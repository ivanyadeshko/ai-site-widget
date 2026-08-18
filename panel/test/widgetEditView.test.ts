import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h } from 'vue';
import WidgetEditView from '../src/views/WidgetEditView.vue';

const blank = defineComponent({ render: () => h('div') });

const WIDGET = {
  id: 'w-1',
  name: 'Виджет магазина',
  publish_token: 'wgt_00000000000000000000000000000001',
  enabled: true,
  allowed_origins: ['https://shop.example'],
  agent_config: { instructions: 'Ты консультант магазина.' },
  created_at: '2026-08-18T10:00:00.000Z',
  theme: {} as Record<string, unknown>,
  embed_snippet: '',
  app_url: 'https://app.vell.pro/app/wgt_00000000000000000000000000000001',
};

type Reply = { status: number; body: unknown };

const routeFetch = (table: Record<string, Reply[]>): ReturnType<typeof vi.fn> => {
  const stub = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
    const reply = table[key]?.shift()
      ?? { status: 500, body: { error: { code: 'internal', message: `нет ответа на ${key}` } } };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
};

const mountEdit = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'widgets', component: blank },
      { path: '/widgets/:id', name: 'widget', component: blank },
    ],
  });
  await router.push('/widgets/w-1');
  await router.isReady();
  const wrapper = mount(WidgetEditView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('экран настройки виджета', () => {
  it('удаление требует ввести имя виджета — случайным кликом его не снести', async () => {
    routeFetch({ 'GET /api/v1/widgets/w-1': [{ status: 200, body: { widget: WIDGET } }] });
    const wrapper = await mountEdit();

    expect(wrapper.find('[data-test="delete-widget"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="delete-confirmation"] input').setValue('не то имя');
    expect(wrapper.find('[data-test="delete-widget"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test="delete-confirmation"] input').setValue('Виджет магазина');
    expect(wrapper.find('[data-test="delete-widget"]').attributes('disabled')).toBeUndefined();
  });

  it('токен показан вместе с объяснением, что он не секрет', async () => {
    routeFetch({ 'GET /api/v1/widgets/w-1': [{ status: 200, body: { widget: WIDGET } }] });
    const wrapper = await mountEdit();
    expect(wrapper.text()).toContain(WIDGET.publish_token);
    expect(wrapper.text()).toMatch(/не секрет/i);
  });

  it('после ротации показывает, что старый сниппет мёртв, и новый токен', async () => {
    routeFetch({
      'GET /api/v1/widgets/w-1': [{ status: 200, body: { widget: WIDGET } }],
      'POST /api/v1/widgets/w-1/rotate-token': [{
        status: 200, body: { widget: { ...WIDGET, publish_token: 'wgt_ffffffffffffffffffffffffffffffff' } },
      }],
    });
    const wrapper = await mountEdit();

    // Popconfirm телепортирует подтверждение в body — дёргаем сам обработчик
    // через кнопку-триггер и проверяем результат, а не разметку поповера.
    await (wrapper.vm as unknown as { rotate: () => Promise<void> }).rotate();
    await flushPromises();

    expect(wrapper.text()).toContain('wgt_ffffffffffffffffffffffffffffffff');
    expect(wrapper.text()).toMatch(/старый больше не работает/i);
  });

  it('ошибку сохранения показывает текстом с бэкенда', async () => {
    routeFetch({
      'GET /api/v1/widgets/w-1': [{ status: 200, body: { widget: WIDGET } }],
      'PATCH /api/v1/widgets/w-1': [{
        status: 422,
        body: { error: { code: 'instructions_too_long', message: 'Инструкции длиннее 8000 символов — сократите текст.' } },
      }],
    });
    const wrapper = await mountEdit();
    await wrapper.find('[data-test="save-widget"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Инструкции длиннее 8000 символов — сократите текст.');
  });

  it('блок «Оформление» показывает сохранённую тему и возвращает её в PATCH', async () => {
    const themed = {
      ...WIDGET,
      theme: { color: '#ff0000', position: 'left', button_label: '🤖', title: 'Магазин на связи' },
    };
    const fetchStub = routeFetch({
      'GET /api/v1/widgets/w-1': [{ status: 200, body: { widget: themed } }],
      'PATCH /api/v1/widgets/w-1': [{ status: 200, body: { widget: themed } }],
    });
    const wrapper = await mountEdit();

    expect((wrapper.find('[data-test="theme-title"] input').element as HTMLInputElement).value)
      .toBe('Магазин на связи');
    expect((wrapper.find('[data-test="theme-button-label"] input').element as HTMLInputElement).value)
      .toBe('🤖');

    await wrapper.find('[data-test="theme-launcher-title"] input').setValue('Спросить консультанта');
    await wrapper.find('[data-test="save-widget"]').trigger('click');
    await flushPromises();

    const patch = fetchStub.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH');
    const sent = JSON.parse((patch![1] as RequestInit).body as string);
    expect(sent.theme).toEqual({
      color: '#ff0000', position: 'left', button_label: '🤖',
      title: 'Магазин на связи', launcher_title: 'Спросить консультанта',
    });
  });

  it('незаполненные поля оформления в запрос НЕ уезжают — бэкенд отверг бы пустую строку', async () => {
    const fetchStub = routeFetch({
      'GET /api/v1/widgets/w-1': [{ status: 200, body: { widget: WIDGET } }],
      'PATCH /api/v1/widgets/w-1': [{ status: 200, body: { widget: WIDGET } }],
    });
    const wrapper = await mountEdit();
    await wrapper.find('[data-test="save-widget"]').trigger('click');
    await flushPromises();

    const patch = fetchStub.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH');
    const sent = JSON.parse((patch![1] as RequestInit).body as string);
    // Виджет без темы обязан оставаться без темы: пустой объект, а не пять
    // пустых строк и не вмороженные в БД сегодняшние дефолты.
    expect(sent.theme).toEqual({});
  });
});
