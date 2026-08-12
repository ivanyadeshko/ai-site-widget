import type { FastifyReply } from 'fastify';
import type { CoreHttpError } from '../core/client.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  // НЕ параметр-свойства: тот же баг, что и в CoreHttpError (см. её комментарий) —
  // `node --experimental-strip-types` (npm run dev) падает на этом синтаксисе,
  // а vitest/tsc компилируют его молча и не ловят регресс.
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const sendApiError = (reply: FastifyReply, err: ApiError): FastifyReply =>
  reply.code(err.status).send({ error: { code: err.code, message: err.message } });

/**
 * Ошибка ядра → ошибка наружу. Коды НЕ схлопываем в 422: 409
 * (`idempotency_in_progress` — повторить через мгновение), 404 (чужой
 * `continue_from`) и 410 (сессия закрыта) требуют от клиента РАЗНЫХ действий,
 * и одинаковый статус лишил бы его возможности их различить.
 */
export const mapCoreError = (err: CoreHttpError): ApiError => {
  const passthrough = new Set([402, 404, 409, 410, 503]);
  return new ApiError(passthrough.has(err.status) ? err.status : 422, err.code, err.message);
};
