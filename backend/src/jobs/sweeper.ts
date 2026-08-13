import type { AppDeps } from '../app.ts';
import { CoreHttpError } from '../core/client.ts';
import {
  applyFinalizedUsage, listStaleActiveDialogs, setDialogStatus, touchDialog,
} from '../db/repositories/dialogs.ts';
import { purgeOldIpCounters, purgeOldVisitorCounters } from '../db/repositories/quotas.ts';

/** Сколько суток держим суточные счётчики капов, прежде чем подмести. */
const COUNTER_RETENTION_DAYS = 7;

const TERMINAL = new Set(['finalized', 'expired']);

/**
 * Вебхук после 8 неудачных доставок теряется НАВСЕГДА — статус и деньги
 * зависшего диалога иначе никогда не сойдутся. Свипер спрашивает карточку сам.
 * Выборка берёт только active/escalating: ended/error уже сведены (и деньги по
 * ним посчитаны вебхуком), повторный проход удвоил бы credits_total.
 */
export async function sweepOnce(deps: AppDeps, opts: { staleMinutes: number; batch: number }): Promise<number> {
  const stale = await listStaleActiveDialogs(deps.pool, opts.staleMinutes, opts.batch);
  let synced = 0;
  for (const dialog of stale) {
    const sessionId = dialog.current_core_session_id;
    if (!sessionId) continue;
    let card;
    try {
      card = await deps.core.getSession(sessionId);
    } catch (err) {
      if (err instanceof CoreHttpError && err.status === 404) {
        // ЗОМБИ (фикс-раунд 1, M1): ядро такой сессии не знает — ни сейчас, ни
        // впредь. Прежний код просто логировал и шёл дальше, а выборка
        // отсортирована по last_activity_at ASC — тот же мертвец возвращался
        // ПЕРВЫМ на каждом проходе и занимал место в batch: свипер
        // захлёбывался и переставал видеть живые протухшие диалоги
        // (воспроизведено ревью: batch=3, synced=0). Терминализуем — диалог
        // всё равно никогда не сойдётся, зато освободит выборку.
        await setDialogStatus(deps.pool, dialog.id, 'error');
        deps.log.error(
          { dialogId: dialog.id, sessionId },
          'свипер: ядро не знает сессию диалога — терминализуем в error, деньги по ней уже не сойдутся',
        );
      } else {
        // Транзиентная беда (сеть, 5xx, таймаут): сессия, возможно, жива.
        // Двигаем метку активности — диалог уходит в ХВОСТ очереди и не
        // блокирует batch следующего прохода, но из-под свипера не исчезает.
        await touchDialog(deps.pool, dialog.id);
        deps.log.warn(
          { err, dialogId: dialog.id, sessionId },
          'свипер: карточку сессии получить не удалось — диалог ротирован в хвост',
        );
      }
      continue;
    }

    if (!TERMINAL.has(card.status)) continue;
    // Идемпотентно по sessionId: вебхук мог долететь между выборкой и этим
    // моментом — тогда деньги уже учтены и второй раз не прибавятся.
    const settled = await applyFinalizedUsage(deps.pool, {
      dialogId: dialog.id,
      sessionId,
      usage: (card.usage_summary ?? {}) as Record<string, number>,
      creditsTotal: card.credits_total ?? 0,
    });
    await setDialogStatus(deps.pool, dialog.id, 'ended');
    // L2: досинхронизированными считаем только те диалоги, где свипер РЕАЛЬНО
    // свёл деньги. Успел вебхук — проход лишь закрыл статус, и рапортовать за
    // это единицей значит завышать метрику, по которой судят, много ли
    // вебхуков теряется.
    if (settled) synced += 1;
    deps.log.info(
      { dialogId: dialog.id, sessionId, status: card.status, settled },
      'свипер досинхронил зависший диалог',
    );
  }
  return synced;
}

export function startSweeper(
  deps: AppDeps,
  opts: { intervalMs?: number; staleMinutes?: number; batch?: number } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 10 * 60_000;
  const staleMinutes = opts.staleMinutes ?? 120;
  const batch = opts.batch ?? 50;
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // предыдущий проход ещё идёт — тик пропускаем
    running = true;
    // Три НЕЗАВИСИМЫЕ работы одного тика (L3): прежняя then-цепочка связывала
    // их судьбой — первая же ошибка свипера (недоступное ядро, обрыв пула)
    // отменяла обе уборки счётчиков, и таблицы капов не подметались ровно в
    // те периоды, когда система и так нездорова. Уборка счётчиков со свипером
    // не связана ничем, кроме удобного тика.
    //
    // Подметаем ОБЕ таблицы: ip_day_counters и visitor_day_counters — капы с
    // фикс-раунда T3 считают обе, механика роста у них одна (строка на ключ в
    // сутки), уборщика не было ни у одной. Докстринг quotas.ts (T3) прямо
    // обещает, что свипер T4 метёт обе.
    void Promise.allSettled([
      sweepOnce(deps, { staleMinutes, batch }),
      purgeOldIpCounters(deps.pool, COUNTER_RETENTION_DAYS),
      purgeOldVisitorCounters(deps.pool, COUNTER_RETENTION_DAYS),
    ])
      .then((results) => {
        const names = ['проход свипера', 'уборка ip_day_counters', 'уборка visitor_day_counters'];
        results.forEach((result, i) => {
          if (result.status === 'rejected') deps.log.error({ err: result.reason }, `${names[i]} сорвался`);
        });
      })
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref(); // не держим процесс при shutdown
  return { stop: () => clearInterval(timer) };
}
