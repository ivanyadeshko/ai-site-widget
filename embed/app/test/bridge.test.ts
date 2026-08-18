import { describe, expect, it, vi } from 'vitest';
import { createBridge } from '../src/lib/bridge.ts';

describe('мост iframe↔хост', () => {
  it('init принимается только от родителя и только из allowed_origins', async () => {
    const onInit = vi.fn();
    const bridge = createBridge({ allowedOrigins: ['https://shop.example'], onInit, onVisibility: vi.fn() });
    bridge.listen();
    window.dispatchEvent(new MessageEvent('message', {
      data: { src: 'aski-widget-host', type: 'init', visitorKey: 'v1', dialogId: null, parentOrigin: 'https://evil.example' },
      origin: 'https://evil.example', source: window.parent,
    }));
    expect(onInit).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', {
      data: { src: 'aski-widget-host', type: 'init', visitorKey: 'v1', dialogId: null, parentOrigin: 'https://shop.example' },
      origin: 'https://shop.example', source: window.parent,
    }));
    expect(onInit).toHaveBeenCalledWith({ visitorKey: 'v1', dialogId: null });
  });

  it('тема из init доезжает объектом, мусор вместо неё отбрасывается', () => {
    const onInit = vi.fn();
    const bridge = createBridge({ allowedOrigins: ['https://shop.example'], onInit, onVisibility: vi.fn() });
    bridge.listen();
    const init = (theme: unknown): void => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          src: 'aski-widget-host', type: 'init', visitorKey: 'v1', dialogId: null,
          parentOrigin: 'https://shop.example', theme,
        },
        origin: 'https://shop.example', source: window.parent,
      }));
    };

    init({ color: '#ff0000', title: 'Магазин' });
    expect(onInit).toHaveBeenLastCalledWith({
      visitorKey: 'v1', dialogId: null, theme: { color: '#ff0000', title: 'Магазин' },
    });

    // Строка/массив/число в разметке дали бы мусор вместо заголовка: панель
    // обязана остаться просто без темы.
    for (const junk of ['#ff0000', ['#ff0000'], 42]) {
      init(junk);
      expect(onInit).toHaveBeenLastCalledWith({ visitorKey: 'v1', dialogId: null });
    }
  });

  it('после init отправка идёт строго на подтверждённый origin, никогда на *', () => {
    const post = vi.fn();
    vi.stubGlobal('parent', { postMessage: post } as unknown as Window);
    const bridge = createBridge({ allowedOrigins: ['https://shop.example'], onInit: vi.fn(), onVisibility: vi.fn() });
    bridge.listen();
    window.dispatchEvent(new MessageEvent('message', {
      data: { src: 'aski-widget-host', type: 'init', visitorKey: 'v1', dialogId: null, parentOrigin: 'https://shop.example' },
      origin: 'https://shop.example', source: window.parent,
    }));
    bridge.sendState('v1', 'd1');
    expect(post).toHaveBeenCalledWith({ src: 'aski-widget', type: 'state', visitorKey: 'v1', dialogId: 'd1' }, 'https://shop.example');
  });

  it('ready уходит ДО init — иначе очередь хоста никогда не разблокируется', () => {
    const post = vi.fn();
    vi.stubGlobal('parent', { postMessage: post } as unknown as Window);
    createBridge({ allowedOrigins: ['https://shop.example'], onInit: vi.fn(), onVisibility: vi.fn() }).ready();
    expect(post).toHaveBeenCalledWith({ src: 'aski-widget', type: 'ready' }, '*');
  });
});
