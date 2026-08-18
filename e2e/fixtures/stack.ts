import { test as base, expect, type APIRequestContext } from '@playwright/test';

/**
 * Фикстуры герметичного стека (Task 25) и приёмки (Task 26).
 *
 * `baseURL` приходит из конфига проекта (panel → localhost:8200 герметичного
 * стека; acceptance/voice → E2E_BASE_URL). `api` — тонкая обёртка над публичным
 * API `/w/v1/*` и служебной ручкой фейка ядра: сценарий дёргает их напрямую там,
 * где браузер не нужен (старт диалога, лид, закрытие, финализация).
 *
 * Служебная ручка `/__test__/finalize` есть ТОЛЬКО у fake-core (герметичный
 * стек Task 25). На живом ядре (acceptance) её нет — там деньги сводит вебхук
 * `session.finalized` асинхронно (см. acceptance.spec.ts).
 */

/** Порт фейка ядра, опубликованный compose.e2e.yaml. Только для проекта panel. */
export const FAKE_CORE_URL = process.env.E2E_FAKE_CORE_URL ?? 'http://localhost:8100';

export type LeadInput = { name?: string; phone?: string; email?: string; comment?: string; consent: boolean };

export class ApiHelper {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseURL: string,
  ) {}

  /** Origin легитимного посетителя = baseURL: тот же origin, что у демо-страницы. */
  private get origin(): string {
    return this.baseURL.replace(/\/+$/, '');
  }

  /** Старт диалога через публичный API. Возвращает dialog_id — из него собирается client_reference. */
  async startDialog(token: string, visitorKey: string): Promise<string> {
    const res = await this.request.post(`/w/v1/${token}/dialogs`, {
      headers: { origin: this.origin },
      data: { visitor_key: visitorKey },
    });
    expect(res.status(), `POST /dialogs -> ${res.status()}: ${await res.text()}`).toBe(201);
    return (await res.json()).dialog_id as string;
  }

  async submitLead(token: string, dialogId: string, visitorKey: string, lead: LeadInput): Promise<void> {
    const res = await this.request.post(`/w/v1/${token}/dialogs/${dialogId}/lead`, {
      headers: { origin: this.origin },
      data: { visitor_key: visitorKey, ...lead },
    });
    expect(res.status(), `POST /lead -> ${res.status()}: ${await res.text()}`).toBe(201);
  }

  async endDialog(token: string, dialogId: string, visitorKey: string): Promise<void> {
    const res = await this.request.post(`/w/v1/${token}/dialogs/${dialogId}/end`, {
      headers: { origin: this.origin },
      data: { visitor_key: visitorKey },
    });
    expect([200, 502, 503, 504], `POST /end -> ${res.status()}`).toContain(res.status());
  }

  /**
   * Служебная финализация через fake-core: доставляет BFF подписанный
   * session.finalized и ВОЗВРАЩАЕТ статус доставки. Ответ приходит ПОСЛЕ того,
   * как BFF ответил на вебхук — деньги в БД уже сведены, ретраев не нужно.
   * Только герметичный стек (panel).
   */
  async finalize(clientReference: string): Promise<{ bff_status: number; bff_body: string }> {
    const res = await this.request.post(`${FAKE_CORE_URL}/__test__/finalize`, {
      data: { client_reference: clientReference },
    });
    expect(res.ok(), `finalize -> ${res.status()}: ${await res.text()}`).toBeTruthy();
    return (await res.json()) as { bff_status: number; bff_body: string };
  }
}

export const test = base.extend<{ api: ApiHelper }>({
  api: async ({ request, baseURL }, use) => {
    await use(new ApiHelper(request, baseURL ?? 'http://localhost:8200'));
  },
});

export { expect };
