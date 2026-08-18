<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert, NButton, NDataTable, NEmpty, NInputNumber, NModal, NPopconfirm, NSpace, NTag, NText,
  type DataTableColumns,
} from 'naive-ui';
import { PanelApi, PanelApiError } from '../../lib/api.ts';

/**
 * Экран оператора витрины: кто у нас клиент, сколько он тратит и что с ним
 * можно сделать. Реальная защита — на сервере (`requireAdmin`, 404); гард
 * роутера и скрытый пункт меню это только UX.
 */
type AdminAccount = {
  id: string;
  email: string;
  is_admin: boolean;
  blocked_at: string | null;
  created_at: string;
  last_login_at: string | null;
  widgets_count: number;
  dialogs_30d: number;
};

type Limits = { max_sessions_per_day: number | null; effective_default: number };

const accounts = ref<AdminAccount[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
const notice = ref('');

const editing = ref<AdminAccount | null>(null);
const limits = ref<Limits | null>(null);
const limitValue = ref<number | null>(null);
const savingLimit = ref(false);

const humanDate = (iso: string): string => new Date(iso).toLocaleDateString('ru-RU');

const failure = (err: unknown, fallback: string): string =>
  (err instanceof PanelApiError ? err.message : fallback);

async function load(append = false): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (append && nextCursor.value !== null) params.set('cursor', nextCursor.value);
    const query = params.toString();
    const page = await PanelApi.get<{ accounts: AdminAccount[]; next_cursor: string | null }>(
      `/admin/accounts${query === '' ? '' : `?${query}`}`,
    );
    accounts.value = append ? [...accounts.value, ...page.accounts] : page.accounts;
    nextCursor.value = page.next_cursor;
  } catch (err) {
    error.value = failure(err, 'Не удалось загрузить аккаунты.');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/**
 * Строка обновляется ОТВЕТОМ СЕРВЕРА, а не догадкой клиента: только сервер
 * знает, что на самом деле записалось. Мержим, а не подменяем: ответ ручки
 * блокировки — это аккаунт без агрегатов, и подмена стёрла бы счётчики.
 */
function mergeRow(account: Partial<AdminAccount> & { id: string }): void {
  accounts.value = accounts.value.map((row) => (row.id === account.id ? { ...row, ...account } : row));
}

async function act(row: AdminAccount, action: 'block' | 'unblock' | 'unlock-login', done: string): Promise<void> {
  error.value = '';
  notice.value = '';
  try {
    const res = await PanelApi.post<{ account: AdminAccount }>(`/admin/accounts/${row.id}/${action}`);
    mergeRow(res.account);
    notice.value = `${row.email}: ${done}`;
  } catch (err) {
    error.value = failure(err, 'Не удалось выполнить действие.');
  }
}

async function openLimit(row: AdminAccount): Promise<void> {
  editing.value = row;
  limits.value = null;
  limitValue.value = null;
  error.value = '';
  try {
    const res = await PanelApi.get<{ limits: Limits }>(`/admin/accounts/${row.id}/limits`);
    limits.value = res.limits;
    // Своей строки нет — показываем действующий дефолт, а не пустое поле:
    // пустота выглядит как «лимита нет», хотя он есть.
    limitValue.value = res.limits.max_sessions_per_day ?? res.limits.effective_default;
  } catch (err) {
    error.value = failure(err, 'Не удалось прочитать лимит.');
    editing.value = null;
  }
}

async function saveLimit(): Promise<void> {
  const target = editing.value;
  if (target === null || limitValue.value === null) return;
  savingLimit.value = true;
  error.value = '';
  try {
    const res = await PanelApi.put<{ limits: Limits }>(
      `/admin/accounts/${target.id}/limits`, { max_sessions_per_day: limitValue.value },
    );
    notice.value = `${target.email}: суточный кап — ${res.limits.max_sessions_per_day}.`;
    editing.value = null;
  } catch (err) {
    error.value = failure(err, 'Не удалось сохранить лимит.');
  } finally {
    savingLimit.value = false;
  }
}

const columns = computed<DataTableColumns<AdminAccount>>(() => [
  {
    title: 'Почта',
    key: 'email',
    render: (row) => (row.is_admin
      ? h(NSpace, { align: 'center', size: 'small' }, {
        default: () => [row.email, h(NTag, { size: 'small', type: 'info' }, { default: () => 'админ' })],
      })
      : row.email),
  },
  { title: 'Создан', key: 'created_at', render: (row) => humanDate(row.created_at) },
  {
    title: 'Последний вход',
    key: 'last_login_at',
    // «ни разу» вместо пустой ячейки: пустоту читают как «данные не приехали».
    render: (row) => (row.last_login_at === null ? 'ни разу' : humanDate(row.last_login_at)),
  },
  { title: 'Виджетов', key: 'widgets_count' },
  { title: 'Диалогов за 30 дней', key: 'dialogs_30d' },
  {
    title: 'Статус',
    key: 'blocked_at',
    render: (row) => h(
      NTag,
      { type: row.blocked_at === null ? 'success' : 'error' },
      { default: () => (row.blocked_at === null ? 'Активен' : 'Заблокирован') },
    ),
  },
  {
    title: 'Действия',
    key: 'actions',
    render: (row) => h(NSpace, { size: 'small' }, {
      default: () => [
        // Подтверждение обязательно: блокировка гасит виджеты клиента на его
        // сайте и выкидывает его из панели немедленно.
        h(NPopconfirm, {
          onPositiveClick: () => act(
            row,
            row.blocked_at === null ? 'block' : 'unblock',
            row.blocked_at === null ? 'аккаунт заблокирован.' : 'аккаунт разблокирован.',
          ),
        }, {
          trigger: () => h(
            NButton,
            { size: 'small', type: row.blocked_at === null ? 'error' : 'primary', tertiary: true },
            { default: () => (row.blocked_at === null ? 'Заблокировать' : 'Разблокировать') },
          ),
          default: () => (row.blocked_at === null
            ? 'Виджеты клиента перестанут отвечать на его сайте, а сам он выйдет из панели немедленно. Продолжить?'
            : 'Клиент снова сможет войти, виджеты заработают. Ранее отозванные сессии не вернутся — вход заново.'),
        }),
        h(NButton, {
          size: 'small',
          tertiary: true,
          'data-test': 'unlock-login',
          // Восстановления пароля у витрины нет: это единственный способ
          // вернуть владельца, которого закрыл счётчик неудачных входов.
          title: 'Снять блокировку входа после серии неверных паролей',
          onClick: () => act(row, 'unlock-login', 'блокировка входа снята.'),
        }, { default: () => 'Снять login-lock' }),
        h(NButton, {
          size: 'small',
          tertiary: true,
          'data-test': 'edit-limit',
          onClick: () => openLimit(row),
        }, { default: () => 'Лимит' }),
      ],
    }),
  },
]);
</script>

<template>
  <n-space vertical size="large">
    <n-text strong style="font-size: 20px">Аккаунты витрины</n-text>

    <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>
    <n-alert v-if="notice" type="success" :bordered="false">{{ notice }}</n-alert>

    <n-empty v-if="accounts.length === 0 && !loading" description="Аккаунтов пока нет" />

    <n-data-table
      v-else-if="accounts.length > 0"
      :columns="columns"
      :data="accounts"
      :row-key="(row: AdminAccount) => row.id"
    />

    <n-button v-if="nextCursor !== null" data-test="load-more" :disabled="loading" @click="load(true)">
      Показать ещё
    </n-button>

    <n-modal
      :show="editing !== null"
      preset="card"
      style="max-width: 480px"
      title="Суточный кап сессий"
      @update:show="(value: boolean) => { if (!value) editing = null; }"
    >
      <n-space vertical>
        <n-text depth="3">
          Сколько сессий ядра в сутки может открыть {{ editing?.email }}. Ноль гасит виджеты клиента,
          не блокируя аккаунт. Значение действует немедленно.
        </n-text>
        <n-input-number
          :value="limitValue"
          :min="0"
          :max="100000"
          data-test="limit-input"
          @update:value="(value: number | null) => { limitValue = value; }"
        />
        <n-text v-if="limits && limits.max_sessions_per_day === null" depth="3">
          Своей строки лимитов нет — сейчас действует общий дефолт стенда: {{ limits.effective_default }}.
        </n-text>
        <n-space justify="end">
          <n-button tertiary @click="editing = null">Отмена</n-button>
          <n-button
            type="primary"
            data-test="save-limit"
            :loading="savingLimit"
            :disabled="limitValue === null"
            @click="saveLimit"
          >
            Сохранить
          </n-button>
        </n-space>
      </n-space>
    </n-modal>
  </n-space>
</template>
