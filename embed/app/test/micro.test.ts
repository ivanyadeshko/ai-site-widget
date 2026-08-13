import { describe, expect, it } from 'vitest';
import { mountWidget, VOICE_OK } from './helpers/mount.ts';

const goVoice = async () => {
  const ctx = await mountWidget();
  await ctx.wrapper.find('[data-test=escalate]').trigger('click');
  await ctx.api.resolveEscalate(VOICE_OK);
  return ctx;
};

describe('микрофон в голосовом режиме', () => {
  it('публикуется сразу после входа в голосовую комнату', async () => {
    const { room } = await goVoice();
    expect(room.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it('включается ПОСЛЕ connect: до комнаты публиковать нечего', async () => {
    const { room } = await goVoice();
    expect(room.connect).toHaveBeenCalledBefore(room.setMicrophoneEnabled as never);
  });

  it('отказ в доступе (NotAllowedError) → понятный баннер, разговор не падает', async () => {
    // ДЕВИАЦИЯ от буквы брифа: бриф не резолвил escalate в этом тесте, но
    // escalate — ОТЛОЖЕННЫЙ промис (иначе тесты порядка/402/503 не проверить),
    // и без resolveEscalate поток не доходит до enableMic. Резолвим успехом —
    // падает уже сам микрофон (mockRejectedValueOnce), что и проверяем.
    const { wrapper, api, room } = await mountWidget();
    room.setMicrophoneEnabled.mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    );
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    expect(wrapper.text()).toContain('Микрофон недоступен');
    expect(wrapper.text()).toContain('разрешите доступ');
    // Фаза остаётся voice: аватара СЛЫШНО, просто нас не слышат.
    expect(wrapper.find('[data-test=voice-panel]').exists()).toBe(true);
  });

  it('кнопка mute гасит и возвращает публикацию', async () => {
    const { wrapper, room } = await goVoice();
    await wrapper.find('[data-test=mic-toggle]').trigger('click');
    expect(room.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await wrapper.find('[data-test=mic-toggle]').trigger('click');
    expect(room.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });

  it('в чат-режиме микрофон не трогаем вовсе', async () => {
    const { room } = await mountWidget();
    expect(room.setMicrophoneEnabled).not.toHaveBeenCalled();
  });
});
