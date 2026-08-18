import type { AgentConfig } from '../db/repositories/widgets.ts';
import { ApiError } from '../http/errors.ts';
import { normalizeOrigin } from '../http/originGuard.ts';

/** Кап на число виджетов одного аккаунта витрины. */
export const WIDGETS_PER_ACCOUNT_MAX = 10;
export const NAME_MAX = 100;
export const INSTRUCTIONS_MAX = 8000;
export const GREETING_MAX = 500;
export const ORIGINS_MAX = 20;

/** voice_id/avatar_id уезжают в тело запроса к ядру (dialogs/openSession.ts). */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export function parseWidgetName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length === 0 || name.length > NAME_MAX) {
    throw new ApiError(422, 'invalid_name', `Название виджета — от 1 до ${NAME_MAX} символов.`);
  }
  return name;
}

/**
 * Список сайтов, на которых виджет разрешён.
 *
 * Маска (`*`) запрещена НАМЕРЕННО: `allowed_origins` — единственная защита
 * публичного пути виджета (originGuard.ts), и `['*']` сняла бы её целиком,
 * подарив чужому сайту право жечь кредиты общего тенанта ядра. Пустой список
 * при этом разрешён и означает «виджет закрыт везде» (Constraint 12) — панель
 * обязана это ОБЪЯСНЯТЬ, а не чинить.
 */
export function parseAllowedOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(422, 'invalid_origins', 'Список разрешённых сайтов должен быть массивом.');
  }
  if (raw.length > ORIGINS_MAX) {
    throw new ApiError(422, 'invalid_origins', `Не более ${ORIGINS_MAX} разрешённых сайтов.`);
  }

  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ApiError(422, 'invalid_origins', 'Адрес сайта должен быть непустой строкой.');
    }
    const value = item.trim();
    if (value.includes('*')) {
      throw new ApiError(
        422, 'invalid_origins',
        'Маска «*» не поддерживается: перечислите адреса сайтов целиком.',
      );
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ApiError(422, 'invalid_origins', `Не похоже на адрес сайта: ${value}. Пример: https://shop.example`);
    }
    if (!ALLOWED_SCHEMES.has(url.protocol) || url.host === '') {
      throw new ApiError(422, 'invalid_origins', `Адрес должен начинаться с https:// или http:// — получено: ${value}`);
    }
    // normalizeOrigin режет путь, порт сохраняет, регистр опускает.
    const normalized = normalizeOrigin(url.origin);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export function parseAgentConfig(raw: unknown): AgentConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(422, 'invalid_agent_config', 'Настройки агента должны быть объектом.');
  }
  const input = raw as Record<string, unknown>;

  const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : '';
  if (instructions.length === 0) {
    throw new ApiError(422, 'invalid_instructions', 'Опишите, что агент должен делать: поле не может быть пустым.');
  }
  if (instructions.length > INSTRUCTIONS_MAX) {
    throw new ApiError(
      422, 'instructions_too_long',
      `Инструкции длиннее ${INSTRUCTIONS_MAX} символов — сократите текст.`,
    );
  }

  const config: AgentConfig = { instructions };

  if (input.greeting !== undefined && input.greeting !== null && input.greeting !== '') {
    const greeting = typeof input.greeting === 'string' ? input.greeting.trim() : '';
    if (greeting.length === 0 || greeting.length > GREETING_MAX) {
      throw new ApiError(422, 'invalid_greeting', `Приветствие — не длиннее ${GREETING_MAX} символов.`);
    }
    config.greeting = greeting;
  }

  for (const field of ['voice_id', 'avatar_id'] as const) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !ID_RE.test(value.trim())) {
      throw new ApiError(
        422, `invalid_${field}`,
        'Допустимы латиница, цифры, точка, дефис и подчёркивание (до 64 символов).',
      );
    }
    config[field] = value.trim();
  }

  return config;
}
