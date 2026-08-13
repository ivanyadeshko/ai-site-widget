/**
 * Клиент публичного BFF (T3). iframe отдаётся с того же origin, что и API
 * (`${publicOrigin}/app/:token`), поэтому пути относительные — CORS не нужен,
 * а `connect-src 'self'` из CSP их пропускает.
 */

export type ApiFailure = { status: number; code: string; message: string };

export type ConfigResult = {
  widget_id: string; name: string; enabled: boolean;
  allowed_origins: string[]; app_url: string; text_max_length: number;
};

export type ParticipantToken = { token: string; identity: string; livekit_url?: string; expires_at: string };

export type PublicMessage = {
  role: 'user' | 'agent'; text: string; seq: number;
  source: 'client' | 'core'; created_at: string;
};

export type StartDialogResult = {
  dialog_id: string; channel: 'chat'; participant_token: ParticipantToken;
  continued_from?: string; history_lost?: boolean;
  messages: PublicMessage[]; next_seq: number;
};

export type ReenterResult = {
  dialog_id: string; channel: 'chat' | 'voice';
  participant_token: ParticipantToken; messages: PublicMessage[]; next_seq: number;
};

export type LeadPayload = {
  name?: string; phone?: string; email?: string; comment?: string; consent: boolean;
};

const isFailure = (value: unknown): value is { error: { code?: unknown; message?: unknown } } =>
  typeof value === 'object' && value !== null && 'error' in value;

export class WidgetApi {
  constructor(private readonly token: string) {}

  private base(path: string): string {
    return `/w/v1/${encodeURIComponent(this.token)}${path}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base(path), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let code = 'http_error';
      let message = res.statusText || `HTTP ${res.status}`;
      try {
        const parsed: unknown = await res.json();
        if (isFailure(parsed)) {
          if (typeof parsed.error.code === 'string') code = parsed.error.code;
          if (typeof parsed.error.message === 'string') message = parsed.error.message;
        }
      } catch {
        // тело не JSON — оставляем statusText
      }
      const failure: ApiFailure = { status: res.status, code, message };
      throw failure;
    }
    return (await res.json()) as T;
  }

  config(): Promise<ConfigResult> {
    return this.request<ConfigResult>('GET', '/config');
  }

  startDialog(visitorKey: string, dialogId?: string): Promise<StartDialogResult> {
    return this.request<StartDialogResult>('POST', '/dialogs', {
      visitor_key: visitorKey,
      ...(dialogId ? { dialog_id: dialogId } : {}),
    });
  }

  reenter(dialogId: string, visitorKey: string): Promise<ReenterResult> {
    return this.request<ReenterResult>('POST', `/dialogs/${encodeURIComponent(dialogId)}/reenter`, {
      visitor_key: visitorKey,
    });
  }

  journal(
    dialogId: string, visitorKey: string,
    role: 'user' | 'agent', text: string, seq: number,
  ): Promise<{ stored: boolean }> {
    return this.request<{ stored: boolean }>('POST', `/dialogs/${encodeURIComponent(dialogId)}/messages`, {
      visitor_key: visitorKey, role, text, seq,
    });
  }

  end(dialogId: string, visitorKey: string): Promise<{ dialog_id: string; status: string }> {
    return this.request('POST', `/dialogs/${encodeURIComponent(dialogId)}/end`, { visitor_key: visitorKey });
  }

  escalate(dialogId: string, visitorKey: string, messagesCount: number): Promise<StartDialogResult> {
    return this.request<StartDialogResult>('POST', `/dialogs/${encodeURIComponent(dialogId)}/escalate`, {
      visitor_key: visitorKey, messages_count: messagesCount,
    });
  }

  lead(dialogId: string, visitorKey: string, payload: LeadPayload): Promise<{ lead_id: string }> {
    return this.request('POST', `/dialogs/${encodeURIComponent(dialogId)}/lead`, {
      visitor_key: visitorKey, ...payload,
    });
  }
}
