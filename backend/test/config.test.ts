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

  it('однодоменный .env: app/panel/cdn — все три падают на WIDGET_PUBLIC_ORIGIN', () => {
    const cfg = loadConfig(FULL);
    expect(cfg.appOrigin).toBe('http://localhost:8200');
    expect(cfg.publicOrigin).toBe(cfg.appOrigin); // алиас, не вторая точка правды
    expect(cfg.panelOrigin).toBe('http://localhost:8200');
    expect(cfg.cdnOrigin).toBe('http://localhost:8200');
  });

  it('задан только WIDGET_APP_ORIGIN — панель и статика переезжают ВМЕСТЕ с приложением', () => {
    const cfg = loadConfig({ ...FULL, WIDGET_APP_ORIGIN: 'https://app.vell.pro/' });
    expect(cfg.appOrigin).toBe('https://app.vell.pro'); // хвостовой слэш срезан
    expect(cfg.publicOrigin).toBe('https://app.vell.pro');
    // Иначе кабинет остался бы на старом хосте и КАЖДЫЙ не-GET к /api/v1
    // получал бы 403 по Origin (CSRF-барьер D-5), а сниппет звал бы старый CDN.
    expect(cfg.panelOrigin).toBe('https://app.vell.pro');
    expect(cfg.cdnOrigin).toBe('https://app.vell.pro');
  });

  it('полная мультидоменная раскладка: три разных origin', () => {
    const cfg = loadConfig({
      ...FULL,
      WIDGET_APP_ORIGIN: 'https://app.vell.pro',
      WIDGET_CDN_ORIGIN: 'https://cdn.vell.pro',
      WIDGET_PANEL_ORIGIN: 'https://app.vell.pro',
    });
    expect(cfg.appOrigin).toBe('https://app.vell.pro');
    expect(cfg.cdnOrigin).toBe('https://cdn.vell.pro');
    expect(cfg.panelOrigin).toBe('https://app.vell.pro');
    // https-раскладка сама включает Secure у куки сессии.
    expect(cfg.cookieSecure).toBe(true);
  });

  it('ПУСТАЯ строка в .env = переменная не задана: docker отдаёт `KEY=` как ""', () => {
    // `??` такую строку пропустил бы, и пустой appOrigin утащил бы за собой
    // panel/cdn: относительный app_url (iframe грузится с домена чужого сайта),
    // 403 на каждый не-GET к /api/v1 и потерянный Secure у куки сессии.
    const cfg = loadConfig({
      ...FULL, WIDGET_APP_ORIGIN: '', WIDGET_PANEL_ORIGIN: '   ', WIDGET_CDN_ORIGIN: '',
    });
    expect(cfg.appOrigin).toBe('http://localhost:8200');
    expect(cfg.panelOrigin).toBe('http://localhost:8200');
    expect(cfg.cdnOrigin).toBe('http://localhost:8200');
  });

  it('trustProxy по умолчанию ВЫКЛЮЧЕН: иначе IP-кап обходится одним заголовком', () => {
    expect(loadConfig(FULL).trustProxy).toBe(false);
    expect(loadConfig({ ...FULL, TRUST_PROXY: 'true' }).trustProxy).toBe(false); // включает только '1'
    expect(loadConfig({ ...FULL, TRUST_PROXY: '1' }).trustProxy).toBe(true);
  });
});
