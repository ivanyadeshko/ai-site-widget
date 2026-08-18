import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { NPopconfirm } from 'naive-ui';
import AccountsView from '../src/views/admin/AccountsView.vue';
import AdminUsageView from '../src/views/admin/AdminUsageView.vue';
import AdminWidgetsView from '../src/views/admin/AdminWidgetsView.vue';

type Reply = { status: number; body: unknown };

/**
 * Ответ по паре «метод + начало адреса»: у экранов админки параметры плавают.
 * Выигрывает САМОЕ ДЛИННОЕ совпадение — иначе `/admin/accounts` перехватывал бы
 * `/admin/accounts/:id/limits` и тест молча проверял бы не то.
 */
const stubApi = (table: { call: string; status?: number; body: unknown }[]): ReturnType<typeof vi.fn> => {
  const stub = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
    const match = table
      .filter((row) => key.startsWith(row.call))
      .sort((a, b) => b.call.length - a.call.length)[0];
    const reply: Reply = match === undefined
      ? { status: 500, body: { error: { code: 'internal', message: `нет ответа на ${key}` } } }
      : { status: match.status ?? 200, body: match.body };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
};

const ACCOUNTS = {
  accounts: [
    {
      id: 'acc-live', email: 'shop@example.com', is_admin: false, blocked_at: null,
      created_at: '2026-08-01T10:00:00.000Z', last_login_at: '2026-08-17T09:00:00.000Z',
      widgets_count: 2, dialogs_30d: 41,
    },
    {
      id: 'acc-blocked', email: 'spam@example.com', is_admin: false, blocked_at: '2026-08-10T10:00:00.000Z',
      created_at: '2026-07-01T10:00:00.000Z', last_login_at: null,
      widgets_count: 1, dialogs_30d: 0,
    },
  ],
  next_cursor: null,
};

const WIDGETS = {
  widgets: [
    {
      id: 'w-1', name: 'Виджет магазина', publish_token: 'wgt_shop', enabled: true,
      created_at: '2026-08-01T10:00:00.000Z', account_id: 'acc-live',
      owner_email: 'shop@example.com', owner_blocked: false, dialogs_total: 12,
    },
    {
      id: 'w-orphan', name: 'Демо-виджет', publish_token: 'wgt_demo', enabled: true,
      created_at: '2026-07-01T10:00:00.000Z', account_id: null,
      owner_email: null, owner_blocked: false, dialogs_total: 3,
    },
  ],
  next_cursor: null,
};

const USAGE = {
  from: '2026-07-19T00:00:00.000Z',
  to: '2026-08-18T00:00:00.000Z',
  buckets: [
    { account_id: 'acc-live', account_email: 'shop@example.com', dialogs: 41, credits_total: 190, usage: { llm_input_tokens: 5000 } },
    { account_id: 'acc-quiet', account_email: 'quiet@example.com', dialogs: 0, credits_total: 0, usage: {} },
  ],
  totals: { dialogs: 44, credits_total: 205, usage: { llm_input_tokens: 5300 } },
};

const CREDITS = { balance: { balance: 8123, updated_at: '2026-08-18T08:00:00.000Z' }, fetched_at: '2026-08-18T08:00:05.000Z' };

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => {
  vi.unstubAllGlobals();
  // Naive UI телепортирует модалку в body; без чистки её разметка доживает до
  // следующего теста и находится вместо своей.
  document.body.innerHTML = '';
});

/**
 * Содержимое `n-modal` уезжает телепортом в `document.body`, то есть ВНЕ
 * поддерева, которым владеет wrapper. Ищем его в документе — это не обход
 * проверки, а признание того, как модалка работает в браузере.
 */
const clickInBody = async (selector: string): Promise<void> => {
  const element = document.body.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flushPromises();
};

describe('админка: аккаунты витрины', () => {
  it('показывает клиента со счётчиками и различает заблокированного', async () => {
    stubApi([{ call: 'GET /api/v1/admin/accounts', body: ACCOUNTS }]);
    const wrapper = mount(AccountsView);
    await flushPromises();

    expect(wrapper.text()).toContain('shop@example.com');
    expect(wrapper.text()).toContain('41');
    expect(wrapper.text()).toContain('Заблокирован');
    expect(wrapper.text()).toContain('Активен');
    // «Ни разу не входил» информативнее пустой ячейки: пустоту читают как сбой.
    expect(wrapper.text()).toContain('ни разу');
  });

  it('блокировка требует подтверждения и уходит на сервер', async () => {
    const stub = stubApi([
      { call: 'GET /api/v1/admin/accounts', body: ACCOUNTS },
      {
        call: 'POST /api/v1/admin/accounts/acc-live/block',
        body: { account: { ...ACCOUNTS.accounts[0], blocked_at: '2026-08-18T10:00:00.000Z' } },
      },
    ]);
    const wrapper = mount(AccountsView);
    await flushPromises();

    // Подтверждение обязательно: блокировка гасит виджеты клиента на его сайте.
    const confirms = wrapper.findAllComponents(NPopconfirm);
    expect(confirms.length).toBeGreaterThan(0);
    confirms[0]!.vm.$emit('positive-click');
    await flushPromises();

    const calls = stub.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${c[0] as string}`);
    expect(calls).toContain('POST /api/v1/admin/accounts/acc-live/block');
    // Строка обновляется ответом сервера, а не догадкой клиента.
    expect(wrapper.text()).toContain('Заблокирован');
  });

  it('снятие login-lock — отдельная кнопка, объясняющая, зачем она', async () => {
    const stub = stubApi([
      { call: 'GET /api/v1/admin/accounts', body: ACCOUNTS },
      { call: 'POST /api/v1/admin/accounts/acc-live/unlock-login', body: { account: ACCOUNTS.accounts[0] } },
    ]);
    const wrapper = mount(AccountsView);
    await flushPromises();

    const button = wrapper.findAll('[data-test="unlock-login"]')[0]!;
    expect(button).toBeDefined();
    await button.trigger('click');
    await flushPromises();

    const calls = stub.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${c[0] as string}`);
    expect(calls).toContain('POST /api/v1/admin/accounts/acc-live/unlock-login');
  });

  it('редактор лимита читает текущее значение и отправляет PUT', async () => {
    const stub = stubApi([
      { call: 'GET /api/v1/admin/accounts', body: ACCOUNTS },
      { call: 'GET /api/v1/admin/accounts/acc-live/limits', body: { limits: { max_sessions_per_day: null, effective_default: 300 } } },
      { call: 'PUT /api/v1/admin/accounts/acc-live/limits', body: { limits: { max_sessions_per_day: 42, effective_default: 300 } } },
    ]);
    const wrapper = mount(AccountsView);
    await flushPromises();

    await wrapper.findAll('[data-test="edit-limit"]')[0]!.trigger('click');
    await flushPromises();
    const calls = () => stub.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${c[0] as string}`);
    expect(calls()).toContain('GET /api/v1/admin/accounts/acc-live/limits');

    await clickInBody('[data-test="save-limit"]');
    expect(calls()).toContain('PUT /api/v1/admin/accounts/acc-live/limits');
  });

  it('отказ сервера объясняется текстом, а не пустой таблицей', async () => {
    stubApi([{
      call: 'GET /api/v1/admin/accounts', status: 503,
      body: { error: { code: 'internal', message: 'База недоступна.' } },
    }]);
    const wrapper = mount(AccountsView);
    await flushPromises();
    expect(wrapper.text()).toContain('База недоступна.');
  });
});

describe('админка: виджеты витрины', () => {
  it('показывает владельца, а у бесхозного виджета — прямо говорит, что владельца нет', async () => {
    stubApi([{ call: 'GET /api/v1/admin/widgets', body: WIDGETS }]);
    const wrapper = mount(AdminWidgetsView);
    await flushPromises();

    expect(wrapper.text()).toContain('Виджет магазина');
    expect(wrapper.text()).toContain('shop@example.com');
    // Бесхозный виджет (наследие релиза 1) обязан быть виден и подписан: у него
    // нет ни лимитов, ни адресата жалобы.
    expect(wrapper.text()).toContain('Демо-виджет');
    expect(wrapper.text()).toContain('без владельца');
  });
});

describe('админка: расход витрины', () => {
  it('сводка по аккаунтам плюс итог за период', async () => {
    stubApi([
      { call: 'GET /api/v1/admin/usage', body: USAGE },
      { call: 'GET /api/v1/admin/core/credits', body: CREDITS },
    ]);
    const wrapper = mount(AdminUsageView);
    await flushPromises();

    expect(wrapper.text()).toContain('shop@example.com');
    expect(wrapper.text()).toContain('190');
    expect(wrapper.text()).toContain('205');
    // Клиент без расхода остаётся строкой: «строки нет» читается как сбой отчёта.
    expect(wrapper.text()).toContain('quiet@example.com');
  });

  it('плашка баланса ядра ЯВНО говорит, что баланс общий на всю витрину', async () => {
    // Следствие D-1: для ядра весь виджет-продукт — один тенант. Без подписи
    // оператор прочитает цифру как баланс конкретного клиента и примет по ней
    // денежное решение.
    stubApi([
      { call: 'GET /api/v1/admin/usage', body: USAGE },
      { call: 'GET /api/v1/admin/core/credits', body: CREDITS },
    ]);
    const wrapper = mount(AdminUsageView);
    await flushPromises();

    expect(wrapper.text()).toContain('8123');
    expect(wrapper.text()).toMatch(/общий на всю витрину/i);
  });

  it('недоступное ядро гасит только плашку, а не весь экран', async () => {
    stubApi([
      { call: 'GET /api/v1/admin/usage', body: USAGE },
      {
        call: 'GET /api/v1/admin/core/credits', status: 503,
        body: { error: { code: 'core_unavailable', message: 'Ядро не отдало баланс.' } },
      },
    ]);
    const wrapper = mount(AdminUsageView);
    await flushPromises();

    expect(wrapper.text()).toContain('Ядро не отдало баланс.');
    // Отчёт по аккаунтам от чужой недоступности не зависит — он из своей БД.
    expect(wrapper.text()).toContain('shop@example.com');
  });
});
