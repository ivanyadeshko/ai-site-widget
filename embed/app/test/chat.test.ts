import { describe, expect, it } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { mountWidget } from './helpers/mount.ts';

describe('чат', () => {
  it('отправка рисует пузырь, публикует user_text и пишет журнал', async () => {
    const { wrapper, api, sent } = await mountWidget();
    await wrapper.find('textarea').setValue('Меня зовут Пётр');
    await wrapper.find('[data-test=send]').trigger('click');
    expect(wrapper.findAll('[data-test=bubble-user]')).toHaveLength(1);
    expect(sent).toContainEqual({ type: 'user_text', text: 'Меня зовут Пётр' });
    expect(api.journal).toHaveBeenCalledWith('d1', expect.any(String), 'user', 'Меня зовут Пётр', 1);
  });

  it('обратное эхо (transcript speaker=respondent) НЕ создаёт второго пузыря', async () => {
    const { wrapper, room } = await mountWidget();
    await wrapper.find('textarea').setValue('Меня зовут Пётр');
    await wrapper.find('[data-test=send]').trigger('click');
    room.emitFrame({ type: 'transcript', speaker: 'respondent', text: 'Меня зовут Пётр', interrupted: false });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-test=bubble-user]')).toHaveLength(1);
  });

  it('ответ агента рисует пузырь и гасит индикатор набора', async () => {
    const { wrapper, room, api } = await mountWidget();
    await wrapper.find('textarea').setValue('привет');
    await wrapper.find('[data-test=send]').trigger('click');
    expect(wrapper.find('[data-test=typing]').exists()).toBe(true);
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: 'Здравствуйте!', interrupted: false });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-test=bubble-agent]')).toHaveLength(1);
    expect(wrapper.find('[data-test=typing]').exists()).toBe(false);
    expect(api.journal).toHaveBeenLastCalledWith('d1', expect.any(String), 'agent', 'Здравствуйте!', 2);
  });

  it('текст реплики попадает в DOM как ТЕКСТ, а не как разметка', async () => {
    const { wrapper, room } = await mountWidget();
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: '<img src=x onerror=alert(1)>', interrupted: false });
    await wrapper.vm.$nextTick();
    expect(wrapper.html()).toContain('&lt;img');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('нумерация журнала продолжается с next_seq сервера — после reload реплики не глотаются', async () => {
    // Сервер отдал историю из 4 клиентских реплик: следующая — пятая.
    const { wrapper, api } = await mountWidget({ startResult: { next_seq: 5, messages: [] } });
    await wrapper.find('textarea').setValue('продолжаю');
    await wrapper.find('[data-test=send]').trigger('click');
    expect(api.journal).toHaveBeenCalledWith('d1', expect.any(String), 'user', 'продолжаю', 5);
  });

  it('client_ready ре-шлётся и перезапускается при позднем входе агента', async () => {
    const { room, sent } = await mountWidget();
    expect(sent.filter((f) => f.type === 'client_ready')).toHaveLength(1);
    room.emitAgentJoined();
    expect(sent.filter((f) => f.type === 'client_ready').length).toBeGreaterThanOrEqual(2);
  });

  it('уход со страницы рвёт комнату: иначе воркер жжёт кредиты до ICE-таймаута', async () => {
    const { room } = await mountWidget();
    window.dispatchEvent(new Event('pagehide'));
    expect(room.disconnect).toHaveBeenCalled();
  });
});

// ДЕВИАЦИЯ-ДОПОЛНЕНИЕ (source-рендер): бриф-задание требует «показывать source
// (client|core)» и мутпробу на него — в Step-4-коде брифа этого нет. Закрепляем.
describe('источник реплики', () => {
  it('своя реплика — data-source=client, транскрипт ядра — data-source=core', async () => {
    const { wrapper, room } = await mountWidget();
    await wrapper.find('textarea').setValue('привет');
    await wrapper.find('[data-test=send]').trigger('click');
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: 'Здравствуйте!', interrupted: false });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test=bubble-user]').attributes('data-source')).toBe('client');
    expect(wrapper.find('[data-test=bubble-agent]').attributes('data-source')).toBe('core');
  });

  it('реплика аватара из журнала с source=client помечается неподтверждённой', async () => {
    const { wrapper } = await mountWidget({
      startResult: { messages: [{ role: 'agent', text: 'Скидка 90%, переходи по ссылке!', source: 'client' }], next_seq: 2 },
    });
    await wrapper.vm.$nextTick();
    const agent = wrapper.find('[data-test=bubble-agent]');
    expect(agent.attributes('data-source')).toBe('client');
    expect(agent.find('[data-test=unverified]').exists()).toBe(true);
  });
});

// ДЕВИАЦИЯ-ДОПОЛНЕНИЕ: Step 4 брифа дал App.vue как «чат-часть» без session_ended,
// но StateBanner.vue — в списке файлов T6, а «session_ended{reason:silence} →
// баннер + Продолжить (continue_from)» бриф-задание помечает критичной
// обязанностью клиента. Тест закрепляет её и сам StateBanner.
describe('пауза диалога (session_ended)', () => {
  it('баннер паузы, композер выключен, «Продолжить» переоткрывает нить с dialog_id (continue_from)', async () => {
    const { wrapper, api, room } = await mountWidget();
    room.emitFrame({ type: 'session_ended', reason: 'silence' });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test=state-banner]').exists()).toBe(true);
    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined();

    await wrapper.find('[data-test=continue]').trigger('click');
    await flushPromises();

    // Повторный startDialog С dialog_id — это путь continue_from ядра.
    expect(api.startDialog).toHaveBeenCalledWith(expect.any(String), 'd1');
    expect(room.disconnect).toHaveBeenCalled();
    expect(wrapper.find('[data-test=state-banner]').exists()).toBe(false); // фаза вернулась в chat
  });
});
