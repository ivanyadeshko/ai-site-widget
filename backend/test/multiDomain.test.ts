import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildTestApp } from './helpers/app.ts';
import type { FakeCore } from './helpers/fakeCore.ts';
import { seedWidget, truncateAll } from './helpers/db.ts';

/**
 * Мультидоменная раскладка: iframe и API на app.vell.pro, статика лоадера на
 * cdn.vell.pro, лендинг на apex. Пока origin был один (`WIDGET_PUBLIC_ORIGIN`),
 * разъезд ломался в четырёх местах сразу — CORS-эхо `/config`, `app_url` в нём
 * же, отсутствие CORS у статики и «доверенный origin» в Origin-guard.
 */
const APP_ORIGIN = 'https://app.vell.pro';
const CDN_ORIGIN = 'https://cdn.vell.pro';
const SHOP = 'https://shop.example';

// Файлы, которых в чистом чекауте нет: хэшированный бандл лоадера пишет
// make-shim.mjs после `vite build`, ассеты iframe-приложения — `vite build`
// в embed/app. Тест проверяет ЗАГОЛОВКИ отдачи, поэтому файлы обязаны реально
// существовать: `setHeaders` вызывается только когда файл найден.
const LOADER_DIST = fileURLToPath(new URL('../../embed/loader/dist/', import.meta.url));
const APP_ASSETS = fileURLToPath(new URL('../../embed/app/dist/assets/', import.meta.url));
const HASHED_BUNDLE = `${LOADER_DIST}w.MdTest01.js`;
const APP_ASSET = `${APP_ASSETS}multidomain-test.js`;

let app: FastifyInstance;
let core: FakeCore;
let pool: Pool;

beforeAll(() => {
  mkdirSync(LOADER_DIST, { recursive: true });
  mkdirSync(APP_ASSETS, { recursive: true });
  writeFileSync(HASHED_BUNDLE, '/* тестовый хэшированный бандл лоадера */\n');
  writeFileSync(APP_ASSET, '/* тестовый ассет iframe-приложения */\n');
});
afterAll(() => {
  // Убираем ровно свои файлы: настоящую сборку `dist` трогать нельзя.
  rmSync(HASHED_BUNDLE, { force: true });
  rmSync(APP_ASSET, { force: true });
});

beforeEach(async () => {
  ({ app, core, pool } = await buildTestApp({
    appOrigin: APP_ORIGIN,
    publicOrigin: APP_ORIGIN,
    cdnOrigin: CDN_ORIGIN,
    panelOrigin: APP_ORIGIN,
  }));
  await truncateAll(pool);
});
afterEach(async () => { await app.close(); await core.stop(); await pool.end(); });

describe('мультидомен app/cdn: публичный API', () => {
  it('CORS-эхо и Vary: Origin для разрешённого сайта — регресс на однодоменное поведение', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [SHOP] });
    const res = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: SHOP } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(SHOP);
    expect(res.headers.vary).toContain('Origin');
  });

  it('app_url строится из appOrigin, а НЕ из cdnOrigin — иначе iframe уедет на хост без API и сессии', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [SHOP] });
    const res = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: SHOP } });
    expect(res.json().app_url).toBe(`${APP_ORIGIN}/app/${token}`);
    expect(res.json().app_url).not.toContain('cdn.');
  });

  it('appOrigin доверен Origin-guard всегда: запрос из самого iframe проходит, даже если его нет в allowed_origins', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [SHOP] });
    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: APP_ORIGIN },
      payload: { visitor_key: 'не-uuid' },
    });
    // 422 (невалидный visitor_key), а НЕ 403: Origin-guard пропустил.
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_visitor_key');
  });

  it('cdnOrigin доверенным НЕ становится: с CDN-хоста в API никто не ходит', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [SHOP] });
    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: CDN_ORIGIN },
      payload: { visitor_key: '11111111-1111-4111-8111-111111111111' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('origin_not_allowed');
  });
});

describe('мультидомен app/cdn: статика лоадера', () => {
  it('шим /w.js отдаётся с Access-Control-Allow-Origin: * — его тянет чужой сайт кросс-доменно', async () => {
    const res = await app.inject({ method: 'GET', url: '/w.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('хэшированный бандл /w.<hash>.js — тоже с CORS и с иммутабельным кэшем', async () => {
    const res = await app.inject({ method: 'GET', url: '/w.MdTest01.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('/assets/* iframe-приложения — с CORS: без него ассеты не загрузятся с CDN-хоста', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/multidomain-test.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('мультидомен app/cdn: CSP страницы iframe', () => {
  it('connect-src берётся из WIDGET_CSP_CONNECT_SRC, frame-ancestors — по-прежнему только allowed_origins', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [SHOP] });
    const built = await buildTestApp({
      appOrigin: APP_ORIGIN, publicOrigin: APP_ORIGIN, cdnOrigin: CDN_ORIGIN, panelOrigin: APP_ORIGIN,
      cspConnectSrc: "'self' wss://lk.example https://lk.example",
    });
    try {
      const res = await built.app.inject({ method: 'GET', url: `/app/${token}` });
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toContain("connect-src 'self' wss://lk.example https://lk.example");
      expect(csp).toContain(`frame-ancestors 'self' ${SHOP}`);
      // Разъезд доменов НЕ расширяет frame-ancestors: право встраивания даёт
      // только список сайтов владельца, а не наша собственная раскладка.
      expect(csp).not.toContain(CDN_ORIGIN);
    } finally {
      await built.app.close(); await built.core.stop(); await built.pool.end();
    }
  });
});

describe('мультидомен app/cdn: кука панели не живёт на публичном пути', () => {
  it('ни /w/v1/*, ни /w.js не ставят Set-Cookie — куке панели на чужом сайте делать нечего', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [SHOP] });
    const config = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: SHOP } });
    expect(config.headers['set-cookie']).toBeUndefined();
    const loader = await app.inject({ method: 'GET', url: '/w.js' });
    expect(loader.headers['set-cookie']).toBeUndefined();
  });

  it('присланная кука сессии публичный путь не трогает: ответ тот же и без продления сессии', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [SHOP] });
    const res = await app.inject({
      method: 'GET', url: `/w/v1/${token}/config`,
      headers: { origin: SHOP, cookie: 'vell_sid=подделанный-токен-сессии' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
