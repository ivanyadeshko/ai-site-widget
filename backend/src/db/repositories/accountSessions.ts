import type { Queryable } from '../pool.ts';
import type { AccountRow } from './accounts.ts';

export type AccountSessionRow = {
  id: string;
  account_id: string;
  token_hash: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
};

const COLS = `id, account_id, token_hash, created_at, last_seen_at, expires_at`;

export async function insertSession(
  db: Queryable,
  input: { accountId: string; tokenHash: string; expiresAt: Date },
): Promise<AccountSessionRow> {
  const { rows } = await db.query<AccountSessionRow>(
    `INSERT INTO account_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, $3)
     RETURNING ${COLS}`,
    [input.accountId, input.tokenHash, input.expiresAt],
  );
  return rows[0]!;
}

/**
 * Живая сессия ВМЕСТЕ с аккаунтом одним запросом: гард дёргается на каждом
 * запросе SPA, второй round-trip за аккаунтом здесь лишний. Протухшие строки
 * не возвращаются вовсе — свипер уносит их позже, но пускать до уборки нельзя.
 */
export async function findLiveSessionByHash(
  db: Queryable,
  tokenHash: string,
): Promise<{ session: AccountSessionRow; account: AccountRow } | null> {
  const { rows } = await db.query<AccountSessionRow & {
    a_id: string; a_email: string; a_password_hash: string; a_is_admin: boolean;
    a_blocked_at: Date | null; a_created_at: Date; a_last_login_at: Date | null;
  }>(
    `SELECT s.id, s.account_id, s.token_hash, s.created_at, s.last_seen_at, s.expires_at,
            a.id AS a_id, a.email AS a_email, a.password_hash AS a_password_hash,
            a.is_admin AS a_is_admin, a.blocked_at AS a_blocked_at,
            a.created_at AS a_created_at, a.last_login_at AS a_last_login_at
       FROM account_sessions s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    session: {
      id: row.id,
      account_id: row.account_id,
      token_hash: row.token_hash,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      expires_at: row.expires_at,
    },
    account: {
      id: row.a_id,
      email: row.a_email,
      password_hash: row.a_password_hash,
      is_admin: row.a_is_admin,
      blocked_at: row.a_blocked_at,
      created_at: row.a_created_at,
      last_login_at: row.a_last_login_at,
    },
  };
}

/** Продление скользящего окна: last_seen_at + новый expires_at. */
export async function touchSession(
  db: Queryable,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await db.query(
    `UPDATE account_sessions SET last_seen_at = now(), expires_at = $2 WHERE token_hash = $1`,
    [tokenHash, expiresAt],
  );
}

export async function deleteSessionByHash(db: Queryable, tokenHash: string): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM account_sessions WHERE token_hash = $1`, [tokenHash]);
  return rowCount ?? 0;
}

export async function deleteSessionsOfAccount(db: Queryable, accountId: string): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM account_sessions WHERE account_id = $1`, [accountId]);
  return rowCount ?? 0;
}

export async function deleteExpiredSessions(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM account_sessions WHERE expires_at <= now()`);
  return rowCount ?? 0;
}
