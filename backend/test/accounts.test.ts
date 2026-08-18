import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SYSTEM_ACCOUNT_EMAIL, findAccountByEmail, insertAccount, setAccountBlocked,
} from '../src/db/repositories/accounts.ts';
import { seedWidget, testPool, truncateAll } from './helpers/db.ts';

const pool = testPool();
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await truncateAll(pool); });

describe('аккаунты витрины', () => {
  it('системный аккаунт существует после миграции и НЕ вычищается truncate', async () => {
    // Владелец бэкфилла обязан пережить любую чистку: на него ссылаются
    // строки widgets, созданные до появления аккаунтов.
    const system = await findAccountByEmail(pool, SYSTEM_ACCOUNT_EMAIL);
    expect(system).not.toBeNull();
    expect(system!.is_admin).toBe(false);
    // Хэш заведомо неверифицируемый: под этим аккаунтом нельзя войти.
    expect(system!.password_hash).toBe('locked');
  });

  it('email уникален без учёта регистра', async () => {
    await insertAccount(pool, { email: 'Owner@Example.COM', passwordHash: 'x' });
    await expect(insertAccount(pool, { email: 'owner@example.com', passwordHash: 'y' }))
      .rejects.toThrow(/duplicate key|accounts_email_unique/i);
  });

  it('поиск по email нечувствителен к регистру и хранит исходное написание', async () => {
    const created = await insertAccount(pool, { email: 'Owner@Example.com', passwordHash: 'x' });
    const found = await findAccountByEmail(pool, 'OWNER@EXAMPLE.COM');
    expect(found?.id).toBe(created.id);
    expect(found?.email).toBe('Owner@Example.com');
  });

  it('блокировка проставляет blocked_at, разблокировка снимает', async () => {
    const acc = await insertAccount(pool, { email: 'a@b.c', passwordHash: 'x' });
    expect(await setAccountBlocked(pool, acc.id, true)).toBe(true);
    expect((await findAccountByEmail(pool, 'a@b.c'))!.blocked_at).toBeInstanceOf(Date);
    expect(await setAccountBlocked(pool, acc.id, false)).toBe(true);
    expect((await findAccountByEmail(pool, 'a@b.c'))!.blocked_at).toBeNull();
  });

  it('виджет без account_id больше НЕ создаётся (NOT NULL, релиз 2)', async () => {
    // Инверсия теста релиза 1 «создаётся с NULL»: он фиксировал промежуточное
    // состояние аддитивной миграции Task 1 и здесь умирает по плану. Второй
    // релиз (Task 27) ставит NOT NULL — сырой INSERT без владельца обязан
    // падать 23502, а не тихо заводить бесхозный виджет.
    await expect(pool.query(
      `INSERT INTO widgets (publish_token, name, agent_config, kb_ids, allowed_origins, enabled)
       VALUES ('wgt_notnull_probe', 'x', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, true)`,
    )).rejects.toThrow(/null value in column "account_id"|not-null|23502/i);
  });

  it('удаление аккаунта уносит его виджеты (ON DELETE CASCADE)', async () => {
    const acc = await insertAccount(pool, { email: 'own@er.io', passwordHash: 'x' });
    const { id } = await seedWidget(pool, { accountId: acc.id });
    await pool.query('DELETE FROM accounts WHERE id = $1', [acc.id]);
    const { rowCount } = await pool.query('SELECT 1 FROM widgets WHERE id = $1', [id]);
    expect(rowCount).toBe(0);
  });
});
