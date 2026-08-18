<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace } from 'naive-ui';
import { useSessionStore } from '../stores/session.ts';
import { PanelApiError } from '../lib/api.ts';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();

const email = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

const canSubmit = computed(() => email.value.trim() !== '' && password.value !== '' && !busy.value);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  error.value = '';
  busy.value = true;
  try {
    await session.login(email.value.trim(), password.value);
    const next = typeof route.query.next === 'string' ? route.query.next : '/';
    await router.replace(next);
  } catch (err) {
    error.value = err instanceof PanelApiError ? err.message : 'Не удалось войти. Попробуйте ещё раз.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="auth-screen">
    <n-card title="Вход в кабинет" class="auth-card">
      <n-form @submit.prevent="submit">
        <n-form-item label="Почта">
          <n-input v-model:value="email" type="text" placeholder="owner@example.com" autocomplete="username" />
        </n-form-item>
        <n-form-item label="Пароль">
          <n-input
            v-model:value="password"
            type="password"
            show-password-on="click"
            placeholder="Пароль"
            autocomplete="current-password"
            @keyup.enter="submit"
          />
        </n-form-item>

        <!-- Ссылки «забыли пароль?» здесь НЕТ намеренно: восстановления у
             витрины не существует (D-4), и предлагать его — тупик для человека. -->
        <n-alert v-if="error" type="error" :bordered="false" class="auth-error">{{ error }}</n-alert>

        <n-space vertical size="large">
          <n-button type="primary" block :disabled="!canSubmit" :loading="busy" @click="submit">Войти</n-button>
          <router-link to="/register">Нет аккаунта? Зарегистрироваться</router-link>
        </n-space>
      </n-form>
    </n-card>
  </div>
</template>

<style scoped>
.auth-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
}
.auth-card { max-width: 420px; width: 100%; }
.auth-error { margin-bottom: 16px; }
</style>
