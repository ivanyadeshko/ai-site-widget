import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool } from '../../src/db/pool.ts';

export const testPool = (): Pool => createPool(process.env.DATABASE_URL!);

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE widgets, dialogs, dialog_messages, leads, core_events, ip_day_counters, visitor_day_counters,'
      + ' account_sessions, auth_failures, account_limits, account_day_counters RESTART IDENTITY CASCADE',
  );
  // accounts НЕ вычищается целиком: системный аккаунт (SYSTEM_ACCOUNT_EMAIL) —
  // часть СХЕМЫ, а не данных теста; на него бэкфиллятся виджеты в миграции, и
  // повторно она не выполнится. TRUNCATE ... CASCADE снёс бы его вместе с
  // остальными. Порядок важен: DELETE идёт ПОСЛЕ TRUNCATE widgets — иначе
  // каскад accounts → widgets унёс бы виджеты в середине чистки.
  await pool.query("DELETE FROM accounts WHERE email <> 'system@vell.local'");
}

export async function seedWidget(
  pool: Pool,
  overrides: Partial<{
    token: string; allowedOrigins: string[]; enabled: boolean; instructions: string; accountId: string;
  }> = {},
): Promise<{ id: string; token: string }> {
  const token = overrides.token ?? `wgt_${randomUUID().replaceAll('-', '')}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO widgets (publish_token, name, agent_config, kb_ids, allowed_origins, enabled, account_id)
     VALUES ($1, 'Тестовый виджет', $2::jsonb, '[]'::jsonb, $3::jsonb, $4, $5) RETURNING id`,
    [
      token,
      JSON.stringify({ instructions: overrides.instructions ?? 'Ты консультант сайта.' }),
      JSON.stringify(overrides.allowedOrigins ?? ['https://shop.example']),
      overrides.enabled ?? true,
      overrides.accountId ?? null,
    ],
  );
  return { id: rows[0]!.id, token };
}

export async function seedAccount(
  pool: Pool,
  overrides: Partial<{ email: string; passwordHash: string; isAdmin: boolean }> = {},
): Promise<{ id: string; email: string }> {
  const email = overrides.email ?? `owner-${randomUUID()}@example.com`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO accounts (email, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id`,
    [email, overrides.passwordHash ?? 'locked', overrides.isAdmin ?? false],
  );
  return { id: rows[0]!.id, email };
}
