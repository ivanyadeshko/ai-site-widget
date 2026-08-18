import type { FastifyPluginAsync } from 'fastify';
import { requireAccount, requireAdmin } from '../../auth/guards.ts';
import { revokeAllSessionsOfAccount } from '../../auth/sessions.ts';
import { CoreHttpError } from '../../core/client.ts';
import type { CreditsBalance } from '../../core/types.ts';
import { findAccountLimits, upsertAccountLimits } from '../../db/repositories/accountLimits.ts';
import {
  SYSTEM_ACCOUNT_EMAIL, adminListAccountsWithStats, findAccountById, setAccountBlocked,
  type AccountRow, type AdminAccountRow,
} from '../../db/repositories/accounts.ts';
import { clearFailures } from '../../db/repositories/authFailures.ts';
import { adminUsageByAccount, adminUsageTotals } from '../../db/repositories/usage.ts';
import { adminListWidgets, type AdminWidgetRow } from '../../db/repositories/widgets.ts';
import { ApiError } from '../../http/errors.ts';
import { pageOf, parseCursor, parseLimit } from '../../panel/pagination.ts';
import { parseReportPeriod } from '../../panel/period.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Потолок суточного капа аккаунта. Не «бесконечность»: `account_limits` — это
 * предохранитель от выжигания баланса ОБЩЕГО тенанта ядра (D-1), и опечатка
 * оператора в лишний ноль не должна снимать предохранитель молча. Ноль
 * разрешён — это штатный способ временно погасить клиента, не блокируя его.
 */
const MAX_SESSIONS_CAP = 100_000;

/** Как долго живёт кэш баланса ядра: админка перерисовывается чаще, чем меняются деньги. */
const CREDITS_CACHE_MS = 30_000;

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

/** Строка списка виджетов витрины; служебная метка курсора остаётся внутри. */
const toPublicWidget = (row: AdminWidgetRow) => ({
  id: row.id,
  name: row.name,
  publish_token: row.publish_token,
  enabled: row.enabled,
  created_at: row.created_at,
  account_id: row.account_id,
  owner_email: row.owner_email,
  owner_blocked: row.owner_blocked,
  dialogs_total: row.dialogs_total,
});

const accountNotFound = (): ApiError => new ApiError(404, 'account_not_found', 'Аккаунт не найден.');

/**
 * Суточный кап из тела PUT. Отдельная функция, потому что «мусор» здесь — это
 * не только отрицательное число: `'10'` строкой и `1.5` уехали бы в
 * `INTEGER`-колонку и превратились бы в 500 из Postgres.
 */
const parseSessionsCap = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_SESSIONS_CAP) {
    throw new ApiError(
      422, 'invalid_limit',
      `max_sessions_per_day — целое от 0 до ${MAX_SESSIONS_CAP}. Ноль гасит виджеты клиента, не блокируя аккаунт.`,
    );
  }
  return raw;
};

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

  /** Все виджеты витрины: чей это токен, включён ли, жив ли владелец. */
  app.get<{ Querystring: { account_id?: string; limit?: string; cursor?: string } }>(
    '/widgets',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const accountId = req.query.account_id ?? null;
      // Кривой uuid в фильтре — пустой список, а не 500 из Postgres (22P02).
      // 404 здесь был бы враньём: ручка существует, просто фильтр ни во что не
      // попадает.
      if (accountId !== null && !UUID_RE.test(accountId)) {
        return reply.send({ widgets: [], next_cursor: null });
      }
      const limit = parseLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);
      const rows = await adminListWidgets(app.deps.pool, { accountId, limit: limit + 1, cursor });
      const { page, nextCursor } = pageOf(rows, limit, (row) => ({ at: row.cursor_at, id: row.id }));
      return reply.send({ widgets: page.map(toPublicWidget), next_cursor: nextCursor });
    },
  );

  /**
   * Расход витрины в разрезе аккаунтов.
   *
   * Период разбирается ТЕМ ЖЕ `parseReportPeriod`, что и в кабинете: те же
   * границы (`from` включительно, `to` исключительно), тот же потолок в 366
   * дней и те же коды ошибок. Свой парсер здесь означал бы, что одна и та же
   * дата даёт в админке и в кабинете разные числа, — и первым это заметил бы
   * клиент, а не оператор.
   */
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/usage',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { from, to } = parseReportPeriod(req.query.from, req.query.to);
      const [buckets, totals] = await Promise.all([
        adminUsageByAccount(app.deps.pool, { from, to }),
        adminUsageTotals(app.deps.pool, { from, to }),
      ]);
      return reply.send({ from: from.toISOString(), to: to.toISOString(), buckets, totals });
    },
  );

  app.get<{ Params: { id: string } }>('/accounts/:id/limits', async (req, reply) => {
    const target = await loadTarget(req.params.id);
    const limits = await findAccountLimits(app.deps.pool, target.id);
    return reply.send({
      limits: {
        // null — «своей строки нет», а НЕ «лимита нет»: действует дефолт стенда.
        // Схлопнуть это в одно число значило бы соврать оператору, что кап
        // выставлен руками, и отнять у нас право менять дефолт.
        max_sessions_per_day: limits?.max_sessions_per_day ?? null,
        effective_default: app.deps.config.maxSessionsPerAccountPerDay,
      },
    });
  });

  /**
   * Персональный кап клиента. Действует НЕМЕДЛЕННО: допуск (`budget.ts`) читает
   * `account_limits` на каждом старте сессии, кэша между ними нет.
   */
  app.put<{ Params: { id: string }; Body: { max_sessions_per_day?: unknown } }>(
    '/accounts/:id/limits',
    async (req, reply) => {
      const target = await loadTarget(req.params.id);
      const maxSessionsPerDay = parseSessionsCap(req.body?.max_sessions_per_day);
      const saved = await upsertAccountLimits(app.deps.pool, {
        accountId: target.id,
        maxSessionsPerDay,
        // Кто менял — записано: спор «кто выключил клиента» решается строкой в
        // БД, а не воспоминаниями.
        updatedBy: req.account!.id,
      });
      return reply.send({
        limits: {
          max_sessions_per_day: saved.max_sessions_per_day,
          effective_default: app.deps.config.maxSessionsPerAccountPerDay,
        },
      });
    },
  );

  /*
   * Кэш баланса ядра — В СКОУПЕ ПЛАГИНА, а не в модуле.
   *
   * Модульная переменная пережила бы закрытие приложения и утекла бы в
   * следующий инстанс: в тестах это чужой баланс из соседнего файла, в проде —
   * баланс, который не сбросить рестартом воркера. Живёт ровно столько,
   * сколько живёт сам сервер.
   */
  let cached: { balance: CreditsBalance; fetchedAt: Date } | null = null;

  /**
   * Баланс кредитов тенанта. ОБЩИЙ на всю витрину (D-1) — UI обязан подписать
   * это прямым текстом, иначе оператор прочитает цифру как баланс клиента.
   */
  app.get('/core/credits', async (_req, reply) => {
    if (cached === null || Date.now() - cached.fetchedAt.getTime() > CREDITS_CACHE_MS) {
      try {
        cached = { balance: await app.deps.core.getCreditsBalance(), fetchedAt: new Date() };
      } catch (err) {
        // Недоступность ЧУЖОЙ системы — не ошибка витрины: 500 отправил бы
        // оператора чинить панель вместо того, чтобы смотреть на ядро. Провал
        // НЕ кэшируется — иначе после починки ядра пришлось бы ждать окно
        // кэша, чтобы увидеть живые цифры.
        if (err instanceof CoreHttpError) {
          throw new ApiError(503, 'core_unavailable', `Ядро не отдало баланс: ${err.message}`);
        }
        throw err;
      }
    }
    return reply.send({ balance: cached.balance, fetched_at: cached.fetchedAt.toISOString() });
  });
};
