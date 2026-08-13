import { describe, expect, it } from 'vitest';
import { bannerFor, nextPhase } from '../src/lib/fsm.ts';

describe('FSM диалога', () => {
  it('обычный путь: idle → chat → escalating → voice', () => {
    expect(nextPhase('idle', { type: 'start' })).toBe('chat');
    expect(nextPhase('chat', { type: 'escalate' })).toBe('escalating');
    expect(nextPhase('escalating', { type: 'voice_ready' })).toBe('voice');
  });

  it('ОБРЫВ СОЕДИНЕНИЯ В escalating — ШТАТНЫЙ переход, не ошибка: /end сносит комнату БЕЗ session_ended', () => {
    expect(nextPhase('escalating', { type: 'disconnected' })).toBe('escalating');
  });

  it('обрыв в ended тоже не ошибка', () => {
    expect(nextPhase('ended', { type: 'disconnected' })).toBe('ended');
  });

  it('обрыв в живом чате/голосе — ошибка', () => {
    expect(nextPhase('chat', { type: 'disconnected' })).toBe('error');
    expect(nextPhase('voice', { type: 'disconnected' })).toBe('error');
  });

  it('провал эскалации: нет денег → error; сервис недоступен/невалидно → chat_fallback', () => {
    expect(nextPhase('escalating', { type: 'escalate_failed', code: 'insufficient_credits' })).toBe('error');
    expect(nextPhase('escalating', { type: 'escalate_failed', code: 'unavailable' })).toBe('chat_fallback');
    expect(nextPhase('escalating', { type: 'escalate_failed', code: 'invalid' })).toBe('chat_fallback');
  });

  it('chat_fallback возвращается в chat по resume', () => {
    expect(nextPhase('chat_fallback', { type: 'resume' })).toBe('chat');
  });

  it('session_ended:silence — это ПАУЗА (центральный сценарий idle-фрагментации), а не конец', () => {
    expect(nextPhase('chat', { type: 'session_ended', reason: 'silence' })).toBe('paused');
    expect(nextPhase('voice', { type: 'session_ended', reason: 'silence' })).toBe('paused');
    expect(nextPhase('paused', { type: 'resume' })).toBe('chat');
  });

  it('прочие причины session_ended закрывают диалог', () => {
    expect(nextPhase('chat', { type: 'session_ended', reason: 'completed' })).toBe('ended');
    expect(nextPhase('voice', { type: 'session_ended', reason: 'duration_limit' })).toBe('ended');
  });

  it('НЕЗНАКОМАЯ причина переживается: причины расширяются аддитивно', () => {
    expect(nextPhase('chat', { type: 'session_ended', reason: 'нечто_из_будущего' })).toBe('ended');
  });

  it('фатальные коды ядра ведут в error', () => {
    expect(nextPhase('chat', { type: 'fatal', code: 'insufficient_credits' })).toBe('error');
  });

  it('баннеры: пауза даёт кнопку «Продолжить», 402 — рестарта нет', () => {
    expect(bannerFor('paused')).toEqual({ text: 'Диалог приостановлен', action: 'resume' });
    expect(bannerFor('error', 'insufficient_credits').action).toBe('none');
    expect(bannerFor('error', 'insufficient_credits').text).toContain('лимит');
    expect(bannerFor('chat_fallback').action).toBe('resume');
    expect(bannerFor('error', 'service_unavailable').text).toContain('недоступен');
    expect(bannerFor('error', 'session_finished').action).toBe('restart');
    expect(bannerFor('chat').action).toBe('none');
  });
});
