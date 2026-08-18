import { ApiError } from '../http/errors.ts';

/**
 * Период выборки в панельных ручках.
 *
 * ⚠️ Отклонение от буквы плана: отдельного модуля в списке файлов не было, но
 * `from`/`to` разбирают ДВЕ ручки (`/leads.csv` — Task 14, `/usage` — Task 16),
 * и обе обязаны одинаково отвечать на «дата задом наперёд» и «мусор вместо
 * даты». Копия разъехалась бы на первой правке.
 */

const invalidPeriod = (message: string): ApiError => new ApiError(422, 'invalid_period', message);

/**
 * Одна граница периода. `Invalid Date` отсекается ЗДЕСЬ: уехав в SQL, он валит
 * запрос уже в Postgres, и владелец видит 500 вместо «поправьте дату».
 */
export function parseDateParam(raw: unknown, field: string): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw invalidPeriod(`Параметр ${field} должен быть датой в формате ISO (2026-08-18).`);
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw invalidPeriod(`Параметр ${field} должен быть датой в формате ISO (2026-08-18) — получено: ${raw}`);
  }
  return value;
}

/** Границы периода в правильном порядке; пустые — «без ограничения». */
export function parseOptionalPeriod(rawFrom: unknown, rawTo: unknown): { from: Date | null; to: Date | null } {
  const from = parseDateParam(rawFrom, 'from');
  const to = parseDateParam(rawTo, 'to');
  if (from !== null && to !== null && from.getTime() > to.getTime()) {
    throw invalidPeriod('Начало периода позже его конца.');
  }
  return { from, to };
}
