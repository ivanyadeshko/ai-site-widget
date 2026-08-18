import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h } from 'vue';
import PanelLayout from '../src/layouts/PanelLayout.vue';
import AccountsView from '../src/views/admin/AccountsView.vue';
import { router } from '../src/router/index.ts';
import { useSessionStore } from '../src/stores/session.ts';

const ACCOUNT = { id: 'acc-1', email: 'owner@example.com', is_admin: false };
const ADMIN = { id: 'acc-2', email: 'root@example.com', is_admin: true };

const blank = defineComponent({ render: () => h('div') });

/**
 * Ответ по НАЧАЛУ адреса: экраны админки уходят в свои ручки сразу после
 * монтирования, и таблица «точный URL → ответ» ломалась бы на каждом параметре
 * периода.
 */
const stubByPrefix = (table: { prefix: string; status: number; body: unknown }[]): ReturnType<typeof vi.fn> => {
  const stub = vi.fn(async (url: string) => {
    const match = table.find((row) => url.startsWith(row.prefix));
    const reply = match ?? { status: 404, body: { error: { code: 'not_found', message: 'Не найдено.' } } };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
};

const asAccount = (account: typeof ACCOUNT) => [
  { prefix: '/api/v1/auth/me', status: 200, body: { account } },
  { prefix: '/api/v1/admin/accounts', status: 200, body: { accounts: [], next_cursor: null } },
  { prefix: '/api/v1/admin/widgets', status: 200, body: { widgets: [], next_cursor: null } },
  { prefix: '/api/v1/admin/usage', status: 200, body: { buckets: [], totals: { dialogs: 0, credits_total: 0, usage: {} } } },
  { prefix: '/api/v1/admin/core/credits', status: 200, body: { balance: { balance: 100, updated_at: '2026-08-18T00:00:00Z' }, fetched_at: '2026-08-18T00:00:00Z' } },
];

beforeEach(async () => {
  setActivePinia(createPinia());
  stubByPrefix([{ prefix: '/api/v1/auth/me', status: 401, body: { error: { code: 'unauthenticated', message: 'Требуется вход.' } } }]);
  await router.replace('/login');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('доступ в админку из SPA', () => {
  it('не-админ не попадает НИ НА ОДИН экран админки — уезжает в свой кабинет', async () => {
    stubByPrefix(asAccount(ACCOUNT));
    for (const path of ['/admin/accounts', '/admin/widgets', '/admin/usage']) {
      await router.push(path);
      expect(router.currentRoute.value.name, path).toBe('widgets');
    }
  });

  it('админ открывает все три экрана, и это НЕ заглушки', async () => {
    stubByPrefix(asAccount(ADMIN));
    const expected: [string, string][] = [
      ['/admin/accounts', 'admin-accounts'],
      ['/admin/widgets', 'admin-widgets'],
      ['/admin/usage', 'admin-usage'],
    ];
    for (const [path, name] of expected) {
      await router.push(path);
      expect(router.currentRoute.value.name, path).toBe(name);
      // Заглушка-`stub()` из router/index.ts рендерила бы голый <h1>; настоящий
      // экран — компонент с именем файла.
      const matched = router.currentRoute.value.matched.at(-1)!;
      expect((matched.components!.default as { __name?: string }).__name, path).toBeTruthy();
    }
  });

  it('пункт «Администрирование» в сайдбаре виден только админу', async () => {
    const layoutRouter = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'widgets', component: blank },
        { path: '/admin/accounts', name: 'admin-accounts', component: blank },
        { path: '/admin/widgets', name: 'admin-widgets', component: blank },
        { path: '/admin/usage', name: 'admin-usage', component: blank },
      ],
    });
    await layoutRouter.replace('/');

    const session = useSessionStore();
    session.account = { ...ACCOUNT };
    const plain = mount(PanelLayout, { global: { plugins: [layoutRouter] } });
    await flushPromises();
    expect(plain.text()).not.toContain('Администрирование');

    session.account = { ...ADMIN };
    const admin = mount(PanelLayout, { global: { plugins: [layoutRouter] } });
    await flushPromises();
    expect(admin.text()).toContain('Администрирование');
  });

  /**
   * ГАРД РОУТЕРА — ЭТО UX, А НЕ ЗАЩИТА.
   *
   * Он прячет пункт меню и разворачивает не-админа с адреса — ровно для того,
   * чтобы человек не увидел экран, на котором ему нечего делать. Обойти его
   * тривиально: DevTools, `session.account.is_admin = true` — и экран
   * открывается. Настоящий барьер стоит на сервере: `requireAdmin` отвечает
   * 404 (не 403 — существование поверхности не подтверждаем), и вот этот тест
   * фиксирует, что при расхождении прав ПОБЕЖДАЕТ СЕРВЕР: данных нет, есть
   * объяснение.
   */
  it('гард — только UX: при 404 от сервера экран показывает отказ, а не данные', async () => {
    const session = useSessionStore();
    session.account = { ...ADMIN };
    session.loaded = true;
    stubByPrefix([
      { prefix: '/api/v1/admin/accounts', status: 404, body: { error: { code: 'not_found', message: 'Не найдено.' } } },
    ]);

    const wrapper = mount(AccountsView);
    await flushPromises();
    expect(wrapper.text()).toContain('Не найдено.');
    expect(wrapper.text()).not.toContain('owner@example.com');
  });
});
