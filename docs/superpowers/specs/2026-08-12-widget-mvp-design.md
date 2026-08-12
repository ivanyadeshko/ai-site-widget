# ai-site-widget MVP — дизайн (Э4/Ф3 распила), v2 после адверсариальной валидации

Статус: спека фазы Э4, переработана по валидации (5 P0 + 14 P1 внесены). SSOT границ — `three-services-split-design.md` §4.3/§4.4/§5. Ядро: `ai-conversation-core` **строго `origin/main` (80b6a3b+)** — локальные чекауты отстают; исполнителю: `git fetch && git checkout origin/main` до первой строки кода. Дев-ядро: `http://185.125.102.133:8100` (host-IP, НЕ имя compose-сервиса — разные проекты/сети).

## 1. Цель и скоуп

**Цель:** третий модуль распила — сервис `ai-site-widget` против дев-ядра: встраиваемый чат-виджет с эскалацией в голос. E2e на дев: сниппет → текстовый диалог (chat-канал ядра) → «Голос» → продолжение с памятью (continue_from) → лид → деньги ядра сходятся.

**MVP:** бэкенд-BFF (Postgres: widgets/visitors-в-dialogs/dialogs+core_session_ids/dialog_messages/leads/core_events) + публичный API + server-side провижининг ядра + w.js+iframe (чат, эскалация, лид-форма) + вебхуки ядра + деплой дев + смоки.

**ВНЕ MVP:** кабинет владельца UI, розничный биллинг, Inbox/оператор, video-эскалация, мультиаккаунты, темизация, in-call cards, playwright (питон-смок + ручной браузерный прогон голоса).

## 2. Архитектура

```
ai-site-widget/
├── backend/     Node.js 22 + Fastify + Postgres (raw SQL + node-pg-migrate)
├── embed/       w.js-лоадер (vanilla TS, ≤8КБ gzip, Shadow DOM) + iframe-приложение (Vue 3 + Vite)
├── contracts/   типы из openapi ядра (openapi-typescript — тот же инструмент, что у ядра)
├── infra/       Dockerfile + compose + деплой
└── scripts/     widget_smoke.py (e2e против дев-стека)
```

Node/Fastify: тонкий BFF, один язык с embed, типы контракта бесплатно. **Обязательная обвязка (в Symfony была даром — заложить явно):** миграции (node-pg-migrate), rawBody-хук для HMAC вебхуков, структурные JSON-логи, graceful shutdown, HTTP-клиент к ядру с таймаутами/ретраями (POST /v1/sessions блокирующий, до ~40с худший случай — таймаут клиента ≥45с, Idempotency-Key обязателен).

## 3. Модель данных (Postgres)

- `widgets`: id, publish_token UNIQUE, name, agent_config JSONB, kb_ids JSONB, **allowed_origins JSONB NOT NULL** (Origin-check ОБЯЗАТЕЛЕН: пустой список = отказ всем, не «любой» — анти-паттерн монолита не наследуем), enabled, created_at.
- `dialogs`: id, widget_id, **visitor_key** (UUID клиента; уникальность диалога не нужна — visitor_key прямо в диалоге, отдельная таблица visitors СНЯТА — YAGNI), status (active|escalating|ended|error), core_session_ids JSONB [], current_core_session_id, current_channel, client_reference (= 'widget:dialog:{id}' — уходит в ядро, возвращается во всех вебхуках: обратного поиска по core_session_ids не нужно), started_at, ended_at, last_activity_at.
- `dialog_messages`: id, dialog_id, role (user|agent — нормализация: data-channel speaker=respondent→user), text, **source ('client'|'core')**, core_session_id, seq, created_at. **Журнал ведёт IFRAME** (шлёт в BFF по мере диалога — это и есть «витрина», которую ядро осознанно не ведёт: greeting/нудж/прощание в ленте ядра нет); транскрипт ядра — СВЕРКА на финализации (source=core, дедуп по тексту/окну).
- `leads`: id, dialog_id, widget_id, name, phone, email, comment, **consent BOOLEAN** (чекбокс согласия — PII на чужих сайтах), created_at.
- `core_events`: event_id UNIQUE, type, payload JSONB, received_at — дедуп вебхуков (порядок не гарантирован, ретраи), источник usage-агрегации (на лету не агрегируем).

## 4. Публичный API (BFF, /w/v1)

Auth: publish_token (публичный) + visitor_key (владение = пара) + **Origin-check по allowed_origins на КАЖДОЙ ручке** (кроме /config для лоадера — у него cache 60s и без секретов). Rate-limit per IP + per visitor + **кап диалогов: N/visitor/сутки, M/IP/сутки** (реальная защита BFF — см. §6 про деньги).

| Метод | Ручка | Назначение |
|---|---|---|
| GET | `/w/v1/{token}/config` | конфиг для лоадера/iframe |
| POST | `/w/v1/{token}/dialogs` | старт: создать chat-сессию ядра (Idempotency-Key, identity генерит ядро) → {dialog_id, participant_token{token,identity,livekit_url,expires_at}} (структура ядра — livekit_url ВНУТРИ participant_token) |
| POST | `/w/v1/{token}/dialogs/{id}/reenter` | повторное открытие живого диалога: `POST /v1/sessions/{sid}/participant-tokens` с НОВОЙ identity `respondent-<uuid>` (генерит BFF; префикс respondent- ОБЯЗАТЕЛЕН — воркер узнаёт клиента по нему; прежнюю identity нельзя — выкинет живого участника). История: dialog_messages + хвост живой сессии GET /transcript (работает на active, лаг ≤5с) |
| POST | `/w/v1/{token}/dialogs/{id}/messages` | журнал от iframe (role, text, seq) — витрина нити |
| POST | `/w/v1/{token}/dialogs/{id}/escalate` | эскалация (см. §5-FSM): вход {messages_count}; /end текущей → poll транскрипта ДО messages_count с потолком ~4с (недобор → последнюю реплику юзера дописать в instructions voice-сессии) → создать voice continue_from (Idempotency-Key) → {participant_token} |
| POST | `/w/v1/{token}/dialogs/{id}/end` | явное завершение → /end + синк |
| GET | `/w/v1/{token}/dialogs/{id}/messages` | история нити |
| POST | `/w/v1/{token}/dialogs/{id}/lead` | лид (+consent) |
| POST | `/w/v1/core-webhooks` | вебхуки ядра: rawBody, `X-Core-Signature: t=<unix>,v1=<hex>` HMAC-SHA256 от `<t>.<raw>`, окно ±5 мин, парс по ключам; INSERT core_events ON CONFLICT DO NOTHING; обработка: session.finalized → dialogs (usage/status), credits.low → лог/алерт. Ответ ≤10с, без редиректов |

Живой чат — браузер↔LiveKit data-channel напрямую (BFF вне пути). Подписка вебхуков: `tenant:webhook:set` поддерживает НЕСКОЛЬКО эндпоинтов и `--events` — подписываемся точечно (session.finalized, transcript.ready, credits.low).

## 5. Embed (w.js + iframe)

- Лоадер: сниппет `<script src="…/w.js" data-widget="{token}" async>`; Shadow DOM кнопка; iframe `…/app/{token}` c `allow="microphone; autoplay"` + **sandbox** + CSP (`script-src 'self'`, connect-src под LiveKit URL); `frame-ancestors` из allowed_origins. Версия: **`w.<hash>.js` + тонкий стабильный шим `/w.js`** (урок монолита: иммутабельный сниппет + возможность катить без дрейфа 1ч).
- Iframe (Vue 3): чат-лента + инпут (maxlength 2000 — ядро режет молча), локальный typing-индикатор по факту отправки (стриминга/agent_typing в chat ядра НЕТ — ответ одним фреймом), кнопка «Продолжить голосом», лид-форма, баннеры состояний.
- **FSM диалога (P0-2):** `chat → escalating → voice | chat_fallback | ended | error`. Эскалация: блокируем инпут → сами отключаемся от chat-комнаты → POST /escalate{messages_count} → 5-15с прелоадер («Соединяю с голосом…») → voice-комната; провал (402/503/422) → POST /dialogs с continue_from последней finalized (новый ЧАТ) + честный текст. `/end` сносит комнату БЕЗ session_ended-фрейма — обрыв LiveKit-соединения в состоянии escalating/ended = штатный переход, НЕ ошибка.
- **Протокол-обязанности клиента (все — из живых гочей ядра):**
  - client_ready при входе + ре-слать при появлении agent-* участника.
  - **Дедуп эха (P0-5):** воркер шлёт обратно И реплику посетителя (transcript speaker=respondent) — рендерить свои сообщения оптимистично и ДЕДУПИТЬ обратный transcript (по тексту+окну).
  - Chat-продолжение/re-enter: greeting не придёт — рендерим историю из BFF.
  - Voice: подписка на аудио-трек (от видеотрека аватара ОТПИСЫВАТЬСЯ — аудио-only UI), mic publish, `resume_welcome` после появления агента с повтором ~3с×5.
  - session_ended{reason:silence} → баннер «Диалог приостановлен» + кнопка «Продолжить» (continue_from). Это ЦЕНТРАЛЬНЫЙ сценарий (idle ядра 120/300с — глобальные env, фрагментация нити частая), не край.
  - localStorage: try/catch + in-memory фолбэк (Safari/ITP).
  - Рендер текста: ТОЛЬКО интерполяция, v-html запрещён (реплики — влияемый посетителем контент).
- Ошибки ядра → UX: 402 «лимит исчерпан» (диалог в error), 503 «сервис недоступен, попробуйте позже», 410/422 — рестарт диалога.

## 6. Деньги и защита (P0-1 — центральный риск MVP)

**Факт ядра:** держатель participant_token (браузер, TTL 1ч) может слать user_text в цикле мимо BFF; ядро НЕ режет токены chat по max_credits (drain-to-zero по балансу на settle), rate-limit user_text в воркере нет, резервирования нет (N параллельных сессий = N×баланс).

Слои защиты MVP:
1. **Бюджет-предохранитель:** отдельный тенант ядра «widget» с НАМЕРЕННО МАЛЫМ балансом (дев: ~5000 credits), пополнение порциями; credits.low → алерт.
2. `max_duration_s`: chat-сессии виджета = **600** (не дефолт 1800), voice = 600 — wall-clock кап одной сессии.
3. Кап диалогов: N=10/visitor/сутки, M=30/IP/сутки (BFF).
4. **Issue в ядро** (не чинится на стороне виджета): rate-limit user_text в воркере + honoring max_credits для chat — завести при старте фазы.
5. Брошенные вкладки держат worker-джоб до idle-close (300с) — принято (chat без presence-teardown, by design ядра).

Учёт: dialogs.usage из core_events (session.finalized). Розничного биллинга нет. **Свипер:** cron BFF по active-диалогам старше N часов → GET /v1/sessions/{id} → досинк статуса (вебхук после 8 неудач теряется навсегда).

**Память нити (P1-8):** continue_from нетранзитивен (~24 реплики предшественника) — нить виджета дробится idle-закрытиями. MVP: при continue_from БЭК дополняет agent.instructions сжатой выжимкой нити (последние K=30 реплик из dialog_messages, потолок инструкций 32000) — «одна правда» у BFF. Полноценное саммари — после MVP.

## 7. Деплой (дев)

Compose-проект `site-widget` на 185.125.102.133: backend :8200 (+ статика embed + /demo.html), Postgres контейнер. Env: CORE_BASE_URL=http://172.17.0.1:8100/api ИЛИ host-IP (ядро — другой compose-проект: по имени сервиса НЕ разрезолвится; проверить фактический маршрут host↔контейнер), CORE_TENANT_KEY (tenant:create «widget» на ядре; баланс — прямым UPDATE psql, ручки пополнения нет), CORE_WEBHOOK_SECRET (из tenant:webhook:set), WIDGET_PUBLIC_HOST. Вебхук: на дев-ядре обязаны стоять CORE_WEBHOOK_ALLOW_HTTP=1 + CORE_WEBHOOK_ALLOW_PRIVATE_TARGETS=1 (стоят — проверить, не полагаться).

**Secure context (P0-3):** голос из iframe требует https/localhost. Дев-прогон голоса: `ssh -L 8200:localhost:8200` → страница `http://localhost:8200/demo.html` (localhost = secure context). Чат по data-channel живёт и на http. TLS-сабдомен — после MVP.

## 8. Тестирование

- Backend: vitest (роуты/валидация/подпись вебхука на фикстурах) + интеграционные против дев-ядра.
- `scripts/widget_smoke.py` (паттерн chat_smoke ядра): (1) конфиг→диалог→чат «Меня зовут Пётр»→ответ + **дедуп эха проверен** (свой текст не задвоен в журнале BFF); (2) reenter с новой respondent-identity — история отдана, диалог жив; (3) escalate{messages_count}→voice-token→resume_welcome→аватар заговорил (python-клиент; браузерный голос — ручной шаг через ssh -L); (4) лид с consent; (5) вебхук → core_events → dialogs.usage; (6) негативы: чужой Origin → отказ; 11-й диалог/сутки → отказ; фейк-подпись вебхука → 401.
- Ручной браузерный смок голоса (P0-3) — чек-лист в README.

## 9. Риски/решения (после валидации)

- Эскалационная гонка ленты: двойная страховка (ретрай ядра 6с + poll BFF до messages_count) + недобор дописывается в instructions.
- publish_token публичный — защита Origin-check+капы+бюджет-предохранитель (§6).
- Данные ядра/клиента в журнале различимы (source) — сверка на finalized.
- Idle-фрагментация — принята и превращена в UX «Продолжить» (§5).
- PII: consent-чекбокс лида; meta посетителя НЕ храним (ни UA, ни IP — как монолит); ретенция — после MVP.
