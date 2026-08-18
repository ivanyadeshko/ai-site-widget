<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  NAlert, NButton, NCard, NDataTable, NEmpty, NForm, NFormItem, NInput, NSpace, NTag, NText,
  type DataTableColumns,
} from 'naive-ui';
import OriginsEditor from '../components/OriginsEditor.vue';
import { useWidgetsStore, type Widget } from '../stores/widgets.ts';
import { PanelApiError } from '../lib/api.ts';

const store = useWidgetsStore();

const creating = ref(false);
const busy = ref(false);
const error = ref('');
const draft = ref({ name: '', instructions: '', origins: [] as string[] });

const canSave = computed(() => draft.value.name.trim() !== '' && draft.value.instructions.trim() !== '' && !busy.value);

onMounted(async () => {
  try {
    await store.load();
  } catch (err) {
    error.value = err instanceof PanelApiError ? err.message : 'Не удалось загрузить список виджетов.';
  }
});

function startCreate(): void {
  error.value = '';
  draft.value = { name: '', instructions: '', origins: [] };
  creating.value = true;
}

async function save(): Promise<void> {
  if (!canSave.value) return;
  error.value = '';
  busy.value = true;
  try {
    await store.create({
      name: draft.value.name.trim(),
      agent_config: { instructions: draft.value.instructions.trim() },
      allowed_origins: draft.value.origins,
    });
    creating.value = false;
  } catch (err) {
    // Кап, кривой origin, длинные инструкции — всё это осмысленные тексты с
    // бэкенда. Показываем их как есть: свой перевод разошёлся бы с правилами.
    error.value = err instanceof PanelApiError ? err.message : 'Не удалось создать виджет.';
  } finally {
    busy.value = false;
  }
}

const columns = computed<DataTableColumns<Widget>>(() => [
  {
    title: 'Название',
    key: 'name',
    render: (row) => h(RouterLink, { to: `/widgets/${row.id}` }, { default: () => row.name }),
  },
  {
    title: 'Статус',
    key: 'enabled',
    render: (row) => {
      // Пустой список сайтов важнее выключателя: виджет с ним закрыт везде
      // (originGuard.ts), и молчать об этом в списке нельзя.
      if (row.allowed_origins.length === 0) {
        return h(NTag, { type: 'warning' }, { default: () => 'Не работает: нет разрешённых сайтов' });
      }
      return row.enabled
        ? h(NTag, { type: 'success' }, { default: () => 'Включён' })
        : h(NTag, {}, { default: () => 'Выключен' });
    },
  },
  {
    title: 'Разрешённые сайты',
    key: 'allowed_origins',
    render: (row) => (row.allowed_origins.length === 0 ? '—' : row.allowed_origins.join(', ')),
  },
  {
    title: 'Создан',
    key: 'created_at',
    render: (row) => new Date(row.created_at).toLocaleDateString('ru-RU'),
  },
]);
</script>

<template>
  <n-space vertical size="large">
    <n-space justify="space-between" align="center">
      <n-text strong style="font-size: 20px">Виджеты</n-text>
      <n-button v-if="store.items.length > 0" type="primary" data-test="new-widget" @click="startCreate">
        Создать виджет
      </n-button>
    </n-space>

    <n-alert v-if="error && !creating" type="error" :bordered="false">{{ error }}</n-alert>

    <n-card v-if="creating" title="Новый виджет">
      <n-form @submit.prevent="save">
        <n-form-item label="Название">
          <div data-test="widget-name">
            <n-input v-model:value="draft.name" placeholder="Например: Консультант интернет-магазина" />
          </div>
        </n-form-item>
        <n-form-item label="Что агент должен делать">
          <div data-test="widget-instructions">
            <n-input
              v-model:value="draft.instructions"
              type="textarea"
              :autosize="{ minRows: 3 }"
              placeholder="Ты консультант интернет-магазина. Отвечай коротко, предлагай оставить контакт."
            />
          </div>
        </n-form-item>
        <n-form-item label="Сайты, на которых виджет разрешён">
          <origins-editor v-model="draft.origins" />
        </n-form-item>

        <n-alert v-if="error" type="error" :bordered="false" style="margin-bottom: 12px">{{ error }}</n-alert>

        <n-space>
          <n-button type="primary" data-test="save-widget" :disabled="!canSave" :loading="busy" @click="save">
            Сохранить
          </n-button>
          <n-button quaternary @click="creating = false">Отмена</n-button>
        </n-space>
      </n-form>
    </n-card>

    <n-empty v-if="store.items.length === 0 && !store.loading && !creating" description="Создайте первый виджет">
      <template #extra>
        <n-button type="primary" data-test="new-widget" @click="startCreate">Создать виджет</n-button>
      </template>
    </n-empty>

    <n-data-table
      v-else-if="store.items.length > 0"
      :columns="columns"
      :data="store.items"
      :row-key="(row: Widget) => row.id"
    />
  </n-space>
</template>
