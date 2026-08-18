<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace, NText } from 'naive-ui';
import { useSessionStore } from '../stores/session.ts';
import { PanelApiError } from '../lib/api.ts';

const PASSWORD_MIN = 10;

const session = useSessionStore();
const router = useRouter();

const email = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

/**
 * Локальная проверка — ТОЛЬКО подсказка. Источник истины — бэкенд
 * (`passwordPolicyError`), и его ответ показывается как есть: расходиться
 * двум проверкам нельзя, а дублировать регистр правил на клиенте незачем.
 */
const passwordHint = computed(() => {
  if (password.value === '') return '';
  if (password.value.length < PASSWORD_MIN) return `Ещё ${PASSWORD_MIN - password.value.length} символов.`;
  if (/^\d+$/.test(password.value)) return 'Только цифры — слишком просто.';
  return '';
});

const canSubmit = computed(() => email.value.trim() !== '' && password.value !== '' && !busy.value);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  error.value = '';
  busy.value = true;
  try {
    await session.register(email.value.trim(), password.value);
    await router.replace('/');
  } catch (err) {
    error.value = err instanceof PanelApiError ? err.message : 'Не удалось зарегистрироваться. Попробуйте ещё раз.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="auth-screen">
    <n-card title="Регистрация" class="auth-card">
      <n-form @submit.prevent="submit">
        <n-form-item label="Почта">
          <n-input v-model:value="email" type="text" placeholder="owner@example.com" autocomplete="username" />
        </n-form-item>
        <n-form-item :label="`Пароль (от ${PASSWORD_MIN} символов)`">
          <n-input
            v-model:value="password"
            type="password"
            show-password-on="click"
            placeholder="Пароль"
            autocomplete="new-password"
            @keyup.enter="submit"
          />
        </n-form-item>
        <n-text v-if="passwordHint" depth="3">{{ passwordHint }}</n-text>

        <!-- Почту НЕ подтверждаем и восстановление пароля НЕ обещаем (D-4):
             почтового канала у витрины нет. Честно предупреждаем об этом. -->
        <n-alert type="info" :bordered="false" class="auth-note">
          Пароль восстановить нельзя — сохраните его. Почта нужна только для входа.
        </n-alert>

        <n-alert v-if="error" type="error" :bordered="false" class="auth-error">{{ error }}</n-alert>

        <n-space vertical size="large">
          <n-button type="primary" block :disabled="!canSubmit" :loading="busy" @click="submit">
            Создать аккаунт
          </n-button>
          <router-link to="/login">Уже есть аккаунт? Войти</router-link>
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
.auth-note { margin: 12px 0; }
.auth-error { margin-bottom: 16px; }
</style>
