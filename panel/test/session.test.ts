import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { PanelApi, PanelApiError } from '../src/lib/api.ts';
import { useSessionStore } from '../src/stores/session.ts';

type StubResponse = { status: number; body?: unknown };

const respond = (...queue: StubResponse[]): ReturnType<typeof vi.fn> => {
  const stub = vi.fn(async () => {
    const next = queue.shift() ?? { status: 500, body: { error: { code: 'internal', message: 'нет ответа' } } };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
};

const ACCOUNT = { id: 'acc-1', email: 'owner@example.com', is_admin: false };

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('стор сессии панели', () => {
  it('успешный вход кладёт аккаунт в стор и НЕ хранит пароль', async () => {
    const fetchStub = respond({ status: 200, body: { account: ACCOUNT } });
    const session = useSessionStore();

    await session.login('owner@example.com', 'пароль-владельца');

    expect(session.account).toEqual(ACCOUNT);
    // Пароль живёт ровно один вызов: в сторе его быть не должно ни в каком поле.
    expect(JSON.stringify(session.$state)).not.toContain('пароль-владельца');
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('same-origin');
  });

  it('неверные данные: код invalid_credentials, аккаунт остаётся пустым', async () => {
    respond({ status: 401, body: { error: { code: 'invalid_credentials', message: 'Неверная почта или пароль.' } } });
    const session = useSessionStore();

    await expect(session.login('owner@example.com', 'мимо')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(session.account).toBeNull();
  });

  it('блокировка после перебора: «попробуйте позже» и НИ СЛОВА про восстановление пароля', async () => {
    // Восстановления пароля у витрины нет (D-4): предлагать его — врать
    // пользователю и загонять его в тупик.
    respond({ status: 429, body: { error: { code: 'login_locked', message: 'Слишком много неудачных попыток. Повторите позже.' } } });
    const session = useSessionStore();

    await expect(session.login('brute@example.com', 'мимо')).rejects.toSatisfy((err: unknown) => {
      const message = (err as PanelApiError).message;
      expect((err as PanelApiError).code).toBe('login_locked');
      expect(message).toContain('попробуйте позже');
      expect(message).not.toMatch(/восстанов|сброс|забыли/i);
      return true;
    });
  });

  it('load() при 401 — не ошибка, а «не авторизован»', async () => {
    respond({ status: 401, body: { error: { code: 'unauthenticated', message: 'Требуется вход.' } } });
    const session = useSessionStore();

    await expect(session.load()).resolves.toBeNull();
    expect(session.account).toBeNull();
    expect(session.loaded).toBe(true);
  });

  it('401 на ЛЮБОМ вызове API сбрасывает стор: сессию отозвали на другом устройстве', async () => {
    respond(
      { status: 200, body: { account: ACCOUNT } },
      { status: 401, body: { error: { code: 'unauthenticated', message: 'Требуется вход.' } } },
    );
    const session = useSessionStore();
    await session.login('owner@example.com', 'пароль-владельца');
    expect(session.account).not.toBeNull();

    await expect(PanelApi.get('/widgets')).rejects.toBeInstanceOf(PanelApiError);
    expect(session.account).toBeNull();
  });

  it('регистрация тоже открывает сессию', async () => {
    respond({ status: 201, body: { account: ACCOUNT } });
    const session = useSessionStore();
    await session.register('owner@example.com', 'пароль-владельца');
    expect(session.account).toEqual(ACCOUNT);
  });

  it('выход чистит стор даже если сервер ответил ошибкой', async () => {
    respond(
      { status: 200, body: { account: ACCOUNT } },
      { status: 500, body: { error: { code: 'internal', message: 'Внутренняя ошибка.' } } },
    );
    const session = useSessionStore();
    await session.login('owner@example.com', 'пароль-владельца');

    await session.logout();
    // Локальный выход обязан состояться: иначе экран кабинета «залипает» с
    // мёртвой сессией и человек не может даже уйти на логин.
    expect(session.account).toBeNull();
  });
});
