import type { FastifyPluginAsync } from 'fastify';
import { requireAccount } from '../../auth/guards.ts';
import { usageByDay, usageByWidget, usageTotals } from '../../db/repositories/usage.ts';
import { ApiError } from '../../http/errors.ts';
import { parseReportPeriod } from '../../panel/period.ts';
import { resolveWidgetFilter } from '../../panel/widgetScope.ts';

type UsageQuery = { from?: string; to?: string; group_by?: string; widget_id?: string };

const GROUPINGS = new Set(['day', 'widget']);

export const usageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAccount);

  /**
   * Отчёт расхода. Тяжелее листингов (разворачивает jsonb по всем диалогам
   * периода), поэтому свой потолок частоты — экран использования обновляется
   * руками, а не поллингом.
   */
  app.get<{ Querystring: UsageQuery }>(
    '/usage',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const accountId = req.account!.id;
      const widgetId = await resolveWidgetFilter(app.deps.pool, req.query.widget_id, accountId);
      const { from, to } = parseReportPeriod(req.query.from, req.query.to);
      const groupBy = req.query.group_by ?? 'day';
      if (!GROUPINGS.has(groupBy)) {
        throw new ApiError(422, 'invalid_group_by', 'group_by — «day» или «widget».');
      }

      const query = { accountId, widgetId, from, to };
      const [buckets, totals] = await Promise.all([
        groupBy === 'widget' ? usageByWidget(app.deps.pool, query) : usageByDay(app.deps.pool, query),
        // Итог считается ОТДЕЛЬНЫМ запросом, а не суммой бакетов: у среза по
        // виджетам бакеты включают виджеты без диалогов, и наивная сумма по
        // ним совпала бы случайно, а не по построению.
        usageTotals(app.deps.pool, query),
      ]);

      return reply.send({
        from: from.toISOString(),
        to: to.toISOString(),
        group_by: groupBy,
        buckets,
        totals,
      });
    },
  );
};
