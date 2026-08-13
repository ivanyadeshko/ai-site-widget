import type { AppDeps } from '../app.ts';
import {
  bumpIpDayCounter, bumpVisitorDayCounter, peekIpDayCounter, peekVisitorDayCounter,
} from '../db/repositories/quotas.ts';
import { ApiError } from '../http/errors.ts';

/**
 * Суточные капы бюджет-предохранителя (спека §6.3).
 *
 * ФИКС-РАУНД 1: капы считают СОЗДАНИЯ СЕССИЙ ЯДРА, а не строки dialogs.
 * Изначальный визитор-кап (`countDialogsStartedByVisitor`) считал строки
 * `dialogs`, заводимые ОДИН раз на диалог — но продолжение нити после silence
 * и эскалация в голос открывают НОВУЮ платную сессию ядра на ТОМ ЖЕ диалоге,
 * и счётчик по строкам эти повторные покупки не видел вовсе (воспроизведено
 * адверсарием: 11 платных сессий одного диалога при капе 2). Деньги жжёт
 * СЕССИЯ, а не строка в БД (то же рассуждение, что уже привело к декларации
 * «капы считают эскалацию» в исходном брифе T3, — просто применённое буквально
 * и к visitor-капу тоже, симметрично IP-капу, который уже считал попытки).
 *
 * Зовётся ПЕРЕД каждым openCoreSession: старт диалога, продолжение нити,
 * эскалация. Счётчики инкрементятся здесь же — попытка создания уже стоит
 * квоты, иначе провалившиеся создания дали бы бесплатный обход.
 */
export async function ensureSessionBudget(
  deps: AppDeps,
  input: { visitorKey: string; ipHash: string },
): Promise<void> {
  const byVisitor = await bumpVisitorDayCounter(deps.pool, input.visitorKey);
  if (byVisitor > deps.config.maxDialogsPerVisitorPerDay) {
    throw new ApiError(429, 'visitor_daily_cap', 'Слишком много обращений за сутки. Попробуйте завтра.');
  }
  const byIp = await bumpIpDayCounter(deps.pool, input.ipHash);
  if (byIp > deps.config.maxDialogsPerIpPerDay) {
    throw new ApiError(429, 'ip_daily_cap', 'Слишком много обращений за сутки. Попробуйте завтра.');
  }
}

/**
 * READ-ONLY вариант: смотрит, поместилась бы СЛЕДУЮЩАЯ попытка в капы, но
 * счётчики НЕ трогает. Нужен путям, которые сами сессию ядра не создают
 * (сейчас — заглушка `/escalate` до T4, отвечающая 501 на любой успешный
 * проход гардов): бампать там нельзя — иначе клиентские ретраи навсегда
 * падающего эндпоинта незаметно съедят суточную квоту у легитимного
 * пользователя ещё до того, как он реально попробует начать разговор. Когда
 * T4 заменит тело `/escalate` на настоящее создание voice-сессии, эта ветка
 * обязана переключиться на `ensureSessionBudget` (бампающую) — читай эту
 * функцию как временную, привязанную к жизни заглушки.
 */
export async function checkSessionBudget(
  deps: AppDeps,
  input: { visitorKey: string; ipHash: string },
): Promise<void> {
  const byVisitor = await peekVisitorDayCounter(deps.pool, input.visitorKey);
  if (byVisitor >= deps.config.maxDialogsPerVisitorPerDay) {
    throw new ApiError(429, 'visitor_daily_cap', 'Слишком много обращений за сутки. Попробуйте завтра.');
  }
  const byIp = await peekIpDayCounter(deps.pool, input.ipHash);
  if (byIp >= deps.config.maxDialogsPerIpPerDay) {
    throw new ApiError(429, 'ip_daily_cap', 'Слишком много обращений за сутки. Попробуйте завтра.');
  }
}
