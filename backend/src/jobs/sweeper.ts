import type { AppDeps } from '../app.ts';
import { applyFinalizedUsage, listStaleActiveDialogs, setDialogStatus } from '../db/repositories/dialogs.ts';
import { purgeOldIpCounters, purgeOldVisitorCounters } from '../db/repositories/quotas.ts';

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
    try {
      const card = await deps.core.getSession(sessionId);
      if (!TERMINAL.has(card.status)) continue;
      // Идемпотентно по sessionId: вебхук мог долететь между выборкой и этим
      // моментом — тогда деньги уже учтены и второй раз не прибавятся.
      await applyFinalizedUsage(deps.pool, {
        dialogId: dialog.id,
        sessionId,
        usage: (card.usage_summary ?? {}) as Record<string, number>,
        creditsTotal: card.credits_total ?? 0,
      });
      await setDialogStatus(deps.pool, dialog.id, 'ended');
      synced += 1;
      deps.log.info({ dialogId: dialog.id, sessionId, status: card.status }, 'свипер досинхронил зависший диалог');
    } catch (err) {
      deps.log.warn({ err, dialogId: dialog.id, sessionId }, 'свипер: карточку сессии получить не удалось');
    }
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
    void sweepOnce(deps, { staleMinutes, batch })
      // Тем же тиком подметаем суточные счётчики: иначе таблица растёт по
      // строке на IP в день и не чистится никем.
      //
      // ОТСТУПЛЕНИЕ ОТ БРИФА (факт, не вкус): в снипете подметался ТОЛЬКО
      // ip_day_counters, но капы с фикс-раунда T3 считают ещё и
      // visitor_day_counters — таблица ровно с той же механикой роста (строка
      // на визитора в сутки) и ровно тем же отсутствием уборщика. Её
      // purgeOldVisitorCounters остался бы мёртвым экспортом, а таблица росла
      // бы вечно; докстринг quotas.ts (T3) прямо обещает, что свипер T4 метёт
      // ОБЕ («Таблицы растут… Зовутся свипером (T4) тем же тиком»).
      .then(() => purgeOldIpCounters(deps.pool, 7))
      .then(() => purgeOldVisitorCounters(deps.pool, 7))
      .catch((err: unknown) => deps.log.error({ err }, 'проход свипера сорвался'))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref(); // не держим процесс при shutdown
  return { stop: () => clearInterval(timer) };
}
