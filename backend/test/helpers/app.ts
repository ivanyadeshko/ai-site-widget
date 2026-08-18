import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp, type AppDeps } from '../../src/app.ts';
import type { AppConfig } from '../../src/config.ts';
import { CoreClient } from '../../src/core/client.ts';
import { testPool } from './db.ts';
import { FakeCore } from './fakeCore.ts';

export type TestApp = { app: FastifyInstance; core: FakeCore; pool: Pool; deps: AppDeps };

/**
 * Общая сборка тестового инстанса: свой пул БД, свой фейк-ядро, свой Fastify —
 * каждый вызов полностью изолирован (свой pool.end() в паре с afterEach
 * вызывающего). Переиспользуется публичным API (T3) и последующими тасками
 * (T4 эскалация, T5 embed-виджет, T6 админка): все гоняют один и тот же набор
 * guard'ов и не должны копировать обвязку по файлам.
 */
export async function buildTestApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const pool = testPool();
  const core = new FakeCore();
  await core.start();
  const config: AppConfig = {
    port: 8200,
    databaseUrl: process.env.DATABASE_URL!,
    coreBaseUrl: core.baseUrl,
    coreTenantKey: 'sk_test_x',
    coreWebhookSecret: 'секрет-длиной-больше-шестнадцати',
    appOrigin: 'https://widget.aski.pro',
    publicOrigin: 'https://widget.aski.pro',
    cspConnectSrc: "'self'",
    ipHashSalt: 'соль',
    maxDialogsPerVisitorPerDay: 20,
    maxDialogsPerIpPerDay: 60,
    maxSessionsPerAccountPerDay: 300,
    maxDurationS: 600,
    trustProxy: false,
    logLevel: 'silent',
    sessionTtlDays: 30,
    panelOrigin: 'https://widget.aski.pro',
    // На http-инжектах Secure-кука не вернулась бы обратно — в тестах выключен.
    cookieSecure: false,
    loginMaxFailures: 10,
    loginLockMinutes: 15,
    // Однодоменная раскладка по умолчанию: embed-сниппет без data-host. Разъезд
    // доменов проверяется точечно — переопределением overrides в самом тесте.
    cdnOrigin: 'https://widget.aski.pro',
    ...overrides,
  };
  const app = await buildApp({
    config,
    pool,
    core: new CoreClient({ baseUrl: core.baseUrl, tenantKey: config.coreTenantKey, timeoutMs: 2000 }),
  });
  return { app, core, pool, deps: app.deps };
}
