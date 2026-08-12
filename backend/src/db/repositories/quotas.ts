import { createHash } from 'node:crypto';
import type { Queryable } from '../pool.ts';

// IP наружу и в БД не попадает НИКОГДА — только необратимый хэш с солью стенда.
export const hashIp = (ip: string, salt: string): string =>
  createHash('sha256').update(`${salt}:${ip}`).digest('hex');

export async function bumpIpDayCounter(db: Queryable, ipHash: string): Promise<number> {
  const { rows } = await db.query<{ started: number }>(
    `INSERT INTO ip_day_counters (ip_hash, day, started) VALUES ($1, current_date, 1)
     ON CONFLICT (ip_hash, day) DO UPDATE SET started = ip_day_counters.started + 1
     RETURNING started`,
    [ipHash],
  );
  return rows[0]!.started;
}

/**
 * Чистка счётчиков старше N суток. Таблица растёт по одной строке на IP в день
 * и никем не подметается — за год это мусор, который никто не удалит руками.
 * Зовётся свипером (T4) тем же тиком, что и досинк диалогов.
 */
export async function purgeOldIpCounters(db: Queryable, keepDays: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM ip_day_counters WHERE day < current_date - ($1 || ' days')::interval`,
    [String(keepDays)],
  );
  return rowCount ?? 0;
}
