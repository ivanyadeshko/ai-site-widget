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
      redact: { paths: ['req.headers.authorization', 'req.headers["x-core-signature"]'], remove: true },
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
    },
  });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../../embed/app/dist/assets', import.meta.url)),
    prefix: '/assets/',
    decorateReply: false, // reply.sendFile уже задекорирован первым register
    index: false,
  });

  await app.register(appPageRoutes);
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
