import type { FastifyPluginAsync } from 'fastify';
import { requireSameOrigin } from '../../auth/guards.ts';
import { ApiError, sendApiError } from '../../http/errors.ts';
import { authRoutes } from './auth.ts';
import { dialogRoutes } from './dialogs.ts';
import { leadRoutes } from './leads.ts';
import { usageRoutes } from './usage.ts';
import { widgetRoutes } from './widgets.ts';

/**
 * Плагин панельного API. Регистрируется с `{ prefix: '/api/v1' }`.
 *
 * ГОЧА ENCAPSULATION FASTIFY: `setErrorHandler` действует ТОЛЬКО в скоупе
 * плагина, в котором вызван. У публичного API (`publicApi.ts`) свой такой же —
 * он остаётся при своём. Без собственного обработчика здесь `ApiError` уехал
 * бы в дефолтный 500-обработчик Fastify и потерял `code`, на который завязан
 * весь клиент панели.
 */
export const panelRoutes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return sendApiError(reply, err);
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    const message = err instanceof Error ? err.message : 'ошибка без сообщения';
    // @fastify/rate-limit бросает ОБЫЧНЫЙ Error со statusCode=429 — без этой
    // ветки упор в лимит отдавал бы 500 (тот же баг ловили в публичном API).
    if (statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message } });
    }
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: { code: 'request_error', message } });
    }
    app.log.error({ err }, 'необработанная ошибка панельного API');
    return reply.code(500).send({ error: { code: 'internal', message: 'Внутренняя ошибка.' } });
  });

  // CSRF-барьер на ВЕСЬ панельный префикс разом: гард на каждом роуте по
  // отдельности легко забыть в новой ручке, а цена забывчивости — дыра.
  app.addHook('preHandler', requireSameOrigin);

  // Каждая панельная ручка регистрируется ДОЧЕРНИМ плагином ИМЕННО ЗДЕСЬ —
  // только внутри этого скоупа она наследует CSRF-хук и формат ошибок выше.
  await app.register(authRoutes);
  await app.register(widgetRoutes);
  await app.register(leadRoutes);
  await app.register(dialogRoutes);
  await app.register(usageRoutes);
};
