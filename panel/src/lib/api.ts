/** Событие «сервер больше не признаёт нашу сессию» — стор сессии его слушает. */
export const UNAUTHENTICATED_EVENT = 'panel:unauthenticated';

/** Ошибка панельного API с машинным кодом из тела `{error:{code,message}}`. */
export class PanelApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PanelApiError';
    this.status = status;
    this.code = code;
  }
}

const API_BASE = '/api/v1';

type ErrorBody = { error?: { code?: unknown; message?: unknown } };

export class PanelApi {
  static async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const hasBody = body !== undefined;
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      // Кука сессии host-only и SameSite=Lax; панель и API — один origin (D-5).
      credentials: 'same-origin',
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return undefined as T;

    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok) {
      // 401 на ЛЮБОМ вызове = сессия отозвана (админом, логаутом на другом
      // устройстве, истечением). Стор обязан узнать об этом один раз и
      // централизованно, а не каждый вызывающий по отдельности.
      if (res.status === 401) {
        window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
      }
      const error = (payload as ErrorBody | null)?.error;
      throw new PanelApiError(
        res.status,
        typeof error?.code === 'string' ? error.code : 'request_failed',
        typeof error?.message === 'string' ? error.message : 'Не удалось выполнить запрос.',
      );
    }

    return payload as T;
  }

  static get<T>(path: string): Promise<T> { return PanelApi.request<T>('GET', path); }
  static post<T>(path: string, body?: unknown): Promise<T> { return PanelApi.request<T>('POST', path, body); }
  static patch<T>(path: string, body?: unknown): Promise<T> { return PanelApi.request<T>('PATCH', path, body); }
  /** PUT — замена значения целиком (лимиты аккаунта в админке), в отличие от частичного PATCH. */
  static put<T>(path: string, body?: unknown): Promise<T> { return PanelApi.request<T>('PUT', path, body); }
  static delete<T>(path: string): Promise<T> { return PanelApi.request<T>('DELETE', path); }
}
