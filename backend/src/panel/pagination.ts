import { ApiError } from '../http/errors.ts';

/**
 * Keyset-пагинация панельных листингов.
 *
 * ⚠️ Отклонение от буквы плана: отдельного модуля в списке файлов Task 14 не
 * было, но курсор нужен ДВУМ задачам подряд (лиды — Task 14, диалоги — Task 15)
 * и обязан кодироваться и разбираться ОДИНАКОВО. Копия разъехалась бы на первой
 * же правке формата.
 *
 * Почему keyset, а не OFFSET: лиды приходят непрерывно, и на втором экране
 * OFFSET показал бы владельцу строки, которые он уже видел (или спрятал бы
 * новые). Курсор — пара (время, id): id разводит строки с СОВПАДАЮЩИМ временем,
 * без него страница зациклилась бы на них.
 */
/**
 * ⚠️ `at` — СТРОКА, а не `Date`, и это не стилистика.
 *
 * `timestamptz` в Postgres хранит МИКРОсекунды, а драйвер `pg` отдаёт JS `Date`
 * с точностью до миллисекунды. Курсор, собранный из такого `Date`, оказывается
 * РАНЬШЕ реальной строки на её же микросекунды, и условие
 * `(created_at, id) < (курсор)` не находит НИ ОДНОЙ строки той же миллисекунды.
 * Поймано красным тестом батчевого экспорта: 1200 лидов, вставленных одним
 * INSERT (у всех одинаковый `now()`), выгружались первой страницей в 500 строк,
 * а остальные 700 молча пропадали.
 *
 * Поэтому репозитории отдают рядом с `created_at` ещё и `cursor_at` —
 * `to_char(... 'US')` с полной микросекундной точностью. Она уезжает в курсор
 * как есть и возвращается в SQL параметром `::timestamptz`, а сравнение
 * остаётся на СЫРОЙ колонке — то есть индекс (widget_id, created_at DESC,
 * id DESC) продолжает работать. Округлять вместо этого (`date_trunc`) нельзя:
 * порядок пришлось бы считать по тому же выражению, и индекс перестал бы
 * применяться.
 */
export type Cursor = { at: string; id: string };

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/**
 * Курсор наружу — непрозрачная строка. Base64url от `<ISO>|<uuid>`: клиенту не
 * на что опереться, кроме «вернуть как есть», и формат можно менять, не ломая
 * панель. Шифровать нечего — внутри время и uuid уже отданной строки.
 */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, 'utf8').toString('base64url');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Разбор курсора из query. Мусор — это 422 с внятным кодом, а НЕ 500: курсор
 * приходит из адресной строки, и опечатка в ней не должна выглядеть как падение
 * сервера. Невалидная дата тоже отсекается здесь — иначе `Invalid Date` уехал
 * бы в SQL и уронил запрос уже в Postgres.
 */
export function parseCursor(raw: unknown): Cursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const invalid = (): ApiError => new ApiError(422, 'invalid_cursor', 'Курсор страницы повреждён — начните листинг заново.');
  if (typeof raw !== 'string') throw invalid();

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator === -1) throw invalid();
  const at = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  // Метку времени проверяем на разбор, но в SQL уезжает ИСХОДНАЯ строка: `Date`
  // отрезал бы микросекунды и сломал бы страницу (см. комментарий к Cursor).
  if (Number.isNaN(new Date(at).getTime()) || !UUID_RE.test(id)) throw invalid();
  return { at, id };
}

/** Размер страницы из query: без параметра — дефолт, мусор — 422. */
export function parseLimit(raw: unknown, fallback = DEFAULT_PAGE_LIMIT): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ApiError(422, 'invalid_limit', `limit — целое от 1 до ${MAX_PAGE_LIMIT}.`);
  }
  return limit;
}

/**
 * Страница + курсор продолжения из выборки на ОДНУ строку больше запрошенной.
 *
 * Лишняя строка — единственный честный способ ответить «есть ли ещё»: без неё
 * последняя полная страница всегда отдавала бы next_cursor, и панель делала бы
 * заведомо пустой запрос, а владелец видел бы кнопку «ещё», ведущую в пустоту.
 */
export function pageOf<T>(rows: T[], limit: number, cursorOf: (row: T) => Cursor): { page: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { page: rows, nextCursor: null };
  const page = rows.slice(0, limit);
  return { page, nextCursor: encodeCursor(cursorOf(page[page.length - 1]!)) };
}
