import type { Queryable } from '../pool.ts';

/**
 * Владелец, на которого бэкфиллятся виджеты, заведённые до появления
 * аккаунтов (миграция 1787030000000_accounts). Его password_hash = 'locked' —
 * заведомо невалидный формат, verifyPassword отвергает любой пароль.
 */
export const SYSTEM_ACCOUNT_EMAIL = 'system@vell.local';

export type AccountRow = {
  id: string;
  email: string;
  password_hash: string;
  is_admin: boolean;
  blocked_at: Date | null;
  created_at: Date;
  last_login_at: Date | null;
};

const COLS = `id, email, password_hash, is_admin, blocked_at, created_at, last_login_at`;

export async function findAccountByEmail(db: Queryable, email: string): Promise<AccountRow | null> {
  // lower() с обеих сторон — тот же предикат, что и в accounts_email_unique,
  // поэтому попадает в функциональный индекс.
  const { rows } = await db.query<AccountRow>(
    `SELECT ${COLS} FROM accounts WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findAccountById(db: Queryable, id: string): Promise<AccountRow | null> {
  const { rows } = await db.query<AccountRow>(`SELECT ${COLS} FROM accounts WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertAccount(
  db: Queryable,
  input: { email: string; passwordHash: string },
): Promise<AccountRow> {
  const { rows } = await db.query<AccountRow>(
    `INSERT INTO accounts (email, password_hash) VALUES ($1, $2) RETURNING ${COLS}`,
    [input.email, input.passwordHash],
  );
  return rows[0]!;
}

export async function touchAccountLogin(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE accounts SET last_login_at = now() WHERE id = $1`, [id]);
}

/** Возвращает false, если аккаунта с таким id нет. */
export async function setAccountBlocked(db: Queryable, id: string, blocked: boolean): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE accounts SET blocked_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1`,
    [id, blocked],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Keyset-пагинация по (created_at DESC, id DESC): OFFSET на растущей таблице
 * даёт дубли и пропуски между страницами, а курсор по паре — стабилен.
 */
export async function listAccounts(
  db: Queryable,
  input: { limit: number; cursor: { createdAt: Date; id: string } | null },
): Promise<AccountRow[]> {
  if (input.cursor === null) {
    const { rows } = await db.query<AccountRow>(
      `SELECT ${COLS} FROM accounts ORDER BY created_at DESC, id DESC LIMIT $1`,
      [input.limit],
    );
    return rows;
  }
  const { rows } = await db.query<AccountRow>(
    `SELECT ${COLS} FROM accounts
      WHERE (created_at, id) < ($2, $3)
      ORDER BY created_at DESC, id DESC LIMIT $1`,
    [input.limit, input.cursor.createdAt, input.cursor.id],
  );
  return rows;
}
