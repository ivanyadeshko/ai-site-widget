import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../src/loader.ts';

// Тема приезжает ПОЛНОЙ: дефолты добил бэкенд (themeForConfig), лоадер их не
// знает и не проверяет — бюджет 8 КБ gzip дороже (D-9).
const THEME = {
  color: '#2563eb', position: 'right', button_label: '💬',
  title: 'Виджет', launcher_title: 'Открыть чат: Виджет',
};

const CONFIG = {
  widget_id: 'w1', name: 'Виджет', enabled: true,
  allowed_origins: ['https://shop.example'],
  app_url: 'https://widget.aski.pro/app/tok', text_max_length: 2000,
  theme: THEME,
};

const serve = (config: unknown): void => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(config), { status: 200 })));
};

/** Отрисованное после boot: Shadow DOM, кнопка и текст инлайнового стиля. */
const rendered = () => {
  const root = document.querySelector('aski-site-widget')!.shadowRoot!;
  return {
    root,
    button: root.querySelector('button')!,
    css: root.querySelector('style')!.textContent ?? '',
  };
};

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__askiSiteWidget;
  localStorage.clear();
  serve(CONFIG);
});

describe('лоадер', () => {
  it('вешает кнопку в Shadow DOM и НЕ создаёт iframe до первого клика', async () => {
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const host = document.querySelector('aski-site-widget')!;
    expect(host.shadowRoot!.querySelector('button')).not.toBeNull();
    expect(host.shadowRoot!.querySelector('iframe')).toBeNull();
  });

  it('iframe создаётся на клик: allow=microphone, sandbox с allow-same-origin', async () => {
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const root = document.querySelector('aski-site-widget')!.shadowRoot!;
    (root.querySelector('button') as HTMLButtonElement).click();
    const frame = root.querySelector('iframe')!;
    expect(frame.getAttribute('allow')).toBe('microphone; autoplay');
    const sandbox = frame.getAttribute('sandbox')!;
    // allow-same-origin ОБЯЗАТЕЛЕН: без него opaque origin убивает getUserMedia
    // и localStorage внутри iframe — микрофон просто не запросится.
    expect(sandbox).toContain('allow-same-origin');
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).toContain('allow-forms');
    expect(frame.src).toContain('https://widget.aski.pro/app/tok');
  });

  it('visitor_key живёт в localStorage ХОСТА (first-party) и переживает перезапуск', async () => {
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const first = localStorage.getItem('aski-sw-visitor-tok');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>).__askiSiteWidget;
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    expect(localStorage.getItem('aski-sw-visitor-tok')).toBe(first);
  });

  it('localStorage кинул (приватный режим) — лоадер жив, ключ в памяти', async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('заблокировано'); };
    await expect(boot({ token: 'tok', base: 'https://widget.aski.pro/' })).resolves.toBeUndefined();
    expect(document.querySelector('aski-site-widget')).not.toBeNull();
    Storage.prototype.setItem = original;
  });

  it('повторная вставка сниппета не плодит второй виджет', async () => {
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    expect(document.querySelectorAll('aski-site-widget')).toHaveLength(1);
  });

  it('enabled:false — ничего не рисуем', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...CONFIG, enabled: false }), { status: 200 })));
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    expect(document.querySelector('aski-site-widget')).toBeNull();
  });

  it('404 конфига — тихий выход без единой ошибки в консоли', async () => {
    const errorSpy = vi.spyOn(console, 'error');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    expect(document.querySelector('aski-site-widget')).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('цвет темы уезжает в фон кнопки', async () => {
    serve({ ...CONFIG, theme: { ...THEME, color: '#ff0000' } });
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    expect(rendered().css).toContain('background:#ff0000');
  });

  it('position:left переносит кнопку И панель к левому краю, правого прижима не остаётся', async () => {
    serve({ ...CONFIG, theme: { ...THEME, position: 'left' } });
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const { css } = rendered();
    expect(css).toContain('left:20px');
    // Именно ОТСУТСТВИЕ right:20px: две конкурирующие привязки дали бы
    // растянутую на всю ширину кнопку, а не переезд к левому краю.
    expect(css).not.toContain('right:20px');
    // Обе привязки — и у кнопки, и у панели: иначе панель открывалась бы
    // на другой стороне экрана, чем кнопка.
    expect(css.match(/left:20px/g)).toHaveLength(2);
  });

  it('подписи темы становятся значком, aria-label и tooltip кнопки', async () => {
    serve({
      ...CONFIG,
      theme: { ...THEME, button_label: '🤖', launcher_title: 'Спросить консультанта' },
    });
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const { button } = rendered();
    expect(button.textContent).toBe('🤖');
    expect(button.getAttribute('aria-label')).toBe('Спросить консультанта');
    expect(button.getAttribute('title')).toBe('Спросить консультанта');
  });

  it('тема уезжает в iframe первым же сообщением init', async () => {
    serve({ ...CONFIG, theme: { ...THEME, color: '#00ff00', title: 'Магазин на связи' } });
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const { root, button } = rendered();
    button.click();
    const frame = root.querySelector('iframe')!;
    const post = vi.fn();
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage: post }, configurable: true });

    window.dispatchEvent(new MessageEvent('message', {
      data: { src: 'aski-widget', type: 'ready' },
      origin: 'https://widget.aski.pro', source: frame.contentWindow,
    }));

    const init = post.mock.calls.map(([payload]) => payload as { type?: string; theme?: unknown })
      .find((payload) => payload.type === 'init');
    expect(init).toBeDefined();
    expect(init!.theme).toEqual({ ...THEME, color: '#00ff00', title: 'Магазин на связи' });
  });

  it('/config СТАРОГО бэкенда (без theme) не роняет лоадер и рисует кнопку как до темизации', async () => {
    // Прямое следствие инварианта «предыдущий образ обязан работать» в обратную
    // сторону: откат образа бэкенда при уже раскатанном на CDN бандле.
    const { theme: _dropped, ...legacy } = CONFIG;
    serve(legacy);
    await expect(boot({ token: 'tok', base: 'https://widget.aski.pro/' })).resolves.toBeUndefined();
    const { button, css } = rendered();
    expect(button.textContent).toBe('💬');
    expect(button.getAttribute('aria-label')).toBe('Открыть чат: Виджет');
    expect(css).toContain('background:#2563eb');
    expect(css).toContain('right:20px');
    // Ни одного «undefined», просочившегося в CSS из отсутствующей темы.
    expect(css).not.toContain('undefined');
  });

  it('сообщения принимаются ТОЛЬКО от своего iframe и своего origin', async () => {
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const root = document.querySelector('aski-site-widget')!.shadowRoot!;
    (root.querySelector('button') as HTMLButtonElement).click();
    const frame = root.querySelector('iframe')!;
    // Чужой origin — игнор (панель не закроется).
    window.dispatchEvent(new MessageEvent('message', {
      data: { src: 'aski-widget', type: 'close' }, origin: 'https://evil.example', source: frame.contentWindow,
    }));
    expect(frame.style.display).not.toBe('none');
  });
});
