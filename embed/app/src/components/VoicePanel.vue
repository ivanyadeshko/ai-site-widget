<script setup lang="ts">
// Аудио-only панель голосового режима. Видео аватара клиент отписывает (см.
// room.ts/App), UI — только звук + управление своим микрофоном. Разговор
// односторонний, пока не опубликован микрофон: connect его НЕ включает.
defineProps<{ micState: 'off' | 'requesting' | 'on' | 'denied' | 'failed' }>();
const emit = defineEmits<{ toggleMic: [] }>();
</script>

<template>
  <div class="voice" data-test="voice-panel" role="group" aria-label="Голосовой разговор">
    <p v-if="micState === 'denied'" class="voice__warn" data-test="mic-warn">
      Микрофон недоступен: разрешите доступ в настройках браузера
    </p>
    <p v-else-if="micState === 'failed'" class="voice__warn" data-test="mic-warn">
      Микрофон не включился — проверьте устройство
    </p>
    <p v-else class="voice__hint">Идёт голосовой разговор — говорите, аватар слышит вас.</p>

    <button type="button" class="voice__mic" data-test="mic-toggle" @click="emit('toggleMic')">
      {{ micState === 'on' ? 'Выключить микрофон' : 'Включить микрофон' }}
    </button>
  </div>
</template>

<style scoped>
.voice {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: #eef4ff;
  border-top: 1px solid #cddafc;
}
.voice__warn {
  margin: 0;
  font: 14px/1.4 system-ui, sans-serif;
  color: #b00020;
}
.voice__hint {
  margin: 0;
  font: 14px/1.4 system-ui, sans-serif;
  color: #33466b;
}
.voice__mic {
  align-self: flex-start;
  padding: 8px 14px;
  border: none;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  font: 600 14px/1 system-ui, sans-serif;
  cursor: pointer;
}
</style>
