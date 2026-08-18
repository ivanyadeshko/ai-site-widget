# Образ лендинга vell.pro (Payload CMS 3 + Next.js standalone).
# Контекст сборки — КАТАЛОГ site/, а не корень репозитория: site/ — отдельный
# npm-проект со своим package-lock.json (см. решение D-10 плана), в общий
# workspace он не входит и в образ BFF (infra/Dockerfile) не попадает.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --legacy-peer-deps обязателен: дерево Payload 3 + Next 16 + React 19 не
# сходится по peer-диапазонам, обычный npm ci падает на резолве.
RUN npm ci --legacy-peer-deps

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
# NEXT_PUBLIC_* инлайнятся в бандл на этапе build, а не читаются в рантайме.
# Дефолтов здесь НЕТ: домен задаётся только окружением (build-arg из CI или
# compose build из .env).
ARG NEXT_PUBLIC_SERVER_URL
ENV NEXT_PUBLIC_SERVER_URL=$NEXT_PUBLIC_SERVER_URL
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
# Fail-fast. Пусто → ссылки лендинга («Начать бесплатно» → кабинет) и
# canonical/sitemap запеклись бы пустыми, и поломка всплыла бы только у
# посетителя: CI зелёный, кнопка ведёт в никуда. Валим сборку сразу.
RUN test -n "$NEXT_PUBLIC_SERVER_URL" || { echo "BUILD ERROR: NEXT_PUBLIC_SERVER_URL build-arg is required (GH var SITE_PUBLIC_URL / infra/.env)"; exit 1; }
RUN test -n "$NEXT_PUBLIC_APP_URL"    || { echo "BUILD ERROR: NEXT_PUBLIC_APP_URL build-arg is required (GH var SITE_APP_URL / infra/.env)"; exit 1; }
RUN npm run build
# Payload CLI (миграции) читает НЕ payload.config.ts, а собранный
# payload.config.mjs: без этого шага `npm run migrate` в контейнере падает на
# резолве конфига, и one-shot site-migrate валит весь профиль.
RUN npm run build:payload-config

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# node_modules из deps (а не срез standalone): в runner живёт ещё и Payload
# CLI, которым one-shot site-migrate катает миграции.
COPY --from=deps    /app/node_modules ./node_modules
# package.json/lock — источник скриптов `payload` и `migrate`.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# src — коллекции, globals и файлы миграций, которые импортирует конфиг.
COPY --from=builder /app/src ./src
# .mjs читает CLI (PAYLOAD_CONFIG_PATH), .ts оставляем рядом: часть импортов
# Payload/Next резолвится на исходник, и его отсутствие всплывает в рантайме.
COPY --from=builder /app/payload.config.ts ./payload.config.ts
COPY --from=builder /app/payload.config.mjs ./payload.config.mjs
EXPOSE 3000
CMD ["node", "server.js"]
