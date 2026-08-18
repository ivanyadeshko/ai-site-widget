import type {
  CoreSession, CreditsBalance, ParticipantToken, SessionCreate, SessionCreated, TranscriptPage,
} from './types.ts';

export class CoreHttpError extends Error {
  readonly status: number;
  readonly code: string;

  // НЕ параметр-свойства (readonly status в сигнатуре конструктора): это
  // синтаксический сахар TS, который требует трансформации тела, а не только
  // стирания типов. `node --experimental-strip-types` (см. `npm run dev` и
  // голый запуск src/server.ts) — режим ТОЛЬКО стирания типов и падает на
  // параметр-свойствах с ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX; vitest/tsc это
  // компилируют молча, поэтому баг не ловится тестами — только живым процессом.
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CoreHttpError';
    this.status = status;
    this.code = code;
  }
}

export type CoreClientOptions = {
  baseUrl: string;
  tenantKey: string;
  /** POST /v1/sessions блокирующий: ядро поднимает комнату и зовёт агента, до ~40с. */
  timeoutMs?: number;
};

export class CoreClient {
  private readonly baseUrl: string;
  private readonly tenantKey: string;
  private readonly timeoutMs: number;

  constructor(opts: CoreClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.tenantKey = opts.tenantKey;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; okStatuses?: number[]; swallow?: number[] } = {},
  ): Promise<T | undefined> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.tenantKey}`, accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new CoreHttpError(
        aborted ? 504 : 502,
        aborted ? 'core_timeout' : 'core_unreachable',
        `${method} ${path}: ${aborted ? `ядро не ответило за ${this.timeoutMs}мс` : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (opts.swallow?.includes(res.status)) return undefined;
    const ok = opts.okStatuses ?? [200, 201, 204];
    if (!ok.includes(res.status)) {
      const text = await res.text();
      let code = `http_${res.status}`;
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        if (parsed.error?.code) code = parsed.error.code;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // Не-json тело ядра — оставляем http_<status> и сырой текст.
      }
      throw new CoreHttpError(res.status, code, `${method} ${path} → ${res.status} ${code}: ${message}`);
    }
    if (res.status === 204) return undefined;
    return (await res.json()) as T;
  }

  createSession(body: SessionCreate, idempotencyKey: string): Promise<SessionCreated> {
    return this.request<SessionCreated>('POST', '/v1/sessions', { body, idempotencyKey, okStatuses: [201] }) as Promise<SessionCreated>;
  }

  issueParticipantToken(sessionId: string, identity: string): Promise<ParticipantToken> {
    return this.request<ParticipantToken>('POST', `/v1/sessions/${sessionId}/participant-tokens`, {
      body: { identity },
      okStatuses: [201],
    }) as Promise<ParticipantToken>;
  }

  async endSession(sessionId: string): Promise<void> {
    // 404/410 — сессии уже нет; для вызывающего это тот же исход, что и 204.
    await this.request<void>('POST', `/v1/sessions/${sessionId}/end`, { okStatuses: [204], swallow: [404, 410] });
  }

  getTranscript(sessionId: string, afterSeq = 0, limit = 500): Promise<TranscriptPage> {
    return this.request<TranscriptPage>(
      'GET',
      `/v1/sessions/${sessionId}/transcript?after_seq=${afterSeq}&limit=${limit}`,
      { okStatuses: [200] },
    ) as Promise<TranscriptPage>;
  }

  getSession(sessionId: string): Promise<CoreSession> {
    return this.request<CoreSession>('GET', `/v1/sessions/${sessionId}`, { okStatuses: [200] }) as Promise<CoreSession>;
  }

  /**
   * Баланс кредитов ТЕНАНТА — единственная цифра ядра, которую видит оператор
   * витрины. Для ядра весь виджет-продукт один тенант (D-1), поэтому это баланс
   * ОБЩИЙ на всех клиентов, а не персональный: подпись в UI обязана это
   * говорить прямым текстом.
   */
  getCreditsBalance(): Promise<CreditsBalance> {
    return this.request<CreditsBalance>('GET', '/v1/credits/balance', { okStatuses: [200] }) as Promise<CreditsBalance>;
  }
}
