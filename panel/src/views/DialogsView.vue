<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  NAlert, NButton, NDataTable, NEmpty, NSelect, NSpace, NTag, NText, type DataTableColumns,
} from 'naive-ui';
import { PanelApi, PanelApiError } from '../lib/api.ts';
import { useWidgetsStore } from '../stores/widgets.ts';

type Dialog = {
  id: string;
  widget_id: string;
  widget_name: string;
  status: 'active' | 'escalating' | 'ended' | 'error';
  channel: 'chat' | 'voice' | null;
  messages_count: number;
  has_lead: boolean;
  usage: Record<string, number>;
  credits_total: number;
  started_at: string;
  ended_at: string | null;
};

const STATUS_LABEL: Record<Dialog['status'], string> = {
  active: 'Идёт',
  escalating: 'Переход в голос',
  ended: 'Завершён',
  error: 'Ошибка',
};

const widgets = useWidgetsStore();

const dialogs = ref<Dialog[]>([]);
const nextCursor = ref<string | null>(null);
const widgetId = ref<string | null>(null);
const loading = ref(false);
const error = ref('');

const widgetOptions = computed(() => [
  { label: 'Все виджеты', value: '' },
  ...widgets.items.map((w) => ({ label: w.name, value: w.id })),
]);

async function load(append = false): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (widgetId.value) params.set('widget_id', widgetId.value);
    if (append && nextCursor.value !== null) params.set('cursor', nextCursor.value);
    const query = params.toString();
    const page = await PanelApi.get<{ dialogs: Dialog[]; next_cursor: string | null }>(
      `/dialogs${query === '' ? '' : `?${query}`}`,
    );
    dialogs.value = append ? [...dialogs.value, ...page.dialogs] : page.dialogs;
    nextCursor.value = page.next_cursor;
  } catch (err) {
    error.value = err instanceof PanelApiError ? err.message : 'Не удалось загрузить диалоги.';
  } finally {
    loading.value = false;
  }
}

async function applyFilter(value: string): Promise<void> {
  widgetId.value = value === '' ? null : value;
  nextCursor.value = null;
  await load();
}

onMounted(async () => {
  try {
    if (!widgets.loaded) await widgets.load();
  } catch { /* фильтр останется одним пунктом «Все виджеты» */ }
  await load();
});

const columns = computed<DataTableColumns<Dialog>>(() => [
  {
    title: 'Начало',
    key: 'started_at',
    render: (row) => h(
      RouterLink,
      { to: `/dialogs/${row.id}` },
      { default: () => new Date(row.started_at).toLocaleString('ru-RU') },
    ),
  },
  { title: 'Виджет', key: 'widget_name' },
  {
    title: 'Статус',
    key: 'status',
    render: (row) => h(
      NTag,
      { type: row.status === 'error' ? 'error' : row.status === 'ended' ? 'default' : 'success' },
      { default: () => STATUS_LABEL[row.status] },
    ),
  },
  { title: 'Реплик', key: 'messages_count' },
  { title: 'Лид', key: 'has_lead', render: (row) => (row.has_lead ? 'да' : '—') },
  // Кредиты списывает ядро; ноль у живого диалога — это «ещё не сведено», а не
  // «бесплатно», поэтому показываем как есть, без «0 ₽» и округлений.
  { title: 'Кредиты', key: 'credits_total' },
]);
</script>

<template>
  <n-space vertical size="large">
    <n-space justify="space-between" align="center">
      <n-text strong style="font-size: 20px">Диалоги</n-text>
      <div data-test="widget-filter" style="min-width: 220px">
        <n-select :value="widgetId ?? ''" :options="widgetOptions" @update:value="applyFilter" />
      </div>
    </n-space>

    <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>

    <n-empty v-if="dialogs.length === 0 && !loading" description="Диалогов пока нет">
      <template #extra>
        <n-text depth="3">
          Диалог появляется, когда посетитель сайта открывает виджет и пишет первое сообщение.
        </n-text>
      </template>
    </n-empty>

    <n-data-table
      v-else-if="dialogs.length > 0"
      :columns="columns"
      :data="dialogs"
      :row-key="(row: Dialog) => row.id"
    />

    <n-button v-if="nextCursor !== null" data-test="load-more" :disabled="loading" @click="load(true)">
      Показать ещё
    </n-button>
  </n-space>
</template>
