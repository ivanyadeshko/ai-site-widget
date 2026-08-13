# ai-site-widget

Встраиваемый виджет-аватар для чужих сайтов (Aski, Э4/Ф3 распила): лоадер
`w.js` (Shadow DOM, бюджет ≤8КБ gzip) → iframe-приложение (чат по
data-channel + голос) → бэкенд (`:8200`, Fastify) → ядро (`ai-conversation-core`,
LiveKit-агент). Собственной БД для разговоров у ядра виджет не спрашивает —
держит свой Postgres (`dialogs`/`dialog_messages`/`leads`/квоты), общается с
ядром через `contracts/openapi.core.yaml` (Session API + вебхуки).

Структура репозитория:

| Каталог | Что |
|---|---|
| `backend/` | Fastify: публичный API виджета, вебхуки ядра, `/app/:token`, статика `w.js`/embed-приложения |
| `embed/loader/` | `w.js` — сниппет, который вставляет владелец сайта |
| `embed/app/` | Vue 3 iframe-приложение (чат + голос) |
| `embed/public/` | Статика демо-страницы (`demo.html`) |
| `contracts/` | Синхронизированный контракт ядра (`core-api.d.ts` из `openapi.core.yaml`) |
| `infra/` | Dockerfile, compose дев-стенда, `.env.example`, `deploy.sh` |
| `.superpowers/sdd/` | SDD-леджер задачи (планы/брифы/отчёты тасков) |

## Локальный запуск (docker compose)

```bash
cd infra
cp .env.example .env
# отредактировать .env — см. «Обязательные плейсхолдеры» ниже
docker compose up -d --build
docker compose exec -T backend npx --no-install node-pg-migrate -m backend/migrations up
curl -fsS http://localhost:8200/healthz   # {"status":"ok","db":"ok"}
```

`build.context` по умолчанию — `..` (корень репо): локально `WIDGET_BUILD_CONTEXT`
в `.env` не задают, эту строку удаляют/комментируют (в `.env.example` она стоит
как `./src` — значение под стенд, см. ниже).

Бэкенд без реального ядра поднимается и отвечает на `/healthz`, но
`/w/v1/:token/dialogs` (старт диалога) упадёт — ходить некуда. Для полного
локального цикла с ядром см. `ai-conversation-core` (свой стенд, свой `.env`).

### Обязательные плейсхолдеры перед первым запуском

`.env.example` содержит несколько значений, которые **обязаны** быть заменены
до первого реального запроса — иначе не «не работает частично», а падает
процесс целиком на конкретных путях. Оба факта проверены живым прогоном
контейнера (`docker compose up` + `curl`), не из документации:

- **`CORE_TENANT_KEY`** — уезжает в исходящий заголовок `Authorization: Bearer
  <ключ>` к ядру (`backend/src/core/client.ts:44`). Placeholder с кириллицей
  валит `TypeError: Cannot convert argument to a ByteString` — Fetch API
  требует latin1 в значении заголовка. Падает КАЖДЫЙ вызов ядра (старт
  диалога, эскалация, reenter), причём до сети, ещё в конструкторе `Headers`.
- **`WIDGET_CSP_CONNECT_SRC`** — целиком уезжает в ответный заголовок
  `Content-Security-Policy` (`backend/src/routes/appPage.ts`). Placeholder с
  кириллицей валит `ERR_INVALID_CHAR: Invalid character in header content` —
  Node требует latin1 в значении заголовка. Падает КАЖДЫЙ `GET /app/:token`,
  то есть весь iframe (чат И голос) не грузится вообще, не только голос.

Оба плейсхолдера в `.env.example` уже ASCII (`REPLACE-ME-...`) специально по
этой причине — сохранённая кириллица была бы такой же миной, только без
явного сигнала «это не настоящее значение».

Прочие плейсхолдеры (`POSTGRES_PASSWORD`, `CORE_WEBHOOK_SECRET`,
`IP_HASH_SALT`) в HTTP-заголовки не попадают — забытыми они деградируют
безопасность/дедуп вебхука, но не роняют процесс.

### Гоча docker-сборки: `.dockerignore`

`infra/Dockerfile` (build-стадия) делает `RUN npm ci` (ставит зависимости под
linux/alpine в образе), а следом `COPY . .`. Без корневого `.dockerignore`
эта копия затирает свежепоставленный `node_modules` ХОСТОВЫМ node_modules из
контекста сборки — а у `vite`/`vite`-лоадера зависимости `esbuild`/`rollup`
платформенные (нативные бинарники, например `@esbuild/darwin-arm64` на
macOS). Попав поверх linux-версии внутри контейнера, `vite build` падает.
`.dockerignore` в корне репозитория (действует и локально при
`build.context: ..`, и на стенде при `build.context: ./src` — `deploy.sh`
рассылает дотфайлы rsync'ом как есть) исключает `node_modules`/`dist`
везде — проверено полной локальной сборкой образа
(`docker build -f infra/Dockerfile .`).

## Раскатка на дев-стенд

```bash
HOST=root@185.125.102.133 DIR=/opt/site-widget bash infra/deploy.sh
```

Что делает `infra/deploy.sh`: rsync исходников (кроме `.git`/`node_modules`/
`dist`/`.env`) в `$DIR/src` на сервере → `docker compose up -d --build`
(контекст сборки — `$DIR/src`, см. `WIDGET_BUILD_CONTEXT=./src` в
`.env.example`) → миграции → `curl /healthz`.

**Предпосылка**: на сервере должен уже лежать `$DIR/.env`, заполненный из
`infra/.env.example` (`chmod 600`) — скрипт падает с понятным сообщением,
если файла нет. `.env` в rsync намеренно не улетает (секреты не должны жить
в исходниках, которые гоняются туда-обратно).

MTU на этом сервере — 1400: большие передачи по `scp` подвисают, поэтому
rsync, а не один толстый scp (уже известная гоча стенда, см. `docs/dev_stand`
в родственных репозиториях программы распила).

## Провижининг тенанта в ядре (ручной ран, вне этого репозитория)

Этот раздел исполняется НЕ отсюда — руками (или скриптово) на 185.125.102.133
против `ai-conversation-core` (`/opt/conversation-core`). Здесь только
готовые команды; я их не запускал (нет мандата трогать общий дев-стенд из
задачи T8 — деплой и провижининг делает оркестратор).

```bash
CORE="docker compose -f /opt/conversation-core/compose.yaml exec -T control-plane bin/console"
PSQL="docker compose -f /opt/conversation-core/compose.yaml exec -T postgres psql -U core -d conversation_core"

# 1. Тенант + ключ (ключ показывается ОДИН раз — сразу в infra/.env виджета,
#    CORE_TENANT_KEY).
$CORE tenant:create "site-widget" --test --json

# 2. Бюджет-предохранитель: намеренно малый баланс. Ручки пополнения нет —
#    только прямой INSERT. Баланс — в ОТДЕЛЬНОЙ таблице tenant_balances
#    (PK = tenant_id, внутренний int-id тенанта; колонки credits_balance в
#    tenants НЕТ).
$PSQL -c "INSERT INTO tenant_balances (tenant_id, balance, updated_at)
          SELECT id, 5000, now() FROM tenants WHERE public_id = 'ten_ПОДСТАВИТЬ'
          ON CONFLICT (tenant_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = now();"
$PSQL -c "SELECT t.public_id, b.balance FROM tenants t
          JOIN tenant_balances b ON b.tenant_id = t.id WHERE t.public_id = 'ten_ПОДСТАВИТЬ';"

# 3. Порог credits.low. По умолчанию low_credits_threshold = 0 → событие
#    низкого баланса не придёт никогда. Ставим руками.
$PSQL -c "UPDATE tenants SET low_credits_threshold = 1000 WHERE public_id = 'ten_ПОДСТАВИТЬ';"

# 4. Подписка на вебхуки — ТОЧЕЧНО. Секрет из вывода → CORE_WEBHOOK_SECRET
#    виджета. Адрес — тот, по которому КОНТЕЙНЕР ЯДРА видит контейнер
#    виджета (см. следующий раздел про маршрут, ДО того как вписывать сюда
#    финальный адрес).
$CORE tenant:webhook:set ten_ПОДСТАВИТЬ http://172.17.0.1:8200/w/v1/core-webhooks \
  --events session.finalized,transcript.ready,credits.low --json

# 5. Проверить (не полагаться на догадку), что http и приватные адреса
#    разрешены — оба флага обязаны быть =1.
grep -E 'CORE_WEBHOOK_ALLOW_(HTTP|PRIVATE_TARGETS)' /opt/conversation-core/.env
```

Если флаги не `=1` — дописать и пересоздать (`restart` env не подхватывает):

```bash
docker compose -f /opt/conversation-core/compose.yaml up -d --force-recreate control-plane webhook-dispatcher
```

### Маршрут контейнер виджета → ядро (проверять руками, не гадать)

`172.17.0.1` (Docker bridge gateway) — рабочая ГИПОТЕЗА в `.env.example`
(`CORE_BASE_URL`), не факт: у ядра свой compose-проект и своя сеть, и
резолвится ли `172.17.0.1` из сети `site-widget` — надо проверить С МЕСТА
(из контейнера виджета), а не с хоста:

```bash
docker compose -f /opt/site-widget/compose.yaml exec -T backend \
  node -e "fetch('http://172.17.0.1:8100/health').then(r=>console.log('172.17.0.1 →',r.status)).catch(e=>console.log('172.17.0.1 ✗',e.message))"
docker compose -f /opt/site-widget/compose.yaml exec -T backend \
  node -e "fetch('http://185.125.102.133:8100/health').then(r=>console.log('host-IP →',r.status)).catch(e=>console.log('host-IP ✗',e.message))"
```

Победивший адрес → `CORE_BASE_URL` в `infra/.env` (с суффиксом `/api`).
Симметрично, для `tenant:webhook:set` — адрес, по которому КОНТЕЙНЕР ЯДРА
видит контейнер виджета:

```bash
docker compose -f /opt/conversation-core/compose.yaml exec -T control-plane \
  curl -fsS http://172.17.0.1:8200/healthz
```

Оба адреса (`CORE_BASE_URL` со стороны виджета и адрес в `tenant:webhook:set`
со стороны ядра) НЕ обязаны совпадать по хосту — это два разных направления
через два независимых docker-bridge.

## Демо-виджет (первый виджет, кабинета в MVP нет)

```bash
ssh root@185.125.102.133 "cd /opt/site-widget && docker compose exec -T postgres psql -U widget -d site_widget -c \"
INSERT INTO widgets (publish_token, name, agent_config, kb_ids, allowed_origins, enabled)
VALUES ('wgt_demo_\$(openssl rand -hex 8)', 'Демо-виджет',
  '{\\\"instructions\\\":\\\"Ты консультант интернет-магазина. Отвечай коротко и по делу.\\\"}'::jsonb,
  '[]'::jsonb, '[\\\"http://localhost:8200\\\"]'::jsonb, true)
RETURNING publish_token;\""
```

**ДЕВИАЦИЯ от буквы брифа T8**: `allowed_origins` содержит только
`http://localhost:8200`, БЕЗ `http://185.125.102.133:8200` — сам же брифа
(шаг «Демо-страница») явно велит НЕ добавлять IP-адрес стенда: страница по
IP не secure context, голос там не заработает, а лишний разрешённый origin
(= лишняя дыра в `frame-ancestors`) ничего не даёт взамен. SQL-пример на шаге
«Раскатка» того же брифа противоречил этому и включал IP — следую более
позднему и обоснованному указанию, не более раннему тексту. Если понадобится
показать чат (без голоса) по IP — добавить `http://185.125.102.133:8200`
осознанно вторым элементом массива и обязательно пометить здесь, что голос
по этому адресу не работает.

Полученный `publish_token` вписать в `embed/public/demo.html`
(`data-widget="..."`) и пересобрать образ (в MVP — правкой файла и повторным
`bash infra/deploy.sh`; `?token=` через query — не реализовано).

Проверки живости:

```bash
ssh root@185.125.102.133 'cd /opt/site-widget && docker compose logs backend --tail 100 | grep -i "listening\|error"'
curl -fsS http://185.125.102.133:8200/w/v1/<TOKEN>/config | head -c 400
curl -fsS -o /dev/null -w '%{http_code}\n' http://185.125.102.133:8200/w.js
```

## Ручной прогон голоса (P0-3, secure context)

`widget_smoke.py` (см. следующий раздел) проверяет 6 сценариев §8 headless'ом —
питон-клиент входит в voice-комнату и видит, что аватар ЗАГОВОРИЛ
(transcript/аудио-трек), но он НЕ публикует микрофон и не может проверить, что
аватар слышит и понимает живую речь браузера. Это последний P0 гейта фазы —
без него неизвестно, разрешает ли браузер `getUserMedia` именно в этой
раскладке (iframe, CSP, allowed origin) и слышит ли аватар реального человека.

Голос требует `getUserMedia`, а тот требует secure context. Страница по
`http://185.125.102.133:8200/...` (голый IP) — НЕ secure context, и микрофон
там не запросится вовсе, даже с валидным диалогом. Рабочий способ на деве —
ssh-туннель на `localhost`; `WIDGET_PUBLIC_ORIGIN` на стенде обязан быть
именно `http://localhost:8200` — иначе iframe (allowed_origins/frame-ancestors
сверяются буквально) уедет на IP-origin, и голос умрёт молча:

```bash
ssh -L 8200:localhost:8200 root@185.125.102.133
# в новой вкладке браузера (ИМЕННО localhost, не IP):
open http://localhost:8200/demo.html
```

Чек-лист (каждый пункт отмечается по факту прогона):

- [ ] 1. `ssh -L 8200:localhost:8200 root@185.125.102.133`.
- [ ] 2. Открыть `http://localhost:8200/demo.html`. ⚠️ ИМЕННО `localhost`:
      страница по `http://<IP>` не secure context, и микрофон там не
      запросится вовсе. `WIDGET_PUBLIC_ORIGIN` на стенде обязан быть
      `http://localhost:8200`, иначе iframe уедет на IP-origin и голос умрёт.
- [ ] 3. Кнопка виджета → панель открылась, greeting пришёл текстом.
- [ ] 4. Написать «Меня зовут Пётр» → свой пузырь ОДИН (эхо не задвоило) →
      ответ агента.
- [ ] 5. Перезагрузить страницу → история на месте и НЕ задвоилась, диалог
      продолжается.
- [ ] 6. Написать ещё реплику → она видна (нумерация журнала продолжилась с
      `next_seq`).
- [ ] 7. «Продолжить голосом» → прелоадер «Соединяю с голосом…» ≤15с.
- [ ] 8. Браузер СПРОСИЛ доступ к микрофону → разрешить; индикатор микрофона
      активен.
- [ ] 9. Аватар ЗАГОВОРИЛ сам (`resume_welcome` сработал), не дожидаясь
      реплики.
- [ ] 10. Сказать «А доставка бесплатная?» → аватар ОТВЕТИЛ по существу
       (значит нас слышно: микрофон реально опубликован), своя реплика в
       ленте ОДИН раз.
- [ ] 11. Нажать mute → сказать что-нибудь → реакции нет; снять mute → снова
       слышно.
- [ ] 12. Отказать в доступе к микрофону (отдельный прогон в приватном окне)
       → баннер «Микрофон недоступен», аватара при этом СЛЫШНО, оверлея
       ошибки нет.
- [ ] 13. Помолчать до silence-таймаута → баннер «Диалог приостановлен» +
       «Продолжить».
- [ ] 14. «Продолжить» → новый чат помнит имя Пётр (нить не потеряна).
- [ ] 15. Лид-форма: без чекбокса согласия кнопка неактивна; с ним —
       «Спасибо».
- [ ] 16. Закрыть вкладку → в логах ядра сессия закрылась, кредиты не текут.
- [ ] 17. Проверить остаток баланса тенанта и записать его здесь: `_____`.

Если на шаге 9/10 тишина — первым делом смотреть devtools → Console на CSP
violation (`connect-src`): это самый частый способ сломать именно голос, не
трогая ничего в коде. `wss://<livekit-хост>` обязан быть в
`WIDGET_CSP_CONNECT_SRC`, иначе браузер молча рубит соединение по CSP
(`Refused to connect`), а бэкенд об этом никак не узнаёт (клиентская политика).

Гейт фазы Э4 требует пункты 8–10 (микрофон запрошен, аватар заговорил сам,
ответил по существу сказанного), 11–12 (mute и отказ в доступе), 13–14 (пауза
по silence → «Продолжить» → нить помнит имя) и 16 (закрытие вкладки не течёт
кредитами) — не только «голос слышно».

Фактические значения стенда (заполнить после прогона): `CORE_BASE_URL` —
`_____`; адрес приёмника вебхуков глазами ядра (`tenant:webhook:set`) —
`_____`; LiveKit-хост в `WIDGET_CSP_CONNECT_SRC` — `_____`; остаток баланса
тенанта после прогона — `_____`.

## `widget_smoke.py` — headless-гейт BFF+ядро (6 сценариев §8)

`scripts/widget_smoke.py` — headless-версия того же пути (без браузера и без
микрофона): `GET /config` → `POST /dialogs` → LiveKit data-only чат →
`client_ready` → greeting → `user_text` → ответ агента + дедуп эха → re-enter
новой identity → `POST /escalate` → voice-токен → `resume_welcome` → аватар
заговорил (аудио-трек/транскрипт, БЕЗ публикации микрофона) → лид с
consent → `POST /end` → вебхук `session.finalized` (ядро → BFF) →
`core_events` → `dialogs.usage`/`credits_total`/`settled_session_ids` сведены
→ три негатива (чужой Origin, суточный кап посетителя, фейк-подпись вебхука).

Гоняется с самого дев-сервера интерпретатором ВОРКЕРА ЯДРА (там есть
`livekit-rtc`; в `ai-site-widget` такой зависимости нет и не должно быть).
Приёмник вебхуков поднимать не нужно: вебхук `session.finalized` ядро само
доставляет в BFF (`POST /w/v1/core-webhooks`, подписка настроена в разделе
«Провижининг» выше), money-синк проверяется через `--psql` BFF-Postgres.

```bash
/opt/conversation-core/worker/.venv/bin/python scripts/widget_smoke.py \
  --base-url http://localhost:8200 --token <PUBLISH_TOKEN> \
  --psql 'docker compose -f /opt/site-widget/compose.yaml exec -T postgres psql -U widget -d site_widget'
```

Ожидаемый результат — последняя строка вывода `SMOKE-RESULT: widget-ok exit=0
verdicts=6`; коды выхода 0/1/2/3 и полный разбор сценариев — в докстринге
файла (`--help` тоже работает без `livekit-rtc`: SDK импортируется лениво,
только внутри реального LiveKit-подключения). ⚠️ Диалог настоящий и жжёт
кредиты тенанта виджета (малый баланс по конструкции, см. «Провижининг»
выше) — гонять пачкой не стоит. Красный смок — чинить код, а НЕ ослаблять
ассерт.

## CI (`.github/workflows/ci.yml`)

Гейт репозитория (`ubuntu-latest`, npm workspaces):

1. `npm ci` — весь монорепо разом (общий `package-lock.json`).
2. Тестовый Postgres — `infra/compose.test.yaml` (порт `55433`, БД
   `widget_test`) — тот же compose-файл, что и локальный `npm run
   db:test:up` в `backend/package.json`; порт совпадает с фолбэком
   `DATABASE_URL` в `backend/test/helpers/globalSetup.ts`, отдельно
   прокидывать переменную в CI не нужно.
3. `npm run typecheck --workspaces --if-present` — `tsc` (backend),
   `vue-tsc` (embed/app), `tsc` (embed/loader).
4. `npm run test --workspaces --if-present` — vitest во всех трёх
   воркспейсах; backend-тесты сами мигрируют тестовую БД на старте
   (`globalSetup`).
5. `npm run build --workspaces --if-present` — это ЖЕ бюджет-гейт `w.js`:
   `embed/loader`'s `build`-скрипт цепочкой гоняет `vite build && make-shim
   && size-check.mjs` (потолок 8КБ gzip); отдельного шага не заводил —
   размер уже проверяется билдом, дублировать нечем.
6. Отдельная джоба `docker-build` — просто `docker build -f infra/Dockerfile .`
   без публикации (реестр образов — после MVP, см. `infra/deploy.sh`:
   раскатка = rsync исходников + сборка на месте).

`.github/workflows/ci.yml` проверен `actionlint` локально — чисто.

## Известные ограничения MVP (не в скоупе T8)

- Публикация образа в GHCR — после MVP; `compose.yaml` уже готов принять тег
  через `WIDGET_IMAGE`, когда реестр появится.
- Кабинета для управления виджетами нет — первый (и единственный на MVP)
  виджет заводится прямым SQL (см. выше).
- `?token=` вместо правки `demo.html` — не реализовано.
