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
