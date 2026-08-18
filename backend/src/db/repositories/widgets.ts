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
  /** NULL — наследие релиза 1: виджеты, заведённые до появления аккаунтов. */
  account_id: string | null;
};

/** Виджет вместе с ответом на вопрос «владелец не заблокирован?» — одним запросом. */
export type WidgetWithOwner = WidgetRow & { owner_blocked: boolean };

/** Частичное обновление: `undefined` = «поле не трогать», а не «обнулить». */
export type WidgetPatch = {
  name?: string;
  agentConfig?: AgentConfig;
  allowedOrigins?: string[];
  enabled?: boolean;
};

const COLS = 'id, publish_token, name, agent_config, kb_ids, allowed_origins, enabled, created_at, account_id';

export async function findWidgetByToken(db: Queryable, token: string): Promise<WidgetWithOwner | null> {
  // LEFT JOIN, а НЕ INNER: строки с account_id IS NULL обязаны продолжать
  // находиться (Constraint 1, аддитивность релиза 1) — INNER погасил бы весь
  // существующий прод разом. У таких строк owner_blocked = false.
  const { rows } = await db.query<WidgetWithOwner>(
    `SELECT w.id, w.publish_token, w.name, w.agent_config, w.kb_ids, w.allowed_origins,
            w.enabled, w.created_at, w.account_id,
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

export async function insertWidget(db: Queryable, input: {
  accountId: string; name: string; publishToken: string;
  agentConfig: AgentConfig; allowedOrigins: string[];
}): Promise<WidgetRow> {
  const { rows } = await db.query<WidgetRow>(
    `INSERT INTO widgets (account_id, name, publish_token, agent_config, allowed_origins)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     RETURNING ${COLS}`,
    [
      input.accountId, input.name, input.publishToken,
      JSON.stringify(input.agentConfig), JSON.stringify(input.allowedOrigins),
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
