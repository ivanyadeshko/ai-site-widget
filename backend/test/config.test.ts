import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const FULL = {
  DATABASE_URL: 'postgres://widget:widget@127.0.0.1:55433/widget_test',
  CORE_BASE_URL: 'http://185.125.102.133:8100/api',
  CORE_TENANT_KEY: 'sk_test_x',
  CORE_WEBHOOK_SECRET: 'секрет-длиной-больше-шестнадцати',
  WIDGET_PUBLIC_ORIGIN: 'http://localhost:8200',
  WIDGET_CSP_CONNECT_SRC: "'self' wss://livekit.example",
  IP_HASH_SALT: 'соль',
};

describe('loadConfig', () => {
  it('перечисляет ВСЕ недостающие переменные разом, а не первую', () => {
    expect(() => loadConfig({})).toThrowError(
      /DATABASE_URL.*CORE_BASE_URL.*CORE_TENANT_KEY.*CORE_WEBHOOK_SECRET.*WIDGET_PUBLIC_ORIGIN.*WIDGET_CSP_CONNECT_SRC.*IP_HASH_SALT/s,
    );
  });

  it('срезает хвостовой слэш у CORE_BASE_URL и WIDGET_PUBLIC_ORIGIN', () => {
    const cfg = loadConfig({ ...FULL, CORE_BASE_URL: 'http://core:8100/api/', WIDGET_PUBLIC_ORIGIN: 'http://x/' });
    expect(cfg.coreBaseUrl).toBe('http://core:8100/api');
    expect(cfg.publicOrigin).toBe('http://x');
  });

  it('дефолты бюджет-предохранителя — из спеки §6, фикс-раунд 1 (капы по сессиям, не строкам dialogs)', () => {
    const cfg = loadConfig(FULL);
    expect(cfg.maxDialogsPerVisitorPerDay).toBe(20);
    expect(cfg.maxDialogsPerIpPerDay).toBe(60);
    expect(cfg.maxDurationS).toBe(600);
  });

  it('trustProxy по умолчанию ВЫКЛЮЧЕН: иначе IP-кап обходится одним заголовком', () => {
    expect(loadConfig(FULL).trustProxy).toBe(false);
    expect(loadConfig({ ...FULL, TRUST_PROXY: 'true' }).trustProxy).toBe(false); // включает только '1'
    expect(loadConfig({ ...FULL, TRUST_PROXY: '1' }).trustProxy).toBe(true);
  });
});
