import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h } from 'vue';
import WidgetsView from '../src/views/WidgetsView.vue';

const blank = defineComponent({ render: () => h('div') });

const testRouter = () => createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'widgets', component: blank },
    { path: '/widgets/:id', name: 'widget', component: blank },
  ],
});

type Reply = { status: number; body: unknown };

/** Ответы раздаются по паре «метод + путь»: порядок вызовов не должен быть важен. */
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

const WIDGET = {
  id: 'w-1',
  name: 'Виджет магазина',
  publish_token: 'wgt_00000000000000000000000000000001',
  enabled: true,
  allowed_origins: ['https://shop.example'],
  agent_config: { instructions: 'Ты консультант магазина.' },
  created_at: '2026-08-18T10:00:00.000Z',
  theme: {},
  embed_snippet: '',
  app_url: 'https://app.vell.pro/app/wgt_00000000000000000000000000000001',
};

const mountView = async () => {
  const router = testRouter();
  await router.push('/');
  await router.isReady();
  const wrapper = mount(WidgetsView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

const fillNewWidgetForm = async (wrapper: Awaited<ReturnType<typeof mountView>>): Promise<void> => {
  await wrapper.find('[data-test="new-widget"]').trigger('click');
  await wrapper.find('[data-test="widget-name"] input').setValue('Виджет магазина');
  await wrapper.find('[data-test="widget-instructions"] textarea').setValue('Ты консультант магазина.');
};

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('экран виджетов', () => {
  it('пустое состояние зовёт создать первый виджет, а не показывает пустую таблицу', async () => {
    routeFetch({ 'GET /api/v1/widgets': [{ status: 200, body: { widgets: [] } }] });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('Создайте первый виджет');
  });

  it('созданный виджет появляется в списке без перезагрузки страницы', async () => {
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: [] } }],
      'POST /api/v1/widgets': [{ status: 201, body: { widget: WIDGET } }],
    });
    const wrapper = await mountView();
    await fillNewWidgetForm(wrapper);

    await wrapper.find('[data-test="save-widget"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Виджет магазина');
    // Второго GET /widgets в очереди нет: список обновился локально.
    expect(wrapper.text()).not.toContain('Создайте первый виджет');
  });

  it('упор в кап показывается человеку текстом, а не молчанием', async () => {
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: [WIDGET] } }],
      'POST /api/v1/widgets': [{
        status: 422,
        body: { error: { code: 'widget_limit_reached', message: 'Достигнут предел в 10 виджетов на аккаунт.' } },
      }],
    });
    const wrapper = await mountView();
    await fillNewWidgetForm(wrapper);

    await wrapper.find('[data-test="save-widget"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Достигнут предел в 10 виджетов на аккаунт.');
  });

  it('виджет без разрешённых сайтов помечен как нерабочий прямо в списке', async () => {
    routeFetch({
      'GET /api/v1/widgets': [{ status: 200, body: { widgets: [{ ...WIDGET, allowed_origins: [] }] } }],
    });
    const wrapper = await mountView();
    // Пустой список origin'ов = виджет закрыт везде (originGuard.ts). В списке
    // это обязано быть видно, иначе владелец ищет причину в чём угодно, кроме
    // настроек.
    expect(wrapper.text()).toMatch(/не работает|нет разрешённых сайтов/i);
  });
});
