import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h } from 'vue';
import { NSelect } from 'naive-ui';
import LeadsView from '../src/views/LeadsView.vue';

const blank = defineComponent({ render: () => h('div') });

const testRouter = () => createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'widgets', component: blank },
    { path: '/leads', name: 'leads', component: blank },
    { path: '/dialogs/:id', name: 'dialog', component: blank },
  ],
});

type Reply = { status: number; body: unknown };

const routeFetch = (table: Record<string, Reply[]>): ReturnType<typeof vi.fn> => {
  const stub = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
    const queue = table[key];
    const reply = queue?.shift() ?? { status: 500, body: { error: { code: 'internal', message: `нет ответа на ${key}` } } };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
};

const WIDGETS = [
  { id: 'w-1', name: 'Виджет магазина', publish_token: 'wgt_1', enabled: true, allowed_origins: [], agent_config: { instructions: '' }, created_at: '2026-08-01T00:00:00.000Z', theme: {}, embed_snippet: '', app_url: '' },
  { id: 'w-2', name: 'Виджет клиники', publish_token: 'wgt_2', enabled: true, allowed_origins: [], agent_config: { instructions: '' }, created_at: '2026-08-01T00:00:00.000Z', theme: {}, embed_snippet: '', app_url: '' },
];

const LEAD = {
  id: 'l-1',
  created_at: '2026-08-18T10:00:00.000Z',
  widget_id: 'w-1',
  widget_name: 'Виджет магазина',
  dialog_id: 'd-1',
  name: 'Пётр Кириллович',
  phone: '+79990001122',
  email: null,
  comment: 'Хочу «Ёлку»',
};

const mountView = async () => {
  const router = testRouter();
  await router.push('/leads');
  await router.isReady();
  const wrapper = mount(LeadsView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('экран лидов', () => {
  it('таблица показывает лид со всеми контактами и ссылкой на переписку', async () => {
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: WIDGETS } }],
      'GET /api/v1/leads': [{ status: 200, body: { leads: [LEAD], next_cursor: null } }],
    });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('Пётр Кириллович');
    expect(wrapper.text()).toContain('+79990001122');
    expect(wrapper.text()).toContain('Хочу «Ёлку»');
    // Лид без разговора — половина картины: до контакта человек что-то спрашивал.
    expect(wrapper.find('a[href="/dialogs/d-1"]').exists()).toBe(true);
  });

  it('«Экспорт CSV» — ССЫЛКА на ручку выгрузки, а не обработчик клика', async () => {
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: WIDGETS } }],
      'GET /api/v1/leads': [{ status: 200, body: { leads: [LEAD], next_cursor: null } }],
    });
    const wrapper = await mountView();
    // Файл скачивает браузер: проверяем адрес, а не клик.
    expect(wrapper.find('[data-test="export-csv"]').attributes('href')).toBe('/api/v1/leads.csv');
  });

  it('фильтр по виджету попадает И в список, И в адрес выгрузки', async () => {
    // Выгрузить не то, что видишь на экране, — худший вид расхождения: ошибку
    // замечают уже в чужой таблице.
    const fetchStub = routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: WIDGETS } }],
      'GET /api/v1/leads': [{ status: 200, body: { leads: [LEAD], next_cursor: null } }],
      'GET /api/v1/leads?widget_id=w-2': [{ status: 200, body: { leads: [], next_cursor: null } }],
    });
    const wrapper = await mountView();

    wrapper.findComponent(NSelect).vm.$emit('update:value', 'w-2');
    await flushPromises();

    expect(fetchStub.mock.calls.map((call) => call[0])).toContain('/api/v1/leads?widget_id=w-2');
    expect(wrapper.find('[data-test="export-csv"]').attributes('href')).toBe('/api/v1/leads.csv?widget_id=w-2');
  });

  it('пустое состояние ОБЪЯСНЯЕТ, откуда берутся лиды', async () => {
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: WIDGETS } }],
      'GET /api/v1/leads': [{ status: 200, body: { leads: [], next_cursor: null } }],
    });
    const wrapper = await mountView();
    // Пустая таблица без объяснения читается как поломка панели.
    expect(wrapper.text()).toContain('Лидов пока нет');
    expect(wrapper.text()).toMatch(/форму контактов внутри диалога/i);
  });

  it('вторая страница догружается по кнопке и НЕ теряет первую', async () => {
    const second = { ...LEAD, id: 'l-2', name: 'Мария' };
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: WIDGETS } }],
      'GET /api/v1/leads': [{ status: 200, body: { leads: [LEAD], next_cursor: 'cur-1' } }],
      'GET /api/v1/leads?cursor=cur-1': [{ status: 200, body: { leads: [second], next_cursor: null } }],
    });
    const wrapper = await mountView();

    await wrapper.find('[data-test="load-more"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Пётр Кириллович');
    expect(wrapper.text()).toContain('Мария');
    expect(wrapper.find('[data-test="load-more"]').exists()).toBe(false);
  });

  it('отказ списка виджетов не прячет сами лиды', async () => {
    // Виджеты нужны только фильтру. Уронить из-за них экран значило бы спрятать
    // данные, которые сервер отдал.
    routeFetch({
      'GET /api/v1/widgets': [{ status: 500, body: { error: { code: 'internal', message: 'Внутренняя ошибка.' } } }],
      'GET /api/v1/leads': [{ status: 200, body: { leads: [LEAD], next_cursor: null } }],
    });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('Пётр Кириллович');
  });
});
