import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { findDialogById, setDialogStatus, touchDialog, type DialogRow } from '../db/repositories/dialogs.ts';
import { insertLead } from '../db/repositories/leads.ts';
import { insertMessage, listThreadTail, maxClientSeq } from '../db/repositories/messages.ts';
import { hashIp } from '../db/repositories/quotas.ts';
import { findWidgetByToken, type WidgetRow } from '../db/repositories/widgets.ts';
import { ApiError, sendApiError } from '../http/errors.ts';
import { originVerdict } from '../http/originGuard.ts';
import { ensureSessionBudget } from '../dialogs/budget.ts';
import { reenterDialog } from '../dialogs/reenter.ts';
import { MESSAGES_PAGE, startDialog, toPublicMessage } from '../dialogs/startDialog.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEXT_MAX = 2000; // воркер режет ровно тут — режем сами, чтобы журнал совпал с лентой

const requireWidget = async (req: FastifyRequest, token: string, checkOrigin: boolean): Promise<WidgetRow> => {
  const widget = await findWidgetByToken(req.server.deps.pool, token);
  if (!widget) throw new ApiError(404, 'widget_not_found', 'Виджет не найден.');
  if (checkOrigin) {
    const verdict = originVerdict(widget, {
      origin: req.headers.origin,
      publicOrigin: req.server.deps.config.publicOrigin,
      method: req.method,
    });
    if (verdict === 'deny') throw new ApiError(403, 'origin_not_allowed', 'Этот сайт не разрешён для виджета.');
    if (!widget.enabled) throw new ApiError(403, 'widget_disabled', 'Виджет выключен.');
  }
  return widget;
};

const requireVisitorKey = (raw: unknown): string => {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) throw new ApiError(422, 'invalid_visitor_key', 'visitor_key должен быть UUID.');
  return raw;
};

const requireOwnedDialog = async (req: FastifyRequest, widget: WidgetRow, dialogId: string, visitorKey: string): Promise<DialogRow> => {
  const dialog = await findDialogById(req.server.deps.pool, dialogId);
  if (!dialog || dialog.widget_id !== widget.id || dialog.visitor_key !== visitorKey) {
    throw new ApiError(404, 'dialog_not_found', 'Диалог не найден.');
  }
  return dialog;
};

export const publicApiRoutes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return sendApiError(reply, err);
    app.log.error({ err }, 'необработанная ошибка публичного API');
    return reply.code(500).send({ error: { code: 'internal', message: 'Внутренняя ошибка.' } });
  });

  app.get<{ Params: { token: string } }>(
    '/w/v1/:token/config',
    // Ручка без Origin-check — единственная открытая настежь, поэтому свой
    // лимит: иначе она станет бесплатным способом щупать чужие токены.
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, false);
      const origin = req.headers.origin;
      // CORS-эхо ТОЛЬКО для разрешённых сайтов: сам ответ не секрет, но и раздавать
      // его каждому встречному незачем. Vary обязателен — кэш иначе перепутает.
      reply.header('Vary', 'Origin');
      if (origin && originVerdict(widget, { origin, publicOrigin: app.deps.config.publicOrigin, method: 'GET' }) === 'allow') {
        reply.header('Access-Control-Allow-Origin', origin);
      }
      reply.header('Cache-Control', 'public, max-age=60');
      return reply.send({
        widget_id: widget.id,
        name: widget.name,
        enabled: widget.enabled,
        allowed_origins: widget.allowed_origins,
        app_url: `${app.deps.config.publicOrigin}/app/${widget.publish_token}`,
        text_max_length: TEXT_MAX,
      });
    },
  );

  app.post<{ Params: { token: string }; Body: { visitor_key?: unknown; dialog_id?: unknown } }>(
    '/w/v1/:token/dialogs',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, true);
      const visitorKey = requireVisitorKey(req.body?.visitor_key);
      const dialogId = req.body?.dialog_id;
      if (dialogId !== undefined && (typeof dialogId !== 'string' || !UUID_RE.test(dialogId))) {
        throw new ApiError(422, 'invalid_dialog_id', 'dialog_id должен быть UUID.');
      }
      const result = await startDialog(app.deps, {
        widget, visitorKey,
        ipHash: hashIp(req.ip, app.deps.config.ipHashSalt),
        ...(typeof dialogId === 'string' ? { dialogId } : {}),
      });
      return reply.code(201).send(result);
    },
  );

  app.post<{ Params: { token: string; id: string }; Body: { visitor_key?: unknown } }>(
    '/w/v1/:token/dialogs/:id/reenter',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, true);
      const visitorKey = requireVisitorKey(req.body?.visitor_key);
      const dialog = await requireOwnedDialog(req, widget, req.params.id, visitorKey);
      return reply.send(await reenterDialog(app.deps, { widget, dialog }));
    },
  );

  app.post<{ Params: { token: string; id: string }; Body: { visitor_key?: unknown; role?: unknown; text?: unknown; seq?: unknown } }>(
    '/w/v1/:token/dialogs/:id/messages',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, true);
      const visitorKey = requireVisitorKey(req.body?.visitor_key);
      const dialog = await requireOwnedDialog(req, widget, req.params.id, visitorKey);
      const role = req.body?.role;
      if (role !== 'user' && role !== 'agent') throw new ApiError(422, 'invalid_role', 'role: user|agent.');
      const raw = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (raw.length === 0) throw new ApiError(422, 'empty_text', 'Пустой текст не пишем.');
      const seq = Number(req.body?.seq);
      if (!Number.isInteger(seq) || seq < 1) throw new ApiError(422, 'invalid_seq', 'seq — целое ≥ 1.');

      const stored = await insertMessage(app.deps.pool, {
        dialogId: dialog.id, role, text: raw.slice(0, TEXT_MAX),
        source: 'client', coreSessionId: null, seq,
      });
      await touchDialog(app.deps.pool, dialog.id);
      // 201 — записали, 200 — уже было (ре-отправка клиента при реконнекте).
      return reply.code(stored ? 201 : 200).send({ stored });
    },
  );

  app.get<{ Params: { token: string; id: string }; Querystring: { visitor_key?: string } }>(
    '/w/v1/:token/dialogs/:id/messages',
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, true);
      const visitorKey = requireVisitorKey(req.query.visitor_key);
      const dialog = await requireOwnedDialog(req, widget, req.params.id, visitorKey);
      const rows = await listThreadTail(app.deps.pool, dialog.id, MESSAGES_PAGE);
      return reply.send({
        dialog_id: dialog.id, status: dialog.status, channel: dialog.current_channel,
        messages: rows.map(toPublicMessage),
        next_seq: (await maxClientSeq(app.deps.pool, dialog.id)) + 1,
      });
    },
  );

  app.post<{ Params: { token: string; id: string }; Body: { visitor_key?: unknown } }>(
    '/w/v1/:token/dialogs/:id/end',
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, true);
      const visitorKey = requireVisitorKey(req.body?.visitor_key);
      const dialog = await requireOwnedDialog(req, widget, req.params.id, visitorKey);
      if (dialog.current_core_session_id) await app.deps.core.endSession(dialog.current_core_session_id);
      await setDialogStatus(app.deps.pool, dialog.id, 'ended');
      return reply.send({ dialog_id: dialog.id, status: 'ended' });
    },
  );

  app.post<{ Params: { token: string; id: string }; Body: Record<string, unknown> }>(
    '/w/v1/:token/dialogs/:id/lead',
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, true);
      const visitorKey = requireVisitorKey(req.body?.visitor_key);
      const dialog = await requireOwnedDialog(req, widget, req.params.id, visitorKey);
      if (req.body?.consent !== true) throw new ApiError(422, 'consent_required', 'Нужно согласие на обработку данных.');
      const str = (key: string, max: number): string | null => {
        const value = req.body?.[key];
        return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
      };
      const phone = str('phone', 40);
      const email = str('email', 200);
      if (!phone && !email) throw new ApiError(422, 'contact_required', 'Оставьте телефон или почту.');
      const id = await insertLead(app.deps.pool, {
        dialogId: dialog.id, widgetId: widget.id, name: str('name', 200),
        phone, email, comment: str('comment', 2000), consent: true,
      });
      return reply.code(201).send({ lead_id: id });
    },
  );

  // Заглушка на T4 (эскалация chat→voice, §5 спеки): здесь только цепочка
  // гардов + ensureSessionBudget — то, что должно защищать ЛЮБОЙ путь создания
  // платной сессии (решение №3 брифа T3), и что уже проверяет caps.test.ts.
  // Сама эскалация (continue_from между каналами, закрытие текущей chat-сессии,
  // выдача voice-токена) — предмет T4; успешный путь тут намеренно не собран.
  app.post<{ Params: { token: string; id: string }; Body: { visitor_key?: unknown } }>(
    '/w/v1/:token/dialogs/:id/escalate',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, true);
      const visitorKey = requireVisitorKey(req.body?.visitor_key);
      await requireOwnedDialog(req, widget, req.params.id, visitorKey);
      await ensureSessionBudget(app.deps, {
        visitorKey, ipHash: hashIp(req.ip, app.deps.config.ipHashSalt),
      });
      throw new ApiError(501, 'not_implemented', 'Эскалация реализуется в T4.');
    },
  );
};
