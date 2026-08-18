import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h } from 'vue';
import { NSelect } from 'naive-ui';
import DialogsView from '../src/views/DialogsView.vue';

const blank = defineComponent({ render: () => h('div') });

const testRouter = () => createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'widgets', component: blank },
    { path: '/dialogs', name: 'dialogs', component: blank },
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

const widget = (id: string, name: string) => ({
  id, name, publish_token: `wgt_${id}`, enabled: true, allowed_origins: [],
  agent_config: { instructions: '' }, created_at: '2026-08-01T00:00:00.000Z',
  theme: {}, embed_snippet: '', app_url: '',
});

const WIDGETS = [widget('w-1', 'Виджет магазина'), widget('w-2', 'Виджет клиники')];

const DIALOG = {
  id: 'd-1',
  widget_id: 'w-1',
  widget_name: 'Виджет магазина',
  status: 'ended' as const,
  channel: 'chat' as const,
  messages_count: 7,
  has_lead: true,
  usage: { llm_input_tokens: 120 },
  credits_total: 5,
  started_at: '2026-08-18T10:00:00.000Z',
  ended_at: '2026-08-18T10:05:00.000Z',
};

const mountView = async () => {
  const router = testRouter();
  await router.push('/dialogs');
  await router.isReady();
  const wrapper = mount(DialogsView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('экран диалогов', () => {
  it('строка списка показывает срез разговора и ведёт в переписку', async () => {
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: WIDGETS } }],
      'GET /api/v1/dialogs': [{ status: 200, body: { dialogs: [DIALOG], next_cursor: null } }],
    });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('Виджет магазина');
    // Статус — человеческим словом, а не техническим 'ended': владелец не
    // обязан знать словарь состояний нити.
    expect(wrapper.text()).toContain('Завершён');
    expect(wrapper.text()).toContain('7');
    expect(wrapper.text()).toContain('да');
    expect(wrapper.text()).toContain('5');
    expect(wrapper.find('a[href="/dialogs/d-1"]').exists()).toBe(true);
  });

  it('фильтр по виджету перезапрашивает список с widget_id', async () => {
    const fetchStub = routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: WIDGETS } }],
      'GET /api/v1/dialogs': [{ status: 200, body: { dialogs: [DIALOG], next_cursor: null } }],
      'GET /api/v1/dialogs?widget_id=w-2': [{ status: 200, body: { dialogs: [], next_cursor: null } }],
    });
    const wrapper = await mountView();

    wrapper.findComponent(NSelect).vm.$emit('update:value', 'w-2');
    await flushPromises();

    expect(fetchStub.mock.calls.map((call) => call[0])).toContain('/api/v1/dialogs?widget_id=w-2');
    // Фильтр обязан ЗАМЕНИТЬ выборку, а не дописать её к прежней.
    expect(wrapper.text()).not.toContain('Виджет магазина');
    expect(wrapper.text()).toContain('Диалогов пока нет');
  });

  it('вторая страница догружается по кнопке и НЕ теряет первую', async () => {
    const second = { ...DIALOG, id: 'd-2', started_at: '2026-08-17T10:00:00.000Z', messages_count: 3 };
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: WIDGETS } }],
      'GET /api/v1/dialogs': [{ status: 200, body: { dialogs: [DIALOG], next_cursor: 'cur-1' } }],
      'GET /api/v1/dialogs?cursor=cur-1': [{ status: 200, body: { dialogs: [second], next_cursor: null } }],
    });
    const wrapper = await mountView();

    await wrapper.find('[data-test="load-more"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('a[href="/dialogs/d-1"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/dialogs/d-2"]').exists()).toBe(true);
    // Продолжения нет — кнопка обязана исчезнуть, а не звать в пустоту.
    expect(wrapper.find('[data-test="load-more"]').exists()).toBe(false);
  });

  it('пустое состояние объясняет, откуда берутся диалоги', async () => {
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: WIDGETS } }],
      'GET /api/v1/dialogs': [{ status: 200, body: { dialogs: [], next_cursor: null } }],
    });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('Диалогов пока нет');
    expect(wrapper.text()).toMatch(/открывает виджет/i);
  });

  it('отказ сервера показывается текстом, а не пустым экраном', async () => {
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: WIDGETS } }],
      'GET /api/v1/dialogs': [{
        status: 429, body: { error: { code: 'rate_limited', message: 'Слишком часто. Попробуйте позже.' } },
      }],
    });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('Слишком часто. Попробуйте позже.');
  });
});
