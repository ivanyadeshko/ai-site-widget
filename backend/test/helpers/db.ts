import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool } from '../../src/db/pool.ts';

export const testPool = (): Pool => createPool(process.env.DATABASE_URL!);

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE widgets, dialogs, dialog_messages, leads, core_events, ip_day_counters RESTART IDENTITY CASCADE',
  );
}

export async function seedWidget(
  pool: Pool,
  overrides: Partial<{ token: string; allowedOrigins: string[]; enabled: boolean; instructions: string }> = {},
): Promise<{ id: string; token: string }> {
  const token = overrides.token ?? `wgt_${randomUUID().replaceAll('-', '')}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO widgets (publish_token, name, agent_config, kb_ids, allowed_origins, enabled)
     VALUES ($1, 'Тестовый виджет', $2::jsonb, '[]'::jsonb, $3::jsonb, $4) RETURNING id`,
    [
      token,
      JSON.stringify({ instructions: overrides.instructions ?? 'Ты консультант сайта.' }),
      JSON.stringify(overrides.allowedOrigins ?? ['https://shop.example']),
      overrides.enabled ?? true,
    ],
  );
  return { id: rows[0]!.id, token };
}
