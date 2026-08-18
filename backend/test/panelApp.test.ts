import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildTestApp } from './helpers/app.ts';
import type { FakeCore } from './helpers/fakeCore.ts';
import { PANEL_TEST_CHUNK } from './helpers/globalSetup.ts';

let app: FastifyInstance;
let core: FakeCore;
let pool: Pool;

beforeEach(async () => { ({ app, core, pool } = await buildTestApp()); });
afterEach(async () => { await app.close(); await core.stop(); await pool.end(); });

describe('раздача SPA панели с /panel', () => {
  it('корень панели отдаёт HTML-оболочку', async () => {
    const res = await app.inject({ method: 'GET', url: '/panel/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<div id="panel">');
  });

  it('глубокая ссылка отдаёт ту же оболочку, а не 404 (history-фолбэк SPA)', async () => {
    const res = await app.inject({ method: 'GET', url: '/panel/widgets/123' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="panel">');
  });

  it('несуществующий чанк отдаёт 404, а НЕ оболочку', async () => {
    // Грабли монолита «протухшие чанки после деплоя»: если на запрос
    // /assets/index-<старый-хэш>.js вернуть HTML, браузер выполнит его как
    // модуль и SPA умрёт на `Unexpected token '<'` вместо честного 404,
    // по которому роутер умеет перезагрузить страницу.
    const res = await app.inject({ method: 'GET', url: '/panel/assets/nonexistent.js' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="panel">');
  });

  it('оболочка не кэшируется и не встраивается в чужой фрейм', async () => {
    const res = await app.inject({ method: 'GET', url: '/panel/' });
    expect(res.headers['cache-control']).toContain('no-store');
    // Кабинет — не виджет: встраиваться ему некуда, кликджекинг закрыт наглухо.
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('хэшированный чанк отдаётся иммутабельно', async () => {
    const res = await app.inject({ method: 'GET', url: `/panel/assets/${PANEL_TEST_CHUNK}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('панель не ломает существующую статику виджета', async () => {
    expect((await app.inject({ method: 'GET', url: '/w.js' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/demo.html' })).statusCode).toBe(200);
  });

  it('панельный API не перехвачен SPA-фолбэком', async () => {
    // /api/v1/* обязан остаться JSON-ручкой: фолбэк ловит только /panel/*.
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });
});
