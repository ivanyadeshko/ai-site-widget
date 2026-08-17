#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# release.sh — деплой виджета с бэкапом, health-гейтом и откатом.
#
# Заменяет infra/deploy.sh (rsync исходников + сборка на месте). Интерфейс
# подкоманд общий для трёх репозиториев программы распила:
#
#   preflight            — диск/иноды, .env, сеть ядра, compose config, образ
#   backup               — pg_dump -Fc + верификация pg_restore + ретенция
#   apply                — пин тега → pull → up --no-build → миграции → health
#   health               — /healthz BFF
#   rollback --to TAG    — вернуться на предыдущий образ
#   status [--json]      — что сейчас раскатано
#   commit --tag T       — зафиксировать успешный деплой в истории
#
# Чем это отличается от infra/deploy.sh, который заменяет:
#
#   1. Никакого rsync исходников. Код едет ОБРАЗОМ из GHCR (release.yml).
#      Старая схема собирала образ на сервере из залитого дерева: артефакта
#      не оставалось, откатываться было не на что, и деплоился не тот образ,
#      что проверял CI.
#   2. `up -d --no-build`. `build:` в compose оставлен для локальной
#      разработки, и на стенде он опасен: голый `up` с несуществующим тегом
#      НЕ падает — он молча собирает образ из рабочего дерева и вешает на него
#      запрошенный тег, то есть катит чужой код под видом успешного деплоя.
#   3. Бэкап БД до миграций, с проверкой pg_restore. У виджета своя БД
#      (site_widget) с диалогами и лимитами визитёров — терять её нельзя.
#   4. Откат одной командой вместо «собери предыдущий коммит заново».
#
# Специфика виджета:
#   • BFF присоединён к ВНЕШНЕЙ сети ядра (conversation-core_default). Её
#     отсутствие — не «предупреждение», а гарантированный отказ `up`, поэтому
#     preflight проверяет сеть до того, как тронуть стенд.
#   • Миграции — node-pg-migrate через exec в backend, после `up`.
#
# Env: REPO_DIR (авто), IMAGE_TAG, WIDGET_HEALTH_URL, BACKUP_RETAIN, IMAGE_OWNER.
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BACKUP_RETAIN="${BACKUP_RETAIN:-10}"
STATE_FILE="$REPO_DIR/.deploy-state"
HISTORY_FILE="$REPO_DIR/.deploy-history"
BACKUP_DIR="$REPO_DIR/backups"
# Тот же файл, что у монолита и ядра: на дев-ВМ три стенда делят хост,
# а concurrency GitHub Actions границы репозиториев не пересекает.
LOCK_FILE="/var/lock/aski-deploy.lock"

cd "$REPO_DIR"

# ── общие хелперы ─────────────────────────────────────────────────────

die() { echo "❌ $*" >&2; exit 1; }
info() { echo "→ $*"; }

env_get() { sed -n "s|^$1=||p" .env 2>/dev/null | tail -1; }

state_set() {
    local key="$1" val="$2" tmp
    tmp="$(mktemp "${STATE_FILE}.XXXXXX")"
    if [ -f "$STATE_FILE" ]; then grep -v "^${key}=" "$STATE_FILE" > "$tmp" || true; fi
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$STATE_FILE"
}

state_get() {
    [ -f "$STATE_FILE" ] || return 0
    sed -n "s|^$1=||p" "$STATE_FILE" | tail -1
}

# Источник истины — .env, а не .deploy-state: руками сделанный `up -d`
# состояние не обновляет.
current_tag_from_env() { env_get IMAGE_TAG; }

pin_tag() {
    local tag="$1"
    if grep -q '^IMAGE_TAG=' .env 2>/dev/null; then
        sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${tag}|" .env
    else
        printf '\nIMAGE_TAG=%s\n' "$tag" >> .env
    fi
    # WIDGET_IMAGE переопределяет всю ссылку целиком и делает IMAGE_TAG
    # безмолвно бесполезным (compose: ${WIDGET_IMAGE:-ghcr.io/…:${IMAGE_TAG}}).
    # Наследие локальной сборки — вычищаем, иначе деплой «проходит», а образ
    # остаётся прежним.
    if grep -q '^WIDGET_IMAGE=' .env 2>/dev/null; then
        sed -i '/^WIDGET_IMAGE=/d' .env
        info "убрал WIDGET_IMAGE из .env — он перекрывал бы IMAGE_TAG"
    fi
    # То же про контекст сборки: со схемой «образ из реестра» он не нужен,
    # а его присутствие намекает, что стенд ещё на сборке из исходников.
    if grep -q '^WIDGET_BUILD_CONTEXT=' .env 2>/dev/null; then
        sed -i '/^WIDGET_BUILD_CONTEXT=/d' .env
        info "убрал WIDGET_BUILD_CONTEXT из .env — деплой больше не собирает на месте"
    fi
}

wait_healthy() {
    local budget="${1:-300}" waited=0 name state health bad
    while [ "$waited" -lt "$budget" ]; do
        bad=""
        while IFS=$'\t' read -r name state health; do
            [ -n "$name" ] || continue
            case "$state" in
                running)
                    if [ -n "$health" ] && [ "$health" != "healthy" ]; then
                        bad="${bad}${name}(${health}) "
                    fi ;;
                exited)
                    if ! docker inspect "$name" --format '{{.State.ExitCode}}' 2>/dev/null | grep -qx 0; then
                        die "контейнер $name завершился с ненулевым кодом (см. docker logs $name)"
                    fi ;;
                *) bad="${bad}${name}(${state}) " ;;
            esac
        done < <(docker compose ps --all --format '{{.Name}}\t{{.State}}\t{{.Health}}' 2>/dev/null)

        if [ -z "$bad" ]; then
            info "стек сошёлся за ${waited}с"
            return 0
        fi
        sleep 5; waited=$((waited + 5))
    done
    die "стек не сошёлся за ${budget}с, не готовы: $bad"
}

acquire_lock() {
    # ОСТОРОЖНО: `exec 9>файл 2>/dev/null` перенаправляет stderr ВСЕГО скрипта
    # в /dev/null (exec без команды меняет дескрипторы самой оболочки), после
    # чего все die-сообщения исчезают — скрипт падает молча. Поймано на деве
    # 2026-08-17. Поэтому доступность проверяем заранее и отдельно.
    if ! : >>"$LOCK_FILE" 2>/dev/null; then
        info "нет доступа к $LOCK_FILE — продолжаем без межсервисной блокировки"
        return 0
    fi
    exec 9>>"$LOCK_FILE"
    flock -w 900 9 || die "другой деплой держит хост дольше 15 минут"
}

health_url() { printf '%s' "${WIDGET_HEALTH_URL:-http://localhost:8200/healthz}"; }

# ── preflight ─────────────────────────────────────────────────────────

cmd_preflight() {
    echo "═══ preflight ═══"

    [ -f "$REPO_DIR/.env" ] || die ".env не найден в $REPO_DIR (заполняется из infra/.env.example, chmod 600)"
    [ -f "$REPO_DIR/compose.yaml" ] || die "compose.yaml не найден"

    local use_pct inode_pct
    use_pct=$(df --output=pcent /var/lib/docker 2>/dev/null | tail -1 | tr -dc '0-9')
    inode_pct=$(df --output=ipcent /var/lib/docker 2>/dev/null | tail -1 | tr -dc '0-9')
    [ -n "$use_pct" ] || die "не смог прочитать df — fail-closed"
    [ "$use_pct" -lt 90 ] || die "диск занят на ${use_pct}% — деплой не начинаем"
    if [ -n "$inode_pct" ] && [ "$inode_pct" -ge 90 ]; then
        die "иноды заняты на ${inode_pct}% — деплой не начинаем"
    fi
    info "диск ${use_pct}%, иноды ${inode_pct:-н/д}%"

    # Внешняя сеть ядра. Её отсутствие роняет `up` — но уже ПОСЛЕ того, как
    # мы подменили тег в .env, то есть в состоянии «наполовину задеплоено».
    local net
    net="$(env_get CORE_NETWORK)"; net="${net:-conversation-core_default}"
    docker network inspect "$net" >/dev/null 2>&1 \
        || die "внешняя сеть '$net' не существует — стек ядра не поднят? BFF без неё не стартует"
    info "сеть ядра '$net' на месте"

    docker compose config --quiet || die "compose.yaml невалиден или в .env не хватает обязательных переменных"

    if [ -n "${IMAGE_TAG:-}" ]; then
        local owner
        owner="$(env_get IMAGE_OWNER)"; owner="${owner:-${IMAGE_OWNER:-ivanyadeshko}}"
        docker manifest inspect "ghcr.io/${owner}/site-widget-backend:${IMAGE_TAG}" >/dev/null 2>&1 \
            || die "образ site-widget-backend:${IMAGE_TAG} недоступен в ghcr (нет тега или docker login протух)"
        info "образ ${IMAGE_TAG} найден в реестре"
    fi

    echo "✅ preflight пройден"
}

# ── backup ────────────────────────────────────────────────────────────

cmd_backup() {
    echo "═══ backup БД ═══"
    mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"

    local file tmp_in size
    file="$BACKUP_DIR/pre-${IMAGE_TAG:-manual}-$(date -u +%Y%m%dT%H%M%SZ).dump"
    tmp_in="/tmp/release-backup-$$.dump"

    # Пользователь и БД зашиты в compose (widget/site_widget), а не в .env —
    # берём их оттуда же, чтобы не завести вторую точку правды.
    docker compose exec -T widget-db sh -c \
        "pg_dump -U widget -d site_widget -Fc -f '$tmp_in'" \
        || die "pg_dump не отработал"

    # Дамп, который никто не пробовал прочитать, дампом не является.
    # --list для custom-формата требует seekable-вход, поэтому файл, не пайп.
    docker compose exec -T widget-db pg_restore --list "$tmp_in" >/dev/null \
        || { docker compose exec -T widget-db rm -f "$tmp_in" || true; die "дамп не читается pg_restore"; }

    docker compose cp "widget-db:$tmp_in" "$file" || die "не смог забрать дамп из контейнера"
    docker compose exec -T widget-db rm -f "$tmp_in" || true
    [ -s "$file" ] || die "дамп пустой: $file"

    size=$(du -h "$file" | cut -f1)
    info "бэкап готов: $(basename "$file") ($size), проверен pg_restore"
    state_set BACKUP_FILE "backups/$(basename "$file")"

    ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | tail -n "+$((BACKUP_RETAIN + 1))" | xargs -r rm -f
    info "в каталоге $(ls -1 "$BACKUP_DIR"/*.dump 2>/dev/null | wc -l) дампов (лимит $BACKUP_RETAIN)"
}

# ── apply ─────────────────────────────────────────────────────────────

cmd_apply() {
    acquire_lock
    echo "═══ apply${IMAGE_TAG:+ → $IMAGE_TAG} ═══"

    [ -n "${IMAGE_TAG:-}" ] || die "IMAGE_TAG обязателен"

    local prev
    prev="$(current_tag_from_env)"
    if [ -n "$prev" ] && [ "$prev" != "$IMAGE_TAG" ]; then
        state_set PREVIOUS_TAG "$prev"
        info "предыдущий тег зафиксирован: $prev"
    fi

    pin_tag "$IMAGE_TAG"

    echo "── prune перед pull ──"
    docker container prune -f >/dev/null
    # НЕ `image prune -a -f`: он сносит образ, на который мы будем откатываться.
    # На этом хосте живут ещё и образы ядра с Аски-девом — until=72h щадит и их.
    docker image prune -a -f --filter "until=72h" >/dev/null
    docker builder prune -a -f >/dev/null

    echo "── pull ──"
    local ok=""
    for attempt in 1 2 3; do
        if docker compose pull; then ok=1; break; fi
        echo "⚠️  pull не удался (попытка $attempt/3), повтор через 10с…"
        sleep 10
    done
    [ -n "$ok" ] || die "pull не удался после 3 попыток"

    echo "── up -d --no-build ──"
    docker compose up -d --no-build || die "up -d не отработал"

    echo "── миграции (node-pg-migrate) ──"
    local waited=0
    until docker compose exec -T backend true >/dev/null 2>&1; do
        [ "$waited" -lt 60 ] || die "backend не поднялся за 60с — миграции накатить некуда"
        sleep 2; waited=$((waited + 2))
    done
    docker compose exec -T backend npx --no-install node-pg-migrate -m backend/migrations up \
        || die "миграции не накатились"

    wait_healthy 300

    # `up -d` без --force-recreate умеет оставить старый контейнер живым —
    # тогда деплой «прошёл», а код старый.
    local wrong
    wrong=$(docker compose ps --format '{{.Image}}' 2>/dev/null \
            | grep 'site-widget-backend' | grep -v ":${IMAGE_TAG}$" || true)
    [ -z "$wrong" ] || die "на стенде остались контейнеры не на ${IMAGE_TAG}:\n$wrong"
    info "backend на ${IMAGE_TAG}"

    state_set CURRENT_TAG "$IMAGE_TAG"
    state_set DEPLOYED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "✅ apply завершён"
}

# ── health ────────────────────────────────────────────────────────────

cmd_health() {
    local url; url="$(health_url)"
    echo "═══ health $url ═══"
    local code i
    for i in $(seq 1 30); do
        code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)
        if [ "$code" = "200" ]; then
            echo "✅ healthy (попытка $i)"
            return 0
        fi
        sleep 5
    done
    die "$url не отдал 200 за 150с (последний код: $code)"
}

# ── rollback ──────────────────────────────────────────────────────────

cmd_rollback() {
    acquire_lock
    local to="${1:-}"
    [ -n "$to" ] || to="$(state_get PREVIOUS_TAG)"
    [ -n "$to" ] || die "нет предыдущего тега — откат невозможен, нужен ручной разбор"

    echo "═══ ОТКАТ на $to ═══"
    pin_tag "$to"

    docker compose pull || info "pull не прошёл, надеемся на локальный кэш"
    docker compose up -d --no-build \
        || die "откат не поднялся — стенд в неопределённом состоянии, нужен ручной разбор"
    wait_healthy 300

    state_set CURRENT_TAG "$to"
    state_set ROLLED_BACK_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '%s rollback → %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$to" >> "$HISTORY_FILE"

    echo "⚠️  ОТКАТ ВЫПОЛНЕН на $to."
    echo "    ВНИМАНИЕ: схема БД НЕ откатывалась. Инвариант программы —"
    echo "    предыдущий образ обязан работать на новой схеме."
    echo "    Если релиз содержал деструктивную миграцию — нужен ручной restore"
    echo "    из $(state_get BACKUP_FILE)."
}

# ── status / commit ───────────────────────────────────────────────────

cmd_status() {
    local cur prev
    cur="$(current_tag_from_env)"
    prev="$(state_get PREVIOUS_TAG)"
    if [ "${1:-}" = "--json" ]; then
        printf '{"current_tag":"%s","previous_tag":"%s","deployed_at":"%s","backup":"%s"}\n' \
            "$cur" "$prev" "$(state_get DEPLOYED_AT)" "$(state_get BACKUP_FILE)"
    else
        echo "current:  ${cur:-?}"
        echo "previous: ${prev:-—}"
        echo "deployed: $(state_get DEPLOYED_AT)"
        echo "backup:   $(state_get BACKUP_FILE)"
    fi
}

cmd_commit() {
    local tag="${1:-$IMAGE_TAG}" run="${2:-manual}"
    state_set CURRENT_TAG "$tag"
    state_set DEPLOYED_BY "$run"
    printf '%s deploy → %s (%s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tag" "$run" >> "$HISTORY_FILE"
    info "деплой зафиксирован: $tag"
}

# ── диспетчер ─────────────────────────────────────────────────────────

case "${1:-}" in
    preflight) cmd_preflight ;;
    backup)    cmd_backup ;;
    apply)     cmd_apply ;;
    health)    cmd_health ;;
    rollback)  shift
               # Явный if, а не `[ ... ] && shift`: под set -e ложное условие
               # в && -списке роняет весь скрипт с кодом 1 ещё до вызова функции
               # (поймано на деве 2026-08-17 — откат «падал» молча).
               if [ "${1:-}" = "--to" ]; then shift; fi
               cmd_rollback "${1:-}" ;;
    status)    shift; cmd_status "${1:-}" ;;
    commit)    shift
               tag=""; run=""
               while [ $# -gt 0 ]; do
                   case "$1" in
                       --tag) tag="$2"; shift 2 ;;
                       --run) run="$2"; shift 2 ;;
                       *) shift ;;
                   esac
               done
               cmd_commit "${tag:-${IMAGE_TAG:-}}" "${run:-manual}" ;;
    *)
        cat >&2 <<EOF
Использование: release.sh <команда>

  preflight            проверить хост, сеть ядра и наличие образа
  backup               дамп БД с верификацией
  apply                выкатить IMAGE_TAG
  health               дождаться /healthz
  rollback [--to TAG]  откатить на предыдущий образ
  status [--json]      что раскатано
  commit --tag T       зафиксировать успех
EOF
        exit 2 ;;
esac
