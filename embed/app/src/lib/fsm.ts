export type DialogPhase =
  | 'idle' | 'chat' | 'escalating' | 'voice' | 'chat_fallback' | 'paused' | 'ended' | 'error';

export type DialogEvent =
  | { type: 'start' }
  | { type: 'connected' }
  | { type: 'escalate' }
  | { type: 'voice_ready' }
  | { type: 'escalate_failed'; code: 'insufficient_credits' | 'unavailable' | 'invalid' }
  | { type: 'session_ended'; reason: string }
  | { type: 'resume' }
  | { type: 'disconnected' }
  | { type: 'fatal'; code: string };

/** Фазы, в которых обрыв LiveKit — ШТАТНЫЙ ход, а не поломка. */
const DISCONNECT_IS_NORMAL = new Set<DialogPhase>(['escalating', 'ended', 'error', 'paused', 'chat_fallback', 'idle']);

export function nextPhase(phase: DialogPhase, event: DialogEvent): DialogPhase {
  switch (event.type) {
    case 'start': return 'chat';
    case 'connected': return phase === 'idle' ? 'chat' : phase;
    case 'escalate': return phase === 'chat' ? 'escalating' : phase;
    case 'voice_ready': return 'voice';
    case 'escalate_failed':
      // Денег нет — диалог мёртв; всё прочее откатывается в чат (§5 спеки).
      return event.code === 'insufficient_credits' ? 'error' : 'chat_fallback';
    case 'session_ended':
      // silence — ЦЕНТРАЛЬНЫЙ сценарий: idle ядра 120/300с рвёт нить постоянно.
      return event.reason === 'silence' ? 'paused' : 'ended';
    case 'resume': return 'chat';
    case 'disconnected':
      // `POST /end` сносит комнату БЕЗ фрейма session_ended — в escalating и
      // ended это ожидаемо и молча проглатывается.
      return DISCONNECT_IS_NORMAL.has(phase) ? phase : 'error';
    case 'fatal': return 'error';
    default: return phase;
  }
}

export function bannerFor(phase: DialogPhase, code?: string): { text: string; action: 'resume' | 'restart' | 'none' } {
  if (phase === 'paused') return { text: 'Диалог приостановлен', action: 'resume' };
  // Терминальный конец (session_ended с любым НЕ-silence reason: completed,
  // duration_limit, …) — нить закрыта штатно, продолжать нечего: только текст,
  // БЕЗ «Продолжить» (иначе кнопка подняла бы платную continue_from на мёртвой нити).
  if (phase === 'ended') return { text: 'Диалог завершён', action: 'none' };
  if (phase === 'chat_fallback') return { text: 'Голосовая связь сейчас недоступна — продолжим текстом', action: 'resume' };
  if (phase === 'escalating') return { text: 'Соединяю с голосом…', action: 'none' };
  if (phase === 'error') {
    if (code === 'insufficient_credits') return { text: 'Исчерпан лимит обращений. Напишите нам другим способом.', action: 'none' };
    if (code === 'service_unavailable') return { text: 'Сервис временно недоступен, попробуйте позже', action: 'none' };
    if (code === 'session_finished' || code === 'dialog_not_found') return { text: 'Диалог устарел — начните заново', action: 'restart' };
    return { text: 'Что-то пошло не так', action: 'restart' };
  }
  return { text: '', action: 'none' };
}
