import { describe, expect, it } from 'vitest';
import { originVerdict } from '../src/http/originGuard.ts';
import type { WidgetRow } from '../src/db/repositories/widgets.ts';

const widget = (origins: string[]): WidgetRow =>
  ({ allowed_origins: origins } as WidgetRow);
const OURS = 'https://widget.aski.pro';
const check = (
  origins: string[],
  origin: string | undefined,
  method: string,
): 'allow' | 'deny' => originVerdict(widget(origins), { origin, publicOrigin: OURS, method });

describe('originVerdict', () => {
  it('свой сайт разрешён', () => {
    expect(check(['https://shop.example'], 'https://shop.example', 'POST')).toBe('allow');
  });

  it('наш собственный origin разрешён — это путь iframe', () => {
    expect(check(['https://shop.example'], OURS, 'POST')).toBe('allow');
  });

  it('чужой origin — отказ', () => {
    expect(check(['https://shop.example'], 'https://evil.example', 'POST')).toBe('deny');
  });

  it('НЕ-GET без Origin — ОТКАЗ: браузер шлёт Origin на любой не-GET, значит это curl', () => {
    expect(check(['https://shop.example'], undefined, 'POST')).toBe('deny');
    expect(check(['https://shop.example'], undefined, 'DELETE')).toBe('deny');
  });

  it('GET без Origin — пропуск: браузер не шлёт его на same-origin GET', () => {
    expect(check(['https://shop.example'], undefined, 'GET')).toBe('allow');
    expect(check(['https://shop.example'], undefined, 'HEAD')).toBe('allow');
  });

  it('ПУСТОЙ allowed_origins — отказ всем и на любом методе', () => {
    expect(check([], 'https://shop.example', 'POST')).toBe('deny');
    expect(check([], undefined, 'GET')).toBe('deny');
    expect(check([], OURS, 'POST')).toBe('deny');
  });

  it('сравнение точное: поддомен и порт не подходят', () => {
    expect(check(['https://shop.example'], 'https://evil.shop.example', 'POST')).toBe('deny');
    expect(check(['https://shop.example'], 'https://shop.example:8443', 'POST')).toBe('deny');
    expect(check(['https://shop.example'], 'http://shop.example', 'POST')).toBe('deny');
  });

  it('хвостовой слэш и регистр схемы/хоста нормализуются', () => {
    expect(check(['https://Shop.Example/'], 'https://shop.example', 'POST')).toBe('allow');
  });
});
