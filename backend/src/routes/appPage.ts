import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { findWidgetByToken } from '../db/repositories/widgets.ts';
import { normalizeOrigin } from '../http/originGuard.ts';

const SHELL = fileURLToPath(new URL('../../../embed/app/dist/index.html', import.meta.url));

export const appPageRoutes: FastifyPluginAsync = async (app) => {
  let template: string | null = null;

  app.get<{ Params: { token: string } }>('/app/:token', async (req, reply) => {
    const widget = await findWidgetByToken(app.deps.pool, req.params.token);
    if (!widget) return reply.code(404).type('text/plain; charset=utf-8').send('Виджет не найден');

    template ??= await readFile(SHELL, 'utf8');

    // frame-ancestors — ЕДИНСТВЕННОЕ, что реально запрещает встраивание на чужой
    // сайт: Origin-заголовок подделывается кем угодно, а это применяет браузер.
    const ancestors = widget.allowed_origins.length > 0
      ? `'self' ${widget.allowed_origins.map(normalizeOrigin).join(' ')}`
      : "'none'";

    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        `connect-src ${app.deps.config.cspConnectSrc}`,
        "media-src 'self' blob:",
        `frame-ancestors ${ancestors}`,
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Токен уезжает АТРИБУТОМ, а не вставкой в скрипт: строка из БД в js-литерале —
    // это инъекция, ждущая своего часа.
    return reply
      .type('text/html; charset=utf-8')
      .send(template.replace('data-widget-token=""', `data-widget-token="${encodeURIComponent(widget.publish_token)}"`));
  });
};
