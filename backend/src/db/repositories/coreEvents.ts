import type { Queryable } from '../pool.ts';

export async function insertCoreEvent(
  db: Queryable,
  input: { eventId: string; type: string; payload: unknown },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO core_events (event_id, type, payload) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (event_id) DO NOTHING`,
    [input.eventId, input.type, JSON.stringify(input.payload)],
  );
  return (rowCount ?? 0) > 0;
}
