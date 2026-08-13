import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResender } from '../src/lib/resender.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ре-отправщик служебных фреймов', () => {
  it('шлёт сразу и повторяет до потолка попыток', () => {
    const send = vi.fn();
    createResender(send, { intervalMs: 1000, maxAttempts: 3 }).start();
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3500);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('stop гасит повторы', () => {
    const send = vi.fn();
    const resender = createResender(send, { intervalMs: 1000, maxAttempts: 10 });
    resender.start();
    resender.stop();
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('гасим ПОСЛЕ очередной отправки, а не вместо неё: фрейм воркера доказывает лишь, что воркер в комнате', () => {
    const send = vi.fn();
    const resender = createResender(send, { intervalMs: 1000, maxAttempts: 10 });
    resender.start();
    resender.bump();          // увидели фрейм воркера
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(2); // ещё одна отправка ушла
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(2); // и только потом тишина
  });
});
