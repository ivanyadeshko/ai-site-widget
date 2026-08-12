import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from './config.ts';
import { healthRoutes } from './routes/health.ts';

// Плейсхолдер: T2 заносит настоящий клиент ядра (CoreClient) в свой модуль и
// заменяет этот alias на импорт оттуда. Имя типа зафиксировано контрактом T1
// уже сейчас, чтобы `AppDeps.core` не переименовывался в чужом таске.
export type CoreClient = unknown;

export type AppDeps = {
  config: AppConfig;
  pool: Pool;
  log: FastifyBaseLogger;
  core?: CoreClient; // в T2 станет обязательным
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
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
