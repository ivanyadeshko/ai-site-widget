import { describe, expect, it, vi } from 'vitest';
import { mountWidget, VOICE_OK } from './helpers/mount.ts';

describe('эскалация в голос', () => {
  it('порядок обязателен: инпут заблокирован → ОТКЛЮЧИЛИСЬ от чата → /escalate → голос', async () => {
    const { wrapper, api, room, sent } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');

    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined();
    // От чат-комнаты отключаемся САМИ, до вызова: иначе ловим свой же обрыв.
    expect(room.disconnect).toHaveBeenCalledBefore(api.escalate as never);
    expect(wrapper.text()).toContain('Соединяю с голосом…');

    await api.resolveEscalate({
      dialog_id: 'd1', channel: 'voice', core_session_id: 'sess_bbbbbbbbbbbbbbbb',
      participant_token: { token: 'jwt-voice', identity: 'respondent-x', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T11:00:00Z' },
      continued_from: 'sess_aaaaaaaaaaaaaaaa', transcript_complete: true,
    });

    expect(room.connect).toHaveBeenLastCalledWith('wss://lk.example', 'jwt-voice', { audio: true });
    // Голос: сначала client_ready, ПОТОМ resume_welcome — иначе welcome-back
    // прозвучит в ещё не подписанный трек.
    expect(sent.map((f) => f.type)).toEqual(['client_ready', 'resume_welcome']);
  });

  it('messages_count = свои реплики + ответы агента, БЕЗ greeting', async () => {
    const { wrapper, api, room } = await mountWidget();
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: 'Здравствуйте!', interrupted: false }); // greeting
    await wrapper.find('textarea').setValue('Меня зовут Пётр');
    await wrapper.find('[data-test=send]').trigger('click');
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: 'Приятно, Пётр!', interrupted: false }); // ответ
    await wrapper.find('[data-test=escalate]').trigger('click');
    expect(api.escalate).toHaveBeenCalledWith('d1', expect.any(String), 2);
  });

  it('resume_welcome НЕ уходит до появления агента: фрейм в пустую комнату теряется навсегда', async () => {
    vi.useFakeTimers();
    const { wrapper, api, room, sent } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    sent.length = 0;
    vi.advanceTimersByTime(12_000);
    expect(sent.filter((f) => f.type === 'resume_welcome')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('resume_welcome стартует по appearance агента и повторяется 3с×5', async () => {
    vi.useFakeTimers();
    const { wrapper, api, room, sent } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    sent.length = 0;
    room.emitAgentJoined();
    expect(sent.filter((f) => f.type === 'resume_welcome')).toHaveLength(1);
    vi.advanceTimersByTime(9000);
    expect(sent.filter((f) => f.type === 'resume_welcome').length).toBeGreaterThanOrEqual(3);
    vi.advanceTimersByTime(60_000);
    expect(sent.filter((f) => f.type === 'resume_welcome').length).toBeLessThanOrEqual(5);
    vi.useRealTimers();
  });

  it('#4 гонка взвода: агент УЖЕ в комнате на voice-connect (phase=escalating) — повторяющий resume_welcome ВСЁ РАВНО взводится', async () => {
    vi.useFakeTimers();
    // agentJoinsOnConnect → onAgentJoined приходит СИНХРОННО внутри room.connect,
    // когда phase ещё 'escalating' (voice ставится ПОСЛЕ await connect+enableMic).
    const { wrapper, api, sent } = await mountWidget({ agentJoinsOnConnect: true });
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    // Взвёлся именно ПОВТОРЯЮЩИЙ ресендер, а не только одноразовый resume_welcome:
    // за 9с должно прилететь ещё как минимум пара тиков.
    const before = sent.filter((f) => f.type === 'resume_welcome').length;
    vi.advanceTimersByTime(9000);
    const after = sent.filter((f) => f.type === 'resume_welcome').length;
    expect(after - before).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it('гасится РЕЧЬЮ агента, а не любым кадром: pong/session_timer ничего не доказывают', async () => {
    vi.useFakeTimers();
    const { wrapper, api, room, sent } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    room.emitAgentJoined();
    sent.length = 0;
    // Служебные кадры НЕ считаются подтверждением: аватар всё ещё молчит.
    room.emitFrame({ type: 'session_timer', remaining_s: 590 });
    vi.advanceTimersByTime(9000);
    expect(sent.filter((f) => f.type === 'resume_welcome').length).toBeGreaterThanOrEqual(2);
    // А вот реплика агента — доказательство, что welcome-back доехал.
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: 'Рад продолжить!', interrupted: false });
    const after = sent.length;
    vi.advanceTimersByTime(30_000);
    expect(sent.length - after).toBeLessThanOrEqual(1); // один добивающий допустим
    vi.useRealTimers();
  });

  it('402 на эскалации → баннер про лимит, кнопки продолжения НЕТ', async () => {
    const { wrapper, api } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.rejectEscalate({ status: 402, code: 'insufficient_credits' });
    expect(wrapper.text()).toContain('лимит');
    expect(wrapper.find('[data-test=resume]').exists()).toBe(false);
  });

  it('503 на эскалации → chat_fallback: кнопка возвращает в чат новой сессией с продолжением', async () => {
    const { wrapper, api } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.rejectEscalate({ status: 503, code: 'service_unavailable' });
    expect(wrapper.text()).toContain('продолжим текстом');
    await wrapper.find('[data-test=resume]').trigger('click');
    expect(api.startDialog).toHaveBeenLastCalledWith(expect.any(String), 'd1');
  });

  it('обрыв комнаты в фазе escalating НЕ показывает ошибку', async () => {
    const { wrapper, room } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    room.emitDisconnected();
    await wrapper.vm.$nextTick(); // ДЕВИАЦИЯ: без флаша DOM не переигрывается и
    // мутпроба M4 (escalating→error) не ловится — тест был бы тавтологией.
    expect(wrapper.text()).not.toContain('Что-то пошло не так');
    expect(wrapper.text()).toContain('Соединяю с голосом…');
  });

  it('session_ended:silence → баннер «Продолжить», клик заводит новую сессию того же диалога', async () => {
    const { wrapper, api, room } = await mountWidget();
    room.emitFrame({ type: 'session_ended', reason: 'silence' });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Диалог приостановлен');
    await wrapper.find('[data-test=resume]').trigger('click');
    expect(api.startDialog).toHaveBeenLastCalledWith(expect.any(String), 'd1');
  });

  it('видеотрек аватара реально ОТПИСЫВАЕТСЯ: платить за egress видео в аудио-UI незачем', async () => {
    const { wrapper, api, room } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    expect(room.connect).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), { audio: true });
    // Комната отдаёт публикацию видео — клиент обязан её погасить вызовом
    // setSubscribed(false), а не «просто не рисовать» (трек всё равно течёт).
    const publication = room.emitVideoPublication();
    expect(publication.setSubscribed).toHaveBeenCalledWith(false);
  });

  it('аудиотрек, наоборот, подписывается и ПРИКРЕПЛЯЕТСЯ — без attach() голоса не слышно', async () => {
    const { wrapper, api, room } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    const track = room.emitAudioTrack();
    expect(track.attach).toHaveBeenCalled();
    expect(document.querySelectorAll('audio').length).toBeGreaterThan(0);
  });
});
