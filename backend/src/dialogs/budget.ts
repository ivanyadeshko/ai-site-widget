import type { AppDeps } from '../app.ts';
import { countDialogsStartedByVisitor } from '../db/repositories/dialogs.ts';
import { bumpIpDayCounter } from '../db/repositories/quotas.ts';
import { ApiError } from '../http/errors.ts';

/**
 * Суточные капы бюджет-предохранителя (спека §6.3). Зовётся ПЕРЕД каждым
 * openCoreSession: старт диалога, продолжение нити, эскалация в голос.
 * Счётчик IP инкрементится здесь же — попытка создания уже стоит квоты, иначе
 * провалившиеся создания дали бы бесплатный обход.
 */
export async function ensureSessionBudget(
  deps: AppDeps,
  input: { visitorKey: string; ipHash: string },
): Promise<void> {
  const byVisitor = await countDialogsStartedByVisitor(deps.pool, input.visitorKey);
  if (byVisitor >= deps.config.maxDialogsPerVisitorPerDay) {
    throw new ApiError(429, 'visitor_daily_cap', 'Слишком много обращений за сутки. Попробуйте завтра.');
  }
  const byIp = await bumpIpDayCounter(deps.pool, input.ipHash);
  if (byIp > deps.config.maxDialogsPerIpPerDay) {
    throw new ApiError(429, 'ip_daily_cap', 'Слишком много обращений за сутки. Попробуйте завтра.');
  }
}
