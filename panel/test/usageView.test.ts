import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { NRadioGroup, NSelect } from 'naive-ui';
import UsageView from '../src/views/UsageView.vue';

/**
 * Отчёт запрашивается с ВЫЧИСЛЕННЫМИ границами периода (`now` и `now - N дней`),
 * поэтому таблица «URL → ответ» здесь не годится: адрес меняется каждую
 * миллисекунду. Стаб отвечает по `group_by` и запоминает адреса — на них же
 * проверяется само окно периода.
 */
const usageFetch = (bodies: { day: unknown; widget?: unknown }): string[] => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const body = query.get('group_by') === 'widget' ? bodies.widget ?? bodies.day : bodies.day;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
};

const DAY_REPORT = {
  from: '2026-07-19T00:00:00.000Z',
  to: '2026-08-18T00:00:00.000Z',
  group_by: 'day',
  buckets: [
    { day: '2026-08-17', dialogs: 2, credits_total: 7, usage: { llm_input_tokens: 120, tts_characters: 25 } },
    { day: '2026-08-18', dialogs: 1, credits_total: 3, usage: { llm_input_tokens: 40 } },
  ],
  totals: { dialogs: 3, credits_total: 10, usage: { llm_input_tokens: 160, tts_characters: 25 } },
};

const WIDGET_REPORT = {
  from: '2026-07-19T00:00:00.000Z',
  to: '2026-08-18T00:00:00.000Z',
  group_by: 'widget',
  buckets: [
    { widget_id: 'w-1', widget_name: 'Виджет магазина', dialogs: 3, credits_total: 10, usage: { llm_input_tokens: 160 } },
    { widget_id: 'w-2', widget_name: 'Молчащий', dialogs: 0, credits_total: 0, usage: {} },
  ],
  totals: DAY_REPORT.totals,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const mountView = async () => {
  const wrapper = mount(UsageView);
  await flushPromises();
  return wrapper;
};

const periodDays = (url: string): number => {
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  const from = new Date(query.get('from')!).getTime();
  const to = new Date(query.get('to')!).getTime();
  return Math.round((to - from) / DAY_MS);
};

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('экран использования', () => {
  it('по умолчанию спрашивает последние 30 дней с группировкой по дням', async () => {
    const calls = usageFetch({ day: DAY_REPORT });
    const wrapper = await mountView();

    expect(calls).toHaveLength(1);
    expect(periodDays(calls[0]!)).toBe(30);
    expect(calls[0]).toContain('group_by=day');
    expect(wrapper.text()).toContain('Последние 30 дней');
  });

  it('колонки метров строятся ПО ДАННЫМ, а не по списку в коде', async () => {
    // Набор метров задаёт ядро. Зашитый перечень тихо спрятал бы новый — то же
    // правило, что и в SQL агрегата.
    usageFetch({ day: DAY_REPORT });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('llm_input_tokens');
    expect(wrapper.text()).toContain('tts_characters');
    expect(wrapper.text()).toContain('2026-08-17');
    expect(wrapper.text()).toContain('120');
    // У дня без метра колонка обязана показать 0, а не пустоту: пропуск
    // читается как «данные не приехали».
    expect(wrapper.text()).toContain('0');
  });

  it('деньги за период показаны итогом, а не суммой на глаз', async () => {
    usageFetch({ day: DAY_REPORT });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('Диалогов за период');
    expect(wrapper.text()).toContain('Кредитов списано');
    expect(wrapper.text()).toContain('10');
  });

  it('переключение на «по виджетам» перезапрашивает отчёт и меняет колонку', async () => {
    const calls = usageFetch({ day: DAY_REPORT, widget: WIDGET_REPORT });
    const wrapper = await mountView();

    wrapper.findComponent(NRadioGroup).vm.$emit('update:value', 'widget');
    await flushPromises();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('group_by=widget');
    expect(wrapper.text()).toContain('Виджет магазина');
    // Молчащий виджет обязан остаться в отчёте нулевой строкой (LEFT JOIN на
    // бэкенде) — иначе владелец решит, что виджет пропал.
    expect(wrapper.text()).toContain('Молчащий');
  });

  it('смена периода перезапрашивает отчёт с новым окном', async () => {
    const calls = usageFetch({ day: DAY_REPORT });
    const wrapper = await mountView();

    wrapper.findComponent(NSelect).vm.$emit('update:value', 7);
    await flushPromises();

    expect(calls).toHaveLength(2);
    expect(periodDays(calls[1]!)).toBe(7);
  });

  it('отказ сервера объясняется текстом, а не пустой таблицей', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'invalid_period', message: 'Период не может быть длиннее 366 дней.' } }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )));
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('Период не может быть длиннее 366 дней.');
  });
});
