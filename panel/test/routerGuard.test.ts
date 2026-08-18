import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { router } from '../src/router/index.ts';
import { useSessionStore } from '../src/stores/session.ts';

const ACCOUNT = { id: 'acc-1', email: 'owner@example.com', is_admin: false };
const ADMIN = { id: 'acc-2', email: 'root@example.com', is_admin: true };

const respondMe = (status: number, body: unknown): void => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })));
};

beforeEach(async () => {
  setActivePinia(createPinia());
  // Экран логина публичен: сюда можно встать без гарда и обнулить историю.
  respondMe(401, { error: { code: 'unauthenticated', message: 'Требуется вход.' } });
  await router.replace('/login');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('гард роутера панели', () => {
  it('аноним уезжает на логин, и адрес, куда он шёл, не теряется', async () => {
    respondMe(401, { error: { code: 'unauthenticated', message: 'Требуется вход.' } });
    await router.push('/leads');
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.next).toBe('/leads');
  });

  it('перезагрузка страницы кабинета НЕ выкидывает на логин: сначала /me, потом решение', async () => {
    // Стор при старте пуст по определению — редирект «по пустому стору»
    // означал бы, что кабинет вообще нельзя открыть по прямой ссылке.
    respondMe(200, { account: ACCOUNT });
    await router.push('/dialogs');
    expect(router.currentRoute.value.name).toBe('dialogs');
    expect(useSessionStore().account).toEqual(ACCOUNT);
  });

  it('не-админ не попадает в админку', async () => {
    respondMe(200, { account: ACCOUNT });
    await router.push('/admin/accounts');
    expect(router.currentRoute.value.name).toBe('widgets');
  });

  it('админ в админку попадает', async () => {
    respondMe(200, { account: ADMIN });
    await router.push('/admin/accounts');
    expect(router.currentRoute.value.name).toBe('admin-accounts');
  });

  it('после выхода следующий переход снова требует входа — без повторного /me', async () => {
    respondMe(200, { account: ACCOUNT });
    await router.push('/leads');
    expect(router.currentRoute.value.name).toBe('leads');

    const session = useSessionStore();
    await session.logout();
    // Ответов в очереди больше нет: если гард пойдёт в /me второй раз, тест
    // это заметит по неожиданному успеху.
    respondMe(500, { error: { code: 'internal', message: 'сюда ходить не должны' } });
    await router.push('/usage');
    expect(router.currentRoute.value.name).toBe('login');
  });
});
