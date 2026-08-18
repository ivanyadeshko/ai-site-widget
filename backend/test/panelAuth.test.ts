import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/app.ts';
import { seedAccount, testPool, truncateAll } from './helpers/db.ts';
import { hashPassword } from '../src/auth/password.ts';

const pool = testPool();
let app: FastifyInstance;
let close: () => Promise<void>;

beforeEach(async () => {
  await truncateAll(pool);
  const built = await buildTestApp();
  app = built.app;
  close = async () => { await built.app.close(); await built.pool.end(); await built.core.stop(); };
});
afterEach(async () => { await close(); });
afterAll(async () => { await pool.end(); });

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0]! : String(raw);
  return first.split(';')[0]!;
};

describe('регистрация и вход владельца сайта', () => {
  it('регистрация заводит аккаунт и сразу выдаёт httpOnly-сессию', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { origin: 'https://widget.aski.pro' },
      payload: { email: 'Owner@Example.com', password: 'пароль-владельца' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().account.email).toBe('Owner@Example.com');
    // Пароль НИКОГДА не уезжает наружу — ни в каком виде.
    expect(res.body).not.toContain('password');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('vell_sid=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    // Domain НЕ задаём: кука host-only (D-5).
    expect(setCookie).not.toContain('Domain=');
  });

  it('повторная регистрация того же email (в другом регистре) — 409, а не 500', async () => {
    const payload = { email: 'dup@example.com', password: 'пароль-владельца' };
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin: 'https://widget.aski.pro' }, payload });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { origin: 'https://widget.aski.pro' },
      payload: { ...payload, email: 'DUP@EXAMPLE.COM' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('email_taken');
  });

  it('слабый пароль отвергается до записи в БД', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { origin: 'https://widget.aski.pro' },
      payload: { email: 'weak@example.com', password: '123' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('weak_password');
    const { rowCount } = await pool.query("SELECT 1 FROM accounts WHERE lower(email) = 'weak@example.com'");
    expect(rowCount).toBe(0);
  });

  it('/me без cookie — 401; с cookie — сам аккаунт', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().error.code).toBe('unauthenticated');

    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { origin: 'https://widget.aski.pro' },
      payload: { email: 'me@example.com', password: 'пароль-владельца' },
    });
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieOf(reg) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().account.email).toBe('me@example.com');
  });

  it('неверный пароль — 401 с тем же кодом, что и несуществующий email (не оракул)', async () => {
    await seedAccount(pool, { email: 'real@example.com', passwordHash: await hashPassword('пароль-владельца') });
    const wrongPass = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://widget.aski.pro' },
      payload: { email: 'real@example.com', password: 'не-тот-пароль' },
    });
    const noUser = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://widget.aski.pro' },
      payload: { email: 'ghost@example.com', password: 'не-тот-пароль' },
    });
    expect(wrongPass.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPass.json().error.code).toBe(noUser.json().error.code);
  });

  it('после 10 неудач подряд по одному email вход блокируется на окно — даже с ВЕРНЫМ паролем', async () => {
    await seedAccount(pool, { email: 'brute@example.com', passwordHash: await hashPassword('пароль-владельца') });
    for (let i = 0; i < 10; i += 1) {
      await app.inject({
        method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://widget.aski.pro' },
        payload: { email: 'brute@example.com', password: `мимо-${i}` },
      });
    }
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://widget.aski.pro' },
      payload: { email: 'brute@example.com', password: 'пароль-владельца' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('login_locked');
  });

  it('успешный вход обнуляет счётчик неудач', async () => {
    await seedAccount(pool, { email: 'reset@example.com', passwordHash: await hashPassword('пароль-владельца') });
    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://widget.aski.pro' }, payload: { email: 'reset@example.com', password: 'мимо' } });
    }
    await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://widget.aski.pro' }, payload: { email: 'reset@example.com', password: 'пароль-владельца' } });
    const { rows } = await pool.query<{ failures: number }>(
      "SELECT failures FROM auth_failures WHERE subject_key = 'login:reset@example.com'",
    );
    expect(rows[0]?.failures ?? 0).toBe(0);
  });

  it('заблокированный аккаунт не входит даже с верным паролем', async () => {
    // Иначе вход отдал бы 200 и куку, а resolveSession её тут же не признал бы
    // (D-3): владелец видел бы «вход выполнен» и мгновенный выброс на логин.
    const acc = await seedAccount(pool, { email: 'blocked@example.com', passwordHash: await hashPassword('пароль-владельца') });
    await pool.query('UPDATE accounts SET blocked_at = now() WHERE id = $1', [acc.id]);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://widget.aski.pro' },
      payload: { email: 'blocked@example.com', password: 'пароль-владельца' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('account_blocked');
    const { rowCount } = await pool.query('SELECT 1 FROM account_sessions');
    expect(rowCount).toBe(0);
  });

  it('logout уничтожает сессию НА СЕРВЕРЕ: старая кука больше не работает', async () => {
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register', headers: { origin: 'https://widget.aski.pro' },
      payload: { email: 'bye@example.com', password: 'пароль-владельца' },
    });
    const cookie = cookieOf(reg);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, origin: 'https://widget.aski.pro' } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
    const { rowCount } = await pool.query('SELECT 1 FROM account_sessions');
    expect(rowCount).toBe(0);
  });

  it('в БД лежит ХЭШ токена, а не сам токен', async () => {
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register', headers: { origin: 'https://widget.aski.pro' },
      payload: { email: 'hash@example.com', password: 'пароль-владельца' },
    });
    const token = cookieOf(reg).split('=')[1]!;
    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM account_sessions');
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('протухшая сессия не пускает', async () => {
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register', headers: { origin: 'https://widget.aski.pro' },
      payload: { email: 'stale@example.com', password: 'пароль-владельца' },
    });
    await pool.query("UPDATE account_sessions SET expires_at = now() - interval '1 minute'");
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieOf(reg) } })).statusCode).toBe(401);
  });

  it('POST с ЧУЖИМ Origin отвергается (CSRF-барьер D-5)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: 'a@b.c', password: 'пароль-владельца' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('cross_origin_denied');
  });

  it('POST БЕЗ заголовка Origin отвергается (не браузер)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'a@b.c', password: 'пароль-владельца' },
    });
    expect(res.statusCode).toBe(403);
  });
});
