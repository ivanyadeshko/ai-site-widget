import { afterEach, expect, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ClientFrame, WorkerFrame } from '../../src/lib/frames.ts';

// Порядковый матчер (см. test/vitest.d.ts): received вызван РАНЬШЕ other.
// jest-extended в проект не тащим — крошечная реализация на invocationCallOrder.
expect.extend({
  toHaveBeenCalledBefore(received: unknown, other: unknown) {
    const order = (spy: unknown): number | undefined =>
      (spy as { mock?: { invocationCallOrder: number[] } }).mock?.invocationCallOrder[0];
    const a = order(received);
    const b = order(other);
    const pass = typeof a === 'number' && typeof b === 'number' && a < b;
    return {
      pass,
      message: () => `ожидалось, что первый спай вызван раньше второго (порядок ${String(a)} vs ${String(b)})`,
    };
  },
});

// Подставная публикация/трек аватара: их отдаёт КОМНАТА, а решают (гасить видео,
// прикреплять аудио) обработчики onPublication/onTrack самого App — их и проверяем.
type PublicationLike = { kind: string; setSubscribed: ReturnType<typeof vi.fn> };
type TrackLike = { kind: string; attach: ReturnType<typeof vi.fn> };

type Handlers = {
  onFrame: (frame: WorkerFrame) => void;
  onAgentJoined: () => void;
  onDisconnected: () => void;
  onPublication?: (pub: PublicationLike) => void;
  onTrack?: (track: TrackLike) => void;
};

type EscalateCtl = { resolve: (value: unknown) => void; reject: (err: unknown) => void };

// Общее состояние для фабрик vi.mock. vi.hoisted гарантирует, что оно
// существует к моменту, когда хойстнутые vi.mock'и его читают.
const shared = vi.hoisted(() => ({
  sent: [] as ClientFrame[],
  handlers: null as null | {
    onFrame: (frame: WorkerFrame) => void;
    onAgentJoined: () => void;
    onDisconnected: () => void;
    onPublication?: (pub: { kind: string; setSubscribed: (v: boolean) => void }) => void;
    onTrack?: (track: { kind: string; attach: () => HTMLMediaElement }) => void;
  },
  roomInstance: null as null | {
    connect: ReturnType<typeof vi.fn>;
    setMicrophoneEnabled: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  },
  apiInstance: null as null | Record<string, ReturnType<typeof vi.fn>>,
  bridgeOpts: null as null | {
    onInit: (p: { visitorKey: string; dialogId: string | null }) => void;
    onVisibility: (visible: boolean) => void;
  },
  configResult: null as unknown,
  startResult: null as unknown,
  escalateCtl: null as null | EscalateCtl,
  // Симуляция «агент УЖЕ в комнате к моменту connect»: реальный room.connect зовёт
  // onAgentJoined синхронно из цикла по присутствующим участникам (room.ts) —
  // именно так воспроизводится гонка взвода resume_welcome (фикс-раунд 1 #4).
  agentJoinsOnConnect: false,
}));

// Комнату мокаем целиком: живой LiveKit в юнит-тесте недоступен. publish
// складываем в sent, handlers пробрасываем наружу как emit*. disconnect
// ОБНУЛЯЕТ sent: фреймы снесённой комнаты уже неактуальны — так `sent` в
// голосовой фазе не тащит client_ready прежней чат-комнаты.
vi.mock('../../src/lib/room.ts', () => ({
  CoreRoom: class {
    connect = vi.fn(async () => {
      // Агент уже в комнате → onAgentJoined приходит СИНХРОННО в connect (как в
      // room.ts), пока фаза ещё не 'voice'. Иначе бы гонка #4 не воспроизводилась.
      if (shared.agentJoinsOnConnect) shared.handlers?.onAgentJoined();
    });
    setMicrophoneEnabled = vi.fn(async () => {});
    disconnect = vi.fn(async () => { shared.sent.length = 0; });
    publish = (frame: ClientFrame): void => { shared.sent.push(frame); };
    constructor(handlers: NonNullable<typeof shared.handlers>) {
      shared.handlers = handlers;
      shared.roomInstance = this as unknown as NonNullable<typeof shared.roomInstance>;
    }
  },
}));

// API мокаем: значения config/startDialog берём из shared (задаются ДО mount,
// потому что onMounted дергает config() ещё во время монтирования). escalate —
// ОТЛОЖЕННЫЙ промис: тест сам решает исход через resolveEscalate/rejectEscalate.
vi.mock('../../src/lib/api.ts', () => ({
  WidgetApi: class {
    config = vi.fn(async () => shared.configResult);
    startDialog = vi.fn(async () => shared.startResult);
    reenter = vi.fn(async () => shared.startResult);
    journal = vi.fn(async () => ({ stored: true }));
    end = vi.fn(async () => ({ dialog_id: 'd1', status: 'ended' }));
    escalate = vi.fn((..._args: unknown[]) => {
      let resolve!: (value: unknown) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      shared.escalateCtl = { resolve, reject };
      return promise;
    });
    lead = vi.fn(async () => ({ lead_id: 'l1' }));
    constructor() { shared.apiInstance = this as unknown as Record<string, ReturnType<typeof vi.fn>>; }
  },
}));

// Мост мокаем: реальную postMessage-валидацию проверяет bridge.test.ts. Здесь
// просто ловим onInit, чтобы вручную завести нить.
vi.mock('../../src/lib/bridge.ts', () => ({
  createBridge: (opts: NonNullable<typeof shared.bridgeOpts>) => {
    shared.bridgeOpts = opts;
    return {
      ready: vi.fn(),
      listen: vi.fn(),
      setAllowedOrigins: vi.fn(),
      sendState: vi.fn(),
      close: vi.fn(),
    };
  },
}));

// Импорт ПОСЛЕ vi.mock (vitest хойстит vi.mock выше импортов автоматически).
import App from '../../src/App.vue';

const VISITOR_KEY = '11111111-1111-4111-8111-111111111111';

/** Успешный ответ /escalate — один на все тесты голоса. */
export const VOICE_OK = {
  dialog_id: 'd1', channel: 'voice' as const, core_session_id: 'sess_bbbbbbbbbbbbbbbb',
  participant_token: {
    token: 'jwt-voice', identity: 'respondent-x',
    livekit_url: 'wss://lk.example', expires_at: '2026-08-13T11:00:00Z',
  },
  continued_from: 'sess_aaaaaaaaaaaaaaaa', transcript_complete: true,
};

const defaultConfig = () => ({
  widget_id: 'w1', name: 'Демо', enabled: true,
  allowed_origins: ['https://shop.example'],
  app_url: 'https://widget.test/app/wgt_tok', text_max_length: 2000,
});

const defaultStart = () => ({
  dialog_id: 'd1',
  channel: 'chat' as const,
  participant_token: { token: 'tok', identity: 'respondent-1', livekit_url: 'wss://lk.test', expires_at: '' },
  messages: [] as { role: 'user' | 'agent'; text: string }[],
  next_seq: 1,
});

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  shared.escalateCtl = null;
});

export type MountOptions = {
  startResult?: Record<string, unknown>;
  dialogId?: string | null;
  agentJoinsOnConnect?: boolean;
};

export type MountedRoom = {
  emitFrame: (frame: WorkerFrame) => void;
  emitAgentJoined: () => void;
  emitDisconnected: () => void;
  emitVideoPublication: () => PublicationLike;
  emitAudioTrack: () => TrackLike;
  connect: ReturnType<typeof vi.fn>;
  setMicrophoneEnabled: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

// Явные ключи (не через Record): noUncheckedIndexedAccess иначе делает
// api.lead возможным undefined, и .mockRejectedValueOnce на нём не вызвать.
type ApiSpy = ReturnType<typeof vi.fn>;
export type MountedApi = {
  config: ApiSpy; startDialog: ApiSpy; reenter: ApiSpy; journal: ApiSpy;
  end: ApiSpy; escalate: ApiSpy; lead: ApiSpy;
  resolveEscalate: (value: unknown) => Promise<void>;
  rejectEscalate: (err: unknown) => Promise<void>;
};

export async function mountWidget(opts: MountOptions = {}): Promise<{
  wrapper: VueWrapper;
  api: MountedApi;
  sent: ClientFrame[];
  room: MountedRoom;
}> {
  shared.sent.length = 0;
  shared.escalateCtl = null;
  shared.agentJoinsOnConnect = opts.agentJoinsOnConnect ?? false;
  shared.configResult = defaultConfig();
  shared.startResult = { ...defaultStart(), ...opts.startResult };

  // #app держит ТОЛЬКО атрибут-токен (App читает его через getElementById);
  // сам компонент монтируется в отдельный узел, чтобы не затирать атрибут.
  document.body.innerHTML = '<div id="app" data-widget-token="wgt_tok"></div>';

  const wrapper = mount(App);
  mounted.push(wrapper);
  await flushPromises();                        // onMounted: config → setAllowedOrigins/listen/ready

  shared.bridgeOpts!.onInit({ visitorKey: VISITOR_KEY, dialogId: opts.dialogId ?? null });
  await flushPromises();                        // openThread → startDialog → applyStart → connect → client_ready

  const handlers = (): NonNullable<typeof shared.handlers> => shared.handlers!;
  const room: MountedRoom = {
    emitFrame: (frame) => handlers().onFrame(frame),
    emitAgentJoined: () => handlers().onAgentJoined(),
    emitDisconnected: () => handlers().onDisconnected(),
    emitVideoPublication: () => {
      const pub: PublicationLike = { kind: 'video', setSubscribed: vi.fn() };
      handlers().onPublication?.(pub);
      return pub;
    },
    emitAudioTrack: () => {
      const track: TrackLike = { kind: 'audio', attach: vi.fn(() => document.createElement('audio')) };
      handlers().onTrack?.(track);
      return track;
    },
    connect: shared.roomInstance!.connect,
    setMicrophoneEnabled: shared.roomInstance!.setMicrophoneEnabled,
    disconnect: shared.roomInstance!.disconnect,
  };

  const api = Object.assign(shared.apiInstance!, {
    resolveEscalate: async (value: unknown) => { shared.escalateCtl!.resolve(value); await flushPromises(); },
    rejectEscalate: async (err: unknown) => { shared.escalateCtl!.reject(err); await flushPromises(); },
  }) as unknown as MountedApi;

  return { wrapper, api, sent: shared.sent, room };
}
