import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClient, CoreHttpError } from '../src/core/client.ts';
import { FakeCore } from './helpers/fakeCore.ts';

let core: FakeCore;
let client: CoreClient;

beforeEach(async () => {
  core = new FakeCore();
  await core.start();
  client = new CoreClient({ baseUrl: core.baseUrl, tenantKey: 'sk_test_x', timeoutMs: 45_000 });
});
afterEach(() => core.stop());

const CREATED = {
  session_id: 'sess_0123456789abcdef',
  room: 'room-1',
  participant_token: { token: 'jwt', identity: 'respondent-x', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T10:00:00Z' },
};

describe('CoreClient', () => {
  it('createSession шлёт Bearer, Idempotency-Key и тело как есть', async () => {
    core.enqueue({ status: 201, body: CREATED });
    const res = await client.createSession(
      { channel: 'chat', agent: { instructions: 'Ты консультант.' }, limits: { max_duration_s: 600 } },
      'dlg:abc:1',
    );
    expect(res.participant_token.livekit_url).toBe('wss://lk.example');
    const call = core.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/v1/sessions');
    expect(call.headers.authorization).toBe('Bearer sk_test_x');
    expect(call.headers['idempotency-key']).toBe('dlg:abc:1');
    expect(call.body).toMatchObject({ channel: 'chat', limits: { max_duration_s: 600 } });
  });

  it('402 превращается в CoreHttpError с кодом ядра', async () => {
    core.enqueue({ status: 402, body: { error: { code: 'insufficient_credits', message: 'нет кредитов' } } });
    await expect(client.createSession({ channel: 'chat', agent: { instructions: 'x' } }, 'k')).rejects.toSatisfy(
      (err: unknown) => err instanceof CoreHttpError && err.status === 402 && err.code === 'insufficient_credits',
    );
  });

  it('ответ без тела ошибки всё равно даёт код http_<status>', async () => {
    core.enqueue({ status: 503, body: 'сервис недоступен' });
    await expect(client.getSession('sess_0123456789abcdef')).rejects.toSatisfy(
      (err: unknown) => err instanceof CoreHttpError && err.code === 'http_503',
    );
  });

  it('issueParticipantToken требует identity и бьёт в нужный путь', async () => {
    core.enqueue({ status: 201, body: CREATED.participant_token });
    const token = await client.issueParticipantToken('sess_0123456789abcdef', 'respondent-uuid');
    expect(token.identity).toBe('respondent-x');
    expect(core.calls[0]!.url).toBe('/api/v1/sessions/sess_0123456789abcdef/participant-tokens');
    expect(core.calls[0]!.body).toEqual({ identity: 'respondent-uuid' });
  });

  it('endSession глотает 404/410 — сессия уже закрыта, это не ошибка вызывающего', async () => {
    core.enqueue({ status: 410, body: { error: { code: 'session_finished', message: 'уже' } } });
    await expect(client.endSession('sess_0123456789abcdef')).resolves.toBeUndefined();
  });

  it('getTranscript прокидывает after_seq и limit', async () => {
    core.enqueue({ status: 200, body: { messages: [{ seq: 1, role: 'user', text: 'привет', created_at: '2026-08-13T10:00:00Z' }], has_more: false } });
    const page = await client.getTranscript('sess_0123456789abcdef', 3, 100);
    expect(page.messages).toHaveLength(1);
    expect(core.calls[0]!.url).toBe('/api/v1/sessions/sess_0123456789abcdef/transcript?after_seq=3&limit=100');
  });

  it('таймаут рвёт запрос и даёт код core_timeout', async () => {
    const fast = new CoreClient({ baseUrl: core.baseUrl, tenantKey: 'sk_test_x', timeoutMs: 50 });
    core.enqueue({ status: 201, body: CREATED, delayMs: 500 });
    await expect(fast.createSession({ channel: 'chat', agent: { instructions: 'x' } }, 'k')).rejects.toSatisfy(
      (err: unknown) => err instanceof CoreHttpError && err.code === 'core_timeout' && err.status === 504,
    );
  });
});
