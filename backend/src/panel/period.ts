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

/** Окно отчёта: больше года — уже не «посмотреть расход», а выгрузка всей истории. */
export const MAX_PERIOD_DAYS = 366;
/** Что показываем, когда владелец не выбрал период сам. */
export const DEFAULT_PERIOD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Период отчёта: обе границы обязательны, поэтому пустые заполняются дефолтом.
 *
 * Потолок в 366 дней — не вкусовщина: без него любой запрос «за всё время»
 * разворачивает `jsonb_each_text` по ВСЕЙ таблице диалогов, и один любопытный
 * владелец кладёт отчёты всем. Дефолтное окно — последние 30 дней.
 *
 * `from` включительно, `to` исключительно: соседние периоды стыкуются без
 * нахлёста, и один диалог не попадает в два отчёта.
 */
export function parseReportPeriod(rawFrom: unknown, rawTo: unknown): { from: Date; to: Date } {
  const to = parseDateParam(rawTo, 'to') ?? new Date();
  const from = parseDateParam(rawFrom, 'from') ?? new Date(to.getTime() - DEFAULT_PERIOD_DAYS * DAY_MS);
  if (from.getTime() > to.getTime()) throw invalidPeriod('Начало периода позже его конца.');
  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw invalidPeriod(`Период не может быть длиннее ${MAX_PERIOD_DAYS} дней — выберите отрезок покороче.`);
  }
  return { from, to };
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
