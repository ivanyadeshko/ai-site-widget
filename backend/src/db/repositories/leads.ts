import type { Cursor } from '../../panel/pagination.ts';
import type { Queryable } from '../pool.ts';

export type InsertLeadInput = {
  dialogId: string;
  widgetId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  comment: string | null;
  consent: boolean;
};

export type LeadRow = { id: string; created_at: Date };

export async function insertLead(db: Queryable, input: InsertLeadInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO leads (dialog_id, widget_id, name, phone, email, comment, consent)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.dialogId, input.widgetId, input.name, input.phone, input.email, input.comment, input.consent],
  );
  return rows[0]!.id;
}

/*
 * ЧТЕНИЕ ЛИДОВ В КАБИНЕТЕ.
 *
 * ИЗОЛЯЦИЯ АРЕНДАТОРОВ ДЕЛАЕТСЯ ЗДЕСЬ, В SQL — тем же правилом, что и у
 * виджетов (см. комментарий в widgets.ts): каждая функция ниже несёт
 * `JOIN widgets w … WHERE w.account_id = $1`. У лида нет своей колонки
 * владельца, владелец у него — через виджет, и соблазн «проверить в ручке»
 * особенно велик. Проверка в ручке забывается в следующей ручке; забытый JOIN
 * в репозитории виден на ревью сразу.
 */

/**
 * Строка листинга: лид + имя виджета, чтобы панель не ходила за ним отдельно.
 *
 * `cursor_at` — служебное поле сверх интерфейса плана: та же `created_at`, но
 * текстом с МИКРОсекундами. Наружу не отдаётся, нужно keyset-курсору — почему
 * именно так, разобрано в `panel/pagination.ts` (тип `Cursor`).
 */
export type LeadListRow = LeadRow & {
  widget_id: string;
  widget_name: string;
  dialog_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  comment: string | null;
  cursor_at: string;
};

/** Размер батча потокового экспорта: держит в памяти страницу, а не таблицу. */
export const LEADS_EXPORT_BATCH = 500;

export type LeadFilter = {
  accountId: string;
  widgetId: string | null;
  /** Границы периода экспорта; `null` — без ограничения с этой стороны. */
  from?: Date | null;
  to?: Date | null;
};

const LIST_COLS = `l.id, l.created_at, l.widget_id, w.name AS widget_name, l.dialog_id,
                   l.name, l.phone, l.email, l.comment,
                   to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;

/**
 * Одна страница лидов аккаунта в порядке (created_at DESC, id DESC).
 *
 * Курсор сравнивается ПАРОЙ (`(l.created_at, l.id) < ($, $)`), а не по одному
 * времени: лиды одного диалога рождаются в одну миллисекунду, и курсор по
 * времени либо зациклился бы на них, либо перепрыгнул через часть.
 */
export async function listLeadsByAccount(
  db: Queryable, input: LeadFilter & { limit: number; cursor: Cursor | null },
): Promise<LeadListRow[]> {
  const { rows } = await db.query<LeadListRow>(
    `SELECT ${LIST_COLS}
       FROM leads l
       JOIN widgets w ON w.id = l.widget_id
      WHERE w.account_id = $1
        AND ($2::uuid IS NULL OR l.widget_id = $2::uuid)
        AND ($3::timestamptz IS NULL OR l.created_at >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR l.created_at < $4::timestamptz)
        AND ($5::timestamptz IS NULL OR (l.created_at, l.id) < ($5::timestamptz, $6::uuid))
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $7`,
    [
      input.accountId, input.widgetId, input.from ?? null, input.to ?? null,
      input.cursor?.at ?? null, input.cursor?.id ?? null, input.limit,
    ],
  );
  return rows;
}

/**
 * Весь отбор лидов ПОТОКОМ, батчами по `LEADS_EXPORT_BATCH`.
 *
 * Зачем генератор, а не «SELECT всё»: выгрузку заказывает владелец с любым
 * числом лидов, а ответ уходит стримом. Собрать миллион строк в массив значило
 * бы положить процесс BFF ради одного CSV. Идём тем же keyset-курсором, что и
 * листинг, — новые лиды, приехавшие во время выгрузки, страницу не сдвигают.
 */
export async function* streamLeadsByAccount(db: Queryable, input: LeadFilter): AsyncGenerator<LeadListRow> {
  let cursor: Cursor | null = null;
  for (;;) {
    const batch: LeadListRow[] = await listLeadsByAccount(db, { ...input, limit: LEADS_EXPORT_BATCH, cursor });
    for (const row of batch) yield row;
    if (batch.length < LEADS_EXPORT_BATCH) return;
    const last = batch[batch.length - 1]!;
    cursor = { at: last.cursor_at, id: last.id };
  }
}

export async function countLeadsByAccount(db: Queryable, input: LeadFilter): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM leads l
       JOIN widgets w ON w.id = l.widget_id
      WHERE w.account_id = $1
        AND ($2::uuid IS NULL OR l.widget_id = $2::uuid)
        AND ($3::timestamptz IS NULL OR l.created_at >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR l.created_at < $4::timestamptz)`,
    [input.accountId, input.widgetId, input.from ?? null, input.to ?? null],
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}
