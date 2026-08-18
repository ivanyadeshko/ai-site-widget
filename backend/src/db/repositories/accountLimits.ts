import type { Queryable } from '../pool.ts';

export type AccountLimitsRow = {
  account_id: string;
  max_sessions_per_day: number;
  updated_at: Date;
  updated_by: string | null;
};

const COLS = `account_id, max_sessions_per_day, updated_at, updated_by`;

export async function findAccountLimits(db: Queryable, accountId: string): Promise<AccountLimitsRow | null> {
  const { rows } = await db.query<AccountLimitsRow>(
    `SELECT ${COLS} FROM account_limits WHERE account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

export async function upsertAccountLimits(
  db: Queryable,
  input: { accountId: string; maxSessionsPerDay: number; updatedBy: string },
): Promise<AccountLimitsRow> {
  const { rows } = await db.query<AccountLimitsRow>(
    `INSERT INTO account_limits (account_id, max_sessions_per_day, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE
       SET max_sessions_per_day = EXCLUDED.max_sessions_per_day,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by
     RETURNING ${COLS}`,
    [input.accountId, input.maxSessionsPerDay, input.updatedBy],
  );
  return rows[0]!;
}

/** Инкремент по факту созданной сессии — копия паттерна quotas.ts. */
export async function bumpAccountDayCounter(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query<{ started: number }>(
    `INSERT INTO account_day_counters (account_id, day, started) VALUES ($1, current_date, 1)
     ON CONFLICT (account_id, day) DO UPDATE SET started = account_day_counters.started + 1
     RETURNING started`,
    [accountId],
  );
  return rows[0]!.started;
}

/** Текущее значение БЕЗ инкремента — для допуска (см. budget.ts). */
export async function peekAccountDayCounter(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query<{ started: number }>(
    `SELECT started FROM account_day_counters WHERE account_id = $1 AND day = current_date`,
    [accountId],
  );
  return rows[0]?.started ?? 0;
}

export async function purgeOldAccountCounters(db: Queryable, keepDays: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM account_day_counters WHERE day < current_date - ($1 || ' days')::interval`,
    [String(keepDays)],
  );
  return rowCount ?? 0;
}
