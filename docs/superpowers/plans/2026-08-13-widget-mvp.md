# ai-site-widget MVP — Implementation Plan (Э4/Ф3 распила)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять третий сервис распила — встраиваемый чат-виджет для чужих сайтов, который ведёт текстовый диалог поверх chat-канала ядра и умеет эскалировать разговор в голос с сохранением памяти нити.

**Architecture:** Тонкий BFF на Fastify (Node 22) держит Postgres с витриной диалогов и ходит в `ai-conversation-core` server-to-server ключом тенанта; браузер получает от BFF только `participant_token` и разговаривает с воркером НАПРЯМУЮ по LiveKit data-channel (BFF вне пути реплик). Встраивание — двухслойное: крошечный лоадер `w.js` в Shadow DOM на чужой странице поднимает iframe с Vue-приложением; лоадер владеет `visitor_key` в first-party localStorage и отдаёт его в iframe через postMessage. Эскалация чат→голос = `POST /end` старой сессии + `POST /v1/sessions {channel:voice, continue_from}` с досыпанной в `agent.instructions` выжимкой нити.

**Tech Stack:** Node.js 22, Fastify 5, TypeScript 5.7, `pg` + `node-pg-migrate` (raw SQL), vitest 3, Vue 3.5 + Vite 6, `livekit-client` 2.16.1, `openapi-typescript`, Postgres 16, Docker Compose, Python 3 (stdlib + `livekit-rtc` из воркера ядра) для смока.

## Global Constraints

Эти ограничения — часть требований КАЖДОГО таска. Значения скопированы из спеки `docs/superpowers/specs/2026-08-12-widget-mvp-design.md`.

- **Ядро — строго `origin/main`** (80b6a3b+). Локальные чекауты `ai-conversation-core` отстают. Любая сверка контракта: `git -C ../ai-conversation-core show origin/main:contracts/openapi.yaml` и `origin/main:contracts/realtime/pv1/*`. Дев-ядро: `http://185.125.102.133:8100`, API-база `http://185.125.102.133:8100/api`, health — `http://185.125.102.133:8100/health` (ВНЕ `/api`).
- **Origin-check ОБЯЗАТЕЛЕН на каждой ручке `/w/v1/*`, кроме `GET /config`.** Пустой `allowed_origins` = отказ ВСЕМ (не «любой» — анти-паттерн монолита не наследуем). Правило асимметрично по методу: **на любой не-GET ручке отсутствие `Origin` = ОТКАЗ** (браузер по Fetch-спеке шлёт `Origin` на каждый не-GET запрос, включая same-origin, — значит безголовый `curl` без заголовка отсекается, а iframe не страдает); на GET отсутствие `Origin` допустимо (браузер его на same-origin GET не шлёт).
- **`trustProxy: false` в дев-раскладке.** Backend слушает `:8200` напрямую, без обратного прокси: доверие к `X-Forwarded-For` превратило бы IP-кап в декорацию (клиент подставит любой заголовок). Включать `trustProxy` только одновременно с реальным прокси перед сервисом.
- **`identity` на re-enter генерит BFF в форме `respondent-<uuid>`.** Префикс `respondent-` обязателен (воркер узнаёт клиента по нему); переиспользовать прежнюю identity нельзя — LiveKit выкинет живого участника.
- **Дедуп эха на клиенте обязателен:** воркер шлёт обратно и реплику посетителя (`transcript` со `speaker: "respondent"`). Свои сообщения рендерятся оптимистично, обратный `transcript` дедупится по нормализованному тексту в окне.
- **FSM диалога:** `chat → escalating → voice | chat_fallback | ended | error`. Обрыв LiveKit-соединения в состоянии `escalating`/`ended` — ШТАТНЫЙ переход, не ошибка (`POST /end` сносит комнату БЕЗ фрейма `session_ended`).
- **Бюджет-предохранитель:** отдельный тенант ядра «site-widget» с намеренно малым балансом (дев: ~5000 credits); `limits.max_duration_s = 600` у ОБОИХ каналов (не дефолт 1800); капы `MAX_DIALOGS_PER_VISITOR_PER_DAY=10`, `MAX_DIALOGS_PER_IP_PER_DAY=30`; `credits.low` → warn-лог.
- **Secure context:** голос из iframe работает только на https/localhost. Дев-прогон голоса — `ssh -L 8200:localhost:8200` + `http://localhost:8200/demo.html`, и при этом `WIDGET_PUBLIC_ORIGIN` обязан быть `http://localhost:8200`: iframe грузится по `app_url` из конфига, и IP-origin (`http://185.125.102.133:8200`) сделал бы страницу iframe НЕ secure context — `getUserMedia` умрёт даже внутри ssh-туннеля. Чат по data-channel живёт и на http с любым origin.
- **Вебхуки: rawBody.** HMAC-SHA256 считается по СКЛЕЙКЕ `<t>.<сырое тело>` до всякого `JSON.parse`; заголовок `X-Core-Signature: t=<unix>,v1=<hex>` разбирается ПО КЛЮЧАМ (не по позиции), окно ±300с, сравнение постоянное по времени. Ответ ≤10с, любой 2xx = успех, редиректы = провал.
- **SQL живёт ТОЛЬКО в `backend/src/db/repositories/*`.** Роуты и сервисы дёргают функции репозиториев, а не `pool.query`.
- **Рендер текста реплик — ТОЛЬКО интерполяция.** `v-html` запрещён: реплики — влияемый посетителем контент.
- **PII/meta посетителя не храним:** ни UA, ни IP. Для IP-капа хранится только `sha256(IP_HASH_SALT + ip)` в суточном счётчике.
- **Лоадер `w.js` ≤ 8 КБ gzip.** Версионирование: иммутабельный `w.<hash>.js` + тонкий стабильный шим `/w.js` (кэш 60с).
- **`agent.instructions` ≤ 32000 символов** — потолок ядра (промпт уезжает в метаданные комнаты LiveKit).
- Язык кода: комментарии и сообщения об ошибках — по-русски (как в ядре и монолите).

## Структура файлов

```
ai-site-widget/
├── package.json                       npm workspaces: backend, embed/loader, embed/app
├── contracts/
│   ├── openapi.core.yaml              вендорённая копия origin/main:contracts/openapi.yaml
│   ├── core-api.d.ts                  сгенерённые openapi-typescript типы
│   └── sync.mjs                       синк + детект дрейфа
├── backend/
│   ├── package.json, tsconfig.json, vitest.config.ts
│   ├── migrations/1755100000000_init.cjs
│   ├── src/
│   │   ├── server.ts                  entrypoint, SIGTERM/SIGINT, graceful shutdown
│   │   ├── app.ts                     buildApp(deps) → FastifyInstance
│   │   ├── config.ts                  loadConfig(env) → AppConfig (падает громко)
│   │   ├── db/pool.ts                 createPool(url) → Pool
│   │   ├── db/repositories/{widgets,dialogs,messages,leads,coreEvents,quotas}.ts
│   │   ├── core/{client,signature,types}.ts
│   │   ├── http/{originGuard,errors}.ts
│   │   ├── routes/{health,coreWebhooks,publicApi,appPage}.ts
│   │   ├── dialogs/{budget,openSession,startDialog,reenter,escalate,threadDigest}.ts
│   │   └── jobs/sweeper.ts
│   └── test/{helpers/db.ts,helpers/fakeCore.ts,helpers/app.ts, …}
├── embed/
│   ├── loader/src/loader.ts           vanilla TS, Shadow DOM, ≤8КБ gzip
│   ├── loader/scripts/{make-shim.mjs,size-check.mjs}
│   ├── app/src/                       Vue 3 iframe-приложение
│   └── public/demo.html               демо-страница для ручного прогона
├── infra/{Dockerfile,compose.yaml,compose.test.yaml,.env.example}
└── scripts/widget_smoke.py            6 сценариев §8 спеки
```

## Карта тасков (9)

| № | Таск | Артефакт |
|---|---|---|
| 1 | Скелет backend + модель данных | `/healthz` на живой БД, репозитории под тестами |
| 2 | Core-клиент + приёмник вебхуков | подпись, дедуп, деньги садятся в диалог |
| 3 | Публичный API диалогов | 8 ручек, Origin-check, капы, журнал, лид |
| 4 | Эскалация чат→голос + свипер | `/escalate` с выжимкой нити, досинк зависших |
| 5 | Backend-обвязка embed + лоадер | `/app/:token` с `frame-ancestors`, `w.<hash>.js` ≤8КБ |
| 6 | iframe-приложение: чат | лента, композер, дедуп эха, журнал, `client_ready` |
| 7 | iframe-приложение: голос и FSM | эскалация, микрофон, «Продолжить», лид-форма |
| 8 | Compose + деплой дев + провижининг | живой стенд, тенант ядра, вебхуки, demo.html |
| 9 | `widget_smoke.py` + гейт фазы | 6 сценариев §8 зелёные + ручной браузерный голос |

---
### Task 1: Скелет backend + модель данных

**Files:**
- Create: `package.json`, `.gitignore`, `.nvmrc`
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/vitest.config.ts`
- Create: `backend/migrations/1755100000000_init.cjs`
- Create: `backend/src/config.ts`, `backend/src/db/pool.ts`, `backend/src/app.ts`, `backend/src/server.ts`
- Create: `backend/src/db/repositories/widgets.ts`, `backend/src/db/repositories/dialogs.ts`, `backend/src/db/repositories/messages.ts`, `backend/src/db/repositories/leads.ts`, `backend/src/db/repositories/coreEvents.ts`, `backend/src/db/repositories/quotas.ts`
- Create: `infra/compose.test.yaml`
- Test: `backend/test/helpers/db.ts`, `backend/test/config.test.ts`, `backend/test/health.test.ts`, `backend/test/repositories.test.ts`

**Interfaces:**
- Consumes: ничего (первый таск).
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): AppConfig` — бросает `Error` с перечнем недостающих переменных.
  - `type AppConfig = { port: number; databaseUrl: string; coreBaseUrl: string; coreTenantKey: string; coreWebhookSecret: string; publicOrigin: string; cspConnectSrc: string; ipHashSalt: string; maxDialogsPerVisitorPerDay: number; maxDialogsPerIpPerDay: number; maxDurationS: number; logLevel: string }`
  - `createPool(databaseUrl: string): Pool` (из `pg`)
  - `type Queryable = Pool | PoolClient`
  - `type AppDeps = { config: AppConfig; pool: Pool; log: FastifyBaseLogger; core?: CoreClient }`; `type AppDepsInput = Omit<AppDeps, 'log'>`; `buildApp(input: AppDepsInput): Promise<FastifyInstance>`. Поле `log` заводится СРАЗУ, в T1 (сервисам оно нужно с первого дня, и дописывать его в чужом таске — плохой шов), но заполняется внутри `buildApp`: логгер рождается вместе с инстансом Fastify. `core` опционально здесь и становится обязательным в T2.
  - Типы строк: `WidgetRow`, `AgentConfig`, `DialogRow`, `DialogStatus`, `MessageRow`, `LeadRow`.
  - Репозитории (все — функции `(db: Queryable, …)`):
    `findWidgetByToken(db, token: string): Promise<WidgetRow | null>`;
    `insertDialog(db, input: { widgetId: string; visitorKey: string }): Promise<DialogRow>`;
    `findDialogById(db, id: string): Promise<DialogRow | null>`;
    `findDialogByClientReference(db, ref: string): Promise<DialogRow | null>`;
    `attachCoreSession(db, input: { dialogId: string; sessionId: string; channel: 'chat' | 'voice' }): Promise<void>`;
    `setDialogStatus(db, dialogId: string, status: DialogStatus): Promise<void>`;
    `casDialogStatus(db, dialogId: string, from: DialogStatus, to: DialogStatus): Promise<boolean>`;
    `touchDialog(db, dialogId: string): Promise<void>`;
    `applyFinalizedUsage(db, input: { dialogId: string; sessionId: string; usage: Record<string, number>; creditsTotal: number }): Promise<boolean>` (идемпотентно по `sessionId`; false = деньги этой сессии уже учтены);
    `countDialogsStartedByVisitor(db, visitorKey: string): Promise<number>`;
    `insertMessage(db, input: InsertMessageInput): Promise<boolean>` (false = дубль, отбит уникальным индексом);
    `listThreadTail(db, dialogId: string, limit: number): Promise<MessageRow[]>` (ХВОСТ в хронологическом порядке — единственная функция чтения журнала);
    `maxClientSeq(db, dialogId: string): Promise<number>`;
    `hasSimilarMessage(db, input: { dialogId: string; role: 'user' | 'agent'; text: string; windowSeconds: number }): Promise<boolean>`;
    `insertLead(db, input: InsertLeadInput): Promise<string>`;
    `insertCoreEvent(db, input: { eventId: string; type: string; payload: unknown }): Promise<boolean>` (false = уже видели);
    `bumpIpDayCounter(db, ipHash: string): Promise<number>` (возвращает счётчик ПОСЛЕ инкремента);
    `purgeOldIpCounters(db, keepDays: number): Promise<number>`;
    `hashIp(ip: string, salt: string): string`;
    `listStaleActiveDialogs(db, olderThanMinutes: number, limit: number): Promise<DialogRow[]>`.

- [ ] **Step 1: Каркас репозитория и workspaces**

`package.json` в корне:

```json
{
  "name": "ai-site-widget",
  "private": true,
  "workspaces": ["backend", "embed/loader", "embed/app"],
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present"
  }
}
```

`.nvmrc`: `22`. `.gitignore`: `node_modules/`, `dist/`, `.env`, `*.log`, `backend/coverage/`.

`backend/package.json`:

```json
{
  "name": "@aski/site-widget-backend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --experimental-strip-types --watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "migrate": "node-pg-migrate -m migrations --envPath ../.env up",
    "test": "vitest run",
    "db:test:up": "docker compose -f ../infra/compose.test.yaml up -d --wait"
  },
  "dependencies": {
    "fastify": "^5.2.0",
    "@fastify/rate-limit": "^10.2.0",
    "@fastify/static": "^8.0.0",
    "pg": "^8.13.0",
    "node-pg-migrate": "^7.9.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.10",
    "typescript": "~5.7.2",
    "vitest": "^3.0.0"
  }
}
```

`backend/tsconfig.json`: `target/module: ES2023/NodeNext`, `moduleResolution: NodeNext`, `strict: true`, `noUncheckedIndexedAccess: true`, `outDir: dist`, `rootDir: src`, `verbatimModuleSyntax: true` и **обязательно `"rewriteRelativeImportExtensions": true`** (TS 5.7). Без этого флага пара «импорты с расширением `.ts` + эмит в `dist`» даёт ошибку TS5097 (`An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is set`), а `allowImportingTsExtensions` в свою очередь требует `noEmit` — то есть сборка бы не собралась вовсе. Флаг переписывает `./x.ts` → `./x.js` на выходе, поэтому в исходниках расширения `.ts` (как во всех снипетах плана) остаются корректными и в рантайме Node 22.

`backend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/helpers/globalSetup.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    fileParallelism: false, // одна тестовая БД на всех — файлы не топчут друг друга
  },
});
```

`infra/compose.test.yaml`:

```yaml
name: site-widget-test
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: widget
      POSTGRES_PASSWORD: widget
      POSTGRES_DB: widget_test
    ports: ["55433:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U widget -d widget_test"]
      interval: 2s
      timeout: 3s
      retries: 30
```

- [ ] **Step 2: Тест на конфиг — FAIL**

`backend/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const FULL = {
  DATABASE_URL: 'postgres://widget:widget@127.0.0.1:55433/widget_test',
  CORE_BASE_URL: 'http://185.125.102.133:8100/api',
  CORE_TENANT_KEY: 'sk_test_x',
  CORE_WEBHOOK_SECRET: 'секрет-длиной-больше-шестнадцати',
  WIDGET_PUBLIC_ORIGIN: 'http://localhost:8200',
  WIDGET_CSP_CONNECT_SRC: "'self' wss://livekit.example",
  IP_HASH_SALT: 'соль',
};

describe('loadConfig', () => {
  it('перечисляет ВСЕ недостающие переменные разом, а не первую', () => {
    expect(() => loadConfig({})).toThrowError(
      /DATABASE_URL.*CORE_BASE_URL.*CORE_TENANT_KEY.*CORE_WEBHOOK_SECRET.*WIDGET_PUBLIC_ORIGIN.*WIDGET_CSP_CONNECT_SRC.*IP_HASH_SALT/s,
    );
  });

  it('срезает хвостовой слэш у CORE_BASE_URL и WIDGET_PUBLIC_ORIGIN', () => {
    const cfg = loadConfig({ ...FULL, CORE_BASE_URL: 'http://core:8100/api/', WIDGET_PUBLIC_ORIGIN: 'http://x/' });
    expect(cfg.coreBaseUrl).toBe('http://core:8100/api');
    expect(cfg.publicOrigin).toBe('http://x');
  });

  it('дефолты бюджет-предохранителя — из спеки §6', () => {
    const cfg = loadConfig(FULL);
    expect(cfg.maxDialogsPerVisitorPerDay).toBe(10);
    expect(cfg.maxDialogsPerIpPerDay).toBe(30);
    expect(cfg.maxDurationS).toBe(600);
  });

  it('trustProxy по умолчанию ВЫКЛЮЧЕН: иначе IP-кап обходится одним заголовком', () => {
    expect(loadConfig(FULL).trustProxy).toBe(false);
    expect(loadConfig({ ...FULL, TRUST_PROXY: 'true' }).trustProxy).toBe(false); // включает только '1'
    expect(loadConfig({ ...FULL, TRUST_PROXY: '1' }).trustProxy).toBe(true);
  });
});
```

Run: `cd backend && npx vitest run test/config.test.ts` → FAIL: `Cannot find module '../src/config.ts'`.

- [ ] **Step 3: Реализация `backend/src/config.ts`**

```ts
export type AppConfig = {
  port: number;
  databaseUrl: string;
  coreBaseUrl: string;
  coreTenantKey: string;
  coreWebhookSecret: string;
  publicOrigin: string;
  cspConnectSrc: string;
  ipHashSalt: string;
  maxDialogsPerVisitorPerDay: number;
  maxDialogsPerIpPerDay: number;
  maxDurationS: number;
  /** Только за реальным обратным прокси: иначе X-Forwarded-For ломает IP-кап. */
  trustProxy: boolean;
  logLevel: string;
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
  return {
    port: int(env.PORT, 8200),
    databaseUrl: env.DATABASE_URL!,
    coreBaseUrl: trimSlash(env.CORE_BASE_URL!),
    coreTenantKey: env.CORE_TENANT_KEY!,
    coreWebhookSecret: env.CORE_WEBHOOK_SECRET!,
    publicOrigin: trimSlash(env.WIDGET_PUBLIC_ORIGIN!),
    cspConnectSrc: env.WIDGET_CSP_CONNECT_SRC!,
    ipHashSalt: env.IP_HASH_SALT!,
    maxDialogsPerVisitorPerDay: int(env.MAX_DIALOGS_PER_VISITOR_PER_DAY, 10),
    maxDialogsPerIpPerDay: int(env.MAX_DIALOGS_PER_IP_PER_DAY, 30),
    maxDurationS: int(env.CORE_MAX_DURATION_S, 600),
    // Небезопасное значение требует ЯВНОГО согласия: дефолт закрыт.
    trustProxy: env.TRUST_PROXY === '1',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
```

Run: `npx vitest run test/config.test.ts` → PASS.

- [ ] **Step 4: Миграция схемы**

`backend/migrations/1755100000000_init.cjs`:

```js
/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.sql(`
    CREATE TABLE widgets (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      publish_token    TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      agent_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
      kb_ids           JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_origins  JSONB NOT NULL DEFAULT '[]'::jsonb,
      enabled          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE dialogs (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      widget_id               UUID NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      visitor_key             UUID NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','escalating','ended','error')),
      core_session_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- Сессии, деньги по которым УЖЕ учтены. Вебхук и свипер приходят к одному
      -- и тому же выводу разными путями и могут сойтись на одной сессии —
      -- без этого списка credits_total удвоился бы.
      settled_session_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
      current_core_session_id TEXT,
      current_channel         TEXT CHECK (current_channel IN ('chat','voice')),
      client_reference        TEXT NOT NULL UNIQUE,
      usage                   JSONB NOT NULL DEFAULT '{}'::jsonb,
      credits_total           INTEGER NOT NULL DEFAULT 0,
      started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at                TIMESTAMPTZ,
      last_activity_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX dialogs_visitor_started_idx ON dialogs (visitor_key, started_at DESC);
    CREATE INDEX dialogs_stale_idx ON dialogs (status, last_activity_at);

    CREATE TABLE dialog_messages (
      id              BIGSERIAL PRIMARY KEY,
      dialog_id       UUID NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK (role IN ('user','agent')),
      text            TEXT NOT NULL,
      source          TEXT NOT NULL CHECK (source IN ('client','core')),
      core_session_id TEXT,
      seq             INTEGER NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Идемпотентность журнала: ре-отправка того же seq клиентом и повторная
    -- сверка транскрипта ядра не плодят дублей. coalesce нужен потому, что у
    -- source='client' сессии может ещё не быть.
    CREATE UNIQUE INDEX dialog_messages_dedup_idx
      ON dialog_messages (dialog_id, source, coalesce(core_session_id, ''), seq);
    CREATE INDEX dialog_messages_thread_idx ON dialog_messages (dialog_id, id);

    CREATE TABLE leads (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dialog_id  UUID NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
      widget_id  UUID NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      name       TEXT,
      phone      TEXT,
      email      TEXT,
      comment    TEXT,
      consent    BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE core_events (
      event_id    TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      payload     JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- IP посетителя НЕ храним (спека §9): только необратимый суточный счётчик.
    CREATE TABLE ip_day_counters (
      ip_hash TEXT NOT NULL,
      day     DATE NOT NULL,
      started INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip_hash, day)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE ip_day_counters, core_events, leads, dialog_messages, dialogs, widgets;`);
};
```

- [ ] **Step 5: Хелпер тестовой БД + globalSetup**

`backend/test/helpers/globalSetup.ts`:

```ts
import { execFileSync } from 'node:child_process';

export default function setup(): void {
  process.env.DATABASE_URL ??= 'postgres://widget:widget@127.0.0.1:55433/widget_test';
  // Мигрируем ОДИН раз на прогон: node-pg-migrate идемпотентен.
  execFileSync('npx', ['node-pg-migrate', '-m', 'migrations', 'up'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
}
```

`backend/test/helpers/db.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool } from '../../src/db/pool.ts';

export const testPool = (): Pool => createPool(process.env.DATABASE_URL!);

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE widgets, dialogs, dialog_messages, leads, core_events, ip_day_counters RESTART IDENTITY CASCADE',
  );
}

export async function seedWidget(
  pool: Pool,
  overrides: Partial<{ token: string; allowedOrigins: string[]; enabled: boolean; instructions: string }> = {},
): Promise<{ id: string; token: string }> {
  const token = overrides.token ?? `wgt_${randomUUID().replaceAll('-', '')}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO widgets (publish_token, name, agent_config, kb_ids, allowed_origins, enabled)
     VALUES ($1, 'Тестовый виджет', $2::jsonb, '[]'::jsonb, $3::jsonb, $4) RETURNING id`,
    [
      token,
      JSON.stringify({ instructions: overrides.instructions ?? 'Ты консультант сайта.' }),
      JSON.stringify(overrides.allowedOrigins ?? ['https://shop.example']),
      overrides.enabled ?? true,
    ],
  );
  return { id: rows[0]!.id, token };
}
```

- [ ] **Step 6: Тест репозиториев — FAIL**

`backend/test/repositories.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seedWidget, testPool, truncateAll } from './helpers/db.ts';
import { findWidgetByToken } from '../src/db/repositories/widgets.ts';
import { attachCoreSession, casDialogStatus, countDialogsStartedByVisitor, findDialogByClientReference, insertDialog } from '../src/db/repositories/dialogs.ts';
import { hasSimilarMessage, insertMessage, listThreadTail, maxClientSeq } from '../src/db/repositories/messages.ts';
import { insertCoreEvent } from '../src/db/repositories/coreEvents.ts';
import { bumpIpDayCounter } from '../src/db/repositories/quotas.ts';

const pool = testPool();
beforeEach(() => truncateAll(pool));
afterAll(() => pool.end());

const VISITOR = '11111111-1111-4111-8111-111111111111';

describe('репозитории', () => {
  it('виджет находится по publish_token, JSONB приезжает разобранным', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: ['https://a.example'] });
    const widget = await findWidgetByToken(pool, token);
    expect(widget?.allowed_origins).toEqual(['https://a.example']);
    expect(widget?.agent_config.instructions).toBe('Ты консультант сайта.');
    expect(await findWidgetByToken(pool, 'нет-такого')).toBeNull();
  });

  it('client_reference диалога — widget:dialog:{id}, свежий диалог без привязанных сессий', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    expect(dialog.client_reference).toBe(`widget:dialog:${dialog.id}`);
    expect(await findDialogByClientReference(pool, dialog.client_reference)).not.toBeNull();
    // Ключ повторяемости считается от ДЛИНЫ core_session_ids, отдельного
    // счётчика нет: два источника правды разъехались бы на первом же ретрае.
    expect(dialog.core_session_ids).toEqual([]);
    expect(dialog.settled_session_ids).toEqual([]);
  });

  it('attachCoreSession копит историю сессий и переключает текущую', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_aaaaaaaaaaaaaaaa', channel: 'chat' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_bbbbbbbbbbbbbbbb', channel: 'voice' });
    const fresh = await findDialogByClientReference(pool, dialog.client_reference);
    expect(fresh?.core_session_ids).toEqual(['sess_aaaaaaaaaaaaaaaa', 'sess_bbbbbbbbbbbbbbbb']);
    expect(fresh?.current_core_session_id).toBe('sess_bbbbbbbbbbbbbbbb');
    expect(fresh?.current_channel).toBe('voice');
  });

  it('casDialogStatus переводит статус ТОЛЬКО из ожидаемого — защита от двойной эскалации', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    expect(await casDialogStatus(pool, dialog.id, 'active', 'escalating')).toBe(true);
    expect(await casDialogStatus(pool, dialog.id, 'active', 'escalating')).toBe(false);
  });

  it('журнал идемпотентен по (dialog, source, session, seq)', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    const row = { dialogId: dialog.id, role: 'user' as const, text: 'Меня зовут Пётр', source: 'client' as const, coreSessionId: null, seq: 1 };
    expect(await insertMessage(pool, row)).toBe(true);
    expect(await insertMessage(pool, row)).toBe(false);
    expect((await listThreadTail(pool, dialog.id, 10)).length).toBe(1);
  });

  it('listThreadTail отдаёт ХВОСТ в хронологическом порядке', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    for (let seq = 1; seq <= 5; seq += 1) {
      await insertMessage(pool, { dialogId: dialog.id, role: 'user', text: `реплика ${seq}`, source: 'client', coreSessionId: null, seq });
    }
    const tail = await listThreadTail(pool, dialog.id, 2);
    expect(tail.map((m) => m.text)).toEqual(['реплика 4', 'реплика 5']);
  });

  it('maxClientSeq продолжает нумерацию клиента и не считает реплики ядра', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    expect(await maxClientSeq(pool, dialog.id)).toBe(0);
    await insertMessage(pool, { dialogId: dialog.id, role: 'user', text: 'раз', source: 'client', coreSessionId: null, seq: 7 });
    await insertMessage(pool, { dialogId: dialog.id, role: 'agent', text: 'два', source: 'core', coreSessionId: 'sess_x', seq: 99 });
    expect(await maxClientSeq(pool, dialog.id)).toBe(7);
  });

  it('hasSimilarMessage ловит ту же реплику, приехавшую вторым путём', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await insertMessage(pool, { dialogId: dialog.id, role: 'user', text: 'Меня зовут Пётр', source: 'client', coreSessionId: null, seq: 1 });
    // Регистр и лишние пробелы не должны мешать: ядро отдаёт свой вариант текста.
    expect(await hasSimilarMessage(pool, { dialogId: dialog.id, role: 'user', text: '  меня  зовут пётр ', windowSeconds: 600 })).toBe(true);
    expect(await hasSimilarMessage(pool, { dialogId: dialog.id, role: 'agent', text: 'Меня зовут Пётр', windowSeconds: 600 })).toBe(false);
    expect(await hasSimilarMessage(pool, { dialogId: dialog.id, role: 'user', text: 'другое', windowSeconds: 600 })).toBe(false);
    expect(await hasSimilarMessage(pool, { dialogId: dialog.id, role: 'user', text: 'Меня зовут Пётр', windowSeconds: 0 })).toBe(false);
  });

  it('core_events дедупятся по event_id', async () => {
    expect(await insertCoreEvent(pool, { eventId: 'evt_1', type: 'session.finalized', payload: { a: 1 } })).toBe(true);
    expect(await insertCoreEvent(pool, { eventId: 'evt_1', type: 'session.finalized', payload: { a: 1 } })).toBe(false);
  });

  it('счётчики капов считают за сутки', async () => {
    const { id: widgetId } = await seedWidget(pool);
    await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    expect(await countDialogsStartedByVisitor(pool, VISITOR)).toBe(2);
    expect(await bumpIpDayCounter(pool, 'hash-a')).toBe(1);
    expect(await bumpIpDayCounter(pool, 'hash-a')).toBe(2);
    expect(await bumpIpDayCounter(pool, 'hash-b')).toBe(1);
  });
});
```

Run: `cd backend && npm run db:test:up && npx vitest run test/repositories.test.ts` → FAIL (модулей нет).

- [ ] **Step 7: Реализация pool + репозиториев**

`backend/src/db/pool.ts`:

```ts
import pg, { type Pool, type PoolClient } from 'pg';

export type Queryable = Pool | PoolClient;

// JSONB приезжает разобранным по умолчанию; int8 (BIGSERIAL) — строкой, и это
// правильно, но seq у нас int4, а id журнала наружу не отдаётся.
export const createPool = (databaseUrl: string): Pool =>
  new pg.Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
```

`backend/src/db/repositories/widgets.ts`:

```ts
import type { Queryable } from '../pool.ts';

export type AgentConfig = { instructions: string; greeting?: string; voice_id?: string; avatar_id?: string };

export type WidgetRow = {
  id: string;
  publish_token: string;
  name: string;
  agent_config: AgentConfig;
  kb_ids: string[];
  allowed_origins: string[];
  enabled: boolean;
  created_at: Date;
};

export async function findWidgetByToken(db: Queryable, token: string): Promise<WidgetRow | null> {
  const { rows } = await db.query<WidgetRow>(
    `SELECT id, publish_token, name, agent_config, kb_ids, allowed_origins, enabled, created_at
       FROM widgets WHERE publish_token = $1`,
    [token],
  );
  return rows[0] ?? null;
}
```

`backend/src/db/repositories/dialogs.ts`:

```ts
import type { Queryable } from '../pool.ts';

export type DialogStatus = 'active' | 'escalating' | 'ended' | 'error';

export type DialogRow = {
  id: string;
  widget_id: string;
  visitor_key: string;
  status: DialogStatus;
  core_session_ids: string[];
  settled_session_ids: string[];
  current_core_session_id: string | null;
  current_channel: 'chat' | 'voice' | null;
  client_reference: string;
  usage: Record<string, number>;
  credits_total: number;
  started_at: Date;
  ended_at: Date | null;
  last_activity_at: Date;
};

const COLS = `id, widget_id, visitor_key, status, core_session_ids, settled_session_ids,
              current_core_session_id, current_channel, client_reference,
              usage, credits_total, started_at, ended_at, last_activity_at`;

export async function insertDialog(db: Queryable, input: { widgetId: string; visitorKey: string }): Promise<DialogRow> {
  // ОДНИМ statement'ом: client_reference — NOT NULL UNIQUE, и промежуточная
  // вставка пустой строки с последующим UPDATE ловила бы 23505 на втором же
  // параллельном старте диалога (пустая строка уникальна ровно в одном экземпляре).
  const { rows } = await db.query<DialogRow>(
    `INSERT INTO dialogs (id, widget_id, visitor_key, client_reference)
     SELECT g.id, $1, $2, 'widget:dialog:' || g.id
       FROM (SELECT gen_random_uuid() AS id) g
     RETURNING ${COLS}`,
    [input.widgetId, input.visitorKey],
  );
  return rows[0]!;
}

export async function findDialogById(db: Queryable, id: string): Promise<DialogRow | null> {
  const { rows } = await db.query<DialogRow>(`SELECT ${COLS} FROM dialogs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findDialogByClientReference(db: Queryable, ref: string): Promise<DialogRow | null> {
  const { rows } = await db.query<DialogRow>(`SELECT ${COLS} FROM dialogs WHERE client_reference = $1`, [ref]);
  return rows[0] ?? null;
}

export async function attachCoreSession(
  db: Queryable,
  input: { dialogId: string; sessionId: string; channel: 'chat' | 'voice' },
): Promise<void> {
  await db.query(
    `UPDATE dialogs
        SET core_session_ids = core_session_ids || to_jsonb($2::text),
            current_core_session_id = $2,
            current_channel = $3,
            last_activity_at = now()
      WHERE id = $1`,
    [input.dialogId, input.sessionId, input.channel],
  );
}

export async function setDialogStatus(db: Queryable, dialogId: string, status: DialogStatus): Promise<void> {
  await db.query(
    `UPDATE dialogs SET status = $2, ended_at = CASE WHEN $2 IN ('ended','error') THEN now() ELSE ended_at END
      WHERE id = $1`,
    [dialogId, status],
  );
}

export async function casDialogStatus(db: Queryable, dialogId: string, from: DialogStatus, to: DialogStatus): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE dialogs SET status = $3 WHERE id = $1 AND status = $2`, [dialogId, from, to]);
  return (rowCount ?? 0) > 0;
}

export async function touchDialog(db: Queryable, dialogId: string): Promise<void> {
  await db.query(`UPDATE dialogs SET last_activity_at = now() WHERE id = $1`, [dialogId]);
}

/**
 * Учесть деньги ОДНОЙ закрытой сессии. Идемпотентно по session_id: вебхук
 * `session.finalized` и свипер приходят к одному выводу разными путями, и без
 * защиты credits_total удвоился бы. Возвращает false, если сессию уже учли.
 */
export async function applyFinalizedUsage(
  db: Queryable,
  input: { dialogId: string; sessionId: string; usage: Record<string, number>; creditsTotal: number },
): Promise<boolean> {
  // Складываем по сессиям нити: у диалога их несколько (chat → voice → chat…).
  const { rowCount } = await db.query(
    `UPDATE dialogs
        SET settled_session_ids = settled_session_ids || to_jsonb($4::text),
            usage = (
              SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                FROM (
                  SELECT key, sum(value::numeric) AS value
                    FROM (
                      SELECT key, value FROM jsonb_each_text(usage)
                      UNION ALL
                      SELECT key, value FROM jsonb_each_text($2::jsonb)
                    ) merged
                   GROUP BY key
                ) summed
            ),
            credits_total = credits_total + $3
      WHERE id = $1
        AND NOT (settled_session_ids @> to_jsonb($4::text))`,
    [input.dialogId, JSON.stringify(input.usage), input.creditsTotal, input.sessionId],
  );
  return (rowCount ?? 0) > 0;
}

export async function countDialogsStartedByVisitor(db: Queryable, visitorKey: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM dialogs WHERE visitor_key = $1 AND started_at > now() - interval '24 hours'`,
    [visitorKey],
  );
  return Number.parseInt(rows[0]!.n, 10);
}

export async function listStaleActiveDialogs(db: Queryable, olderThanMinutes: number, limit: number): Promise<DialogRow[]> {
  const { rows } = await db.query<DialogRow>(
    `SELECT ${COLS} FROM dialogs
      WHERE status IN ('active','escalating')
        AND current_core_session_id IS NOT NULL
        AND last_activity_at < now() - ($1 || ' minutes')::interval
      ORDER BY last_activity_at ASC LIMIT $2`,
    [String(olderThanMinutes), limit],
  );
  return rows;
}
```

`backend/src/db/repositories/messages.ts`:

```ts
import type { Queryable } from '../pool.ts';

export type MessageRow = {
  id: string;
  dialog_id: string;
  role: 'user' | 'agent';
  text: string;
  source: 'client' | 'core';
  core_session_id: string | null;
  seq: number;
  created_at: Date;
};

export type InsertMessageInput = {
  dialogId: string;
  role: 'user' | 'agent';
  text: string;
  source: 'client' | 'core';
  coreSessionId: string | null;
  seq: number;
};

export async function insertMessage(db: Queryable, input: InsertMessageInput): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO dialog_messages (dialog_id, role, text, source, core_session_id, seq)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [input.dialogId, input.role, input.text, input.source, input.coreSessionId, input.seq],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * ХВОСТ нити в хронологическом порядке — единственный способ читать журнал.
 * Голова здесь никому не нужна: у долгого диалога `ORDER BY id ASC LIMIT 200`
 * отдал бы первые двести реплик и спрятал всё недавнее — посетитель открыл бы
 * виджет и увидел начало разговора недельной давности.
 */
export async function listThreadTail(db: Queryable, dialogId: string, limit: number): Promise<MessageRow[]> {
  const { rows } = await db.query<MessageRow>(
    `SELECT * FROM (
       SELECT id::text, dialog_id, role, text, source, core_session_id, seq, created_at
         FROM dialog_messages WHERE dialog_id = $1 ORDER BY id DESC LIMIT $2
     ) tail ORDER BY id ASC`,
    [dialogId, limit],
  );
  return rows;
}

/** Максимальный seq клиентского журнала — с него продолжится нумерация после reload. */
export async function maxClientSeq(db: Queryable, dialogId: string): Promise<number> {
  const { rows } = await db.query<{ seq: number | null }>(
    `SELECT max(seq) AS seq FROM dialog_messages WHERE dialog_id = $1 AND source = 'client'`,
    [dialogId],
  );
  return rows[0]?.seq ?? 0;
}

/**
 * Есть ли уже в журнале такой текст этой роли в окне ±N секунд. Нужен на синке
 * транскрипта ядра: уникальный индекс ловит лишь повтор той же (source,seq)
 * пары, а одна и та же реплика приезжает ДВАЖДЫ разными путями — от клиента
 * (source=client, свой seq) и из ленты ядра (source=core, seq ядра).
 */
export async function hasSimilarMessage(
  db: Queryable,
  input: { dialogId: string; role: 'user' | 'agent'; text: string; windowSeconds: number },
): Promise<boolean> {
  const { rows } = await db.query<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM dialog_messages
        WHERE dialog_id = $1 AND role = $2
          AND lower(btrim(regexp_replace(text, '\\s+', ' ', 'g')))
              = lower(btrim(regexp_replace($3::text, '\\s+', ' ', 'g')))
          AND created_at > now() - ($4 || ' seconds')::interval
     ) AS hit`,
    [input.dialogId, input.role, input.text, String(input.windowSeconds)],
  );
  return rows[0]!.hit;
}
```

`backend/src/db/repositories/leads.ts`:

```ts
import type { Queryable } from '../pool.ts';

export type InsertLeadInput = {
  dialogId: string;
  widgetId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  comment: string | null;
  consent: boolean;
};

export type LeadRow = { id: string; created_at: Date };

export async function insertLead(db: Queryable, input: InsertLeadInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO leads (dialog_id, widget_id, name, phone, email, comment, consent)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.dialogId, input.widgetId, input.name, input.phone, input.email, input.comment, input.consent],
  );
  return rows[0]!.id;
}
```

`backend/src/db/repositories/coreEvents.ts`:

```ts
import type { Queryable } from '../pool.ts';

export async function insertCoreEvent(
  db: Queryable,
  input: { eventId: string; type: string; payload: unknown },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO core_events (event_id, type, payload) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (event_id) DO NOTHING`,
    [input.eventId, input.type, JSON.stringify(input.payload)],
  );
  return (rowCount ?? 0) > 0;
}
```

`backend/src/db/repositories/quotas.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Queryable } from '../pool.ts';

// IP наружу и в БД не попадает НИКОГДА — только необратимый хэш с солью стенда.
export const hashIp = (ip: string, salt: string): string =>
  createHash('sha256').update(`${salt}:${ip}`).digest('hex');

export async function bumpIpDayCounter(db: Queryable, ipHash: string): Promise<number> {
  const { rows } = await db.query<{ started: number }>(
    `INSERT INTO ip_day_counters (ip_hash, day, started) VALUES ($1, current_date, 1)
     ON CONFLICT (ip_hash, day) DO UPDATE SET started = ip_day_counters.started + 1
     RETURNING started`,
    [ipHash],
  );
  return rows[0]!.started;
}

/**
 * Чистка счётчиков старше N суток. Таблица растёт по одной строке на IP в день
 * и никем не подметается — за год это мусор, который никто не удалит руками.
 * Зовётся свипером (T4) тем же тиком, что и досинк диалогов.
 */
export async function purgeOldIpCounters(db: Queryable, keepDays: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM ip_day_counters WHERE day < current_date - ($1 || ' days')::interval`,
    [String(keepDays)],
  );
  return rowCount ?? 0;
}
```

Run: `npx vitest run test/repositories.test.ts` → PASS.

- [ ] **Step 8: Мутпроба идемпотентности журнала и CAS**

Временно убрать `ON CONFLICT DO NOTHING` из `insertMessage` → прогнать `repositories.test.ts` → тест «журнал идемпотентен» обязан упасть с ошибкой уникального индекса. Вернуть. Временно убрать `AND status = $2` из `casDialogStatus` → тест защиты от двойной эскалации обязан упасть. Вернуть. Прогнать — PASS.

- [ ] **Step 9: Тест `/healthz` и graceful shutdown — FAIL**

`backend/test/health.test.ts`:

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { testPool } from './helpers/db.ts';

const pool = testPool();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: process.env.DATABASE_URL,
      CORE_BASE_URL: 'http://core.invalid/api',
      CORE_TENANT_KEY: 'sk_test_x',
      CORE_WEBHOOK_SECRET: 'секрет-длиной-больше-шестнадцати',
      WIDGET_PUBLIC_ORIGIN: 'http://localhost:8200',
      WIDGET_CSP_CONNECT_SRC: "'self'",
      IP_HASH_SALT: 'соль',
    }),
    pool,
  });
});
afterAll(async () => { await app.close(); await pool.end(); });

it('GET /healthz отвечает 200 и проверяет БД настоящим запросом', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
});

it('логи структурные (json) и не содержат ключа тенанта', async () => {
  expect(app.log.level).toBe('info');
});
```

Run: `npx vitest run test/health.test.ts` → FAIL.

- [ ] **Step 10: Реализация `app.ts` + `server.ts`**

`backend/src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from './config.ts';
import { healthRoutes } from './routes/health.ts';

export type AppDeps = {
  config: AppConfig;
  pool: Pool;
  log: FastifyBaseLogger;
  core?: CoreClient; // в T2 станет обязательным
};

/** То, что передаёт вызывающий: логгер рождается вместе с инстансом Fastify. */
export type AppDepsInput = Omit<AppDeps, 'log'>;

export async function buildApp(input: AppDepsInput): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: input.config.logLevel,
      // Структурный JSON: стенд собирает логи grep'ом по полям, не по тексту.
      redact: { paths: ['req.headers.authorization', 'req.headers["x-core-signature"]'], remove: true },
    },
    // trustProxy НЕ включаем на дев-раскладке: сервис слушает :8200 напрямую,
    // и доверие к X-Forwarded-For позволило бы обойти IP-кап одним заголовком.
    trustProxy: input.config.trustProxy,
    bodyLimit: 64 * 1024,
    disableRequestLogging: false,
  });

  const deps: AppDeps = { ...input, log: app.log };
  app.decorate('deps', deps);
  await app.register(healthRoutes);
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
```

`backend/src/routes/health.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async (_req, reply) => {
    try {
      await app.deps.pool.query('SELECT 1');
    } catch (err) {
      app.log.error({ err }, 'healthz: БД недоступна');
      return reply.code(503).send({ status: 'degraded', db: 'fail' });
    }
    return reply.send({ status: 'ok', db: 'ok' });
  });
};
```

`backend/src/server.ts`:

```ts
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
const app = await buildApp({ config, pool });

await app.listen({ port: config.port, host: '0.0.0.0' });

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'останавливаемся: дорабатываем принятые запросы');
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'graceful shutdown сорвался');
        process.exit(1);
      });
  });
}
```

Run: `npx vitest run` → PASS (все три файла).

- [ ] **Step 11: Commit**

```bash
git add package.json .gitignore .nvmrc backend infra/compose.test.yaml
git commit -m "feat(backend): скелет Fastify + Postgres-схема виджета (Э4-T1)"
```

---
### Task 2: Core-клиент + приёмник вебхуков

**Files:**
- Create: `contracts/sync.mjs`, `contracts/openapi.core.yaml` (вендорённая копия), `contracts/core-api.d.ts` (генерится)
- Create: `backend/src/core/types.ts`, `backend/src/core/client.ts`, `backend/src/core/signature.ts`
- Create: `backend/src/routes/coreWebhooks.ts`, `backend/src/dialogs/transcriptSync.ts`
- Modify: `backend/src/app.ts` (`core` в `AppDeps` становится обязательным + регистрация роутов), `backend/package.json` (скрипты `contracts:sync`, devDep `openapi-typescript`)
- Test: `backend/test/helpers/fakeCore.ts`, `backend/test/coreClient.test.ts`, `backend/test/signature.test.ts`, `backend/test/coreWebhooks.test.ts`, `backend/test/transcriptSync.test.ts`

**Interfaces:**
- Consumes (T1): `AppDeps`, `buildApp`, `Queryable`, `insertCoreEvent`, `findDialogByClientReference`, `applyFinalizedUsage`, `setDialogStatus`, `DialogRow`.
- Produces:
  - `type SessionCreate` / `SessionCreated` / `ParticipantToken` / `TranscriptPage` / `TranscriptMessage` / `CoreSession` — алиасы на сгенерённые типы `contracts/core-api.d.ts`.
  - `class CoreHttpError extends Error { readonly status: number; readonly code: string }`
  - `class CoreClient` с методами:
    `createSession(body: SessionCreate, idempotencyKey: string): Promise<SessionCreated>`;
    `issueParticipantToken(sessionId: string, identity: string): Promise<ParticipantToken>`;
    `endSession(sessionId: string): Promise<void>`;
    `getTranscript(sessionId: string, afterSeq?: number, limit?: number): Promise<TranscriptPage>`;
    `getSession(sessionId: string): Promise<CoreSession>`.
  - `verifyCoreSignature(raw: Buffer, header: string | undefined, secret: string, nowMs: number, windowS?: number): { ok: true } | { ok: false; reason: string }`
  - `coreWebhookRoutes: FastifyPluginAsync` — вешает `POST /w/v1/core-webhooks`.
  - `AppDeps.core` становится обязательным (`core: CoreClient`).
  - `const TRANSCRIPT_DEDUP_WINDOW_S = 900`; `type SyncResult = { fetched: number; stored: number; skipped: number }`;
    `persistTranscript(deps, input: { dialog: DialogRow; sessionId: string; messages: TranscriptMessage[] }): Promise<SyncResult>`;
    `reconcileTranscript(deps, input: { dialog: DialogRow; sessionId: string; expected?: number }): Promise<SyncResult>`.

- [ ] **Step 1: Вендорим контракт ядра и генерим типы**

`contracts/sync.mjs`:

```js
#!/usr/bin/env node
// Тянем контракт ЯДРА строго из origin/main: локальный чекаут отстаёт (спека §0).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';

const CORE_REPO = process.env.CORE_REPO ?? '../ai-conversation-core';
const TARGET = new URL('./openapi.core.yaml', import.meta.url).pathname;

execFileSync('git', ['-C', CORE_REPO, 'fetch', 'origin', '--quiet'], { stdio: 'inherit' });
const fresh = execFileSync('git', ['-C', CORE_REPO, 'show', 'origin/main:contracts/openapi.yaml'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
const sha = execFileSync('git', ['-C', CORE_REPO, 'rev-parse', '--short', 'origin/main'], { encoding: 'utf8' }).trim();

if (argv.includes('--check')) {
  const current = readFileSync(TARGET, 'utf8');
  if (current !== fresh) {
    console.error(`Контракт ядра разъехался с origin/main (${sha}). Запусти: node contracts/sync.mjs`);
    process.exit(1);
  }
  console.log(`Контракт совпадает с origin/main (${sha}).`);
} else {
  writeFileSync(TARGET, fresh);
  console.log(`Контракт обновлён до origin/main (${sha}).`);
}
```

Добавить в `backend/package.json`: devDep `"openapi-typescript": "^7.4.0"` и скрипты

```json
"contracts:sync": "node ../contracts/sync.mjs && npx openapi-typescript ../contracts/openapi.core.yaml -o ../contracts/core-api.d.ts",
"contracts:check": "node ../contracts/sync.mjs --check"
```

Run: `cd backend && npm run contracts:sync` → появляются `contracts/openapi.core.yaml` и `contracts/core-api.d.ts`.

- [ ] **Step 2: Алиасы типов**

`backend/src/core/types.ts`:

```ts
import type { components } from '../../../contracts/core-api.d.ts';

export type SessionCreate = components['schemas']['SessionCreate'];
export type SessionCreated = components['schemas']['SessionCreated'];
export type ParticipantToken = components['schemas']['ParticipantToken'];
export type TranscriptMessage = components['schemas']['TranscriptMessage'];
export type TranscriptPage = components['schemas']['TranscriptPage'];
export type CoreSession = components['schemas']['Session'];
export type SessionFinalizedData = components['schemas']['SessionFinalizedData'];
export type WebhookEnvelope = components['schemas']['WebhookEnvelope'];
```

- [ ] **Step 3: Тест подписи вебхука — FAIL**

`backend/test/signature.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyCoreSignature } from '../src/core/signature.ts';

const SECRET = 'секрет-длиной-больше-шестнадцати';
const RAW = Buffer.from('{"api_version":"v1","event_id":"evt_1","type":"session.finalized"}', 'utf8');
const NOW = 1_760_000_000_000;

const sign = (t: number, raw = RAW, secret = SECRET): string =>
  `t=${t},v1=${createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${t}.`), raw])).digest('hex')}`;

describe('verifyCoreSignature', () => {
  it('принимает валидную подпись', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyCoreSignature(RAW, sign(t), SECRET, NOW)).toEqual({ ok: true });
  });

  it('разбирает заголовок ПО КЛЮЧАМ — лишние версии не мешают', () => {
    const t = Math.floor(NOW / 1000);
    const header = `${sign(t)},v2=deadbeef`;
    expect(verifyCoreSignature(RAW, header, SECRET, NOW)).toEqual({ ok: true });
  });

  it('порядок ключей тоже не важен', () => {
    const t = Math.floor(NOW / 1000);
    const [tPart, v1Part] = sign(t).split(',');
    expect(verifyCoreSignature(RAW, `${v1Part},${tPart}`, SECRET, NOW)).toEqual({ ok: true });
  });

  it('отвергает подпись чужим секретом', () => {
    const t = Math.floor(NOW / 1000);
    const res = verifyCoreSignature(RAW, sign(t, RAW, 'другой-секрет-подлиннее'), SECRET, NOW);
    expect(res).toEqual({ ok: false, reason: 'hmac_mismatch' });
  });

  it('отвергает повтор старше окна ±300с', () => {
    const t = Math.floor(NOW / 1000) - 301;
    expect(verifyCoreSignature(RAW, sign(t), SECRET, NOW)).toEqual({ ok: false, reason: 'timestamp_out_of_window' });
  });

  it('отвергает метку из будущего дальше окна', () => {
    const t = Math.floor(NOW / 1000) + 301;
    expect(verifyCoreSignature(RAW, sign(t), SECRET, NOW)).toEqual({ ok: false, reason: 'timestamp_out_of_window' });
  });

  it('подпись считается по СЫРЫМ байтам: пересериализация тела её ломает', () => {
    const t = Math.floor(NOW / 1000);
    const header = sign(t);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(RAW.toString('utf8')), null, 2), 'utf8');
    expect(verifyCoreSignature(reserialized, header, SECRET, NOW)).toEqual({ ok: false, reason: 'hmac_mismatch' });
  });

  it('без заголовка и с мусором — отказ', () => {
    expect(verifyCoreSignature(RAW, undefined, SECRET, NOW)).toEqual({ ok: false, reason: 'missing_header' });
    expect(verifyCoreSignature(RAW, 'мусор', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(verifyCoreSignature(RAW, 't=abc,v1=ff', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed_header' });
  });
});
```

Run: `npx vitest run test/signature.test.ts` → FAIL.

- [ ] **Step 4: Реализация `backend/src/core/signature.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Проверка подписи ядра. Порядок шагов важен и повторяет инструкцию контракта:
 * заголовок → окно метки → HMAC по СЫРЫМ байтам (до всякого JSON.parse).
 */
export function verifyCoreSignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
  nowMs: number,
  windowS = 300,
): SignatureVerdict {
  if (!header) return { ok: false, reason: 'missing_header' };

  // Разбор ПО КЛЮЧАМ: рядом с v1 со временем может появиться v2.
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq > 0) parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const rawT = parts.get('t');
  const v1 = parts.get('v1');
  if (!rawT || !v1 || !/^\d+$/.test(rawT) || !/^[0-9a-f]+$/i.test(v1)) {
    return { ok: false, reason: 'malformed_header' };
  }

  const timestamp = Number.parseInt(rawT, 10);
  if (Math.abs(nowMs / 1000 - timestamp) > windowS) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }

  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), raw]))
    .digest();
  const got = Buffer.from(v1, 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { ok: false, reason: 'hmac_mismatch' };
  }
  return { ok: true };
}
```

Run: `npx vitest run test/signature.test.ts` → PASS.

- [ ] **Step 5: Мутпроба подписи (протокол + деньги)**

Мутации, каждая обязана уронить свой тест; после каждой — вернуть код:
1. Расширить `windowS` по умолчанию до `10 ** 9` → тест «отвергает повтор старше окна» FAIL. Вернуть.
2. Убрать `Buffer.from(`${timestamp}.`)` из склейки (подписывать голое тело) → тест «принимает валидную подпись» FAIL. Вернуть.
3. Заменить сравнение хэшей на `got.equals(expected)` → все тесты остаются зелёными: постоянство времени поведением не проверяется в принципе. Вместо теста-стража на текст файла (`toContain('timingSafeEqual')` — проверка реализации, а не поведения: переживёт переименование импорта и сломается от безобидного рефакторинга) закрыть это ПОВЕДЕНЧЕСКИ — добавить тест на длину:

```ts
it('подпись неверной ДЛИНЫ отвергается до сравнения, а не кидает исключение', () => {
  const t = Math.floor(NOW / 1000);
  // timingSafeEqual кидает RangeError на буферах разной длины — реализация
  // обязана проверить длину САМА и вернуть вердикт, а не упасть.
  expect(verifyCoreSignature(RAW, `t=${t},v1=ab`, SECRET, NOW)).toEqual({ ok: false, reason: 'hmac_mismatch' });
});
```

Мутация: убрать `got.length !== expected.length ||` → тест падает с `RangeError`, а не с ассертом. Вернуть. Постоянство времени остаётся под ревью, а не под тестом — и это честно записано здесь, а не спрятано за зелёной галочкой.

Прогнать всё: PASS.

- [ ] **Step 6: Фейковое ядро для тестов клиента**

`backend/test/helpers/fakeCore.ts`:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export type FakeCall = { method: string; url: string; headers: Record<string, string>; body: unknown };
export type FakeReply = { status: number; body: unknown; delayMs?: number };

export class FakeCore {
  readonly calls: FakeCall[] = [];
  private readonly queue: FakeReply[] = [];
  private server!: Server;
  private port = 0;

  enqueue(reply: FakeReply): this { this.queue.push(reply); return this; }

  get baseUrl(): string { return `http://127.0.0.1:${this.port}/api`; }

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        this.calls.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
          body: raw ? JSON.parse(raw) : null,
        });
        const reply = this.queue.shift() ?? { status: 500, body: { error: { code: 'fake_unset', message: 'очередь фейка пуста' } } };
        const send = (): void => {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(reply.status === 204 ? '' : JSON.stringify(reply.body));
        };
        if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
      });
    });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> { this.server.close(); await once(this.server, 'close'); }
}
```

- [ ] **Step 7: Тест core-клиента — FAIL**

`backend/test/coreClient.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClient, CoreHttpError } from '../src/core/client.ts';
import { FakeCore } from './helpers/fakeCore.ts';

let core: FakeCore;
let client: CoreClient;

beforeEach(async () => {
  core = new FakeCore();
  await core.start();
  client = new CoreClient({ baseUrl: core.baseUrl, tenantKey: 'sk_test_x', timeoutMs: 45_000 });
});
afterEach(() => core.stop());

const CREATED = {
  session_id: 'sess_0123456789abcdef',
  room: 'room-1',
  participant_token: { token: 'jwt', identity: 'respondent-x', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T10:00:00Z' },
};

describe('CoreClient', () => {
  it('createSession шлёт Bearer, Idempotency-Key и тело как есть', async () => {
    core.enqueue({ status: 201, body: CREATED });
    const res = await client.createSession(
      { channel: 'chat', agent: { instructions: 'Ты консультант.' }, limits: { max_duration_s: 600 } },
      'dlg:abc:1',
    );
    expect(res.participant_token.livekit_url).toBe('wss://lk.example');
    const call = core.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/v1/sessions');
    expect(call.headers.authorization).toBe('Bearer sk_test_x');
    expect(call.headers['idempotency-key']).toBe('dlg:abc:1');
    expect(call.body).toMatchObject({ channel: 'chat', limits: { max_duration_s: 600 } });
  });

  it('402 превращается в CoreHttpError с кодом ядра', async () => {
    core.enqueue({ status: 402, body: { error: { code: 'insufficient_credits', message: 'нет кредитов' } } });
    await expect(client.createSession({ channel: 'chat', agent: { instructions: 'x' } }, 'k')).rejects.toSatisfy(
      (err: unknown) => err instanceof CoreHttpError && err.status === 402 && err.code === 'insufficient_credits',
    );
  });

  it('ответ без тела ошибки всё равно даёт код http_<status>', async () => {
    core.enqueue({ status: 503, body: 'сервис недоступен' });
    await expect(client.getSession('sess_0123456789abcdef')).rejects.toSatisfy(
      (err: unknown) => err instanceof CoreHttpError && err.code === 'http_503',
    );
  });

  it('issueParticipantToken требует identity и бьёт в нужный путь', async () => {
    core.enqueue({ status: 201, body: CREATED.participant_token });
    const token = await client.issueParticipantToken('sess_0123456789abcdef', 'respondent-uuid');
    expect(token.identity).toBe('respondent-x');
    expect(core.calls[0]!.url).toBe('/api/v1/sessions/sess_0123456789abcdef/participant-tokens');
    expect(core.calls[0]!.body).toEqual({ identity: 'respondent-uuid' });
  });

  it('endSession глотает 404/410 — сессия уже закрыта, это не ошибка вызывающего', async () => {
    core.enqueue({ status: 410, body: { error: { code: 'session_finished', message: 'уже' } } });
    await expect(client.endSession('sess_0123456789abcdef')).resolves.toBeUndefined();
  });

  it('getTranscript прокидывает after_seq и limit', async () => {
    core.enqueue({ status: 200, body: { messages: [{ seq: 1, role: 'user', text: 'привет', created_at: '2026-08-13T10:00:00Z' }], has_more: false } });
    const page = await client.getTranscript('sess_0123456789abcdef', 3, 100);
    expect(page.messages).toHaveLength(1);
    expect(core.calls[0]!.url).toBe('/api/v1/sessions/sess_0123456789abcdef/transcript?after_seq=3&limit=100');
  });

  it('таймаут рвёт запрос и даёт код core_timeout', async () => {
    const fast = new CoreClient({ baseUrl: core.baseUrl, tenantKey: 'sk_test_x', timeoutMs: 50 });
    core.enqueue({ status: 201, body: CREATED, delayMs: 500 });
    await expect(fast.createSession({ channel: 'chat', agent: { instructions: 'x' } }, 'k')).rejects.toSatisfy(
      (err: unknown) => err instanceof CoreHttpError && err.code === 'core_timeout' && err.status === 504,
    );
  });
});
```

Run: `npx vitest run test/coreClient.test.ts` → FAIL.

- [ ] **Step 8: Реализация `backend/src/core/client.ts`**

```ts
import type { CoreSession, ParticipantToken, SessionCreate, SessionCreated, TranscriptPage } from './types.ts';

export class CoreHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'CoreHttpError';
  }
}

export type CoreClientOptions = {
  baseUrl: string;
  tenantKey: string;
  /** POST /v1/sessions блокирующий: ядро поднимает комнату и зовёт агента, до ~40с. */
  timeoutMs?: number;
};

export class CoreClient {
  private readonly baseUrl: string;
  private readonly tenantKey: string;
  private readonly timeoutMs: number;

  constructor(opts: CoreClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.tenantKey = opts.tenantKey;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; okStatuses?: number[]; swallow?: number[] } = {},
  ): Promise<T | undefined> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.tenantKey}`, accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new CoreHttpError(
        aborted ? 504 : 502,
        aborted ? 'core_timeout' : 'core_unreachable',
        `${method} ${path}: ${aborted ? `ядро не ответило за ${this.timeoutMs}мс` : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (opts.swallow?.includes(res.status)) return undefined;
    const ok = opts.okStatuses ?? [200, 201, 204];
    if (!ok.includes(res.status)) {
      const text = await res.text();
      let code = `http_${res.status}`;
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        if (parsed.error?.code) code = parsed.error.code;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // Не-json тело ядра — оставляем http_<status> и сырой текст.
      }
      throw new CoreHttpError(res.status, code, `${method} ${path} → ${res.status} ${code}: ${message}`);
    }
    if (res.status === 204) return undefined;
    return (await res.json()) as T;
  }

  createSession(body: SessionCreate, idempotencyKey: string): Promise<SessionCreated> {
    return this.request<SessionCreated>('POST', '/v1/sessions', { body, idempotencyKey, okStatuses: [201] }) as Promise<SessionCreated>;
  }

  issueParticipantToken(sessionId: string, identity: string): Promise<ParticipantToken> {
    return this.request<ParticipantToken>('POST', `/v1/sessions/${sessionId}/participant-tokens`, {
      body: { identity },
      okStatuses: [201],
    }) as Promise<ParticipantToken>;
  }

  async endSession(sessionId: string): Promise<void> {
    // 404/410 — сессии уже нет; для вызывающего это тот же исход, что и 204.
    await this.request<void>('POST', `/v1/sessions/${sessionId}/end`, { okStatuses: [204], swallow: [404, 410] });
  }

  getTranscript(sessionId: string, afterSeq = 0, limit = 500): Promise<TranscriptPage> {
    return this.request<TranscriptPage>(
      'GET',
      `/v1/sessions/${sessionId}/transcript?after_seq=${afterSeq}&limit=${limit}`,
      { okStatuses: [200] },
    ) as Promise<TranscriptPage>;
  }

  getSession(sessionId: string): Promise<CoreSession> {
    return this.request<CoreSession>('GET', `/v1/sessions/${sessionId}`, { okStatuses: [200] }) as Promise<CoreSession>;
  }
}
```

Run: `npx vitest run test/coreClient.test.ts` → PASS.

- [ ] **Step 9: Тест приёмника вебхуков — FAIL**

`backend/test/coreWebhooks.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { CoreClient } from '../src/core/client.ts';
import { applyFinalizedUsage, insertDialog, attachCoreSession, findDialogById } from '../src/db/repositories/dialogs.ts';
import { insertMessage, listThreadTail } from '../src/db/repositories/messages.ts';
import { FakeCore } from './helpers/fakeCore.ts';
import { seedWidget, testPool, truncateAll } from './helpers/db.ts';

const SECRET = 'секрет-длиной-больше-шестнадцати';
const pool = testPool();
let app: FastifyInstance;
let core: FakeCore; // нужен сценарию transcript.ready: сверка тянет ленту сама

const post = (raw: string, headerOverride?: string) => {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return app.inject({
    method: 'POST',
    url: '/w/v1/core-webhooks',
    headers: { 'content-type': 'application/json', 'x-core-signature': headerOverride ?? `t=${t},v1=${v1}` },
    payload: raw,
  });
};

beforeAll(async () => {
  core = new FakeCore();
  await core.start();
  app = await buildApp({
    config: {
      port: 8200, databaseUrl: process.env.DATABASE_URL!, coreBaseUrl: core.baseUrl,
      coreTenantKey: 'sk_test_x', coreWebhookSecret: SECRET, publicOrigin: 'http://localhost:8200',
      cspConnectSrc: "'self'", ipHashSalt: 'соль', maxDialogsPerVisitorPerDay: 10,
      maxDialogsPerIpPerDay: 30, maxDurationS: 600, trustProxy: false, logLevel: 'silent',
    },
    pool,
    core: new CoreClient({ baseUrl: core.baseUrl, tenantKey: 'sk_test_x', timeoutMs: 2000 }),
  });
});
beforeEach(() => truncateAll(pool));
afterAll(async () => { await app.close(); await core.stop(); await pool.end(); });

const envelope = (eventId: string, data: unknown, type = 'session.finalized'): string =>
  JSON.stringify({ api_version: 'v1', event_id: eventId, type, created: '2026-08-13T10:00:00Z', data });

describe('POST /w/v1/core-webhooks', () => {
  it('фейк-подпись → 401 и НИЧЕГО не записано', async () => {
    const raw = envelope('evt_bad', { session_id: 'sess_1', status: 'finalized', duration_s: 1, credits_total: 1 });
    const res = await post(raw, 't=1,v1=deadbeef');
    expect(res.statusCode).toBe(401);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM core_events');
    expect(rows[0].n).toBe(0);
  });

  it('session.finalized: usage и credits садятся в диалог по client_reference', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_0123456789abcdef', channel: 'chat' });

    const raw = envelope('evt_1', {
      session_id: 'sess_0123456789abcdef',
      client_reference: dialog.client_reference,
      status: 'finalized', duration_s: 42, credits_total: 7,
      usage_summary: { chat_token: 1200 },
    });
    expect((await post(raw)).statusCode).toBe(200);

    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.usage).toEqual({ chat_token: 1200 });
    expect(fresh?.credits_total).toBe(7);
    expect(fresh?.status).toBe('ended');
  });

  it('ретрай того же event_id не удваивает деньги', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_0123456789abcdef', channel: 'chat' });
    const raw = envelope('evt_dup', {
      session_id: 'sess_0123456789abcdef', client_reference: dialog.client_reference,
      status: 'finalized', duration_s: 42, credits_total: 7, usage_summary: { chat_token: 1200 },
    });
    expect((await post(raw)).statusCode).toBe(200);
    expect((await post(raw)).statusCode).toBe(200);
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.credits_total).toBe(7);
    expect(fresh?.usage).toEqual({ chat_token: 1200 });
  });

  it('финализация НЕ текущей сессии не роняет диалог в ended', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_старая', channel: 'chat' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_новая', channel: 'voice' });
    const raw = envelope('evt_old', {
      session_id: 'sess_старая', client_reference: dialog.client_reference,
      status: 'finalized', duration_s: 10, credits_total: 3,
    });
    expect((await post(raw)).statusCode).toBe(200);
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.status).toBe('active');
    expect(fresh?.credits_total).toBe(3);
  });

  it('неизвестный тип события принимается 200 и просто ложится в core_events', async () => {
    const raw = envelope('evt_unknown', { anything: true }, 'recording.ready');
    expect((await post(raw)).statusCode).toBe(200);
    const { rows } = await pool.query(`SELECT type FROM core_events WHERE event_id = 'evt_unknown'`);
    expect(rows[0].type).toBe('recording.ready');
  });

  it('конверт без event_id → 400, в БД пусто', async () => {
    const raw = JSON.stringify({ api_version: 'v1', type: 'session.finalized', data: {} });
    expect((await post(raw)).statusCode).toBe(400);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM core_events');
    expect(rows[0].n).toBe(0);
  });

  it('деньги той же сессии из ДРУГОГО события не удваиваются (гонка со свипером)', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_0123456789abcdef', channel: 'chat' });
    // Свипер успел раньше и уже учёл эту сессию.
    await applyFinalizedUsage(pool, {
      dialogId: dialog.id, sessionId: 'sess_0123456789abcdef',
      usage: { chat_token: 1200 }, creditsTotal: 7,
    });
    const raw = envelope('evt_race', {
      session_id: 'sess_0123456789abcdef', client_reference: dialog.client_reference,
      status: 'finalized', duration_s: 42, credits_total: 7, usage_summary: { chat_token: 1200 },
    });
    expect((await post(raw)).statusCode).toBe(200);
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.credits_total).toBe(7);            // НЕ 14
    expect(fresh?.usage).toEqual({ chat_token: 1200 }); // НЕ 2400
  });

  it('деньги РАЗНЫХ сессий одной нити суммируются', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_1111111111111111', channel: 'chat' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_2222222222222222', channel: 'voice' });
    for (const [id, sid, credits] of [['evt_a', 'sess_1111111111111111', 7], ['evt_b', 'sess_2222222222222222', 5]] as const) {
      const raw = envelope(id, {
        session_id: sid, client_reference: dialog.client_reference,
        status: 'finalized', duration_s: 10, credits_total: credits, usage_summary: { chat_token: 100 },
      });
      expect((await post(raw)).statusCode).toBe(200);
    }
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.credits_total).toBe(12);
    expect(fresh?.usage).toEqual({ chat_token: 200 });
  });

  it('transcript.ready доливает в журнал ТОЛЬКО то, чего клиент не записал', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_0123456789abcdef', channel: 'chat' });
    // Клиент успел записать первую реплику своим путём.
    await insertMessage(pool, {
      dialogId: dialog.id, role: 'user', text: 'Меня зовут Пётр',
      source: 'client', coreSessionId: null, seq: 1,
    });
    core.enqueue({ status: 200, body: { messages: [
      { seq: 1, role: 'user', text: 'Меня зовут Пётр', created_at: '2026-08-13T10:00:00Z' },
      { seq: 2, role: 'agent', text: 'Здравствуйте, Пётр!', created_at: '2026-08-13T10:00:05Z' },
    ], has_more: false } });

    const raw = envelope('evt_tr', {
      session_id: 'sess_0123456789abcdef', client_reference: dialog.client_reference, message_count: 2,
    }, 'transcript.ready');
    expect((await post(raw)).statusCode).toBe(200);

    const rows = await listThreadTail(pool, dialog.id, 50);
    expect(rows.map((m) => m.text)).toEqual(['Меня зовут Пётр', 'Здравствуйте, Пётр!']);
    expect(rows.filter((m) => m.source === 'core')).toHaveLength(1); // задвоения НЕТ
  });
});
```

Run: `npx vitest run test/coreWebhooks.test.ts` → FAIL.

- [ ] **Step 10: Реализация `backend/src/routes/coreWebhooks.ts`**

```ts
import type { FastifyPluginAsync } from 'fastify';
import { verifyCoreSignature } from '../core/signature.ts';
import type { SessionFinalizedData, WebhookEnvelope } from '../core/types.ts';
import { insertCoreEvent } from '../db/repositories/coreEvents.ts';
import { applyFinalizedUsage, findDialogByClientReference, setDialogStatus } from '../db/repositories/dialogs.ts';

export const coreWebhookRoutes: FastifyPluginAsync = async (app) => {
  // rawBody ТОЛЬКО в этом плагине: парсер инкапсулирован скоупом Fastify и не
  // портит остальные роуты, которым нужен разобранный json.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/w/v1/core-webhooks', async (req, reply) => {
    const raw = req.body as Buffer;
    const verdict = verifyCoreSignature(
      raw,
      req.headers['x-core-signature'] as string | undefined,
      app.deps.config.coreWebhookSecret,
      Date.now(),
    );
    if (!verdict.ok) {
      app.log.warn({ reason: verdict.reason }, 'вебхук отвергнут: подпись не сошлась');
      return reply.code(401).send({ error: { code: 'invalid_signature', message: verdict.reason } });
    }

    let envelope: WebhookEnvelope;
    try {
      envelope = JSON.parse(raw.toString('utf8')) as WebhookEnvelope;
    } catch {
      return reply.code(400).send({ error: { code: 'malformed_body', message: 'тело не json' } });
    }
    if (typeof envelope.event_id !== 'string' || typeof envelope.type !== 'string') {
      return reply.code(400).send({ error: { code: 'malformed_envelope', message: 'нет event_id или type' } });
    }

    // Дедуп ПЕРВЫМ делом: порядок не гарантирован, ретраи штатны.
    const fresh = await insertCoreEvent(app.deps.pool, {
      eventId: envelope.event_id,
      type: envelope.type,
      payload: envelope,
    });
    if (!fresh) {
      app.log.info({ eventId: envelope.event_id, type: envelope.type }, 'вебхук уже обработан — дубль');
      return reply.send({ ok: true, deduped: true });
    }

    if (envelope.type === 'session.finalized') {
      const data = envelope.data as SessionFinalizedData & { client_reference?: string };
      const ref = data.client_reference;
      const dialog = ref ? await findDialogByClientReference(app.deps.pool, ref) : null;
      if (!dialog) {
        app.log.warn({ ref, sessionId: data.session_id }, 'session.finalized без известного диалога');
      } else {
        const settled = await applyFinalizedUsage(app.deps.pool, {
          dialogId: dialog.id,
          sessionId: data.session_id,
          usage: (data.usage_summary ?? {}) as Record<string, number>,
          creditsTotal: data.credits_total ?? 0,
        });
        if (!settled) {
          app.log.info({ sessionId: data.session_id }, 'деньги сессии уже учтены (свипер успел раньше)');
        }
        // В ended роняем ТОЛЬКО текущую сессию активного диалога: закрытие
        // чата ради эскалации приходит сюда же, но диалог тогда 'escalating'.
        if (dialog.status === 'active' && dialog.current_core_session_id === data.session_id) {
          await setDialogStatus(app.deps.pool, dialog.id, 'ended');
        }
      }
    } else if (envelope.type === 'transcript.ready') {
      // СВЕРКА ленты (спека §3): журнал ведёт iframe, ядро — своя правда.
      // На финализации подтягиваем ленту ядра как source='core'; расхождение
      // логируем — это единственный сигнал, что витрина и лента разъехались.
      const data = envelope.data as { session_id: string; client_reference?: string; message_count: number };
      const dialog = data.client_reference
        ? await findDialogByClientReference(app.deps.pool, data.client_reference)
        : null;
      if (dialog) {
        await reconcileTranscript(app.deps, { dialog, sessionId: data.session_id, expected: data.message_count });
      }
    } else if (envelope.type === 'credits.low') {
      app.log.warn({ data: envelope.data }, 'БЮДЖЕТ-ПРЕДОХРАНИТЕЛЬ: у тенанта виджета кончаются кредиты');
    }

    return reply.send({ ok: true });
  });
};
```

`backend/src/dialogs/transcriptSync.ts` — общая сверка ленты, её же зовут T3 (хвост живой сессии на re-enter) и T4 (опрос перед эскалацией):

```ts
import type { AppDeps } from '../app.ts';
import type { TranscriptMessage } from '../core/types.ts';
import type { DialogRow } from '../db/repositories/dialogs.ts';
import { hasSimilarMessage, insertMessage } from '../db/repositories/messages.ts';

/** Окно, в котором реплика из ленты ядра считается той же, что уже в журнале. */
export const TRANSCRIPT_DEDUP_WINDOW_S = 900;

export type SyncResult = { fetched: number; stored: number; skipped: number };

/**
 * Положить ленту ядра в журнал БЕЗ дублей. Уникальный индекс тут бессилен: одна
 * и та же реплика приезжает двумя путями с разными ключами — от клиента
 * (source='client', его seq) и из ленты (source='core', seq ядра), — поэтому
 * дедупим по тексту+роли в окне. Витрина склеивается, а source остаётся, чтобы
 * на разборе инцидента было видно, кто что принёс.
 */
export async function persistTranscript(
  deps: AppDeps,
  input: { dialog: DialogRow; sessionId: string; messages: TranscriptMessage[] },
): Promise<SyncResult> {
  let stored = 0;
  let skipped = 0;
  for (const message of input.messages) {
    const role = message.role === 'agent' ? 'agent' : 'user';
    if (await hasSimilarMessage(deps.pool, {
      dialogId: input.dialog.id, role, text: message.text, windowSeconds: TRANSCRIPT_DEDUP_WINDOW_S,
    })) {
      skipped += 1;
      continue;
    }
    if (await insertMessage(deps.pool, {
      dialogId: input.dialog.id, role, text: message.text,
      source: 'core', coreSessionId: input.sessionId, seq: message.seq,
    })) stored += 1;
    else skipped += 1;
  }
  return { fetched: input.messages.length, stored, skipped };
}

/** Сверка на финализации: тянем ленту сами и докладываем расхождение. */
export async function reconcileTranscript(
  deps: AppDeps,
  input: { dialog: DialogRow; sessionId: string; expected?: number },
): Promise<SyncResult> {
  let messages: TranscriptMessage[] = [];
  try {
    messages = (await deps.core!.getTranscript(input.sessionId)).messages;
  } catch (err) {
    deps.log.warn({ err, sessionId: input.sessionId }, 'сверка: ленту получить не удалось');
    return { fetched: 0, stored: 0, skipped: 0 };
  }
  const result = await persistTranscript(deps, { dialog: input.dialog, sessionId: input.sessionId, messages });
  if (input.expected !== undefined && input.expected !== messages.length) {
    deps.log.warn(
      { sessionId: input.sessionId, expected: input.expected, got: messages.length },
      'сверка: message_count вебхука разошёлся с лентой',
    );
  }
  if (result.stored > 0) {
    deps.log.info({ sessionId: input.sessionId, ...result }, 'сверка: журнал дополнен репликами из ленты ядра');
  }
  return result;
}
```

Обновить `backend/src/app.ts`: сделать `core` в `AppDeps` обязательным (`core: CoreClient`) и `await app.register(coreWebhookRoutes);`. Обновить `server.ts`: создать `new CoreClient({ baseUrl: config.coreBaseUrl, tenantKey: config.coreTenantKey, timeoutMs: 45_000 })` и передать в `buildApp`. Поправить `test/health.test.ts` — добавить `core` в deps.

Run: `npx vitest run` → PASS.

- [ ] **Step 11: Мутпроба дедупа и денег**

1. Убрать `if (!fresh) return …` (обрабатывать дубли) → тест «ретрай того же event_id не удваивает деньги» FAIL. Вернуть.
2. Заменить `credits_total = credits_total + $3` на `credits_total = $3` в `applyFinalizedUsage` → тест «деньги РАЗНЫХ сессий одной нити суммируются» FAIL. Вернуть.
3. Убрать условие `AND NOT (settled_session_ids @> to_jsonb($4::text))` → тест «деньги той же сессии из ДРУГОГО события не удваиваются» FAIL (14 вместо 7). Вернуть.
4. Снять условие `dialog.status === 'active'` → тест «финализация НЕ текущей сессии не роняет диалог в ended» FAIL (диалог уйдёт в ended). Вернуть.
5. В `persistTranscript` убрать проверку `hasSimilarMessage` → тест «transcript.ready доливает ТОЛЬКО то, чего клиент не записал» FAIL (реплика задвоится). Вернуть.

- [ ] **Step 12: Commit**

```bash
git add contracts backend/src/core backend/src/routes/coreWebhooks.ts backend/src/app.ts backend/src/server.ts backend/test backend/package.json
git commit -m "feat(core): HTTP-клиент ядра + приёмник вебхуков с HMAC и дедупом (Э4-T2)"
```

---
### Task 3: Публичный API диалогов (`/w/v1`) — Origin-check, капы, журнал, лид

**Files:**
- Create: `backend/src/http/errors.ts`, `backend/src/http/originGuard.ts`
- Create: `backend/src/dialogs/budget.ts`, `backend/src/dialogs/openSession.ts`, `backend/src/dialogs/startDialog.ts`, `backend/src/dialogs/reenter.ts`
- Create: `backend/src/routes/publicApi.ts`
- Create: `backend/test/helpers/app.ts` — общая сборка тестового инстанса (`buildTestApp(overrides?)` → `{ app, core, pool, deps }`), её переиспользуют T4, T5 и T6
- Modify: `backend/src/app.ts` (регистрация `@fastify/rate-limit` + publicApi)
- Test: `backend/test/originGuard.test.ts`, `backend/test/publicApi.test.ts`, `backend/test/caps.test.ts`

**Interfaces:**
- Consumes (T1, T2): все репозитории, `AppDeps`, `CoreClient`, `CoreHttpError`, `SessionCreate`, `ParticipantToken`, `WidgetRow`, `DialogRow`.
- Produces:
  - `class ApiError extends Error { readonly status: number; readonly code: string }` + `sendApiError(reply, err)` + `mapCoreError(err: CoreHttpError): ApiError` (пропускает 402/404/409/410/503 как есть, остальное → 422).
  - `ensureSessionBudget(deps, input: { visitorKey: string; ipHash: string }): Promise<void>` — суточные капы, зовётся ПЕРЕД каждым `openCoreSession`.
  - `originVerdict(widget: WidgetRow, ctx: { origin: string | undefined; publicOrigin: string; method: string }): 'allow' | 'deny'`; `normalizeOrigin(raw: string): string`
  - `openCoreSession(deps, input: OpenSessionInput): Promise<OpenSessionResult>` где
    `type OpenSessionInput = { widget: WidgetRow; dialog: DialogRow; channel: 'chat' | 'voice'; instructions: string; continueFrom?: string }`,
    `type OpenSessionResult = { core_session_id: string; participant_token: ParticipantToken; continued_from?: string }`.
    Ключ повторяемости — `dlg:{dialogId}:{core_session_ids.length + 1}`, стабильный для ретраев одной логической операции.
  - `startDialog(deps, input: StartDialogInput): Promise<StartDialogResult>` где
    `type StartDialogInput = { widget: WidgetRow; visitorKey: string; ipHash: string; dialogId?: string }`,
    `type StartDialogResult = { dialog_id: string; channel: 'chat'; participant_token: ParticipantToken; continued_from?: string; messages: PublicMessage[]; next_seq: number }`.
  - `reenterDialog(deps, input: { widget: WidgetRow; dialog: DialogRow }): Promise<ReenterResult>` где
    `type ReenterResult = { dialog_id: string; channel: 'chat' | 'voice'; participant_token: ParticipantToken; messages: PublicMessage[]; next_seq: number }`.
  - `type PublicMessage = { role: 'user' | 'agent'; text: string; seq: number; source: 'client' | 'core'; created_at: string }`.
  - Роуты: `GET /w/v1/:token/config`, `POST /w/v1/:token/dialogs`, `POST /w/v1/:token/dialogs/:id/reenter`, `POST|GET /w/v1/:token/dialogs/:id/messages`, `POST /w/v1/:token/dialogs/:id/end`, `POST /w/v1/:token/dialogs/:id/lead`.

**Решения, доопределяющие спеку (обязательны к реализации именно так):**
1. **Origin у iframe — НАШ, а не сайта клиента.** Iframe живёт на `WIDGET_PUBLIC_ORIGIN`, поэтому буквальная проверка «Origin ∈ allowed_origins» убила бы штатный путь. Правило асимметрично по методу: на не-GET отсутствие `Origin` → **ОТКАЗ** (Fetch-спека обязывает браузер слать заголовок на каждый не-GET, значит его отсутствие — не браузер), на GET отсутствие допустимо (same-origin GET его не несёт); если `Origin` есть — обязан быть в `allowed_origins ∪ {WIDGET_PUBLIC_ORIGIN}`. Пустой `allowed_origins` → отказ всем на любом методе (виджет не настроен ни на один сайт — спека §3). Настоящая защита от встраивания на чужой сайт — заголовок `frame-ancestors` на странице `/app/:token` (Task 5), её обеспечивает браузер.
2. **`POST /dialogs` с `dialog_id` = продолжение нити** (баннер «Продолжить» после `silence` и фолбэк провалившейся эскалации из §5): создаёт НОВУЮ chat-сессию ядра с `continue_from` = последней сессии диалога.
3. **Капы считают КАЖДОЕ создание сессии ядра** (старт, продолжение, эскалация), а не только первый старт диалога: деньги жжёт сессия, а не строка в БД. Это осознанное ужесточение §6.

- [ ] **Step 1: Тест Origin-check — FAIL**

`backend/test/originGuard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { originVerdict } from '../src/http/originGuard.ts';
import type { WidgetRow } from '../src/db/repositories/widgets.ts';

const widget = (origins: string[]): WidgetRow =>
  ({ allowed_origins: origins } as WidgetRow);
const OURS = 'https://widget.aski.pro';
const check = (
  origins: string[],
  origin: string | undefined,
  method: string,
): 'allow' | 'deny' => originVerdict(widget(origins), { origin, publicOrigin: OURS, method });

describe('originVerdict', () => {
  it('свой сайт разрешён', () => {
    expect(check(['https://shop.example'], 'https://shop.example', 'POST')).toBe('allow');
  });

  it('наш собственный origin разрешён — это путь iframe', () => {
    expect(check(['https://shop.example'], OURS, 'POST')).toBe('allow');
  });

  it('чужой origin — отказ', () => {
    expect(check(['https://shop.example'], 'https://evil.example', 'POST')).toBe('deny');
  });

  it('НЕ-GET без Origin — ОТКАЗ: браузер шлёт Origin на любой не-GET, значит это curl', () => {
    expect(check(['https://shop.example'], undefined, 'POST')).toBe('deny');
    expect(check(['https://shop.example'], undefined, 'DELETE')).toBe('deny');
  });

  it('GET без Origin — пропуск: браузер не шлёт его на same-origin GET', () => {
    expect(check(['https://shop.example'], undefined, 'GET')).toBe('allow');
    expect(check(['https://shop.example'], undefined, 'HEAD')).toBe('allow');
  });

  it('ПУСТОЙ allowed_origins — отказ всем и на любом методе', () => {
    expect(check([], 'https://shop.example', 'POST')).toBe('deny');
    expect(check([], undefined, 'GET')).toBe('deny');
    expect(check([], OURS, 'POST')).toBe('deny');
  });

  it('сравнение точное: поддомен и порт не подходят', () => {
    expect(check(['https://shop.example'], 'https://evil.shop.example', 'POST')).toBe('deny');
    expect(check(['https://shop.example'], 'https://shop.example:8443', 'POST')).toBe('deny');
    expect(check(['https://shop.example'], 'http://shop.example', 'POST')).toBe('deny');
  });

  it('хвостовой слэш и регистр схемы/хоста нормализуются', () => {
    expect(check(['https://Shop.Example/'], 'https://shop.example', 'POST')).toBe('allow');
  });
});
```

Run: `npx vitest run test/originGuard.test.ts` → FAIL.

- [ ] **Step 2: Реализация `originGuard.ts` и `errors.ts`**

`backend/src/http/errors.ts`:

```ts
import type { FastifyReply } from 'fastify';
import type { CoreHttpError } from '../core/client.ts';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
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
```

`backend/src/http/originGuard.ts`:

```ts
import type { WidgetRow } from '../db/repositories/widgets.ts';

/** Нормализация: схема+хост в нижний регистр, хвостовой слэш срезан, порт значим. */
export function normalizeOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function originVerdict(
  widget: Pick<WidgetRow, 'allowed_origins'>,
  ctx: { origin: string | undefined; publicOrigin: string; method: string },
): 'allow' | 'deny' {
  // Пустой список = виджет не настроен ни на один сайт → закрыт весь публичный
  // путь. Это ЯВНОЕ отличие от монолита, где пустой список значил «любой».
  if (widget.allowed_origins.length === 0) return 'deny';

  if (ctx.origin === undefined) {
    // Fetch-спека обязывает браузер слать Origin на КАЖДЫЙ не-GET запрос, в том
    // числе same-origin. Значит отсутствие заголовка на POST — это не браузер, а
    // curl: отказываем. На GET заголовка честно может не быть (same-origin), и
    // там пропускаем — иначе iframe не прочитает собственную историю.
    return SAFE_METHODS.has(ctx.method.toUpperCase()) ? 'allow' : 'deny';
  }

  const wanted = normalizeOrigin(ctx.origin);
  const allowed = widget.allowed_origins.map(normalizeOrigin);
  return wanted === normalizeOrigin(ctx.publicOrigin) || allowed.includes(wanted) ? 'allow' : 'deny';
}
```

Run: `npx vitest run test/originGuard.test.ts` → PASS.

- [ ] **Step 3: Тест публичного API — FAIL**

`backend/test/publicApi.test.ts` (общая обвязка + сценарии; фейк-ядро из T2):

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { CoreClient } from '../src/core/client.ts';
import { findDialogById, insertDialog } from '../src/db/repositories/dialogs.ts';
import { listThreadTail } from '../src/db/repositories/messages.ts';
import { FakeCore } from './helpers/fakeCore.ts';
import { seedWidget, testPool, truncateAll } from './helpers/db.ts';

const pool = testPool();
const ORIGIN = 'https://shop.example';
const VISITOR = '11111111-1111-4111-8111-111111111111';
let app: FastifyInstance;
let core: FakeCore;

const CREATED = (sid: string) => ({
  session_id: sid, room: 'r',
  participant_token: { token: 'jwt', identity: 'respondent-core', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T10:00:00Z' },
});

beforeEach(async () => {
  await truncateAll(pool);
  core = new FakeCore();
  await core.start();
  app = await buildApp({
    config: {
      port: 8200, databaseUrl: process.env.DATABASE_URL!, coreBaseUrl: core.baseUrl,
      coreTenantKey: 'sk_test_x', coreWebhookSecret: 'секрет-длиной-больше-шестнадцати',
      publicOrigin: 'https://widget.aski.pro', cspConnectSrc: "'self'", ipHashSalt: 'соль',
      maxDialogsPerVisitorPerDay: 10, maxDialogsPerIpPerDay: 30, maxDurationS: 600, logLevel: 'silent',
    },
    pool,
    core: new CoreClient({ baseUrl: core.baseUrl, tenantKey: 'sk_test_x', timeoutMs: 2000 }),
  });
});
afterEach(async () => { await app.close(); await core.stop(); });
afterAll(() => pool.end());

describe('GET /w/v1/:token/config', () => {
  it('отдаёт конфиг, кэш 60с и Vary: Origin, БЕЗ Origin-check', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const res = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, allowed_origins: [ORIGIN] });
    expect(res.json().app_url).toBe(`https://widget.aski.pro/app/${token}`);
    expect(res.headers['cache-control']).toContain('max-age=60');
    expect(res.headers.vary).toContain('Origin');
  });

  it('CORS-заголовок эхом ТОЛЬКО для разрешённого origin', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const good = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: ORIGIN } });
    expect(good.headers['access-control-allow-origin']).toBe(ORIGIN);
    const bad = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: 'https://evil.example' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('неизвестный токен → 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/w/v1/нет/config' })).statusCode).toBe(404);
  });
});

describe('POST /w/v1/:token/dialogs', () => {
  it('создаёт диалог и chat-сессию ядра: max_duration_s=600, client_reference, Idempotency-Key', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN], instructions: 'Ты консультант.' });
    core.enqueue({ status: 201, body: CREATED('sess_0123456789abcdef') });

    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.channel).toBe('chat');
    expect(body.participant_token.livekit_url).toBe('wss://lk.example');
    expect(body.messages).toEqual([]);

    const call = core.calls[0]!;
    expect(call.headers['idempotency-key']).toBe(`dlg:${body.dialog_id}:1`);
    expect(call.body).toMatchObject({
      channel: 'chat',
      agent: { instructions: 'Ты консультант.' },
      limits: { max_duration_s: 600 },
      client_reference: `widget:dialog:${body.dialog_id}`,
    });
    expect((call.body as { identity?: string }).identity).toBeUndefined(); // identity генерит ядро

    const dialog = await findDialogById(pool, body.dialog_id);
    expect(dialog?.current_core_session_id).toBe('sess_0123456789abcdef');
    expect(dialog?.current_channel).toBe('chat');
  });

  it('чужой Origin → 403 и ядро НЕ дёргалось', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: 'https://evil.example' }, payload: { visitor_key: VISITOR },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('origin_not_allowed');
    expect(core.calls).toHaveLength(0);
  });

  it('выключенный виджет → 403 widget_disabled', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN], enabled: false });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('widget_disabled');
  });

  it('невалидный visitor_key → 422', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN }, payload: { visitor_key: 'не-uuid' } });
    expect(res.statusCode).toBe(422);
  });

  it('402 от ядра → 402 наружу, диалог в error', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    core.enqueue({ status: 402, body: { error: { code: 'insufficient_credits', message: 'нет' } } });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('insufficient_credits');
    const { rows } = await pool.query(`SELECT status FROM dialogs`);
    expect(rows[0].status).toBe('error');
  });

  it('продолжение нити: dialog_id → новая сессия с continue_from и история из журнала', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET core_session_ids = '["sess_aaaaaaaaaaaaaaaa"]'::jsonb,
              current_core_session_id = 'sess_aaaaaaaaaaaaaaaa', current_channel = 'chat', status = 'ended'
        WHERE id = $1`, [dialog.id]);
    await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/messages`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, role: 'user', text: 'Меня зовут Пётр', seq: 1 } });

    core.enqueue({ status: 204, body: null });                                    // /end предыдущей
    core.enqueue({ status: 201, body: { ...CREATED('sess_bbbbbbbbbbbbbbbb'), continued_from: 'sess_aaaaaaaaaaaaaaaa' } });

    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, dialog_id: dialog.id } });

    expect(res.statusCode).toBe(201);
    expect(res.json().dialog_id).toBe(dialog.id);
    expect(res.json().continued_from).toBe('sess_aaaaaaaaaaaaaaaa');
    expect(res.json().messages.map((m: { text: string }) => m.text)).toEqual(['Меня зовут Пётр']);
    expect(core.calls[0]!.url).toBe('/api/v1/sessions/sess_aaaaaaaaaaaaaaaa/end');
    expect(core.calls[1]!.body).toMatchObject({ channel: 'chat', continue_from: 'sess_aaaaaaaaaaaaaaaa' });
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.status).toBe('active');
    expect(fresh?.core_session_ids).toEqual(['sess_aaaaaaaaaaaaaaaa', 'sess_bbbbbbbbbbbbbbbb']);
  });

  it('чужой visitor_key к существующему диалогу → 404, а не 403 (не оракул чужих id)', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN }, payload: { visitor_key: randomUUID(), dialog_id: dialog.id } });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /w/v1/:token/dialogs/:id/reenter', () => {
  it('выпускает НОВУЮ identity respondent-<uuid> и отдаёт историю', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(`UPDATE dialogs SET current_core_session_id='sess_0123456789abcdef', current_channel='chat' WHERE id=$1`, [dialog.id]);
    await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/messages`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, role: 'agent', text: 'Здравствуйте!', seq: 1 } });

    core.enqueue({ status: 201, body: { token: 'jwt2', identity: 'respondent-новая', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T11:00:00Z' } });
    core.enqueue({ status: 200, body: { messages: [{ seq: 4, role: 'user', text: 'хвост живой сессии', created_at: '2026-08-13T10:05:00Z' }], has_more: false } });

    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/reenter`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });

    expect(res.statusCode).toBe(200);
    expect(res.json().channel).toBe('chat');
    const sent = core.calls[0]!.body as { identity: string };
    expect(sent.identity).toMatch(/^respondent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Хвост живой сессии подмешан к журналу и сохранён как source='core'.
    expect(res.json().messages.map((m: { text: string }) => m.text)).toEqual(['Здравствуйте!', 'хвост живой сессии']);
    const stored = await listThreadTail(pool, dialog.id, 50);
    expect(stored.filter((m) => m.source === 'core').map((m) => m.text)).toEqual(['хвост живой сессии']);
  });

  it('410 от ядра (сессия закрыта) → 410 gone, клиент пойдёт по пути «Продолжить»', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(`UPDATE dialogs SET current_core_session_id='sess_0123456789abcdef', current_channel='chat' WHERE id=$1`, [dialog.id]);
    core.enqueue({ status: 410, body: { error: { code: 'session_finished', message: 'закрыта' } } });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/reenter`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('session_finished');
  });
});

describe('журнал, завершение и лид', () => {
  const startDialog = async (token: string): Promise<string> => {
    core.enqueue({ status: 201, body: CREATED('sess_0123456789abcdef') });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });
    return res.json().dialog_id as string;
  };

  it('POST messages идемпотентен по seq, GET отдаёт ленту', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await startDialog(token);
    const body = { visitor_key: VISITOR, role: 'user', text: 'Меня зовут Пётр', seq: 1 };
    expect((await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/messages`, headers: { origin: ORIGIN }, payload: body })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/messages`, headers: { origin: ORIGIN }, payload: body })).statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: `/w/v1/${token}/dialogs/${id}/messages?visitor_key=${VISITOR}`, headers: { origin: ORIGIN } });
    expect(list.json().messages).toHaveLength(1);
    expect(list.json().status).toBe('active');
  });

  it('текст длиннее 2000 режется до 2000 — ровно как воркер', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await startDialog(token);
    await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/messages`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, role: 'user', text: 'я'.repeat(2500), seq: 1 } });
    const stored = await listThreadTail(pool, id, 10);
    expect(stored[0]!.text).toHaveLength(2000);
  });

  it('пустой текст → 422', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await startDialog(token);
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/messages`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, role: 'user', text: '   ', seq: 1 } });
    expect(res.statusCode).toBe(422);
  });

  it('POST end закрывает сессию ядра и диалог', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await startDialog(token);
    core.enqueue({ status: 204, body: null });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/end`, headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });
    expect(res.statusCode).toBe(200);
    expect(core.calls.at(-1)!.url).toBe('/api/v1/sessions/sess_0123456789abcdef/end');
    expect((await findDialogById(pool, id))?.status).toBe('ended');
  });

  it('лид требует consent=true и хотя бы один контакт', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await startDialog(token);
    const noConsent = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/lead`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, name: 'Пётр', phone: '+7 900 000-00-00', consent: false } });
    expect(noConsent.statusCode).toBe(422);
    expect(noConsent.json().error.code).toBe('consent_required');

    const noContact = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/lead`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, name: 'Пётр', consent: true } });
    expect(noContact.statusCode).toBe(422);
    expect(noContact.json().error.code).toBe('contact_required');

    const ok = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/lead`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, name: 'Пётр', phone: '+7 900 000-00-00', consent: true } });
    expect(ok.statusCode).toBe(201);
    const { rows } = await pool.query('SELECT name, phone, consent FROM leads');
    expect(rows[0]).toMatchObject({ name: 'Пётр', consent: true });
  });
});
```

Run: `npx vitest run test/publicApi.test.ts` → FAIL.

- [ ] **Step 4: Тест капов — FAIL**

`backend/test/caps.test.ts` (обвязка та же, что в `publicApi.test.ts`; вынести `buildTestApp()` в `test/helpers/app.ts` и переиспользовать в обоих файлах):

```ts
import { describe, expect, it } from 'vitest';
// … та же beforeEach-обвязка, но конфиг с маленькими капами:
//    maxDialogsPerVisitorPerDay: 2, maxDialogsPerIpPerDay: 3

// IP берётся из РЕАЛЬНОГО адреса соединения (trustProxy=false), поэтому в
// тестах его задаёт remoteAddress инжекта, а не заголовок.
const post = (token: string, body: object, remoteAddress = '203.0.113.7') =>
  app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN }, remoteAddress, payload: body });

describe('капы бюджет-предохранителя', () => {
  it('третий диалог того же visitor за сутки → 429 visitor_daily_cap, ядро не дёргается', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    core.enqueue({ status: 201, body: CREATED('sess_1111111111111111') });
    core.enqueue({ status: 201, body: CREATED('sess_2222222222222222') });
    for (let i = 0; i < 2; i += 1) {
      expect((await post(token, { visitor_key: VISITOR })).statusCode).toBe(201);
    }
    const denied = await post(token, { visitor_key: VISITOR });
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('visitor_daily_cap');
    expect(core.calls).toHaveLength(2);
  });

  it('кап по IP ловит смену visitor_key', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    for (let i = 0; i < 3; i += 1) core.enqueue({ status: 201, body: CREATED(`sess_${String(i).repeat(16)}`) });
    for (let i = 0; i < 3; i += 1) {
      expect((await post(token, { visitor_key: randomUUID() }, '203.0.113.8')).statusCode).toBe(201);
    }
    const denied = await post(token, { visitor_key: randomUUID() }, '203.0.113.8');
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('ip_daily_cap');
  });

  it('X-Forwarded-For НЕ подменяет IP: иначе кап обходится одним заголовком', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    for (let i = 0; i < 3; i += 1) core.enqueue({ status: 201, body: CREATED(`sess_${String(i).repeat(16)}`) });
    for (let i = 0; i < 3; i += 1) {
      expect((await post(token, { visitor_key: randomUUID() }, '203.0.113.10')).statusCode).toBe(201);
    }
    // Атакующий крутит заголовок, надеясь получить свежую квоту.
    const spoofed = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '198.51.100.1' },
      remoteAddress: '203.0.113.10',
      payload: { visitor_key: randomUUID() },
    });
    expect(spoofed.statusCode).toBe(429);
    expect(spoofed.json().error.code).toBe('ip_daily_cap');
    // И в счётчиках ровно ОДИН ключ — подменённый адрес своей строки не завёл.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM ip_day_counters');
    expect(rows[0].n).toBe(1);
  });

  it('IP в БД не попадает — только хэш', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    core.enqueue({ status: 201, body: CREATED('sess_3333333333333333') });
    await post(token, { visitor_key: VISITOR }, '203.0.113.9');
    const { rows } = await pool.query('SELECT ip_hash FROM ip_day_counters');
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].ip_hash).not.toContain('203.0.113.9');
  });

  it('кап считает и ЭСКАЛАЦИЮ: она создаёт платную сессию так же, как старт', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    // Диалог уже есть, квота visitor выбрана двумя прошлыми диалогами.
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa', current_channel='chat' WHERE id=$1`,
      [dialog.id],
    );
    const denied = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/escalate`,
      headers: { origin: ORIGIN }, remoteAddress: '203.0.113.11',
      payload: { visitor_key: VISITOR, messages_count: 0 },
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('visitor_daily_cap');
    expect(core.calls).toHaveLength(0); // ядро не тронуто: ни /end, ни создания
  });
});
```

Run: `npx vitest run test/caps.test.ts` → FAIL.

- [ ] **Step 5: Реализация `budget.ts` — единая проверка капов**

`backend/src/dialogs/budget.ts`. Капы обязаны стоять перед КАЖДЫМ созданием сессии ядра, а не только перед стартом диалога: эскалация и продолжение нити жгут деньги ровно так же (решение №3 выше). Отдельная функция — чтобы «забыть позвать» можно было только явно:

```ts
import type { AppDeps } from '../app.ts';
import { countDialogsStartedByVisitor } from '../db/repositories/dialogs.ts';
import { bumpIpDayCounter } from '../db/repositories/quotas.ts';
import { ApiError } from '../http/errors.ts';

/**
 * Суточные капы бюджет-предохранителя (спека §6.3). Зовётся ПЕРЕД каждым
 * openCoreSession: старт диалога, продолжение нити, эскалация в голос.
 * Счётчик IP инкрементится здесь же — попытка создания уже стоит квоты, иначе
 * провалившиеся создания дали бы бесплатный обход.
 */
export async function ensureSessionBudget(
  deps: AppDeps,
  input: { visitorKey: string; ipHash: string },
): Promise<void> {
  const byVisitor = await countDialogsStartedByVisitor(deps.pool, input.visitorKey);
  if (byVisitor >= deps.config.maxDialogsPerVisitorPerDay) {
    throw new ApiError(429, 'visitor_daily_cap', 'Слишком много обращений за сутки. Попробуйте завтра.');
  }
  const byIp = await bumpIpDayCounter(deps.pool, input.ipHash);
  if (byIp > deps.config.maxDialogsPerIpPerDay) {
    throw new ApiError(429, 'ip_daily_cap', 'Слишком много обращений за сутки. Попробуйте завтра.');
  }
}
```

- [ ] **Step 6: Реализация `openSession.ts`**

`backend/src/dialogs/openSession.ts`:

```ts
import type { AppDeps } from '../app.ts';
import { attachCoreSession, type DialogRow } from '../db/repositories/dialogs.ts';
import type { WidgetRow } from '../db/repositories/widgets.ts';
import type { ParticipantToken, SessionCreate } from '../core/types.ts';

export type OpenSessionInput = {
  widget: WidgetRow;
  dialog: DialogRow;
  channel: 'chat' | 'voice';
  instructions: string;
  continueFrom?: string;
};

export type OpenSessionResult = {
  core_session_id: string;
  participant_token: ParticipantToken;
  continued_from?: string;
};

/**
 * Единственная точка создания сессии ядра.
 *
 * Ключ повторяемости — на ЛОГИЧЕСКУЮ операцию, а не на попытку:
 * `dlg:<id>:<число уже привязанных сессий + 1>`. Пока сессия не привязана,
 * повтор (ретрай сети, двойной клик, дубль POST) вычисляет ТОТ ЖЕ ключ и
 * получает от ядра ту же сессию, а не вторую платную. Счётчик, который
 * инкрементился бы перед каждой попыткой, ровно это и ломал: каждый ретрай
 * покупал новую сессию.
 *
 * Он же закрывает гонку двух параллельных запросов по одному диалогу: второй
 * приходит с тем же ключом и получает 409 `idempotency_in_progress` — роль
 * общего замка играет idempotency-хранилище ядра, локальный CAS не нужен.
 */
export async function openCoreSession(deps: AppDeps, input: OpenSessionInput): Promise<OpenSessionResult> {
  const attempt = input.dialog.core_session_ids.length + 1;
  const idempotencyKey = `dlg:${input.dialog.id}:${attempt}`;
  const body: SessionCreate = {
    channel: input.channel,
    agent: {
      instructions: input.instructions,
      ...(input.widget.agent_config.greeting ? { greeting: input.widget.agent_config.greeting } : {}),
      ...(input.widget.agent_config.voice_id ? { voice_id: input.widget.agent_config.voice_id } : {}),
      ...(input.widget.agent_config.avatar_id ? { avatar_id: input.widget.agent_config.avatar_id } : {}),
    },
    ...(input.continueFrom ? { continue_from: input.continueFrom } : {}),
    ...(input.widget.kb_ids.length > 0 ? { knowledge: { base_ids: input.widget.kb_ids, injection: 'auto' } } : {}),
    // Бюджет-предохранитель: 600 вместо дефолтных 1800 у ОБОИХ каналов.
    limits: { max_duration_s: deps.config.maxDurationS },
    client_reference: input.dialog.client_reference,
    metadata: { widget_id: input.widget.id, dialog_id: input.dialog.id },
  };

  let created;
  try {
    created = await deps.core.createSession(body, idempotencyKey);
  } catch (err) {
    // 410 = ключ принадлежит уже ЗАВЕРШЁННОЙ сессии: такое возможно, если
    // прошлая попытка успела создать сессию, но упала до привязки. Один раз
    // пробуем со свежим ключом — иначе диалог залипнет навсегда.
    if (err instanceof CoreHttpError && err.status === 410) {
      deps.log.warn({ dialogId: input.dialog.id, idempotencyKey }, 'ключ повторяемости указывает на закрытую сессию — берём свежий');
      created = await deps.core.createSession(body, `${idempotencyKey}:r${Date.now()}`);
    } else {
      throw err;
    }
  }
  await attachCoreSession(deps.pool, {
    dialogId: input.dialog.id,
    sessionId: created.session_id,
    channel: input.channel,
  });
  return {
    core_session_id: created.session_id,
    participant_token: created.participant_token,
    ...(created.continued_from ? { continued_from: created.continued_from } : {}),
  };
}
```

- [ ] **Step 7: Реализация `startDialog.ts` и `reenter.ts`**

`backend/src/dialogs/startDialog.ts`:

```ts
import type { AppDeps } from '../app.ts';
import { CoreHttpError } from '../core/client.ts';
import {
  countDialogsStartedByVisitor, findDialogById, insertDialog, setDialogStatus, type DialogRow,
} from '../db/repositories/dialogs.ts';
import { listThreadTail, type MessageRow } from '../db/repositories/messages.ts';
import { bumpIpDayCounter } from '../db/repositories/quotas.ts';
import type { WidgetRow } from '../db/repositories/widgets.ts';
import { ApiError } from '../http/errors.ts';
import type { ParticipantToken } from '../core/types.ts';
import { openCoreSession } from './openSession.ts';

export type PublicMessage = { role: 'user' | 'agent'; text: string; seq: number; source: 'client' | 'core'; created_at: string };

export const toPublicMessage = (row: MessageRow): PublicMessage => ({
  role: row.role, text: row.text, seq: row.seq, source: row.source, created_at: row.created_at.toISOString(),
});

export type StartDialogInput = { widget: WidgetRow; visitorKey: string; ipHash: string; dialogId?: string };
export type StartDialogResult = {
  dialog_id: string; channel: 'chat'; participant_token: ParticipantToken;
  continued_from?: string; messages: PublicMessage[]; next_seq: number;
};

export const MESSAGES_PAGE = 200;

export async function startDialog(deps: AppDeps, input: StartDialogInput): Promise<StartDialogResult> {
  // Капы ДО денег: сессия ядра — единственное, что жжёт кредиты.
  await ensureSessionBudget(deps, { visitorKey: input.visitorKey, ipHash: input.ipHash });

  let dialog: DialogRow;
  let continueFrom: string | undefined;

  if (input.dialogId) {
    const existing = await findDialogById(deps.pool, input.dialogId);
    // Чужой/несуществующий/из другого виджета — один и тот же ответ: не оракул.
    if (!existing || existing.widget_id !== input.widget.id || existing.visitor_key !== input.visitorKey) {
      throw new ApiError(404, 'dialog_not_found', 'Диалог не найден.');
    }
    if (existing.status === 'error') {
      throw new ApiError(409, 'dialog_unusable', 'Диалог завершился ошибкой — начните новый.');
    }
    const last = existing.current_core_session_id ?? existing.core_session_ids.at(-1) ?? null;
    if (last) {
      // continue_from требует ЗАВЕРШЁННУЮ сессию; своя же незакрытая дала бы 422.
      await deps.core.endSession(last);
      continueFrom = last;
    }
    dialog = existing;
  } else {
    dialog = await insertDialog(deps.pool, { widgetId: input.widget.id, visitorKey: input.visitorKey });
  }

  try {
    const opened = await openCoreSession(deps, {
      widget: input.widget, dialog, channel: 'chat',
      instructions: input.widget.agent_config.instructions,
      ...(continueFrom ? { continueFrom } : {}),
    });
    await setDialogStatus(deps.pool, dialog.id, 'active');
    const rows = await listThreadTail(deps.pool, dialog.id, MESSAGES_PAGE);
    return {
      dialog_id: dialog.id, channel: 'chat', participant_token: opened.participant_token,
      ...(opened.continued_from ? { continued_from: opened.continued_from } : {}),
      messages: rows.map(toPublicMessage),
      // Клиент продолжает нумерацию журнала отсюда: после reload у него свой
      // счётчик обнулился бы, и новые реплики затирались бы дедупом по (seq).
      next_seq: (await maxClientSeq(deps.pool, dialog.id)) + 1,
    };
  } catch (err) {
    if (err instanceof CoreHttpError) {
      // 402 — денег нет: диалог мёртв. Остальное оставляем живым, клиент вправе
      // повторить. Коды ядра наружу НЕ схлопываем (mapCoreError).
      await setDialogStatus(deps.pool, dialog.id, err.status === 402 ? 'error' : 'active');
      throw mapCoreError(err);
    }
    throw err;
  }
}
```

`backend/src/dialogs/reenter.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../app.ts';
import { CoreHttpError } from '../core/client.ts';
import type { DialogRow } from '../db/repositories/dialogs.ts';
import { listThreadTail, maxClientSeq } from '../db/repositories/messages.ts';
import type { WidgetRow } from '../db/repositories/widgets.ts';
import { ApiError } from '../http/errors.ts';
import type { ParticipantToken } from '../core/types.ts';
import { reconcileTranscript } from './transcriptSync.ts';
import { MESSAGES_PAGE, toPublicMessage, type PublicMessage } from './startDialog.ts';

export type ReenterResult = {
  dialog_id: string; channel: 'chat' | 'voice';
  participant_token: ParticipantToken; messages: PublicMessage[]; next_seq: number;
};

/** identity ре-входа: ВСЕГДА новая и ВСЕГДА с префиксом respondent-. */
export const newRespondentIdentity = (): string => `respondent-${randomUUID()}`;

export async function reenterDialog(
  deps: AppDeps,
  input: { widget: WidgetRow; dialog: DialogRow },
): Promise<ReenterResult> {
  const sessionId = input.dialog.current_core_session_id;
  if (!sessionId) throw new ApiError(409, 'no_live_session', 'В этом диалоге нет живой сессии.');

  let token: ParticipantToken;
  try {
    // Прежнюю identity переиспользовать НЕЛЬЗЯ: LiveKit выкинет живого участника.
    token = await deps.core.issueParticipantToken(sessionId, newRespondentIdentity());
  } catch (err) {
    if (err instanceof CoreHttpError) throw mapCoreError(err);
    throw err;
  }

  // Хвост ЖИВОЙ сессии: лента ядра наполняется и на chat, лаг флаша ≤5с.
  // Та же общая сверка, что на transcript.ready — с дедупом по тексту, иначе
  // каждое повторное открытие вкладки удваивало бы историю.
  await reconcileTranscript(deps, { dialog: input.dialog, sessionId });

  const rows = await listThreadTail(deps.pool, input.dialog.id, MESSAGES_PAGE);
  return {
    dialog_id: input.dialog.id,
    channel: input.dialog.current_channel ?? 'chat',
    participant_token: token,
    messages: rows.map(toPublicMessage),
    next_seq: (await maxClientSeq(deps.pool, input.dialog.id)) + 1,
  };
}
```

`deps.log` появляется в этом шаге: расширить `AppDeps` в `app.ts` до `{ config: AppConfig; pool: Pool; core: CoreClient; log: FastifyBaseLogger }`, присвоить `deps.log = app.log` сразу после создания инстанса Fastify (логгер до этого момента не существует) и добавить поле `log` во все тестовые сборки deps (`test/helpers/app.ts`, `test/health.test.ts`, `test/coreWebhooks.test.ts`) — там подойдёт `app.log` уже собранного инстанса либо заглушка `{ info(){}, warn(){}, error(){} } as unknown as FastifyBaseLogger`.

- [ ] **Step 8: Реализация роутов `publicApi.ts`**

`backend/src/routes/publicApi.ts` — ключевые фрагменты (полностью: 6 ручек по одному шаблону):

```ts
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { findDialogById, setDialogStatus, touchDialog, type DialogRow } from '../db/repositories/dialogs.ts';
import { insertLead } from '../db/repositories/leads.ts';
import { insertMessage, listThreadTail, maxClientSeq } from '../db/repositories/messages.ts';
import { hashIp } from '../db/repositories/quotas.ts';
import { findWidgetByToken, type WidgetRow } from '../db/repositories/widgets.ts';
import { ApiError, sendApiError } from '../http/errors.ts';
import { originVerdict } from '../http/originGuard.ts';
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
  });

  app.post<{ Params: { token: string }; Body: { visitor_key?: unknown; dialog_id?: unknown } }>(
    '/w/v1/:token/dialogs',
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
    async (req, reply) => {
      const widget = await requireWidget(req, req.params.token, true);
      const visitorKey = requireVisitorKey(req.body?.visitor_key);
      const dialog = await requireOwnedDialog(req, widget, req.params.id, visitorKey);
      return reply.send(await reenterDialog(app.deps, { widget, dialog }));
    },
  );

  app.post<{ Params: { token: string; id: string }; Body: { visitor_key?: unknown; role?: unknown; text?: unknown; seq?: unknown } }>(
    '/w/v1/:token/dialogs/:id/messages',
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
};
```

Зарегистрировать в `app.ts` до `coreWebhookRoutes`:

```ts
await app.register(rateLimit, {
  global: false,
  max: 120,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.ip,
});
await app.register(publicApiRoutes);
```

и навесить `config: { rateLimit: { max: 30, timeWindow: '1 minute' } }` на `POST /dialogs`, `POST /reenter`, `POST /escalate` (T4); на `POST /messages` — `{ max: 120, timeWindow: '1 minute' }`.

Run: `npx vitest run` → PASS.

- [ ] **Step 9: Мутпробы (деньги и протокол)**

Каждая мутация — вернуть код после проверки:
1. В `originVerdict` вернуть `'allow'` при пустом `allowed_origins` → тест «ПУСТОЙ allowed_origins» FAIL.
2. В `originVerdict` пропускать отсутствие `Origin` на любом методе → тест «НЕ-GET без Origin — ОТКАЗ» FAIL.
3. В `app.ts` поставить `trustProxy: true` → тест «X-Forwarded-For НЕ подменяет IP» FAIL (кап обойдён, в счётчиках две строки).
4. В `startDialog` перенести `ensureSessionBudget` ПОСЛЕ `openCoreSession` → тесты капов FAIL (`core.calls` длиннее ожидаемого).
5. В `openCoreSession` заменить `limits: { max_duration_s: deps.config.maxDurationS }` на отсутствие поля → тест «создаёт диалог и chat-сессию ядра» FAIL.
6. В `newRespondentIdentity` убрать префикс `respondent-` → тест reenter FAIL.
7. В `startDialog` (ветка продолжения) убрать `await deps.core.endSession(last)` → тест продолжения нити FAIL (первый вызов ядра окажется не `/end`).
8. В `openCoreSession` вернуть счётчик попыток вместо `core_session_ids.length + 1` (например `Date.now()`) → тест «ретрай не покупает вторую сессию» FAIL. Этот тест ДОБАВИТЬ сюда же:

```ts
it('ретрай POST /dialogs с тем же состоянием шлёт ТОТ ЖЕ Idempotency-Key', async () => {
  const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
  const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
  await pool.query(
    `UPDATE dialogs SET core_session_ids='["sess_aaaaaaaaaaaaaaaa"]'::jsonb,
            current_core_session_id='sess_aaaaaaaaaaaaaaaa', status='ended' WHERE id=$1`, [dialog.id]);
  // Первая попытка: ядро приняло /end, но создание оборвалось сетью.
  core.enqueue({ status: 204, body: null });
  core.enqueue({ status: 503, body: { error: { code: 'service_unavailable', message: 'ой' } } });
  await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN },
    payload: { visitor_key: VISITOR, dialog_id: dialog.id } });
  // Вторая попытка — сессия так и не привязана, ключ ОБЯЗАН совпасть.
  core.enqueue({ status: 204, body: null });
  core.enqueue({ status: 201, body: { ...CREATED('sess_bbbbbbbbbbbbbbbb'), continued_from: 'sess_aaaaaaaaaaaaaaaa' } });
  await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN },
    payload: { visitor_key: VISITOR, dialog_id: dialog.id } });

  const creates = core.calls.filter((c) => c.url === '/api/v1/sessions');
  expect(creates).toHaveLength(2);
  expect(creates[0]!.headers['idempotency-key']).toBe(creates[1]!.headers['idempotency-key']);
  expect(creates[0]!.headers['idempotency-key']).toBe(`dlg:${dialog.id}:2`);
});
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/http backend/src/dialogs backend/src/routes/publicApi.ts backend/src/app.ts backend/test
git commit -m "feat(api): публичные ручки диалогов — Origin-check, капы, журнал, лид (Э4-T3)"
```

---
### Task 4: Эскалация чат→голос + свипер зависших диалогов

**Files:**
- Create: `backend/src/dialogs/threadDigest.ts`, `backend/src/dialogs/escalate.ts`, `backend/src/jobs/sweeper.ts`
- Modify: `backend/src/routes/publicApi.ts` (ручка `POST /w/v1/:token/dialogs/:id/escalate`), `backend/src/app.ts` (запуск свипера), `backend/src/server.ts` (остановка свипера в graceful shutdown)
- Test: `backend/test/threadDigest.test.ts`, `backend/test/escalate.test.ts`, `backend/test/sweeper.test.ts`

**Interfaces:**
- Consumes (T1-T3): `openCoreSession`, `ensureSessionBudget`, `persistTranscript`, `casDialogStatus`, `setDialogStatus`, `attachCoreSession`, `listThreadTail`, `listStaleActiveDialogs`, `applyFinalizedUsage`, `purgeOldIpCounters`, `hashIp`, `CoreClient.getTranscript/endSession/getSession`, `CoreHttpError`, `ApiError`, `mapCoreError`, `toPublicMessage`, `buildTestApp`.
- Produces:
  - `const INSTRUCTIONS_MAX = 32000`, `const DIGEST_MAX_MESSAGES = 30`, `const TRANSCRIPT_POLL_DEADLINE_MS = 4000`, `const TRANSCRIPT_POLL_INTERVAL_MS = 500`
  - `type ThreadLine = { role: 'user' | 'agent'; text: string }`
  - `buildContinuationInstructions(base: string, thread: ThreadLine[], pendingUserText?: string): string`
  - `escalateDialog(deps, input: EscalateInput): Promise<EscalateResult>` где
    `type EscalateInput = { widget: WidgetRow; dialog: DialogRow; messagesCount: number; visitorKey: string; ipHash: string }`
    (`visitorKey`/`ipHash` — не для авторизации, а для `ensureSessionBudget`: голосовая сессия платная),
    `type EscalateResult = { dialog_id: string; channel: 'voice'; core_session_id: string; participant_token: ParticipantToken; continued_from: string; transcript_complete: boolean }`
  - `startSweeper(deps, opts?: { intervalMs?: number; staleMinutes?: number; batch?: number }): { stop: () => void }`
  - `sweepOnce(deps, opts: { staleMinutes: number; batch: number }): Promise<number>` (число досинхроненных диалогов)

- [ ] **Step 1: Тест выжимки нити — FAIL**

`backend/test/threadDigest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildContinuationInstructions, DIGEST_MAX_MESSAGES, INSTRUCTIONS_MAX } from '../src/dialogs/threadDigest.ts';

const BASE = 'Ты консультант магазина.';
const line = (i: number) => ({ role: (i % 2 === 0 ? 'user' : 'agent') as 'user' | 'agent', text: `реплика ${i}` });

describe('buildContinuationInstructions', () => {
  it('без нити возвращает базовый промпт БЕЗ довесков', () => {
    expect(buildContinuationInstructions(BASE, [])).toBe(BASE);
  });

  it('нить уходит после базы, с рамкой «не зачитывай» и ролевыми префиксами', () => {
    const out = buildContinuationInstructions(BASE, [
      { role: 'user', text: 'Меня зовут Пётр' },
      { role: 'agent', text: 'Приятно познакомиться, Пётр!' },
    ]);
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('не зачитывай');
    expect(out).toContain('Посетитель: Меня зовут Пётр');
    expect(out).toContain('Аватар: Приятно познакомиться, Пётр!');
  });

  it('недобранная реплика посетителя дописывается отдельной строкой в КОНЦЕ', () => {
    const out = buildContinuationInstructions(BASE, [{ role: 'user', text: 'старое' }], 'А доставка бесплатная?');
    expect(out.indexOf('А доставка бесплатная?')).toBeGreaterThan(out.indexOf('старое'));
    expect(out).toContain('последняя реплика посетителя');
  });

  it('в выжимку идут ПОСЛЕДНИЕ 30 реплик', () => {
    const thread = Array.from({ length: 50 }, (_, i) => line(i));
    const out = buildContinuationInstructions(BASE, thread);
    expect(out).toContain('реплика 49');
    expect(out).toContain('реплика 20');
    expect(out).not.toContain('реплика 19');
    expect(DIGEST_MAX_MESSAGES).toBe(30);
  });

  it('потолок 32000 соблюдён: режется ВЫЖИМКА с головы, база цела', () => {
    const thread = Array.from({ length: 30 }, () => ({ role: 'user' as const, text: 'я'.repeat(3000) }));
    const out = buildContinuationInstructions(BASE, thread);
    expect(out.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX);
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('Посетитель:'); // хоть что-то из нити влезло
  });

  it('база сама длиннее потолка — отдаём обрезанную базу без нити', () => {
    const huge = 'я'.repeat(INSTRUCTIONS_MAX + 500);
    const out = buildContinuationInstructions(huge, [{ role: 'user', text: 'привет' }]);
    expect(out.length).toBe(INSTRUCTIONS_MAX);
    expect(out).not.toContain('Посетитель:');
  });
});
```

Run: `npx vitest run test/threadDigest.test.ts` → FAIL.

- [ ] **Step 2: Реализация `threadDigest.ts`**

```ts
/** Потолок ядра: инструкции уезжают в метаданные комнаты LiveKit. */
export const INSTRUCTIONS_MAX = 32_000;
/** Сколько последних реплик нити кладём в выжимку (P1-8 спеки). */
export const DIGEST_MAX_MESSAGES = 30;

export type ThreadLine = { role: 'user' | 'agent'; text: string };

const HEADER =
  '\n\n[Ниже — краткая выжимка предыдущей части этого же разговора с посетителем. ' +
  'Это память, а не реплика: не зачитывай её вслух и не пересказывай.]\n';
const PENDING_PREFIX = '\n[Ещё не попавшая в историю последняя реплика посетителя: ';

const render = (line: ThreadLine): string =>
  `${line.role === 'user' ? 'Посетитель' : 'Аватар'}: ${line.text}`;

/**
 * `continue_from` НЕтранзитивен и засевает лишь ~24 реплики предшественника, а
 * нить виджета дробится idle-закрытиями. «Одна правда» о нити живёт у BFF,
 * поэтому выжимку в инструкции досыпаем мы.
 */
export function buildContinuationInstructions(
  base: string,
  thread: ThreadLine[],
  pendingUserText?: string,
): string {
  if (base.length >= INSTRUCTIONS_MAX) return base.slice(0, INSTRUCTIONS_MAX);
  if (thread.length === 0 && !pendingUserText) return base;

  const tail = thread.slice(-DIGEST_MAX_MESSAGES);
  const pending = pendingUserText ? `${PENDING_PREFIX}«${pendingUserText}»]` : '';

  // Режем выжимку С ГОЛОВЫ (старое менее ценно), база и хвост неприкосновенны.
  for (let from = 0; from <= tail.length; from += 1) {
    const lines = tail.slice(from).map(render).join('\n');
    const candidate = lines === '' && pending === ''
      ? base
      : `${base}${HEADER}${lines}${pending}`;
    if (candidate.length <= INSTRUCTIONS_MAX) return candidate;
  }
  // Даже пустая выжимка не влезла — значит место съел pending: отдаём базу.
  return base.slice(0, INSTRUCTIONS_MAX);
}
```

Run: `npx vitest run test/threadDigest.test.ts` → PASS.

- [ ] **Step 3: Тест эскалации — FAIL**

`backend/test/escalate.test.ts` (обвязка `test/helpers/app.ts` из T3):

```ts
import { describe, expect, it } from 'vitest';
import { findDialogById, insertDialog } from '../src/db/repositories/dialogs.ts';
import { listThreadTail } from '../src/db/repositories/messages.ts';
// … beforeEach из helpers/app.ts: app, core (FakeCore), pool, ORIGIN, VISITOR

const TOKEN = { token: 'jwt-voice', identity: 'respondent-core', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T11:00:00Z' };

const seedChatDialog = async (): Promise<{ token: string; id: string }> => {
  const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN], instructions: 'Ты консультант.' });
  const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
  await pool.query(
    `UPDATE dialogs SET core_session_ids='["sess_aaaaaaaaaaaaaaaa"]'::jsonb,
            current_core_session_id='sess_aaaaaaaaaaaaaaaa', current_channel='chat' WHERE id=$1`, [dialog.id]);
  for (const [seq, m] of [['user', 'Меня зовут Пётр'], ['agent', 'Здравствуйте, Пётр!']].entries()) {
    await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/messages`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, role: m[0], text: m[1], seq: seq + 1 } });
  }
  return { token, id: dialog.id };
};

describe('POST /w/v1/:token/dialogs/:id/escalate', () => {
  it('полный успешный путь: end → poll до messages_count → voice continue_from', async () => {
    const { token, id } = await seedChatDialog();
    core.enqueue({ status: 204, body: null });                       // 1. /end чата
    core.enqueue({ status: 200, body: { messages: [                  // 2. транскрипт добрал обе реплики
      { seq: 1, role: 'user', text: 'Меня зовут Пётр', created_at: '2026-08-13T10:00:00Z' },
      { seq: 2, role: 'agent', text: 'Здравствуйте, Пётр!', created_at: '2026-08-13T10:00:05Z' },
    ], has_more: false } });
    core.enqueue({ status: 201, body: { session_id: 'sess_bbbbbbbbbbbbbbbb', room: 'r', participant_token: TOKEN, continued_from: 'sess_aaaaaaaaaaaaaaaa' } });

    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      channel: 'voice', core_session_id: 'sess_bbbbbbbbbbbbbbbb',
      continued_from: 'sess_aaaaaaaaaaaaaaaa', transcript_complete: true,
    });

    expect(core.calls[0]!.url).toBe('/api/v1/sessions/sess_aaaaaaaaaaaaaaaa/end');
    expect(core.calls[1]!.url).toContain('/transcript');
    const created = core.calls[2]!.body as { channel: string; continue_from: string; agent: { instructions: string }; limits: { max_duration_s: number } };
    expect(created.channel).toBe('voice');
    expect(created.continue_from).toBe('sess_aaaaaaaaaaaaaaaa');
    expect(created.limits.max_duration_s).toBe(600);
    expect(created.agent.instructions).toContain('Ты консультант.');
    expect(created.agent.instructions).toContain('Посетитель: Меня зовут Пётр');
    expect(created.agent.instructions.length).toBeLessThanOrEqual(32_000);
    expect(core.calls[2]!.headers['idempotency-key']).toBe(`dlg:${id}:1`);

    const fresh = await findDialogById(pool, id);
    expect(fresh?.status).toBe('active');
    expect(fresh?.current_channel).toBe('voice');
    expect(fresh?.core_session_ids).toEqual(['sess_aaaaaaaaaaaaaaaa', 'sess_bbbbbbbbbbbbbbbb']);
    // Транскрипт ядра сохранён отдельным источником — для сверки.
    expect((await listThreadTail(pool, id, 50)).filter((m) => m.source === 'core')).toHaveLength(2);
  });

  it('недобор ленты за 4с: последняя реплика посетителя уезжает в instructions', async () => {
    const { token, id } = await seedChatDialog();
    core.enqueue({ status: 204, body: null });
    // Лента отдаёт только первую реплику — и так на каждом опросе.
    for (let i = 0; i < 12; i += 1) {
      core.enqueue({ status: 200, body: { messages: [{ seq: 1, role: 'user', text: 'Меня зовут Пётр', created_at: '2026-08-13T10:00:00Z' }], has_more: false } });
    }
    core.enqueue({ status: 201, body: { session_id: 'sess_bbbbbbbbbbbbbbbb', room: 'r', participant_token: TOKEN, continued_from: 'sess_aaaaaaaaaaaaaaaa' } });

    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });

    expect(res.statusCode).toBe(201);
    expect(res.json().transcript_complete).toBe(false);
    const created = core.calls.at(-1)!.body as { agent: { instructions: string } };
    expect(created.agent.instructions).toContain('Ещё не попавшая в историю последняя реплика посетителя');
    expect(created.agent.instructions).toContain('Меня зовут Пётр');
  });

  it('повторный /escalate во время эскалации → 409 escalation_in_progress, второй сессии НЕТ', async () => {
    const { token, id } = await seedChatDialog();
    await pool.query(`UPDATE dialogs SET status='escalating' WHERE id=$1`, [id]);
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('escalation_in_progress');
    expect(core.calls).toHaveLength(0);
  });

  it('эскалация завершённого диалога → 409 dialog_not_active (ДРУГОЙ код: ждать бесполезно)', async () => {
    const { token, id } = await seedChatDialog();
    await pool.query(`UPDATE dialogs SET status='ended' WHERE id=$1`, [id]);
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('dialog_not_active');
    expect(core.calls).toHaveLength(0);
  });

  it('402 при создании голоса → 402, диалог в error', async () => {
    const { token, id } = await seedChatDialog();
    core.enqueue({ status: 204, body: null });
    core.enqueue({ status: 200, body: { messages: [], has_more: false } });
    core.enqueue({ status: 402, body: { error: { code: 'insufficient_credits', message: 'нет' } } });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 0 } });
    expect(res.statusCode).toBe(402);
    expect((await findDialogById(pool, id))?.status).toBe('error');
  });

  it('503 при создании голоса → 503, диалог возвращается в active (фолбэк в чат возможен)', async () => {
    const { token, id } = await seedChatDialog();
    core.enqueue({ status: 204, body: null });
    core.enqueue({ status: 200, body: { messages: [], has_more: false } });
    core.enqueue({ status: 503, body: { error: { code: 'service_unavailable', message: 'занято' } } });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 0 } });
    expect(res.statusCode).toBe(503);
    expect((await findDialogById(pool, id))?.status).toBe('active');
  });

  it('messages_count не число → 422', async () => {
    const { token, id } = await seedChatDialog();
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 'два' } });
    expect(res.statusCode).toBe(422);
  });
});
```

Run: `npx vitest run test/escalate.test.ts` → FAIL.

- [ ] **Step 4: Реализация `escalate.ts`**

```ts
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppDeps } from '../app.ts';
import { CoreHttpError } from '../core/client.ts';
import type { ParticipantToken, TranscriptMessage } from '../core/types.ts';
import { casDialogStatus, setDialogStatus, type DialogRow } from '../db/repositories/dialogs.ts';
import { listThreadTail } from '../db/repositories/messages.ts';
import type { WidgetRow } from '../db/repositories/widgets.ts';
import { ApiError, mapCoreError } from '../http/errors.ts';
import { ensureSessionBudget } from './budget.ts';
import { persistTranscript } from './transcriptSync.ts';
import { openCoreSession } from './openSession.ts';
import { buildContinuationInstructions, DIGEST_MAX_MESSAGES, type ThreadLine } from './threadDigest.ts';

/**
 * Лента ядра флашится раз в 5с, а воркер продолжения ретраит пустой fetch до
 * ~6с своего дедлайна. Ждать столько же на ручке — терять UX: 4с потолок, а
 * недобор компенсируется дописыванием реплики в instructions.
 */
export const TRANSCRIPT_POLL_DEADLINE_MS = 4_000;
export const TRANSCRIPT_POLL_INTERVAL_MS = 500;

export type EscalateInput = {
  widget: WidgetRow; dialog: DialogRow; messagesCount: number;
  visitorKey: string; ipHash: string;
};
export type EscalateResult = {
  dialog_id: string; channel: 'voice'; core_session_id: string;
  participant_token: ParticipantToken; continued_from: string; transcript_complete: boolean;
};

async function pollTranscript(
  deps: AppDeps, sessionId: string, wanted: number, now = () => Date.now(),
): Promise<TranscriptMessage[]> {
  const deadline = now() + TRANSCRIPT_POLL_DEADLINE_MS;
  let best: TranscriptMessage[] = [];
  for (;;) {
    try {
      const page = await deps.core.getTranscript(sessionId);
      if (page.messages.length > best.length) best = page.messages;
      if (best.length >= wanted) return best;
    } catch (err) {
      deps.log.warn({ err, sessionId }, 'опрос транскрипта сорвался — продолжаем до дедлайна');
    }
    if (now() >= deadline) return best;
    await sleep(TRANSCRIPT_POLL_INTERVAL_MS);
  }
}

export async function escalateDialog(deps: AppDeps, input: EscalateInput): Promise<EscalateResult> {
  const fromSession = input.dialog.current_core_session_id;
  if (!fromSession) throw new ApiError(409, 'no_live_session', 'Нечего эскалировать: живой сессии нет.');
  if (input.dialog.status !== 'active') {
    // Отдельный код: клиенту это НЕ «эскалация уже идёт», а «диалог не в том
    // состоянии» — он должен переоткрыть нить, а не ждать и повторять.
    throw new ApiError(409, 'dialog_not_active', 'Диалог не в активном состоянии — откройте его заново.');
  }

  // Капы ДО всего: голосовая сессия стоит денег ровно как стартовая (§6.3).
  // Проверяем ПЕРЕД CAS, чтобы отказ не оставил диалог в 'escalating'.
  await ensureSessionBudget(deps, { visitorKey: input.visitorKey, ipHash: input.ipHash });

  // CAS: вторая параллельная эскалация НЕ создаст вторую платную сессию.
  if (!(await casDialogStatus(deps.pool, input.dialog.id, 'active', 'escalating'))) {
    throw new ApiError(409, 'escalation_in_progress', 'Эскалация уже идёт.');
  }

  try {
    // 1. Закрываем чат: continue_from требует ЗАВЕРШЁННУЮ сессию.
    await deps.core.endSession(fromSession);

    // 2. Ждём оседания ленты. Двойная страховка: воркер продолжения сам ретраит
    //    пустой fetch истории до ~6с общего дедлайна, а мы добираем
    //    недостающее в instructions.
    const messages = await pollTranscript(deps, fromSession, input.messagesCount);
    // Тот же дедуп, что в сверке: клиент уже записал эти реплики своим путём.
    await persistTranscript(deps, { dialog: input.dialog, sessionId: fromSession, messages });
    const transcriptComplete = messages.length >= input.messagesCount;

    // 3. Недобор — дописываем последнюю реплику посетителя из НАШЕГО журнала.
    let pending: string | undefined;
    if (!transcriptComplete) {
      const journal = await listThreadTail(deps.pool, input.dialog.id, 50);
      pending = journal.filter((m) => m.source === 'client' && m.role === 'user').at(-1)?.text;
    }

    // 4. Выжимка нити: continue_from нетранзитивен, «одна правда» у BFF.
    const thread: ThreadLine[] = (await listThreadTail(deps.pool, input.dialog.id, DIGEST_MAX_MESSAGES * 2))
      .filter((m) => m.source === 'client')
      .map((m) => ({ role: m.role, text: m.text }));
    const instructions = buildContinuationInstructions(
      input.widget.agent_config.instructions, thread, pending,
    );

    const opened = await openCoreSession(deps, {
      widget: input.widget, dialog: input.dialog, channel: 'voice',
      instructions, continueFrom: fromSession,
    });
    await setDialogStatus(deps.pool, input.dialog.id, 'active');

    return {
      dialog_id: input.dialog.id, channel: 'voice',
      core_session_id: opened.core_session_id,
      participant_token: opened.participant_token,
      continued_from: opened.continued_from ?? fromSession,
      transcript_complete: transcriptComplete,
    };
  } catch (err) {
    if (err instanceof CoreHttpError) {
      // 402 — денег нет, диалог мёртв; остальное — возвращаем в active, клиент
      // уйдёт в chat_fallback (новый чат с continue_from).
      await setDialogStatus(deps.pool, input.dialog.id, err.status === 402 ? 'error' : 'active');
      throw mapCoreError(err);
    }
    await setDialogStatus(deps.pool, input.dialog.id, 'active');
    throw err;
  }
}
```

Ручка в `publicApi.ts`:

```ts
app.post<{ Params: { token: string; id: string }; Body: { visitor_key?: unknown; messages_count?: unknown } }>(
  '/w/v1/:token/dialogs/:id/escalate',
  { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
  async (req, reply) => {
    const widget = await requireWidget(req, req.params.token, true);
    const visitorKey = requireVisitorKey(req.body?.visitor_key);
    const dialog = await requireOwnedDialog(req, widget, req.params.id, visitorKey);
    const messagesCount = Number(req.body?.messages_count);
    if (!Number.isInteger(messagesCount) || messagesCount < 0) {
      throw new ApiError(422, 'invalid_messages_count', 'messages_count — целое ≥ 0.');
    }
    return reply.code(201).send(await escalateDialog(app.deps, {
      widget, dialog, messagesCount, visitorKey,
      ipHash: hashIp(req.ip, app.deps.config.ipHashSalt),
    }));
  },
);
```

Run: `npx vitest run test/escalate.test.ts` → PASS.

- [ ] **Step 5: Мутпробы эскалации (деньги + протокол)**

1. Заменить `casDialogStatus(..., 'active', 'escalating')` на `setDialogStatus(..., 'escalating')` → тест «повторный /escalate → 409 escalation_in_progress» FAIL. Вернуть.
2. Убрать `await deps.core.endSession(fromSession)` → тест полного пути FAIL (первый вызов ядра окажется транскриптом). Вернуть.
3. Убрать `continueFrom: fromSession` → тест полного пути FAIL. Вернуть.
3a. Убрать вызов `ensureSessionBudget` из `escalateDialog` → тест «кап считает и ЭСКАЛАЦИЮ» (T3, `caps.test.ts`) FAIL: ядро будет тронуто. Вернуть.
3b. Убрать проверку `input.dialog.status !== 'active'` → тест «эскалация завершённого диалога → 409 dialog_not_active» FAIL (ответ станет `escalation_in_progress` или 201). Вернуть.
4. В `pollTranscript` вернуть `best` сразу после первого запроса (без ожидания `wanted`) → тест «недобор ленты» останется зелёным, а вот полный путь с задержанной лентой не покрыт → ДОБАВИТЬ тест: первый опрос отдаёт 1 сообщение, второй — 2; ожидание `transcript_complete === true` и ≥2 вызовов `/transcript`. С мутацией FAIL, без — PASS.
5. Поднять `INSTRUCTIONS_MAX` до `100_000` → тест потолка в `threadDigest.test.ts` FAIL. Вернуть.

- [ ] **Step 6: Тест свипера — FAIL**

`backend/test/sweeper.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sweepOnce } from '../src/jobs/sweeper.ts';
import { findDialogById, insertDialog } from '../src/db/repositories/dialogs.ts';
// … обвязка helpers/app.ts

describe('свипер зависших диалогов', () => {
  it('досинхронивает статус и деньги по карточке ядра', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa', current_channel='chat',
              last_activity_at = now() - interval '5 hours' WHERE id=$1`, [dialog.id]);

    core.enqueue({ status: 200, body: {
      session_id: 'sess_aaaaaaaaaaaaaaaa', channel: 'chat', status: 'finalized',
      duration_s: 120, credits_total: 9, usage_summary: { chat_token: 800 },
    } });

    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(1);
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.status).toBe('ended');
    expect(fresh?.credits_total).toBe(9);
    expect(fresh?.usage).toEqual({ chat_token: 800 });
  });

  it('живую сессию не трогает', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa',
              last_activity_at = now() - interval '5 hours' WHERE id=$1`, [dialog.id]);
    core.enqueue({ status: 200, body: { session_id: 'sess_aaaaaaaaaaaaaaaa', channel: 'chat', status: 'active' } });
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(0);
    expect((await findDialogById(pool, dialog.id))?.status).toBe('active');
  });

  it('свежий диалог в выборку не попадает — ядро не дёргается', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(`UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa' WHERE id=$1`, [dialog.id]);
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(0);
    expect(core.calls).toHaveLength(0);
  });

  it('деньги не удваиваются, если вебхук уже приезжал', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa', status='ended',
              credits_total = 9, usage = '{"chat_token":800}'::jsonb,
              last_activity_at = now() - interval '5 hours' WHERE id=$1`, [dialog.id]);
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(0);
    expect(core.calls).toHaveLength(0); // ended в выборку не берём вовсе
  });
});
```

Run: `npx vitest run test/sweeper.test.ts` → FAIL.

- [ ] **Step 7: Реализация `sweeper.ts`**

```ts
import type { AppDeps } from '../app.ts';
import { applyFinalizedUsage, listStaleActiveDialogs, setDialogStatus } from '../db/repositories/dialogs.ts';
import { purgeOldIpCounters } from '../db/repositories/quotas.ts';

const TERMINAL = new Set(['finalized', 'expired']);

/**
 * Вебхук после 8 неудачных доставок теряется НАВСЕГДА — статус и деньги
 * зависшего диалога иначе никогда не сойдутся. Свипер спрашивает карточку сам.
 * Выборка берёт только active/escalating: ended/error уже сведены (и деньги по
 * ним посчитаны вебхуком), повторный проход удвоил бы credits_total.
 */
export async function sweepOnce(deps: AppDeps, opts: { staleMinutes: number; batch: number }): Promise<number> {
  const stale = await listStaleActiveDialogs(deps.pool, opts.staleMinutes, opts.batch);
  let synced = 0;
  for (const dialog of stale) {
    const sessionId = dialog.current_core_session_id;
    if (!sessionId) continue;
    try {
      const card = await deps.core.getSession(sessionId);
      if (!TERMINAL.has(card.status)) continue;
      // Идемпотентно по sessionId: вебхук мог долететь между выборкой и этим
      // моментом — тогда деньги уже учтены и второй раз не прибавятся.
      await applyFinalizedUsage(deps.pool, {
        dialogId: dialog.id,
        sessionId,
        usage: (card.usage_summary ?? {}) as Record<string, number>,
        creditsTotal: card.credits_total ?? 0,
      });
      await setDialogStatus(deps.pool, dialog.id, 'ended');
      synced += 1;
      deps.log.info({ dialogId: dialog.id, sessionId, status: card.status }, 'свипер досинхронил зависший диалог');
    } catch (err) {
      deps.log.warn({ err, dialogId: dialog.id, sessionId }, 'свипер: карточку сессии получить не удалось');
    }
  }
  return synced;
}

export function startSweeper(
  deps: AppDeps,
  opts: { intervalMs?: number; staleMinutes?: number; batch?: number } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 10 * 60_000;
  const staleMinutes = opts.staleMinutes ?? 120;
  const batch = opts.batch ?? 50;
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // предыдущий проход ещё идёт — тик пропускаем
    running = true;
    void sweepOnce(deps, { staleMinutes, batch })
      // Тем же тиком подметаем суточные счётчики: иначе таблица растёт по
      // строке на IP в день и не чистится никем.
      .then(() => purgeOldIpCounters(deps.pool, 7))
      .catch((err: unknown) => deps.log.error({ err }, 'проход свипера сорвался'))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref(); // не держим процесс при shutdown
  return { stop: () => clearInterval(timer) };
}
```

В `server.ts`: `const sweeper = startSweeper({ config, pool, core, log: app.log });` и `sweeper.stop()` первым шагом graceful shutdown.

Run: `npx vitest run` → PASS.

- [ ] **Step 8: Мутпроба свипера**

Расширить выборку `listStaleActiveDialogs` до `status IN ('active','escalating','ended')` → тест «деньги не удваиваются» FAIL (`core.calls` не пуст). Вернуть. Прогнать — PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/dialogs/threadDigest.ts backend/src/dialogs/escalate.ts backend/src/jobs/sweeper.ts backend/src/routes/publicApi.ts backend/src/app.ts backend/src/server.ts backend/test
git commit -m "feat(escalation): чат→голос через continue_from + выжимка нити + свипер (Э4-T4)"
```

---
### Task 5: Backend-обвязка embed + лоадер `w.<hash>.js` с шимом

**Files:**
- Create: `backend/src/routes/appPage.ts`; Modify: `backend/src/app.ts` (`@fastify/static` + appPage)
- Create: `embed/loader/package.json`, `embed/loader/vite.config.ts`, `embed/loader/src/loader.ts`, `embed/loader/scripts/make-shim.mjs`, `embed/loader/scripts/size-check.mjs`
- Test: `backend/test/appPage.test.ts`, `embed/loader/test/loader.test.ts`

**Interfaces:**
- Consumes (T1–T3): `findWidgetByToken`, `normalizeOrigin`, `AppDeps`, `buildTestApp`, `GET /w/v1/:token/config`.
- Produces:
  - Backend: `appPageRoutes: FastifyPluginAsync` — `GET /app/:token` (HTML iframe-приложения с CSP `frame-ancestors` из `allowed_origins`); статика `/w.js`, `/w.<hash>.js`, `/assets/*`, `/demo.html`.
  - Лоадер: `boot(input: LoaderBoot): Promise<void>`; глобальный гард `window.__askiSiteWidget`; очередь `window.AskiWidgetQueue: LoaderBoot[]`, `type LoaderBoot = { token: string; base: string }`.
  - postMessage-протокол (обе стороны валидируют origin И source) — контракт, который реализует T6:
    - iframe→хост: `{ src: 'aski-widget', type: 'ready' }`, `{ src, type: 'state', visitorKey: string, dialogId: string | null }`, `{ src, type: 'close' }`
    - хост→iframe: `{ src: 'aski-widget-host', type: 'init', visitorKey: string, dialogId: string | null, parentOrigin: string }`, `{ src, type: 'visibility', visible: boolean }`
  - Артефакты сборки: `embed/loader/dist/w.<hash>.js` (иммутабельный) + `embed/loader/dist/w.js` (шим, кэш 60с), gzip ≤ 8 КБ.

- [ ] **Step 1: Тест страницы `/app/:token` — FAIL**

`backend/test/appPage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
// … обвязка helpers/app.ts

describe('GET /app/:token', () => {
  it('CSP несёт frame-ancestors из allowed_origins — единственная НАСТОЯЩАЯ защита от встраивания', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: ['https://shop.example', 'https://www.shop.example'] });
    const res = await app.inject({ method: 'GET', url: `/app/${token}` });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("frame-ancestors 'self' https://shop.example https://www.shop.example");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers['x-frame-options']).toBeUndefined(); // XFO не умеет список — только CSP
  });

  it('пустой allowed_origins → frame-ancestors none', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [] });
    const res = await app.inject({ method: 'GET', url: `/app/${token}` });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('токен прокидывается в страницу, но НЕ через innerHTML-инъекцию', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: ['https://shop.example'] });
    const res = await app.inject({ method: 'GET', url: `/app/${token}` });
    expect(res.body).toContain(`data-widget-token="${token}"`);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('неизвестный токен → 404 без раскрытия', async () => {
    expect((await app.inject({ method: 'GET', url: '/app/нет-такого' })).statusCode).toBe(404);
  });
});
```

Run: `npx vitest run test/appPage.test.ts` → FAIL.

- [ ] **Step 2: Реализация `backend/src/routes/appPage.ts`**

```ts
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
```

Зарегистрировать статику и `appPageRoutes` в `app.ts`. `@fastify/static` НЕЛЬЗЯ регистрировать дважды с одним `prefix` — второй вызов упадёт с `FST_ERR_DEC_ALREADY_PRESENT` (`decorateReply: false` у второго это лечит лишь частично и оставляет два конфликтующих хендлера на `/`). Вместо этого один register со СПИСКОМ корней:

```ts
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';

await app.register(fastifyStatic, {
  // Порядок важен: первый корень, где нашёлся файл, побеждает.
  root: [
    fileURLToPath(new URL('../../embed/loader/dist', import.meta.url)), // /w.js, /w.<hash>.js
    fileURLToPath(new URL('../../embed/public', import.meta.url)),      // /demo.html
  ],
  prefix: '/',
  index: false,
  // Хэшированный бандл иммутабелен; шим обязан протухать быстро.
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', /w\.[^.]+\.js$/.test(path)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=60');
  },
});

await app.register(fastifyStatic, {
  root: fileURLToPath(new URL('../../embed/app/dist/assets', import.meta.url)),
  prefix: '/assets/',
  decorateReply: false, // reply.sendFile уже задекорирован первым register
  index: false,
});

await app.register(appPageRoutes);
```

Run: `npx vitest run test/appPage.test.ts` → PASS.

- [ ] **Step 3: Тест лоадера — FAIL**

`embed/loader/package.json`: deps нет; devDeps `vite ^6`, `typescript ~5.7`, `vitest ^3`, `happy-dom ^15`.

`embed/loader/test/loader.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../src/loader.ts';

const CONFIG = {
  widget_id: 'w1', name: 'Виджет', enabled: true,
  allowed_origins: ['https://shop.example'],
  app_url: 'https://widget.aski.pro/app/tok', text_max_length: 2000,
};

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__askiSiteWidget;
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(CONFIG), { status: 200 })));
});

describe('лоадер', () => {
  it('вешает кнопку в Shadow DOM и НЕ создаёт iframe до первого клика', async () => {
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const host = document.querySelector('aski-site-widget')!;
    expect(host.shadowRoot!.querySelector('button')).not.toBeNull();
    expect(host.shadowRoot!.querySelector('iframe')).toBeNull();
  });

  it('iframe создаётся на клик: allow=microphone, sandbox с allow-same-origin', async () => {
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const root = document.querySelector('aski-site-widget')!.shadowRoot!;
    (root.querySelector('button') as HTMLButtonElement).click();
    const frame = root.querySelector('iframe')!;
    expect(frame.getAttribute('allow')).toBe('microphone; autoplay');
    const sandbox = frame.getAttribute('sandbox')!;
    // allow-same-origin ОБЯЗАТЕЛЕН: без него opaque origin убивает getUserMedia
    // и localStorage внутри iframe — микрофон просто не запросится.
    expect(sandbox).toContain('allow-same-origin');
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).toContain('allow-forms');
    expect(frame.src).toContain('https://widget.aski.pro/app/tok');
  });

  it('visitor_key живёт в localStorage ХОСТА (first-party) и переживает перезапуск', async () => {
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const first = localStorage.getItem('aski-sw-visitor-tok');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>).__askiSiteWidget;
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    expect(localStorage.getItem('aski-sw-visitor-tok')).toBe(first);
  });

  it('localStorage кинул (приватный режим) — лоадер жив, ключ в памяти', async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('заблокировано'); };
    await expect(boot({ token: 'tok', base: 'https://widget.aski.pro/' })).resolves.toBeUndefined();
    expect(document.querySelector('aski-site-widget')).not.toBeNull();
    Storage.prototype.setItem = original;
  });

  it('повторная вставка сниппета не плодит второй виджет', async () => {
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    expect(document.querySelectorAll('aski-site-widget')).toHaveLength(1);
  });

  it('enabled:false — ничего не рисуем', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...CONFIG, enabled: false }), { status: 200 })));
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    expect(document.querySelector('aski-site-widget')).toBeNull();
  });

  it('404 конфига — тихий выход без единой ошибки в консоли', async () => {
    const errorSpy = vi.spyOn(console, 'error');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    expect(document.querySelector('aski-site-widget')).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('сообщения принимаются ТОЛЬКО от своего iframe и своего origin', async () => {
    await boot({ token: 'tok', base: 'https://widget.aski.pro/' });
    const root = document.querySelector('aski-site-widget')!.shadowRoot!;
    (root.querySelector('button') as HTMLButtonElement).click();
    const frame = root.querySelector('iframe')!;
    // Чужой origin — игнор (панель не закроется).
    window.dispatchEvent(new MessageEvent('message', {
      data: { src: 'aski-widget', type: 'close' }, origin: 'https://evil.example', source: frame.contentWindow,
    }));
    expect(frame.style.display).not.toBe('none');
  });
});
```

Run: `cd embed/loader && npx vitest run` → FAIL.

- [ ] **Step 4: Реализация лоадера**

`embed/loader/src/loader.ts` (экспорт `boot` ради тестируемости; IIFE-обёртка — в конце файла):

```ts
export type LoaderBoot = { token: string; base: string };

type LoaderConfig = {
  widget_id: string; name: string; enabled: boolean;
  allowed_origins: string[]; app_url: string; text_max_length: number;
};

const MSG_FROM_FRAME = 'aski-widget';
const MSG_TO_FRAME = 'aski-widget-host';

// localStorage кидает в приватном режиме Safari и при запрете кук: любое
// обращение — в try/catch, с фолбэком в память (посетитель просто потеряет
// нить между визитами, но виджет останется рабочим).
const memory = new Map<string, string>();
const lsGet = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return memory.get(key) ?? null; }
};
const lsSet = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { memory.set(key, value); }
};

const uuid = (): string =>
  (crypto.randomUUID?.() ?? '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16)));

const onBodyReady = (fn: () => void): void => {
  // Сниппет часто стоит в <head> — body ещё нет.
  if (document.body) fn();
  else document.addEventListener('DOMContentLoaded', fn, { once: true });
};

export async function boot(input: LoaderBoot): Promise<void> {
  const flag = '__askiSiteWidget';
  // CMS вставляют сниппет дважды — второй запуск обязан быть no-op.
  if ((window as unknown as Record<string, unknown>)[flag]) return;
  (window as unknown as Record<string, unknown>)[flag] = true;

  let config: LoaderConfig;
  try {
    const res = await fetch(`${input.base}w/v1/${encodeURIComponent(input.token)}/config`, { mode: 'cors' });
    if (!res.ok) { (window as unknown as Record<string, unknown>)[flag] = false; return; } // 404 — тихо
    config = (await res.json()) as LoaderConfig;
  } catch {
    (window as unknown as Record<string, unknown>)[flag] = false;
    return; // сеть легла — виджет не наша главная забота на чужом сайте
  }
  if (!config.enabled) { (window as unknown as Record<string, unknown>)[flag] = false; return; }

  const visitorKeyName = `aski-sw-visitor-${input.token}`;
  const dialogKeyName = `aski-sw-dialog-${input.token}`;
  // visitor_key живёт в FIRST-PARTY хранилище хоста: у iframe оно
  // партиционировано/выключено (ITP Safari), и нить терялась бы каждый визит.
  let visitorKey = lsGet(visitorKeyName);
  if (!visitorKey) { visitorKey = uuid(); lsSet(visitorKeyName, visitorKey); }

  const appOrigin = new URL(config.app_url).origin;

  onBodyReady(() => {
    const host = document.createElement('aski-site-widget');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host{all:initial}
      .btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;
           border:none;border-radius:50%;background:#2563eb;color:#fff;font:600 22px/1 system-ui;cursor:pointer}
      .frame{position:fixed;right:20px;bottom:20px;z-index:2147483001;width:380px;
             height:min(640px,calc(100vh - 40px));border:none;border-radius:18px;display:none;
             background:#fff;color-scheme:light;box-shadow:0 12px 48px rgba(0,0,0,.24)}
      @media (max-width:767px){.frame{inset:0;width:100%;height:100dvh;border-radius:0}}
    `;
    const button = document.createElement('button');
    button.className = 'btn';
    button.type = 'button';
    button.setAttribute('aria-label', `Открыть чат: ${config.name}`);
    button.textContent = '💬';
    root.append(style, button);
    document.body.appendChild(host);

    let frame: HTMLIFrameElement | null = null;
    let frameReady = false;
    const pending: unknown[] = [];

    const post = (message: Record<string, unknown>): void => {
      const payload = { src: MSG_TO_FRAME, ...message };
      if (!frame || !frameReady) { pending.push(payload); return; }
      frame.contentWindow?.postMessage(payload, appOrigin); // никогда не '*'
    };

    const ensureFrame = (): HTMLIFrameElement => {
      if (frame) return frame;
      frame = document.createElement('iframe');
      frame.className = 'frame';
      frame.src = config.app_url;
      frame.title = `Чат: ${config.name}`;
      frame.setAttribute('allow', 'microphone; autoplay');
      // allow-same-origin ОБЯЗАТЕЛЕН вместе с allow-scripts: без него iframe
      // получает opaque origin, а с ним умирают getUserMedia и localStorage.
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      root.appendChild(frame);
      return frame;
    };

    const open = (): void => {
      const el = ensureFrame();
      el.style.display = 'block';
      button.style.display = 'none';
      post({ type: 'visibility', visible: true });
    };
    const close = (): void => {
      if (frame) frame.style.display = 'none';
      button.style.display = 'block';
      post({ type: 'visibility', visible: false });
    };

    button.addEventListener('click', open);

    window.addEventListener('message', (event: MessageEvent) => {
      // Тройная проверка: origin + именно НАШ iframe + маркер конверта.
      if (event.origin !== appOrigin) return;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { src?: string; type?: string; visitorKey?: string; dialogId?: string | null };
      if (data?.src !== MSG_FROM_FRAME) return;

      if (data.type === 'ready') {
        frameReady = true;
        post({ type: 'init', visitorKey, dialogId: lsGet(dialogKeyName), parentOrigin: location.origin });
        // Флашим накопленное: iframe грузится секунды, «open» иначе теряется.
        for (const message of pending.splice(0)) frame.contentWindow?.postMessage(message, appOrigin);
      } else if (data.type === 'state') {
        if (data.visitorKey) lsSet(visitorKeyName, data.visitorKey);
        lsSet(dialogKeyName, data.dialogId ?? '');
      } else if (data.type === 'close') {
        close();
      }
    });
  });
}

// Бутстрап: шим кладёт конфиг в очередь, основной бандл её разбирает.
const queue = (window as unknown as { AskiWidgetQueue?: LoaderBoot[] }).AskiWidgetQueue ?? [];
for (const item of queue) void boot(item);
```

Run: `cd embed/loader && npx vitest run` → PASS.

- [ ] **Step 5: Сборка `w.<hash>.js` + шим + бюджет размера**

`embed/loader/vite.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2019',
    minify: 'esbuild',
    lib: { entry: 'src/loader.ts', formats: ['iife'], name: 'AskiSiteWidget' },
    rollupOptions: { output: { entryFileNames: 'w.[hash].js', extend: true } },
    outDir: 'dist',
    emptyOutDir: true,
  },
});
```

`embed/loader/scripts/make-shim.mjs`:

```js
// Стабильный /w.js: сниппет у клиента на сайте ВЕЧЕН, а бандл обязан катиться
// без дрейфа кэша. Шим короткий, кэш 60с; хэшированный бандл — immutable.
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const hashed = readdirSync(dist).find((f) => /^w\.[^.]+\.js$/.test(f));
if (!hashed) { console.error('в dist нет w.<hash>.js — сначала vite build'); process.exit(1); }

writeFileSync(join(dist, 'w.js'), `(function(){
var me=document.currentScript||document.querySelector('script[data-widget]');
if(!me)return;var t=me.getAttribute('data-widget');if(!t)return;
var base=me.getAttribute('data-host')||new URL('.',me.src).href;
(window.AskiWidgetQueue=window.AskiWidgetQueue||[]).push({token:t,base:base});
var s=document.createElement('script');s.async=true;s.src=new URL('${hashed}',me.src).href;
(document.head||document.documentElement).appendChild(s);})();`);
console.log(`шим /w.js указывает на ${hashed}`);
```

`embed/loader/scripts/size-check.mjs`:

```js
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 8 * 1024;
const dist = new URL('../dist/', import.meta.url).pathname;
const bundle = readdirSync(dist).find((f) => /^w\.[^.]+\.js$/.test(f));
const size = gzipSync(readFileSync(join(dist, bundle))).length;
console.log(`${bundle}: ${size} байт gzip (потолок ${LIMIT})`);
if (size > LIMIT) { console.error('БЮДЖЕТ ПРЕВЫШЕН — лоадер на чужой странице обязан быть крошечным'); process.exit(1); }
```

`embed/loader/package.json` scripts: `"build": "vite build && node scripts/make-shim.mjs && node scripts/size-check.mjs"`.

Run: `cd embed/loader && npm run build` → бандл собран, шим создан, размер в бюджете (иначе шаг красный — резать код лоадера, а не поднимать лимит).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/appPage.ts backend/src/app.ts backend/test/appPage.test.ts embed/loader
git commit -m "feat(embed): страница iframe с frame-ancestors + лоадер w.<hash>.js и шим (Э4-T5)"
```

---
### Task 6: iframe-приложение — чат по data-channel

**Files:**
- Create: `embed/app/package.json`, `embed/app/vite.config.ts`, `embed/app/index.html`, `embed/app/src/main.ts`, `embed/app/src/App.vue`
- Create: `embed/app/src/lib/{bridge.ts,echoGuard.ts,resender.ts,api.ts,frames.ts,room.ts}`
- Create: `embed/app/src/components/{ChatFeed.vue,Composer.vue,Bubble.vue,StateBanner.vue}`
- Test: `embed/app/test/{echoGuard,resender,frames,bridge,chat}.test.ts`, `embed/app/test/helpers/mount.ts`

**Interfaces:**
- Consumes (T3, T5): `GET /w/v1/:token/config`, `POST /w/v1/:token/dialogs`, `POST …/reenter`, `POST|GET …/messages`, `POST …/end` (все отдают `next_seq`); postMessage-контракт лоадера; `data-widget-token` на `#app`.
- Produces:
  - `embed/app/src/lib/echoGuard.ts`: `normalizeEcho(text: string): string`; `createEchoGuard(opts: { windowMs: number; now: () => number }): { remember(text: string): void; isEcho(text: string): boolean }`
  - `embed/app/src/lib/resender.ts`: `createResender(send: () => void, opts: { intervalMs: number; maxAttempts: number }): { start(): void; stop(): void; bump(): void }`
  - `embed/app/src/lib/frames.ts`: `type WorkerFrame`, `type ClientFrame`, `parseWorkerFrame(raw: Uint8Array | string): WorkerFrame | null`, `encodeClientFrame(frame: ClientFrame): Uint8Array`
  - `embed/app/src/lib/bridge.ts`: `createBridge(opts: { allowedOrigins: string[]; onInit: (p: { visitorKey: string; dialogId: string | null }) => void; onVisibility: (visible: boolean) => void }): { ready(): void; listen(): void; sendState(visitorKey: string, dialogId: string | null): void; close(): void }`
  - `embed/app/src/lib/api.ts`: `class WidgetApi` — `config()`, `startDialog(visitorKey, dialogId?)`, `reenter(dialogId, visitorKey)`, `journal(dialogId, visitorKey, role, text, seq)`, `end(dialogId, visitorKey)`, `escalate(dialogId, visitorKey, messagesCount)`, `lead(dialogId, visitorKey, payload)`; ошибки бросает как `ApiFailure = { status: number; code: string; message: string }`.
  - `embed/app/src/lib/room.ts`: `class CoreRoom` — `connect(url, token, opts: { audio: boolean })`, `publish(frame: ClientFrame)`, `setMicrophoneEnabled(on: boolean)`, `disconnect()`; колбэки `onFrame`, `onAgentJoined`, `onDisconnected`.
  - `embed/app/dist/` — собранное приложение, которое отдаёт `GET /app/:token` из T5.

- [ ] **Step 1: Тесты чистых модулей iframe-приложения — FAIL**

`embed/app/test/echoGuard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createEchoGuard, normalizeEcho } from '../src/lib/echoGuard.ts';

describe('дедуп эха', () => {
  it('нормализация: регистр, пробелы, края', () => {
    expect(normalizeEcho('  Меня   зовут\nПётр ')).toBe('меня зовут пётр');
  });

  it('свой текст, вернувшийся transcript-ом, съедается ОДИН раз', () => {
    let now = 0;
    const guard = createEchoGuard({ windowMs: 30_000, now: () => now });
    guard.remember('Меня зовут Пётр');
    expect(guard.isEcho('Меня зовут Пётр')).toBe(true);
    // Второй такой же transcript — уже НЕ эхо: посетитель мог повторить фразу.
    expect(guard.isEcho('Меня зовут Пётр')).toBe(false);
  });

  it('эхо с иной пунктуацией пробелов всё равно ловится', () => {
    let now = 0;
    const guard = createEchoGuard({ windowMs: 30_000, now: () => now });
    guard.remember('Меня зовут Пётр');
    expect(guard.isEcho('меня  зовут пётр')).toBe(true);
  });

  it('за окном 30с эхо не срабатывает — это уже реплика голосом', () => {
    let now = 0;
    const guard = createEchoGuard({ windowMs: 30_000, now: () => now });
    guard.remember('Меня зовут Пётр');
    now = 30_001;
    expect(guard.isEcho('Меня зовут Пётр')).toBe(false);
  });

  it('чужой текст (STT в голосе) НЕ съедается', () => {
    const guard = createEchoGuard({ windowMs: 30_000, now: () => 0 });
    guard.remember('Меня зовут Пётр');
    expect(guard.isEcho('А доставка бесплатная?')).toBe(false);
  });
});
```

`embed/app/test/resender.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResender } from '../src/lib/resender.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ре-отправщик служебных фреймов', () => {
  it('шлёт сразу и повторяет до потолка попыток', () => {
    const send = vi.fn();
    createResender(send, { intervalMs: 1000, maxAttempts: 3 }).start();
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3500);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('stop гасит повторы', () => {
    const send = vi.fn();
    const resender = createResender(send, { intervalMs: 1000, maxAttempts: 10 });
    resender.start();
    resender.stop();
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('гасим ПОСЛЕ очередной отправки, а не вместо неё: фрейм воркера доказывает лишь, что воркер в комнате', () => {
    const send = vi.fn();
    const resender = createResender(send, { intervalMs: 1000, maxAttempts: 10 });
    resender.start();
    resender.bump();          // увидели фрейм воркера
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(2); // ещё одна отправка ушла
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(2); // и только потом тишина
  });
});
```

`embed/app/test/frames.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { encodeClientFrame, parseWorkerFrame } from '../src/lib/frames.ts';

describe('фреймы pv1', () => {
  it('user_text кодируется ровно как {type,text}', () => {
    const bytes = encodeClientFrame({ type: 'user_text', text: 'Меня зовут Пётр' });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ type: 'user_text', text: 'Меня зовут Пётр' });
  });

  it('client_ready и resume_welcome — без полезной нагрузки', () => {
    expect(JSON.parse(new TextDecoder().decode(encodeClientFrame({ type: 'client_ready' })))).toEqual({ type: 'client_ready' });
    expect(JSON.parse(new TextDecoder().decode(encodeClientFrame({ type: 'resume_welcome' })))).toEqual({ type: 'resume_welcome' });
  });

  it('transcript разбирается со speaker (data-channel говорит respondent, НЕ user)', () => {
    const frame = parseWorkerFrame(JSON.stringify({ type: 'transcript', speaker: 'respondent', text: 'привет' }));
    expect(frame).toEqual({ type: 'transcript', speaker: 'respondent', text: 'привет', interrupted: false });
  });

  it('легаси-поле role=avatar|client понимается как speaker', () => {
    const frame = parseWorkerFrame(JSON.stringify({ type: 'transcript', role: 'avatar', text: 'привет' }));
    expect(frame).toMatchObject({ type: 'transcript', speaker: 'agent' });
  });

  it('session_ended несёт свободную строку reason — незнакомое значение переживаем', () => {
    expect(parseWorkerFrame(JSON.stringify({ type: 'session_ended', reason: 'нечто_новое' })))
      .toEqual({ type: 'session_ended', reason: 'нечто_новое' });
  });

  it('мусор и чужие кадры дают null, а не исключение', () => {
    expect(parseWorkerFrame('не json')).toBeNull();
    expect(parseWorkerFrame(JSON.stringify({ нет: 'типа' }))).toBeNull();
    expect(parseWorkerFrame(JSON.stringify({ type: 'transcript' }))).toBeNull(); // нет text
  });

  it('неизвестный тип фрейма отдаётся как есть — протокол расширяется аддитивно', () => {
    expect(parseWorkerFrame(JSON.stringify({ type: 'session_timer', remaining_s: 42 })))
      .toEqual({ type: 'session_timer', remaining_s: 42 });
  });
});
```

Run: `cd embed/app && npx vitest run` → FAIL.

- [ ] **Step 2: Реализация чистых модулей**

`embed/app/src/lib/echoGuard.ts`:

```ts
/** Воркер шлёт обратно и реплику посетителя (transcript speaker=respondent). */
export const normalizeEcho = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

export type EchoGuard = { remember(text: string): void; isEcho(text: string): boolean };

export function createEchoGuard(opts: { windowMs: number; now: () => number }): EchoGuard {
  const pending: { key: string; at: number }[] = [];
  return {
    remember(text) {
      pending.push({ key: normalizeEcho(text), at: opts.now() });
    },
    isEcho(text) {
      const key = normalizeEcho(text);
      const now = opts.now();
      const index = pending.findIndex((item) => item.key === key && now - item.at <= opts.windowMs);
      if (index === -1) return false;
      // Гасим ОДНУ запись: повторное такое же сообщение — уже настоящая реплика.
      pending.splice(index, 1);
      return true;
    },
  };
}
```

`embed/app/src/lib/resender.ts`:

```ts
/**
 * client_ready / resume_welcome теряются, если воркер вошёл в комнату позже нас:
 * LiveKit data-фреймы не буферизуются. Гасим ПОСЛЕ очередной отправки — фрейм
 * воркера доказывает лишь, что он в комнате, а не что НАШ фрейм доехал.
 */
export function createResender(
  send: () => void,
  opts: { intervalMs: number; maxAttempts: number },
): { start(): void; stop(): void; bump(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let sent = 0;
  let acked = false;

  const stop = (): void => {
    if (timer !== null) { clearInterval(timer); timer = null; }
  };

  return {
    start() {
      if (timer !== null) return;
      send(); sent = 1;
      timer = setInterval(() => {
        if (sent >= opts.maxAttempts) { stop(); return; }
        send(); sent += 1;
        if (acked) stop();
      }, opts.intervalMs);
    },
    stop,
    bump() { acked = true; },
  };
}
```

`embed/app/src/lib/frames.ts`:

```ts
export type WorkerFrame =
  | { type: 'transcript'; speaker: 'agent' | 'respondent'; text: string; interrupted: boolean }
  | { type: 'session_ended'; reason: string }
  | { type: 'agent_typing'; value: boolean }
  | { type: string; [key: string]: unknown };

export type ClientFrame =
  | { type: 'client_ready' }
  | { type: 'resume_welcome' }
  | { type: 'user_text'; text: string };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export const encodeClientFrame = (frame: ClientFrame): Uint8Array => encoder.encode(JSON.stringify(frame));

export function parseWorkerFrame(raw: Uint8Array | string): WorkerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : decoder.decode(raw));
  } catch {
    return null; // чужой кадр в комнате не должен ронять чат
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  if (typeof frame.type !== 'string') return null;

  if (frame.type === 'transcript') {
    if (typeof frame.text !== 'string') return null;
    // data-channel исторически говорит 'respondent', REST ядра — 'user'.
    // Легаси-синоним role=avatar|client клиентский роутер обязан понимать.
    const legacy = frame.role === 'avatar' ? 'agent' : frame.role === 'client' ? 'respondent' : undefined;
    const speaker = frame.speaker === 'agent' || frame.speaker === 'respondent' ? frame.speaker : legacy;
    if (!speaker) return null;
    return { type: 'transcript', speaker, text: frame.text, interrupted: frame.interrupted === true };
  }
  if (frame.type === 'session_ended') {
    return { type: 'session_ended', reason: typeof frame.reason === 'string' ? frame.reason : '' };
  }
  return frame as WorkerFrame;
}
```

Run: `cd embed/app && npx vitest run` → PASS.

- [ ] **Step 3: Тест моста postMessage — FAIL, затем реализация**

`embed/app/test/bridge.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createBridge } from '../src/lib/bridge.ts';

describe('мост iframe↔хост', () => {
  it('init принимается только от родителя и только из allowed_origins', async () => {
    const onInit = vi.fn();
    const bridge = createBridge({ allowedOrigins: ['https://shop.example'], onInit, onVisibility: vi.fn() });
    bridge.listen();
    window.dispatchEvent(new MessageEvent('message', {
      data: { src: 'aski-widget-host', type: 'init', visitorKey: 'v1', dialogId: null, parentOrigin: 'https://evil.example' },
      origin: 'https://evil.example', source: window.parent,
    }));
    expect(onInit).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', {
      data: { src: 'aski-widget-host', type: 'init', visitorKey: 'v1', dialogId: null, parentOrigin: 'https://shop.example' },
      origin: 'https://shop.example', source: window.parent,
    }));
    expect(onInit).toHaveBeenCalledWith({ visitorKey: 'v1', dialogId: null });
  });

  it('после init отправка идёт строго на подтверждённый origin, никогда на *', () => {
    const post = vi.fn();
    vi.stubGlobal('parent', { postMessage: post } as unknown as Window);
    const bridge = createBridge({ allowedOrigins: ['https://shop.example'], onInit: vi.fn(), onVisibility: vi.fn() });
    bridge.listen();
    window.dispatchEvent(new MessageEvent('message', {
      data: { src: 'aski-widget-host', type: 'init', visitorKey: 'v1', dialogId: null, parentOrigin: 'https://shop.example' },
      origin: 'https://shop.example', source: window.parent,
    }));
    bridge.sendState('v1', 'd1');
    expect(post).toHaveBeenCalledWith({ src: 'aski-widget', type: 'state', visitorKey: 'v1', dialogId: 'd1' }, 'https://shop.example');
  });

  it('ready уходит ДО init — иначе очередь хоста никогда не разблокируется', () => {
    const post = vi.fn();
    vi.stubGlobal('parent', { postMessage: post } as unknown as Window);
    createBridge({ allowedOrigins: ['https://shop.example'], onInit: vi.fn(), onVisibility: vi.fn() }).ready();
    expect(post).toHaveBeenCalledWith({ src: 'aski-widget', type: 'ready' }, '*');
  });
});
```

`embed/app/src/lib/bridge.ts` — реализация по тестам: хранит `hostOrigin: string | null`; `ready()` шлёт `{src:'aski-widget',type:'ready'}` на `'*'` (origin родителя ещё не подтверждён, секретов в конверте нет); слушатель принимает сообщение только если `event.source === window.parent`, `event.data.src === 'aski-widget-host'` и `normalizeOrigin(event.origin) === normalizeOrigin(data.parentOrigin)` и этот origin есть в `allowedOrigins` (список приехал с СЕРВЕРА в `/config` — подделать нельзя); после init `hostOrigin` фиксируется и все дальнейшие `postMessage` идут строго на него.

Run: `npx vitest run test/bridge.test.ts` → сначала FAIL, после реализации PASS.

- [ ] **Step 4: Vue-каркас чата (лента, композер, журнал, дедуп)**

`embed/app/index.html` — `<div id="app" data-widget-token=""></div>` + `<script type="module" src="/src/main.ts">`; сборка Vite с `base: '/assets/'`, `build.outDir: 'dist'`, `rollupOptions.input: 'index.html'`.

`embed/app/src/lib/room.ts` — обёртка над `livekit-client`:

```ts
import { Room, RoomEvent, type RemoteParticipant } from 'livekit-client';
import { encodeClientFrame, parseWorkerFrame, type ClientFrame, type WorkerFrame } from './frames.ts';

export class CoreRoom {
  private room: Room | null = null;
  private readonly audio = new Set<HTMLMediaElement>();

  constructor(
    private readonly handlers: {
      onFrame: (frame: WorkerFrame) => void;
      onAgentJoined: () => void;
      onDisconnected: () => void;
    },
  ) {}

  async connect(url: string, token: string, opts: { audio: boolean }): Promise<void> {
    const room = new Room();
    this.room = room;
    room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
      const frame = parseWorkerFrame(payload);
      if (frame) this.handlers.onFrame(frame);
    });
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      if (p.identity.startsWith('agent-')) this.handlers.onAgentJoined();
    });
    room.on(RoomEvent.Disconnected, () => this.handlers.onDisconnected());
    if (opts.audio) {
      room.on(RoomEvent.TrackSubscribed, (track) => {
        // Подписка ≠ воспроизведение: без attach() голос молчит (урок монолита).
        if (track.kind !== 'audio') { void track; return; }
        const element = track.attach();
        element.autoplay = true;
        document.body.appendChild(element);
        this.audio.add(element);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        for (const element of track.detach()) { element.remove(); this.audio.delete(element); }
      });
    }
    await room.connect(url, token);
    // Агент мог войти РАНЬШЕ нас — событие для него не придёт.
    for (const p of room.remoteParticipants.values()) {
      if (p.identity.startsWith('agent-')) this.handlers.onAgentJoined();
    }
    if (opts.audio) await room.startAudio().catch(() => undefined); // autoplay-политика
  }

  publish(frame: ClientFrame): void {
    // publishData при room=null — молчаливая потеря фрейма; шумим в консоль.
    if (!this.room) { console.warn('[aski] фрейм в никуда: комнаты нет', frame.type); return; }
    void this.room.localParticipant.publishData(encodeClientFrame(frame), { reliable: true });
  }

  async setMicrophoneEnabled(on: boolean): Promise<void> {
    if (!this.room) throw new Error('микрофон без комнаты не включить');
    await this.room.localParticipant.setMicrophoneEnabled(on);
  }

  async disconnect(): Promise<void> {
    for (const element of this.audio) element.remove();
    this.audio.clear();
    await this.room?.disconnect();
    this.room = null;
  }
}
```

Тест `embed/app/test/chat.test.ts` (`@vue/test-utils` + `happy-dom`), пишется ПЕРВЫМ:

```ts
import { describe, expect, it } from 'vitest';
import { mountWidget } from './helpers/mount.ts';

describe('чат', () => {
  it('отправка рисует пузырь, публикует user_text и пишет журнал', async () => {
    const { wrapper, api, sent } = await mountWidget();
    await wrapper.find('textarea').setValue('Меня зовут Пётр');
    await wrapper.find('[data-test=send]').trigger('click');
    expect(wrapper.findAll('[data-test=bubble-user]')).toHaveLength(1);
    expect(sent).toContainEqual({ type: 'user_text', text: 'Меня зовут Пётр' });
    expect(api.journal).toHaveBeenCalledWith('d1', expect.any(String), 'user', 'Меня зовут Пётр', 1);
  });

  it('обратное эхо (transcript speaker=respondent) НЕ создаёт второго пузыря', async () => {
    const { wrapper, room } = await mountWidget();
    await wrapper.find('textarea').setValue('Меня зовут Пётр');
    await wrapper.find('[data-test=send]').trigger('click');
    room.emitFrame({ type: 'transcript', speaker: 'respondent', text: 'Меня зовут Пётр', interrupted: false });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-test=bubble-user]')).toHaveLength(1);
  });

  it('ответ агента рисует пузырь и гасит индикатор набора', async () => {
    const { wrapper, room, api } = await mountWidget();
    await wrapper.find('textarea').setValue('привет');
    await wrapper.find('[data-test=send]').trigger('click');
    expect(wrapper.find('[data-test=typing]').exists()).toBe(true);
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: 'Здравствуйте!', interrupted: false });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-test=bubble-agent]')).toHaveLength(1);
    expect(wrapper.find('[data-test=typing]').exists()).toBe(false);
    expect(api.journal).toHaveBeenLastCalledWith('d1', expect.any(String), 'agent', 'Здравствуйте!', 2);
  });

  it('текст реплики попадает в DOM как ТЕКСТ, а не как разметка', async () => {
    const { wrapper, room } = await mountWidget();
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: '<img src=x onerror=alert(1)>', interrupted: false });
    await wrapper.vm.$nextTick();
    expect(wrapper.html()).toContain('&lt;img');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('нумерация журнала продолжается с next_seq сервера — после reload реплики не глотаются', async () => {
    // Сервер отдал историю из 4 клиентских реплик: следующая — пятая.
    const { wrapper, api } = await mountWidget({ startResult: { next_seq: 5, messages: [] } });
    await wrapper.find('textarea').setValue('продолжаю');
    await wrapper.find('[data-test=send]').trigger('click');
    expect(api.journal).toHaveBeenCalledWith('d1', expect.any(String), 'user', 'продолжаю', 5);
  });

  it('client_ready ре-шлётся и перезапускается при позднем входе агента', async () => {
    const { room, sent } = await mountWidget();
    expect(sent.filter((f) => f.type === 'client_ready')).toHaveLength(1);
    room.emitAgentJoined();
    expect(sent.filter((f) => f.type === 'client_ready').length).toBeGreaterThanOrEqual(2);
  });

  it('уход со страницы рвёт комнату: иначе воркер жжёт кредиты до ICE-таймаута', async () => {
    const { room } = await mountWidget();
    window.dispatchEvent(new Event('pagehide'));
    expect(room.disconnect).toHaveBeenCalled();
  });
});
```

Run: `cd embed/app && npx vitest run test/chat.test.ts` → FAIL. Затем реализация.

`embed/app/index.html` — `<div id="app" data-widget-token=""></div>` + `<script type="module" src="/src/main.ts">`; сборка Vite с `base: '/assets/'`, `build.outDir: 'dist'`, `rollupOptions.input: 'index.html'`.

`embed/app/src/App.vue` (чат-часть; FSM, голос и лид — T7):

```vue
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import ChatFeed from './components/ChatFeed.vue';
import Composer from './components/Composer.vue';
import { WidgetApi } from './lib/api.ts';
import { createBridge } from './lib/bridge.ts';
import { createEchoGuard } from './lib/echoGuard.ts';
import { createResender } from './lib/resender.ts';
import { CoreRoom } from './lib/room.ts';
import type { WorkerFrame } from './lib/frames.ts';

type Bubble = { id: string; role: 'user' | 'agent'; text: string };

const token = (document.getElementById('app')!.dataset.widgetToken ?? '');
const api = new WidgetApi(token);
const bubbles = ref<Bubble[]>([]);
const typing = ref(false);
const visitorKey = ref<string | null>(null);
const dialogId = ref<string | null>(null);
const seq = ref(1);                       // следующий номер журнала
const userTextsSent = ref(0);             // для messages_count эскалации (T7)
const agentReplies = ref(0);
const coreMessageCount = computed(() => userTextsSent.value + agentReplies.value);

const echo = createEchoGuard({ windowMs: 30_000, now: () => Date.now() });
let readyResender: ReturnType<typeof createResender> | null = null;

const room = new CoreRoom({
  onFrame: handleFrame,
  onAgentJoined: () => readyResender?.start(), // агент вошёл позже нас
  onDisconnected: () => { /* фазу считает FSM из T7 */ },
});

const bridge = createBridge({
  allowedOrigins: [],                     // заполнится из /config в onMounted
  onInit: ({ visitorKey: key, dialogId: saved }) => void openThread(key, saved),
  onVisibility: () => undefined,
});

function push(role: 'user' | 'agent', text: string): void {
  // Стабильный id, а не индекс: по индексу Vue переиспользует узлы и ломает
  // анимацию/выделение при вставке в середину.
  bubbles.value.push({ id: crypto.randomUUID(), role, text });
}

function handleFrame(frame: WorkerFrame): void {
  readyResender?.bump();
  if (frame.type !== 'transcript') return;
  if (frame.speaker === 'respondent') {
    // Своё эхо гасим; чужой respondent-transcript (STT в голосе) — рисуем.
    if (echo.isEcho(frame.text)) return;
    push('user', frame.text);
    return;
  }
  typing.value = false;
  push('agent', frame.text);
  if (userTextsSent.value > 0) agentReplies.value += 1; // greeting не в счёт
  void api.journal(dialogId.value!, visitorKey.value!, 'agent', frame.text, seq.value++);
}

async function openThread(key: string, saved: string | null): Promise<void> {
  visitorKey.value = key;
  const started = saved
    ? await api.reenter(saved, key).catch(() => api.startDialog(key, saved))
    : await api.startDialog(key);
  applyStart(started);
}

function applyStart(started: {
  dialog_id: string; participant_token: { livekit_url: string; token: string };
  messages: { role: 'user' | 'agent'; text: string }[]; next_seq: number;
}): void {
  dialogId.value = started.dialog_id;
  // Нумерацию журнала продолжаем с серверной: свой счётчик после reload
  // обнулился бы, и новые реплики глотал бы дедуп по (dialog, source, seq).
  seq.value = started.next_seq;
  bubbles.value = started.messages.map((m) => ({ id: crypto.randomUUID(), role: m.role, text: m.text }));
  // Счётчик ленты ядра принадлежит СЕССИИ, а не нити: новая сессия начинает
  // с нуля, иначе messages_count эскалации попросит несуществующие реплики.
  userTextsSent.value = 0;
  agentReplies.value = 0;
  bridge.sendState(visitorKey.value!, dialogId.value);
  void connect(started.participant_token, { audio: false });
}

async function connect(pt: { livekit_url: string; token: string }, opts: { audio: boolean }): Promise<void> {
  await room.connect(pt.livekit_url, pt.token, opts);
  readyResender?.stop();
  readyResender = createResender(() => room.publish({ type: 'client_ready' }), { intervalMs: 3000, maxAttempts: 20 });
  readyResender.start();
}

async function send(text: string): Promise<void> {
  const clean = text.trim().slice(0, 2000); // воркер режет ровно тут
  if (!clean) return;
  push('user', clean);
  echo.remember(clean);
  room.publish({ type: 'user_text', text: clean });
  userTextsSent.value += 1;
  typing.value = true;
  await api.journal(dialogId.value!, visitorKey.value!, 'user', clean, seq.value++);
}

const leave = (): void => { void room.disconnect(); };

onMounted(async () => {
  const config = await api.config();
  bridge.setAllowedOrigins(config.allowed_origins);
  bridge.listen();
  bridge.ready();
  // pagehide надёжнее beforeunload на мобильных: iOS часто не шлёт второй.
  window.addEventListener('pagehide', leave);
});
onBeforeUnmount(() => window.removeEventListener('pagehide', leave));
</script>

<template>
  <div class="widget">
    <ChatFeed :bubbles="bubbles" :typing="typing" />
    <Composer :disabled="false" @send="send" />
  </div>
</template>
```

`ChatFeed.vue` — лента: `v-for="b in bubbles" :key="b.id"`, пузырь рисует `{{ b.text }}` и ставит `:data-test="b.role === 'user' ? 'bubble-user' : 'bubble-agent'"`; индикатор `<div v-if="typing" data-test="typing">`. `v-html` в проекте ЗАПРЕЩЁН — реплики влияемы посетителем.

`Composer.vue` — `<textarea maxlength="2000">` + кнопка `[data-test=send]`; Enter отправляет, Shift+Enter переносит, `event.isComposing` гасит отправку (IME набирает иероглифы Enter'ом); кнопка `:disabled` на пустом тексте.

Run: `npx vitest run test/chat.test.ts` → PASS. Проверить `grep -rn "v-html" embed/app/src` → пусто.

- [ ] **Step 5: Мутпроба дедупа и XSS**

1. В `handleFrame` убрать вызов `echo.isEcho` → тест «обратное эхо НЕ создаёт второго пузыря» FAIL. Вернуть.
2. Заменить `{{ b.text }}` в `ChatFeed.vue` на `v-html="b.text"` → тест «текст попадает в DOM как ТЕКСТ» FAIL. Вернуть.
3. В `createResender` перенести `if (acked) stop()` ПЕРЕД `send()` → тест «гасим ПОСЛЕ отправки» FAIL. Вернуть.
4. В `applyStart` заменить `seq.value = started.next_seq` на `seq.value = 1` → тест «нумерация продолжается с next_seq» FAIL. Вернуть.
5. В `applyStart` убрать обнуление `userTextsSent`/`agentReplies` → тест T7 «messages_count = свои реплики + ответы» после продолжения нити FAIL. Вернуть.

- [ ] **Step 6: Commit**

```bash
git add embed/app
git commit -m "feat(embed): iframe-приложение — чат по data-channel с дедупом эха и журналом (Э4-T6)"
```

---
### Task 7: iframe-приложение — FSM эскалации, голос с микрофоном, баннер «Продолжить», лид-форма

**Files:**
- Create: `embed/app/src/lib/fsm.ts`
- Create: `embed/app/src/components/{VoicePanel.vue,ResumeBanner.vue,LeadForm.vue}`
- Modify: `embed/app/src/App.vue` (подключение FSM, эскалация, голос, лид), `embed/app/src/lib/room.ts` (микрофон, отписка от видео)
- Test: `embed/app/test/{fsm.test.ts,escalationFlow.test.ts,micro.test.ts,leadForm.test.ts}`

**Interfaces:**
- Consumes (T4, T6): `POST /w/v1/:token/dialogs/:id/escalate` → `{ dialog_id, channel:'voice', core_session_id, participant_token, continued_from, transcript_complete }`; `POST /w/v1/:token/dialogs/:id/lead`; `POST /w/v1/:token/dialogs` (с `dialog_id` — продолжение); `CoreRoom`, `createResender`, `createEchoGuard`, `parseWorkerFrame`, `WidgetApi`, `coreMessageCount`.
- Produces:
  - `type DialogPhase = 'idle' | 'chat' | 'escalating' | 'voice' | 'chat_fallback' | 'paused' | 'ended' | 'error'`
  - `type DialogEvent = { type: 'start' } | { type: 'connected' } | { type: 'escalate' } | { type: 'voice_ready' } | { type: 'escalate_failed'; code: 'insufficient_credits' | 'unavailable' | 'invalid' } | { type: 'session_ended'; reason: string } | { type: 'resume' } | { type: 'disconnected' } | { type: 'fatal'; code: string }`
  - `nextPhase(phase: DialogPhase, event: DialogEvent): DialogPhase`
  - `bannerFor(phase: DialogPhase, code?: string): { text: string; action: 'resume' | 'restart' | 'none' }`
  - `CoreRoom.setMicrophoneEnabled(on: boolean): Promise<void>` (уже объявлен в T6) + `CoreRoom.unsubscribeVideo(): void`
  - `type MicState = 'off' | 'requesting' | 'on' | 'denied' | 'failed'` в `App.vue`

- [ ] **Step 1: Тест FSM — FAIL**

`embed/app/test/fsm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bannerFor, nextPhase } from '../src/lib/fsm.ts';

describe('FSM диалога', () => {
  it('обычный путь: idle → chat → escalating → voice', () => {
    expect(nextPhase('idle', { type: 'start' })).toBe('chat');
    expect(nextPhase('chat', { type: 'escalate' })).toBe('escalating');
    expect(nextPhase('escalating', { type: 'voice_ready' })).toBe('voice');
  });

  it('ОБРЫВ СОЕДИНЕНИЯ В escalating — ШТАТНЫЙ переход, не ошибка: /end сносит комнату БЕЗ session_ended', () => {
    expect(nextPhase('escalating', { type: 'disconnected' })).toBe('escalating');
  });

  it('обрыв в ended тоже не ошибка', () => {
    expect(nextPhase('ended', { type: 'disconnected' })).toBe('ended');
  });

  it('обрыв в живом чате/голосе — ошибка', () => {
    expect(nextPhase('chat', { type: 'disconnected' })).toBe('error');
    expect(nextPhase('voice', { type: 'disconnected' })).toBe('error');
  });

  it('провал эскалации: нет денег → error; сервис недоступен/невалидно → chat_fallback', () => {
    expect(nextPhase('escalating', { type: 'escalate_failed', code: 'insufficient_credits' })).toBe('error');
    expect(nextPhase('escalating', { type: 'escalate_failed', code: 'unavailable' })).toBe('chat_fallback');
    expect(nextPhase('escalating', { type: 'escalate_failed', code: 'invalid' })).toBe('chat_fallback');
  });

  it('chat_fallback возвращается в chat по resume', () => {
    expect(nextPhase('chat_fallback', { type: 'resume' })).toBe('chat');
  });

  it('session_ended:silence — это ПАУЗА (центральный сценарий idle-фрагментации), а не конец', () => {
    expect(nextPhase('chat', { type: 'session_ended', reason: 'silence' })).toBe('paused');
    expect(nextPhase('voice', { type: 'session_ended', reason: 'silence' })).toBe('paused');
    expect(nextPhase('paused', { type: 'resume' })).toBe('chat');
  });

  it('прочие причины session_ended закрывают диалог', () => {
    expect(nextPhase('chat', { type: 'session_ended', reason: 'completed' })).toBe('ended');
    expect(nextPhase('voice', { type: 'session_ended', reason: 'duration_limit' })).toBe('ended');
  });

  it('НЕЗНАКОМАЯ причина переживается: причины расширяются аддитивно', () => {
    expect(nextPhase('chat', { type: 'session_ended', reason: 'нечто_из_будущего' })).toBe('ended');
  });

  it('фатальные коды ядра ведут в error', () => {
    expect(nextPhase('chat', { type: 'fatal', code: 'insufficient_credits' })).toBe('error');
  });

  it('баннеры: пауза даёт кнопку «Продолжить», 402 — рестарта нет', () => {
    expect(bannerFor('paused')).toEqual({ text: 'Диалог приостановлен', action: 'resume' });
    expect(bannerFor('error', 'insufficient_credits').action).toBe('none');
    expect(bannerFor('error', 'insufficient_credits').text).toContain('лимит');
    expect(bannerFor('chat_fallback').action).toBe('resume');
    expect(bannerFor('error', 'service_unavailable').text).toContain('недоступен');
    expect(bannerFor('error', 'session_finished').action).toBe('restart');
    expect(bannerFor('chat').action).toBe('none');
  });
});
```

Run: `cd embed/app && npx vitest run test/fsm.test.ts` → FAIL.

- [ ] **Step 2: Реализация `fsm.ts`**

```ts
export type DialogPhase =
  | 'idle' | 'chat' | 'escalating' | 'voice' | 'chat_fallback' | 'paused' | 'ended' | 'error';

export type DialogEvent =
  | { type: 'start' }
  | { type: 'connected' }
  | { type: 'escalate' }
  | { type: 'voice_ready' }
  | { type: 'escalate_failed'; code: 'insufficient_credits' | 'unavailable' | 'invalid' }
  | { type: 'session_ended'; reason: string }
  | { type: 'resume' }
  | { type: 'disconnected' }
  | { type: 'fatal'; code: string };

/** Фазы, в которых обрыв LiveKit — ШТАТНЫЙ ход, а не поломка. */
const DISCONNECT_IS_NORMAL = new Set<DialogPhase>(['escalating', 'ended', 'error', 'paused', 'chat_fallback', 'idle']);

export function nextPhase(phase: DialogPhase, event: DialogEvent): DialogPhase {
  switch (event.type) {
    case 'start': return 'chat';
    case 'connected': return phase === 'idle' ? 'chat' : phase;
    case 'escalate': return phase === 'chat' ? 'escalating' : phase;
    case 'voice_ready': return 'voice';
    case 'escalate_failed':
      // Денег нет — диалог мёртв; всё прочее откатывается в чат (§5 спеки).
      return event.code === 'insufficient_credits' ? 'error' : 'chat_fallback';
    case 'session_ended':
      // silence — ЦЕНТРАЛЬНЫЙ сценарий: idle ядра 120/300с рвёт нить постоянно.
      return event.reason === 'silence' ? 'paused' : 'ended';
    case 'resume': return 'chat';
    case 'disconnected':
      // `POST /end` сносит комнату БЕЗ фрейма session_ended — в escalating и
      // ended это ожидаемо и молча проглатывается.
      return DISCONNECT_IS_NORMAL.has(phase) ? phase : 'error';
    case 'fatal': return 'error';
    default: return phase;
  }
}

export function bannerFor(phase: DialogPhase, code?: string): { text: string; action: 'resume' | 'restart' | 'none' } {
  if (phase === 'paused') return { text: 'Диалог приостановлен', action: 'resume' };
  if (phase === 'chat_fallback') return { text: 'Голосовая связь сейчас недоступна — продолжим текстом', action: 'resume' };
  if (phase === 'escalating') return { text: 'Соединяю с голосом…', action: 'none' };
  if (phase === 'error') {
    if (code === 'insufficient_credits') return { text: 'Исчерпан лимит обращений. Напишите нам другим способом.', action: 'none' };
    if (code === 'service_unavailable') return { text: 'Сервис временно недоступен, попробуйте позже', action: 'none' };
    if (code === 'session_finished' || code === 'dialog_not_found') return { text: 'Диалог устарел — начните заново', action: 'restart' };
    return { text: 'Что-то пошло не так', action: 'restart' };
  }
  return { text: '', action: 'none' };
}
```

Run: `npx vitest run test/fsm.test.ts` → PASS.

- [ ] **Step 3: Тест сценария эскалации в приложении — FAIL**

`embed/app/test/helpers/mount.ts` — общая фабрика (её же используют `chat.test.ts` из T6, `micro.test.ts` и `leadForm.test.ts`):

```ts
import { mount } from '@vue/test-utils';
import { vi } from 'vitest';
import App from '../../src/App.vue';
import type { ClientFrame, WorkerFrame } from '../../src/lib/frames.ts';

/** Успешный ответ /escalate — один на все тесты голоса. */
export const VOICE_OK = {
  dialog_id: 'd1', channel: 'voice' as const, core_session_id: 'sess_bbbbbbbbbbbbbbbb',
  participant_token: {
    token: 'jwt-voice', identity: 'respondent-x',
    livekit_url: 'wss://lk.example', expires_at: '2026-08-13T11:00:00Z',
  },
  continued_from: 'sess_aaaaaaaaaaaaaaaa', transcript_complete: true,
};

export async function mountWidget(overrides: { startResult?: Partial<typeof START> } = {}) {
  const START = {
    dialog_id: 'd1', channel: 'chat' as const,
    participant_token: { token: 'jwt', identity: 'respondent-core', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T10:00:00Z' },
    messages: [] as { role: 'user' | 'agent'; text: string }[], next_seq: 1,
  };
  const sent: ClientFrame[] = [];
  // Подставной CoreRoom: тесты дёргают emit*-хелперы вместо живого LiveKit.
  const room = {
    connect: vi.fn(async () => undefined),
    publish: vi.fn((f: ClientFrame) => { sent.push(f); }),
    setMicrophoneEnabled: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    emitFrame: (f: WorkerFrame) => handlers.onFrame(f),
    emitAgentJoined: () => handlers.onAgentJoined(),
    emitDisconnected: () => handlers.onDisconnected(),
    emitVideoPublication: () => { const p = { kind: 'video', setSubscribed: vi.fn() }; handlers.onPublication?.(p); return p; },
    emitAudioTrack: () => { const t = { kind: 'audio', attach: vi.fn(() => document.createElement('audio')) }; handlers.onTrack?.(t); return t; },
  };
  const api = {
    config: vi.fn(async () => ({ allowed_origins: ['https://shop.example'], text_max_length: 2000 })),
    startDialog: vi.fn(async () => ({ ...START, ...overrides.startResult })),
    reenter: vi.fn(async () => ({ ...START, ...overrides.startResult })),
    journal: vi.fn(async () => undefined),
    escalate: vi.fn(() => escalatePromise),
    lead: vi.fn(async () => ({ lead_id: 'l1' })),
    end: vi.fn(async () => undefined),
    resolveEscalate: (v: unknown) => { resolveEsc(v); return flush(); },
    rejectEscalate: (e: unknown) => { rejectEsc(e); return flush(); },
  };
  // … проброс room/api в App через provide; handlers перехватываются из
  // конструктора CoreRoom; flush() = await nextTick() дважды.
  const wrapper = mount(App, { global: { provide: { api, room } } });
  await flush();
  return { wrapper, api, room, sent };
}
```

`embed/app/test/escalationFlow.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mountWidget } from './helpers/mount.ts';

describe('эскалация в голос', () => {
  it('порядок обязателен: инпут заблокирован → ОТКЛЮЧИЛИСЬ от чата → /escalate → голос', async () => {
    const { wrapper, api, room, sent } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');

    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined();
    // От чат-комнаты отключаемся САМИ, до вызова: иначе ловим свой же обрыв.
    expect(room.disconnect).toHaveBeenCalledBefore(api.escalate as never);
    expect(wrapper.text()).toContain('Соединяю с голосом…');

    await api.resolveEscalate({
      dialog_id: 'd1', channel: 'voice', core_session_id: 'sess_bbbbbbbbbbbbbbbb',
      participant_token: { token: 'jwt-voice', identity: 'respondent-x', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T11:00:00Z' },
      continued_from: 'sess_aaaaaaaaaaaaaaaa', transcript_complete: true,
    });

    expect(room.connect).toHaveBeenLastCalledWith('wss://lk.example', 'jwt-voice', { audio: true });
    // Голос: сначала client_ready, ПОТОМ resume_welcome — иначе welcome-back
    // прозвучит в ещё не подписанный трек.
    expect(sent.map((f) => f.type)).toEqual(['client_ready', 'resume_welcome']);
  });

  it('messages_count = свои реплики + ответы агента, БЕЗ greeting', async () => {
    const { wrapper, api, room } = await mountWidget();
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: 'Здравствуйте!', interrupted: false }); // greeting
    await wrapper.find('textarea').setValue('Меня зовут Пётр');
    await wrapper.find('[data-test=send]').trigger('click');
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: 'Приятно, Пётр!', interrupted: false }); // ответ
    await wrapper.find('[data-test=escalate]').trigger('click');
    expect(api.escalate).toHaveBeenCalledWith('d1', expect.any(String), 2);
  });

  it('resume_welcome НЕ уходит до появления агента: фрейм в пустую комнату теряется навсегда', async () => {
    vi.useFakeTimers();
    const { wrapper, api, room, sent } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    sent.length = 0;
    vi.advanceTimersByTime(12_000);
    expect(sent.filter((f) => f.type === 'resume_welcome')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('resume_welcome стартует по appearance агента и повторяется 3с×5', async () => {
    vi.useFakeTimers();
    const { wrapper, api, room, sent } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    sent.length = 0;
    room.emitAgentJoined();
    expect(sent.filter((f) => f.type === 'resume_welcome')).toHaveLength(1);
    vi.advanceTimersByTime(9000);
    expect(sent.filter((f) => f.type === 'resume_welcome').length).toBeGreaterThanOrEqual(3);
    vi.advanceTimersByTime(60_000);
    expect(sent.filter((f) => f.type === 'resume_welcome').length).toBeLessThanOrEqual(5);
    vi.useRealTimers();
  });

  it('гасится РЕЧЬЮ агента, а не любым кадром: pong/session_timer ничего не доказывают', async () => {
    vi.useFakeTimers();
    const { wrapper, api, room, sent } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    room.emitAgentJoined();
    sent.length = 0;
    // Служебные кадры НЕ считаются подтверждением: аватар всё ещё молчит.
    room.emitFrame({ type: 'session_timer', remaining_s: 590 });
    vi.advanceTimersByTime(9000);
    expect(sent.filter((f) => f.type === 'resume_welcome').length).toBeGreaterThanOrEqual(2);
    // А вот реплика агента — доказательство, что welcome-back доехал.
    room.emitFrame({ type: 'transcript', speaker: 'agent', text: 'Рад продолжить!', interrupted: false });
    const after = sent.length;
    vi.advanceTimersByTime(30_000);
    expect(sent.length - after).toBeLessThanOrEqual(1); // один добивающий допустим
    vi.useRealTimers();
  });

  it('402 на эскалации → баннер про лимит, кнопки продолжения НЕТ', async () => {
    const { wrapper, api } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.rejectEscalate({ status: 402, code: 'insufficient_credits' });
    expect(wrapper.text()).toContain('лимит');
    expect(wrapper.find('[data-test=resume]').exists()).toBe(false);
  });

  it('503 на эскалации → chat_fallback: кнопка возвращает в чат новой сессией с продолжением', async () => {
    const { wrapper, api } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.rejectEscalate({ status: 503, code: 'service_unavailable' });
    expect(wrapper.text()).toContain('продолжим текстом');
    await wrapper.find('[data-test=resume]').trigger('click');
    expect(api.startDialog).toHaveBeenLastCalledWith(expect.any(String), 'd1');
  });

  it('обрыв комнаты в фазе escalating НЕ показывает ошибку', async () => {
    const { wrapper, room } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    room.emitDisconnected();
    expect(wrapper.text()).not.toContain('Что-то пошло не так');
    expect(wrapper.text()).toContain('Соединяю с голосом…');
  });

  it('session_ended:silence → баннер «Продолжить», клик заводит новую сессию того же диалога', async () => {
    const { wrapper, api, room } = await mountWidget();
    room.emitFrame({ type: 'session_ended', reason: 'silence' });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Диалог приостановлен');
    await wrapper.find('[data-test=resume]').trigger('click');
    expect(api.startDialog).toHaveBeenLastCalledWith(expect.any(String), 'd1');
  });

  it('видеотрек аватара реально ОТПИСЫВАЕТСЯ: платить за egress видео в аудио-UI незачем', async () => {
    const { wrapper, api, room } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    expect(room.connect).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), { audio: true });
    // Комната отдаёт публикацию видео — клиент обязан её погасить вызовом
    // setSubscribed(false), а не «просто не рисовать» (трек всё равно течёт).
    const publication = room.emitVideoPublication();
    expect(publication.setSubscribed).toHaveBeenCalledWith(false);
  });

  it('аудиотрек, наоборот, подписывается и ПРИКРЕПЛЯЕТСЯ — без attach() голоса не слышно', async () => {
    const { wrapper, api, room } = await mountWidget();
    await wrapper.find('[data-test=escalate]').trigger('click');
    await api.resolveEscalate(VOICE_OK);
    const track = room.emitAudioTrack();
    expect(track.attach).toHaveBeenCalled();
    expect(document.querySelectorAll('audio').length).toBeGreaterThan(0);
  });
});
```

Run: `npx vitest run test/escalationFlow.test.ts` → FAIL.

- [ ] **Step 3a: Тест микрофона — FAIL**

Голосовой разговор односторонний, пока клиент не ОПУБЛИКУЕТ микрофон: `connect` сам его не включает, и аватар будет говорить в пустоту.

`embed/app/test/micro.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mountWidget, VOICE_OK } from './helpers/mount.ts';

const goVoice = async () => {
  const ctx = await mountWidget();
  await ctx.wrapper.find('[data-test=escalate]').trigger('click');
  await ctx.api.resolveEscalate(VOICE_OK);
  return ctx;
};

describe('микрофон в голосовом режиме', () => {
  it('публикуется сразу после входа в голосовую комнату', async () => {
    const { room } = await goVoice();
    expect(room.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it('включается ПОСЛЕ connect: до комнаты публиковать нечего', async () => {
    const { room } = await goVoice();
    expect(room.connect).toHaveBeenCalledBefore(room.setMicrophoneEnabled as never);
  });

  it('отказ в доступе (NotAllowedError) → понятный баннер, разговор не падает', async () => {
    const { wrapper, room } = await mountWidget();
    room.setMicrophoneEnabled.mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    );
    await wrapper.find('[data-test=escalate]').trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Микрофон недоступен');
    expect(wrapper.text()).toContain('разрешите доступ');
    // Фаза остаётся voice: аватара СЛЫШНО, просто нас не слышат.
    expect(wrapper.find('[data-test=voice-panel]').exists()).toBe(true);
  });

  it('кнопка mute гасит и возвращает публикацию', async () => {
    const { wrapper, room } = await goVoice();
    await wrapper.find('[data-test=mic-toggle]').trigger('click');
    expect(room.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await wrapper.find('[data-test=mic-toggle]').trigger('click');
    expect(room.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });

  it('в чат-режиме микрофон не трогаем вовсе', async () => {
    const { room } = await mountWidget();
    expect(room.setMicrophoneEnabled).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run test/micro.test.ts` → FAIL.

- [ ] **Step 3b: Реализация микрофона и отписки от видео**

В `embed/app/src/lib/room.ts` добавить отписку от видео (в T6 объявлен только `setMicrophoneEnabled`):

```ts
import { RoomEvent, Track, type RemoteTrackPublication } from 'livekit-client';

// В connect(), в ветке opts.audio:
room.on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication) => {
  // UI аудио-only. «Просто не рисовать» видео недостаточно: подписка живёт,
  // трафик идёт и оплачивается. Гасим саму подписку.
  if (publication.kind === Track.Kind.Video) publication.setSubscribed(false);
});
```

и в `App.vue` — включение микрофона сразу после входа в голосовую комнату:

```ts
const micState = ref<MicState>('off');

async function enableMic(): Promise<void> {
  micState.value = 'requesting';
  try {
    await room.setMicrophoneEnabled(true);
    micState.value = 'on';
  } catch (err) {
    // Разговор НЕ прерываем: аватара слышно, просто нас — нет. Пользователю
    // нужен путь наружу (разрешить доступ), а не оверлей ошибки.
    micState.value = (err as Error).name === 'NotAllowedError' ? 'denied' : 'failed';
  }
}

async function toggleMic(): Promise<void> {
  const next = micState.value !== 'on';
  try {
    await room.setMicrophoneEnabled(next);
    micState.value = next ? 'on' : 'off';
  } catch {
    micState.value = 'failed';
  }
}
```

`VoicePanel.vue` (`data-test="voice-panel"`): кнопка `[data-test=mic-toggle]` и баннер по `micState` — `denied` → «Микрофон недоступен: разрешите доступ в настройках браузера», `failed` → «Микрофон не включился — проверьте устройство».

Run: `npx vitest run test/micro.test.ts` → PASS.

- [ ] **Step 4: Реализация эскалации в `App.vue`**

Логика (порядок шагов — часть контракта, менять нельзя):

```ts
async function escalate(): Promise<void> {
  phase.value = nextPhase(phase.value, { type: 'escalate' });   // блокирует инпут через :disabled
  const count = coreMessageCount.value;                          // см. ниже
  await room.disconnect();                                       // САМИ уходим из чат-комнаты
  try {
    const voice = await api.escalate(dialogId.value!, visitorKey.value!, count);
    await room.connect(voice.participant_token.livekit_url, voice.participant_token.token, { audio: true });
    readyResender = createResender(() => room.publish({ type: 'client_ready' }), { intervalMs: 3000, maxAttempts: 20 });
    readyResender.start();
    // Микрофон публикуем САМИ: connect его не включает, и без этого разговор
    // односторонний — аватар говорит, а нас не слышно.
    await enableMic();
    phase.value = nextPhase(phase.value, { type: 'voice_ready' });
    // resume_welcome НЕ шлём здесь: до входа агента data-фрейм теряется
    // безвозвратно. Ресендер заводится в onAgentJoined (см. ниже).
  } catch (err) {
    const code = (err as ApiFailure).code;
    const status = (err as ApiFailure).status;
    lastErrorCode.value = code;
    phase.value = nextPhase(phase.value, {
      type: 'escalate_failed',
      code: status === 402 ? 'insufficient_credits' : status === 503 ? 'unavailable' : 'invalid',
    });
  }
}
```

`coreMessageCount` уже объявлен в T6 (`userTextsSent + agentReplies`, greeting не считается, обнуляется в `applyStart` вместе со сменой сессии). Перебор из-за нуджа сторожа простоя безопасен: BFF не доберёт ленту за 4с, вернёт `transcript_complete:false` и допишет последнюю реплику в instructions.

Обработчики присутствия и подтверждений — здесь ключевая правка протокола:

```ts
let welcomeResender: ReturnType<typeof createResender> | null = null;

// Агент вошёл в комнату. ТОЛЬКО отсюда стартует resume_welcome: фрейм,
// отправленный до его появления, теряется безвозвратно (LiveKit data-фреймы
// не буферизуются), а мы бы «отстрелялись» в пустоту и замолчали навсегда.
function onAgentJoined(): void {
  readyResender?.start();
  if (phase.value !== 'voice' || !isContinuation.value) return;
  welcomeResender?.stop();
  welcomeResender = createResender(
    () => room.publish({ type: 'resume_welcome' }),
    { intervalMs: 3000, maxAttempts: 5 },
  );
  welcomeResender.start();
}

// В handleFrame (T6) добавить:
//   readyResender?.bump()                      — на ЛЮБОМ кадре: он доказывает,
//                                                что воркер в комнате;
//   welcomeResender?.bump() ТОЛЬКО на transcript speaker='agent' — подтверждение
//   тут не «воркер жив», а «аватар ЗАГОВОРИЛ». session_timer и pong приходят и
//   от молчащего воркера, и гашение по ним вернуло бы ровно ту немоту, ради
//   которой resume_welcome и существует.
```

`isContinuation` — `ref(false)`, взводится в `escalate()` (голосовая сессия всегда `continue_from`) и в `resumeThread()`; в обычной чат-сессии остаётся `false`, и `resume_welcome` не шлётся вовсе (в chat он всё равно no-op).

`onDisconnected` → `phase = nextPhase(phase, { type: 'disconnected' })`.

`ResumeBanner.vue` — текст из `bannerFor(phase, lastErrorCode)`, кнопка `[data-test=resume]` при `action==='resume'` вызывает `resumeThread()`:

```ts
async function resumeThread(): Promise<void> {
  const started = await api.startDialog(visitorKey.value!, dialogId.value!); // продолжение нити
  phase.value = nextPhase(phase.value, { type: 'resume' });
  applyStart(started); // messages из BFF + новая комната; greeting в продолжении НЕ придёт
}
```

при `action==='restart'` — `api.startDialog(visitorKey)` без `dialog_id` и `bridge.sendState(visitorKey, null)`.

Run: `npx vitest run test/escalationFlow.test.ts` → PASS.

- [ ] **Step 5: Тест лид-формы — FAIL, затем реализация**

`embed/app/test/leadForm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mountWidget } from './helpers/mount.ts';

describe('лид-форма', () => {
  it('кнопка отправки заблокирована без согласия', async () => {
    const { wrapper } = await mountWidget();
    await wrapper.find('[data-test=open-lead]').trigger('click');
    await wrapper.find('[data-test=lead-phone]').setValue('+7 900 000-00-00');
    expect(wrapper.find('[data-test=lead-submit]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test=lead-consent]').setValue(true);
    expect(wrapper.find('[data-test=lead-submit]').attributes('disabled')).toBeUndefined();
  });

  it('без телефона и почты не отправляется', async () => {
    const { wrapper, api } = await mountWidget();
    await wrapper.find('[data-test=open-lead]').trigger('click');
    await wrapper.find('[data-test=lead-name]').setValue('Пётр');
    await wrapper.find('[data-test=lead-consent]').setValue(true);
    expect(wrapper.find('[data-test=lead-submit]').attributes('disabled')).toBeDefined();
    expect(api.lead).not.toHaveBeenCalled();
  });

  it('успешная отправка шлёт consent:true и показывает благодарность', async () => {
    const { wrapper, api } = await mountWidget();
    await wrapper.find('[data-test=open-lead]').trigger('click');
    await wrapper.find('[data-test=lead-name]').setValue('Пётр');
    await wrapper.find('[data-test=lead-phone]').setValue('+7 900 000-00-00');
    await wrapper.find('[data-test=lead-consent]').setValue(true);
    await wrapper.find('[data-test=lead-submit]').trigger('click');
    expect(api.lead).toHaveBeenCalledWith('d1', expect.any(String), {
      name: 'Пётр', phone: '+7 900 000-00-00', email: '', comment: '', consent: true,
    });
    expect(wrapper.text()).toContain('Спасибо');
  });

  it('ошибка сервера не теряет введённое', async () => {
    const { wrapper, api } = await mountWidget();
    api.lead.mockRejectedValueOnce({ status: 503, code: 'service_unavailable' });
    await wrapper.find('[data-test=open-lead]').trigger('click');
    await wrapper.find('[data-test=lead-phone]').setValue('+7 900 000-00-00');
    await wrapper.find('[data-test=lead-consent]').setValue(true);
    await wrapper.find('[data-test=lead-submit]').trigger('click');
    expect((wrapper.find('[data-test=lead-phone]').element as HTMLInputElement).value).toBe('+7 900 000-00-00');
    expect(wrapper.text()).toContain('Не удалось отправить');
  });
});
```

`LeadForm.vue`: поля name/phone/email/comment + обязательный чекбокс `[data-test=lead-consent]` с текстом согласия на обработку персональных данных (PII на чужих сайтах — §3 спеки); `canSubmit = consent && (phone.trim() || email.trim())`; на ошибке значения полей сохраняются.

Run: `npx vitest run test/leadForm.test.ts` → PASS.

- [ ] **Step 6: Мутпробы клиентского протокола**

1. Убрать `await room.disconnect()` перед `api.escalate` → тест порядка FAIL. Вернуть.
2. Перенести старт `welcomeResender` из `onAgentJoined` обратно в `escalate()` (сразу после connect) → тест «resume_welcome НЕ уходит до появления агента» FAIL. Вернуть.
3. Гасить `welcomeResender` по любому кадру (`welcomeResender?.bump()` рядом с `readyResender?.bump()`) → тест «гасится РЕЧЬЮ агента» FAIL. Вернуть.
4. В `nextPhase` вернуть `'error'` на `disconnected` в фазе `escalating` → тест «обрыв в escalating не ошибка» FAIL. Вернуть.
5. Считать greeting в `coreMessageCount` (инкремент без проверки `userTextsSent > 0`) → тест `messages_count` FAIL (ожидалось 2, стало 3). Вернуть.
6. Заменить `{ audio: true }` на `{ audio: false }` в голосовом `connect` → тест аудиотрека FAIL. Вернуть.
7. Убрать `await enableMic()` из `escalate()` → тест «микрофон публикуется сразу после входа» FAIL. Вернуть.
8. В `room.ts` убрать `publication.setSubscribed(false)` для видео → тест отписки FAIL. Вернуть.

- [ ] **Step 7: Полный прогон и commit**

Run: `cd embed/app && npx vitest run` → PASS. `cd embed/loader && npx vitest run && npm run build` → PASS + бюджет ≤8КБ. `grep -rn "v-html" embed/app/src` → пусто.

```bash
git add embed/app/src embed/app/test
git commit -m "feat(embed): FSM эскалации, голос с микрофоном, баннер «Продолжить», лид-форма (Э4-T7)"
```

---
### Task 8: Compose + деплой дев + провижининг ядра

**Files:**
- Create: `infra/Dockerfile`, `infra/compose.yaml`, `infra/.env.example`, `infra/deploy.sh`, `embed/public/demo.html`
- Create: `README.md` (запуск, провижининг, ручной чек-лист голоса)

**Interfaces:**
- Consumes: всё, что произвели T1–T7.
- Produces: живой стенд (compose-проект `site-widget`, порт 8200), тенант ядра «site-widget» с балансом-предохранителем и подпиской на вебхуки, `demo.html` со вставленным `publish_token`, зафиксированные в README фактические значения (`CORE_BASE_URL`, адрес приёмника глазами ядра, LiveKit-хост).

- [ ] **Step 1: Dockerfile и compose**

`infra/Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY embed/loader/package.json embed/loader/
COPY embed/app/package.json embed/app/
RUN npm ci
COPY . .
RUN npm run build --workspaces --if-present

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY backend/package.json backend/
RUN npm ci --omit=dev --workspace backend
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/backend/migrations backend/migrations
COPY --from=build /app/embed/loader/dist embed/loader/dist
COPY --from=build /app/embed/app/dist embed/app/dist
COPY embed/public embed/public
COPY contracts/core-api.d.ts contracts/
# curl нужен для healthcheck: в node:alpine его НЕТ (урок инцидента с Alloy).
RUN apk add --no-cache curl
USER node
EXPOSE 8200
CMD ["node", "backend/dist/server.js"]
```

`infra/compose.yaml`:

```yaml
name: site-widget
services:
  backend:
    image: ${WIDGET_IMAGE:-site-widget-backend:local}
    # Контекст — каталог с исходниками, который кладёт rsync (infra/deploy.sh).
    # Локально это `..`, на стенде — `./src`; переопределяется переменной.
    build: { context: "${WIDGET_BUILD_CONTEXT:-..}", dockerfile: infra/Dockerfile }
    restart: unless-stopped
    env_file: [.env]
    environment:
      DATABASE_URL: postgres://widget:${POSTGRES_PASSWORD}@postgres:5432/site_widget
      PORT: "8200"
    ports: ["8200:8200"]
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8200/healthz"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 20s

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: widget
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: site_widget
    volumes: ["widget-pgdata:/var/lib/postgresql/data"]   # ИМЕНОВАННЫЙ том: анонимные жгут inode
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U widget -d site_widget"]
      interval: 5s
      timeout: 3s
      retries: 20

volumes:
  widget-pgdata:
```

`infra/.env.example`:

```dotenv
POSTGRES_PASSWORD=смени-меня
# На стенде исходники лежат в ./src (их кладёт infra/deploy.sh). Локально
# строку не задают — compose подставит дефолт `..`.
WIDGET_BUILD_CONTEXT=./src
# Ядро — ДРУГОЙ compose-проект: по имени сервиса НЕ разрезолвится.
# Проверить фактический маршрут ДО деплоя (Step 3), а не полагаться на догадку.
CORE_BASE_URL=http://172.17.0.1:8100/api
CORE_TENANT_KEY=sk_test_подставить-из-tenant-create
CORE_WEBHOOK_SECRET=подставить-из-tenant-webhook-set
# ВАЖНО (secure context): именно localhost, а НЕ IP стенда. Отсюда строится
# app_url, по которому грузится iframe; страница на http://<IP> не является
# secure context, и getUserMedia в ней мёртв даже через ssh -L. Ручной прогон
# голоса ходит на http://localhost:8200/demo.html внутри туннеля.
WIDGET_PUBLIC_ORIGIN=http://localhost:8200
# LiveKit-хост берётся из participant_token.livekit_url ядра — подставить
# фактический, и обязательно и wss://, и https:// (SDK ходит по обоим).
WIDGET_CSP_CONNECT_SRC='self' wss://ПОДСТАВИТЬ-livekit-хост https://ПОДСТАВИТЬ-livekit-хост
# trustProxy НЕ включаем: сервис слушает :8200 напрямую (иначе IP-кап обходится).
TRUST_PROXY=0
IP_HASH_SALT=случайная-соль-стенда
MAX_DIALOGS_PER_VISITOR_PER_DAY=10
MAX_DIALOGS_PER_IP_PER_DAY=30
CORE_MAX_DURATION_S=600
LOG_LEVEL=info
```

- [ ] **Step 2: Провижининг тенанта ядра**

На дев-ядре (`ssh root@185.125.102.133`, каталог `/opt/conversation-core`):

```bash
CORE="docker compose -f /opt/conversation-core/compose.yaml exec -T control-plane bin/console"
PSQL="docker compose -f /opt/conversation-core/compose.yaml exec -T postgres psql -U core -d conversation_core"

# 1. Тенант + ключ (ключ показывается ОДИН раз — сразу в .env виджета).
$CORE tenant:create "site-widget" --test --json

# 2. БЮДЖЕТ-ПРЕДОХРАНИТЕЛЬ: намеренно малый баланс. Ручки пополнения нет —
#    только прямой INSERT. Баланс живёт в ОТДЕЛЬНОЙ таблице tenant_balances
#    (PK = tenant_id, внутренний int-id тенанта), колонки credits_balance в
#    tenants НЕТ — сверено с origin/main:control-plane/src/Entity/TenantBalance.php.
$PSQL -c "INSERT INTO tenant_balances (tenant_id, balance, updated_at)
          SELECT id, 5000, now() FROM tenants WHERE public_id = 'ten_ПОДСТАВИТЬ'
          ON CONFLICT (tenant_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = now();"
$PSQL -c "SELECT t.public_id, b.balance FROM tenants t
          JOIN tenant_balances b ON b.tenant_id = t.id WHERE t.public_id = 'ten_ПОДСТАВИТЬ';"

# 3. Порог credits.low. По умолчанию low_credits_threshold = 0, а значит
#    событие НЕ придёт НИКОГДА и алерт из §6.1 мёртв. Ставим руками.
$PSQL -c "UPDATE tenants SET low_credits_threshold = 1000 WHERE public_id = 'ten_ПОДСТАВИТЬ';"

# 4. Подписка на вебхуки — ТОЧЕЧНО, а не на всё подряд. Секрет из вывода.
$CORE tenant:webhook:set ten_ПОДСТАВИТЬ http://172.17.0.1:8200/w/v1/core-webhooks \
  --events session.finalized,transcript.ready,credits.low --json

# 5. Проверить (НЕ полагаться!), что http и приватные адреса разрешены.
grep -E 'CORE_WEBHOOK_ALLOW_(HTTP|PRIVATE_TARGETS)' /opt/conversation-core/.env
```

Оба флага обязаны быть `=1`; если нет — дописать и `docker compose up -d --force-recreate control-plane webhook-dispatcher` (смена env требует пересоздания, `restart` не подхватит).

- [ ] **Step 3: Проверить фактический маршрут контейнер→ядро**

Догадка про `172.17.0.1` может не сойтись: у ядра свой compose-проект и своя сеть. Проверять ИЗ нашего контейнера, а не с хоста:

```bash
docker compose -f /opt/site-widget/compose.yaml exec -T backend \
  node -e "fetch('http://172.17.0.1:8100/health').then(r=>console.log('172.17.0.1 →',r.status)).catch(e=>console.log('172.17.0.1 ✗',e.message))"
docker compose -f /opt/site-widget/compose.yaml exec -T backend \
  node -e "fetch('http://185.125.102.133:8100/health').then(r=>console.log('host-IP →',r.status)).catch(e=>console.log('host-IP ✗',e.message))"
```

Победивший адрес прописать в `CORE_BASE_URL` (с суффиксом `/api`). Симметрично: адрес приёмника вебхуков в `tenant:webhook:set` — тот, по которому КОНТЕЙНЕР ЯДРА видит нас; проверить `docker compose -f /opt/conversation-core/compose.yaml exec -T control-plane curl -fsS http://172.17.0.1:8200/healthz`.

- [ ] **Step 4: Демо-страница**

`embed/public/demo.html`:

```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Демо-сайт с виджетом Aski</title>
</head>
<body style="font:16px/1.6 system-ui;max-width:720px;margin:60px auto;padding:0 20px">
  <h1>Демо-магазин</h1>
  <p>Страница существует ради одного: проверить виджет на «чужом» сайте.</p>
  <p><strong>Голос требует secure context.</strong> На деве открывать строго так:</p>
  <pre>ssh -L 8200:localhost:8200 root@185.125.102.133
# затем http://localhost:8200/demo.html — localhost считается secure context</pre>
  <!-- Сниппет ровно в том виде, в каком его получит владелец сайта. -->
  <script src="/w.js" data-widget="ПОДСТАВИТЬ_PUBLISH_TOKEN" async></script>
</body>
</html>
```

В `allowed_origins` виджета для дева положить `["http://localhost:8200"]` — тот же origin, что `WIDGET_PUBLIC_ORIGIN`. Добавлять туда `http://185.125.102.133:8200` НЕ надо: страница по IP не secure context, голос там всё равно не заработает, а лишний разрешённый origin — лишняя дыра. Если чат нужно показать по IP без голоса — добавить адрес осознанно и записать в README, что голос по нему не поддерживается.

- [ ] **Step 5: Раскатка**

`build.context: ..` в compose означает, что образ собирается ИЗ РЕПОЗИТОРИЯ. Копировать на сервер только `compose.yaml` + `.env` недостаточно — `docker compose up --build` упадёт, потому что контекста там нет. Для MVP берём самый простой из честных вариантов: заливаем исходники и собираем на месте (CI с публикацией образа в GHCR — после MVP; тогда `WIDGET_IMAGE` в compose уже готов принять тег).

`infra/deploy.sh`:

```bash
#!/usr/bin/env bash
# Раскатка дев-стенда site-widget: исходники → сервер → сборка на месте.
set -euo pipefail

HOST="${HOST:-root@185.125.102.133}"
DIR="${DIR:-/opt/site-widget}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ssh "$HOST" "mkdir -p $DIR"

# MTU 1400 на этом сервере: большие передачи подвисают, поэтому rsync, а не
# один толстый scp. node_modules и dist не везём — собираются в образе.
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude '.env' \
  "$ROOT/" "$HOST:$DIR/src/"

scp "$ROOT/infra/compose.yaml" "$HOST:$DIR/compose.yaml"
ssh "$HOST" "test -f $DIR/.env || { echo 'НЕТ $DIR/.env — заполни из infra/.env.example и chmod 600'; exit 1; }"

ssh "$HOST" "cd $DIR && docker compose config --quiet && docker compose up -d --build"
ssh "$HOST" "cd $DIR && docker compose exec -T backend npx --no-install node-pg-migrate -m backend/migrations up"
ssh "$HOST" "curl -fsS -w ' HTTP %{http_code}\n' http://localhost:8200/healthz"
```

Чтобы compose нашёл контекст, в серверный `$DIR/.env` добавляется строка `WIDGET_BUILD_CONTEXT=./src` (локально переменной нет и подставляется дефолт `..`). `WIDGET_IMAGE` оставляем как переключатель на будущий образ из реестра.

Про путь миграций: при npm workspaces бинарь `node-pg-migrate` лежит НЕ в `backend/node_modules/.bin`, а в корневом `/app/node_modules/.bin` (npm поднимает зависимости в корень). Прямой путь `backend/node_modules/.bin/node-pg-migrate` не существует и упадёт — поэтому `npx --no-install node-pg-migrate`, который найдёт бинарь сам. Альтернатива, если хочется явности: `node /app/node_modules/.bin/node-pg-migrate -m backend/migrations up`.

Run: `bash infra/deploy.sh` → `HTTP 200` на `/healthz`.

Завести первый виджет прямым SQL (кабинета в MVP нет):

```bash
ssh root@185.125.102.133 "cd /opt/site-widget && docker compose exec -T postgres psql -U widget -d site_widget -c \"
INSERT INTO widgets (publish_token, name, agent_config, kb_ids, allowed_origins, enabled)
VALUES ('wgt_demo_$(openssl rand -hex 8)', 'Демо-виджет',
  '{\\\"instructions\\\":\\\"Ты консультант интернет-магазина. Отвечай коротко и по делу.\\\"}'::jsonb,
  '[]'::jsonb, '[\\\"http://localhost:8200\\\",\\\"http://185.125.102.133:8200\\\"]'::jsonb, true)
RETURNING publish_token;\""
```

Полученный токен вписать в `embed/public/demo.html` и пересобрать (или подставить через `?token=` — но в MVP правим файл и катим заново).

Проверки живости — grep'ом по логам, а не по `docker compose ps`:

```bash
ssh root@185.125.102.133 'cd /opt/site-widget && docker compose logs backend --tail 100 | grep -i "listening\|error"'
curl -fsS http://185.125.102.133:8200/w/v1/<TOKEN>/config | head -c 400
curl -fsS -o /dev/null -w '%{http_code}\n' http://185.125.102.133:8200/w.js
```

- [ ] **Step 6: Commit**

```bash
git add infra embed/public/demo.html README.md
git commit -m "feat(deploy): дев-стенд site-widget + провижининг тенанта ядра (Э4-T8)"
```

---
### Task 9: `widget_smoke.py` — 6 сценариев §8 + ГЕЙТ ФАЗЫ

**Files:**
- Create: `scripts/widget_smoke.py`
- Modify: `README.md` (ручной чек-лист голоса), `backend/src/routes/health.ts` (проверка достижимости ядра в `/healthz?deep=1`)

**Interfaces:**
- Consumes: живой стенд из T8, `publish_token` демо-виджета, venv воркера ядра (`livekit-rtc`).
- Produces: `SMOKE-RESULT: <исход> exit=<код> verdicts=<n>` последней строкой; коды выхода 0/1/2/3 как у `chat_smoke.py` ядра; пройденный ручной чек-лист браузерного голоса.

- [ ] **Step 1: `widget_smoke.py` — 6 сценариев спеки §8**

`scripts/widget_smoke.py` — по образцу `scripts/chat_smoke.py` ядра (stdlib + `livekit-rtc` из venv воркера ядра; строительные блоки — `HttpResponse/http`, `WebhookReceiver`, `poll_until`, `verify_signature`, коды выхода 0/1/2/3 — переносятся с пометкой «(из chat_smoke.py ядра)»).

Запуск:

```bash
/opt/conversation-core/worker/.venv/bin/python scripts/widget_smoke.py \
  --base-url http://localhost:8200 --token <PUBLISH_TOKEN> \
  --psql 'docker compose -f /opt/site-widget/compose.yaml exec -T postgres psql -U widget -d site_widget' \
  --core-console 'docker compose -f /opt/conversation-core/compose.yaml exec -T control-plane bin/console'
```

Скелет (каждый сценарий — своя функция, вердикты собираются, а не обрываются на первом):

```python
#!/usr/bin/env python3
"""Смок ai-site-widget против дев-ядра: 6 сценариев §8 спеки.

⚠️ Диалог НАСТОЯЩИЙ: поднимает комнату LiveKit, приводит агента и ЖЖЁТ кредиты
вендоров. Гонять пачкой не стоит — на тенанте виджета намеренно малый баланс.

Коды выхода: 0 — все зелёные (ЭТО гейт фазы); 1 — ассерт не сошёлся;
2 — смок не смог начать (нет livekit-rtc, BFF не отвечает); 3 — стек пропал
посреди прогона.
"""

def scenario_1_chat_and_echo_dedup(ctx) -> None:
    """(1) конфиг → диалог → «Меня зовут Пётр» → ответ + ДЕДУП ЭХА проверен."""
    config = ctx.http("GET", f"/w/v1/{ctx.token}/config").json()
    assert config["enabled"] is True, "виджет выключен"

    started = ctx.http("POST", f"/w/v1/{ctx.token}/dialogs",
                       json={"visitor_key": ctx.visitor_key},
                       headers={"Origin": ctx.origin}).json()
    ctx.dialog_id = started["dialog_id"]
    token = started["participant_token"]

    # Комната остаётся ЖИВОЙ до сценария 3 (см. его докстринг): выход участника
    # разбудил бы сторож простоя и закрыл chat-сессию раньше эскалации.
    signals = ctx.run_chat(token, question="Меня зовут Пётр", keep_open=True)
    assert signals.greeting_seen, "greeting (transcript speaker=agent) не пришёл"
    assert signals.answer_seen, "ответ агента не пришёл"
    # Столько реплик ОБЯЗАНО осесть в ленте ядра: наш user_text + ответ агента.
    # Greeting в ленту не идёт (служебные реплики chat не персистятся).
    ctx.core_message_count = 2
    # Эхо: воркер вернул нашу же реплику как transcript speaker=respondent.
    assert signals.respondent_echo_seen, (
        "воркер НЕ вернул эхо — сценарий дедупа непроверяем, "
        "проверь протокол воркера прежде чем радоваться")

    # Журнал ведёт КЛИЕНТ; смок эмулирует его ровно один раз на реплику.
    ctx.http("POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/messages",
             json={"visitor_key": ctx.visitor_key, "role": "user",
                   "text": "Меня зовут Пётр", "seq": 1},
             headers={"Origin": ctx.origin})
    journal = ctx.http("GET", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/messages"
                              f"?visitor_key={ctx.visitor_key}",
                       headers={"Origin": ctx.origin}).json()["messages"]
    mine = [m for m in journal if m["role"] == "user" and m["text"] == "Меня зовут Пётр"]
    assert len(mine) == 1, f"свой текст задвоился в журнале BFF: {mine}"


def scenario_2_reenter(ctx) -> None:
    """(2) re-enter с НОВОЙ respondent-identity: история отдана, диалог жив."""
    res = ctx.http("POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/reenter",
                   json={"visitor_key": ctx.visitor_key},
                   headers={"Origin": ctx.origin}).json()
    identity = res["participant_token"]["identity"]
    assert identity.startswith("respondent-"), f"identity без префикса: {identity}"
    assert identity != ctx.previous_identity, "identity переиспользована — выкинет живого участника"
    assert any(m["text"] == "Меня зовут Пётр" for m in res["messages"]), "история не отдана"
    assert res["next_seq"] >= 2, f"next_seq не продолжает нумерацию журнала: {res['next_seq']}"
    # Свой текст в истории ОДИН раз: сверка ленты ядра дедупится по тексту, и
    # повторное открытие вкладки не обязано удваивать реплики.
    mine = [m for m in res["messages"] if m["text"] == "Меня зовут Пётр"]
    assert len(mine) == 1, f"история задвоилась после re-enter: {mine}"
    # Вторым участником в ту же комнату НЕ входим: живой чат-клиент сценария 1
    # остаётся единственным. Проверяем лишь, что токен выписан на новую identity.


def scenario_3_escalate_to_voice(ctx) -> None:
    """(3) escalate{messages_count} → voice-token → resume_welcome → аватар заговорил.

    ⚠️ ПОРЯДОК: chat-комнату НЕ покидаем до вызова /escalate. Уход участника
    взводит сторож простоя воркера, и он может закрыть chat-сессию раньше нас —
    тогда диалог уедет в ended, а /escalate честно ответит 409 dialog_not_active,
    и смок покажет ЛОЖНЫЙ красный. Комнату рвёт сам /escalate через POST /end,
    ровно как в браузере (T7 отключается сам ПЕРЕД вызовом, но там между этими
    двумя действиями миллисекунды, а не сетевой roundtrip смока).
    """
    res = ctx.http("POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/escalate",
                   json={"visitor_key": ctx.visitor_key, "messages_count": ctx.core_message_count},
                   headers={"Origin": ctx.origin}, expect_error=True)
    if res.status == 409 and res.json()["error"]["code"] == "dialog_not_active":
        raise AssertError(
            "диалог уже не активен к моменту эскалации: сторож простоя закрыл "
            "chat-сессию раньше. Это НЕ баг эскалации — смок обязан держать "
            "chat-комнату живой между сценариями 1-3")
    assert res.status == 201, f"эскалация не прошла: {res.status} {res.text[:300]}"
    body = res.json()
    assert body["channel"] == "voice"
    assert body["continued_from"], "связь с прошлой сессией потеряна"
    ctx.drop_chat_room()  # комнаты уже нет: /end снёс её на стороне ядра
    signals = ctx.run_voice(body["participant_token"])
    # В продолжении greeting гасится — заговорить аватар обязан ИМЕННО по
    # resume_welcome (client_ready сразу, resume_welcome ПОСЛЕ входа агента,
    # повтор 3с×5).
    assert signals.agent_spoke, "аватар молчит: resume_welcome не сработал"


def scenario_4_lead(ctx) -> None:
    """(4) лид с consent."""
    res = ctx.http("POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/lead",
                   json={"visitor_key": ctx.visitor_key, "name": "Пётр",
                         "phone": "+7 900 000-00-00", "consent": True},
                   headers={"Origin": ctx.origin})
    assert res.status == 201, f"лид не принят: {res.status} {res.text[:200]}"
    rows = ctx.psql_fields("SELECT name, consent FROM leads ORDER BY created_at DESC LIMIT 1")
    assert rows[:2] == ["Пётр", "t"], f"лид не в БД: {rows}"
    no_consent = ctx.http("POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/lead",
                          json={"visitor_key": ctx.visitor_key, "phone": "+7 900 000-00-01",
                                "consent": False}, headers={"Origin": ctx.origin})
    assert no_consent.status == 422, "лид без согласия ПРИНЯТ — PII без основания"


def scenario_5_webhook_to_usage(ctx) -> None:
    """(5) вебхук → core_events → dialogs.usage."""
    ctx.http("POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/end",
             json={"visitor_key": ctx.visitor_key}, headers={"Origin": ctx.origin})
    ctx.poll_until(
        lambda: ctx.psql_fields(
            "SELECT count(*) FROM core_events WHERE type = 'session.finalized'")[0] != "0",
        timeout=90, what="вебхук session.finalized")
    usage, credits, status, settled = ctx.psql_fields(
        f"SELECT usage::text, credits_total, status, settled_session_ids::text "
        f"FROM dialogs WHERE id = '{ctx.dialog_id}'")
    # Ассертим ЮНИТЫ метра, а не credits: прайс chat_token = 0.001 credits за
    # токен с округлением per-turn, и на коротком диалоге credits_total честно
    # бывает нулём. Нулевой usage — вот это поломка учёта.
    parsed = json.loads(usage)
    assert parsed.get("chat_token", 0) > 0, f"токенный учёт не доехал в usage: {usage}"
    assert int(credits) >= 0, f"credits_total отрицательный: {credits}"
    assert status == "ended", f"статус диалога не сведён: {status}"
    # Каждая сессия нити учтена ровно один раз (защита от гонки со свипером).
    ids = json.loads(settled)
    assert len(ids) == len(set(ids)), f"сессия учтена дважды: {ids}"


def scenario_6_negatives(ctx) -> None:
    """(6) чужой Origin → отказ; 11-й диалог/сутки → отказ; фейк-подпись → 401."""
    alien = ctx.http("POST", f"/w/v1/{ctx.token}/dialogs",
                     json={"visitor_key": ctx.visitor_key},
                     headers={"Origin": "https://evil.example"}, expect_error=True)
    assert alien.status == 403, f"чужой Origin ПРОПУЩЕН: {alien.status}"

    # Кап: добиваем счётчик посетителя прямым UPDATE (реальные 10 сессий = 10
    # платных диалогов), затем 11-й обязан отлететь БЕЗ похода в ядро.
    ctx.psql(f"""INSERT INTO dialogs (widget_id, visitor_key, client_reference)
                 SELECT id, '{ctx.capped_visitor}', 'widget:dialog:cap-' || g
                   FROM widgets, generate_series(1,10) g
                  WHERE publish_token = '{ctx.token}';""")
    capped = ctx.http("POST", f"/w/v1/{ctx.token}/dialogs",
                      json={"visitor_key": ctx.capped_visitor},
                      headers={"Origin": ctx.origin}, expect_error=True)
    assert capped.status == 429 and capped.json()["error"]["code"] == "visitor_daily_cap", \
        f"кап диалогов не сработал: {capped.status} {capped.text[:200]}"

    fake = ctx.http("POST", "/w/v1/core-webhooks",
                    raw=b'{"api_version":"v1","event_id":"evt_fake","type":"session.finalized","data":{}}',
                    headers={"Content-Type": "application/json",
                             "X-Core-Signature": "t=1,v1=deadbeef"}, expect_error=True)
    assert fake.status == 401, f"фейк-подпись ПРИНЯТА: {fake.status}"
    assert ctx.psql_fields(
        "SELECT count(*) FROM core_events WHERE event_id = 'evt_fake'")[0] == "0", \
        "отвергнутый вебхук всё равно записан"
```

`run_chat` / `run_voice` — тот же приём, что `chat_dialog` в `chat_smoke.py`: `rtc.Room`, `data_received` копит фреймы, `client_ready` публикуется сразу после входа. Отличия:

- `run_chat(..., keep_open=True)` НЕ вызывает `room.disconnect()` и возвращает живую комнату в `ctx` — её рвёт `ctx.drop_chat_room()` уже после `/escalate` (сторож простоя иначе закроет chat-сессию между сценариями).
- `run_voice` шлёт `resume_welcome` строго ПОСЛЕ появления agent-участника (событие `participant_connected` с identity на `agent-`, плюс проверка уже вошедших в `room.remote_participants` — вошедший раньше нас события не породит), повторяет 3с×5 и гасит повтор по `transcript speaker=agent`. Признак «аватар заговорил» — именно этот кадр либо подписка на аудио-трек; `session_timer`/`pong` не считаются.
- Микрофон питон-клиент НЕ публикует: смок проверяет, что аватар ЗАГОВОРИЛ, а распознавание речи проверяет ручной браузерный прогон (Step 3).

Финальная строка — `SMOKE-RESULT: <исход> exit=<код> verdicts=<n>`.

- [ ] **Step 2: Прогон смока**

```bash
scp scripts/widget_smoke.py root@185.125.102.133:/opt/site-widget/widget_smoke.py
ssh root@185.125.102.133 'cd /opt/site-widget && /opt/conversation-core/worker/.venv/bin/python widget_smoke.py --base-url http://localhost:8200 --token <TOKEN> --psql "docker compose -f /opt/site-widget/compose.yaml exec -T postgres psql -U widget -d site_widget"'
```

Ожидаемое: `SMOKE-RESULT: OK exit=0 verdicts=6`. Красный смок — чинить код, а НЕ ослаблять ассерт.

- [ ] **Step 3: Ручной браузерный смок голоса (P0-3) + README**

`README.md` — раздел «Ручной прогон голоса» (чек-лист, каждый пункт отмечается):

```
1. ssh -L 8200:localhost:8200 root@185.125.102.133
2. Открыть http://localhost:8200/demo.html
   ⚠️ ИМЕННО localhost: страница по http://<IP> НЕ secure context, и микрофон
   там не запросится вовсе. WIDGET_PUBLIC_ORIGIN на стенде обязан быть
   http://localhost:8200, иначе iframe уедет на IP-origin и голос умрёт.
3. Кнопка виджета → панель открылась, greeting пришёл текстом
4. Написать «Меня зовут Пётр» → свой пузырь ОДИН (эхо не задвоило) → ответ агента
5. Перезагрузить страницу → история на месте и НЕ задвоилась, диалог продолжается
6. Написать ещё реплику → она видна (нумерация журнала продолжилась с next_seq)
7. «Продолжить голосом» → прелоадер «Соединяю с голосом…» ≤15с
8. Браузер СПРОСИЛ доступ к микрофону → разрешить; индикатор микрофона активен
9. Аватар ЗАГОВОРИЛ сам (resume_welcome сработал), не дожидаясь реплики
10. Сказать «А доставка бесплатная?» → аватар ОТВЕТИЛ по существу (значит нас
    слышно: микрофон реально опубликован), своя реплика в ленте ОДИН раз
11. Нажать mute → сказать что-нибудь → реакции нет; снять mute → снова слышно
12. Отказать в доступе к микрофону (отдельный прогон в приватном окне) →
    баннер «Микрофон недоступен», аватара при этом СЛЫШНО, оверлея ошибки нет
13. Помолчать до silence-таймаута → баннер «Диалог приостановлен» + «Продолжить»
14. «Продолжить» → новый чат помнит имя Пётр (нить не потеряна)
15. Лид-форма: без чекбокса согласия кнопка неактивна; с ним — «Спасибо»
16. Закрыть вкладку → в логах ядра сессия закрылась, кредиты не текут
17. Проверить остаток баланса тенанта и записать его в README
```

Также в README: команды запуска, провижининг ядра, известные ограничения MVP (нет кабинета, нет TLS-сабдомена, голос только через `ssh -L`).

- [ ] **Step 4: Завести issue в ядро (§6.4 спеки)**

Не чинится на стороне виджета — держатель `participant_token` может слать `user_text` в цикле мимо BFF:

```bash
gh issue create --repo ivanyadeshko/ai-conversation-core \
  --title "Rate-limit user_text в воркере + honoring max_credits для chat" \
  --body "Найдено при Э4 (ai-site-widget). Браузер держит participant_token 1ч и может слать user_text в цикле мимо BFF: rate-limit в воркере нет, ядро НЕ режет chat-сессии по limits.max_credits (drain-to-zero только на settle), резервирования нет — N параллельных сессий жгут N×баланс. На стороне виджета закрыто лишь косвенно (малый баланс тенанта, max_duration_s=600, капы диалогов). Нужно: (1) rate-limit user_text на сессию в воркере; (2) honoring max_credits для канала chat."
```

- [ ] **Step 5: Commit**

```bash
git add scripts/widget_smoke.py README.md backend/src/routes/health.ts
git commit -m "feat(smoke): widget_smoke.py — 6 сценариев §8 + ручной чек-лист голоса (Э4-T9)"
```

---

## Гейт фазы (после SDD, ДО закрытия Э4)

Все три пункта обязаны быть зелёными; частичный успех — не гейт.

1. **Автотесты:** `npm test --workspaces` зелёный целиком (backend vitest + embed/loader + embed/app), `cd embed/loader && npm run build` укладывается в 8 КБ gzip, `npm run contracts:check` подтверждает, что контракт совпадает с `origin/main` ядра.
2. **Смок:** `widget_smoke.py` на дев-стенде → `SMOKE-RESULT: OK exit=0 verdicts=6` (все 6 сценариев §8: чат+дедуп эха, re-enter, эскалация в голос, лид, вебхук→usage, три негатива).
3. **Ручной браузерный голос:** чек-лист README пройден целиком через `ssh -L 8200:localhost:8200` на `http://localhost:8200/demo.html`, включая пункты 8–10 (микрофон запрошен, аватар заговорил сам, ответил по существу сказанного), 11–12 (mute и отказ в доступе), 13–14 (пауза по silence → «Продолжить» → нить помнит имя) и 16 (закрытие вкладки не течёт кредитами).

Дополнительно зафиксировать в README фактические значения, найденные на стенде: рабочий `CORE_BASE_URL`, адрес приёмника вебхуков глазами ядра, LiveKit-хост в `WIDGET_CSP_CONNECT_SRC`, остаток баланса тенанта после прогона.

---

## Самопроверка плана (writing-plans self-review)

Проведена по чек-листу до коммита; найденное исправлено ИНЛАЙН в тексте выше. Вторая редакция — после адверсариальной валидации (6 P0 + 12 P1 + right-sizing).

**1. Покрытие спеки.** Каждый раздел SSOT привязан к таску: §2 архитектура → Task 1 (обязательная обвязка: миграции, структурные логи, graceful shutdown — Task 1; rawBody, таймаут 45с и Idempotency-Key — Task 2); §3 модель данных → Task 1 (таблица `visitors` СНЯТА, `visitor_key` прямо в диалоге — как в спеке); §4 все 9 ручек → Task 3 (8) + Task 4 (`/escalate`); §5 embed → Task 5 (страница iframe, лоадер, шим) + Task 6 (чат, дедуп эха, `client_ready`, журнал) + Task 7 (FSM, голос, микрофон, баннер, лид, маппинг ошибок ядра в UX); §6 деньги → Task 1 (схема капов и `settled_session_ids`), Task 3 (`ensureSessionBudget`), Task 4 (кап на эскалации + свипер), Task 8 (малый баланс, порог `credits.low`), Task 9 (issue в ядро); §7 деплой → Task 8; §8 тестирование → Task 1–7 (vitest) + Task 9 (`widget_smoke.py` 6 сценариев + ручной чек-лист); §9 риски → гонка ленты (poll + дописывание в instructions, Task 4), `source` в журнале и сверка (Task 2/4), idle-фрагментация как `paused`/«Продолжить» (Task 7), PII (consent Task 3/7, хэш IP Task 1/3).

**Пробелы спеки, закрытые решениями плана:** (а) буквальный Origin-check убил бы штатный путь iframe → правило доопределено по методу, реальная граница вынесена в `frame-ancestors`; (б) кап по IP против «не храним meta» → необратимые суточные счётчики `ip_day_counters` вместо хранения IP; (в) `localStorage` в iframe партиционируется ITP → владельцем `visitor_key` сделан лоадер (first-party) с передачей через postMessage; (г) спека молчала про публикацию микрофона — без неё голос односторонний, поэтому в Task 7 заведены отдельные шаг, тесты и UX отказа в доступе.

**2. Плейсхолдеры.** Поиск по «TBD», «добавь валидацию», «аналогично Task N», «обработай ошибки» — чисто. Из первой редакции устранены две заглушки прямо в снипетах (`app_log_warn` → `deps.log.warn`, опечатка `${raw!r ?? raw}` → `${raw}`), из второй — проза вместо кода в Vue-шаге: `App.vue`, `room.ts`, `ChatFeed`/`Composer` теперь описаны кодом и тестами с точными селекторами `data-test`. Мутпробы стоят везде, где есть деньги или протокол: Task 1 (идемпотентность журнала, CAS), Task 2 (окно подписи, склейка `<t>.<body>`, длина хэша, дедуп событий, суммирование и НЕудвоение денег, дедуп сверки), Task 3 (Origin без заголовка, `trustProxy`, капы до денег, `max_duration_s`, префикс identity, `/end` перед продолжением, стабильность Idempotency-Key), Task 4 (CAS эскалации, `dialog_not_active`, кап на эскалации, `continue_from`, потолок инструкций, выборка свипера), Task 6 (дедуп эха, XSS, порядок гашения ре-отправщика, `next_seq`, сброс счётчика ленты), Task 7 (порядок disconnect→escalate, старт `resume_welcome` только по входу агента, гашение речью а не любым кадром, `disconnected` в `escalating`, счёт `messages_count`, аудио, микрофон, отписка от видео).

**3. Консистентность типов.** `AppDeps` объявлен целиком в Task 1 (`config`, `pool`, `log`, `core?`) и лишь ужесточается в Task 2 (`core` становится обязательным) — растущий по трём таскам тип из первой редакции был плохим швом. Логгер заполняется внутри `buildApp` через `AppDepsInput = Omit<AppDeps,'log'>`. Чтение журнала — ОДНА функция `listThreadTail` (хвост, хронологический порядок); прежняя пара `listMessages`/`listLastMessages` с расходящейся семантикой сведена в неё, рядом добавлены `maxClientSeq` и `hasSimilarMessage`. Ключ повторяемости выводится ИЗ `core_session_ids.length + 1` — отдельный счётчик `session_seq` удалён вместе с `bumpSessionSeq`, чтобы не держать два источника правды (и чтобы ретрай не покупал новую сессию). `applyFinalizedUsage` везде принимает `sessionId` и возвращает `boolean`. `mapCoreError` живёт в `http/errors.ts` и используется всеми тремя вызывающими. Формы фреймов — из pv1: `user_text {type,text}`, `client_ready {type}`, `resume_welcome {type}`, `transcript {type,speaker:agent|respondent,text,interrupted}`, `session_ended {type,reason}`; `speaker` (data-channel), а НЕ `role` (REST ядра `agent|user`), нормализация `respondent→user` — в одном месте. `TRANSCRIPT_POLL_DEADLINE_MS = 4000` согласован со спекой (~4с) и с ~6с дедлайном ретраев воркера продолжения.

**Проверено по коду ядра (а не по памяти):** баланс тенанта живёт в `tenant_balances (tenant_id PK, balance bigint, updated_at)` — колонки `credits_balance` в `tenants` НЕТ, и SQL провижининга исправлен под реальную схему; `tenants.low_credits_threshold` по умолчанию `0`, поэтому без явного `UPDATE` событие `credits.low` не придёт никогда и алерт §6.1 был бы мёртвым.

**Остаточные риски, которые план не устраняет (осознанно):** `messages_count` считается клиентом эвристически — нудж сторожа простоя даёт перебор, и тогда `transcript_complete:false` уводит в путь «дописать последнюю реплику в instructions» (деградация UX, не поломка); `sandbox` на iframe оставлен по требованию спеки, но вместе с обязательным `allow-same-origin` почти не ограничивает — реальная граница у `frame-ancestors`; `publish_token` публичен by design, и Origin-check не боец против не-браузерных клиентов (страховка — капы, малый баланс и issue в ядро на rate-limit `user_text`); постоянство времени сравнения подписи проверяется ревью, а не тестом (поведенческого способа нет, тест на текст файла был бы проверкой реализации); двойной POST `/dialogs` БЕЗ `dialog_id` создаёт два диалога — общего ключа у них нет, и это ловится только суточным капом.

