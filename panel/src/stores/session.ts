import { defineStore } from 'pinia';
import { ref } from 'vue';
import { PanelApi, PanelApiError } from '../lib/api.ts';

export type Account = { id: string; email: string; is_admin: boolean };

export const useSessionStore = defineStore('session', () => {
  const account = ref<Account | null>(null);
  const loading = ref(false);
  /** Первая загрузка уже отработала: гард роутера не должен дёргать /me на каждый переход. */
  const loaded = ref(false);

  /**
   * Кто мы. 401 — НЕ ошибка: это штатный ответ «не авторизован», и
   * выбрасывать его наверх значило бы показывать красный тост каждому
   * анонимному гостю на экране логина.
   */
  async function load(): Promise<Account | null> {
    loading.value = true;
    try {
      const res = await PanelApi.get<{ account: Account }>('/auth/me');
      account.value = res.account;
    } catch (err) {
      if (err instanceof PanelApiError && err.status === 401) account.value = null;
      else throw err;
    } finally {
      loading.value = false;
      loaded.value = true;
    }
    return account.value;
  }

  function clear(): void {
    account.value = null;
  }

  return { account, loading, loaded, load, clear };
});
