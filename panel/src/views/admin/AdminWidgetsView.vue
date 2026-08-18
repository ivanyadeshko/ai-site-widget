<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { NAlert, NButton, NDataTable, NEmpty, NSpace, NTag, NText, type DataTableColumns } from 'naive-ui';
import { PanelApi, PanelApiError } from '../../lib/api.ts';

/**
 * Все виджеты витрины, с владельцем. Экран, на который приходит поддержка с
 * токеном в руках: «клиент прислал wgt_…, чей это виджет и почему молчит».
 */
type AdminWidget = {
  id: string;
  name: string;
  publish_token: string;
  enabled: boolean;
  created_at: string;
  account_id: string | null;
  owner_email: string | null;
  owner_blocked: boolean;
  dialogs_total: number;
};

const widgets = ref<AdminWidget[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const error = ref('');

async function load(append = false): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (append && nextCursor.value !== null) params.set('cursor', nextCursor.value);
    const query = params.toString();
    const page = await PanelApi.get<{ widgets: AdminWidget[]; next_cursor: string | null }>(
      `/admin/widgets${query === '' ? '' : `?${query}`}`,
    );
    widgets.value = append ? [...widgets.value, ...page.widgets] : page.widgets;
    nextCursor.value = page.next_cursor;
  } catch (err) {
    error.value = err instanceof PanelApiError ? err.message : 'Не удалось загрузить виджеты.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const columns = computed<DataTableColumns<AdminWidget>>(() => [
  { title: 'Виджет', key: 'name' },
  {
    title: 'Владелец',
    key: 'owner_email',
    /*
     * Бесхозный виджет (`account_id IS NULL`, наследие релиза 1) подписывается
     * прямым текстом, а не прочерком: у него нет ни лимитов, ни адресата
     * жалобы, и оператор обязан видеть это как ОСОБЕННОСТЬ, а не как пустую
     * ячейку. Колонка исчезнет вместе с NOT NULL вторым релизом.
     */
    render: (row) => (row.owner_email === null
      ? h(NText, { depth: 3 }, { default: () => 'без владельца' })
      : row.owner_email),
  },
  // Токен не секрет — он лежит в HTML клиентского сайта; поддержке он нужен,
  // чтобы связать жалобу с строкой в БД.
  { title: 'Токен', key: 'publish_token' },
  {
    title: 'Статус',
    key: 'enabled',
    render: (row) => {
      if (row.owner_blocked) {
        return h(NTag, { type: 'error' }, { default: () => 'Владелец заблокирован' });
      }
      return h(
        NTag,
        { type: row.enabled ? 'success' : 'default' },
        { default: () => (row.enabled ? 'Включён' : 'Выключен') },
      );
    },
  },
  { title: 'Диалогов всего', key: 'dialogs_total' },
  {
    title: 'Создан',
    key: 'created_at',
    render: (row) => new Date(row.created_at).toLocaleDateString('ru-RU'),
  },
]);
</script>

<template>
  <n-space vertical size="large">
    <n-text strong style="font-size: 20px">Виджеты витрины</n-text>

    <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>

    <n-empty v-if="widgets.length === 0 && !loading" description="Виджетов пока нет" />

    <n-data-table
      v-else-if="widgets.length > 0"
      :columns="columns"
      :data="widgets"
      :row-key="(row: AdminWidget) => row.id"
    />

    <n-button v-if="nextCursor !== null" data-test="load-more" :disabled="loading" @click="load(true)">
      Показать ещё
    </n-button>
  </n-space>
</template>
