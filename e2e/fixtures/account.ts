import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export type FreshAccount = { email: string; password: string };

/**
 * Регистрирует НОВЫЙ аккаунт витрины через форму панели и дожидается редиректа
 * в кабинет. Свежий email на каждый вызов — прогоны не наступают друг на друга.
 *
 * Пароль заведомо проходит политику бэкенда (≥10 символов, не одни цифры,
 * `passwordPolicyError`). Кириллица в теле JSON допустима (Constraint 11 — про
 * заголовки, не про тело).
 */
export async function registerFreshAccount(page: Page, baseURL: string): Promise<FreshAccount> {
  const account: FreshAccount = {
    email: `owner-${randomUUID()}@example.com`,
    password: `надёжный-пароль-${randomUUID().slice(0, 8)}`,
  };
  await page.goto(`${baseURL.replace(/\/+$/, '')}/panel/register`);
  // Naive UI кладёт fallthrough-атрибуты (autocomplete/type) на обёртку, а не на
  // внутренний <input>, поэтому цепляемся за плейсхолдеры формы регистрации.
  await page.getByPlaceholder('owner@example.com').fill(account.email);
  await page.getByPlaceholder('Пароль', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  // Успех = уход с /register в кабинет (router.replace('/')).
  await expect(page).toHaveURL(/\/panel\/?(#.*)?$/, { timeout: 15_000 });
  return account;
}

/** Вход существующим аккаунтом (например, админ, поднятый grant-admin.mjs). */
export async function loginAccount(page: Page, baseURL: string, creds: FreshAccount): Promise<void> {
  await page.goto(`${baseURL.replace(/\/+$/, '')}/panel/login`);
  await page.getByPlaceholder('owner@example.com').fill(creds.email);
  await page.getByPlaceholder('Пароль', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/panel\/?(#.*)?$/, { timeout: 15_000 });
}
