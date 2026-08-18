<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { NCard, NSpace, NTag, NText } from 'naive-ui';
import ThreadFeed from '../components/ThreadFeed.vue';

const route = useRoute();
const dialogId = String(route.params.id ?? '');

const STATUS_LABEL: Record<string, string> = {
  active: 'Идёт',
  escalating: 'Переход в голос',
  ended: 'Завершён',
  error: 'Ошибка',
};

// Статус приезжает вместе с первой страницей ленты: отдельной ручки «диалог
// целиком» нет и заводить её ради одного поля незачем.
const status = ref('');
</script>

<template>
  <n-space vertical size="large">
    <n-space justify="space-between" align="center">
      <n-text strong style="font-size: 20px">Переписка</n-text>
      <router-link to="/dialogs">Ко всем диалогам</router-link>
    </n-space>

    <n-space align="center" size="small">
      <n-tag v-if="status !== ''" :type="status === 'error' ? 'error' : 'default'">
        {{ STATUS_LABEL[status] ?? status }}
      </n-tag>
      <n-text depth="3" style="font-size: 12px">{{ dialogId }}</n-text>
    </n-space>

    <n-card>
      <thread-feed :dialog-id="dialogId" @status="(value: string) => (status = value)" />
    </n-card>
  </n-space>
</template>
