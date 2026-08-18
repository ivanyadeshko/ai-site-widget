<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert, NDataTable, NEmpty, NRadioButton, NRadioGroup, NSelect, NSpace, NStatistic, NText,
  type DataTableColumns,
} from 'naive-ui';
import { PanelApi, PanelApiError } from '../lib/api.ts';

type Metrics = { dialogs: number; credits_total: number; usage: Record<string, number> };
type Bucket = Metrics & { day?: string; widget_id?: string; widget_name?: string };

const PERIOD_OPTIONS = [
  { label: 'Последние 7 дней', value: 7 },
  { label: 'Последние 30 дней', value: 30 },
  { label: 'Последние 90 дней', value: 90 },
  // Потолок бэкенда — 366 дней (panel/period.ts), больше и не предлагаем.
  { label: 'Последний год', value: 365 },
];

const days = ref(30);
const groupBy = ref<'day' | 'widget'>('day');
const buckets = ref<Bucket[]>([]);
const totals = ref<Metrics>({ dialogs: 0, credits_total: 0, usage: {} });
const loading = ref(false);
const error = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const to = new Date();
    const from = new Date(to.getTime() - days.value * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      from: from.toISOString(), to: to.toISOString(), group_by: groupBy.value,
    });
    const report = await PanelApi.get<{ buckets: Bucket[]; totals: Metrics }>(`/usage?${params.toString()}`);
    buckets.value = report.buckets;
    totals.value = report.totals;
  } catch (err) {
    error.value = err instanceof PanelApiError ? err.message : 'Не удалось загрузить расход.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/**
 * Колонки метров строятся ПО ДАННЫМ, а не по списку в коде: набор метров задаёт
 * ядро, и зашитый перечень тихо спрятал бы новый (тот же принцип, что в SQL
 * агрегата).
 */
const metricKeys = computed(() => {
  const keys = new Set<string>();
  for (const bucket of buckets.value) for (const key of Object.keys(bucket.usage)) keys.add(key);
  return [...keys].sort();
});

const columns = computed<DataTableColumns<Bucket>>(() => [
  groupBy.value === 'day'
    ? { title: 'День', key: 'day' }
    : { title: 'Виджет', key: 'widget_name' },
  { title: 'Диалогов', key: 'dialogs' },
  { title: 'Кредиты', key: 'credits_total' },
  ...metricKeys.value.map((key) => ({
    title: key,
    key,
    render: (row: Bucket) => row.usage[key] ?? 0,
  })),
]);
</script>

<template>
  <n-space vertical size="large">
    <n-space justify="space-between" align="center">
      <n-text strong style="font-size: 20px">Использование</n-text>
      <n-space align="center">
        <div data-test="period" style="min-width: 200px">
          <n-select
            :value="days"
            :options="PERIOD_OPTIONS"
            @update:value="(value: number) => { days = value; load(); }"
          />
        </div>
        <n-radio-group
          :value="groupBy"
          data-test="group-by"
          @update:value="(value: 'day' | 'widget') => { groupBy = value; load(); }"
        >
          <n-radio-button value="day">По дням</n-radio-button>
          <n-radio-button value="widget">По виджетам</n-radio-button>
        </n-radio-group>
      </n-space>
    </n-space>

    <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>

    <n-space size="large">
      <n-statistic label="Диалогов за период" :value="totals.dialogs" />
      <n-statistic label="Кредитов списано" :value="totals.credits_total" />
    </n-space>

    <n-empty v-if="buckets.length === 0 && !loading" description="За выбранный период расхода не было" />

    <n-data-table
      v-else-if="buckets.length > 0"
      :columns="columns"
      :data="buckets"
      :row-key="(row: Bucket) => row.day ?? row.widget_id ?? ''"
    />
  </n-space>
</template>
