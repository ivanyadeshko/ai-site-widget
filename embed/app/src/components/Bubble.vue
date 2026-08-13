<script setup lang="ts">
// Текст реплики влияем посетителем (и эхом его же слов через воркер), поэтому
// в шаблоне ТОЛЬКО интерполяция `{{ }}`. v-html здесь — открытая XSS.
//
// source ('client'|'core') — CARRY из ревью T3: реплика аватара, попавшая в
// журнал ОТ КЛИЕНТА (source=client), неотличима от подтверждённой ядром
// (source=core) без явной пометки — иначе подделанную реплику аватара не поймать.
defineProps<{ role: 'user' | 'agent'; text: string; source: 'client' | 'core' }>();
</script>

<template>
  <div
    class="bubble"
    :class="`bubble--${role}`"
    :data-test="role === 'user' ? 'bubble-user' : 'bubble-agent'"
    :data-source="source"
  >
    {{ text }}
    <span
      v-if="role === 'agent' && source !== 'core'"
      class="bubble__warn"
      data-test="unverified"
      title="Реплика не подтверждена ядром"
      aria-label="не подтверждено ядром"
    >⚠</span>
  </div>
</template>

<style scoped>
.bubble {
  max-width: 84%;
  padding: 8px 12px;
  border-radius: 14px;
  font: 15px/1.4 system-ui, sans-serif;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bubble--user {
  align-self: flex-end;
  background: #2563eb;
  color: #fff;
  border-bottom-right-radius: 4px;
}
.bubble--agent {
  align-self: flex-start;
  background: #f1f3f5;
  color: #111;
  border-bottom-left-radius: 4px;
}
.bubble__warn {
  margin-left: 6px;
  color: #b00020;
  font-size: 13px;
  cursor: help;
}
</style>
