<script setup lang="ts">
import Bubble from './Bubble.vue';

// :key — стабильный id пузыря, а не индекс: по индексу Vue переиспользует узлы
// и ломает вставку/выделение (урок reveal-движка монолита).
defineProps<{
  bubbles: { id: string; role: 'user' | 'agent'; text: string; source: 'client' | 'core' }[];
  typing: boolean;
}>();
</script>

<template>
  <div class="feed" data-test="feed">
    <Bubble v-for="b in bubbles" :key="b.id" :role="b.role" :text="b.text" :source="b.source" />
    <div v-if="typing" class="typing" data-test="typing" aria-live="polite">
      <span></span><span></span><span></span>
    </div>
  </div>
</template>

<style scoped>
.feed {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  overflow-y: auto;
}
.typing {
  align-self: flex-start;
  display: inline-flex;
  gap: 4px;
  padding: 10px 12px;
}
.typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #adb5bd;
  animation: blink 1.2s infinite both;
}
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}
</style>
