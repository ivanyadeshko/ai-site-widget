<script setup lang="ts">
import { computed, ref } from 'vue';
import { NAlert, NButton, NInput, NSpace, NTag, NText } from 'naive-ui';

const props = defineProps<{ modelValue: string[] }>();
const emit = defineEmits<{ 'update:modelValue': [string[]] }>();

const draft = ref('');

/** Та же нормализация, что и на бэкенде: схема+хост, путь и хвостовой слэш срезаны. */
function normalize(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.host === '') return null;
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * Подсказка объясняет ПРИЧИНУ отказа до отправки формы. Бэкенд проверит то же
 * самое ещё раз (он источник истины) — но человек не должен узнавать про
 * маску и схему из красного тоста после сохранения.
 */
const problem = computed(() => {
  const value = draft.value.trim();
  if (value === '') return '';
  if (value.includes('*')) return 'Маска «*» не поддерживается: перечислите адреса сайтов целиком.';
  if (!/^https?:\/\//i.test(value)) return `Добавьте схему: https://${value.replace(/^\/+/, '')}`;
  const normalized = normalize(value);
  if (normalized === null) return 'Не похоже на адрес сайта. Пример: https://shop.example';
  if (props.modelValue.some((item) => item.toLowerCase() === normalized)) return 'Этот сайт уже в списке.';
  return '';
});

const canAdd = computed(() => draft.value.trim() !== '' && problem.value === '');

function add(): void {
  const normalized = canAdd.value ? normalize(draft.value) : null;
  if (normalized === null) return;
  emit('update:modelValue', [...props.modelValue, normalized]);
  draft.value = '';
}

function remove(origin: string): void {
  emit('update:modelValue', props.modelValue.filter((item) => item !== origin));
}
</script>

<template>
  <div>
    <n-space vertical size="small">
      <n-space>
        <n-input
          v-model:value="draft"
          placeholder="https://shop.example"
          style="min-width: 260px"
          @keyup.enter="add"
        />
        <n-button data-test="add-origin" :disabled="!canAdd" @click="add">Добавить сайт</n-button>
      </n-space>

      <n-text v-if="problem" type="warning">{{ problem }}</n-text>

      <n-space v-if="modelValue.length > 0">
        <n-tag v-for="origin in modelValue" :key="origin" closable @close="remove(origin)">{{ origin }}</n-tag>
      </n-space>

      <!-- Пустой список = deny (originGuard.ts, Constraint 12). Это не баг и не
           «разрешено всё» — панель ОБЪЯСНЯЕТ правило, а не чинит его. -->
      <n-alert v-else type="warning" :bordered="false">
        Список пуст — виджет не будет работать ни на одном сайте. Добавьте адрес,
        на котором стоит сниппет.
      </n-alert>
    </n-space>
  </div>
</template>
