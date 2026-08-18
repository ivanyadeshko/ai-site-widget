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
| `contracts/` | Вендорённый контракт ядра, запиненный по коммиту (`core.pin.json` → `openapi.core.yaml` → `core-api.d.ts`), см. «Контракт ядра» ниже |
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

⚠️ В `.env.example` строка `COMPOSE_FILE=compose.yaml:compose.core-network.yaml`
активна — это режим `attached`, и он требует, чтобы внешняя docker-сеть ядра
(`conversation-core_default`) уже существовала, иначе `up` падает «network …
declared as external, but could not be found». Поднимаете виджет БЕЗ ядра —
закомментируйте эту строку (режим `public`, см. раздел «Сетевые режимы»).

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

Деплой — **воркфлоу GitHub Actions `Deploy`** (`.github/workflows/deploy.yml`),
не ручной скрипт. Раскатывается **готовый образ из GHCR** (публикует `release.yml`
парой тегов `sha-XXXXXXX` + `latest`), а не собранный НА СЕРВЕРЕ код: откатываться
есть на что, и деплоится ровно то, что проверил CI.

```
Actions → Deploy → target = dev | de | prod,  image_tag = sha-XXXXXXX
```

Цепочка (`infra/deploy/release.sh`): `gate → preflight → backup → apply → health
→ smoke → commit`. На `apply` — строго `pull` + `up -d --no-build` (голый `up`
с несуществующим тегом молча собрал бы образ из рабочего дерева и выкатил чужой
код под видом успеха — поэтому `--no-build`). Смок-гейт деплоя — сценарии `6,7`
`widget_smoke.py` (негативы + панель, оба бесплатны, кредитов не жгут).

**Предпосылка**: на сервере лежит `$DIR/.env` из `infra/.env.example`
(`chmod 600`); секреты в образ и в git не едут.

> ⚠️ Прежняя схема (`infra/deploy.sh`: rsync исходников + `up -d --build` НА
> СЕРВЕРЕ) выведена из деплоя: собранный на месте образ не совпадал с тем, что
> проверил CI, и откатываться было не на что. Не использовать.

## Сетевые режимы: `attached` и `public`

BFF добирается до ядра одним из двух способов, и выбирает их **одна строка
`COMPOSE_FILE` в `.env` стенда** — ни `release.sh`, ни workflow деплоя её не
пишут и не мигрируют, они только читают.

| | `attached` (дев рядом с ядром) | `public` (прод витрины) |
|---|---|---|
| `COMPOSE_FILE` | `compose.yaml:compose.core-network.yaml` | не задан |
| Сеть ядра | внешняя `conversation-core_default` | не используется |
| `CORE_BASE_URL` | `http://control-plane:8000/api` | `https://api.ai-speak.ru/api` |
| `TRUST_PROXY` | `0` (BFF слушает `:8200` напрямую) | `1` (за nginx, обязателен) |

Базовый `infra/compose.yaml` описывает `public`: сети ядра в нём **нет**.
Возвращает её только override `infra/compose.core-network.yaml`. Причина —
`external: true` нельзя сделать условным: пока сеть была объявлена в базовом
файле, `up` на хосте без стека ядра падал «network … declared as external, but
could not be found», то есть прод витрины был структурно невозможен.

`preflight` проверяет сеть **только** в режиме `attached` (смотрит на
`COMPOSE_FILE`), а в `public` печатает `сетевой режим public — внешняя сеть
ядра не требуется`. Отдельным стоп-условием он проверяет связку
«https-origin + `TRUST_PROXY=1`»: без доверия прокси `req.ip` равен адресу
nginx для всех посетителей сразу, и суточный IP-кап начинает валить живых
людей 429.

**Переключение существующего стенда в `attached`** (порядок обязателен):

```bash
# 1. Файл — на хост РАНЬШЕ строки в .env (иначе compose падает «no such file»
#    на каждой команде). Штатно его кладёт деплой, до первого прогона — руками:
scp infra/compose.core-network.yaml root@<хост>:/opt/site-widget/

# 2. На хосте:
cd /opt/site-widget
cp .env .env.bak-$(date +%F)
grep -q '^COMPOSE_FILE=' .env \
  || echo 'COMPOSE_FILE=compose.yaml:compose.core-network.yaml' >> .env

# 3. Проверка, которая РАБОТАЕТ ДО ДЕПЛОЯ. Не «версия compose такая-то», а
#    прямой вопрос смёрженному графу: вошёл ли backend в сеть ядра. Если да —
#    COMPOSE_FILE подхватился этой конкретной связкой compose и .env; если нет
#    — не подхватился, какова бы ни была версия:
docker compose config | sed -n '/^  backend:/,/^  [a-z]/p' | grep -A3 networks
#   ожидается, что под backend.networks есть строка `core:` (а не только
#   `default:`). Это ровно то, что теперь проверяет и сам preflight.
docker compose config --quiet && bash infra/deploy/release.sh preflight
```

Версию compose отдельно называть не нужно: COMPOSE_FILE в `.env` проекта
современный compose читает, но вместо того чтобы полагаться на номер версии,
проверка выше спрашивает результат напрямую — вошёл backend в сеть ядра или
нет.

⚠️ Строка `→ сеть ядра '…' на месте` в логе preflight различает режимы только
на **новой** версии `release.sh` — до первого деплоя на хосте лежит старая, где
проверка сети безусловна. Поэтому до деплоя доверять нужно выводу
`docker compose config` (шаг 3), а не строке preflight. После деплоя — уже
новый `release.sh`, и он сам падает, если backend в смёрженном графе не
подключён к сети ядра (`override compose.core-network.yaml НЕ смержился …`):
в этом случае `apply` пересоздал бы `backend` без сети ядра и все диалоги
встали бы с `core_unreachable`.

## Мультидомен: `app` / `cdn` / apex

Целевая раскладка прода витрины (DNS и TLS включает этап G3, здесь — только
конфигурация):

```
vell.pro      → site:3000     лендинг + /admin CMS Payload
app.vell.pro  → backend:8200  /app/:token, /w/v1, /panel, /api/v1
cdn.vell.pro  → backend:8200  /w.js, /w.<hash>.js, /assets/* (и больше ничего)
```

Три переменные, у всех фолбэк в конечном счёте на `WIDGET_PUBLIC_ORIGIN` —
однодоменный стенд продолжает работать без единой правки `.env`:

| Переменная | Что задаёт | Фолбэк |
|---|---|---|
| `WIDGET_APP_ORIGIN` | `app_url` iframe; доверенный Origin публичного API | `WIDGET_PUBLIC_ORIGIN` |
| `WIDGET_PANEL_ORIGIN` | единственный Origin, принимаемый не-GET `/api/v1` (D-5) | `WIDGET_APP_ORIGIN` |
| `WIDGET_CDN_ORIGIN` | откуда сниппет зовёт `w.js`; расхождение с app включает `data-host` | `WIDGET_APP_ORIGIN` |

Что делает разъезд доменов рабочим:

- **`app_url` строится из `appOrigin`, а не из cdn** — iframe обязан грузиться
  с хоста, где есть API и кука сессии.
- **`/w.js`, `/w.<hash>.js` и `/assets/*` отдаются с
  `Access-Control-Allow-Origin: *`** — их тянет чужой сайт кросс-доменно, и на
  CDN-хосте без этого заголовка статика просто не загрузится. Панельная
  статика (`/panel/assets/`) заголовок НЕ получает: она живёт на одном хосте с
  кукой сессии.
- **Origin-guard доверяет `appOrigin`**, но не `cdnOrigin`: с CDN-хоста в API
  не ходит никто.
- **`frame-ancestors` разъезд не расширяет** — право встраивания по-прежнему
  даёт только `allowed_origins` виджета.

`infra/nginx/vell.pro.conf` — готовый конфиг под эту раскладку. В этап E он
**не применяется** (вход для G3): слушает `127.0.0.1:9443 ssl proxy_protocol`
как локальный апстрим SNI-разводки на РФ-фронте, разводит два разных `/admin`
(CMS на apex vs админка оператора `/panel/admin` на app) и держит
`proxy_read_timeout 90s` — с запасом к 45-секундному таймауту `CoreClient`.
Проверен `nginx -t` на 1.24 (версия фронта) и 1.27.

## Провижининг оператора витрины (первый администратор)

Админка (`/panel/admin/*` и `/api/v1/admin/*`) открывается только аккаунту с
`accounts.is_admin = TRUE`. Через UI права не выдаются вовсе, и это осознанно:
первого админа назначить неоткуда (админка требует админа), а правило «первый
зарегистрировавшийся становится админом» на публичном URL отдало бы оператора
витрины любому, кто открыл свежий стенд раньше владельца. Доказательство прав —
доступ к серверу:

```bash
# 1. Обычная регистрация через панель: https://<хост>/panel/register
# 2. Выдача прав (DATABASE_URL берётся из окружения контейнера):
docker compose exec -T backend npm run grant-admin -- owner@example.com
# локально, вне docker:
DATABASE_URL=postgres://widget:widget@127.0.0.1:55432/site_widget \
  node backend/scripts/grant-admin.mjs owner@example.com
```

Скрипт идемпотентен, регистр адреса не важен; на несуществующем аккаунте
выходит с кодом 1 и говорит об этом. Отобрать права он не умеет намеренно —
снятие `is_admin` это `UPDATE ... SET is_admin = FALSE` руками и повод
разобраться, что произошло.

Что оператор может из админки: список аккаунтов витрины с числом виджетов и
диалогов за 30 дней, блокировка/разблокировка владельца (блокировка гасит
живые сессии и публичный путь его виджетов немедленно) и **снятие
login-lock**. Последнее — не удобство: блокировка входа кейтся по email,
восстановления пароля у витрины нет, и без этой кнопки владельца вытаскивают
SQL'ем на проде.

Заблокировать себя оператор не может (иначе запрёт себя снаружи), системный
аккаунт `system@vell.local` защищён отдельно — на нём висят виджеты,
заведённые до появления аккаунтов.

### Аварийная разблокировка (витрина заперта)

`cannot_block_self` спасает оператора только от него самого. При ДВУХ и более
администраторах взаимная блокировка запирает витрину целиком: войти в админку
некому, а разблокировка живёт в админке. Тот же тупик даёт e2e с сид-админами
на дев-стенде. Выход — с сервера, без SQL руками:

```bash
docker compose exec -T backend npm run unblock-account -- root@example.com
```

Скрипт снимает `blocked_at` и заодно счётчик неудачных входов по тому же
адресу. Ранее отозванные сессии не восстанавливаются — нужен повторный вход.

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

## Демо-виджет (через кабинет)

Кабинет у витрины теперь ЕСТЬ (потоки I–IV) — виджет заводится в панели, а не
ручным SQL:

1. Регистрация: `https://<хост>/panel/register` (на деве через ssh-туннель —
   `http://localhost:8200/panel/register`).
2. «Создать виджет» → имя + инструкции агента → «Сохранить».
3. В настройках виджета добавить **разрешённый сайт** — тот origin, откуда
   виджет будет открываться (для демо на деве это `http://localhost:8200`).
   ⚠️ Список пуст = виджет закрыт ВЕЗДЕ (осознанное отличие, Constraint 12).
   IP-адрес стенда добавлять НЕ надо: страница по IP не secure context, голос
   там не заведётся.
4. Экран «Установка» → скопировать сниппет (или взять `publish_token` оттуда же).

Полученный `publish_token` подставляется в демо-страницу параметром запроса:
`http://localhost:8200/demo.html?token=<publish_token>`. Пересобирать образ
ради смены токена не нужно (Task 13 потока V).

> Первого администратора витрины поднимают отдельно — см. «Провижининг
> оператора витрины» выше (`grant-admin.mjs`).

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
open 'http://localhost:8200/demo.html?token=<publish_token>'
```

Чек-лист (каждый пункт отмечается по факту прогона):

- [ ] 1. `ssh -L 8200:localhost:8200 root@185.125.102.133`.
- [ ] 2. Открыть `http://localhost:8200/demo.html?token=<publish_token>`.
      ⚠️ ИМЕННО `localhost`:
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

## e2e Playwright (`e2e/`, отдельный npm-проект)

Браузерный сквозной путь. `e2e/` — **отдельный** npm-проект (не воркспейс,
D-11): `@playwright/test` тянет браузеры postinstall'ом. Три проекта:

| Проект | Ядро | В CI? | Кредиты | Что проверяет |
|---|---|---|---|---|
| `panel` | fake-core (герметично) | **да**, обязателен (в т.ч. форк-PR) | нет | весь путь панели: регистрация → виджет → сниппет → кнопка на «чужом» сайте → тема → лид → CSV → цифры (деньги сводит подписанный вебхук `session.finalized`) |
| `acceptance` | **живое** дев-ядро | нет (D-14) | **да** | тот же путь + живой ответ агента; деньги приходят асинхронно (`expect.poll`) |
| `voice` | **живое** дев-ядро | нет (D-14) | **да** | структурные ассерты голоса (панель, микрофон, реплика `source='core'`) |

```bash
# герметичный гейт (как в CI): fake-core вместо ядра, секретов не нужно
docker compose -f e2e/compose.e2e.yaml up -d --build --wait
cd e2e && npm ci && npx playwright install --with-deps chromium
npx playwright test --project=panel
docker compose -f compose.e2e.yaml down -v

# приёмка на живом дев-ядре (ЖЖЁТ кредиты — следить за балансом):
E2E_BASE_URL=http://localhost:8200 npx playwright test --project=acceptance
E2E_BASE_URL=http://localhost:8200 npx playwright test --project=voice
```

Проверку админки в `acceptance` включают переменные `E2E_ADMIN_EMAIL` /
`E2E_ADMIN_PASSWORD` (админ поднимается `backend/scripts/grant-admin.mjs`, см.
«Провижининг оператора»); без них шаг помечается пропуском. Детали — `e2e/README.md`.

## Приёмка E — «незнакомец с улицы»

Сквозной приёмочный сценарий этапа E: живой человек с нуля проходит весь путь
клиента витрины на дев-стенде. Каждый пункт отмечается по факту.

Доступ к стенду для secure context (голос) — ssh-туннель на `localhost`:
```bash
ssh -L 8200:localhost:8200 root@<дев-хост>
```

- [ ] **Регистрация** нового аккаунта на `http://localhost:8200/panel/register`.
- [ ] **Создание виджета** в кабинете: имя + инструкции агента → «Сохранить».
- [ ] **Разрешённый сайт** `http://localhost:8200` добавлен в настройках виджета.
- [ ] **Сниппет** скопирован; демо-страница открыта:
      `http://localhost:8200/demo.html?token=<publish_token>` (ИМЕННО `localhost`).
- [ ] **Живой диалог (чат)**: кнопка → панель → greeting агента → «Сколько стоит
      доставка?» → ответ агента по существу, своя реплика в ленте ОДИН раз.
- [ ] **Эскалация в голос**: «Позвонить голосом» → микрофон запрошен → аватар
      заговорил сам → ответил по существу сказанного (пункты 8–11 ручного
      чек-листа голоса выше).
- [ ] **Лид**: форма с согласием отправлена → «Спасибо» → лид виден на экране
      «Лиды» в панели.
- [ ] **Цифры использования**: экран «Использование» показывает НЕнулевой расход,
      совпадающий с `credits_total`/`usage` диалога на экране «Диалоги».
- [ ] **Админка**: аккаунт с `grant-admin` видит этот аккаунт, его виджет,
      использование и остаток кредитов ядра (`/api/v1/admin/core/credits`).
- [ ] **Playwright** `--project=acceptance` против дев-стенда — зелёный
      (жжёт кредиты, следить за балансом).

Герметичную часть того же пути (без живого агента) непрерывно охраняет CI:
`e2e --project=panel` (см. выше). Приёмку на живом ядре гоняют осознанно —
она тратит кредиты тенанта.

## Контракт ядра: пин, а не `origin/main`

Виджет держит вендорённую копию OpenAPI ядра. Источник правды — **пин**
`contracts/core.pin.json`: коммит ядра, тег его образов и sha256 спеки на этом
коммите.

```
contracts/core.pin.json   ← коммит ядра (SSOT)
        │  contracts/sync.mjs
        ▼
contracts/openapi.core.yaml   ← байт-в-байт contracts/openapi.yaml ядра на core_sha
        │  openapi-typescript
        ▼
contracts/core-api.d.ts   ← типы, которые тянет backend/src/core/types.ts
```

```bash
npm run contracts:sync  -w @aski/site-widget-backend   # подтянуть по пину + перегенерить .d.ts
npm run contracts:check -w @aski/site-widget-backend   # только сверка (гейт CI)
```

`sync.mjs` берёт спеку двумя путями: из **локального чекаута ядра**
(`git show <core_sha>:contracts/openapi.yaml`, по умолчанию сосед
`../ai-conversation-core`, переопределяется `CORE_REPO`) либо, если чекаута нет
(это и есть случай CI), из **GitHub Contents API** с `?ref=<core_sha>` и токеном
из `GH_TOKEN`/`GITHUB_TOKEN`. Режим форсируется `CORE_CONTRACTS_SOURCE=git|api`.
Полученные байты в любом случае сверяются с `spec_sha256` пина — расхождение
означает испорченный пин, а не дрейф контракта, и падает отдельным сообщением.

Пин двигает **не человек**: ядро после публикации образов шлёт
`repository_dispatch` (`core-released`), а `.github/workflows/core-pin-bump.yml`
переписывает пин, перегенерирует `contracts/` и открывает PR
`chore(contracts): bump core pin to sha-XXXXXXX`. Ревьюер читает дифф спеки —
это единственное место, где изменение внешнего контракта видно глазами.

Для обоих механизмов нужны секреты (см. «Известные ограничения»):
`CORE_CONTRACTS_TOKEN` в этом репозитории и `WIDGET_DISPATCH_TOKEN` в ядре.

## CI (`.github/workflows/ci.yml`)

Гейт репозитория (`ubuntu-latest`, npm workspaces):

1. `npm ci` — весь монорепо разом (общий `package-lock.json`).
2. Гейт дрейфа контракта ядра — `contracts:check` по пину (см. раздел выше).
   Мягкий, пока не заведён секрет `CORE_CONTRACTS_TOKEN`: без него шаг пишет
   `::warning` и выходит нулём, потому что приватное ядро штатным
   `github.token` публичного репозитория не читается в принципе.
3. Тестовый Postgres — `infra/compose.test.yaml` (порт `55433`, БД
   `widget_test`) — тот же compose-файл, что и локальный `npm run
   db:test:up` в `backend/package.json`; порт совпадает с фолбэком
   `DATABASE_URL` в `backend/test/helpers/globalSetup.ts`, отдельно
   прокидывать переменную в CI не нужно.
4. `npm run typecheck --workspaces --if-present` — `tsc` (backend),
   `vue-tsc` (embed/app), `tsc` (embed/loader).
5. `npm run test --workspaces --if-present` — vitest во всех трёх
   воркспейсах; backend-тесты сами мигрируют тестовую БД на старте
   (`globalSetup`).
6. `npm run build --workspaces --if-present` — это ЖЕ бюджет-гейт `w.js`:
   `embed/loader`'s `build`-скрипт цепочкой гоняет `vite build && make-shim
   && size-check.mjs` (потолок 8КБ gzip); отдельного шага не заводил —
   размер уже проверяется билдом, дублировать нечем.
7. Отдельная джоба `docker-build` — просто `docker build -f infra/Dockerfile .`
   без публикации (реестр образов — после MVP, см. `infra/deploy.sh`:
   раскатка = rsync исходников + сборка на месте).

`.github/workflows/ci.yml` проверен `actionlint` локально — чисто.

## Известные ограничения MVP (не в скоупе T8)

- Публикация образа в GHCR — после MVP; `compose.yaml` уже готов принять тег
  через `WIDGET_IMAGE`, когда реестр появится.
- ~~Кабинета для управления виджетами нет~~ — **уже не так**: кабинет появился
  (потоки I–III и V этапа E) — регистрация, `/panel`, CRUD виджетов,
  оформление и готовый embed-сниппет. SQL-рецепт выше остаётся аварийным
  путём и способом завести виджет вообще без аккаунта.
- **Секреты кросс-репо-пина не заведены** (их создаёт человек, не CI):
  - `CORE_CONTRACTS_TOKEN` — здесь, в `ai-site-widget`. Fine-grained PAT,
    **только** `Contents: Read-only` на `ivanyadeshko/ai-conversation-core`.
    Пока его нет, гейт дрейфа в `ci.yml` пишет `::warning` и пропускает
    проверку, а `core-pin-bump.yml` падает (без чтения ядра ему нечего делать).
  - `WIDGET_DISPATCH_TOKEN` — в `ai-conversation-core`. Fine-grained PAT,
    `Contents: Read-write` на `ivanyadeshko/ai-site-widget` (право слать
    `repository_dispatch`). Пока его нет, ядро после релиза пишет `::warning`
    и не уведомляет виджет — пин двигают руками
    (Actions → «core pin bump» → `workflow_dispatch`).
  - Плюс настройка репозитория: Settings → Actions → General → **Allow GitHub
    Actions to create and approve pull requests** — иначе `core-pin-bump.yml`
    не сможет открыть PR штатным `GITHUB_TOKEN`.
