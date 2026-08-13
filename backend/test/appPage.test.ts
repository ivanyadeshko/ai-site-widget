import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildTestApp } from './helpers/app.ts';
import type { FakeCore } from './helpers/fakeCore.ts';
import { seedWidget, truncateAll } from './helpers/db.ts';

let app: FastifyInstance;
let core: FakeCore;
let pool: Pool;

beforeEach(async () => {
  ({ app, core, pool } = await buildTestApp());
  await truncateAll(pool);
});
afterEach(async () => { await app.close(); await core.stop(); await pool.end(); });

describe('GET /app/:token', () => {
  it('CSP несёт frame-ancestors из allowed_origins — единственная НАСТОЯЩАЯ защита от встраивания', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: ['https://shop.example', 'https://www.shop.example'] });
    const res = await app.inject({ method: 'GET', url: `/app/${token}` });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("frame-ancestors 'self' https://shop.example https://www.shop.example");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers['x-frame-options']).toBeUndefined(); // XFO не умеет список — только CSP
  });

  it('пустой allowed_origins → frame-ancestors none', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [] });
    const res = await app.inject({ method: 'GET', url: `/app/${token}` });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('токен прокидывается в страницу, но НЕ через innerHTML-инъекцию', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: ['https://shop.example'] });
    const res = await app.inject({ method: 'GET', url: `/app/${token}` });
    expect(res.body).toContain(`data-widget-token="${token}"`);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('неизвестный токен → 404 без раскрытия', async () => {
    expect((await app.inject({ method: 'GET', url: '/app/нет-такого' })).statusCode).toBe(404);
  });
});
