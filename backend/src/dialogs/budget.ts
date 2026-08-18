import type { AppDeps } from '../app.ts';
import {
  bumpIpDayCounter, bumpVisitorDayCounter, peekIpDayCounter, peekVisitorDayCounter,
} from '../db/repositories/quotas.ts';
import {
  bumpAccountDayCounter, findAccountLimits, peekAccountDayCounter,
} from '../db/repositories/accountLimits.ts';
import { ApiError } from '../http/errors.ts';

/**
 * Кап владельца сайта: своя строка `account_limits` или дефолт стенда.
 * Виджет без владельца (`accountId === null`, наследие релиза 1) сюда не
 * доходит вовсе — он капом аккаунта не ограничен.
 */
async function accountCap(deps: AppDeps, accountId: string): Promise<number> {
  const limits = await findAccountLimits(deps.pool, accountId);
  return limits?.max_sessions_per_day ?? deps.config.maxSessionsPerAccountPerDay;
}

/**
 * Суточные капы бюджет-предохранителя (спека §6.3) разнесены на ДВА шага:
 * ДОПУСК (`checkSessionBudget`, read-only) и СПИСАНИЕ (`chargeSessionBudget`,
 * бамп по ФАКТУ созданной сессии, внутри `openCoreSession`).
 *
 * ФИКС-РАУНД 1 T3: капы считают СОЗДАНИЯ СЕССИЙ ЯДРА, а не строки dialogs —
 * продолжение нити после silence и эскалация в голос открывают НОВУЮ платную
 * сессию на ТОМ ЖЕ диалоге (воспроизведено: 11 платных сессий при капе 2).
 * Деньги жжёт СЕССИЯ, а не строка в БД.
 *
 * ФИКС-РАУНД 1 T4 (M3): единый бамп-перед-попыткой списывал квоту ДВАЖДЫ за
 * ОДНУ сессию. Ключ повторяемости ровно на то и заведён, чтобы ретрай
 * (оборванная сеть, двойной клик) получил от ядра ТУ ЖЕ сессию — платная
 * сущность одна, а счётчик рос на каждую попытку: посетитель с плохой сетью
 * выжигал суточную квоту, не купив ничего.
 *
 * РАЗМЕН, ПРИНЯТЫЙ ВЛАДЕЛЬЦЕМ ЯВНО: peek + пост-бамп НЕ атомарны. Пачка
 * запросов, стартовавших одновременно, проходит допуск по одному и тому же
 * значению счётчика и покупает на ширину параллелизма больше разрешённого
 * (fail-open, недосчёт). Прежняя схема была строже к гонке, но fail-closed по
 * ретраям — то есть штрафовала ЧЕСТНОГО пользователя за плохую сеть.
 * Сознательно выбран недосчёт при гонке вместо двойного списания на ретраях;
 * страховки от разгона — IP-кап (тот же механизм, другой ключ) и малый баланс
 * тенанта, который физически ограничивает ущерб. Понадобится строгость — это
 * уже не счётчик, а атомарный резерв (заявка на сессию с последующим settle),
 * а не правка знака сравнения.
 */
export async function chargeSessionBudget(
  deps: AppDeps,
  input: { visitorKey: string; ipHash: string; accountId: string | null },
): Promise<void> {
  const byVisitor = await bumpVisitorDayCounter(deps.pool, input.visitorKey);
  const byIp = await bumpIpDayCounter(deps.pool, input.ipHash);
  // НЕ бросаем: сессия ядра уже создана и уже стоит денег — отказ здесь ничего
  // не вернёт, а лишь оставит купленную сессию неучтённой в счётчике. Перебор
  // означает, что допуск пропустил гонку (см. размен выше) — это надо видеть.
  if (byVisitor > deps.config.maxDialogsPerVisitorPerDay || byIp > deps.config.maxDialogsPerIpPerDay) {
    deps.log.warn(
      { byVisitor, byIp, maxVisitor: deps.config.maxDialogsPerVisitorPerDay, maxIp: deps.config.maxDialogsPerIpPerDay },
      'БЮДЖЕТ-ПРЕДОХРАНИТЕЛЬ: сессия создана сверх суточного капа — допуск пропустил гонку',
    );
  }
  if (input.accountId === null) return;
  const byAccount = await bumpAccountDayCounter(deps.pool, input.accountId);
  if (byAccount > (await accountCap(deps, input.accountId))) {
    deps.log.warn(
      { accountId: input.accountId, byAccount },
      'БЮДЖЕТ-ПРЕДОХРАНИТЕЛЬ: сессия создана сверх суточного капа АККАУНТА — допуск пропустил гонку',
    );
  }
}

/**
 * ДОПУСК: поместится ли СЛЕДУЮЩАЯ сессия в капы. Счётчики НЕ трогает — их
 * двигает `chargeSessionBudget` по факту созданной сессии (M3). Зовётся ПЕРЕД
 * каждым обращением к ядру: старт диалога, продолжение нити, эскалация.
 */
export async function checkSessionBudget(
  deps: AppDeps,
  input: { visitorKey: string; ipHash: string; accountId: string | null },
): Promise<void> {
  const byVisitor = await peekVisitorDayCounter(deps.pool, input.visitorKey);
  if (byVisitor >= deps.config.maxDialogsPerVisitorPerDay) {
    throw new ApiError(429, 'visitor_daily_cap', 'Слишком много обращений за сутки. Попробуйте завтра.');
  }
  const byIp = await peekIpDayCounter(deps.pool, input.ipHash);
  if (byIp >= deps.config.maxDialogsPerIpPerDay) {
    throw new ApiError(429, 'ip_daily_cap', 'Слишком много обращений за сутки. Попробуйте завтра.');
  }
  // Третий ключ — ВЛАДЕЛЕЦ САЙТА. Поле обязательное (`string | null`, а не
  // `?`): пропущенный проброс на новом call-site иначе не упал бы компиляцией
  // и тихо снял бы кап.
  if (input.accountId === null) return;
  const byAccount = await peekAccountDayCounter(deps.pool, input.accountId);
  if (byAccount >= (await accountCap(deps, input.accountId))) {
    throw new ApiError(429, 'account_daily_cap', 'Лимит виджета на сегодня исчерпан. Владелец сайта уведомлён.');
  }
}
