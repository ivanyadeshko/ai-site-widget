import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/app.ts';
import { testPool, truncateAll } from './helpers/db.ts';
import { buildEmbedSnippet } from '../src/widgets/snippet.ts';
import { loadConfig } from '../src/config.ts';

const pool = testPool();
let app: FastifyInstance;
let close: () => Promise<void>;

const ORIGIN = 'https://widget.aski.pro';

beforeEach(async () => {
  await truncateAll(pool);
  const built = await buildTestApp();
  app = built.app;
  close = async () => { await built.app.close(); await built.pool.end(); await built.core.stop(); };
});
afterEach(async () => { await close(); });
afterAll(async () => { await pool.end(); });

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0]! : String(raw);
  return first.split(';')[0]!;
};

describe('генератор embed-сниппета', () => {
  it('однодоменная раскладка: одна строка, без data-host', () => {
    const snippet = buildEmbedSnippet({
      token: 'wgt_00000000000000000000000000000001',
      cdnOrigin: 'https://app.vell.pro',
      publicOrigin: 'https://app.vell.pro',
    });
    expect(snippet).toBe(
      '<script src="https://app.vell.pro/w.js" data-widget="wgt_00000000000000000000000000000001" async></script>',
    );
    // Ровно одна строка: сниппет копируют глазами и вставляют руками.
    expect(snippet.split('\n')).toHaveLength(1);
  });

  it('CDN отдельным доменом — добавляется data-host, иначе API уедет в CDN', () => {
    // Шим считает base из me.src (embed/loader/scripts/make-shim.mjs:13). На
    // раскладке cdn.vell.pro + app.vell.pro без data-host лоадер бил бы
    // /w/v1/... в CDN-хост, где API нет вовсе. Ключевой стык мультидомена.
    const snippet = buildEmbedSnippet({
      token: 'wgt_00000000000000000000000000000001',
      cdnOrigin: 'https://cdn.vell.pro',
      publicOrigin: 'https://app.vell.pro',
    });
    expect(snippet).toContain('src="https://cdn.vell.pro/w.js"');
    expect(snippet).toContain('data-host="https://app.vell.pro/"');
    expect(snippet).toContain('async');
  });

  it('токен экранируется: кавычкой атрибут не разорвать', () => {
    // После Task 6 такой токен невозможен (generatePublishToken), но функция
    // обязана быть безопасной сама по себе: её позовут из панели и из e2e.
    const snippet = buildEmbedSnippet({
      token: 'wgt_"><script>alert(1)</script>',
      cdnOrigin: 'https://cdn.vell.pro',
      publicOrigin: 'https://cdn.vell.pro',
    });
    expect(snippet).not.toContain('<script>alert(1)');
    expect(snippet).toContain('&quot;&gt;&lt;script&gt;');
    // Открывающих тегов ровно один — свой.
    expect(snippet.match(/<script/g)).toHaveLength(1);
  });

  it('cdnOrigin по умолчанию равен публичному origin — существующие стенды без правки .env', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x/y', CORE_BASE_URL: 'https://core.example',
      CORE_TENANT_KEY: 'sk_x', CORE_WEBHOOK_SECRET: 'секрет-длиной-больше-шестнадцати',
      WIDGET_PUBLIC_ORIGIN: 'https://app.vell.pro/', WIDGET_CSP_CONNECT_SRC: "'self'",
      IP_HASH_SALT: 'соль',
    } as NodeJS.ProcessEnv);
    expect(config.cdnOrigin).toBe('https://app.vell.pro');

    const split = loadConfig({
      DATABASE_URL: 'postgres://x/y', CORE_BASE_URL: 'https://core.example',
      CORE_TENANT_KEY: 'sk_x', CORE_WEBHOOK_SECRET: 'секрет-длиной-больше-шестнадцати',
      WIDGET_PUBLIC_ORIGIN: 'https://app.vell.pro', WIDGET_CSP_CONNECT_SRC: "'self'",
      IP_HASH_SALT: 'соль', WIDGET_CDN_ORIGIN: 'https://cdn.vell.pro/',
    } as NodeJS.ProcessEnv);
    expect(split.cdnOrigin).toBe('https://cdn.vell.pro');
  });

  it('embed_snippet заполнен во ВСЕХ проекциях панели и меняется вместе с токеном', async () => {
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      headers: { origin: ORIGIN }, payload: { email: 'snip@example.com', password: 'пароль-владельца' },
    });
    const cookie = cookieOf(reg);
    const created = await app.inject({
      method: 'POST', url: '/api/v1/widgets', headers: { origin: ORIGIN, cookie },
      payload: {
        name: 'Виджет магазина',
        agent_config: { instructions: 'Ты консультант магазина.' },
        allowed_origins: ['https://shop.example'],
      },
    });
    const widget = created.json().widget;
    expect(widget.embed_snippet).toContain(`data-widget="${widget.publish_token}"`);
    expect(widget.embed_snippet).toContain('/w.js');

    const list = await app.inject({ method: 'GET', url: '/api/v1/widgets', headers: { cookie } });
    expect(list.json().widgets[0].embed_snippet).toBe(widget.embed_snippet);

    const read = await app.inject({
      method: 'GET', url: `/api/v1/widgets/${widget.id}`, headers: { cookie },
    });
    expect(read.json().widget.embed_snippet).toBe(widget.embed_snippet);

    // Ротация токена обязана переписать сниппет: старый после неё мёртв.
    const rotated = await app.inject({
      method: 'POST', url: `/api/v1/widgets/${widget.id}/rotate-token`,
      headers: { origin: ORIGIN, cookie },
    });
    const fresh = rotated.json().widget;
    expect(fresh.embed_snippet).toContain(`data-widget="${fresh.publish_token}"`);
    expect(fresh.embed_snippet).not.toContain(widget.publish_token);
  });
});

describe('демо-страница', () => {
  it('demo.html берёт токен из ?token= и не содержит зашитого плейсхолдера', async () => {
    const res = await app.inject({ method: 'GET', url: '/demo.html' });
    expect(res.statusCode).toBe(200);
    // Прежний зашитый плейсхолдер требовал пересборки образа под каждый токен.
    expect(res.body).not.toContain('ПОДСТАВИТЬ_PUBLISH_TOKEN');
    expect(res.body).toContain('token');
    // Токен ставится атрибутом, а не склейкой HTML: иначе демо-страница сама
    // стала бы XSS-полигоном для любого, кто пришлёт ссылку с ?token=.
    expect(res.body).toContain('setAttribute');
    expect(res.body).not.toContain('innerHTML');
  });
});
