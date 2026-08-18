<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import ChatFeed from './components/ChatFeed.vue';
import Composer from './components/Composer.vue';
import ResumeBanner from './components/ResumeBanner.vue';
import VoicePanel from './components/VoicePanel.vue';
import LeadForm from './components/LeadForm.vue';
import { WidgetApi, type ApiFailure, type ParticipantToken, type ReenterResult, type StartDialogResult } from './lib/api.ts';
import { createBridge, type BridgeTheme } from './lib/bridge.ts';
import { createEchoGuard } from './lib/echoGuard.ts';
import { createResender } from './lib/resender.ts';
import { CoreRoom, type CorePublication, type CoreTrack } from './lib/room.ts';
import { bannerFor, nextPhase, type DialogPhase } from './lib/fsm.ts';
import type { WorkerFrame } from './lib/frames.ts';

// source: 'client' — реплика отрисована ОПТИМИСТИЧНО самим iframe (наш ввод);
// 'core' — пришла транскриптом от ядра/воркера (подтверждена). Показываем в
// пузыре, иначе подделанную реплику аватара из журнала не отличить (ревью T3).
type Bubble = { id: string; role: 'user' | 'agent'; text: string; source: 'client' | 'core' };
type MicState = 'off' | 'requesting' | 'on' | 'denied' | 'failed';
type LeadFields = { name: string; phone: string; email: string; comment: string; consent: boolean };

const token = (document.getElementById('app')!.dataset.widgetToken ?? '');
const api = new WidgetApi(token);
const bubbles = ref<Bubble[]>([]);
const typing = ref(false);
const phase = ref<DialogPhase>('chat');
const visitorKey = ref<string | null>(null);
const dialogId = ref<string | null>(null);
const seq = ref(1);                       // следующий номер журнала
const userTextsSent = ref(0);             // для messages_count эскалации
const agentReplies = ref(0);
const coreMessageCount = computed(() => userTextsSent.value + agentReplies.value);

const micState = ref<MicState>('off');
// Засов на асинхронное «Продолжить»: двойной клик по баннеру иначе заводил бы
// ДВЕ сессии (два startDialog → две оплаченные continue_from).
const resuming = ref(false);
const lastErrorCode = ref<string | null>(null);
// Голосовая сессия всегда идёт continue_from — только для неё шлём resume_welcome.
const isContinuation = ref(false);
const leadOpen = ref(false);

// Баннер FSM-фаз: единый источник текста/действия для ResumeBanner.
const banner = computed(() => bannerFor(phase.value, lastErrorCode.value ?? undefined));

const echo = createEchoGuard({ windowMs: 30_000, now: () => Date.now() });
let readyResender: ReturnType<typeof createResender> | null = null;
let welcomeResender: ReturnType<typeof createResender> | null = null;
const voiceAudio: HTMLMediaElement[] = [];

// createResender.start() идемпотентен: уже запущенный на повторный start() молчит.
// Поэтому «поздний вход агента» требует ПЕРЕ-создания — шлём client_ready сразу
// и заново тикаем. Тот же хелпер зовём из connect и из onAgentJoined.
function startReadySender(): void {
  readyResender?.stop();
  readyResender = createResender(() => room.publish({ type: 'client_ready' }), { intervalMs: 3000, maxAttempts: 20 });
  readyResender.start();
}

// Агент вошёл (в т.ч. позже нас). client_ready — на любой вход. resume_welcome
// повторяет ТОЛЬКО отсюда и только в голосовом продолжении: фрейм, ушедший до
// появления агента, теряется безвозвратно (LiveKit data-фреймы не буферизуются).
//
// ФИКС-РАУНД 1 #4 (гонка взвода): room.connect() зовёт onAgentJoined СИНХРОННО из
// цикла по уже присутствующим участникам — тогда phase ещё 'escalating' (voice
// ставится ПОСЛЕ await connect+enableMic). Прежний гард `phase==='voice'` в этот
// момент отбивал взвод повторяющего ресендера → оставался лишь одноразовый
// resume_welcome (escalate()), который pv1 помечает «может быть молча проглочен в
// окне инициализации» = немой аватар после continue_from. Условие теперь по
// НЕтранзиентным признакам: продолжение (isContinuation, известно ДО connect) и
// НЕ-чат (голос идёт как escalating→voice; в chat-продолжении resume_welcome —
// pv1-noop, слать не нужно). Гашение по речи агента — welcomeResender.bump() (M3).
function onAgentJoined(): void {
  startReadySender();
  if (!isContinuation.value || phase.value === 'chat') return;
  welcomeResender?.stop();
  welcomeResender = createResender(() => room.publish({ type: 'resume_welcome' }), { intervalMs: 3000, maxAttempts: 5 });
  welcomeResender.start();
}

// UI аудио-only: гасим саму подписку на видео, иначе трек течёт и оплачивается
// (за egress видео в аудио-интерфейсе платить незачем).
function onVideoPublication(pub: CorePublication): void {
  if (pub.kind === 'video') pub.setSubscribed(false);
}

// Подписка ≠ воспроизведение: без attach() голос молчит (урок монолита).
function onAudioTrack(track: CoreTrack): void {
  if (track.kind !== 'audio') return;
  const element = track.attach();
  element.autoplay = true;
  document.body.appendChild(element);
  voiceAudio.push(element);
}

function clearVoiceAudio(): void {
  for (const element of voiceAudio.splice(0)) element.remove();
}

const room = new CoreRoom({
  onFrame: handleFrame,
  onAgentJoined,
  onDisconnected: () => { phase.value = nextPhase(phase.value, { type: 'disconnected' }); },
  onPublication: onVideoPublication,
  onTrack: onAudioTrack,
});

// Оформление приезжает от хоста в init (D-8): своим запросом за ним панель не
// ходит. `null` — старый бэкенд без темы: панель тогда выглядит как до
// темизации, без заголовка и без акцента.
const theme = ref<BridgeTheme | null>(null);
const panelTitle = computed(() => theme.value?.title ?? '');
// Акцент — переменной на корне, а не инлайновым цветом на каждой кнопке: так
// его подхватывают все элементы панели разом, включая будущие.
const themeStyle = computed(() => (
  theme.value?.color ? { '--vell-accent': theme.value.color } : {}
));

const bridge = createBridge({
  allowedOrigins: [],                     // заполнится из /config в onMounted
  onInit: ({ visitorKey: key, dialogId: saved, theme: hostTheme }) => {
    if (hostTheme) theme.value = hostTheme;
    void openThread(key, saved);
  },
  onVisibility: () => undefined,
});

function push(role: 'user' | 'agent', text: string, source: 'client' | 'core'): void {
  // Стабильный id, а не индекс: по индексу Vue переиспользует узлы и ломает
  // анимацию/выделение при вставке в середину.
  bubbles.value.push({ id: crypto.randomUUID(), role, text, source });
}

function handleFrame(frame: WorkerFrame): void {
  readyResender?.bump(); // ЛЮБОЙ кадр доказывает, что воркер в комнате
  if (frame.type === 'session_ended') {
    // Ядро закрыло сессию: silence → ПАУЗА (нить цела, предлагаем продолжить),
    // прочее → конец. Решает FSM.
    typing.value = false;
    const reason = typeof frame.reason === 'string' ? frame.reason : '';
    phase.value = nextPhase(phase.value, { type: 'session_ended', reason });
    return;
  }
  if (frame.type !== 'transcript') return;
  // WorkerFrame — открытый union с catch-all {type:string;[k]:unknown}, поэтому
  // проверки type мало: сужаем к самому transcript-члену, иначе frame.text — unknown.
  const t = frame as Extract<WorkerFrame, { type: 'transcript' }>;
  if (t.speaker === 'respondent') {
    // Своё эхо гасим; чужой respondent-transcript (STT в голосе) — рисуем.
    if (echo.isEcho(t.text)) return;
    push('user', t.text, 'core');
    return;
  }
  typing.value = false;
  // Аватар ЗАГОВОРИЛ — welcome-back доехал; гасим resume_welcome. Служебные
  // кадры (session_timer, pong) сюда не попадают и НЕ гасят (иначе вернём немоту).
  welcomeResender?.bump();
  push('agent', t.text, 'core');
  if (userTextsSent.value > 0) agentReplies.value += 1; // greeting не в счёт
  void api.journal(dialogId.value!, visitorKey.value!, 'agent', t.text, seq.value++);
}

// Провал обращения к ядру → фаза error + понятный баннер. Разбор по статусу тот
// же, что escalate-ветка, но исход другой: на ВХОДЕ откатываться в чат некуда
// (диалог не открылся), поэтому 402/503/прочее → 'error' (fatal), а не
// chat_fallback. Бэкенд к этому моменту уже пометил диалог error.
function failWithCoreError(err: unknown): void {
  const status = (err as ApiFailure).status;
  lastErrorCode.value = status === 402 ? 'insufficient_credits'
    : status === 503 ? 'service_unavailable'
    : ((err as ApiFailure).code ?? null);
  phase.value = nextPhase(phase.value, { type: 'fatal', code: lastErrorCode.value ?? 'open_failed' });
}

async function openThread(key: string, saved: string | null): Promise<void> {
  visitorKey.value = key;
  try {
    // ФИКС whole-branch #1: раньше catch стоял ТОЛЬКО на fallback reenter→startDialog.
    // Если падал сам первичный startDialog (402 при малом балансе тенанта — штатное
    // состояние дев-предохранителя! — или 503), промис реджектился необработанным
    // (void openThread): фаза оставалась 'chat', композер активен, а send()
    // публиковал user_text в null-комнату (молчаливый дроп). §5: 402→error, 503→«позже».
    const started: StartDialogResult | ReenterResult = saved
      ? await api.reenter(saved, key).catch(() => api.startDialog(key, saved))
      : await api.startDialog(key);
    applyStart(started);
  } catch (err) {
    failWithCoreError(err);
  }
}

function applyStart(started: {
  dialog_id: string; participant_token: ParticipantToken;
  messages: { role: 'user' | 'agent'; text: string; source?: 'client' | 'core' }[]; next_seq: number;
}): void {
  clearVoiceAudio(); // прежний голосовой трек снимаем с DOM: новая сессия — чистый лист
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

// Эскалация в голос. Порядок шагов — часть контракта (менять нельзя):
// блокируем инпут → САМИ уходим из чат-комнаты → /escalate → голос.
async function escalate(): Promise<void> {
  if (phase.value !== 'chat') return;
  phase.value = nextPhase(phase.value, { type: 'escalate' });  // :disabled инпута
  const count = coreMessageCount.value;
  await room.disconnect();                                     // САМИ, до /escalate: иначе ловим свой обрыв
  try {
    const voice = await api.escalate(dialogId.value!, visitorKey.value!, count);
    isContinuation.value = true;
    await room.connect(voice.participant_token.livekit_url ?? '', voice.participant_token.token, { audio: true });
    startReadySender();
    // Микрофон публикуем САМИ: connect его не включает, и без этого разговор
    // односторонний — аватар говорит, а нас не слышно.
    await enableMic();
    phase.value = nextPhase(phase.value, { type: 'voice_ready' });
    // Первый resume_welcome — сразу после client_ready (порядок важен: welcome-back
    // не должен звучать в ещё не подписанный трек). ПОВТОР — из onAgentJoined.
    room.publish({ type: 'resume_welcome' });
  } catch (err) {
    const status = (err as ApiFailure).status;
    lastErrorCode.value = (err as ApiFailure).code ?? null;
    phase.value = nextPhase(phase.value, {
      type: 'escalate_failed',
      // Денег нет (402) — диалог мёртв; недоступно (503)/невалидно — откат в чат.
      code: status === 402 ? 'insufficient_credits' : status === 503 ? 'unavailable' : 'invalid',
    });
  }
}

async function enableMic(): Promise<void> {
  micState.value = 'requesting';
  try {
    await room.setMicrophoneEnabled(true);
    micState.value = 'on';
  } catch (err) {
    // Разговор НЕ прерываем: аватара слышно, просто нас — нет. Пользователю
    // нужен путь наружу (разрешить доступ), а не оверлей ошибки.
    micState.value = (err as Error).name === 'NotAllowedError' ? 'denied' : 'failed';
  }
}

async function toggleMic(): Promise<void> {
  const next = micState.value !== 'on';
  try {
    await room.setMicrophoneEnabled(next);
    micState.value = next ? 'on' : 'off';
  } catch {
    micState.value = 'failed';
  }
}

// ФИКС-РАУНД 1 #5: раньше в фазе paused рендерились ДВА баннера с двумя рабочими
// кнопками «Продолжить» — T6 StateBanner (→resume()) и T7 ResumeBanner
// (→resumeThread()). Оба делали ОДНО И ТО ЖЕ (continue_from той же нити), поэтому
// StateBanner и resume() удалены: единственный путь продолжения — resumeThread.
async function resumeThread(): Promise<void> {
  // «Продолжить» из ResumeBanner (paused / chat_fallback): новая сессия той же
  // нити (continue_from). Комнату рвём — chat_fallback уже без комнаты, пауза
  // могла оставить живую.
  if (resuming.value || !visitorKey.value || !dialogId.value) return;
  resuming.value = true;
  try {
    await room.disconnect();
    const started = await api.startDialog(visitorKey.value, dialogId.value);
    isContinuation.value = true;
    phase.value = nextPhase(phase.value, { type: 'resume' });
    applyStart(started);
  } finally {
    resuming.value = false;
  }
}

async function restart(): Promise<void> {
  // Диалог устарел — заводим НОВЫЙ (без dialog_id) и сбрасываем сохранённую нить.
  // ФИКС whole-branch #3: тот же засов, что в resumeThread. ResumeBanner дизейблит
  // кнопку по :busy=resuming, но restart его не ставил → двойной клик = 2 платных
  // startDialog. try/finally восстанавливает засов даже на ошибке.
  if (resuming.value || !visitorKey.value) return;
  resuming.value = true;
  try {
    await room.disconnect();
    const started = await api.startDialog(visitorKey.value);
    bridge.sendState(visitorKey.value, null);
    applyStart(started);
  } finally {
    resuming.value = false;
  }
}

async function submitLead(payload: LeadFields): Promise<void> {
  await api.lead(dialogId.value!, visitorKey.value!, payload);
}

const leave = (): void => { clearVoiceAudio(); void room.disconnect(); };

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
  readyResender?.stop();   // гигиена таймеров: не оставляем висящие interval'ы
  welcomeResender?.stop();
  clearVoiceAudio();
});
</script>

<template>
  <div class="widget" :style="themeStyle">
    <header v-if="panelTitle" class="widget__title" data-test="panel-title">{{ panelTitle }}</header>
    <ChatFeed :bubbles="bubbles" :typing="typing" />
    <VoicePanel v-if="phase === 'voice'" :mic-state="micState" @toggle-mic="toggleMic" />
    <ResumeBanner
      v-if="banner.text"
      :text="banner.text"
      :action="banner.action"
      :busy="resuming"
      @resume="resumeThread"
      @restart="restart"
    />
    <LeadForm v-if="leadOpen" :submit="submitLead" @close="leadOpen = false" />
    <div v-if="phase === 'chat'" class="actions">
      <button type="button" class="actions__btn" data-test="escalate" @click="escalate">Позвонить голосом</button>
      <button type="button" class="actions__btn actions__btn--ghost" data-test="open-lead" @click="leadOpen = true">
        Оставить контакты
      </button>
    </div>
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
.actions {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
  padding: 8px 12px 0;
}
/*
 * Акцент — через --vell-accent с фолбэком на прежний цвет: тема приезжает
 * ПОЗЖЕ первой отрисовки (сообщением init), и без фолбэка панель успевала бы
 * мигнуть бесцветными кнопками. Старый бэкенд без темы остаётся на фолбэке
 * навсегда — ровно то, как панель выглядела до темизации.
 */
.actions__btn {
  flex: 1 1 auto;
  padding: 8px 12px;
  border: 1px solid var(--vell-accent, #2563eb);
  border-radius: 10px;
  background: var(--vell-accent, #2563eb);
  color: #fff;
  font: 600 13px/1 system-ui, sans-serif;
  cursor: pointer;
}
.actions__btn--ghost {
  background: #fff;
  color: var(--vell-accent, #2563eb);
}
.widget__title {
  flex: 0 0 auto;
  padding: 12px;
  border-bottom: 1px solid #e5e7eb;
  color: var(--vell-accent, #2563eb);
  font: 600 15px/1.3 system-ui, sans-serif;
  /* Заголовок длиной с экран не должен ломать шапку: одна строка с многоточием. */
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
