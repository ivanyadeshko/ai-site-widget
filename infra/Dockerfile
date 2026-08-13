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
