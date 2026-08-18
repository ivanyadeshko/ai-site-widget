<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert, NCard, NDataTable, NEmpty, NSelect, NSpace, NStatistic, NText, type DataTableColumns,
} from 'naive-ui';
import { PanelApi, PanelApiError } from '../../lib/api.ts';

type Metrics = { dialogs: number; credits_total: number; usage: Record<string, number> };
type AccountBucket = Metrics & { account_id: string; account_email: string };
type CoreCredits = { balance: { balance: number; updated_at: string }; fetched_at: string };

const PERIOD_OPTIONS = [
  { label: 'Последние 7 дней', value: 7 },
  { label: 'Последние 30 дней', value: 30 },
  { label: 'Последние 90 дней', value: 90 },
  // Потолок бэкенда — 366 дней (panel/period.ts, тот же и для админки).
  { label: 'Последний год', value: 365 },
];

const days = ref(30);
const buckets = ref<AccountBucket[]>([]);
const totals = ref<Metrics>({ dialogs: 0, credits_total: 0, usage: {} });
const loading = ref(false);
const error = ref('');

const credits = ref<CoreCredits | null>(null);
const creditsError = ref('');

async function loadReport(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const to = new Date();
    const from = new Date(to.getTime() - days.value * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    const report = await PanelApi.get<{ buckets: AccountBucket[]; totals: Metrics }>(
      `/admin/usage?${params.toString()}`,
    );
    buckets.value = report.buckets;
    totals.value = report.totals;
  } catch (err) {
    error.value = err instanceof PanelApiError ? err.message : 'Не удалось загрузить расход.';
  } finally {
    loading.value = false;
  }
}

/**
 * Баланс ядра грузится ОТДЕЛЬНО и падает отдельно: это чужая система, и её
 * недоступность не должна гасить отчёт, который целиком лежит в нашей БД.
 */
async function loadCredits(): Promise<void> {
  creditsError.value = '';
  try {
    credits.value = await PanelApi.get<CoreCredits>('/admin/core/credits');
  } catch (err) {
    credits.value = null;
    creditsError.value = err instanceof PanelApiError ? err.message : 'Ядро не ответило.';
  }
}

onMounted(async () => { await Promise.all([loadReport(), loadCredits()]); });

/** Колонки метров строятся ПО ДАННЫМ: набор метров задаёт ядро и он растёт. */
const metricKeys = computed(() => {
  const keys = new Set<string>();
  for (const bucket of buckets.value) for (const key of Object.keys(bucket.usage)) keys.add(key);
  return [...keys].sort();
});

const columns = computed<DataTableColumns<AccountBucket>>(() => [
  { title: 'Аккаунт', key: 'account_email' },
  { title: 'Диалогов', key: 'dialogs' },
  { title: 'Кредиты', key: 'credits_total' },
  ...metricKeys.value.map((key) => ({
    title: key,
    key,
    render: (row: AccountBucket) => row.usage[key] ?? 0,
  })),
]);
</script>

<template>
  <n-space vertical size="large">
    <n-space justify="space-between" align="center">
      <n-text strong style="font-size: 20px">Расход витрины</n-text>
      <div data-test="period" style="min-width: 200px">
        <n-select
          :value="days"
          :options="PERIOD_OPTIONS"
          @update:value="(value: number) => { days = value; loadReport(); }"
        />
      </div>
    </n-space>

    <!--
      ПЛАШКА БАЛАНСА ЯДРА. Следствие D-1: для ядра весь виджет-продукт — ОДИН
      тенант, поэтому цифра общая на всех клиентов. Без явной подписи оператор
      прочитает её как баланс конкретного аккаунта и примет по ней денежное
      решение — поэтому текст здесь часть функциональности, а не украшение.
    -->
    <n-card size="small" title="Баланс кредитов ядра" data-test="core-credits">
      <n-space vertical size="small">
        <n-statistic v-if="credits" label="Кредитов на тенанте" :value="credits.balance.balance" />
        <n-alert v-if="creditsError" type="warning" :bordered="false">{{ creditsError }}</n-alert>
        <n-text depth="3">
          Это баланс общий на всю витрину, а не остаток конкретного клиента: для ядра
          виджет-продукт — один тенант. Персональный предел клиента задаётся суточным капом
          на экране «Аккаунты».
        </n-text>
        <n-text v-if="credits" depth="3">
          Обновлено: {{ new Date(credits.fetched_at).toLocaleString('ru-RU') }} (кэш 30 секунд).
        </n-text>
      </n-space>
    </n-card>

    <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>

    <n-space size="large">
      <n-statistic label="Диалогов за период" :value="totals.dialogs" />
      <n-statistic label="Кредитов списано" :value="totals.credits_total" />
    </n-space>

    <n-text depth="3">
      Итог считается по всем диалогам витрины, включая виджеты без владельца, — поэтому он
      может быть больше суммы строк ниже.
    </n-text>

    <n-empty v-if="buckets.length === 0 && !loading" description="За выбранный период расхода не было" />

    <n-data-table
      v-else-if="buckets.length > 0"
      :columns="columns"
      :data="buckets"
      :row-key="(row: AccountBucket) => row.account_id"
    />
  </n-space>
</template>
