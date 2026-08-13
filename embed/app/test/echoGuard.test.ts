import { describe, expect, it } from 'vitest';
import { createEchoGuard, normalizeEcho } from '../src/lib/echoGuard.ts';

describe('дедуп эха', () => {
  it('нормализация: регистр, пробелы, края', () => {
    expect(normalizeEcho('  Меня   зовут\nПётр ')).toBe('меня зовут пётр');
  });

  it('свой текст, вернувшийся transcript-ом, съедается ОДИН раз', () => {
    let now = 0;
    const guard = createEchoGuard({ windowMs: 30_000, now: () => now });
    guard.remember('Меня зовут Пётр');
    expect(guard.isEcho('Меня зовут Пётр')).toBe(true);
    // Второй такой же transcript — уже НЕ эхо: посетитель мог повторить фразу.
    expect(guard.isEcho('Меня зовут Пётр')).toBe(false);
  });

  it('эхо с иной пунктуацией пробелов всё равно ловится', () => {
    let now = 0;
    const guard = createEchoGuard({ windowMs: 30_000, now: () => now });
    guard.remember('Меня зовут Пётр');
    expect(guard.isEcho('меня  зовут пётр')).toBe(true);
  });

  it('за окном 30с эхо не срабатывает — это уже реплика голосом', () => {
    let now = 0;
    const guard = createEchoGuard({ windowMs: 30_000, now: () => now });
    guard.remember('Меня зовут Пётр');
    now = 30_001;
    expect(guard.isEcho('Меня зовут Пётр')).toBe(false);
  });

  it('чужой текст (STT в голосе) НЕ съедается', () => {
    const guard = createEchoGuard({ windowMs: 30_000, now: () => 0 });
    guard.remember('Меня зовут Пётр');
    expect(guard.isEcho('А доставка бесплатная?')).toBe(false);
  });
});
