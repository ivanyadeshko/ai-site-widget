/**
 * Парная сторона лоадера (embed/loader/src/loader.ts). Конверты:
 *   iframe → host:  { src: 'aski-widget', ... }        (MSG_FROM_FRAME)
 *   host   → iframe: { src: 'aski-widget-host', ... }   (MSG_TO_FRAME)
 *
 * visitor_key живёт в FIRST-PARTY хранилище хоста и приезжает СЮДА одним
 * `init`-сообщением. Доверять ему можно лишь после ТРОЙНОЙ проверки:
 *   1. event.source === window.parent      — это наш родитель, не чужой фрейм;
 *   2. data.src === 'aski-widget-host'      — маркер конверта хоста;
 *   3. origin === parentOrigin И origin ∈ allowedOrigins (список — с СЕРВЕРА,
 *      из /config; подделать нельзя).
 * До подтверждения origin родителя `ready` шлём на '*' — секретов в конверте
 * нет, а иначе очередь хоста никогда не разблокируется.
 */

const MSG_FROM_FRAME = 'aski-widget';
const MSG_TO_FRAME = 'aski-widget-host';

/** Схема+хост в нижний регистр, хвостовой слэш срезан, порт значим (паритет с бэкендом). */
function normalizeOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}

export type Bridge = {
  ready(): void;
  listen(): void;
  setAllowedOrigins(origins: string[]): void;
  sendState(visitorKey: string, dialogId: string | null): void;
  close(): void;
};

export function createBridge(opts: {
  allowedOrigins: string[];
  onInit: (p: { visitorKey: string; dialogId: string | null }) => void;
  onVisibility: (visible: boolean) => void;
}): Bridge {
  // Список изменяемый: App создаёт мост ДО ответа /config, а разрешённые
  // origin приезжают позже — setAllowedOrigins их досыпает.
  let allowed = opts.allowedOrigins.map(normalizeOrigin);
  let hostOrigin: string | null = null;

  const postToHost = (message: Record<string, unknown>, targetOrigin: string): void => {
    window.parent.postMessage({ src: MSG_FROM_FRAME, ...message }, targetOrigin);
  };

  const onMessage = (event: MessageEvent): void => {
    // (1) строго наш родитель.
    if (event.source !== window.parent) return;
    const data = event.data as {
      src?: unknown; type?: unknown; visitorKey?: unknown; dialogId?: unknown;
      parentOrigin?: unknown; visible?: unknown;
    };
    // (2) маркер конверта хоста.
    if (data?.src !== MSG_TO_FRAME) return;

    if (data.type === 'init') {
      // (3) origin === заявленный parentOrigin И origin разрешён сервером.
      if (typeof data.parentOrigin !== 'string') return;
      const origin = normalizeOrigin(event.origin);
      if (origin !== normalizeOrigin(data.parentOrigin)) return;
      if (!allowed.includes(origin)) return;
      if (typeof data.visitorKey !== 'string') return;
      hostOrigin = origin; // все дальнейшие posts — строго сюда, никогда на '*'.
      const dialogId = typeof data.dialogId === 'string' && data.dialogId !== '' ? data.dialogId : null;
      opts.onInit({ visitorKey: data.visitorKey, dialogId });
      return;
    }
    if (data.type === 'visibility') {
      opts.onVisibility(data.visible === true);
    }
  };

  return {
    ready() {
      // origin родителя ещё не подтверждён — конверт без секретов, шлём на '*'.
      window.parent.postMessage({ src: MSG_FROM_FRAME, type: 'ready' }, '*');
    },
    listen() {
      window.addEventListener('message', onMessage);
    },
    setAllowedOrigins(origins) {
      allowed = origins.map(normalizeOrigin);
    },
    sendState(visitorKey, dialogId) {
      if (hostOrigin === null) return; // до init хост-origin не подтверждён — молчим.
      postToHost({ type: 'state', visitorKey, dialogId }, hostOrigin);
    },
    close() {
      if (hostOrigin === null) return;
      postToHost({ type: 'close' }, hostOrigin);
    },
  };
}
