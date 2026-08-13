export type WorkerFrame =
  | { type: 'transcript'; speaker: 'agent' | 'respondent'; text: string; interrupted: boolean }
  | { type: 'session_ended'; reason: string }
  | { type: 'agent_typing'; value: boolean }
  | { type: string; [key: string]: unknown };

export type ClientFrame =
  | { type: 'client_ready' }
  | { type: 'resume_welcome' }
  | { type: 'user_text'; text: string };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export const encodeClientFrame = (frame: ClientFrame): Uint8Array => encoder.encode(JSON.stringify(frame));

export function parseWorkerFrame(raw: Uint8Array | string): WorkerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : decoder.decode(raw));
  } catch {
    return null; // чужой кадр в комнате не должен ронять чат
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  if (typeof frame.type !== 'string') return null;

  if (frame.type === 'transcript') {
    if (typeof frame.text !== 'string') return null;
    // data-channel исторически говорит 'respondent', REST ядра — 'user'.
    // Легаси-синоним role=avatar|client клиентский роутер обязан понимать.
    const legacy = frame.role === 'avatar' ? 'agent' : frame.role === 'client' ? 'respondent' : undefined;
    const speaker = frame.speaker === 'agent' || frame.speaker === 'respondent' ? frame.speaker : legacy;
    if (!speaker) return null;
    return { type: 'transcript', speaker, text: frame.text, interrupted: frame.interrupted === true };
  }
  if (frame.type === 'session_ended') {
    return { type: 'session_ended', reason: typeof frame.reason === 'string' ? frame.reason : '' };
  }
  return frame as WorkerFrame;
}
