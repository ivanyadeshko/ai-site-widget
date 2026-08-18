export type AppConfig = {
  port: number;
  databaseUrl: string;
  coreBaseUrl: string;
  coreTenantKey: string;
  coreWebhookSecret: string;
  publicOrigin: string;
  cspConnectSrc: string;
  ipHashSalt: string;
  /**
   * Суточный кап — фактически кап СОЗДАНИЙ СЕССИЙ ЯДРА (budget.ts), не строк
   * dialogs (фикс-раунд 1). Имя поля/env-переменной оставлено как есть: его
   * переименование задело бы AppConfig-литералы в test/coreWebhooks.test.ts и
   * test/transcriptSync.test.ts — файлах коммита T2 фикс-раунда (c6c3ea3),
   * трогать которые запрещено явно. См. task-3-report.md §фикс-раунд 1.
   */
  maxDialogsPerVisitorPerDay: number;
  maxDialogsPerIpPerDay: number;
  maxDurationS: number;
  /** Только за реальным обратным прокси: иначе X-Forwarded-For ломает IP-кап. */
  trustProxy: boolean;
  logLevel: string;
  /** Срок жизни cookie-сессии панели, суток (скользящее окно). */
  sessionTtlDays: number;
  /** Origin SPA панели: единственный допустимый на не-GET /api/v1/* (D-5). */
  panelOrigin: string;
  /** Флаг Secure у cookie сессии: на http-стенде кука с Secure не доедет вовсе. */
  cookieSecure: boolean;
  /** Порог неудачных входов по ОДНОМУ email и длина окна блокировки. */
  loginMaxFailures: number;
  loginLockMinutes: number;
};

const REQUIRED = [
  'DATABASE_URL',
  'CORE_BASE_URL',
  'CORE_TENANT_KEY',
  'CORE_WEBHOOK_SECRET',
  'WIDGET_PUBLIC_ORIGIN',
  'WIDGET_CSP_CONNECT_SRC',
  'IP_HASH_SALT',
] as const;

const trimSlash = (v: string): string => v.replace(/\/+$/, '');

const int = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Ожидалось положительное целое, получено: ${raw}`);
  }
  return parsed;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) {
    // Падаем ГРОМКО и разом: половина конфига — хуже, чем его отсутствие.
    throw new Error(`Не заданы обязательные переменные окружения: ${missing.join(', ')}`);
  }
  // Панель по умолчанию живёт на том же origin, что и остальной BFF
  // (app.vell.pro: /panel + /api/v1 + /app/:token). Отдельная переменная нужна
  // лишь на раскладке, где SPA раздаётся с другого хоста.
  const panelOrigin = trimSlash(env.WIDGET_PANEL_ORIGIN ?? env.WIDGET_PUBLIC_ORIGIN!);
  return {
    port: int(env.PORT, 8200),
    databaseUrl: env.DATABASE_URL!,
    coreBaseUrl: trimSlash(env.CORE_BASE_URL!),
    coreTenantKey: env.CORE_TENANT_KEY!,
    coreWebhookSecret: env.CORE_WEBHOOK_SECRET!,
    publicOrigin: trimSlash(env.WIDGET_PUBLIC_ORIGIN!),
    cspConnectSrc: env.WIDGET_CSP_CONNECT_SRC!,
    ipHashSalt: env.IP_HASH_SALT!,
    // Фикс-раунд 1: капы теперь считают СОЗДАНИЯ СЕССИЙ (budget.ts), а не
    // строки dialogs — продолжение нити после silence и эскалация тратят
    // квоту наравне со стартом. Дефолты подняты (10→20, 30→60), иначе
    // фрагментация одного разговора на несколько сессий душит легитимных.
    maxDialogsPerVisitorPerDay: int(env.MAX_DIALOGS_PER_VISITOR_PER_DAY, 20),
    maxDialogsPerIpPerDay: int(env.MAX_DIALOGS_PER_IP_PER_DAY, 60),
    maxDurationS: int(env.CORE_MAX_DURATION_S, 600),
    // Небезопасное значение требует ЯВНОГО согласия: дефолт закрыт.
    trustProxy: env.TRUST_PROXY === '1',
    logLevel: env.LOG_LEVEL ?? 'info',
    // Новые переменные — все НЕобязательные с дефолтом и НЕ в REQUIRED: иначе
    // каждый существующий стенд перестал бы подниматься на этом релизе.
    sessionTtlDays: int(env.SESSION_TTL_DAYS, 30),
    panelOrigin,
    // На https-происхождении Secure включается сам; явный SESSION_COOKIE_SECURE=1
    // форсирует его на раскладке, где TLS терминируется выше по цепочке.
    cookieSecure: (env.SESSION_COOKIE_SECURE ?? '') === '1' || panelOrigin.startsWith('https://'),
    loginMaxFailures: int(env.LOGIN_MAX_FAILURES, 10),
    loginLockMinutes: int(env.LOGIN_LOCK_MINUTES, 15),
  };
}
