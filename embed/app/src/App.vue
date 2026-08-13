<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import ChatFeed from './components/ChatFeed.vue';
import Composer from './components/Composer.vue';
import StateBanner from './components/StateBanner.vue';
import { WidgetApi, type ParticipantToken, type ReenterResult, type StartDialogResult } from './lib/api.ts';
import { createBridge } from './lib/bridge.ts';
import { createEchoGuard } from './lib/echoGuard.ts';
import { createResender } from './lib/resender.ts';
import { CoreRoom } from './lib/room.ts';
import type { WorkerFrame } from './lib/frames.ts';

// source: 'client' — реплика отрисована ОПТИМИСТИЧНО самим iframe (наш ввод);
// 'core' — пришла транскриптом от ядра/воркера (подтверждена). Показываем в
// пузыре, иначе подделанную реплику аватара из журнала не отличить (ревью T3).
type Bubble = { id: string; role: 'user' | 'agent'; text: string; source: 'client' | 'core' };

// Заготовка FSM: chat → paused (session_ended) сегодня; escalating/voice достроит
// T7 поверх этого же ref, не переписывая ветвление chat.
type Phase = 'chat' | 'paused' | 'escalating';

const token = (document.getElementById('app')!.dataset.widgetToken ?? '');
const api = new WidgetApi(token);
const bubbles = ref<Bubble[]>([]);
const typing = ref(false);
const phase = ref<Phase>('chat');
const pausedReason = ref('');
const visitorKey = ref<string | null>(null);
const dialogId = ref<string | null>(null);
const seq = ref(1);                       // следующий номер журнала
const userTextsSent = ref(0);             // для messages_count эскалации (T7)
const agentReplies = ref(0);
const coreMessageCount = computed(() => userTextsSent.value + agentReplies.value);

const echo = createEchoGuard({ windowMs: 30_000, now: () => Date.now() });
let readyResender: ReturnType<typeof createResender> | null = null;

// ДЕВИАЦИЯ от буквы брифа: бриф давал `onAgentJoined: () => readyResender?.start()`,
// но `createResender.start()` идемпотентен (`if (timer !== null) return`) — уже
// запущенный ресендер на повторный start() не шлёт НИЧЕГО, и «поздний вход
// агента» не давал бы немедленного пере-client_ready (тест это ловит). Правильный
// приём — пере-СОЗДАТЬ ресендер: он шлёт фрейм сразу и заново тикает. Тот же
// хелпер зовём и из connect, и из onAgentJoined.
function startReadySender(): void {
  readyResender?.stop();
  readyResender = createResender(() => room.publish({ type: 'client_ready' }), { intervalMs: 3000, maxAttempts: 20 });
  readyResender.start();
}

const room = new CoreRoom({
  onFrame: handleFrame,
  onAgentJoined: () => startReadySender(), // агент вошёл (в т.ч. позже нас)
  onDisconnected: () => { /* фазу считает FSM из T7 */ },
});

const bridge = createBridge({
  allowedOrigins: [],                     // заполнится из /config в onMounted
  onInit: ({ visitorKey: key, dialogId: saved }) => void openThread(key, saved),
  onVisibility: () => undefined,
});

function push(role: 'user' | 'agent', text: string, source: 'client' | 'core'): void {
  // Стабильный id, а не индекс: по индексу Vue переиспользует узлы и ломает
  // анимацию/выделение при вставке в середину.
  bubbles.value.push({ id: crypto.randomUUID(), role, text, source });
}

function handleFrame(frame: WorkerFrame): void {
  readyResender?.bump();
  if (frame.type === 'session_ended') {
    // Ядро закрыло сессию (silence и т.п.): нить у клиента цела — предлагаем
    // продолжить. Центральный сценарий §. Голос/эскалацию достроит T7.
    typing.value = false;
    pausedReason.value = typeof frame.reason === 'string' ? frame.reason : '';
    phase.value = 'paused';
    return;
  }
  if (frame.type !== 'transcript') return;
  // WorkerFrame — открытый union с catch-all {type:string;[k]:unknown}, поэтому
  // проверки type мало: сужаем к самому transcript-члену, иначе frame.text — unknown.
  const t = frame as Extract<WorkerFrame, { type: 'transcript' }>;
  if (t.speaker === 'respondent') {
    // Своё эхо гасим; чужой respondent-transcript (STT в голосе) — рисуем.
    // Он от ядра (data-channel), значит source=core.
    if (echo.isEcho(t.text)) return;
    push('user', t.text, 'core');
    return;
  }
  typing.value = false;
  push('agent', t.text, 'core');
  if (userTextsSent.value > 0) agentReplies.value += 1; // greeting не в счёт
  void api.journal(dialogId.value!, visitorKey.value!, 'agent', t.text, seq.value++);
}

async function openThread(key: string, saved: string | null): Promise<void> {
  visitorKey.value = key;
  const started: StartDialogResult | ReenterResult = saved
    ? await api.reenter(saved, key).catch(() => api.startDialog(key, saved))
    : await api.startDialog(key);
  applyStart(started);
}

function applyStart(started: {
  dialog_id: string; participant_token: ParticipantToken;
  messages: { role: 'user' | 'agent'; text: string; source?: 'client' | 'core' }[]; next_seq: number;
}): void {
  dialogId.value = started.dialog_id;
  // Нумерацию журнала продолжаем с серверной: свой счётчик после reload
  // обнулился бы, и новые реплики глотал бы дедуп по (dialog, source, seq).
  seq.value = started.next_seq;
  // Историю рендерим с ЕЁ источником: реплика аватара, лежащая в журнале как
  // client (записал сам клиент), помечается неподтверждённой (ревью T3).
  bubbles.value = started.messages.map((m) => ({
    id: crypto.randomUUID(), role: m.role, text: m.text, source: m.source ?? 'core',
  }));
  // Счётчик ленты ядра принадлежит СЕССИИ, а не нити: новая сессия начинает
  // с нуля, иначе messages_count эскалации попросит несуществующие реплики.
  userTextsSent.value = 0;
  agentReplies.value = 0;
  phase.value = 'chat';
  bridge.sendState(visitorKey.value!, dialogId.value);
  void connect(started.participant_token, { audio: false });
}

async function connect(pt: ParticipantToken, opts: { audio: boolean }): Promise<void> {
  await room.connect(pt.livekit_url ?? '', pt.token, opts);
  startReadySender();
}

async function send(text: string): Promise<void> {
  const clean = text.trim().slice(0, 2000); // воркер режет ровно тут
  if (!clean) return;
  push('user', clean, 'client'); // своя реплика — оптимистичный рендер
  echo.remember(clean);
  room.publish({ type: 'user_text', text: clean });
  userTextsSent.value += 1;
  typing.value = true;
  await api.journal(dialogId.value!, visitorKey.value!, 'user', clean, seq.value++);
}

async function resume(): Promise<void> {
  // «Продолжить» после паузы: рвём прежнюю комнату и переоткрываем нить С
  // dialog_id — на бэкенде это путь continue_from (лента предшественника
  // засевается в новую сессию, история у клиента уже на экране).
  if (!visitorKey.value || !dialogId.value) return;
  await room.disconnect();
  const started = await api.startDialog(visitorKey.value, dialogId.value);
  applyStart(started);
}

const leave = (): void => { void room.disconnect(); };

onMounted(async () => {
  const config = await api.config();
  bridge.setAllowedOrigins(config.allowed_origins);
  bridge.listen();
  bridge.ready();
  // pagehide надёжнее beforeunload на мобильных: iOS часто не шлёт второй.
  window.addEventListener('pagehide', leave);
});
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', leave);
  readyResender?.stop(); // гигиена таймера: не оставляем висящий interval после размонтирования
});

// coreMessageCount уедет в escalate(...) из T7; держим вычисляемым уже сейчас.
void coreMessageCount;
</script>

<template>
  <div class="widget">
    <ChatFeed :bubbles="bubbles" :typing="typing" />
    <StateBanner v-if="phase === 'paused'" :reason="pausedReason" @continue="resume" />
    <Composer :disabled="phase !== 'chat'" @send="send" />
  </div>
</template>

<style scoped>
.widget {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 100vh;
  background: #fff;
}
</style>
