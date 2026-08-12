# ai-site-widget MVP — дизайн (Э4/Ф3 распила)

Статус: спека фазы Э4. SSOT границ модуля — `three-services-split-design.md` §4.3/§4.4/§5 (монорепо, ветка `feat/split-phase2-canary`). Ядро: `ai-conversation-core` (контракт `contracts/openapi.yaml` + `contracts/realtime/pv1/`), дев-стенд `http://185.125.102.133:8100` (внутри сервера `localhost:8100`).

## 1. Цель и скоуп

**Цель фазы:** третий модуль программы распила — самостоятельный сервис `ai-site-widget`, работающий против дев-ядра: встраиваемый чат-виджет для сайтов клиентов с эскалацией в голос. Живой e2e на дев: сниппет на тестовой странице → текстовый диалог с аватаром (chat-канал ядра) → кнопка «Голос» → голосовое продолжение с памятью (continue_from Э3.5) → лид в БД виджета → деньги ядра сходятся.

**MVP-скоуп (решение фазы):**
- Бэкенд-сервис (свой Postgres): `widgets` (конфиг+publish-token), `visitors`, `dialogs` (+`core_session_ids[]`), `dialog_messages` (своя история нити — цепочка ядра нетранзитивна), `leads`.
- Публичный API виджета (CORS, rate-limit, visitorKey-модель) + server-side провижининг сессий ядра (тенант-ключ ядра живёт ТОЛЬКО на бэке).
- `w.js`-лоадер + iframe-приложение: текстовый чат, эскалация в голос, лид-форма.
- Вебхуки ядра (session.finalized) → синк диалога/usage.
- Деплой на дев-сервер (compose, отдельный проект/порт) + e2e-смоки.

**ВНЕ MVP (следующие фазы продукта, зафиксировано):** кабинет владельца (UI), розничный биллинг виджета (свой ledger/тарифы — MVP учитывает usage ядра per-dialog, но не продаёт), Inbox виджета/оператор, video-эскалация (после голоса тривиальна), мультиаккаунты/auth владельцев (MVP: один owner, конфиг через API/сид), брендинг/темизация (минимум), in-call cards.

## 2. Архитектура (3 части, 1 репо)

```
ai-site-widget/
├── backend/     Node.js 22 + Fastify + Postgres (raw SQL/минимальный слой) — публичный API + core-провижининг + вебхуки
├── embed/       w.js-лоадер (vanilla TS, ≤8КБ gzip, Shadow DOM) + iframe-приложение (Vue 3 + Vite)
├── contracts/   локальные типы поверх openapi ядра (генерация из спеки ядра; не шарить код)
├── infra/       Dockerfile'ы + compose + деплой-скрипты (самодостаточный, копипаст шаблонов допустим — §4.4 SSOT)
└── scripts/     смоки (widget_smoke.py — headless e2e против дев-стека)
```

**Почему Node/Fastify для бэка:** сервис — тонкий BFF (проксирование/провижининг/вебхуки, без тяжёлой домен-логики); TS даёт один язык с embed и типы из openapi ядра бесплатно; независимость стека от монолита — осознанная (SSOT: «не расшаривать код», каждый repo самодостаточен). Референс формы (не кода): `App\Widget` + `PublicWidgetApiController` + `CoreClient` монолита.

## 3. Модель данных (Postgres)

- `widgets`: id, publish_token (публичный, в сниппете; аналог inviteToken), name, agent_config JSONB (instructions/avatar_id/voice_id/greeting), kb_ids JSONB, theme JSONB, allowed_origins JSONB (CORS-allowlist; пусто = любой — MVP-дефолт с предупреждением), enabled, created_at.
- `visitors`: id, widget_id, visitor_key (UUID из localStorage iframe; уникальный индекс (widget_id, visitor_key)), first_seen_at, last_seen_at, meta JSONB (ua/referrer).
- `dialogs`: id, widget_id, visitor_id, status (active|ended), core_session_ids JSONB [] (вся цепочка: chat, voice...), current_core_session_id, current_channel, started_at, ended_at, usage JSONB (агрегат по вебхукам ядра: credits/tokens/seconds per session).
- `dialog_messages`: id, dialog_id, role (user|agent), text, core_session_id, seq, created_at. Пишется бэком: user — при отправке, agent — при получении transcript-фрейма? НЕТ — фреймы идут браузер↔ядро напрямую; бэк забирает ленту сессии из ядра (`GET /v1/sessions/{id}/transcript`) на завершении сессии/эскалации и складывает в dialog_messages. (Живой UI-чат держит сообщения в памяти iframe; при повторном открытии диалога история отдаётся бэком из dialog_messages + хвост активной сессии из транскрипта ядра.)
- `leads`: id, dialog_id, widget_id, name, phone, email, comment, created_at.

## 4. Публичный API виджета (backend, префикс /w/v1)

Аутентификация: publish_token в пути (публичный) + visitor_key в теле/заголовке (владение диалогом = пара (widget, visitor_key) — модель монолита). Тенант-ключ ядра НИКОГДА не покидает бэк. Rate-limit per IP + per visitor.

| Метод | Ручка | Назначение |
|---|---|---|
| GET | `/w/v1/{publish_token}/config` | конфиг виджета для лоадера/iframe (тема, greeting, enabled); CORS *, cache 60s |
| POST | `/w/v1/{publish_token}/visitor` | регистрация/тач visitor_key |
| POST | `/w/v1/{publish_token}/dialogs` | старт диалога: бэк создаёт chat-сессию ядра (POST /v1/sessions channel=chat, agent из widgets.agent_config, limits дефолтные) → возвращает {dialog_id, participant_token, livekit_url, room} |
| POST | `/w/v1/{publish_token}/dialogs/{id}/escalate` | эскалация: бэк завершает текущую сессию ядра (/end), забирает транскрипт → dialog_messages, создаёт voice-сессию с continue_from=текущая → возвращает новый participant_token; core_session_ids += новая |
| POST | `/w/v1/{publish_token}/dialogs/{id}/end` | явное завершение (закрыл виджет) → /end ядра + синк транскрипта |
| GET | `/w/v1/{publish_token}/dialogs/{id}/messages` | история нити (dialog_messages; для повторного открытия) |
| POST | `/w/v1/{publish_token}/dialogs/{id}/lead` | лид-форма |
| POST | `/w/v1/core-webhooks` | вебхуки ядра (HMAC X-Core-Signature): session.finalized → usage в dialogs.usage, транскрипт-синк (идемпотентно), dialogs.status при финализации без эскалации |

Сам ЧАТ (фреймы user_text/transcript) идёт браузер↔LiveKit data-channel НАПРЯМУЮ по participant_token (data-only грант ядра) — бэк виджета вне живого пути сообщений (как задумано ядром; latency и нагрузка не проходят через BFF).

## 5. Embed (w.js + iframe)

- **Лоадер** (референс loader.ts монолита, упрощён для MVP): сниппет `<script src="https://<widget-host>/w.js" data-widget="{publish_token}" async>`; Shadow DOM лаунчер-кнопка; клик → iframe `https://<widget-host>/app/{publish_token}` c `allow="microphone; autoplay"`; postMessage-мост (open/close/badge — минимум).
- **Iframe-приложение (Vue 3):** экран чата (лента + инпут), кнопка «Продолжить голосом» (после ≥1 обмена), лид-форма (по кнопке; MVP без прочат-гейта), баннер «сессия завершена по тишине» на session_ended{reason:silence} c кнопкой «Продолжить» (continue_from — путь Э3.5 idle-цепочки!).
- **Протокольные обязанности клиента (гочи фаз, ОБЯЗАТЕЛЬНЫ):**
  - `client_ready` слать при входе + РЕ-СЛАТЬ при появлении участника agent-* (фреймы не доставляются будущим участникам).
  - Chat: ответы = transcript-фреймы speaker=agent; нудж сторожа — тоже transcript (показывать как системное, отличать по тексту НЕ надо — просто рендерить).
  - Chat-продолжение: greeting НЕ придёт — рендерить историю нити из GET messages.
  - Voice-эскалация: LiveKit-комната с аудио (browser-SDK: подписка на аудио-трек, mic publish; участник с обычным voice-грантом ядра), слать `resume_welcome` ПОСЛЕ появления агента с повтором ~3с×5 до первого звука/кадра.
  - visitor_key в localStorage iframe (партиционирование cross-origin принято: истории между РАЗНЫМИ сайтами нет — модель монолита).

## 6. Деньги и лимиты (MVP)

Платит ядру владелец виджета (наш тенант-ключ). MVP учитывает: dialogs.usage агрегирует credits/usage_summary из session.finalized (+continued_from связывает). Лимиты: max_duration_s чата = дефолт ядра (потолок 1800), голоса — 600; кап диалогов/visitor/day (защита от абьюза — rate-limit слоя BFF). Розничного биллинга нет (вне MVP).

## 7. Деплой (дев)

Дев-сервер 185.125.102.133, рядом с ядром: compose-проект `site-widget` (порт 8200 backend; embed-статика раздаётся backend'ом), свой Postgres (контейнер). Env: CORE_BASE_URL=http://<core>:8100/api, CORE_TENANT_KEY (создаётся tenant:create на ядре — отдельный тенант «widget»), CORE_WEBHOOK_SECRET, WIDGET_PUBLIC_HOST. Вебхук ядра tenant:webhook:set → http://<gateway-ip>:8200/w/v1/core-webhooks. Тестовая страница-хост (сниппет) — статикой на backend (/demo.html).

## 8. Тестирование

- Backend: vitest (unit по маршрутам/валидации) + интеграционные против реального дев-ядра (созданный тенант, реальные сессии — как смоки ядра).
- E2e-смок `scripts/widget_smoke.py` (паттерн chat_smoke ядра): (1) конфиг → диалог → participant_token → data-only чат «Меня зовут Пётр» → ответ; (2) escalate → voice-token → resume_welcome → аватар заговорил; (3) лид записан; (4) вебхук session.finalized → dialogs.usage заполнен; (5) messages: история нити содержит обе сессии.
- Embed: playwright-лайт (headless открытие demo.html, кнопка, iframe, отправка сообщения) — если по времени тяжело, минимум ручной смок + api-путь скриптом.

## 9. Риски/решения

- **Тонкий момент эскалации:** /end → мгновенный continue_from — гонка оседания ленты закрыта воркером (ретрай 6с; замер: 2/2). Бэк добавляет паузу-опрос: после /end ждёт транскрипт непустой (poll ≤3с) перед созданием voice — двойная страховка + транскрипт уже нужен для dialog_messages.
- **Безопасность publish_token:** публичный (в сниппете) — как inviteToken монолита; защита от абьюза = rate-limits + enabled-флаг + allowed_origins (Origin-check опционален в MVP, поле заложено).
- **Chat-стрим не через Centrifugo:** виджет НЕ тащит Centrifugo (монолитная механика) — data-channel ядра единственный транспорт (SSOT §4.4: realtime — роль ядра).
- **Дрейф w.js:** версионирования нет (иммутабельный сниппет) — принято как в монолите, cache 1h.
