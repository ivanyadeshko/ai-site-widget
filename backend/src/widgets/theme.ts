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
  const title = stored.title ?? widgetName;
  return {
    color: stored.color ?? DEFAULT_THEME.color,
    position: stored.position ?? DEFAULT_THEME.position,
    button_label: stored.button_label ?? DEFAULT_THEME.button_label,
    title,
    launcher_title: stored.launcher_title ?? `Открыть чат: ${title}`,
  };
}
