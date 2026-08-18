import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { hashPassword, passwordPolicyError, verifyPassword } from '../../auth/password.ts';
import { requireAccount } from '../../auth/guards.ts';
import { SESSION_COOKIE, issueSession, revokeSession } from '../../auth/sessions.ts';
import {
  findAccountByEmail, insertAccount, touchAccountLogin, type AccountRow,
} from '../../db/repositories/accounts.ts';
import { bumpFailure, clearFailures, isLocked } from '../../db/repositories/authFailures.ts';
import { ApiError } from '../../http/errors.ts';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_MAX = 200;

/** Наружу уезжает РОВНО это: ни хэша пароля, ни служебных отметок. */
const publicAccount = (account: AccountRow): { id: string; email: string; is_admin: boolean } =>
  ({ id: account.id, email: account.email, is_admin: account.is_admin });

const parseEmail = (raw: unknown): string => {
  const email = typeof raw === 'string' ? raw.trim() : '';
  if (email.length === 0 || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    throw new ApiError(422, 'invalid_email', 'Введите корректный адрес почты.');
  }
  return email;
};

const parsePassword = (raw: unknown): string => {
  const password = typeof raw === 'string' ? raw : '';
  const problem = passwordPolicyError(password);
  if (problem !== null) throw new ApiError(422, 'weak_password', problem);
  return password;
};

/**
 * Пустышка для выравнивания времени ответа на несуществующий email.
 *
 * ДЕВИАЦИЯ от буквы плана (там `verifyPassword(password, 'locked')`): строка
 * 'locked' отсекается парсером формата на первой же проверке и возвращает
 * false МГНОВЕННО — то есть ровно того, ради чего вызов задуман (скрыть
 * существование аккаунта), она не даёт: ответ по несуществующему email
 * приходил бы на ~100 мс быстрее, чем по существующему. Считаем настоящий
 * scrypt по разовому случайному хэшу — тогда обе ветки стоят одинаково.
 * Хэш ленивый: платить 100 мс на старте процесса незачем.
 */
let dummyHashPromise: Promise<string> | null = null;
const dummyHash = (): Promise<string> => {
  dummyHashPromise ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyHashPromise;
};

const setSessionCookie = (reply: FastifyReply, token: string, expiresAt: Date): void => {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // Domain НЕ задаём: кука host-only (D-5) — поддомены её не увидят.
    secure: reply.server.deps.config.cookieSecure,
    expires: expiresAt,
  });
};

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { email?: unknown; password?: unknown } }>(
    '/auth/register',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const email = parseEmail(req.body?.email);
      // Политика пароля проверяется ДО обращения к БД: слабый пароль не должен
      // оставлять следа даже в виде занятого email.
      const password = parsePassword(req.body?.password);

      let account: AccountRow;
      try {
        account = await insertAccount(app.deps.pool, { email, passwordHash: await hashPassword(password) });
      } catch (err) {
        // 23505 — уникальный индекс accounts_email_unique по lower(email).
        // Ловим КОД ошибки, а не предварительный SELECT: между проверкой и
        // вставкой email успевает занять параллельная регистрация.
        if ((err as { code?: unknown }).code === '23505') {
          throw new ApiError(409, 'email_taken', 'Такая почта уже зарегистрирована.');
        }
        throw err;
      }

      const session = await issueSession(app.deps, account.id);
      setSessionCookie(reply, session.token, session.expiresAt);
      return reply.code(201).send({ account: publicAccount(account) });
    },
  );

  app.post<{ Body: { email?: unknown; password?: unknown } }>(
    '/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const email = parseEmail(req.body?.email);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      // Ключ счётчика — email, а НЕ IP: перебор одного аккаунта идёт с
      // меняющихся адресов, и IP-лимит его не видит.
      const subjectKey = `login:${email.toLowerCase()}`;

      if (await isLocked(app.deps.pool, subjectKey)) {
        throw new ApiError(429, 'login_locked', 'Слишком много неудачных попыток. Повторите позже.');
      }

      const account = await findAccountByEmail(app.deps.pool, email);
      let ok = false;
      if (account === null) {
        await verifyPassword(password, await dummyHash());
      } else {
        ok = await verifyPassword(password, account.password_hash);
      }

      if (!ok || account === null) {
        await bumpFailure(
          app.deps.pool, subjectKey,
          app.deps.config.loginMaxFailures, app.deps.config.loginLockMinutes,
        );
        // ОДИН код на «нет такого email» и «неверный пароль»: разные коды
        // превратили бы ручку в оракул существования аккаунтов.
        throw new ApiError(401, 'invalid_credentials', 'Неверная почта или пароль.');
      }

      // Заблокированный аккаунт не должен получать сессию: resolveSession её
      // всё равно не признает (D-3), и владелец видел бы «вход выполнен», а
      // следом мгновенный выброс на экран логина без объяснения причины.
      if (account.blocked_at !== null) {
        throw new ApiError(403, 'account_blocked', 'Аккаунт заблокирован. Обратитесь в поддержку.');
      }

      await clearFailures(app.deps.pool, subjectKey);
      await touchAccountLogin(app.deps.pool, account.id);
      const session = await issueSession(app.deps, account.id);
      setSessionCookie(reply, session.token, session.expiresAt);
      return reply.send({ account: publicAccount(account) });
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    // Идемпотентно и без requireAccount: выход по протухшей куке обязан
    // заканчиваться выходом, а не 401.
    const token = req.cookies[SESSION_COOKIE];
    if (typeof token === 'string' && token !== '') {
      await revokeSession(app.deps, token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: requireAccount }, async (req, reply) =>
    reply.send({ account: publicAccount(req.account!) }));
};
