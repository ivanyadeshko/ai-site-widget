import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h } from 'vue';
import DialogView from '../src/views/DialogView.vue';

const blank = defineComponent({ render: () => h('div') });

const testRouter = () => createRouter({
  history: createMemoryHistory(),
  routes: [
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

const FIRST_PAGE = 'GET /api/v1/dialogs/d-1/messages?limit=100';

const mountView = async () => {
  const router = testRouter();
  await router.push('/dialogs/d-1');
  await router.isReady();
  const wrapper = mount(DialogView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('экран переписки', () => {
  it('лента диалога из адреса страницы отрисована через ThreadFeed', async () => {
    const fetchStub = routeFetch({
      [FIRST_PAGE]: [{
        status: 200,
        body: {
          dialog_id: 'd-1', status: 'ended', next_after_id: null,
          messages: [
            { id: '1', role: 'user', text: 'Сколько стоит «Ёлка»?', source: 'client', seq: 1, created_at: '2026-08-18T10:00:00.000Z' },
            { id: '2', role: 'agent', text: 'Три рубля.', source: 'core', seq: 1, created_at: '2026-08-18T10:00:05.000Z' },
          ],
        },
      }],
    });
    const wrapper = await mountView();

    // Идентификатор берётся из :id роутера, а не из стора: на экран заходят по
    // прямой ссылке из списка лидов.
    expect(fetchStub.mock.calls.map((call) => call[0])).toContain('/api/v1/dialogs/d-1/messages?limit=100');
    expect(wrapper.text()).toContain('Сколько стоит «Ёлка»?');
    expect(wrapper.text()).toContain('Три рубля.');
    expect(wrapper.findAll('[data-test="unconfirmed"]')).toHaveLength(1);
  });

  it('статус диалога приезжает с первой страницей ленты и показан словом', async () => {
    // Отдельной ручки «диалог целиком» нет: статус берётся из ответа ленты
    // через событие компонента. Разрыв этой связи оставил бы шапку пустой.
    routeFetch({
      [FIRST_PAGE]: [{
        status: 200,
        body: { dialog_id: 'd-1', status: 'active', next_after_id: null, messages: [] },
      }],
    });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('Идёт');
    expect(wrapper.text()).toContain('d-1');
  });

  it('с экрана есть путь назад ко всем диалогам', async () => {
    routeFetch({
      [FIRST_PAGE]: [{
        status: 200,
        body: { dialog_id: 'd-1', status: 'ended', next_after_id: null, messages: [] },
      }],
    });
    const wrapper = await mountView();
    expect(wrapper.find('a[href="/dialogs"]').exists()).toBe(true);
    // Пустая лента объясняется, а не выглядит как несработавшая загрузка.
    expect(wrapper.text()).toContain('ещё нет реплик');
  });
});
