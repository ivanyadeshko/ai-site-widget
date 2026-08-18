import { describe, expect, it } from 'vitest';
import { hashPassword, passwordPolicyError, verifyPassword } from '../src/auth/password.ts';

describe('пароли аккаунтов', () => {
  it('свой пароль проходит, чужой — нет', async () => {
    const stored = await hashPassword('правильный-пароль-1');
    expect(await verifyPassword('правильный-пароль-1', stored)).toBe(true);
    expect(await verifyPassword('правильный-пароль-2', stored)).toBe(false);
  });

  it('соль разная у каждого хэша: одинаковые пароли дают разные строки', async () => {
    const a = await hashPassword('одинаковый-пароль');
    const b = await hashPassword('одинаковый-пароль');
    expect(a).not.toBe(b);
    expect(await verifyPassword('одинаковый-пароль', b)).toBe(true);
  });

  it('формат версионирован — параметры читаются из самой строки', async () => {
    const stored = await hashPassword('какой-то-пароль');
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(stored.split('$')).toHaveLength(6);
  });

  it('мусорный/чужой формат хэша НЕ пускает и НЕ бросает', async () => {
    // 'locked' — хэш системного аккаунта из миграции Task 1. Он обязан
    // отвергать ЛЮБОЙ пароль тихо: исключение здесь превратило бы попытку
    // входа под системным аккаунтом в 500 и раскрыло бы его существование.
    for (const junk of ['locked', '', '$$$$$', 'argon2id$v=19$m=1,t=1,p=1$aaaa$bbbb', 'scrypt$0$8$1$YQ==$Yg==']) {
      await expect(verifyPassword('что угодно', junk)).resolves.toBe(false);
    }
  });

  it('сравнение хэшей постоянного времени: подмена длины не роняет', async () => {
    const stored = await hashPassword('пароль-нормальной-длины');
    const truncated = stored.slice(0, stored.length - 4);
    await expect(verifyPassword('пароль-нормальной-длины', truncated)).resolves.toBe(false);
  });

  it('политика: минимум 10 символов, не только цифры, обрезка по 200', () => {
    expect(passwordPolicyError('коротко')).toMatch(/10/);
    expect(passwordPolicyError('1234567890123')).toMatch(/цифр/i);
    expect(passwordPolicyError('нормальный-пароль')).toBeNull();
    expect(passwordPolicyError('x'.repeat(201))).toMatch(/200/);
  });
});
