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
};

export async function findWidgetByToken(db: Queryable, token: string): Promise<WidgetRow | null> {
  const { rows } = await db.query<WidgetRow>(
    `SELECT id, publish_token, name, agent_config, kb_ids, allowed_origins, enabled, created_at
       FROM widgets WHERE publish_token = $1`,
    [token],
  );
  return rows[0] ?? null;
}
