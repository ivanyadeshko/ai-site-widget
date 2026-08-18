import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/auth/password.ts';
import { SYSTEM_ACCOUNT_EMAIL } from '../src/db/repositories/accounts.ts';
import { bumpFailure, isLocked } from '../src/db/repositories/authFailures.ts';
import { insertDialog } from '../src/db/repositories/dialogs.ts';
import { buildTestApp } from './helpers/app.ts';
import { seedAccount, seedWidget, testPool, truncateAll } from './helpers/db.ts';

const pool = testPool();
let app: FastifyInstance;
let close: () => Promise<void>;

const ORIGIN = 'https://widget.aski.pro';
const PASSWORD = 'пароль-владельца';
const SOME_UUID = '11111111-1111-4111-8111-111111111111';

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

/** Аккаунт с настоящим scrypt-хэшем + вход в него: гарды проверяются целиком. */
const signIn = async (email: string, isAdmin = false): Promise<{ id: string; cookie: string }> => {
  const account = await seedAccount(pool, { email, passwordHash: await hashPassword(PASSWORD), isAdmin });
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    headers: { origin: ORIGIN }, payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return { id: account.id, cookie: cookieOf(res) };
};

type AdminAccount = {
  id: string; email: string; is_admin: boolean; blocked_at: string | null;
  created_at: string; last_login_at: string | null;
  widgets_count: number; dialogs_30d: number;
};

describe('админ-поверхность: аккаунты витрины', () => {
  it('обычный аккаунт получает 404 на КАЖДОМ admin-пути — существование поверхности не подтверждаем', async () => {
    const { cookie } = await signIn('plain@example.com');
    const calls: [string, string][] = [
      ['GET', '/api/v1/admin/accounts'],
      ['POST', `/api/v1/admin/accounts/${SOME_UUID}/block`],
      ['POST', `/api/v1/admin/accounts/${SOME_UUID}/unblock`],
      ['POST', `/api/v1/admin/accounts/${SOME_UUID}/unlock-login`],
    ];
    for (const [method, url] of calls) {
      const res = await app.inject({ method: method as 'GET', url, headers: { cookie, origin: ORIGIN } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      // 403 сказал бы «поверхность есть, но не для тебя» — ровно то, что скрываем.
      expect(res.json().error.code, `${method} ${url}`).toBe('not_found');
    }
  });

  it('аноним получает 401, а не 404: вход требуется раньше, чем решается роль', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/accounts' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('админ видит список аккаунтов с агрегатами widgets_count и dialogs_30d', async () => {
    const admin = await signIn('root@example.com', true);
    const owner = await seedAccount(pool, { email: 'shop@example.com' });
    const widget = await seedWidget(pool, { accountId: owner.id });
    await seedWidget(pool, { accountId: owner.id });
    const fresh = await insertDialog(pool, { widgetId: widget.id, visitorKey: SOME_UUID });
    const old = await insertDialog(pool, { widgetId: widget.id, visitorKey: SOME_UUID });
    // Диалог старше 30 дней в срез «за 30 дней» попадать не должен.
    await pool.query("UPDATE dialogs SET started_at = now() - interval '40 days' WHERE id = $1", [old.id]);
    expect(fresh.id).toBeTruthy();

    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/accounts', headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const accounts = res.json().accounts as AdminAccount[];
    const row = accounts.find((a) => a.email === 'shop@example.com')!;
    expect(row).toBeDefined();
    expect(row.widgets_count).toBe(2);
    expect(row.dialogs_30d).toBe(1);
    // Хэш пароля не уезжает наружу НИ В КАКОМ виде — даже админу.
    expect(res.body).not.toContain('password');
    // Админ видит и себя, и системный аккаунт: список — весь, без фильтров.
    expect(accounts.some((a) => a.email === SYSTEM_ACCOUNT_EMAIL)).toBe(true);
  });

  it('список листается курсором без повторов и пропусков', async () => {
    const admin = await signIn('pager@example.com', true);
    for (let i = 0; i < 4; i += 1) await seedAccount(pool, { email: `owner-${i}@example.com` });

    const seen: string[] = [];
    let url = '/api/v1/admin/accounts?limit=2';
    for (let page = 0; page < 5; page += 1) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { accounts: AdminAccount[]; next_cursor: string | null };
      seen.push(...body.accounts.map((a) => a.id));
      if (body.next_cursor === null) break;
      url = `/api/v1/admin/accounts?limit=2&cursor=${encodeURIComponent(body.next_cursor)}`;
    }
    // 4 владельца + сам админ + системный аккаунт, каждый ровно по разу.
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('блокировка ставит blocked_at и ГАСИТ живые сессии аккаунта немедленно', async () => {
    const admin = await signIn('root@example.com', true);
    const victim = await signIn('victim@example.com');
    // До блокировки кука жертвы рабочая.
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: victim.cookie } })).statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/accounts/${victim.id}/block`,
      headers: { cookie: admin.cookie, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.blocked_at).not.toBeNull();

    // Отзыв сессий — не «протухнет само»: строк в account_sessions больше нет.
    const { rowCount } = await pool.query('SELECT 1 FROM account_sessions WHERE account_id = $1', [victim.id]);
    expect(rowCount).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: victim.cookie } })).statusCode).toBe(401);

    const back = await app.inject({
      method: 'POST', url: `/api/v1/admin/accounts/${victim.id}/unblock`,
      headers: { cookie: admin.cookie, origin: ORIGIN },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().account.blocked_at).toBeNull();
  });

  it('админ не может заблокировать сам себя — иначе оператор запирает себя снаружи', async () => {
    const admin = await signIn('root@example.com', true);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/accounts/${admin.id}/block`,
      headers: { cookie: admin.cookie, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('cannot_block_self');
  });

  it('системный аккаунт заблокировать нельзя — под ним висят бэкфилленные виджеты', async () => {
    const admin = await signIn('root@example.com', true);
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM accounts WHERE email = $1', [SYSTEM_ACCOUNT_EMAIL],
    );
    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/accounts/${rows[0]!.id}/block`,
      headers: { cookie: admin.cookie, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('system_account_protected');
  });

  it('несуществующий и синтаксически кривой id дают 404, а не 500', async () => {
    const admin = await signIn('root@example.com', true);
    for (const id of [SOME_UUID, 'не-uuid']) {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/admin/accounts/${id}/block`,
        headers: { cookie: admin.cookie, origin: ORIGIN },
      });
      expect(res.statusCode, id).toBe(404);
      expect(res.json().error.code, id).toBe('account_not_found');
    }
  });

  /**
   * Единственный выход из login-lock: восстановления пароля у витрины нет (D-4),
   * а счётчик неудач сам по себе не рассасывается — без этой ручки владельца
   * вытаскивают SQL'ем руками.
   */
  it('unlock-login возвращает вход владельцу немедленно, с ВЕРНЫМ паролем', async () => {
    const admin = await signIn('root@example.com', true);
    const locked = await signIn('locked@example.com');

    for (let i = 0; i < 10; i += 1) {
      await app.inject({
        method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN },
        payload: { email: 'locked@example.com', password: `мимо-${i}` },
      });
    }
    const denied = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN },
      payload: { email: 'locked@example.com', password: PASSWORD },
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('login_locked');

    const unlock = await app.inject({
      method: 'POST', url: `/api/v1/admin/accounts/${locked.id}/unlock-login`,
      headers: { cookie: admin.cookie, origin: ORIGIN },
    });
    expect(unlock.statusCode).toBe(200);
    expect(unlock.json().account.email).toBe('locked@example.com');

    const allowed = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN },
      payload: { email: 'locked@example.com', password: PASSWORD },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('unlock-login ищет счётчик по email аккаунта БЕЗ учёта регистра', async () => {
    const admin = await signIn('root@example.com', true);
    const owner = await seedAccount(pool, { email: 'MiXeD@Example.COM', passwordHash: await hashPassword(PASSWORD) });
    // Ключ счётчика собирается из email в нижнем регистре (auth.ts), а в БД
    // лежит исходное написание — ручка обязана попасть в тот же ключ.
    for (let i = 0; i < 10; i += 1) {
      await app.inject({
        method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN },
        payload: { email: 'mixed@example.com', password: 'мимо' },
      });
    }
    expect(await isLocked(pool, 'login:mixed@example.com')).toBe(true);

    const unlock = await app.inject({
      method: 'POST', url: `/api/v1/admin/accounts/${owner.id}/unlock-login`,
      headers: { cookie: admin.cookie, origin: ORIGIN },
    });
    expect(unlock.statusCode).toBe(200);
    expect(await isLocked(pool, 'login:mixed@example.com')).toBe(false);
  });
});

/**
 * Тот же фикс, что и unlock-login, только со стороны счётчика (находка
 * кросс-ревью потока I, MAJOR): пока `bumpFailure` продлевал окно на КАЖДОЙ
 * неудаче после порога, одна неверная попытка раз в 15 минут держала владельца
 * снаружи вечно — и вручную снимать блокировку приходилось бы бесконечно.
 */
describe('окно блокировки входа не продлевается вечно', () => {
  const KEY = 'login:dos@example.com';

  it('истёкшее окно начинает НОВЫЙ отсчёт, а не продлевает старое', async () => {
    for (let i = 0; i < 10; i += 1) await bumpFailure(pool, KEY, 10, 15);
    expect(await isLocked(pool, KEY)).toBe(true);

    // Окно истекло само — владелец мог бы войти прямо сейчас.
    await pool.query("UPDATE auth_failures SET locked_until = now() - interval '1 minute' WHERE subject_key = $1", [KEY]);
    expect(await isLocked(pool, KEY)).toBe(false);

    // Одиночная неудача (в том числе чужая, по email жертвы) НЕ обязана
    // возвращать блокировку: счётчик начинается заново.
    const after = await bumpFailure(pool, KEY, 10, 15);
    expect(after.failures).toBe(1);
    expect(after.lockedUntil).toBeNull();
    expect(await isLocked(pool, KEY)).toBe(false);
  });

  it('внутри живого окна счётчик по-прежнему растёт и блокировку держит', async () => {
    for (let i = 0; i < 10; i += 1) await bumpFailure(pool, KEY, 10, 15);
    const eleventh = await bumpFailure(pool, KEY, 10, 15);
    expect(eleventh.failures).toBe(11);
    expect(await isLocked(pool, KEY)).toBe(true);
  });
});

/**
 * Первого админа назначить неоткуда: «первый зарегистрировавшийся = админ» на
 * публичном URL — дыра, а через UI это курица и яйцо. Значит CLI, и он обязан
 * работать НА САМОМ ДЕЛЕ — тест запускает настоящий процесс.
 */
describe('CLI выдачи прав администратора', () => {
  const script = fileURLToPath(new URL('../scripts/grant-admin.mjs', import.meta.url));
  const run = (email: string): { status: number; out: string } => {
    try {
      const out = execFileSync('node', [script, email], {
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL! },
        encoding: 'utf8',
      });
      return { status: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  it('выдаёт is_admin по email без учёта регистра', async () => {
    const account = await seedAccount(pool, { email: 'Boss@Example.com' });
    const res = run('boss@EXAMPLE.com');
    expect(res.status, res.out).toBe(0);
    const { rows } = await pool.query<{ is_admin: boolean }>(
      'SELECT is_admin FROM accounts WHERE id = $1', [account.id],
    );
    expect(rows[0]!.is_admin).toBe(true);
  });

  it('на несуществующем аккаунте выходит с кодом 1 и говорит об этом', async () => {
    const res = run('ghost@example.com');
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/ghost@example\.com/);
  });
});
