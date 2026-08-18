import type { Cursor } from '../../panel/pagination.ts';
import type { WidgetTheme } from '../../widgets/theme.ts';
import type { Queryable } from '../pool.ts';

export type AgentConfig = { instructions: string; greeting?: string; voice_id?: string; avatar_id?: string };

export type WidgetRow = {
  id: string;
  publish_token: string;
  name: string;
  agent_config: AgentConfig;
  kb_ids: string[];
  allowed_origins: string[];
  enabled: boolean;
  created_at: Date;
  /**
   * Владелец виджета. NOT NULL со ВТОРОГО релиза (Task 27): бесхозных строк в
   * проде не осталось (бэкфилл релиза 1 увёл их на системный аккаунт). FK на
   * accounts, ON DELETE CASCADE.
   */
  account_id: string;
  /** Только то, что владелец реально задал; `{}` = «всё по умолчанию». */
  theme: WidgetTheme;
};

/** Виджет вместе с ответом на вопрос «владелец не заблокирован?» — одним запросом. */
export type WidgetWithOwner = WidgetRow & { owner_blocked: boolean };

/** Частичное обновление: `undefined` = «поле не трогать», а не «обнулить». */
export type WidgetPatch = {
  name?: string;
  agentConfig?: AgentConfig;
  allowedOrigins?: string[];
  enabled?: boolean;
  theme?: WidgetTheme;
};

const COLS = 'id, publish_token, name, agent_config, kb_ids, allowed_origins, enabled, created_at, account_id, theme';

export async function findWidgetByToken(db: Queryable, token: string): Promise<WidgetWithOwner | null> {
  // LEFT JOIN, а НЕ INNER. Со второго релиза (Task 27) account_id — NOT NULL,
  // бесхозных строк больше нет, так что практической разницы уже не даёт; LEFT
  // остаётся как ДЕФЕНСИВНЫЙ выбор (INNER молча спрятал бы виджет, у которого
  // FK по какой-то аномалии не сошёлся, вместо того чтобы вернуть его без
  // владельца). Исторически же он был обязателен для аддитивности релиза 1.
  const { rows } = await db.query<WidgetWithOwner>(
    `SELECT w.id, w.publish_token, w.name, w.agent_config, w.kb_ids, w.allowed_origins,
            w.enabled, w.created_at, w.account_id, w.theme,
            (a.blocked_at IS NOT NULL) AS owner_blocked
       FROM widgets w
       LEFT JOIN accounts a ON a.id = w.account_id
      WHERE w.publish_token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

/*
 * ИЗОЛЯЦИЯ АРЕНДАТОРОВ ДЕЛАЕТСЯ ЗДЕСЬ, В SQL.
 *
 * Каждая функция ниже несёт `AND account_id = $N` в самом запросе, а не
 * полагается на проверку в обработчике: проверку легко забыть в новой ручке,
 * а забытый `WHERE` в репозитории виден на code review сразу. Следствие —
 * чужой виджет для аккаунта неотличим от несуществующего, и роут честно
 * отдаёт 404, а не 403 (403 подтвердил бы существование чужого виджета).
 */

export async function listWidgetsByAccount(db: Queryable, accountId: string): Promise<WidgetRow[]> {
  const { rows } = await db.query<WidgetRow>(
    `SELECT ${COLS} FROM widgets WHERE account_id = $1 ORDER BY created_at DESC, id DESC`,
    [accountId],
  );
  return rows;
}

export async function findWidgetByIdForAccount(
  db: Queryable, id: string, accountId: string,
): Promise<WidgetRow | null> {
  const { rows } = await db.query<WidgetRow>(
    `SELECT ${COLS} FROM widgets WHERE id = $1 AND account_id = $2`,
    [id, accountId],
  );
  return rows[0] ?? null;
}

/*
 * ИНВАРИАНТ ТЕМЫ (держит безопасность лоадера на чужом сайте).
 *
 * `widgets.theme` уезжает в `/w/v1/:token/config`, а оттуда — прямо в
 * шаблонную строку `<style>` внутри Shadow DOM на ЧУЖОЙ странице
 * (`embed/loader/src/loader.ts`). Лоадер валидации не содержит вовсе — это
 * осознанное решение ради бюджета 8 КБ gzip (D-9). Значит, единственная
 * линия защиты — вот эти две функции: любая запись в колонку `theme` обязана
 * идти через `parseTheme` (`backend/src/widgets/theme.ts`). Появится третий
 * путь записи (админка, импорт, сид) без него — получим CSS-инъекцию у
 * каждого посетителя сайта владельца.
 */
export async function insertWidget(db: Queryable, input: {
  accountId: string; name: string; publishToken: string;
  agentConfig: AgentConfig; allowedOrigins: string[]; theme?: WidgetTheme;
}): Promise<WidgetRow> {
  const { rows } = await db.query<WidgetRow>(
    `INSERT INTO widgets (account_id, name, publish_token, agent_config, allowed_origins, theme)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
     RETURNING ${COLS}`,
    [
      input.accountId, input.name, input.publishToken,
      JSON.stringify(input.agentConfig), JSON.stringify(input.allowedOrigins),
      JSON.stringify(input.theme ?? {}),
    ],
  );
  return rows[0]!;
}

export async function updateWidget(
  db: Queryable, id: string, accountId: string, patch: WidgetPatch,
): Promise<WidgetRow | null> {
  // Собираем SET только из пришедших полей: PATCH обязан быть частичным, а не
  // подменой всей строки дефолтами.
  const sets: string[] = [];
  const values: unknown[] = [id, accountId];
  const push = (expr: string, value: unknown): void => {
    values.push(value);
    sets.push(`${expr} = $${values.length}`);
  };
  if (patch.name !== undefined) push('name', patch.name);
  if (patch.enabled !== undefined) push('enabled', patch.enabled);
  if (patch.agentConfig !== undefined) push('agent_config', JSON.stringify(patch.agentConfig));
  if (patch.allowedOrigins !== undefined) push('allowed_origins', JSON.stringify(patch.allowedOrigins));
  if (patch.theme !== undefined) push('theme', JSON.stringify(patch.theme));

  if (sets.length === 0) return findWidgetByIdForAccount(db, id, accountId);

  const { rows } = await db.query<WidgetRow>(
    `UPDATE widgets SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2 RETURNING ${COLS}`,
    values,
  );
  return rows[0] ?? null;
}

export async function deleteWidget(db: Queryable, id: string, accountId: string): Promise<boolean> {
  // Диалоги, сообщения и лиды уходят каскадом по FK (init.cjs).
  const { rowCount } = await db.query(
    'DELETE FROM widgets WHERE id = $1 AND account_id = $2', [id, accountId],
  );
  return (rowCount ?? 0) > 0;
}

// Обрывает ЖИВЫЕ диалоги: все ручки /w/v1 резолвят виджет по токену из пути, и
// вкладка посетителя со старым токеном получит 404 на следующем же сообщении.
// Известное следствие — панель предупреждает об этом до нажатия; телеметрию
// различимости добавит поток VI.
export async function rotatePublishToken(
  db: Queryable, id: string, accountId: string, token: string,
): Promise<WidgetRow | null> {
  const { rows } = await db.query<WidgetRow>(
    `UPDATE widgets SET publish_token = $3 WHERE id = $1 AND account_id = $2 RETURNING ${COLS}`,
    [id, accountId, token],
  );
  return rows[0] ?? null;
}

export async function countWidgetsByAccount(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM widgets WHERE account_id = $1', [accountId],
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}

/*
 * МЕЖАРЕНДАТОРНОЕ ЧТЕНИЕ — ТОЛЬКО НИЖЕ ЭТОЙ ЧЕРТЫ (Task 19, админка оператора).
 *
 * Всё выше несёт `account_id = $N` в самом SQL — это и есть изоляция. Функция
 * ниже скоупа НЕ имеет по построению, поэтому названа `admin*` и зовётся
 * исключительно из-под `requireAdmin`: на ревью такой вызов в панельной ручке
 * виден по имени, не вчитываясь в запрос.
 */

/**
 * Строка админского списка виджетов.
 *
 * `owner_email`/`account_id` — nullable как ДЕФЕНСИВНЫЙ residue LEFT JOIN
 * (`adminListWidgets`). Со второго релиза (Task 27) account_id — NOT NULL,
 * бесхозных виджетов (когда-то `account_id IS NULL`, наследие релиза 1) больше
 * не бывает, поэтому на практике оба поля всегда заполнены; тип оставлен
 * nullable, чтобы LEFT JOIN не пришлось менять на INNER (тот молча спрятал бы
 * виджет с несошедшимся FK вместо того, чтобы показать его оператору).
 *
 * `publish_token` отдаётся намеренно: он не секрет (лежит в HTML клиентского
 * сайта), а поддержка приходит на этот экран ровно с ним в руках — «клиент
 * прислал токен, чей это виджет».
 */
export type AdminWidgetRow = {
  id: string;
  name: string;
  publish_token: string;
  enabled: boolean;
  created_at: Date;
  account_id: string | null;
  owner_email: string | null;
  owner_blocked: boolean;
  dialogs_total: number;
  cursor_at: string;
};

export async function adminListWidgets(
  db: Queryable,
  input: { accountId: string | null; limit: number; cursor: Cursor | null },
): Promise<AdminWidgetRow[]> {
  const { rows } = await db.query<AdminWidgetRow>(
    // Число диалогов — коррелированным подзапросом, а не JOIN + GROUP BY:
    // группировка по всей строке виджета ради одного счётчика читается хуже и
    // ломается на первом добавленном поле.
    `SELECT w.id, w.name, w.publish_token, w.enabled, w.created_at, w.account_id,
            a.email AS owner_email,
            (a.blocked_at IS NOT NULL) AS owner_blocked,
            to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
            (SELECT count(*)::int FROM dialogs d WHERE d.widget_id = w.id) AS dialogs_total
       FROM widgets w
       LEFT JOIN accounts a ON a.id = w.account_id
      WHERE ($2::uuid IS NULL OR w.account_id = $2::uuid)
        AND ($3::timestamptz IS NULL OR (w.created_at, w.id) < ($3::timestamptz, $4::uuid))
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT $1`,
    [input.limit, input.accountId, input.cursor?.at ?? null, input.cursor?.id ?? null],
  );
  return rows;
}
