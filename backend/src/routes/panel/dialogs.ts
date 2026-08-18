import type { FastifyPluginAsync } from 'fastify';
import { requireAccount } from '../../auth/guards.ts';
import { findDialogForAccount, listDialogsByAccount, type DialogListRow } from '../../db/repositories/dialogs.ts';
import { listThreadPage } from '../../db/repositories/messages.ts';
import { ApiError } from '../../http/errors.ts';
import { pageOf, parseCursor, parseLimit } from '../../panel/pagination.ts';
import { resolveWidgetFilter } from '../../panel/widgetScope.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Курсор ленты — id из BIGSERIAL, то есть только цифры. */
const BIGINT_RE = /^\d{1,19}$/;
const THREAD_PAGE_DEFAULT = 100;

type ListQuery = { widget_id?: string; limit?: string; cursor?: string };
type ThreadQuery = { limit?: string; after_id?: string };

/** Наружу уезжает РОВНО это: служебная метка курсора остаётся внутри. */
const toPublicDialog = (row: DialogListRow) => ({
  id: row.id,
  widget_id: row.widget_id,
  widget_name: row.widget_name,
  status: row.status,
  channel: row.current_channel,
  messages_count: row.messages_count,
  has_lead: row.has_lead,
  // Деньги отдаются как есть: округление или пересчёт на лету разошлись бы с
  // тем, что показывают экраны использования и админка по тем же строкам.
  usage: row.usage,
  credits_total: row.credits_total,
  started_at: row.started_at,
  ended_at: row.ended_at,
  last_activity_at: row.last_activity_at,
});

export const dialogRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAccount);

  app.get<{ Querystring: ListQuery }>(
    '/dialogs',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const accountId = req.account!.id;
      const widgetId = await resolveWidgetFilter(app.deps.pool, req.query.widget_id, accountId);
      const limit = parseLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);

      const rows = await listDialogsByAccount(app.deps.pool, { accountId, widgetId, limit: limit + 1, cursor });
      const { page, nextCursor } = pageOf(rows, limit, (row) => ({ at: row.cursor_at, id: row.id }));
      return reply.send({ dialogs: page.map(toPublicDialog), next_cursor: nextCursor });
    },
  );

  app.get<{ Params: { id: string }; Querystring: ThreadQuery }>(
    '/dialogs/:id/messages',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const notFound = (): ApiError => new ApiError(404, 'dialog_not_found', 'Диалог не найден.');
      // Кривой uuid в пути — 404, а не 500: `WHERE id = 'не-uuid'` роняет
      // Postgres ошибкой 22P02 ещё до всякой логики.
      if (!UUID_RE.test(req.params.id)) throw notFound();
      const dialog = await findDialogForAccount(app.deps.pool, req.params.id, req.account!.id);
      if (!dialog) throw notFound();

      const limit = parseLimit(req.query.limit, THREAD_PAGE_DEFAULT);
      const afterId = req.query.after_id ?? null;
      if (afterId !== null && !BIGINT_RE.test(afterId)) {
        throw new ApiError(422, 'invalid_after_id', 'after_id — идентификатор реплики из предыдущей страницы.');
      }

      const rows = await listThreadPage(app.deps.pool, dialog.id, { limit: limit + 1, afterId });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return reply.send({
        dialog_id: dialog.id,
        status: dialog.status,
        messages: page.map((row) => ({
          id: row.id,
          role: row.role,
          text: row.text,
          // Владелец обязан отличать подтверждённую ядром реплику (`core`) от
          // оптимистичной клиентской (`client`): вторая приехала со страницы
          // посетителя и в пределе может быть подделана.
          source: row.source,
          seq: row.seq,
          created_at: row.created_at,
        })),
        // Полная страница ещё не значит «есть продолжение» — отвечает лишняя
        // прочитанная строка, а не догадка клиента.
        next_after_id: hasMore ? page[page.length - 1]!.id : null,
      });
    },
  );
};
