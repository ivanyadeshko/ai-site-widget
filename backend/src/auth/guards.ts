import type { preHandlerHookHandler } from 'fastify';
import type { AccountRow } from '../db/repositories/accounts.ts';
import { ApiError } from '../http/errors.ts';
import { normalizeOrigin } from '../http/originGuard.ts';
import { SESSION_COOKIE, resolveSession } from './sessions.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF-барьер панели (D-5): панель и API живут на одном origin, кука
 * host-only с SameSite=Lax, поэтому пары «SameSite + строгий Origin» хватает,
 * а токен-в-форме добавил бы состояние без выигрыша.
 *
 * Отсутствие заголовка на не-GET = отказ: Fetch-спека обязывает браузер слать
 * Origin на КАЖДЫЙ не-GET запрос, включая same-origin. Нет заголовка — это не
 * браузер, а curl с украденной кукой.
 */
export const requireSameOrigin: preHandlerHookHandler = async (req) => {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') {
    throw new ApiError(403, 'cross_origin_denied', 'Запрос отклонён: не указан источник.');
  }
  if (normalizeOrigin(origin) !== normalizeOrigin(req.server.deps.config.panelOrigin)) {
    throw new ApiError(403, 'cross_origin_denied', 'Запрос отклонён: чужой источник.');
  }
};

export const requireAccount: preHandlerHookHandler = async (req) => {
  const token = req.cookies[SESSION_COOKIE];
  if (typeof token !== 'string' || token === '') {
    throw new ApiError(401, 'unauthenticated', 'Требуется вход.');
  }
  const account = await resolveSession(req.server.deps, token);
  if (!account) throw new ApiError(401, 'unauthenticated', 'Требуется вход.');
  req.account = account;
};

/**
 * 404, а НЕ 403: существование админ-поверхности не подтверждаем никому, кроме
 * админов — иначе владелец-любитель узнаёт, что админка есть, и идёт её щупать.
 * Ставится ПОСЛЕ requireAccount в цепочке preHandler.
 */
export const requireAdmin: preHandlerHookHandler = async (req) => {
  if (req.account?.is_admin !== true) {
    throw new ApiError(404, 'not_found', 'Не найдено.');
  }
};

declare module 'fastify' {
  interface FastifyRequest {
    account?: AccountRow;
  }
}
