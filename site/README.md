# `site/` — лендинг vell.pro (Payload CMS 3 + Next.js)

Апекс `vell.pro`: публичный лендинг витрины и CMS для его контента.
Продукт (кабинет владельца сайта, API виджета, iframe) живёт **в другом
сервисе** — `backend/` на `app.vell.pro`.

`site/` — **отдельный npm-проект, а не workspace монорепо**. У него свой
`package-lock.json`, свой `npm ci --legacy-peer-deps`, свой `Dockerfile` и своя
CI-джоба (`site-build` в `.github/workflows/ci.yml`). Причина: дерево Payload 3
+ Next 16 + React 19 не сходится по peer-диапазонам, и в общем корневом локе
оно сломало бы `npm ci` для `backend/`, `embed/*` и `panel/`.

---

## Два админа — не перепутать

У витрины **два независимых административных периметра**. Они не связаны:
разные БД, разные таблицы пользователей, разные куки, разные пароли. Заведение
человека в одном не даёт ему ничего во втором.

| | Payload CMS | Панель оператора |
|---|---|---|
| Адрес | `https://vell.pro/admin` | `https://app.vell.pro/panel/admin` |
| Кто это | редактор лендинга (тексты, тарифы, блог) | оператор витрины (клиенты, лимиты, блокировки) |
| Учётки | коллекция `users` Payload, БД `vell_site` | таблица `accounts` (`is_admin = true`), БД `site_widget` |
| Аутентификация | штатный Payload-auth | scrypt + cookie-сессия в `account_sessions` |
| API | `/admin/api/*` (Payload REST) | `/api/v1/admin/*` (BFF) |
| Сервис | `site` (этот проект) | `backend` |

Что из этого следует на практике:

- **Куки обоих периметров — строго host-only.** Ни Payload, ни BFF не выставляют
  атрибут `Domain`: кука `vell.pro` не должна уезжать на `app.vell.pro` и
  наоборот. Стоит один раз выставить `Domain=.vell.pro` — и сессии двух разных
  систем начнут ездить друг к другу: браузер пошлёт куку CMS в API кабинета
  (лишний секрет в чужом периметре), а при совпадении имён — ещё и затрёт
  живую сессию. В Payload это задано явно (`src/collections/Users.ts`,
  `auth.cookies`), в BFF — тем, что `Domain` не передаётся при `setCookie`.
- Блокировка клиента оператором в `/panel/admin` **не трогает** доступ в CMS, и
  наоборот: удаление редактора из Payload не выключает ни одного виджета.
- Компрометация одного периметра не даёт другого. Разные секреты:
  `PAYLOAD_SECRET` (этот проект) и `SESSION_*`/`IP_HASH_SALT` (BFF).
- Не заводите «сквозной» SSO между ними в обход этого решения: единственная
  общая точка витрины — тенант ядра, а не пользователи.

---

## Локальный запуск

```bash
cd site
cp .env.example .env            # заполнить DATABASE_URI и PAYLOAD_SECRET
npm ci --legacy-peer-deps       # обычный npm ci упадёт на peer-резолве
npm run build:payload-config    # payload.config.mjs — его читает CLI Payload
npm run migrate                 # схема Payload в БД
npm run dev                     # http://localhost:3000, админка на /admin
```

⚠️ `npm run dev` — это `next dev --webpack`. Turbopack ломает админку Payload,
поэтому флаг зашит в скрипт; не убирайте его «за скорость».

⚠️ Нужен **Node 22** (`.nvmrc` репозитория). На Node 25 CLI Payload падает с
`ERR_REQUIRE_ASYNC_MODULE` при загрузке конфига.

Первый заход на `/admin` предложит создать пользователя CMS — это редактор
лендинга (см. «Два админа» выше), не аккаунт продукта.

### Порядок команд имеет значение

`payload migrate` и `payload generate:*` читают **не** `payload.config.ts`, а
собранный `payload.config.mjs` (`PAYLOAD_CONFIG_PATH` в скрипте `payload`).
Забыли `build:payload-config` — получите «конфиг не найден» вместо миграции.
В образе этот шаг выполняется на стадии `builder` (`site/Dockerfile`).

После правки коллекций/globals:

```bash
npm run build:payload-config
npm run payload generate:types        # src/payload-types.ts
npm run payload generate:importmap    # src/app/(payload)/admin/importMap.js
npm run migrate:create                # новая миграция в src/migrations
```

Сгенерированные `payload-types.ts`, `importMap.js` и файлы миграций
**коммитятся**: образ собирается из репозитория, а не запускает генерацию.

---

## Стенд (compose-профиль `site`)

Сервисы объявлены в общем `infra/compose.yaml` под профилем `site`:

| Сервис | Что делает |
|---|---|
| `site-db` | Postgres 16, БД `vell_site`, том `site-pgdata`, порт наружу не публикуется |
| `site-migrate` | one-shot `npm run migrate`, завершается кодом 0 |
| `site` | Next standalone на `:3000`, том `site-media` под загрузки CMS |

```bash
cd infra
# в .env: COMPOSE_PROFILES=site, SITE_DB_PASSWORD, PAYLOAD_SECRET,
#         NEXT_PUBLIC_SERVER_URL, NEXT_PUBLIC_APP_URL
docker compose --profile site build
docker compose --profile site up -d
docker compose logs site-migrate     # обязан завершиться без ошибок
curl -fsS localhost:3000/api/health  # {"status":"ok"}
```

`NEXT_PUBLIC_*` **инлайнятся в бандл при сборке образа** — правка в `.env` без
пересборки ничего не изменит на страницах. Пустые значения намеренно валят
`docker build` (fail-fast в `site/Dockerfile`).

### ⚠️ Первый пользователь CMS — окно захвата, закрывать сразу

Пока в коллекции `users` нет ни одной записи, `/admin` показывает форму
«создать первого пользователя» **любому, кто её откроет**, и созданный
аккаунт получает полный доступ к CMS. Это штатное поведение Payload, а не
настройка, которую мы забыли выключить: свежая база не знает, кто хозяин.

Порядок действий при первом публичном деплое апекса:

1. Поднять профиль `site`, дождаться `site-migrate` с кодом 0.
2. **Немедленно**, до того как домен куда-либо анонсирован и до того как на
   него направлен DNS, открыть `https://<домен>/admin` и создать первого
   пользователя.
3. Убедиться, что форма создания больше не показывается (после первой записи
   `/admin` отдаёт обычную форму входа).

Пока шаг 2 не сделан, домен нельзя считать задеплоенным. `Disallow: /admin`
в `robots.txt` от этого не защищает: он адресован поисковым роботам, а не
человеку и не сканеру.

⚠️ Кука сессии CMS в образе всегда `Secure` (условие вычислено на билде, см.
`src/collections/Users.ts`). Поэтому вход в `/admin` на стенде **по http и по
IP** не сработает — браузер такую куку не вернёт. Открывайте админку по TLS
либо через `http://localhost:3000` / ssh-туннель: localhost браузеры считают
доверенным origin'ом.

Если стенд уже публично доступен, а первого пользователя ещё нет — быстрее
всего закрыть окно, временно сняв публикацию порта (или направив домен в
заглушку), создать пользователя через локальный доступ и вернуть публикацию.

---

## Контент

- Коллекции: `pages` (лендинг и текстовые страницы; `slug: home` = `/`),
  `posts` (блог), `media` (картинки), `users` (редакторы CMS).
- Globals: `header`, `pricing`, `footer`.
- Блоки лендинга — поле `pages.layout`: `hero`, `features`, `how-it-works`,
  `pricing`, `faq`, `cta`. Конфиг поля — `src/blocks/*/config.ts`, рендер —
  `src/blocks/*/Component.tsx`, диспетчер — `src/lib/blockRenderer.tsx`.
  Блок `pricing` собственных полей не имеет: карточки берутся из global
  `pricing`, чтобы цены жили в одном месте.
- Ссылки на кабинет строятся в `src/lib/links.ts` из `NEXT_PUBLIC_APP_URL`
  (`/panel/register`, `/panel/login`). В контенте CMS доменов кабинета нет и
  быть не должно — иначе после переезда стенда кнопки уведут не туда.
- SEO: `/robots.txt` (`src/app/(frontend)/robots.ts`, `/admin` закрыт от
  индексации) и `/sitemap.xml` (страницы из Payload, `home` → `/`).

### Сид стартового контента

`POST /api/seed` пересоздаёт домашнюю страницу и перезаписывает globals.
Роут **деструктивен** и закрыт двумя условиями сразу — иначе отвечает 404:

```bash
# в окружении сервиса: ENABLE_SEED_ROUTES=1
curl -X POST localhost:3000/api/seed -H "x-seed-secret: $PAYLOAD_SECRET"
```

После первичного засева флаг снимают. Тексты — `src/seed/landing.ts`.

---

## Публичный репозиторий

Тексты лендинга, тарифы и FAQ лежат в открытом коде (`src/seed/landing.ts`).
Перед коммитом контента перечитайте его глазами конкурента: никакой
себестоимости, внутренних коэффициентов, неанонсированных планов и упоминаний
внутреннего устройства (ядро, его домены). Секреты — только через `secrets.*`
в CI и `.env` на стенде; в `.env.example` — плейсхолдеры.
