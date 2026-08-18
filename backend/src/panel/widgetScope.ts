import { findWidgetByIdForAccount } from '../db/repositories/widgets.ts';
import type { Queryable } from '../db/pool.ts';
import { ApiError } from '../http/errors.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Фильтр `widget_id` из query, проверенный на принадлежность аккаунту.
 *
 * ⚠️ Отклонение от буквы плана: общий модуль, а не копия в каждой ручке. Его
 * заводят сразу три листинга (лиды, диалоги, использование), и все три обязаны
 * отвечать на чужой `widget_id` ОДИНАКОВО.
 *
 * Чужой и несуществующий виджет дают один и тот же 404: 403 подтвердил бы, что
 * такой виджет есть у кого-то другого. Синтаксически кривой id — тоже 404, а не
 * 500: `WHERE id = 'не-uuid'` роняет Postgres ошибкой 22P02.
 *
 * Сам по себе фильтр НЕ является защитой — изоляция живёт в SQL репозиториев
 * (`WHERE w.account_id = $1`). Он нужен, чтобы владелец видел честный 404
 * вместо пустого списка и не искал причину в своих настройках.
 */
export async function resolveWidgetFilter(db: Queryable, raw: unknown, accountId: string): Promise<string | null> {
  if (raw === undefined || raw === null || raw === '') return null;
  const notFound = (): ApiError => new ApiError(404, 'widget_not_found', 'Виджет не найден.');
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) throw notFound();
  const widget = await findWidgetByIdForAccount(db, raw, accountId);
  if (!widget) throw notFound();
  return widget.id;
}
