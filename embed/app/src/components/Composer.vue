<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ send: [text: string] }>();

const text = ref('');

function submit(): void {
  if (props.disabled) return;
  const value = text.value.trim();
  if (!value) return;
  emit('send', value);
  text.value = '';
}

function onKeydown(event: KeyboardEvent): void {
  // Enter отправляет, Shift+Enter — перенос строки. event.isComposing гасит
  // отправку: IME набирает иероглифы/кандзи тем же Enter'ом.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="composer">
    <textarea
      v-model="text"
      class="composer__input"
      maxlength="2000"
      rows="1"
      :disabled="disabled"
      placeholder="Напишите сообщение…"
      data-test="input"
      @keydown="onKeydown"
    ></textarea>
    <button
      type="button"
      class="composer__send"
      data-test="send"
      :disabled="disabled || text.trim() === ''"
      @click="submit"
    >
      Отправить
    </button>
  </div>
</template>

<style scoped>
.composer {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid #e9ecef;
}
.composer__input {
  flex: 1 1 auto;
  resize: none;
  max-height: 120px;
  padding: 8px 10px;
  border: 1px solid #ced4da;
  border-radius: 10px;
  font: 15px/1.4 system-ui, sans-serif;
}
.composer__send {
  flex: 0 0 auto;
  padding: 0 14px;
  border: none;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  font: 600 14px/1 system-ui, sans-serif;
  cursor: pointer;
}
.composer__send:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
