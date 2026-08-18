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
