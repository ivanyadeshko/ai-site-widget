import { defineStore } from 'pinia';
import { ref } from 'vue';
import { PanelApi, PanelApiError, UNAUTHENTICATED_EVENT } from '../lib/api.ts';

export type Account = { id: string; email: string; is_admin: boolean };

/**
 * Восстановления пароля у витрины НЕТ (D-4: почтового канала не существует),
 * поэтому текст блокировки говорит ровно то, что человек может сделать, —
 * подождать. Ссылка «забыли пароль?» здесь была бы прямым враньём.
 */
const LOCKED_MESSAGE = 'Слишком много попыток входа — попробуйте позже.';

export const useSessionStore = defineStore('session', () => {
  const account = ref<Account | null>(null);
  const loading = ref(false);
  /** Первая загрузка уже отработала: гард роутера не дёргает /me на каждый переход. */
  const loaded = ref(false);

  function clear(): void {
    account.value = null;
  }

  // Сессию могли отозвать где угодно: админ заблокировал аккаунт, человек вышел
  // на другом устройстве, кука протухла. Узнаём об этом ОДИН раз и
  // централизованно — с любого вызова API, а не только с /auth/me.
  if (typeof window !== 'undefined') {
    window.addEventListener(UNAUTHENTICATED_EVENT, clear);
  }

  async function load(): Promise<Account | null> {
    loading.value = true;
    try {
      const res = await PanelApi.get<{ account: Account }>('/auth/me');
      account.value = res.account;
    } catch (err) {
      // 401 — НЕ ошибка, а штатный ответ «не авторизован»: красный тост на
      // экране логина показывать некому и не за что.
      if (err instanceof PanelApiError && err.status === 401) account.value = null;
      else throw err;
    } finally {
      loading.value = false;
      loaded.value = true;
    }
    return account.value;
  }

  /** Пароль живёт ровно один вызов и никуда не сохраняется. */
  async function authenticate(path: '/auth/login' | '/auth/register', email: string, password: string): Promise<Account> {
    loading.value = true;
    try {
      const res = await PanelApi.post<{ account: Account }>(path, { email, password });
      account.value = res.account;
      loaded.value = true;
      return res.account;
    } catch (err) {
      if (err instanceof PanelApiError && err.code === 'login_locked') {
        throw new PanelApiError(err.status, err.code, LOCKED_MESSAGE);
      }
      throw err;
    } finally {
      loading.value = false;
    }
  }

  const login = (email: string, password: string): Promise<Account> => authenticate('/auth/login', email, password);
  const register = (email: string, password: string): Promise<Account> => authenticate('/auth/register', email, password);

  async function logout(): Promise<void> {
    try {
      await PanelApi.post('/auth/logout');
    } catch {
      // Локальный выход обязан состояться при любом ответе сервера: иначе
      // кабинет залипает с мёртвой сессией и человек не может даже уйти.
    } finally {
      clear();
      loaded.value = true;
    }
  }

  return { account, loading, loaded, load, login, register, logout, clear };
});
