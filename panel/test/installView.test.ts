import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { RouterLink, createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h } from 'vue';
import WidgetInstallView from '../src/views/WidgetInstallView.vue';

const blank = defineComponent({ render: () => h('div') });

const SNIPPET = '<script src="https://cdn.vell.pro/w.js" data-widget="wgt_00000000000000000000000000000001"'
  + ' data-host="https://app.vell.pro/" async><\/script>';

const WIDGET = {
  id: 'w-1',
  name: 'Виджет магазина',
  publish_token: 'wgt_00000000000000000000000000000001',
  enabled: true,
  allowed_origins: ['https://shop.example'],
  agent_config: { instructions: 'Ты консультант магазина.' },
  created_at: '2026-08-18T10:00:00.000Z',
  theme: {},
  embed_snippet: SNIPPET,
  app_url: 'https://app.vell.pro/app/wgt_00000000000000000000000000000001',
};

const serve = (widget: unknown): void => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ widget }), { status: 200, headers: { 'content-type': 'application/json' } },
  )));
};

const mountInstall = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'widgets', component: blank },
      { path: '/widgets/:id', name: 'widget', component: blank },
      { path: '/widgets/:id/install', name: 'widget-install', component: blank },
    ],
  });
  await router.push('/widgets/w-1/install');
  await router.isReady();
  const wrapper = mount(WidgetInstallView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('экран установки на сайт', () => {
  it('показывает готовый сниппет с бэкенда, ничего не досочиняя', async () => {
    serve(WIDGET);
    const wrapper = await mountInstall();
    // Сниппет собирает бэкенд (widgets/snippet.ts) — панель обязана показать
    // ровно его, иначе на мультидоменной раскладке потеряется data-host.
    expect(wrapper.find('[data-test="embed-snippet"]').text()).toBe(SNIPPET);
  });

  it('кнопка «Скопировать» кладёт сниппет в буфер и подтверждает это', async () => {
    serve(WIDGET);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const wrapper = await mountInstall();

    await wrapper.find('[data-test="copy-snippet"]').trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledWith(SNIPPET);
    expect(wrapper.text()).toMatch(/скопирован/i);
  });

  it('буфер недоступен (http-стенд, отказ пользователя) — говорим об этом, а не молчим', async () => {
    serve(WIDGET);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    const wrapper = await mountInstall();

    await wrapper.find('[data-test="copy-snippet"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toMatch(/скопируйте вручную/i);
  });

  it('объясняет, что токен не секрет, и ведёт к списку разрешённых сайтов', async () => {
    serve(WIDGET);
    const wrapper = await mountInstall();
    expect(wrapper.text()).toMatch(/не секрет/i);
    expect(wrapper.text()).toMatch(/разрешённых сайтов/i);
    // Ссылка ведёт на настройки виджета, где этот список и правится.
    expect(wrapper.find('[data-test="origins-link"]').attributes('href')).toBe('/widgets/w-1');
    // И ведёт ИМЕННО через роутер. SPA раздаётся с базой /panel/, поэтому
    // обычный <a href="/widgets/w-1"> увёл бы браузер на путь БЕЗ префикса —
    // в статику виджета, где ответ 404. По одному href это неотличимо: в
    // тестовом memory-роутере база пустая, и обе формы дают ту же строку.
    expect(wrapper.findAllComponents(RouterLink)
      .some((link) => link.attributes('data-test') === 'origins-link')).toBe(true);
  });

  it('даёт ссылку на демо-страницу с этим токеном', async () => {
    serve(WIDGET);
    const wrapper = await mountInstall();
    expect(wrapper.find('[data-test="demo-link"]').attributes('href'))
      .toBe('https://app.vell.pro/demo.html?token=wgt_00000000000000000000000000000001');
  });

  it('виджет без разрешённых сайтов — предупреждение, что он закрыт везде', async () => {
    // Пустой список = deny (Constraint 12). Панель обязана это ОБЪЯСНЯТЬ:
    // владелец вставит сниппет и не поймёт, почему кнопки нет.
    serve({ ...WIDGET, allowed_origins: [] });
    const wrapper = await mountInstall();
    expect(wrapper.find('[data-test="no-origins-warning"]').exists()).toBe(true);
  });
});
