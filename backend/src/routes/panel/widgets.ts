import type { FastifyPluginAsync } from 'fastify';
import { requireAccount } from '../../auth/guards.ts';
import type { AppConfig } from '../../config.ts';
import {
  countWidgetsByAccount, deleteWidget, findWidgetByIdForAccount, insertWidget,
  listWidgetsByAccount, rotatePublishToken, updateWidget,
  type WidgetPatch, type WidgetRow,
} from '../../db/repositories/widgets.ts';
import { ApiError } from '../../http/errors.ts';
import { buildEmbedSnippet } from '../../widgets/snippet.ts';
import { parseTheme, type WidgetTheme } from '../../widgets/theme.ts';
import { generatePublishToken } from '../../widgets/tokens.ts';
import {
  WIDGETS_PER_ACCOUNT_MAX, parseAgentConfig, parseAllowedOrigins, parseWidgetName,
} from '../../widgets/validation.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Наружу уезжает РОВНО это.
 *
 * `publish_token` отдаётся владельцу намеренно: он не секрет, он лежит в HTML
 * его собственного сайта.
 *
 * `theme` отдаётся СЫРОЙ, как лежит в БД: владелец правит то, что задал сам, и
 * незаполненное поле в панели обязано выглядеть незаполненным. Дефолты
 * добиваются только на публичном пути (`/w/v1/:token/config`, `themeForConfig`)
 * — иначе первое же сохранение формы вморозило бы сегодняшние дефолты в БД и
 * отняло бы у нас право их менять.
 */
export type WidgetPublic = {
  id: string;
  name: string;
  publish_token: string;
  enabled: boolean;
  allowed_origins: string[];
  agent_config: WidgetRow['agent_config'];
  created_at: Date;
  theme: WidgetTheme;
  /** Готовый <script> для вставки на сайт — собран целиком, копируется как есть. */
  embed_snippet: string;
  app_url: string;
};

const toPublic = (widget: WidgetRow, config: AppConfig): WidgetPublic => ({
  id: widget.id,
  name: widget.name,
  publish_token: widget.publish_token,
  enabled: widget.enabled,
  allowed_origins: widget.allowed_origins,
  agent_config: widget.agent_config,
  created_at: widget.created_at,
  theme: widget.theme,
  embed_snippet: buildEmbedSnippet({
    token: widget.publish_token,
    cdnOrigin: config.cdnOrigin,
    // `appOrigin` (== publicOrigin, алиас): в сниппет уезжает адрес, по
    // которому лоадер будет бить в API, а API живёт на app-хосте.
    publicOrigin: config.appOrigin,
  }),
  app_url: `${config.appOrigin}/app/${widget.publish_token}`,
});

/**
 * Кривой UUID в пути — это НЕ 500: `WHERE id = 'не-uuid'` роняет Postgres
 * ошибкой 22P02, и без этой проверки любая опечатка в адресной строке панели
 * превращалась бы во внутреннюю ошибку сервера.
 */
const notFound = (): ApiError => new ApiError(404, 'widget_not_found', 'Виджет не найден.');

export const widgetRoutes: FastifyPluginAsync = async (app) => {
  // Гард на весь скоуп плагина: новая ручка виджетов не может «забыть» вход.
  app.addHook('preHandler', requireAccount);

  const load = async (id: string, accountId: string): Promise<WidgetRow> => {
    if (!UUID_RE.test(id)) throw notFound();
    const widget = await findWidgetByIdForAccount(app.deps.pool, id, accountId);
    if (!widget) throw notFound();
    return widget;
  };

  app.get('/widgets', async (req, reply) => {
    const widgets = await listWidgetsByAccount(app.deps.pool, req.account!.id);
    return reply.send({ widgets: widgets.map((w) => toPublic(w, app.deps.config)) });
  });

  app.post<{
    Body: { name?: unknown; agent_config?: unknown; allowed_origins?: unknown; theme?: unknown };
  }>(
    '/widgets',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const accountId = req.account!.id;
      const name = parseWidgetName(req.body?.name);
      const agentConfig = parseAgentConfig(req.body?.agent_config);
      const allowedOrigins = parseAllowedOrigins(req.body?.allowed_origins ?? []);
      // Тема при создании необязательна (форма панели её не собирает), но
      // ПРИСЛАННУЮ обязана либо сохранить, либо отвергнуть: молча проглоченное
      // поле — тихая потеря данных, а `parseTheme` в PATCH придирается даже к
      // опечатке в имени поля. Две ручки не должны вести себя по-разному.
      const theme = req.body?.theme === undefined ? {} : parseTheme(req.body.theme);

      // Кап читается ПОСЛЕ валидации: мусорное тело не должно даже считаться.
      // Гонка двух параллельных созданий на границе капа теоретически даёт
      // 11-й виджет — цена вопроса нулевая, а на транзакцию с блокировкой
      // счётчика она не тянет.
      if (await countWidgetsByAccount(app.deps.pool, accountId) >= WIDGETS_PER_ACCOUNT_MAX) {
        throw new ApiError(
          422, 'widget_limit_reached',
          `Достигнут предел в ${WIDGETS_PER_ACCOUNT_MAX} виджетов на аккаунт. Удалите ненужный или напишите в поддержку.`,
        );
      }

      // Одна повторная попытка на случай коллизии UNIQUE(publish_token):
      // вероятность её — 2^-128, но 500 из-за неё выглядел бы как «панель
      // сломалась», а не как чудо.
      let widget: WidgetRow | null = null;
      for (let attempt = 0; attempt < 2 && widget === null; attempt += 1) {
        try {
          widget = await insertWidget(app.deps.pool, {
            accountId, name, publishToken: generatePublishToken(), agentConfig, allowedOrigins, theme,
          });
        } catch (err) {
          if ((err as { code?: unknown }).code !== '23505' || attempt === 1) throw err;
        }
      }
      return reply.code(201).send({ widget: toPublic(widget!, app.deps.config) });
    },
  );

  app.get<{ Params: { id: string } }>('/widgets/:id', async (req, reply) => {
    const widget = await load(req.params.id, req.account!.id);
    return reply.send({ widget: toPublic(widget, app.deps.config) });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: unknown; agent_config?: unknown; allowed_origins?: unknown;
      enabled?: unknown; theme?: unknown;
    };
  }>('/widgets/:id', async (req, reply) => {
    const accountId = req.account!.id;
    await load(req.params.id, accountId);

    const body = req.body ?? {};
    const patch: WidgetPatch = {};
    if (body.name !== undefined) patch.name = parseWidgetName(body.name);
    if (body.agent_config !== undefined) patch.agentConfig = parseAgentConfig(body.agent_config);
    if (body.allowed_origins !== undefined) patch.allowedOrigins = parseAllowedOrigins(body.allowed_origins);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        throw new ApiError(422, 'invalid_enabled', 'Поле enabled должно быть true или false.');
      }
      patch.enabled = body.enabled;
    }
    // Тема — целиком, а не по полям: `{}` в теле = «сбросить оформление к
    // дефолтам». Отсутствие ключа `theme` тему НЕ трогает (частичность PATCH).
    if (body.theme !== undefined) patch.theme = parseTheme(body.theme);

    const updated = await updateWidget(app.deps.pool, req.params.id, accountId, patch);
    if (!updated) throw notFound();
    return reply.send({ widget: toPublic(updated, app.deps.config) });
  });

  /**
   * Перевыпуск публичного токена — кнопка «после ухода подрядчика».
   *
   * Токен не секрет (он в HTML чужого сайта), но владелец обязан иметь способ
   * оборвать все уже раздатые копии сниппета. Цена операции — СТАРЫЙ сниппет
   * на сайте немедленно перестаёт работать (404 на /w/v1/:token/config),
   * поэтому панель обязана предупреждать об этом до нажатия.
   *
   * История НЕ теряется: диалоги и лиды привязаны к widget_id, а не к токену.
   *
   * Лимит — 5/час на IP (штатный keyGenerator из app.ts): гард requireAccount
   * работает на preHandler, то есть ПОЗЖЕ onRequest-хука лимитера, и ключом
   * по аккаунту здесь воспользоваться нельзя. Для легитимного владельца пять
   * ротаций в час — заведомо больше, чем нужно.
   */
  app.post<{ Params: { id: string } }>(
    '/widgets/:id/rotate-token',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const accountId = req.account!.id;
      await load(req.params.id, accountId);
      let widget: WidgetRow | null = null;
      for (let attempt = 0; attempt < 2 && widget === null; attempt += 1) {
        try {
          widget = await rotatePublishToken(app.deps.pool, req.params.id, accountId, generatePublishToken());
        } catch (err) {
          if ((err as { code?: unknown }).code !== '23505' || attempt === 1) throw err;
        }
      }
      if (!widget) throw notFound();
      return reply.send({ widget: toPublic(widget, app.deps.config) });
    },
  );

  app.delete<{ Params: { id: string } }>('/widgets/:id', async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) throw notFound();
    const removed = await deleteWidget(app.deps.pool, req.params.id, req.account!.id);
    if (!removed) throw notFound();
    return reply.code(204).send();
  });
};
