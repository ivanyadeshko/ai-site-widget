import { afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ClientFrame, WorkerFrame } from '../../src/lib/frames.ts';

// Общее состояние для фабрик vi.mock. vi.hoisted гарантирует, что оно
// существует к моменту, когда хойстнутые vi.mock'и его читают.
const shared = vi.hoisted(() => ({
  sent: [] as ClientFrame[],
  handlers: null as null | {
    onFrame: (frame: WorkerFrame) => void;
    onAgentJoined: () => void;
    onDisconnected: () => void;
  },
  roomInstance: null as null | { disconnect: ReturnType<typeof vi.fn> },
  apiInstance: null as null | Record<string, ReturnType<typeof vi.fn>>,
  bridgeOpts: null as null | {
    onInit: (p: { visitorKey: string; dialogId: string | null }) => void;
    onVisibility: (visible: boolean) => void;
  },
  configResult: null as unknown,
  startResult: null as unknown,
}));

// Комнату мокаем целиком: живой LiveKit в юнит-тесте недоступен. publish
// складываем в sent, handlers пробрасываем наружу как emit*.
vi.mock('../../src/lib/room.ts', () => ({
  CoreRoom: class {
    connect = vi.fn(async () => {});
    setMicrophoneEnabled = vi.fn(async () => {});
    disconnect = vi.fn(async () => {});
    publish = (frame: ClientFrame): void => { shared.sent.push(frame); };
    constructor(handlers: NonNullable<typeof shared.handlers>) {
      shared.handlers = handlers;
      shared.roomInstance = this;
    }
  },
}));

// API мокаем: значения config/startDialog берём из shared (задаются ДО mount,
// потому что onMounted дергает config() ещё во время монтирования).
vi.mock('../../src/lib/api.ts', () => ({
  WidgetApi: class {
    config = vi.fn(async () => shared.configResult);
    startDialog = vi.fn(async () => shared.startResult);
    reenter = vi.fn(async () => shared.startResult);
    journal = vi.fn(async () => ({ stored: true }));
    end = vi.fn(async () => ({ dialog_id: 'd1', status: 'ended' }));
    escalate = vi.fn(async () => shared.startResult);
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
});

export type MountOptions = {
  startResult?: Record<string, unknown>;
  dialogId?: string | null;
};

export async function mountWidget(opts: MountOptions = {}): Promise<{
  wrapper: VueWrapper;
  api: Record<string, ReturnType<typeof vi.fn>>;
  sent: ClientFrame[];
  room: {
    emitFrame: (frame: WorkerFrame) => void;
    emitAgentJoined: () => void;
    disconnect: ReturnType<typeof vi.fn>;
  };
}> {
  shared.sent.length = 0;
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

  return {
    wrapper,
    api: shared.apiInstance!,
    sent: shared.sent,
    room: {
      emitFrame: (frame) => shared.handlers!.onFrame(frame),
      emitAgentJoined: () => shared.handlers!.onAgentJoined(),
      disconnect: shared.roomInstance!.disconnect,
    },
  };
}
