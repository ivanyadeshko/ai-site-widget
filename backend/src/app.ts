import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import type { AppConfig } from './config.ts';
import type { CoreClient } from './core/client.ts';
import { appPageRoutes } from './routes/appPage.ts';
import { coreWebhookRoutes } from './routes/coreWebhooks.ts';
import { healthRoutes } from './routes/health.ts';
import { panelRoutes } from './routes/panel/index.ts';
import { panelAppRoutes } from './routes/panelApp.ts';
import { publicApiRoutes } from './routes/publicApi.ts';

export type AppDeps = {
  config: AppConfig;
  pool: Pool;
  log: FastifyBaseLogger;
  core: CoreClient;
};

/** То, что передаёт вызывающий: логгер рождается вместе с инстансом Fastify. */
export type AppDepsInput = Omit<AppDeps, 'log'>;

export async function buildApp(input: AppDepsInput): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: input.config.logLevel,
      // Структурный JSON: стенд собирает логи grep'ом по полям, не по тексту.
      // Кука сессии панели — долгоживущий секрет: даже если будущая
      // кастомизация сериализатора начнёт логировать заголовки, токен не
      // должен утечь в логи (находка кросс-ревью потока I).
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-core-signature"]',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        remove: true,
      },
    },
    // trustProxy НЕ включаем на дев-раскладке: сервис слушает :8200 напрямую,
    // и доверие к X-Forwarded-For позволило бы обойти IP-кап одним заголовком.
    trustProxy: input.config.trustProxy,
    bodyLimit: 64 * 1024,
    disableRequestLogging: false,
  });

  const deps: AppDeps = { ...input, log: app.log };
  app.decorate('deps', deps);
  await app.register(healthRoutes);
  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });
  await app.register(publicApiRoutes);
  await app.register(coreWebhookRoutes);

  // Порядок обязателен: cookie — ДО панельных роутов (иначе req.cookies нет),
  // панель — ПОСЛЕ rateLimit (лимитер обязан быть зарегистрирован раньше
  // потребителей) и ДО fastifyStatic с prefix '/' (иначе статика перехватит
  // путь раньше роутов).
  await app.register(cookie);
  await app.register(panelRoutes, { prefix: '/api/v1' });

  // SPA кабинета — ДО корневой статики: та смотрит на embed/loader/dist и
  // embed/public с prefix '/', и зарегистрированная раньше перехватила бы
  // /panel/* своим 404 вместо history-фолбэка панели.
  await app.register(panelAppRoutes, { prefix: '/panel' });

  await app.register(fastifyStatic, {
    // Порядок важен: первый корень, где нашёлся файл, побеждает.
    root: [
      fileURLToPath(new URL('../../embed/loader/dist', import.meta.url)), // /w.js, /w.<hash>.js
      fileURLToPath(new URL('../../embed/public', import.meta.url)),      // /demo.html
    ],
    prefix: '/',
    index: false,
    // Хэшированный бандл иммутабелен; шим обязан протухать быстро.
    // ДЕВИАЦИЯ от буквы брифа: брифовский `res.setHeader(...)` писан под
    // @fastify/static@8, где колбэк получал сырой Node ServerResponse. Пакет
    // здесь поднят до @fastify/static@10.1.3 (см. ниже, почему) — там сигнатура
    // `setHeaders` сменилась на `(reply: FastifyReply, path, stat)`, и метод —
    // `reply.header(...)`, а не `res.setHeader(...)`.
    setHeaders: (reply, path) => {
      reply.header('Cache-Control', /w\.[^.]+\.js$/.test(path)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=60');
      // CORS настежь. Классический `<script src>` (как в нашем сниппете, без
      // атрибута crossorigin) заголовка НЕ требует — не будем этого
      // приукрашивать. Он нужен всему остальному, чем этот файл бывает:
      // `fetch`/`import()` из скрипта чужого сайта, `<script type="module">`,
      // sourcemap-запрос девтулзов, и вообще любой доступ к CDN-хосту из
      // кода страницы. Безопасно: файлы публичны по назначению, кук не
      // читают и данных аккаунта не несут — раздача ничем не отличается от
      // любого CDN.
      reply.header('Access-Control-Allow-Origin', '*');
    },
  });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../../embed/app/dist/assets', import.meta.url)),
    prefix: '/assets/',
    decorateReply: false, // reply.sendFile уже задекорирован первым register
    index: false,
    // Тот же заголовок для ассетов iframe-приложения.
    //
    // ЧЕСТНО О ТЕКУЩЕМ СОСТОЯНИИ (уточнено кросс-ревью): СЕГОДНЯ эти файлы с
    // CDN-хоста никто не грузит. `embed/app` собран с `base: '/'`, поэтому
    // страница `/app/:token` тянет `/assets/…` со СВОЕГО хоста (app.vell.pro),
    // а CSP этой страницы (`script-src 'self'`, appPage.ts) чужой origin и не
    // пропустила бы. Чтобы ассеты реально поехали на cdn.vell.pro, нужны ещё
    // две правки, и обе — вне этапа E: `base` в vite-конфиге embed/app и
    // добавление cdnOrigin в script-src/style-src CSP. Заголовок стоит здесь
    // заранее (и потому, что того требует спека Task 24) — вреда от него нет,
    // а забыть его при переезде было бы легко.
    //
    // Панельная статика (`/panel/assets/`, panelApp.ts) заголовка намеренно НЕ
    // получает: она живёт на одном хосте с кукой сессии, и кросс-доменный
    // доступ ей не нужен.
    setHeaders: (reply) => {
      reply.header('Access-Control-Allow-Origin', '*');
    },
  });

  await app.register(appPageRoutes);
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
