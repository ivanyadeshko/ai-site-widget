import type { Queryable } from '../pool.ts';

export type AuthFailureRow = {
  subject_key: string;
  failures: number;
  first_failure_at: Date;
  locked_until: Date | null;
};

/**
 * Инкремент счётчика неудач ОДНИМ statement'ом: параллельные попытки не должны
 * терять инкременты (read-modify-write в приложении их теряет). По достижении
 * порога ставится окно блокировки. Возвращает состояние ПОСЛЕ инкремента.
 */
export async function bumpFailure(
  db: Queryable,
  key: string,
  maxFailures: number,
  lockMinutes: number,
): Promise<{ failures: number; lockedUntil: Date | null }> {
  const { rows } = await db.query<{ failures: number; locked_until: Date | null }>(
    `INSERT INTO auth_failures (subject_key, failures, first_failure_at)
     VALUES ($1, 1, now())
     ON CONFLICT (subject_key) DO UPDATE
       SET failures = auth_failures.failures + 1,
           locked_until = CASE
             WHEN auth_failures.failures + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
             ELSE auth_failures.locked_until
           END
     RETURNING failures, locked_until`,
    [key, maxFailures, String(lockMinutes)],
  );
  const row = rows[0]!;
  return { failures: row.failures, lockedUntil: row.locked_until };
}

export async function isLocked(db: Queryable, key: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM auth_failures WHERE subject_key = $1 AND locked_until > now()`,
    [key],
  );
  return (rowCount ?? 0) > 0;
}

/** Успешный вход = чистый лист. Строку удаляем: держать её незачем. */
export async function clearFailures(db: Queryable, key: string): Promise<void> {
  await db.query(`DELETE FROM auth_failures WHERE subject_key = $1`, [key]);
}

/**
 * Ключ субъекта задаёт АТАКУЮЩИЙ (это произвольный email из тела запроса), то
 * есть таблица растёт настолько, насколько ему хватит терпения. Метём строки,
 * у которых и окно блокировки истекло, и последней активности давно не было.
 */
export async function purgeStaleAuthFailures(db: Queryable, keepDays: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM auth_failures
      WHERE (locked_until IS NULL OR locked_until <= now())
        AND first_failure_at < now() - ($1 || ' days')::interval`,
    [String(keepDays)],
  );
  return rowCount ?? 0;
}
