import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../src/loader.ts';

const CONFIG = {
  widget_id: 'w1', name: 'Виджет', enabled: true,
  allowed_origins: ['https://shop.example'],
  app_url: 'https://widget.aski.pro/app/tok', text_max_length: 2000,
};

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__askiSiteWidget;
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(CONFIG), { status: 200 })));
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
