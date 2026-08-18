<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NAlert, NButton, NEmpty, NSpace, NSpin, NTag, NText } from 'naive-ui';
import { PanelApi, PanelApiError } from '../lib/api.ts';

/** Реплика ленты. Зеркало ответа `GET /api/v1/dialogs/:id/messages`. */
export type ThreadMessage = {
  id: string;
  role: 'user' | 'agent';
  text: string;
  /** `core` — реплика подтверждена ядром; `client` — прислана страницей посетителя. */
  source: 'client' | 'core';
  seq: number;
  created_at: string;
};

const props = defineProps<{ dialogId: string }>();
const emit = defineEmits<{ (event: 'status', status: string): void }>();

const PAGE = 100;

const messages = ref<ThreadMessage[]>([]);
const nextAfterId = ref<string | null>(null);
const loading = ref(false);
const error = ref('');

/**
 * Лента читается С НАЧАЛА и листается ВПЕРЁД (`after_id`) — так же, как её
 * отдаёт бэкенд. Автоподгрузки по скроллу нет намеренно: владелец читает чужой
 * разговор глазами, и страница, уезжающая под курсором, мешает.
 */
async function load(append = false): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (append && nextAfterId.value !== null) params.set('after_id', nextAfterId.value);
    const page = await PanelApi.get<{
      dialog_id: string; status: string; messages: ThreadMessage[]; next_after_id: string | null;
    }>(`/dialogs/${props.dialogId}/messages?${params.toString()}`);
    messages.value = append ? [...messages.value, ...page.messages] : page.messages;
    nextAfterId.value = page.next_after_id;
    emit('status', page.status);
  } catch (err) {
    error.value = err instanceof PanelApiError ? err.message : 'Не удалось загрузить переписку.';
  } finally {
    loading.value = false;
  }
}

onMounted(() => load());

const time = (iso: string): string => new Date(iso).toLocaleString('ru-RU');
</script>

<template>
  <n-space vertical size="large">
    <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>

    <n-empty
      v-if="messages.length === 0 && !loading && !error"
      description="В этом диалоге ещё нет реплик"
    />

    <n-space v-for="message in messages" :key="message.id" vertical size="small" :data-test="`message-${message.id}`">
      <n-space align="center" size="small">
        <!-- Роль различима и текстом, и цветом: только цвет не читается
             скринридером и теряется в чёрно-белой печати. -->
        <n-tag :type="message.role === 'user' ? 'info' : 'success'" size="small">
          {{ message.role === 'user' ? 'Посетитель' : 'Аватар' }}
        </n-tag>
        <n-text depth="3" style="font-size: 12px">{{ time(message.created_at) }}</n-text>
        <!-- Клиентская реплика приехала со страницы посетителя и ядром не
             подтверждена: в пределе её мог прислать кто угодно, кто открыл
             виджет. Владелец обязан видеть эту разницу. -->
        <n-tag v-if="message.source === 'client'" type="warning" size="small" data-test="unconfirmed">
          не подтверждено ядром
        </n-tag>
      </n-space>
      <n-text>{{ message.text }}</n-text>
    </n-space>

    <n-spin v-if="loading" size="small" />

    <n-button v-if="nextAfterId !== null" data-test="load-more" :disabled="loading" @click="load(true)">
      Показать ещё
    </n-button>
  </n-space>
</template>
