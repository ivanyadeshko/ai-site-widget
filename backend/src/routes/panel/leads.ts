import { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { requireAccount } from '../../auth/guards.ts';
import { listLeadsByAccount, streamLeadsByAccount, type LeadListRow } from '../../db/repositories/leads.ts';
import { CSV_BOM, csvLine } from '../../panel/csv.ts';
import { pageOf, parseCursor, parseLimit } from '../../panel/pagination.ts';
import { parseOptionalPeriod } from '../../panel/period.ts';
import { resolveWidgetFilter } from '../../panel/widgetScope.ts';

/** Шапка выгрузки. Порядок колонок — часть контракта: на него смотрит владелец. */
const CSV_HEADER = ['created_at', 'widget', 'name', 'phone', 'email', 'comment'];

type ListQuery = { widget_id?: string; limit?: string; cursor?: string };
type ExportQuery = { widget_id?: string; from?: string; to?: string };

/**
 * Наружу уезжает РОВНО это: служебная метка курсора (`cursor_at`) остаётся
 * внутри — клиент листает по непрозрачному `next_cursor`, и вторая метка
 * времени в строке только сбивала бы с толку.
 */
const toPublicLead = (row: LeadListRow) => ({
  id: row.id,
  created_at: row.created_at,
  widget_id: row.widget_id,
  widget_name: row.widget_name,
  dialog_id: row.dialog_id,
  name: row.name,
  phone: row.phone,
  email: row.email,
  comment: row.comment,
});

/** Строки CSV по одной, как только они приехали из БД: в память ложится батч, не таблица. */
async function* csvBody(rows: AsyncGenerator<LeadListRow>): AsyncGenerator<string> {
  yield CSV_BOM + csvLine(CSV_HEADER);
  for await (const row of rows) {
    yield csvLine([row.created_at, row.widget_name, row.name, row.phone, row.email, row.comment]);
  }
}

export const leadRoutes: FastifyPluginAsync = async (app) => {
  // Гард на весь скоуп плагина: новая ручка лидов не может «забыть» вход.
  app.addHook('preHandler', requireAccount);

  /**
   * Лимит здесь ОБЯЗАТЕЛЕН (вводная кросс-ревью потоков II+III): @fastify/rate-limit
   * зарегистрирован с `global:false`, то есть GET-ручки панели по умолчанию без
   * потолка вовсе. А лиды — персональные данные посетителей чужих сайтов:
   * украденная кука без лимита выкачивает всю базу в один поток.
   *
   * Ключ лимитера — IP (штатный keyGenerator из app.ts): requireAccount живёт на
   * preHandler, то есть ПОЗЖЕ onRequest-хука лимитера, и аккаунта в момент
   * подсчёта ещё нет.
   */
  app.get<{ Querystring: ListQuery }>(
    '/leads',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const accountId = req.account!.id;
      const widgetId = await resolveWidgetFilter(app.deps.pool, req.query.widget_id, accountId);
      const limit = parseLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);

      // Спрашиваем на строку больше запрошенного: только так видно, есть ли
      // продолжение (см. pageOf).
      const rows = await listLeadsByAccount(app.deps.pool, {
        accountId, widgetId, limit: limit + 1, cursor,
      });
      const { page, nextCursor } = pageOf(rows, limit, (row) => ({ at: row.cursor_at, id: row.id }));
      return reply.send({ leads: page.map(toPublicLead), next_cursor: nextCursor });
    },
  );

  /**
   * Выгрузка CSV — самая тяжёлая ручка кабинета: один запрос читает ВСЕ лиды
   * отбора. Потолок вшестеро строже листинга, и ответ уходит ПОТОКОМ —
   * `Readable.from` над генератором репозитория, без промежуточного массива.
   */
  app.get<{ Querystring: ExportQuery }>(
    '/leads.csv',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const accountId = req.account!.id;
      const widgetId = await resolveWidgetFilter(app.deps.pool, req.query.widget_id, accountId);
      const { from, to } = parseOptionalPeriod(req.query.from, req.query.to);

      // Имя файла — только ASCII: кириллица в значении заголовка валит Node
      // (ERR_INVALID_CHAR, Constraint 11), а дата в имени спасает владельца от
      // папки из десяти файлов «leads.csv».
      const day = new Date().toISOString().slice(0, 10);
      reply.header('Content-Disposition', `attachment; filename="leads-${day}.csv"`);
      // Выгрузка персональных данных не должна оседать ни в одном кэше.
      reply.header('Cache-Control', 'no-store');
      return reply
        .type('text/csv; charset=utf-8')
        .send(Readable.from(csvBody(streamLeadsByAccount(app.deps.pool, { accountId, widgetId, from, to }))));
    },
  );
};
