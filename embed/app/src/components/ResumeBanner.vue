<script setup lang="ts">
// Баннер FSM-фаз (bannerFor из fsm.ts): текст + опциональное действие.
//   action='resume'  → «Продолжить» (paused / chat_fallback) — новая сессия нити;
//   action='restart' → «Начать заново» (диалог устарел) — новый диалог;
//   action='none'    → только текст (escalating «Соединяю…», 402-лимит).
defineProps<{ text: string; action: 'resume' | 'restart' | 'none' }>();
const emit = defineEmits<{ resume: []; restart: [] }>();
</script>

<template>
  <div class="rbanner" data-test="resume-banner" role="status">
    <p class="rbanner__text">{{ text }}</p>
    <button
      v-if="action === 'resume'"
      type="button"
      class="rbanner__btn"
      data-test="resume"
      @click="emit('resume')"
    >
      Продолжить
    </button>
    <button
      v-else-if="action === 'restart'"
      type="button"
      class="rbanner__btn"
      data-test="restart"
      @click="emit('restart')"
    >
      Начать заново
    </button>
  </div>
</template>

<style scoped>
.rbanner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  background: #fff8e1;
  border-top: 1px solid #ffe082;
}
.rbanner__text {
  margin: 0;
  font: 14px/1.4 system-ui, sans-serif;
  color: #6b5900;
}
.rbanner__btn {
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
