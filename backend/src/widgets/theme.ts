import { ApiError } from '../http/errors.ts';

/**
 * Оформление виджета на чужом сайте.
 *
 * Все поля НЕобязательные: в БД лежит только то, что владелец реально задал
 * (`{}` = «всё по умолчанию»). Дефолты добираются на выходе — в `themeForConfig`,
 * и наружу, в `/w/v1/:token/config`, уезжает уже ПОЛНЫЙ набор. Так лоадер
 * (`embed/loader`, бюджет 8 КБ gzip) не носит в себе ни одного значения и ни
 * одной проверки: данные приходят из своей же БД, провалидированные здесь (D-9).
 */
export type WidgetTheme = {
  /** '#RRGGBB' — фон круглой кнопки и акцент внутри панели. */
  color?: string;
  /** Сторона экрана, к которой прижаты кнопка и панель. */
  position?: 'right' | 'left';
  /** Значок на кнопке: 1–2 code point'а (эмодзи — один). */
  button_label?: string;
  /** Заголовок панели диалога. */
  title?: string;
  /** aria-label и tooltip кнопки: единственное, что читает скринридер до клика. */
  launcher_title?: string;
};

/**
 * Дефолты, у которых нет зависимости от самого виджета. `title` и
 * `launcher_title` сюда не входят: их значение по умолчанию строится из имени
 * виджета (см. `themeForConfig`), а константы вида «Чат» переименовали бы
 * кнопку на каждом сайте, где владелец подписи не трогал.
 */
export const DEFAULT_THEME: Required<Pick<WidgetTheme, 'color' | 'position' | 'button_label'>> = {
  color: '#2563eb',
  position: 'right',
  button_label: '💬',
};

export const TITLE_MAX = 40;
export const LAUNCHER_TITLE_MAX = 60;
export const BUTTON_LABEL_MAX = 2;

/**
 * Префикс дефолтной подписи кнопки. Продублирован в `embed/loader/src/loader.ts`
 * как фолбэк `aria-label` на случай отката образа бэкенда: общего файла у
 * бандла для чужого сайта и у бэкенда нет и быть не может, поэтому расхождение
 * ловит только тест-пин (`backend/test/widgetTheme.test.ts`).
 */
export const LAUNCHER_TITLE_PREFIX = 'Открыть чат: ';

/**
 * Последний рубеж для заголовка: имя виджета вида `<<>>` после чистки
 * (`derived`) не оставляет НИ ОДНОГО символа, а `/config` обязан отдавать все
 * поля темы непустыми — лоадер подставляет их без проверок. Именно поэтому
 * константа-заглушка допустима здесь и недопустима как общий дефолт: она
 * срабатывает только там, где показать нечего в принципе.
 */
export const TITLE_FALLBACK = 'Чат';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const POSITIONS = new Set(['right', 'left']);
/**
 * Символы, запрещённые в ЛЮБОМ строковом поле темы.
 *
 * `<` и `>` — потому что значения уезжают в Shadow DOM лоадера, а `\n`, `\r` и
 * управляющие — потому что оттуда же они попадают в шаблонную строку `<style>`
 * и в значения атрибутов. DOM-API (`textContent`, `setAttribute`) экранирует
 * само, но лоадер валидации не содержит вовсе — эта проверка и есть его
 * единственная линия защиты.
 */
const FORBIDDEN_RE = /[<>\u0000-\u001f\u007f]/;
/** Тот же класс символов для ЗАМЕНЫ (а не проверки) — см. `derived`. */
const FORBIDDEN_RE_GLOBAL = /[<>\u0000-\u001f\u007f]/g;

const KNOWN_FIELDS = new Set<keyof WidgetTheme>([
  'color', 'position', 'button_label', 'title', 'launcher_title',
]);

const invalid = (message: string): ApiError => new ApiError(422, 'invalid_theme', message);

const parseText = (raw: unknown, field: string, max: number): string => {
  if (typeof raw !== 'string') throw invalid(`Поле «${field}» должно быть строкой.`);
  const value = raw.trim();
  if (value === '') throw invalid(`Поле «${field}» не может быть пустым — уберите его целиком.`);
  // Длину считаем в code point'ах: у эмодзи `.length` равна 2, и «🤖» не влезал
  // бы в лимит из двух символов, будучи ОДНИМ видимым знаком.
  if (Array.from(value).length > max) throw invalid(`Поле «${field}» — не длиннее ${max} символов.`);
  if (FORBIDDEN_RE.test(value)) {
    throw invalid(`Поле «${field}» не должно содержать «<», «>» и переводы строк.`);
  }
  return value;
};

/**
 * Разбор темы из тела PATCH. Неизвестные поля — ошибка, а не тихое
 * игнорирование: владелец, опечатавшийся в имени поля, обязан узнать об этом
 * сразу, а не искать потом, почему цвет «не сохраняется».
 */
export function parseTheme(raw: unknown): WidgetTheme {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('Оформление должно быть объектом.');
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!KNOWN_FIELDS.has(key as keyof WidgetTheme)) {
      throw invalid(`Неизвестное поле оформления: ${key}.`);
    }
  }

  const theme: WidgetTheme = {};

  if (input.color !== undefined) {
    if (typeof input.color !== 'string' || !COLOR_RE.test(input.color.trim())) {
      throw invalid('Цвет задаётся в формате #RRGGBB, например #2563eb.');
    }
    theme.color = input.color.trim().toLowerCase();
  }

  if (input.position !== undefined) {
    if (typeof input.position !== 'string' || !POSITIONS.has(input.position)) {
      throw invalid('Положение — «right» или «left».');
    }
    theme.position = input.position as 'right' | 'left';
  }

  if (input.button_label !== undefined) {
    theme.button_label = parseText(input.button_label, 'button_label', BUTTON_LABEL_MAX);
  }
  if (input.title !== undefined) {
    theme.title = parseText(input.title, 'title', TITLE_MAX);
  }
  if (input.launcher_title !== undefined) {
    theme.launcher_title = parseText(input.launcher_title, 'launcher_title', LAUNCHER_TITLE_MAX);
  }

  return theme;
}

/**
 * Значение, ВЫВЕДЕННОЕ не из темы (сегодня — из имени виджета), приведённое к
 * правилам темы.
 *
 * Зачем: `parseWidgetName` (widgets/validation.ts) проверяет только длину
 * 1..100 и разрешает и «<», и «>», и переводы строк. Без этой чистки `/config`
 * отдавал бы наружу `title`, который сам же бэкенд отверг бы на записи, — а
 * весь инвариант D-9 («в `w.js` нет валидации, потому что валидирует бэкенд»)
 * держится ровно на обратном: из `/config` не может приехать значение, не
 * прошедшее правила темы. Здесь именно ЧИСТКА, а не отказ: имя виджета
 * владелец задал легально, и ронять из-за него публичную ручку нельзя.
 */
const derived = (value: string, max: number): string => {
  const clean = Array.from(value.replace(FORBIDDEN_RE_GLOBAL, ' ').trim().replace(/\s+/g, ' '));
  // Обрезаем по code point'ам, а не по `.slice`: разрез посреди суррогатной
  // пары дал бы «половину эмодзи» — невалидный UTF-16 в JSON.
  return clean.length > max ? clean.slice(0, max).join('').trimEnd() : clean.join('');
};

/**
 * Тема для публичного `/config` — ПОЛНАЯ, без единого пропуска.
 *
 * ⚠️ Отклонение от буквы плана: в интерфейсе задачи сигнатура была
 * `themeForConfig(stored)`, но вернуть `Required<WidgetTheme>` без имени виджета
 * нельзя — дефолт `title`/`launcher_title` строится именно из него. Константа
 * вместо имени сменила бы подпись кнопки («Открыть чат: <имя>», loader.ts:74)
 * на каждом сайте, где владелец её не задавал, то есть тихо сломала бы
 * доступность у всех существующих виджетов.
 */
export function themeForConfig(stored: WidgetTheme, widgetName: string): Required<WidgetTheme> {
  const title = stored.title ?? (derived(widgetName, TITLE_MAX) || TITLE_FALLBACK);
  return {
    color: stored.color ?? DEFAULT_THEME.color,
    position: stored.position ?? DEFAULT_THEME.position,
    button_label: stored.button_label ?? DEFAULT_THEME.button_label,
    title,
    launcher_title: stored.launcher_title
      ?? derived(`${LAUNCHER_TITLE_PREFIX}${title}`, LAUNCHER_TITLE_MAX),
  };
}
