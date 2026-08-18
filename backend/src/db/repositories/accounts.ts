import type { Cursor } from '../../panel/pagination.ts';
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

/*
 * МЕЖАРЕНДАТОРНОЕ ЧТЕНИЕ — ТОЛЬКО НИЖЕ ЭТОЙ ЧЕРТЫ.
 *
 * Всё, что видит аккаунты ЧУЖИЕ, обязано называться `admin*` и зваться
 * исключительно из-под `requireAdmin`. Префикс здесь не украшение: панельные
 * функции несут скоуп аккаунта в самом SQL, и одинаково выглядящий вызов БЕЗ
 * скоупа в новой ручке кабинета — это утечка, которую на ревью надо видеть по
 * имени, не вчитываясь в запрос.
 *
 * ⚠️ Отклонение от интерфейса Task 1: `listAccounts` (страница сырых
 * `AccountRow` по курсору `{createdAt, id}`) заменён на `adminListAccountsWithStats`.
 * Причин две. Первая — единственный её потребитель, админский список, обязан
 * показывать агрегаты, и «список + N запросов за счётчиками» на странице в 50
 * строк это 101 запрос. Вторая — курсор из `Date` теряет микросекунды и молча
 * пропускает строки одной миллисекунды (разобрано в `panel/pagination.ts`),
 * поэтому страница собирается тем же `Cursor`, что и остальные листинги.
 * Функция была мёртвым кодом: ни одного вызова и ни одного теста.
 */

/**
 * Строка админского списка аккаунтов.
 *
 * `password_hash` НЕ выбирается вовсе — даже админу и даже «внутри процесса»:
 * то, чего нет в строке, невозможно случайно отдать наружу вместе с остальным
 * объектом. `cursor_at` — служебная метка keyset-курсора с микросекундами.
 */
export type AdminAccountRow = {
  id: string;
  email: string;
  is_admin: boolean;
  blocked_at: Date | null;
  created_at: Date;
  last_login_at: Date | null;
  widgets_count: number;
  dialogs_30d: number;
  cursor_at: string;
};

/** Окно активности в списке: «жив ли клиент» оператор читает за последний месяц. */
export const ADMIN_ACTIVITY_DAYS = 30;

/**
 * Все аккаунты витрины с агрегатами, keyset-страницей по (created_at DESC, id DESC).
 *
 * Агрегаты — коррелированными подзапросами, а не парой LEFT JOIN + GROUP BY:
 * два независимых JOIN'а от одного аккаунта перемножили бы строки (виджеты ×
 * диалоги), и `widgets_count` вырос бы кратно числу диалогов. Ровно тот класс
 * ошибки, который не виден на пустом стенде и вылезает у первого настоящего
 * клиента.
 */
export async function adminListAccountsWithStats(
  db: Queryable,
  input: { limit: number; cursor: Cursor | null },
): Promise<AdminAccountRow[]> {
  const { rows } = await db.query<AdminAccountRow>(
    `SELECT a.id, a.email, a.is_admin, a.blocked_at, a.created_at, a.last_login_at,
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
            (SELECT count(*)::int FROM widgets w WHERE w.account_id = a.id) AS widgets_count,
            (SELECT count(*)::int
               FROM dialogs d
               JOIN widgets w2 ON w2.id = d.widget_id
              WHERE w2.account_id = a.id
                AND d.started_at >= now() - ($4 || ' days')::interval) AS dialogs_30d
       FROM accounts a
      WHERE ($2::timestamptz IS NULL OR (a.created_at, a.id) < ($2::timestamptz, $3::uuid))
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $1`,
    [input.limit, input.cursor?.at ?? null, input.cursor?.id ?? null, String(ADMIN_ACTIVITY_DAYS)],
  );
  return rows;
}
