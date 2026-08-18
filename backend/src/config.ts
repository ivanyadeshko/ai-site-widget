export type AppConfig = {
  port: number;
  databaseUrl: string;
  coreBaseUrl: string;
  coreTenantKey: string;
  coreWebhookSecret: string;
  /**
   * Origin ПРИЛОЖЕНИЯ: iframe `/app/:token`, публичный API `/w/v1/*`, кабинет
   * `/panel` и `/api/v1/*` — всё это один хост (app.vell.pro). Отсюда строится
   * `app_url`, и он же считается доверенным в Origin-guard: запрос из самого
   * iframe обязан проходить, даже если владелец не вписал наш домен в свой
   * `allowed_origins`.
   */
  appOrigin: string;
  /**
   * Алиас `appOrigin`, оставленный намеренно: на него завязано три десятка
   * мест и все существующие `.env`. Значения РАСХОДИТЬСЯ не могут — новое
   * читает `appOrigin`, старое продолжает читать `publicOrigin`.
   */
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
  /**
   * Суточный кап сессий на АККАУНТ ВИТРИНЫ — третий ключ поверх visitor/IP.
   * Действует, пока у аккаунта нет своей строки в `account_limits`.
   */
  maxSessionsPerAccountPerDay: number;
  maxDurationS: number;
  /** Только за реальным обратным прокси: иначе X-Forwarded-For ломает IP-кап. */
  trustProxy: boolean;
  logLevel: string;
  /** Срок жизни cookie-сессии панели, суток (скользящее окно). */
  sessionTtlDays: number;
  /** Origin SPA панели: единственный допустимый на не-GET /api/v1/* (D-5). */
  panelOrigin: string;
  /**
   * Origin, с которого раздаётся `/w.js`. Отличается от `publicOrigin` только
   * на мультидоменной раскладке (cdn.vell.pro + app.vell.pro, Task 24) — и
   * ровно тогда в embed-сниппет добавляется `data-host` (widgets/snippet.ts).
   */
  cdnOrigin: string;
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
  // Мультидоменная раскладка (Task 24). Три origin'а вместо одного, и у всех
  // ТРЁХ фолбэк ведёт в конечном счёте на WIDGET_PUBLIC_ORIGIN — он остаётся
  // в REQUIRED, и старый однодоменный .env обязан продолжать работать без
  // единой правки. Цепочка именно такая (app → public), а не «каждый сам к
  // public»: стенд, задавший только WIDGET_APP_ORIGIN, ожидает, что панель и
  // статика переехали ВМЕСТЕ с приложением, а не остались на старом хосте.
  const appOrigin = trimSlash(env.WIDGET_APP_ORIGIN ?? env.WIDGET_PUBLIC_ORIGIN!);
  // Панель по умолчанию живёт на том же origin, что и остальной BFF
  // (app.vell.pro: /panel + /api/v1 + /app/:token). Отдельная переменная нужна
  // лишь на раскладке, где SPA раздаётся с другого хоста.
  const panelOrigin = trimSlash(env.WIDGET_PANEL_ORIGIN ?? appOrigin);
  return {
    port: int(env.PORT, 8200),
    databaseUrl: env.DATABASE_URL!,
    coreBaseUrl: trimSlash(env.CORE_BASE_URL!),
    coreTenantKey: env.CORE_TENANT_KEY!,
    coreWebhookSecret: env.CORE_WEBHOOK_SECRET!,
    appOrigin,
    // Алиас, не вторая точка правды: значение то же самое.
    publicOrigin: appOrigin,
    cspConnectSrc: env.WIDGET_CSP_CONNECT_SRC!,
    ipHashSalt: env.IP_HASH_SALT!,
    // Фикс-раунд 1: капы теперь считают СОЗДАНИЯ СЕССИЙ (budget.ts), а не
    // строки dialogs — продолжение нити после silence и эскалация тратят
    // квоту наравне со стартом. Дефолты подняты (10→20, 30→60), иначе
    // фрагментация одного разговора на несколько сессий душит легитимных.
    maxDialogsPerVisitorPerDay: int(env.MAX_DIALOGS_PER_VISITOR_PER_DAY, 20),
    maxDialogsPerIpPerDay: int(env.MAX_DIALOGS_PER_IP_PER_DAY, 60),
    // Дефолт на аккаунт заметно выше визиторного: у владельца сайта посетителей
    // много, и кап здесь — предохранитель от выжигания баланса общего тенанта
    // ядра, а не инструмент тарификации (тариф — строка в account_limits).
    maxSessionsPerAccountPerDay: int(env.MAX_SESSIONS_PER_ACCOUNT_PER_DAY, 300),
    maxDurationS: int(env.CORE_MAX_DURATION_S, 600),
    // Небезопасное значение требует ЯВНОГО согласия: дефолт закрыт.
    trustProxy: env.TRUST_PROXY === '1',
    logLevel: env.LOG_LEVEL ?? 'info',
    // Новые переменные — все НЕобязательные с дефолтом и НЕ в REQUIRED: иначе
    // каждый существующий стенд перестал бы подниматься на этом релизе.
    sessionTtlDays: int(env.SESSION_TTL_DAYS, 30),
    panelOrigin,
    // Фолбэк на origin приложения: существующие стенды продолжают работать без
    // единой правки .env, а сниппет на них остаётся однодоменным (без data-host).
    cdnOrigin: trimSlash(env.WIDGET_CDN_ORIGIN ?? appOrigin),
    // На https-происхождении Secure включается сам; явный SESSION_COOKIE_SECURE=1
    // форсирует его на раскладке, где TLS терминируется выше по цепочке.
    cookieSecure: (env.SESSION_COOKIE_SECURE ?? '') === '1' || panelOrigin.startsWith('https://'),
    loginMaxFailures: int(env.LOGIN_MAX_FAILURES, 10),
    loginLockMinutes: int(env.LOGIN_LOCK_MINUTES, 15),
  };
}
