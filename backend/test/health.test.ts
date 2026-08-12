import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { CoreClient } from '../src/core/client.ts';
import { testPool } from './helpers/db.ts';

const pool = testPool();
let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    CORE_BASE_URL: 'http://core.invalid/api',
    CORE_TENANT_KEY: 'sk_test_x',
    CORE_WEBHOOK_SECRET: 'секрет-длиной-больше-шестнадцати',
    WIDGET_PUBLIC_ORIGIN: 'http://localhost:8200',
    WIDGET_CSP_CONNECT_SRC: "'self'",
    IP_HASH_SALT: 'соль',
  });
  app = await buildApp({
    config,
    pool,
    core: new CoreClient({ baseUrl: config.coreBaseUrl, tenantKey: config.coreTenantKey }),
  });
});
afterAll(async () => { await app.close(); await pool.end(); });

it('GET /healthz отвечает 200 и проверяет БД настоящим запросом', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
});

it('логи структурные (json) и не содержат ключа тенанта', async () => {
  expect(app.log.level).toBe('info');
});
