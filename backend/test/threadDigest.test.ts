import { describe, expect, it } from 'vitest';
import { buildContinuationInstructions, DIGEST_MAX_MESSAGES, INSTRUCTIONS_MAX } from '../src/dialogs/threadDigest.ts';

const BASE = 'Ты консультант магазина.';
const line = (i: number) => ({ role: (i % 2 === 0 ? 'user' : 'agent') as 'user' | 'agent', text: `реплика ${i}` });

describe('buildContinuationInstructions', () => {
  it('без нити возвращает базовый промпт БЕЗ довесков', () => {
    expect(buildContinuationInstructions(BASE, [])).toBe(BASE);
  });

  it('нить уходит после базы, с рамкой «не зачитывай» и ролевыми префиксами', () => {
    const out = buildContinuationInstructions(BASE, [
      { role: 'user', text: 'Меня зовут Пётр' },
      { role: 'agent', text: 'Приятно познакомиться, Пётр!' },
    ]);
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('не зачитывай');
    expect(out).toContain('Посетитель: Меня зовут Пётр');
    expect(out).toContain('Аватар: Приятно познакомиться, Пётр!');
  });

  it('недобранная реплика посетителя дописывается отдельной строкой в КОНЦЕ', () => {
    const out = buildContinuationInstructions(BASE, [{ role: 'user', text: 'старое' }], 'А доставка бесплатная?');
    expect(out.indexOf('А доставка бесплатная?')).toBeGreaterThan(out.indexOf('старое'));
    expect(out).toContain('последняя реплика посетителя');
  });

  it('в выжимку идут ПОСЛЕДНИЕ 30 реплик', () => {
    const thread = Array.from({ length: 50 }, (_, i) => line(i));
    const out = buildContinuationInstructions(BASE, thread);
    expect(out).toContain('реплика 49');
    expect(out).toContain('реплика 20');
    expect(out).not.toContain('реплика 19');
    expect(DIGEST_MAX_MESSAGES).toBe(30);
  });

  it('потолок 32000 соблюдён: режется ВЫЖИМКА с головы, база цела', () => {
    // ОТСТУПЛЕНИЕ ОТ БРИФА (факт, не вкус): сверять длину с ИМПОРТИРОВАННЫМ
    // INSTRUCTIONS_MAX — тавтология: мутпроба 5 брифа (поднять константу до
    // 100_000) оставляла оба теста потолка ЗЕЛЁНЫМИ, потому что ожидание
    // ехало вслед за константой. 32000 — это КОНТРАКТ с ядром (инструкции
    // уезжают в метаданные комнаты LiveKit), а не свободный параметр, поэтому
    // литерал прибит гвоздями — ровно так же, как бриф уже прибил
    // DIGEST_MAX_MESSAGES=30 ниже.
    expect(INSTRUCTIONS_MAX).toBe(32_000);
    const thread = Array.from({ length: 30 }, () => ({ role: 'user' as const, text: 'я'.repeat(3000) }));
    const out = buildContinuationInstructions(BASE, thread);
    expect(out.length).toBeLessThanOrEqual(32_000);
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('Посетитель:'); // хоть что-то из нити влезло
  });

  it('база сама длиннее потолка — отдаём обрезанную базу без нити', () => {
    const huge = 'я'.repeat(INSTRUCTIONS_MAX + 500);
    const out = buildContinuationInstructions(huge, [{ role: 'user', text: 'привет' }]);
    expect(out.length).toBe(INSTRUCTIONS_MAX);
    expect(out).not.toContain('Посетитель:');
  });
});
