import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async (_req, reply) => {
    try {
      await app.deps.pool.query('SELECT 1');
    } catch (err) {
      app.log.error({ err }, 'healthz: БД недоступна');
      return reply.code(503).send({ status: 'degraded', db: 'fail' });
    }
    return reply.send({ status: 'ok', db: 'ok' });
  });
};
