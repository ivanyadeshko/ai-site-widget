# e2e — Playwright витрины `vell.pro`

Отдельный npm-проект (НЕ воркспейс, D-11): `@playwright/test` тянет браузеры
postinstall'ом, в корневом `npm ci` это било бы по каждому backend/embed/panel.

## Проекты Playwright

| Проект | Ядро | В CI-гейте? | Жжёт кредиты? | Что проверяет |
|---|---|---|---|---|
| `panel` | fake-core (герметично) | **да** (обязателен, в т.ч. форк-PR) | нет | весь путь панели: регистрация → виджет → сниппет → кнопка на «чужом» сайте → тема → лид → CSV → цифры использования (деньги сводит подписанный вебхук `session.finalized`) |
| `acceptance` | **живое** дев-ядро | нет (D-14) | **да** | тот же путь + живой ответ агента в чате; деньги приходят АСИНХРОННО (`expect.poll`) |
| `voice` | **живое** дев-ядро | нет (D-14) | **да** | структурные ассерты голоса: панель, индикатор микрофона, реплика `source='core'` |

`acceptance`/`voice` НЕ входят в CI: репозиторий публичный, на форк-PR секретов
нет (Constraint 3в), а чат-канал виджета идёт через LiveKit data-channel и без
живого ядра физически не поднимается. Гейт CI честно проверяет то, что может.

## Герметичный прогон (проект `panel`)

```bash
# из корня репозитория — образ BFF собирается из infra/Dockerfile
docker compose -f e2e/compose.e2e.yaml up -d --build --wait
cd e2e
npm ci
npx playwright install --with-deps chromium   # только chromium
npx playwright test --project=panel
docker compose -f compose.e2e.yaml down -v     # из каталога e2e
```

Стек: `widget-db` + one-shot `migrate` + `backend` (образ `infra/Dockerfile`) +
`fake-core`. Ядра здесь НЕТ — его подменяет `fake-core/server.mjs` на голом
`node:http`. Порты на хост: `backend` — `8200`, `fake-core` — `8100` (служебную
ручку `POST /__test__/finalize` тест дёргает снаружи).

## Приёмка E (проекты `acceptance` и `voice`, живое ядро)

⚠️ **Жгут кредиты тенанта ядра** (как и смоки 1–5). Гонять осознанно, следить
за балансом через `GET /api/v1/admin/core/credits`.

```bash
# стек с CORE_BASE_URL на дев-ядро уже поднят и доступен по E2E_BASE_URL
E2E_BASE_URL=http://localhost:8200 npx playwright test --project=acceptance
E2E_BASE_URL=http://localhost:8200 npx playwright test --project=voice
```

`voice` использует fake-media Chromium (`--use-fake-device-for-media-stream`).
Проверить, что «аватар понял сказанное», браузером нельзя — это остаётся ручным
чек-листом в корневом `README.md` (раздел живого звонка), ссылка — в шапке
`tests/voice.spec.ts`.
