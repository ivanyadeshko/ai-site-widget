export type LoaderBoot = { token: string; base: string };

/**
 * Оформление из `/config`. Поля приходят ЗАПОЛНЕННЫМИ: дефолты добил и всё
 * провалидировал бэкенд (`backend/src/widgets/theme.ts`, `themeForConfig`).
 * Здесь нет ни валидации, ни своих дефолтов — и то и другое стоило бы байт из
 * бюджета 8 КБ gzip и ничего не добавило бы: данные приходят из своей же БД (D-9).
 *
 * Поле необязательное ровно по одной причине — откат образа бэкенда при уже
 * раскатанном на CDN бандле. Тогда `theme` не придёт вовсе, и лоадер обязан
 * нарисовать РОВНО то, что рисовал до темизации: за это отвечают `||` ниже.
 * Это не новые дефолты, а сохранение прежнего поведения.
 */
type LoaderTheme = {
  color?: string; position?: string; button_label?: string;
  title?: string; launcher_title?: string;
};

type LoaderConfig = {
  widget_id: string; name: string; enabled: boolean;
  allowed_origins: string[]; app_url: string; text_max_length: number;
  theme?: LoaderTheme;
};

const MSG_FROM_FRAME = 'aski-widget';
const MSG_TO_FRAME = 'aski-widget-host';

// localStorage кидает в приватном режиме Safari и при запрете кук: любое
// обращение — в try/catch, с фолбэком в память (посетитель просто потеряет
// нить между визитами, но виджет останется рабочим).
const memory = new Map<string, string>();
const lsGet = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return memory.get(key) ?? null; }
};
const lsSet = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { memory.set(key, value); }
};

const uuid = (): string =>
  (crypto.randomUUID?.() ?? '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16)));

const onBodyReady = (fn: () => void): void => {
  // Сниппет часто стоит в <head> — body ещё нет.
  if (document.body) fn();
  else document.addEventListener('DOMContentLoaded', fn, { once: true });
};

export async function boot(input: LoaderBoot): Promise<void> {
  const flag = '__askiSiteWidget';
  // CMS вставляют сниппет дважды — второй запуск обязан быть no-op.
  if ((window as unknown as Record<string, unknown>)[flag]) return;
  (window as unknown as Record<string, unknown>)[flag] = true;

  let config: LoaderConfig;
  try {
    const res = await fetch(`${input.base}w/v1/${encodeURIComponent(input.token)}/config`, { mode: 'cors' });
    if (!res.ok) { (window as unknown as Record<string, unknown>)[flag] = false; return; } // 404 — тихо
    config = (await res.json()) as LoaderConfig;
  } catch {
    (window as unknown as Record<string, unknown>)[flag] = false;
    return; // сеть легла — виджет не наша главная забота на чужом сайте
  }
  if (!config.enabled) { (window as unknown as Record<string, unknown>)[flag] = false; return; }

  const visitorKeyName = `aski-sw-visitor-${input.token}`;
  const dialogKeyName = `aski-sw-dialog-${input.token}`;
  // visitor_key живёт в FIRST-PARTY хранилище хоста: у iframe оно
  // партиционировано/выключено (ITP Safari), и нить терялась бы каждый визит.
  let visitorKey = lsGet(visitorKeyName);
  if (!visitorKey) { visitorKey = uuid(); lsSet(visitorKeyName, visitorKey); }

  const appOrigin = new URL(config.app_url).origin;

  const theme = config.theme ?? {};
  // Одна подстановка на обе привязки: две конкурирующие (right И left) растянули
  // бы кнопку на всю ширину вместо переезда к краю.
  const side = theme.position === 'left' ? 'left' : 'right';
  const launcherTitle = theme.launcher_title || `Открыть чат: ${config.name}`;

  onBodyReady(() => {
    const host = document.createElement('aski-site-widget');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host{all:initial}
      .btn{position:fixed;${side}:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;
           border:none;border-radius:50%;background:${theme.color || '#2563eb'};color:#fff;font:600 22px/1 system-ui;cursor:pointer}
      .frame{position:fixed;${side}:20px;bottom:20px;z-index:2147483001;width:380px;
             height:min(640px,calc(100vh - 40px));border:none;border-radius:18px;display:none;
             background:#fff;color-scheme:light;box-shadow:0 12px 48px rgba(0,0,0,.24)}
      @media (max-width:767px){.frame{inset:0;width:100%;height:100dvh;border-radius:0}}
    `;
    const button = document.createElement('button');
    button.className = 'btn';
    button.type = 'button';
    // Значения уходят в setAttribute/textContent — это DOM-текст, не HTML:
    // разметку ими не собрать даже без валидации. Валидация всё равно есть, но
    // на бэкенде (backend/src/widgets/theme.ts), где ей и место.
    button.setAttribute('aria-label', launcherTitle);
    button.setAttribute('title', launcherTitle);
    button.textContent = theme.button_label || '💬';
    root.append(style, button);
    document.body.appendChild(host);

    let frame: HTMLIFrameElement | null = null;
    let frameReady = false;
    const pending: unknown[] = [];

    const post = (message: Record<string, unknown>): void => {
      const payload = { src: MSG_TO_FRAME, ...message };
      if (!frame || !frameReady) { pending.push(payload); return; }
      frame.contentWindow?.postMessage(payload, appOrigin); // никогда не '*'
    };

    const ensureFrame = (): HTMLIFrameElement => {
      if (frame) return frame;
      frame = document.createElement('iframe');
      frame.className = 'frame';
      frame.src = config.app_url;
      frame.title = `Чат: ${config.name}`;
      frame.setAttribute('allow', 'microphone; autoplay');
      // allow-same-origin ОБЯЗАТЕЛЕН вместе с allow-scripts: без него iframe
      // получает opaque origin, а с ним умирают getUserMedia и localStorage.
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      root.appendChild(frame);
      return frame;
    };

    const open = (): void => {
      const el = ensureFrame();
      el.style.display = 'block';
      button.style.display = 'none';
      post({ type: 'visibility', visible: true });
    };
    const close = (): void => {
      if (frame) frame.style.display = 'none';
      button.style.display = 'block';
      post({ type: 'visibility', visible: false });
    };

    button.addEventListener('click', open);

    window.addEventListener('message', (event: MessageEvent) => {
      // Тройная проверка: origin + именно НАШ iframe + маркер конверта.
      if (event.origin !== appOrigin) return;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { src?: string; type?: string; visitorKey?: string; dialogId?: string | null };
      if (data?.src !== MSG_FROM_FRAME) return;

      if (data.type === 'ready') {
        frameReady = true;
        // Тему iframe получает ОТСЮДА, а не своим запросом: `/config` уже
        // загружен хостом, и лишний сетевой вызов внутри панели не нужен (D-8).
        post({
          type: 'init', visitorKey, dialogId: lsGet(dialogKeyName),
          parentOrigin: location.origin, theme: config.theme,
        });
        // Флашим накопленное: iframe грузится секунды, «open» иначе теряется.
        for (const message of pending.splice(0)) frame.contentWindow?.postMessage(message, appOrigin);
      } else if (data.type === 'state') {
        if (data.visitorKey) lsSet(visitorKeyName, data.visitorKey);
        lsSet(dialogKeyName, data.dialogId ?? '');
      } else if (data.type === 'close') {
        close();
      }
    });
  });
}

// Бутстрап: шим кладёт конфиг в очередь, основной бандл её разбирает.
const queue = (window as unknown as { AskiWidgetQueue?: LoaderBoot[] }).AskiWidgetQueue ?? [];
for (const item of queue) void boot(item);
