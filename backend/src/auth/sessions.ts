import { createHash, randomBytes } from 'node:crypto';
import type { AppDeps } from '../app.ts';
import type { AccountRow } from '../db/repositories/accounts.ts';
import {
  deleteExpiredSessions, deleteSessionByHash, deleteSessionsOfAccount,
  findLiveSessionByHash, insertSession, touchSession,
} from '../db/repositories/accountSessions.ts';

export const SESSION_COOKIE = 'vell_sid';

/**
 * Токен НИКОГДА не хранится в БД — только его sha256. Утечка дампа (бэкап,
 * SQL-инъекция на чтение) не даёт войти: из хэша токен не восстановить, а
 * гард ищет ровно по хэшу. Соль здесь не нужна — токен и так 256 бит энтропии,
 * словарной атаки на него не существует.
 */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const expiryFrom = (deps: AppDeps): Date =>
  new Date(Date.now() + deps.config.sessionTtlDays * 24 * 60 * 60 * 1000);

export async function issueSession(deps: AppDeps, accountId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = expiryFrom(deps);
  await insertSession(deps.pool, { accountId, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

/** Как часто продлевается скользящее окно сессии. */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export async function resolveSession(deps: AppDeps, token: string): Promise<AccountRow | null> {
  const tokenHash = hashToken(token);
  const found = await findLiveSessionByHash(deps.pool, tokenHash);
  if (!found) return null;
  // Блокировка аккаунта гасит ЖИВЫЕ сессии мгновенно (D-3): ради этого сессии
  // и лежат в БД, а не в подписанном токене, который отозвать нельзя.
  if (found.account.blocked_at !== null) return null;

  // Продлеваем не чаще раза в сутки: иначе КАЖДЫЙ запрос SPA — лишний UPDATE
  // на горячей строке.
  if (Date.now() - found.session.last_seen_at.getTime() > RENEW_AFTER_MS) {
    await touchSession(deps.pool, tokenHash, expiryFrom(deps));
  }
  return found.account;
}

export async function revokeSession(deps: AppDeps, token: string): Promise<void> {
  await deleteSessionByHash(deps.pool, hashToken(token));
}

export async function revokeAllSessionsOfAccount(deps: AppDeps, accountId: string): Promise<number> {
  return deleteSessionsOfAccount(deps.pool, accountId);
}

export async function sweepExpiredSessions(deps: AppDeps): Promise<number> {
  return deleteExpiredSessions(deps.pool);
}
