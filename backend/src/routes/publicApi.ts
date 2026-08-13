import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { CoreHttpError } from '../core/client.ts';
import { findDialogById, setDialogStatus, touchDialog, type DialogRow } from '../db/repositories/dialogs.ts';
import { insertLead } from '../db/repositories/leads.ts';
import { insertMessage, listThreadTail, maxClientSeq } from '../db/repositories/messages.ts';
import { hashIp } from '../db/repositories/quotas.ts';
import { findWidgetByToken, type WidgetRow } from '../db/repositories/widgets.ts';
import { ApiError, mapCoreError, sendApiError } from '../http/errors.ts';
import { originVerdict } from '../http/originGuard.ts';
import { checkSessionBudget } from '../dialogs/budget.ts';
import { reenterDialog } from '../dialogs/reenter.ts';
import { MESSAGES_PAGE, startDialog, toPublicMessage } from '../dialogs/startDialog.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEXT_MAX = 2000; // воркер режет ровно тут — режем сами, чтобы журнал совпал с лентой
const SEQ_MAX = 2147483647; // Postgres INTEGER (dialog_messages.seq) — больше не влезет, упало бы 500

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
    // ФИКС-РАУНД 1 (найдено НЕ по предсказанию, а по факту красного теста
    // лид-спама): @fastify/rate-limit при превышении лимита бросает ОБЫЧНЫЙ
    // Error с полем .statusCode=429, а не ApiError — без этой ветки он
    // проваливался бы в generic 500 ниже, и КАЖДЫЙ клиент, упёршийся в ЛЮБОЙ
    // рейт-лимит на ЛЮБОМ роуте (включая уже существовавшие /dialogs,
    // /reenter, /messages, /config), получал бы 500 internal вместо честного
    // 429. Баг был в коде с самого T3, просто ни один тест до сих пор не
    // доводил ни один роут до реального упора в лимит.
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    const message = err instanceof Error ? err.message : 'ошибка без сообщения';
    if (statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message } });
    }
    // Прочие фреймворк-ошибки со своим statusCode (body too large, bad
    // content-type и т.п. от самого Fastify) — тоже НЕ 500: у них уже есть
    // осмысленный код ответа, наше дело не портить его в generic internal.
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: { code: 'request_error', message } });
    }
    app.log.error({ err }, 'необработанная ошибка публичного API');
    return reply.code(500).send({ error: { code: 'internal', message: 'Внутренняя ошибка.' } });
  });

  // РАЗОВЫЙ диагностический warn (один раз за жизнь этого инстанса, не на
  // каждый запрос — иначе атакующий флудит логи тем же заголовком). IP-кап
  // считает по req.ip, а при trustProxy=false это адрес СОКЕТА, не значение
  // X-Forwarded-For (см. app.ts и caps.test.ts «X-Forwarded-For НЕ подменяет
  // IP»). Это верно и безопасно СЕЙЧАС (сервис слушает напрямую), но если
  // когда-нибудь за инстансом встанет реальный реверс-прокси, а TRUST_PROXY
  // забудут включить, req.ip станет одним и тем же адресом прокси для ВСЕХ
  // клиентов — IP-кап схлопнёт их в один бакет и начнёт валить легитимные
  // старты 429 без единой диагностической зацепки в логах.
  let xffMismatchWarned = false;
  app.addHook('onRequest', async (req) => {
    if (xffMismatchWarned || app.deps.config.trustProxy) return;
    if (req.headers['x-forwarded-for'] === undefined) return;
    xffMismatchWarned = true;
    app.log.warn(
      { xForwardedFor: req.headers['x-forwarded-for'], remoteAddress: req.ip },
      'X-Forwarded-For пришёл, но TRUST_PROXY выключен — IP-кап продолжает считать по адресу сокета, не по заголовку; за реальным прокси без TRUST_PROXY=1 это схлопнёт всех клиентов в один IP',
    );
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
      if (!Number.isInteger(seq) || seq < 1 || seq > SEQ_MAX) {
        throw new ApiError(422, 'invalid_seq', `seq — целое от 1 до ${SEQ_MAX}.`);
      }

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
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
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
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, true);
      const visitorKey = requireVisitorKey(req.body?.visitor_key);
      const dialog = await requireOwnedDialog(req, widget, req.params.id, visitorKey);
      if (dialog.current_core_session_id) {
        // ФИКС-РАУНД 1: раньше не обёрнут — недоступность ядра падала НЕ
        // пойманным CoreHttpError и уходила в 500 internal вместо честного
        // mapCoreError (502/503/504).
        try {
          await app.deps.core.endSession(dialog.current_core_session_id);
        } catch (err) {
          if (err instanceof CoreHttpError) throw mapCoreError(err);
          throw err;
        }
      }
      await setDialogStatus(app.deps.pool, dialog.id, 'ended');
      return reply.send({ dialog_id: dialog.id, status: 'ended' });
    },
  );

  app.post<{ Params: { token: string; id: string }; Body: Record<string, unknown> }>(
    '/w/v1/:token/dialogs/:id/lead',
    // Лид легитимно подаётся раз на диалог (возможно, с парой ретраев на
    // валидацию); 100 попыток за минуту — спам, воспроизведённый адверсарием.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
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
  // гардов + read-only checkSessionBudget — то, что должно защищать ЛЮБОЙ путь
  // создания платной сессии (решение №3 брифа T3), и что уже проверяет
  // caps.test.ts. Сама эскалация (continue_from между каналами, закрытие
  // текущей chat-сессии, выдача voice-токена) — предмет T4; успешный путь тут
  // намеренно не собран, роут отвечает 501.
  //
  // ФИКС-РАУНД 1: НЕ ensureSessionBudget (бампающая) — эта заглушка сама
  // сессию не создаёт, только проверяет, влез бы будущий вызов в капы.
  // Бамп здесь заставил бы клиентские ретраи ВЕЧНО падающего 501-эндпоинта
  // (до T4) незаметно съедать суточную квоту легитимного визитора ещё до
  // того, как он реально попробует начать разговор — см. caps.test.ts.
  // T4: заменить ТЕЛО этого роута на настоящую эскалацию (и checkSessionBudget
  // на ensureSessionBudget внутри неё, раз она наконец реально создаёт
  // сессию) — маршрут уже существует, НЕ регистрировать новый.
  app.post<{ Params: { token: string; id: string }; Body: { visitor_key?: unknown } }>(
    '/w/v1/:token/dialogs/:id/escalate',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, true);
      const visitorKey = requireVisitorKey(req.body?.visitor_key);
      await requireOwnedDialog(req, widget, req.params.id, visitorKey);
      await checkSessionBudget(app.deps, {
        visitorKey, ipHash: hashIp(req.ip, app.deps.config.ipHashSalt),
      });
      throw new ApiError(501, 'not_implemented', 'Эскалация реализуется в T4.');
    },
  );
};
