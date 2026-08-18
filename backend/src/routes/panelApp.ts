import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';

const PANEL_DIST = fileURLToPath(new URL('../../../panel/dist/', import.meta.url));
const SHELL = `${PANEL_DIST}index.html`;

/** Префикс собранных чанков — уже вместе с префиксом плагина. */
const ASSETS_PREFIX = '/panel/assets/';

/**
 * Раздача SPA кабинета с `/panel`.
 *
 * Регистрируется `app.register(panelAppRoutes, { prefix: '/panel' })` — ДО
 * корневого `fastifyStatic` с `prefix: '/'`, иначе статика виджета перехватит
 * `/panel/*` раньше этих роутов.
 */
export const panelAppRoutes: FastifyPluginAsync = async (app) => {
  let shell: string | null = null;

  await app.register(fastifyStatic, {
    root: PANEL_DIST,
    prefix: '/',
    // reply.sendFile уже декорируется корневой статикой в app.ts — второй
    // раз Fastify этого не позволит и упадёт на старте.
    decorateReply: false,
    // Оболочку отдаёт фолбэк ниже, а не статика: так у неё ровно один набор
    // заголовков, где бы её ни попросили.
    index: false,
    // wildcard:false = @fastify/static регистрирует ТОЧНЫЕ роуты на реально
    // существующие файлы и не заводит своего `/*`. Дальше всё непойманное
    // ловит наш `/*` ниже.
    wildcard: false,
    setHeaders: (reply, path) => {
      // Чанки Vite несут хэш в имени и иммутабельны; всё прочее — коротко.
      // Разделитель именно `-`: Vite 7 собирает `index-CiULUoa2.js`, а не
      // `index.CiULUoa2.js` — с точкой в шаблоне правило молча не срабатывало
      // бы и каждый чанк перезапрашивался бы раз в минуту.
      reply.header('Cache-Control', /[.-][0-9a-zA-Z_-]{8,}\.(?:js|css)$/.test(path)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=60');
    },
  });

  const sendShell = async (reply: FastifyReply): Promise<FastifyReply> => {
    shell ??= await readFile(SHELL, 'utf8');
    return reply
      .header('Cache-Control', 'no-store')
      // Кабинет не встраивается никуда: в отличие от /app/:token у него нет
      // легитимных фреймов вовсе, поэтому XFO проще и жёстче CSP.
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .type('text/html; charset=utf-8')
      .send(shell);
  };

  app.get('/', async (_req, reply) => sendShell(reply));

  /**
   * History-фолбэк SPA.
   *
   * ДЕВИАЦИЯ от буквы плана (там — `setNotFoundHandler` внутри плагина):
   * обработчик 404 плагина сюда просто не доходит. Корневой `fastifyStatic`
   * с `prefix: '/'` регистрирует ГЛОБАЛЬНЫЙ роут `/*`, и `/panel/widgets/123`
   * попадает в него (маршрутизация Fastify общая, не по плагинам); не найдя
   * файла, он зовёт `callNotFound` уже в СВОЁМ скоупе — то есть корневой 404,
   * а не панельный. Проверено красным тестом: с `setNotFoundHandler` глубокая
   * ссылка отдавала 404. Явный `/*` в скоупе плагина точнее корневого `/*` и
   * выигрывает у него в дереве маршрутов.
   *
   * КРИТИЧНО: под `/panel/assets/` фолбэк НЕ работает. Иначе запрос протухшего
   * чанка после деплоя (`/panel/assets/index-<старый-хэш>.js`) вернул бы 200 с
   * HTML, браузер выполнил бы его как ES-модуль и SPA умерла бы на
   * `Unexpected token '<'` вместо честного 404, по которому роутер умеет
   * перезагрузить страницу (грабли монолита «протухшие чанки после деплоя»).
   */
  app.get('/*', async (req, reply) => {
    if (req.url.startsWith(ASSETS_PREFIX)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Не найдено');
    }
    return sendShell(reply);
  });
};
