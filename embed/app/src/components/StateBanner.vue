<script setup lang="ts">
// Показывается, когда ядро прислало session_ended (напр. reason=silence): нить
// цела, посетителю предлагаем продолжить (POST /dialogs с dialog_id →
// continue_from ядра). Голосовая ветка/эскалация — T7.
defineProps<{ reason: string }>();
const emit = defineEmits<{ continue: [] }>();
</script>

<template>
  <div class="banner" data-test="state-banner" role="status">
    <p class="banner__text">Диалог приостановлен</p>
    <button type="button" class="banner__btn" data-test="continue" @click="emit('continue')">
      Продолжить
    </button>
  </div>
</template>

<style scoped>
.banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  background: #fff8e1;
  border-top: 1px solid #ffe082;
}
.banner__text {
  margin: 0;
  font: 14px/1.4 system-ui, sans-serif;
  color: #6b5900;
}
.banner__btn {
  flex: 0 0 auto;
  padding: 8px 14px;
  border: none;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  font: 600 14px/1 system-ui, sans-serif;
  cursor: pointer;
}
</style>
