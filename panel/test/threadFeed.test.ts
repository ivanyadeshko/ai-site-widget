import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ThreadFeed from '../src/components/ThreadFeed.vue';

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

const message = (over: Partial<{ id: string; role: 'user' | 'agent'; text: string; source: 'client' | 'core'; seq: number }>) => ({
  id: '1', role: 'user' as const, text: 'Привет', source: 'core' as const, seq: 1,
  created_at: '2026-08-18T10:00:00.000Z', ...over,
});

const FIRST_PAGE = '/api/v1/dialogs/d-1/messages?limit=100';
const SECOND_PAGE = '/api/v1/dialogs/d-1/messages?limit=100&after_id=2';

const mountFeed = async () => {
  const wrapper = mount(ThreadFeed, { props: { dialogId: 'd-1' } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('лента диалога', () => {
  it('неподтверждённая ядром реплика помечена, подтверждённая — нет', async () => {
    // source=client значит «прислано страницей посетителя и ядром не
    // подтверждено». В пределе такую реплику мог прислать кто угодно, кто
    // открыл виджет, — владелец обязан видеть разницу.
    routeFetch({
      [`GET ${FIRST_PAGE}`]: [{
        status: 200,
        body: {
          dialog_id: 'd-1', status: 'ended', next_after_id: null,
          messages: [
            message({ id: '1', role: 'user', text: 'Сколько стоит?', source: 'client' }),
            message({ id: '2', role: 'agent', text: 'Три рубля.', source: 'core' }),
          ],
        },
      }],
    });
    const wrapper = await mountFeed();

    expect(wrapper.findAll('[data-test="unconfirmed"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="message-1"]').text()).toContain('не подтверждено ядром');
    expect(wrapper.find('[data-test="message-2"]').text()).not.toContain('не подтверждено ядром');
  });

  it('роли различимы ТЕКСТОМ, а не только цветом', async () => {
    routeFetch({
      [`GET ${FIRST_PAGE}`]: [{
        status: 200,
        body: {
          dialog_id: 'd-1', status: 'ended', next_after_id: null,
          messages: [
            message({ id: '1', role: 'user', text: 'Сколько стоит?' }),
            message({ id: '2', role: 'agent', text: 'Три рубля.' }),
          ],
        },
      }],
    });
    const wrapper = await mountFeed();
    // Цвет не читается скринридером и пропадает в чёрно-белой печати.
    expect(wrapper.find('[data-test="message-1"]').text()).toContain('Посетитель');
    expect(wrapper.find('[data-test="message-2"]').text()).toContain('Аватар');
  });

  it('следующая страница подгружается по кнопке и дописывается в конец', async () => {
    routeFetch({
      [`GET ${FIRST_PAGE}`]: [{
        status: 200,
        body: {
          dialog_id: 'd-1', status: 'active', next_after_id: '2',
          messages: [message({ id: '1', text: 'Первая' }), message({ id: '2', text: 'Вторая' })],
        },
      }],
      [`GET ${SECOND_PAGE}`]: [{
        status: 200,
        body: {
          dialog_id: 'd-1', status: 'active', next_after_id: null,
          messages: [message({ id: '3', text: 'Третья' })],
        },
      }],
    });
    const wrapper = await mountFeed();
    expect(wrapper.text()).not.toContain('Третья');

    await wrapper.find('[data-test="load-more"]').trigger('click');
    await flushPromises();

    const texts = wrapper.findAll('[data-test^="message-"]').map((node) => node.text());
    expect(texts.some((t) => t.includes('Первая'))).toBe(true);
    expect(texts[texts.length - 1]).toContain('Третья');
    // Продолжения нет — кнопка обязана исчезнуть, а не звать в пустоту.
    expect(wrapper.find('[data-test="load-more"]').exists()).toBe(false);
  });

  it('отказ сервера объясняется текстом, а не пустой лентой', async () => {
    routeFetch({
      [`GET ${FIRST_PAGE}`]: [{
        status: 404, body: { error: { code: 'dialog_not_found', message: 'Диалог не найден.' } },
      }],
    });
    const wrapper = await mountFeed();
    expect(wrapper.text()).toContain('Диалог не найден.');
  });
});
