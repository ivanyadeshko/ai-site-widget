import { describe, expect, it } from 'vitest';
import { encodeClientFrame, parseWorkerFrame } from '../src/lib/frames.ts';

describe('фреймы pv1', () => {
  it('user_text кодируется ровно как {type,text}', () => {
    const bytes = encodeClientFrame({ type: 'user_text', text: 'Меня зовут Пётр' });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ type: 'user_text', text: 'Меня зовут Пётр' });
  });

  it('client_ready и resume_welcome — без полезной нагрузки', () => {
    expect(JSON.parse(new TextDecoder().decode(encodeClientFrame({ type: 'client_ready' })))).toEqual({ type: 'client_ready' });
    expect(JSON.parse(new TextDecoder().decode(encodeClientFrame({ type: 'resume_welcome' })))).toEqual({ type: 'resume_welcome' });
  });

  it('transcript разбирается со speaker (data-channel говорит respondent, НЕ user)', () => {
    const frame = parseWorkerFrame(JSON.stringify({ type: 'transcript', speaker: 'respondent', text: 'привет' }));
    expect(frame).toEqual({ type: 'transcript', speaker: 'respondent', text: 'привет', interrupted: false });
  });

  it('легаси-поле role=avatar|client понимается как speaker', () => {
    const frame = parseWorkerFrame(JSON.stringify({ type: 'transcript', role: 'avatar', text: 'привет' }));
    expect(frame).toMatchObject({ type: 'transcript', speaker: 'agent' });
  });

  it('session_ended несёт свободную строку reason — незнакомое значение переживаем', () => {
    expect(parseWorkerFrame(JSON.stringify({ type: 'session_ended', reason: 'нечто_новое' })))
      .toEqual({ type: 'session_ended', reason: 'нечто_новое' });
  });

  it('мусор и чужие кадры дают null, а не исключение', () => {
    expect(parseWorkerFrame('не json')).toBeNull();
    expect(parseWorkerFrame(JSON.stringify({ нет: 'типа' }))).toBeNull();
    expect(parseWorkerFrame(JSON.stringify({ type: 'transcript' }))).toBeNull(); // нет text
  });

  it('неизвестный тип фрейма отдаётся как есть — протокол расширяется аддитивно', () => {
    expect(parseWorkerFrame(JSON.stringify({ type: 'session_timer', remaining_s: 42 })))
      .toEqual({ type: 'session_timer', remaining_s: 42 });
  });
});
