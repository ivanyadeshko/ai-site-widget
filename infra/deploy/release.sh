#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# release.sh — деплой виджета с бэкапом, health-гейтом и откатом.
#
# Заменяет infra/deploy.sh (rsync исходников + сборка на месте). Интерфейс
# подкоманд общий для трёх репозиториев программы распила:
#
#   preflight            — диск/иноды, .env, сеть ядра (только в режиме
#                          attached), TRUST_PROXY, compose config, образ
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
#   • Сетевой режим стенда задаётся COMPOSE_FILE в .env. В режиме `attached`
#     (стенд рядом с ядром) в COMPOSE_FILE перечислен compose.core-network.yaml,
#     BFF входит во ВНЕШНЮЮ сеть ядра, и её отсутствие — не «предупреждение», а
#     гарантированный отказ `up`: preflight проверяет сеть до того, как тронуть
#     стенд. В режиме `public` (прод витрины, ядро за HTTPS) сети нет вовсе, и
#     проверка пропускается — иначе прод было бы не задеплоить в принципе.
#   • Миграции — node-pg-migrate через exec в backend, после `up`.
#
#   • Лендинг (профиль `site`, образ vell-site) — второй сервис того же
#     релиза: preflight сверяет и его тег в реестре, health опрашивает и его.
#     Включённость профиля берётся из COMPOSE_PROFILES в .env.
#
# Env: REPO_DIR (авто), IMAGE_TAG, WIDGET_HEALTH_URL, SITE_HEALTH_URL,
#      BACKUP_RETAIN, IMAGE_OWNER.
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

# printf '%b', а не echo: в сообщения подставляются многострочные списки, и
# `echo` печатал в них `\n` буквально — каша ровно в момент инцидента.
die() { printf '❌ %b\n' "$*" >&2; exit 1; }
info() { printf '→ %b\n' "$*"; }

# Значение ключа из .env. Кавычки снимаются, `|| true` обязателен: иначе
# отсутствие .env роняет скрипт молча через pipefail.
env_get() {
    { sed -n "s|^$1=||p" .env 2>/dev/null | tail -1 \
        | sed -e 's|^"\(.*\)"$|\1|' -e "s|^'\(.*\)'$|\1|"; } || true
}

# Сервисы, обязанные присутствовать в выдаче `docker compose ps`. Нужны
# отдельным списком, потому что проверки построены по принципу «нет плохих
# строк = хорошо», а он не отличает «проверили, всё чисто» от «данных не
# получили вовсе». Найдено кросс-ревью 2026-08-17.
WIDGET_SERVICES="backend widget-db"

# Формат тега — единственный вход снаружи (input workflow). Валидируем
# fail-closed: дальше тег идёт в sed по .env и уезжает в удалённый shell,
# где строка парсится заново. Символы `;`, `&`, `|`, `$(` означают
# исполнение произвольного кода на стенде. Найдено кросс-ревью 2026-08-17.
validate_tag() {
    local t="${1:-}"
    [ -n "$t" ] || die "тег пуст"
    case "$t" in
        latest) return 0 ;;
        sha-*)
            printf '%s' "$t" | grep -qE '^sha-[0-9a-f]{7,40}$' \
                || die "тег '$t' не соответствует формату sha-XXXXXXX" ;;
        *) die "тег '$t' недопустим: ожидается sha-XXXXXXX или latest" ;;
    esac
}

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

state_unset() {
    [ -f "$STATE_FILE" ] || return 0
    local tmp
    tmp="$(mktemp "${STATE_FILE}.XXXXXX")"
    grep -v "^$1=" "$STATE_FILE" > "$tmp" || true
    chmod 600 "$tmp"
    mv "$tmp" "$STATE_FILE"
}

# Источник истины — .env, а не .deploy-state: руками сделанный `up -d`
# состояние не обновляет.
current_tag_from_env() { env_get IMAGE_TAG; }

pin_tag() {
    local tag="$1"
    validate_tag "$tag"

    if grep -q '^IMAGE_TAG=' .env 2>/dev/null; then
        sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${tag}|" .env
    else
        printf '\nIMAGE_TAG=%s\n' "$tag" >> .env
    fi

    # Убеждаемся, что записалось именно то, что просили: sed молчит, если
    # шаблон не совпал, и «успешный» pin оставил бы старый тег.
    local got; got="$(env_get IMAGE_TAG)"
    [ "$got" = "$tag" ] || die "IMAGE_TAG в .env не встал: '$got', ожидался '$tag'"
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
    local budget="${1:-300}" waited=0 name state health bad snapshot svc last_bad=""
    while [ "$waited" -lt "$budget" ]; do
        # Снимок берём ОТДЕЛЬНОЙ командой и НЕ глушим stderr. Раньше вывод
        # читался прямо из process substitution с `2>/dev/null`, и упавший
        # `docker compose ps` (занятый демон, отвалившийся `:?`-гард в .env,
        # смена формата --format) давал пустой список — то есть «нет плохих
        # контейнеров», то есть УСПЕХ. Особенно дорого это в откате, где
        # wait_healthy — единственная проверка: получалось «ОТКАТ ВЫПОЛНЕН»
        # при лежащем стенде. Найдено кросс-ревью 2026-08-17.
        if ! snapshot="$(docker compose ps --all --format '{{.Name}}\t{{.State}}\t{{.Health}}')"; then
            die "docker compose ps не отработал — состояние стека неизвестно (fail-closed)"
        fi
        [ -n "$snapshot" ] || die "docker compose ps вернул пустой список — стек не поднят?"

        for svc in $WIDGET_SERVICES; do
            printf '%s\n' "$snapshot" | grep -q -- "-${svc}-" \
                || die "сервиса '$svc' нет в выдаче docker compose ps — compose не тот или сервис не создан"
        done

        bad=""
        while IFS=$'\t' read -r name state health; do
            [ -n "$name" ] || continue
            case "$state" in
                running)
                    if [ -n "$health" ] && [ "$health" != "healthy" ]; then
                        bad="${bad}${name}(${health}) "
                    fi ;;
                exited)
                    # Не мгновенная смерть: даём restart-политике отработать,
                    # фатально только по исчерпании бюджета.
                    if ! docker inspect "$name" --format '{{.State.ExitCode}}' 2>/dev/null | grep -qx 0; then
                        bad="${bad}${name}(exited≠0) "
                    fi ;;
                *) bad="${bad}${name}(${state}) " ;;
            esac
        done <<EOF
$snapshot
EOF

        if [ -z "$bad" ]; then
            info "стек сошёлся за ${waited}с"
            return 0
        fi
        last_bad="$bad"
        sleep 5; waited=$((waited + 5))
    done
    die "стек не сошёлся за ${budget}с, не готовы: $last_bad"
}

acquire_lock() {
    # ОСТОРОЖНО: `exec 9>файл 2>/dev/null` перенаправляет stderr ВСЕГО скрипта
    # в /dev/null (exec без команды меняет дескрипторы самой оболочки), после
    # чего все die-сообщения исчезают — скрипт падает молча. Поймано на деве
    # 2026-08-17. Поэтому доступность проверяем заранее и отдельно.
    #
    # Порядок перенаправлений ЗНАЧИМ: `2>/dev/null` стоит ПЕРВЫМ. Bash
    # применяет их слева направо, и при `: >>файл 2>/dev/null` неудача
    # открытия файла происходит РАНЬШЕ, чем stderr будет заглушён, — текст
    # «Permission denied» утекал на терминал и читался как авария, хотя
    # ветка отрабатывала штатно (тоже поймано на деве 2026-08-17).
    if ! : 2>/dev/null >>"$LOCK_FILE"; then
        info "нет доступа к $LOCK_FILE — продолжаем без межсервисной блокировки"
        return 0
    fi
    exec 9>>"$LOCK_FILE"
    flock -w 900 9 || die "другой деплой держит хост дольше 15 минут"
}

health_url() { printf '%s' "${WIDGET_HEALTH_URL:-http://localhost:8200/healthz}"; }

# Лендинг на этом стенде включён? Правда одна — COMPOSE_PROFILES в .env
# (по нему compose и решает, существуют ли сервисы site*). Разбираем как
# список через запятую, а не `grep site`: подстрока совпала бы и с чужим
# профилем вроде `site-preview`, и стенд без лендинга получил бы лишние
# проверки и лишние die.
site_profile_enabled() {
    local profiles item
    profiles="$(env_get COMPOSE_PROFILES)"
    [ -n "$profiles" ] || return 1
    local IFS=','
    for item in $profiles; do
        item="$(printf '%s' "$item" | tr -d '[:space:]')"
        [ "$item" = "site" ] && return 0
    done
    return 1
}

site_health_url() { printf '%s' "${SITE_HEALTH_URL:-http://127.0.0.1:3000/api/health}"; }

# Стенд стоит РЯДОМ с ядром и входит в его docker-сеть? Правда одна —
# COMPOSE_FILE в .env: сеть возвращает в граф compose только override-файл
# compose.core-network.yaml, перечисленный там. Разбираем как список путей
# через `:` (разделитель самого compose), а не `grep`: подстрока совпала бы с
# закомментированной строкой или с чужим файлом вроде
# `compose.core-network.yaml.bak`, и стенд в режиме `public` получил бы
# требование несуществующей сети — то есть отказ деплоя на ровном месте.
#
# Побочный эффект намеренный: путь найденного override'а кладётся в
# CORE_NETWORK_OVERRIDE, чтобы preflight проверил наличие ИМЕННО ТОГО файла,
# на который ссылается .env (он может лежать и в подкаталоге), а не угаданного.
CORE_NETWORK_OVERRIDE=""
core_network_mode_attached() {
    local files item
    CORE_NETWORK_OVERRIDE=""
    files="$(env_get COMPOSE_FILE)"
    [ -n "$files" ] || return 1
    local IFS=':'
    for item in $files; do
        item="$(printf '%s' "$item" | tr -d '[:space:]')"
        if [ "$(basename "$item")" = "compose.core-network.yaml" ]; then
            CORE_NETWORK_OVERRIDE="$item"
            return 0
        fi
    done
    return 1
}

# Гард TRUST_PROXY (гэп 9 разведки). За реверс-прокси req.ip у Fastify — это
# адрес ПРОКСИ, один и тот же для всех посетителей, пока TRUST_PROXY=1 не
# разрешит верить X-Forwarded-For (backend/src/config.ts, app.ts). Последствие
# не косметическое: суточный IP-кап (MAX_DIALOGS_PER_IP_PER_DAY) схлопывает
# всех клиентов в ОДИН бакет и начинает валить живых посетителей 429 после
# первых же шестидесяти диалогов на весь сайт.
#
# Почему `die`, а не warning: диагностический warn в приложении уже есть
# (backend/src/routes/publicApi.ts, разовый лог «X-Forwarded-For пришёл, но
# TRUST_PROXY выключен»), и он ровно эту ситуацию замечает — но только в
# логах, которые в момент инцидента никто не читает.
#
# Признак «мы за прокси» — https в origin'ах: TLS у BFF не терминируется
# никогда (он слушает голый :8200), значит https в публичном адресе означает
# ровно одно — впереди стоит прокси.
# Смотрим на ВСЕ четыре origin-переменные, а не только на app/public: смешанная
# раскладка (http app + https panel) — это всё равно «где-то впереди стоит
# прокси», и IP-кап ломается там одинаково (находка кросс-ревью).
check_trust_proxy() {
    local trust key value https_origin=""
    trust="$(env_get TRUST_PROXY)"
    for key in WIDGET_APP_ORIGIN WIDGET_PUBLIC_ORIGIN WIDGET_PANEL_ORIGIN WIDGET_CDN_ORIGIN; do
        value="$(env_get "$key")"
        case "$value" in
            https://*) https_origin="$key=$value"; break ;;
        esac
    done
    if [ -n "$https_origin" ]; then
        [ "$trust" = "1" ] || die "$https_origin — https, а TRUST_PROXY='${trust:-не задан}': за реверс-прокси без TRUST_PROXY=1 IP-кап схлопнет всех клиентов в один бакет и начнёт валить живых посетителей 429.\n   Починка: TRUST_PROXY=1 в .env стенда — и убедиться, что прокси действительно ставит X-Forwarded-For (иначе кап станет обходиться заголовком)."
        info "TRUST_PROXY=1 при https-раскладке ($https_origin) — IP-кап считает по X-Forwarded-For"
    else
        info "https-origin в .env нет — стенд слушает напрямую, доверие прокси не требуется"
    fi
}

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

    # Внешняя сеть ядра — ТОЛЬКО в режиме `attached`. Признак режима один:
    # override-файл compose.core-network.yaml в COMPOSE_FILE из .env стенда
    # (он же единственное, что возвращает сеть в граф compose). В режиме
    # `public` (прод витрины, ядро за HTTPS) сети нет и быть не должно —
    # безусловная проверка здесь делала деплой прода невозможным.
    #
    # Её отсутствие в режиме `attached` роняет `up` — но уже ПОСЛЕ того, как
    # мы подменили тег в .env, то есть в состоянии «наполовину задеплоено».
    if core_network_mode_attached; then
        local net
        net="$(env_get CORE_NETWORK)"; net="${net:-conversation-core_default}"
        docker network inspect "$net" >/dev/null 2>&1 \
            || die "внешняя сеть '$net' не существует — стек ядра не поднят? BFF без неё не стартует"
        info "сеть ядра '$net' на месте"
        # Путь берём ровно тот, что стоит в COMPOSE_FILE: относительный
        # разрешается от каталога стека (compose делает так же), абсолютный —
        # как есть.
        local override="$CORE_NETWORK_OVERRIDE"
        case "$override" in /*) ;; *) override="$REPO_DIR/$override" ;; esac
        [ -f "$override" ] \
            || die "COMPOSE_FILE ссылается на '$CORE_NETWORK_OVERRIDE', но файла нет ($override) — compose упадёт «no such file» на КАЖДОЙ команде, включая rollback; файл кладёт шаг «Sync deploy assets» деплоя"
    else
        info "сетевой режим public — внешняя сеть ядра не требуется"
    fi

    check_trust_proxy

    docker compose config --quiet || die "compose.yaml невалиден или в .env не хватает обязательных переменных"

    if [ -n "${IMAGE_TAG:-}" ]; then
        local owner
        owner="$(env_get IMAGE_OWNER)"; owner="${owner:-${IMAGE_OWNER:-ivanyadeshko}}"
        docker manifest inspect "ghcr.io/${owner}/site-widget-backend:${IMAGE_TAG}" >/dev/null 2>&1 \
            || die "образ site-widget-backend:${IMAGE_TAG} недоступен в ghcr (нет тега или docker login протух)"
        info "образ ${IMAGE_TAG} найден в реестре"

        # Лендинг едет ОТДЕЛЬНЫМ образом (vell-site), публикуемым той же
        # джобой релиза. На стенде с профилем `site` его отсутствие всплыло бы
        # только на `pull` внутри apply — то есть уже ПОСЛЕ подмены тега в
        # .env, в состоянии «наполовину задеплоено», ровно от которого этот
        # preflight и защищает backend. Стенд без профиля проверку не делает:
        # образ ему не нужен, и требовать его там — ложный отказ деплоя.
        if site_profile_enabled; then
            docker manifest inspect "ghcr.io/${owner}/vell-site:${IMAGE_TAG}" >/dev/null 2>&1 \
                || die "образ vell-site:${IMAGE_TAG} недоступен в ghcr, а профиль site включён (нет тега или docker login протух)"
            info "образ лендинга vell-site:${IMAGE_TAG} найден в реестре"
        fi
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
    # `docker compose cp` кладёт файл по umask — на деве вышло 644. Каталог
    # закрыт (700), но дамп несёт переписку посетителей и лиды с телефонами:
    # закрываем и его, чтобы права не зависели от umask запускающего.
    chmod 600 "$file"

    size=$(du -h "$file" | cut -f1)
    info "бэкап готов: $(basename "$file") ($size), проверен pg_restore"
    state_set BACKUP_FILE "backups/$(basename "$file")"

    ls -1t "$BACKUP_DIR"/pre-*.dump 2>/dev/null | tail -n "+$((BACKUP_RETAIN + 1))" | xargs -r rm -f
    info "в каталоге $(ls -1 "$BACKUP_DIR"/pre-*.dump 2>/dev/null | wc -l) дампов (лимит $BACKUP_RETAIN)"

    # ── БД лендинга (compose-профиль `site`) ──────────────────────────
    # Контент CMS — тоже данные, и терять их деплоем нельзя. Условно: на
    # стенде без профиля `site` сервиса site-db просто нет, и это не ошибка.
    # `ps --services --all` перечисляет сервисы всех профилей, поэтому
    # проверяем не «объявлен ли сервис», а «есть ли у него контейнер».
    if ! docker compose ps --services --all 2>/dev/null | grep -qx 'site-db'; then
        info "site-db не поднят (профиль site выключен) — бэкап лендинга пропущен"
        return 0
    fi

    local site_file site_tmp site_size
    site_file="$BACKUP_DIR/site-pre-${IMAGE_TAG:-manual}-$(date -u +%Y%m%dT%H%M%SZ).dump"
    site_tmp="/tmp/release-backup-site-$$.dump"

    # Пользователь и БД зашиты в compose (site/vell_site) — та же логика
    # единственной точки правды, что и у widget-db выше.
    docker compose exec -T site-db sh -c \
        "pg_dump -U site -d vell_site -Fc -f '$site_tmp'" \
        || die "pg_dump site-db не отработал"

    docker compose exec -T site-db pg_restore --list "$site_tmp" >/dev/null \
        || { docker compose exec -T site-db rm -f "$site_tmp" || true; die "дамп site-db не читается pg_restore"; }

    docker compose cp "site-db:$site_tmp" "$site_file" || die "не смог забрать дамп site-db из контейнера"
    docker compose exec -T site-db rm -f "$site_tmp" || true
    [ -s "$site_file" ] || die "дамп site-db пустой: $site_file"
    chmod 600 "$site_file"

    site_size=$(du -h "$site_file" | cut -f1)
    info "бэкап лендинга готов: $(basename "$site_file") ($site_size), проверен pg_restore"

    # Ретенция считается ОТДЕЛЬНО по маске: общий счётчик вымывал бы дампы
    # виджета вдвое быстрее, стоило появиться второй базе.
    ls -1t "$BACKUP_DIR"/site-pre-*.dump 2>/dev/null | tail -n "+$((BACKUP_RETAIN + 1))" | xargs -r rm -f
}

# ── apply ─────────────────────────────────────────────────────────────

cmd_apply() {
    echo "═══ apply${IMAGE_TAG:+ → $IMAGE_TAG} ═══"

    # Валидация — ДО acquire_lock: всё, что может отказать до касания стенда,
    # обязано отказывать как можно раньше.
    [ -n "${IMAGE_TAG:-}" ] || die "IMAGE_TAG обязателен"
    validate_tag "$IMAGE_TAG"

    acquire_lock

    local prev
    prev="$(current_tag_from_env)"
    if [ -n "$prev" ] && [ "$prev" != "$IMAGE_TAG" ]; then
        state_set PREVIOUS_TAG "$prev"
        info "предыдущий тег зафиксирован: $prev"
    elif [ -z "$prev" ]; then
        # ПЕРВЫЙ деплой на стенде, который жил на локально собранном образе:
        # в .env не было IMAGE_TAG вовсе, поэтому «предыдущего тега» в новой
        # схеме не существует и записать его неоткуда. Молчать об этом нельзя:
        # любой сбой после up (миграции, health, смок) вызовет откат, который
        # честно упадёт «нет предыдущего тега», и стенд останется на новом
        # образе без автоматического возврата. Найдено кросс-ревью 2026-08-17
        # (обоими рецензентами виджета).
        echo "⚠️  ВНИМАНИЕ: в .env не было IMAGE_TAG — это первый деплой из реестра."
        echo "    ОТКАТА НА ЭТОМ ПРОГОНЕ НЕ БУДЕТ: предыдущего реестрового тега не"
        echo "    существует. Если релиз окажется плохим, возврат только вручную."
        echo "    Со следующего деплоя откат появится автоматически."
        state_set ROLLBACK_UNAVAILABLE "первый деплой из реестра $(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
    #
    # `--all` и положительное подтверждение: прежняя проверка ловила только
    # «есть контейнер с ЧУЖИМ тегом», но не «контейнера нет вовсе» — при
    # пустой выдаче она печатала «backend на sha-X» и считала apply успешным.
    # Найдено кросс-ревью 2026-08-17.
    local pairs wrong right
    pairs="$(docker compose ps --all --format '{{.Service}} {{.Image}}')" \
        || die "docker compose ps не отработал — не могу подтвердить раскатанный образ"
    wrong="$(printf '%s\n' "$pairs" | awk '$1=="backend"' | grep -v ":${IMAGE_TAG}$" || true)"
    [ -z "$wrong" ] || die "backend не на ${IMAGE_TAG}:\n$wrong"
    right="$(printf '%s\n' "$pairs" | awk '$1=="backend"' | grep -c ":${IMAGE_TAG}$" || true)"
    [ "${right:-0}" -ge 1 ] \
        || die "контейнера backend на ${IMAGE_TAG} не найдено — проверка не подтверждена"
    info "backend на ${IMAGE_TAG}"

    state_set CURRENT_TAG "$IMAGE_TAG"
    state_set DEPLOYED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "✅ apply завершён"
}

# ── health ────────────────────────────────────────────────────────────

cmd_health() {
    local url; url="$(health_url)"
    echo "═══ health $url ═══"
    local code i healthy=0
    for i in $(seq 1 30); do
        code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)
        if [ "$code" = "200" ]; then
            echo "✅ healthy (попытка $i)"
            healthy=1
            break
        fi
        sleep 5
    done
    [ "$healthy" = "1" ] || die "$url не отдал 200 за 150с (последний код: $code)"

    # Лендинг — второй сервис того же релиза, и без этой проверки деплой
    # считался бы успешным при мёртвом апексе: BFF отвечает, а vell.pro
    # отдаёт 502, и узнаёт об этом первый посетитель. Порог короче, чем у
    # BFF: `site` стартует после one-shot `site-migrate`, то есть к моменту
    # этой проверки миграции уже отработали.
    site_profile_enabled || return 0
    local site_url; site_url="$(site_health_url)"
    echo "═══ health лендинга $site_url ═══"
    for i in $(seq 1 24); do
        code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$site_url" 2>/dev/null || echo 000)
        if [ "$code" = "200" ]; then
            echo "✅ лендинг healthy (попытка $i)"
            return 0
        fi
        sleep 5
    done
    die "$site_url не отдал 200 за 120с (последний код: $code)"
}

# ── rollback ──────────────────────────────────────────────────────────

cmd_rollback() {
    local to="${1:-}" if_current="${2:-}"

    # Гард «откатывать только если стенд действительно на этом теге».
    # Без него автооткат срабатывал на ЛЮБОМ провале деплоя, включая те, где
    # apply даже не дошёл до подмены .env: не взялся flock (три стенда делят
    # дев-ВМ), не прошёл pull, упал preflight или backup. Тогда живой здоровый
    # стенд уводился на версию НАЗАД от работающей, на ровном месте.
    # Найдено кросс-ревью 2026-08-17.
    if [ -n "$if_current" ]; then
        local now; now="$(current_tag_from_env)"
        if [ "$now" != "$if_current" ]; then
            info "стенд на '${now:-?}', а не на '${if_current}' — apply его не тронул, откат не требуется"
            return 0
        fi
    fi

    acquire_lock
    [ -n "$to" ] || to="$(state_get PREVIOUS_TAG)"
    if [ -z "$to" ]; then
        local why; why="$(state_get ROLLBACK_UNAVAILABLE)"
        [ -z "$why" ] || echo "   причина: $why" >&2
        die "нет предыдущего тега — откат невозможен, нужен ручной разбор"
    fi

    echo "═══ ОТКАТ на $to ═══"
    # Откуда откатываемся — фиксируем ДО подмены .env, иначе после pin_tag
    # это уже не восстановить.
    local from
    from="$(current_tag_from_env)"
    pin_tag "$to"

    docker compose pull || info "pull не прошёл, надеемся на локальный кэш"
    docker compose up -d --no-build \
        || die "откат не поднялся — стенд в неопределённом состоянии, нужен ручной разбор"

    # Бухгалтерию пишем СРАЗУ после успешного up, ДО wait_healthy: провал
    # ожидания по таймауту иначе оставлял .env и контейнеры на новом теге, а
    # .deploy-state — со старыми значениями, то есть состояние расходилось с
    # реальностью. Найдено кросс-ревью 2026-08-17.
    state_set CURRENT_TAG "$to"
    state_set ROLLED_BACK_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    [ -n "$from" ] && state_set ROLLED_BACK_FROM "$from"

    wait_healthy 300

    # PREVIOUS_TAG СНИМАЕМ — но ТОЛЬКО после того, как откат реально сошёлся.
    # Иначе он указывает на тег, на котором стенд уже стоит, и ВТОРОЙ откат
    # стал бы молчаливым no-op («откатились» туда же). А если wait_healthy
    # выше не прошёл, снимать нельзя: неудавшийся откат имеет право на повтор,
    # и стирать единственную цель возврата в этот момент — худшее, что можно
    # сделать. Поэтому строка стоит именно здесь, а не рядом с остальной
    # бухгалтерией.
    state_unset PREVIOUS_TAG
    printf '%s rollback %s → %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${from:-?}" "$to" >> "$HISTORY_FILE"

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
        echo "previous: ${prev:-— (откат недоступен)}"
        echo "deployed: $(state_get DEPLOYED_AT)"
        echo "backup:   $(state_get BACKUP_FILE)"
        local rb; rb="$(state_get ROLLED_BACK_AT)"
        [ -z "$rb" ] || echo "откат:    $rb, с $(state_get ROLLED_BACK_FROM)"
    fi
}

cmd_commit() {
    # `${IMAGE_TAG:-}`, а не `$IMAGE_TAG`: под `set -u` ручной вызов
    # `release.sh commit` без --tag и без IMAGE_TAG в окружении падал сырым
    # «unbound variable» вместо человекочитаемого отказа.
    local tag="${1:-${IMAGE_TAG:-}}" run="${2:-manual}"
    [ -n "$tag" ] || die "commit: не задан ни --tag, ни IMAGE_TAG"
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
               # Явный разбор флагов, а не `[ ... ] && shift`. Уточнение к
               # прежнему комментарию (он был неточен, проверено экспериментом
               # 2026-08-17): как отдельный стейтмент и в СЕРЕДИНЕ функции
               # `[ ложь ] && cmd` под `set -e` скрипт НЕ роняет. Ловушка — когда
               # такой список ПОСЛЕДНИЙ стейтмент функции: тогда её код возврата
               # равен 1 и уходит наверх.
               to=""; if_current=""
               while [ $# -gt 0 ]; do
                   # `shift $(( $# > 1 ? 2 : 1 ))`, а не `shift 2`: флаг
                   # последним аргументом дал бы `shift 2` при одном аргументе —
                   # ненулевой код, и под `set -e` скрипт падал бы сырым
                   # сообщением вместо die.
                   case "$1" in
                       --to)         to="${2:-}";         shift $(( $# > 1 ? 2 : 1 )) ;;
                       --if-current) if_current="${2:-}"; shift $(( $# > 1 ? 2 : 1 )) ;;
                       -*)           shift ;;
                       *)            [ -n "$to" ] || to="$1"; shift ;;
                   esac
               done
               cmd_rollback "$to" "$if_current" ;;
    status)    shift; cmd_status "${1:-}" ;;
    commit)    shift
               tag=""; run=""
               while [ $# -gt 0 ]; do
                   case "$1" in
                       --tag) tag="${2:-}"; shift $(( $# > 1 ? 2 : 1 )) ;;
                       --run) run="${2:-}"; shift $(( $# > 1 ? 2 : 1 )) ;;
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
