import type { Queryable } from '../pool.ts';

export type DialogStatus = 'active' | 'escalating' | 'ended' | 'error';

export type DialogRow = {
  id: string;
  widget_id: string;
  visitor_key: string;
  status: DialogStatus;
  core_session_ids: string[];
  settled_session_ids: string[];
  current_core_session_id: string | null;
  current_channel: 'chat' | 'voice' | null;
  client_reference: string;
  usage: Record<string, number>;
  credits_total: number;
  started_at: Date;
  ended_at: Date | null;
  last_activity_at: Date;
};

const COLS = `id, widget_id, visitor_key, status, core_session_ids, settled_session_ids,
              current_core_session_id, current_channel, client_reference,
              usage, credits_total, started_at, ended_at, last_activity_at`;

export async function insertDialog(db: Queryable, input: { widgetId: string; visitorKey: string }): Promise<DialogRow> {
  // ОДНИМ statement'ом: client_reference — NOT NULL UNIQUE, и промежуточная
  // вставка пустой строки с последующим UPDATE ловила бы 23505 на втором же
  // параллельном старте диалога (пустая строка уникальна ровно в одном экземпляре).
  const { rows } = await db.query<DialogRow>(
    `INSERT INTO dialogs (id, widget_id, visitor_key, client_reference)
     SELECT g.id, $1, $2, 'widget:dialog:' || g.id
       FROM (SELECT gen_random_uuid() AS id) g
     RETURNING ${COLS}`,
    [input.widgetId, input.visitorKey],
  );
  return rows[0]!;
}

export async function findDialogById(db: Queryable, id: string): Promise<DialogRow | null> {
  const { rows } = await db.query<DialogRow>(`SELECT ${COLS} FROM dialogs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findDialogByClientReference(db: Queryable, ref: string): Promise<DialogRow | null> {
  const { rows } = await db.query<DialogRow>(`SELECT ${COLS} FROM dialogs WHERE client_reference = $1`, [ref]);
  return rows[0] ?? null;
}

export async function attachCoreSession(
  db: Queryable,
  input: { dialogId: string; sessionId: string; channel: 'chat' | 'voice' },
): Promise<void> {
  await db.query(
    `UPDATE dialogs
        SET core_session_ids = core_session_ids || to_jsonb($2::text),
            current_core_session_id = $2,
            current_channel = $3,
            last_activity_at = now()
      WHERE id = $1`,
    [input.dialogId, input.sessionId, input.channel],
  );
}

export async function setDialogStatus(db: Queryable, dialogId: string, status: DialogStatus): Promise<void> {
  await db.query(
    `UPDATE dialogs SET status = $2, ended_at = CASE WHEN $2 IN ('ended','error') THEN now() ELSE ended_at END
      WHERE id = $1`,
    [dialogId, status],
  );
}

export async function casDialogStatus(db: Queryable, dialogId: string, from: DialogStatus, to: DialogStatus): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE dialogs SET status = $3 WHERE id = $1 AND status = $2`, [dialogId, from, to]);
  return (rowCount ?? 0) > 0;
}

export async function touchDialog(db: Queryable, dialogId: string): Promise<void> {
  await db.query(`UPDATE dialogs SET last_activity_at = now() WHERE id = $1`, [dialogId]);
}

/**
 * Учесть деньги ОДНОЙ закрытой сессии. Идемпотентно по session_id: вебхук
 * `session.finalized` и свипер приходят к одному выводу разными путями, и без
 * защиты credits_total удвоился бы. Возвращает false, если сессию уже учли.
 */
export async function applyFinalizedUsage(
  db: Queryable,
  input: { dialogId: string; sessionId: string; usage: Record<string, number>; creditsTotal: number },
): Promise<boolean> {
  // Складываем по сессиям нити: у диалога их несколько (chat → voice → chat…).
  const { rowCount } = await db.query(
    `UPDATE dialogs
        SET settled_session_ids = settled_session_ids || to_jsonb($4::text),
            usage = (
              SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                FROM (
                  SELECT key, sum(value::numeric) AS value
                    FROM (
                      SELECT key, value FROM jsonb_each_text(usage)
                      UNION ALL
                      SELECT key, value FROM jsonb_each_text($2::jsonb)
                    ) merged
                   GROUP BY key
                ) summed
            ),
            credits_total = credits_total + $3
      WHERE id = $1
        AND NOT (settled_session_ids @> to_jsonb($4::text))`,
    [input.dialogId, JSON.stringify(input.usage), input.creditsTotal, input.sessionId],
  );
  return (rowCount ?? 0) > 0;
}

export async function countDialogsStartedByVisitor(db: Queryable, visitorKey: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM dialogs WHERE visitor_key = $1 AND started_at > now() - interval '24 hours'`,
    [visitorKey],
  );
  return Number.parseInt(rows[0]!.n, 10);
}

export async function listStaleActiveDialogs(db: Queryable, olderThanMinutes: number, limit: number): Promise<DialogRow[]> {
  const { rows } = await db.query<DialogRow>(
    `SELECT ${COLS} FROM dialogs
      WHERE status IN ('active','escalating')
        AND current_core_session_id IS NOT NULL
        AND last_activity_at < now() - ($1 || ' minutes')::interval
      ORDER BY last_activity_at ASC LIMIT $2`,
    [String(olderThanMinutes), limit],
  );
  return rows;
}
