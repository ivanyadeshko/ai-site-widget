<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  NAlert, NButton, NDataTable, NEmpty, NSelect, NSpace, NText, type DataTableColumns,
} from 'naive-ui';
import { PanelApi, PanelApiError } from '../lib/api.ts';
import { useWidgetsStore } from '../stores/widgets.ts';

type Lead = {
  id: string;
  created_at: string;
  widget_id: string;
  widget_name: string;
  dialog_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  comment: string | null;
};

const widgets = useWidgetsStore();

const leads = ref<Lead[]>([]);
const nextCursor = ref<string | null>(null);
const widgetId = ref<string | null>(null);
const loading = ref(false);
const error = ref('');

const widgetOptions = computed(() => [
  { label: 'Все виджеты', value: '' },
  ...widgets.items.map((w) => ({ label: w.name, value: w.id })),
]);

const filterQuery = (): URLSearchParams => {
  const params = new URLSearchParams();
  if (widgetId.value) params.set('widget_id', widgetId.value);
  return params;
};

/**
 * Ссылка на выгрузку, а НЕ обработчик клика: файл скачивает браузер, и обычная
 * ссылка переживает и блокировщики, и «открыть в новой вкладке». Фильтр в
 * адресе тот же, что на экране, — иначе владелец выгрузит не то, что видит.
 */
const csvHref = computed(() => {
  const params = filterQuery();
  const query = params.toString();
  return `/api/v1/leads.csv${query === '' ? '' : `?${query}`}`;
});

async function load(append = false): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const params = filterQuery();
    if (append && nextCursor.value !== null) params.set('cursor', nextCursor.value);
    const query = params.toString();
    const page = await PanelApi.get<{ leads: Lead[]; next_cursor: string | null }>(
      `/leads${query === '' ? '' : `?${query}`}`,
    );
    leads.value = append ? [...leads.value, ...page.leads] : page.leads;
    nextCursor.value = page.next_cursor;
  } catch (err) {
    error.value = err instanceof PanelApiError ? err.message : 'Не удалось загрузить лиды.';
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
  // Список виджетов нужен только фильтру: его отказ не должен прятать лиды.
  try {
    if (!widgets.loaded) await widgets.load();
  } catch { /* фильтр останется одним пунктом «Все виджеты» */ }
  await load();
});

const columns = computed<DataTableColumns<Lead>>(() => [
  { title: 'Когда', key: 'created_at', render: (row) => new Date(row.created_at).toLocaleString('ru-RU') },
  { title: 'Виджет', key: 'widget_name' },
  { title: 'Имя', key: 'name', render: (row) => row.name ?? '—' },
  { title: 'Телефон', key: 'phone', render: (row) => row.phone ?? '—' },
  { title: 'Почта', key: 'email', render: (row) => row.email ?? '—' },
  { title: 'Комментарий', key: 'comment', render: (row) => row.comment ?? '—' },
  {
    title: 'Диалог',
    key: 'dialog_id',
    // Лид без разговора — половина картины: владельцу важно, ЧТО человек
    // спрашивал до того, как оставил контакт.
    render: (row) => h(RouterLink, { to: `/dialogs/${row.dialog_id}` }, { default: () => 'Переписка' }),
  },
]);
</script>

<template>
  <n-space vertical size="large">
    <n-space justify="space-between" align="center">
      <n-text strong style="font-size: 20px">Лиды</n-text>
      <n-space align="center">
        <div data-test="widget-filter" style="min-width: 220px">
          <n-select
            :value="widgetId ?? ''"
            :options="widgetOptions"
            @update:value="applyFilter"
          />
        </div>
        <n-button tag="a" :href="csvHref" data-test="export-csv" :disabled="leads.length === 0">
          Экспорт CSV
        </n-button>
      </n-space>
    </n-space>

    <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>

    <n-empty
      v-if="leads.length === 0 && !loading"
      description="Лидов пока нет"
    >
      <template #extra>
        <n-text depth="3">
          Лид появляется, когда посетитель заполняет форму контактов внутри диалога с аватаром.
        </n-text>
      </template>
    </n-empty>

    <n-data-table
      v-else-if="leads.length > 0"
      :columns="columns"
      :data="leads"
      :row-key="(row: Lead) => row.id"
    />

    <n-button v-if="nextCursor !== null" data-test="load-more" :disabled="loading" @click="load(true)">
      Показать ещё
    </n-button>
  </n-space>
</template>
