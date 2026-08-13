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

// Критичная обязанность клиента T6: «session_ended{reason:silence} → баннер +
// Продолжить (continue_from)». ФИКС-РАУНД 1 #5: единственный баннер паузы теперь
// ResumeBanner (T7) — data-test=resume-banner / кнопка resume; T6 StateBanner и
// resume() удалены (двойная кнопка «Продолжить» на паузе). Контракт согласован с
// escalationFlow.test (тоже ждёт [data-test=resume]).
describe('пауза диалога (session_ended)', () => {
  it('баннер паузы, композер выключен, «Продолжить» переоткрывает нить с dialog_id (continue_from)', async () => {
    const { wrapper, api, room } = await mountWidget();
    room.emitFrame({ type: 'session_ended', reason: 'silence' });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test=resume-banner]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Диалог приостановлен');
    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined();

    await wrapper.find('[data-test=resume]').trigger('click');
    await flushPromises();

    // Повторный startDialog С dialog_id — это путь continue_from ядра.
    expect(api.startDialog).toHaveBeenCalledWith(expect.any(String), 'd1');
    expect(room.disconnect).toHaveBeenCalled();
    // Пауза-баннер исчез: фаза вернулась в chat (bannerFor('chat') пуст).
    expect(wrapper.find('[data-test=resume]').exists()).toBe(false);
  });

  // ФИКС-РАУНД 1 #2: терминальный reason (не silence) — конец, а не пауза.
  it('терминальный reason → «Диалог завершён» БЕЗ кнопки «Продолжить»', async () => {
    const { wrapper, room } = await mountWidget();
    room.emitFrame({ type: 'session_ended', reason: 'completed' });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Диалог завершён');
    expect(wrapper.find('[data-test=resume]').exists()).toBe(false); // продолжать нечего
  });

  // ФИКС-РАУНД 1 #3: двойной клик «Продолжить» не заводит две сессии.
  it('двойной клик «Продолжить» заводит РОВНО одну сессию (guard)', async () => {
    const { wrapper, api, room } = await mountWidget();
    room.emitFrame({ type: 'session_ended', reason: 'silence' });
    await wrapper.vm.$nextTick();
    const before = api.startDialog.mock.calls.length;
    const btn = wrapper.find('[data-test=resume]'); // ResumeBanner «Продолжить» → resumeThread
    btn.trigger('click');
    btn.trigger('click'); // второй клик подряд, до разрешения первого
    await flushPromises();
    expect(api.startDialog.mock.calls.length - before).toBe(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
  });
});

// ФИКС whole-branch #1: провал ПЕРВИЧНОГО открытия нити (startDialog) должен вести
// в error-фазу с понятным баннером, а не оставлять активный пустой чат (send()
// публиковал бы user_text в null-комнату — молчаливый дроп). §5 спеки.
describe('провал открытия диалога', () => {
  it('402 на первичном startDialog → error-баннер про лимит, композер выключен (НЕ пустой чат)', async () => {
    const { wrapper } = await mountWidget({ startError: { status: 402, code: 'insufficient_credits', message: 'нет средств' } });
    expect(wrapper.text()).toContain('лимит');                                   // баннер лимита
    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined();       // композер выключен
    expect(wrapper.find('[data-test=escalate]').exists()).toBe(false);           // не chat-фаза
  });

  it('503 на первичном startDialog → error-баннер «сервис недоступен, позже»', async () => {
    const { wrapper } = await mountWidget({ startError: { status: 503, code: 'service_unavailable', message: 'позже' } });
    expect(wrapper.text()).toContain('недоступен');
    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined();
  });

  // LOW #3: у restart не было засова resuming — двойной клик = 2 платных startDialog.
  it('двойной клик «Начать заново» → ровно один startDialog (засов restart)', async () => {
    const { wrapper, api } = await mountWidget({ startError: { status: 404, code: 'dialog_not_found', message: 'нет' } });
    expect(wrapper.find('[data-test=restart]').exists()).toBe(true);             // error с действием restart
    // Дальше рестарт должен пройти — снимаем ошибку у мока.
    api.startDialog.mockResolvedValue({
      dialog_id: 'd1', channel: 'chat',
      participant_token: { token: 't', identity: 'i', livekit_url: 'wss://x', expires_at: '' },
      messages: [], next_seq: 1,
    });
    const before = api.startDialog.mock.calls.length;
    const btn = wrapper.find('[data-test=restart]');
    btn.trigger('click');
    btn.trigger('click');
    await flushPromises();
    expect(api.startDialog.mock.calls.length - before).toBe(1);
  });
});
