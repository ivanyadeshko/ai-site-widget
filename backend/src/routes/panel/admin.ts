import type { FastifyPluginAsync } from 'fastify';
import { requireAccount, requireAdmin } from '../../auth/guards.ts';
import { revokeAllSessionsOfAccount } from '../../auth/sessions.ts';
import {
  SYSTEM_ACCOUNT_EMAIL, adminListAccountsWithStats, findAccountById, setAccountBlocked,
  type AccountRow, type AdminAccountRow,
} from '../../db/repositories/accounts.ts';
import { clearFailures } from '../../db/repositories/authFailures.ts';
import { ApiError } from '../../http/errors.ts';
import { pageOf, parseCursor, parseLimit } from '../../panel/pagination.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Наружу уезжает РОВНО это. `password_hash` в админский срез не попадает даже
 * теоретически: `adminListAccountsWithStats` его не выбирает, а одиночные
 * ответы собираются вот этой функцией по именам полей, а не спредом строки.
 */
const toPublicAccount = (account: AccountRow) => ({
  id: account.id,
  email: account.email,
  is_admin: account.is_admin,
  blocked_at: account.blocked_at,
  created_at: account.created_at,
  last_login_at: account.last_login_at,
});

/** Строка списка: то же плюс агрегаты; служебная метка курсора остаётся внутри. */
const toPublicListRow = (row: AdminAccountRow) => ({
  id: row.id,
  email: row.email,
  is_admin: row.is_admin,
  blocked_at: row.blocked_at,
  created_at: row.created_at,
  last_login_at: row.last_login_at,
  widgets_count: row.widgets_count,
  dialogs_30d: row.dialogs_30d,
});

const accountNotFound = (): ApiError => new ApiError(404, 'account_not_found', 'Аккаунт не найден.');

/**
 * Админ-поверхность оператора витрины. Регистрируется ВНУТРИ `panelRoutes` с
 * `{ prefix: '/admin' }` — только там она наследует CSRF-барьер и формат ошибок
 * панели (см. комментарий в `panel/index.ts`).
 *
 * ЗАЩИТА ЖИВЁТ ЗДЕСЬ, А НЕ В SPA. Клиентский гард роутера панели прячет пункт
 * меню и разворачивает не-админа с `/panel/admin/*` — это удобство, а не
 * барьер: любой может открыть DevTools и позвать ручку напрямую. Барьер —
 * `requireAdmin` на весь скоуп плагина, отвечающий 404, а не 403.
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  // Оба гарда — хуками на скоуп, а не опцией каждого роута: новая админская
  // ручка не может «забыть» проверку роли, а забытая проверка здесь стоит
  // дороже всего остального в этом файле.
  app.addHook('preHandler', requireAccount);
  app.addHook('preHandler', requireAdmin);

  /** Аккаунт из пути + все запреты, общие для block/unblock/unlock-login. */
  const loadTarget = async (id: string): Promise<AccountRow> => {
    // Кривой uuid — 404, а не 500: `WHERE id = 'не-uuid'` роняет Postgres
    // ошибкой 22P02 ещё до всякой логики.
    if (!UUID_RE.test(id)) throw accountNotFound();
    const account = await findAccountById(app.deps.pool, id);
    if (!account) throw accountNotFound();
    return account;
  };

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/accounts',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const limit = parseLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);
      // На строку больше запрошенного — единственный честный способ узнать,
      // есть ли продолжение (см. pageOf).
      const rows = await adminListAccountsWithStats(app.deps.pool, { limit: limit + 1, cursor });
      const { page, nextCursor } = pageOf(rows, limit, (row) => ({ at: row.cursor_at, id: row.id }));
      return reply.send({ accounts: page.map(toPublicListRow), next_cursor: nextCursor });
    },
  );

  /**
   * Блокировка владельца сайта. Гасит ТРИ вещи разом: вход (`login` отвечает
   * 403), живые cookie-сессии (`revokeAllSessionsOfAccount`) и публичный путь
   * его виджетов (`owner_blocked` в `findWidgetByToken`). Отзыв сессий здесь
   * обязателен: без него заблокированный работает в открытой вкладке до
   * истечения куки — то есть до 30 суток.
   */
  app.post<{ Params: { id: string } }>('/accounts/:id/block', async (req, reply) => {
    const target = await loadTarget(req.params.id);

    // Оператор, запёрший себя снаружи, не может разблокироваться сам: админка
    // требует живой сессии, а блокировка её только что отозвала.
    if (target.id === req.account!.id) {
      throw new ApiError(422, 'cannot_block_self', 'Нельзя заблокировать собственный аккаунт.');
    }
    // На системном аккаунте висят виджеты, бэкфилленные миграцией Task 1, —
    // его блокировка погасила бы демо-виджет и смок-гейт деплоя.
    if (target.email === SYSTEM_ACCOUNT_EMAIL) {
      throw new ApiError(
        422, 'system_account_protected',
        'Системный аккаунт заблокировать нельзя: на нём висят виджеты, заведённые до появления аккаунтов.',
      );
    }

    await setAccountBlocked(app.deps.pool, target.id, true);
    await revokeAllSessionsOfAccount(app.deps, target.id);
    const updated = await findAccountById(app.deps.pool, target.id);
    if (!updated) throw accountNotFound();
    return reply.send({ account: toPublicAccount(updated) });
  });

  app.post<{ Params: { id: string } }>('/accounts/:id/unblock', async (req, reply) => {
    const target = await loadTarget(req.params.id);
    await setAccountBlocked(app.deps.pool, target.id, false);
    // Сессии НЕ восстанавливаются: отозванные — отозваны, владелец входит
    // заново. Иначе пришлось бы хранить «замороженные» сессии, а это второе
    // состояние там, где хватает одного.
    const updated = await findAccountById(app.deps.pool, target.id);
    if (!updated) throw accountNotFound();
    return reply.send({ account: toPublicAccount(updated) });
  });

  /**
   * Снятие login-lock — ОБЯЗАТЕЛЬНАЯ ручка, а не удобство.
   *
   * Блокировка входа кейтся по email, а не по IP (перебор одного аккаунта идёт
   * с меняющихся адресов). Восстановления пароля у витрины нет (D-4). Значит,
   * без этой ручки единственный выход из блокировки — SQL руками на проде.
   *
   * Парный фикс живёт в `bumpFailure`: отсидевшее окно обнуляет счётчик, иначе
   * оператор снимал бы одну и ту же блокировку бесконечно.
   */
  app.post<{ Params: { id: string } }>('/accounts/:id/unlock-login', async (req, reply) => {
    const target = await loadTarget(req.params.id);
    // Ключ собирается ровно так же, как в `auth.ts`: email в нижнем регистре.
    // В БД лежит ИСХОДНОЕ написание, поэтому lower() здесь обязателен — иначе
    // ручка чистила бы несуществующий ключ и «ничего не делала».
    await clearFailures(app.deps.pool, `login:${target.email.toLowerCase()}`);
    return reply.send({ account: toPublicAccount(target) });
  });
};
