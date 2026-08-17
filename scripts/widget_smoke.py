#!/usr/bin/env python3
"""Смок ai-site-widget против дев-стенда ядра: 6 сценариев §8 спеки + гейт фазы.

БРАТ `chat_smoke.py` ядра (`ai-conversation-core/../core-e2/scripts/chat_smoke.py`):
оттуда перенесены строительные блоки — коды выхода, вывод, `HttpResponse`/`http`,
`poll_until`, коды выхода 0/1/2/3, `_wait_any` — каждый помечен «(из chat_smoke.py
ядра)». НЕ перенесены (и намеренно не нужны здесь): `WebhookReceiver` и
`verify_signature` — этот смок НЕ поднимает приёмник, вебхук `session.finalized`
ядро само доставляет в BFF (`POST /w/v1/core-webhooks`, подписку настроил
оркестратор в T8), и money-синк проверяется через `--psql` BFF-Postgres
(`dialogs.usage`/`credits_total`/`settled_session_ids`, `core_events`), а не через
приём вебхука самим смоком.

⚠️ Диалог НАСТОЯЩИЙ: смок поднимает LiveKit-комнату (chat, затем voice),
приводит агента и ЖЖЁТ кредиты вендоров тенанта виджета. На тенанте намеренно
малый баланс (см. README) — гонять пачкой не стоит. Сценарий 6 (негативы)
кредитов НЕ жжёт: чужой Origin и фейк-подпись вебхука отбиваются до создания
сессии ядра, суточный кап посетителя проверяется прямой записью счётчика в БД
БФФ, а не покупкой десятка настоящих сессий.

Сценарии (§8 спеки; каждый — своя функция, вердикты СОБИРАЮТСЯ по всем 6, а не
обрываются на первом падении — в отличие от `chat_smoke.py`, где один провальный
шаг обрывает весь прогон. Смысл: 6 сценариев здесь бьют в разные углы контракта
BFF, и «5 зелёных из 6» — полезный частичный сигнал, а не шум):

    1. GET /config → POST /dialogs → LiveKit data-only (chat) → client_ready
       (с ре-отправкой на поздний вход agent-*) → greeting → user_text
       «Меня зовут Пётр» → ответ агента + ДЕДУП ЭХА (воркер вернул нашу же
       реплику transcript speaker=respondent) + журнал БФФ не задвоил свой
       текст (GET messages). Комната chat остаётся ЖИВОЙ до сценария 3.
    2. POST /reenter НОВОЙ respondent-identity: история отдана без дублей,
       identity не переиспользована, диалог жив.
    3. POST /escalate{messages_count} → закрывает chat-сессию сама ручка →
       voice-токен → resume_welcome (после входа агента, повтор 3с×5) →
       аватар заговорил (transcript speaker=agent ИЛИ аудио-трек). Браузерный
       голос/микрофон — вне скоупа питон-клиента, см. README «Ручной прогон
       голоса».
    4. POST /lead с consent=true → 201 + строка в БД; без consent → 422
       (PII без согласия не пишем).
    5. POST /end → вебхук session.finalized (ядро → BFF) → core_events →
       dialogs.usage/credits_total/status/settled_session_ids сведены.
    6. Негативы (кредитов НЕ жгут): чужой Origin → 403; посетитель, чей
       суточный счётчик уже выбит, → 429 visitor_daily_cap; вебхук с фейковой
       подписью → 401 и НЕ записан в core_events.

Машиночитаемый финал — последней строкой: `SMOKE-RESULT: <исход> exit=<код>
verdicts=<n>`. Коды выхода (та же семантика, что у `chat_smoke.py`, адаптированная
под «6 сценариев, не 1 диалог»): 0 — все 6 зелёные (ЭТО гейт фазы); 1 — хотя бы
один сценарий не сошёлся ассертом (смок отработал, БФФ — нет); 2 — смок не смог
НАЧАТЬ (нет `livekit-rtc`, BFF не отвечает на `/healthz`, publish_token не резолвится
или виджет выключен) — это НЕ вердикт о БФФ, ни один сценарий не запускался;
3 — BFF отвечал и ПРОПАЛ посреди прогона (сетевая ошибка после того, как мы уже
видели живой ответ) — инцидент, остаток сценариев не гоняется.

Запуск (интерпретатор — venv ВОРКЕРА ЯДРА, там есть `livekit-rtc`; в самом
ai-site-widget такой зависимости нет и не должно быть):

    /opt/conversation-core/worker/.venv/bin/python scripts/widget_smoke.py \\
        --base-url http://localhost:8200 --token <PUBLISH_TOKEN> \\
        --psql 'docker compose -f /opt/site-widget/compose.yaml exec -T widget-db psql -U widget -d site_widget'

`--origin` не обязателен: смок сам возьмёт первый `allowed_origins` из ответа
`/config`, если флаг не передан.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

# ── Коды выхода (из chat_smoke.py ядра) ────────────────────────────────────
EXIT_OK = 0        # все 6 сценариев зелёные — ЭТО гейт фазы
EXIT_ASSERT = 1    # хотя бы один сценарий не сошёлся ассертом
EXIT_SETUP = 2     # смок не смог НАЧАТЬ (нет SDK, BFF не отвечает, токен мёртв)
EXIT_CORE_LOST = 3 # BFF отвечал и пропал ПОСРЕДИ прогона

RESULT_MARKERS = {
    EXIT_OK: "widget-ok",
    EXIT_ASSERT: "failed",
    EXIT_SETUP: "setup-error",
    EXIT_CORE_LOST: "core-lost",
}


class SetupError(RuntimeError):
    """Смок не может продолжать: это не вердикт о BFF (exit 2). (из chat_smoke.py ядра)"""


class CoreLostError(RuntimeError):
    """BFF отвечал и перестал ПОСРЕДИ прогона (exit 3). (из chat_smoke.py ядра, адаптировано:
    там это про ядро, здесь — про сам BFF, т.к. смок бьёт в BFF, а не в ядро напрямую)."""


class AssertError(RuntimeError):
    """Ассерт не сошёлся: BFF/ядро отработали не так, как обещано. (из chat_smoke.py ядра)"""


# ── Вывод (из chat_smoke.py ядра) ───────────────────────────────────────────

_T0 = time.monotonic()


def _stamp() -> str:
    return f"{time.monotonic() - _T0:6.1f}s"


def step(title: str) -> None:
    print(f"\n[{_stamp()}] === {title} ===", flush=True)


def info(msg: str) -> None:
    print(f"        {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"    OK  {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"  WARN  {msg}", flush=True)


def fail(msg: str) -> None:
    print(f"  FAIL  {msg}", file=sys.stderr, flush=True)


# ── HTTP-клиент (из chat_smoke.py ядра, + `raw=`/`.text` для webhook-негатива) ─

@dataclass
class HttpResponse:
    status: int
    body: bytes
    headers: dict[str, str]

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode() or "null")
        except Exception as exc:  # noqa: BLE001 — диагностика важнее типа
            raise SetupError(f"ответ не JSON ({exc}): {self.body[:400]!r}") from exc

    @property
    def text(self) -> str:
        return self.body.decode(errors="replace")


# BFF хоть раз ответило: дальше недоступность — не «не смогли начать», а пропажа
# посреди прогона (см. CoreLostError).
_BFF_SEEN_ALIVE = False


def mark_bff_alive() -> None:
    global _BFF_SEEN_ALIVE
    _BFF_SEEN_ALIVE = True


def http(
    method: str,
    url: str,
    *,
    payload: Any = None,
    raw: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 20.0,
) -> HttpResponse:
    data = None
    hdrs = dict(headers or {})
    if raw is not None:
        data = raw
        hdrs.setdefault("Content-Type", "application/json")
    elif payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        hdrs.setdefault("Content-Type", "application/json")

    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return HttpResponse(resp.status, resp.read(), dict(resp.headers))
    except urllib.error.HTTPError as exc:  # 4xx/5xx — не исключение, а ответ
        return HttpResponse(exc.code, exc.read(), dict(exc.headers or {}))
    except urllib.error.URLError as exc:
        if _BFF_SEEN_ALIVE:
            raise CoreLostError(
                f"{method} {url}: BFF перестал отвечать ПОСРЕДИ прогона ({exc.reason}). "
                "Смотреть: docker compose ps на стенде, логи backend, не оборвался ли "
                "ssh/сеть до стенда"
            ) from exc
        raise SetupError(f"{method} {url}: сеть недоступна ({exc.reason})") from exc


# ── psql-хелперы (из chat_smoke.py ядра, психа переименована под BFF-Postgres) ─

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _safe_id(value: str, *, what: str) -> str:
    """Валидация ПЕРЕД встраиванием в SQL-строку. Значения серверные (dialog_id
    ядра/BFF — UUID, session_id ядра — sess_+hex), но встраивание без проверки
    формата в raw SQL — плохая привычка, даже когда источник доверенный."""
    if not _SAFE_ID_RE.match(value or ""):
        raise SetupError(f"{what}: неожиданный формат {value!r} — в SQL не встраиваю")
    return value


def run_cmd(cmd_prefix: str, args: list[str], *, timeout: float = 60.0) -> str:
    argv = shlex.split(cmd_prefix) + args
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise SetupError(f"не найдена команда: {argv[0]} ({exc})") from exc
    except subprocess.TimeoutExpired as exc:
        raise SetupError(f"команда не ответила за {timeout:.0f}s: {' '.join(argv)}") from exc
    if proc.returncode != 0:
        raise SetupError(
            f"команда упала (код {proc.returncode}): {' '.join(argv)}\n"
            f"        stdout: {proc.stdout.decode(errors='replace').strip()[:400]}\n"
            f"        stderr: {proc.stderr.decode(errors='replace').strip()[:400]}"
        )
    return proc.stdout.decode(errors="replace")


def psql_fields(psql_prefix: str, sql: str, *, what: str) -> list[str]:
    """Одна строка результата `--psql` как список полей (`-t -A`: tuples-only,
    unaligned; `-q`: без служебных сообщений; `ON_ERROR_STOP=1`: ошибка SQL —
    ненулевой код процесса, иначе run_cmd её не заметит)."""
    out = run_cmd(psql_prefix, ["-t", "-A", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql])
    lines = [ln for ln in out.splitlines() if ln.strip() != ""]
    if not lines:
        raise SetupError(f"{what}: пустой ответ psql на запрос:\n{sql}")
    return lines[-1].split("|")


def psql_exec(psql_prefix: str, sql: str) -> None:
    """INSERT/UPDATE без ожидаемого набора строк — только успех/провал."""
    run_cmd(psql_prefix, ["-q", "-v", "ON_ERROR_STOP=1", "-c", sql])


def poll_until(probe: Any, *, timeout: float, what: str, interval: float = 3.0) -> None:
    """Дождаться True от `probe()` или упасть с внятной диагностикой.

    Проще версии в chat_smoke.py (та копит диагностический payload из
    tuple-возврата пробы) — тут проба сама пишет диагностику через info()/warn()
    по ходу, а возвращает просто bool: сценариям это читается прямее."""
    deadline = time.monotonic() + timeout
    last_exc: Exception | None = None
    while time.monotonic() < deadline:
        try:
            if probe():
                return
        except (SetupError, CoreLostError):
            raise
        except Exception as exc:  # noqa: BLE001 — проба может дёргать psql/HTTP
            last_exc = exc
        time.sleep(interval)
    extra = f" (последняя ошибка пробы: {last_exc})" if last_exc else ""
    raise AssertError(f"{what}: не дождались за {timeout:.0f}s{extra}")


async def _wait_any(events: list[asyncio.Event], timeout: float) -> None:
    """Дождаться, пока ЛЮБОЙ из events взведётся (или истечёт timeout). (из chat_smoke.py ядра)"""
    tasks = [asyncio.ensure_future(evt.wait()) for evt in events]
    try:
        await asyncio.wait(tasks, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass


def normalize_text(text: str) -> str:
    return " ".join(text.strip().lower().split())


# ── pv1 data-channel: сигналы chat/voice диалога ────────────────────────────

# Отказ ядра поднять сессию (та же машинерия, что chat/voice-abort в ядре) —
# для смока это вердикт «разговора не было вовсе», не таймаут ожидания.
FATAL_END_REASONS = {"service_unavailable", "realtime_unavailable"}


@dataclass
class ChatSignals:
    joined_at: float = 0.0
    local_identity: str = ""
    participants: dict[str, float] = field(default_factory=dict)
    frames: dict[str, int] = field(default_factory=dict)
    greeting_text: str = ""
    greeting_seen: bool = False
    answer_text: str = ""
    answer_seen: bool = False
    respondent_echo_seen: bool = False
    session_ended_reason: str = ""
    disconnect_reason: str = ""

    def note_frame(self, ftype: str) -> None:
        self.frames[ftype] = self.frames.get(ftype, 0) + 1

    @property
    def fatal_end_reason(self) -> str:
        return self.session_ended_reason if self.session_ended_reason in FATAL_END_REASONS else ""


@dataclass
class VoiceSignals:
    joined_at: float = 0.0
    participants: dict[str, float] = field(default_factory=dict)
    frames: dict[str, int] = field(default_factory=dict)
    agent_text: str = ""
    agent_spoke: bool = False
    audio_track_seen: bool = False
    session_ended_reason: str = ""
    disconnect_reason: str = ""

    def note_frame(self, ftype: str) -> None:
        self.frames[ftype] = self.frames.get(ftype, 0) + 1


async def run_chat_dialog(
    token: dict[str, Any],
    *,
    question: str,
    greeting_timeout: float,
    answer_timeout: float,
    keep_open: bool,
) -> tuple[ChatSignals, Any]:
    """Войти в chat-комнату DATA-ONLY, дождаться greeting, задать вопрос,
    дождаться ответа И эха своей же реплики (transcript speaker=respondent —
    воркер шлёт его для любого user_text, не только в voice; на этом эхе
    держится дедуп в embed/app/src/lib/echoGuard.ts, и сценарий 1 проверяет,
    что оно вообще приходит — иначе дедуп-сценарий непроверяем).

    `keep_open=True`: НЕ вызывает `room.disconnect()`, возвращает живую комнату
    вторым элементом — её рвёт `Ctx.drop_chat_room()` (сценарий 3 делает это
    ПОСЛЕ `/escalate`: уход участника раньше времени разбудил бы сторож простоя
    воркера и закрыл chat-сессию до эскалации — см. докстринг scenario_3).
    """
    from livekit import rtc  # импорт внутри: без SDK смок падает раньше, с диагностикой

    sig = ChatSignals()
    greeting_evt = asyncio.Event()
    answer_evt = asyncio.Event()
    echo_evt = asyncio.Event()
    fatal_evt = asyncio.Event()
    user_sent: dict[str, float | None] = {"at": None}
    wanted_echo = normalize_text(question)
    loop = asyncio.get_running_loop()
    room = rtc.Room(loop=loop)

    @room.on("participant_connected")
    def _on_participant(p: Any) -> None:
        identity = str(getattr(p, "identity", "") or "?")
        sig.participants.setdefault(identity, time.monotonic() - _T0)
        info(f"участник вошёл (chat): {identity}")
        if identity.startswith("agent-"):
            # Требование сценария 1: client_ready ре-шлём на поздний вход
            # агента — тот же приём, что резендер embed/app (App.vue
            # onAgentJoined/startReadySender): фрейм, отправленный ДО входа
            # агента, LiveKit не буферизует и теряет безвозвратно.
            info("агент вошёл позже нас — ре-шлём client_ready")
            asyncio.ensure_future(
                room.local_participant.publish_data(json.dumps({"type": "client_ready"}), reliable=True)
            )

    @room.on("data_received")
    def _on_data(packet: Any) -> None:
        raw = getattr(packet, "data", packet)
        try:
            msg = json.loads(raw if isinstance(raw, str) else bytes(raw).decode())
        except Exception:  # noqa: BLE001 — чужой кадр не должен ронять смок
            return
        if not isinstance(msg, dict):
            return
        ftype = str(msg.get("type") or "?")
        first = ftype not in sig.frames
        sig.note_frame(ftype)
        if first:
            info(f"кадр от воркера (chat): {ftype}")

        if ftype == "transcript":
            speaker = str(msg.get("speaker") or "")
            text = str(msg.get("text") or "")
            if speaker == "agent":
                if user_sent["at"] is None:
                    if not greeting_evt.is_set():
                        sig.greeting_text = text
                        sig.greeting_seen = True
                        info(f"greeting агента: {text[:160]!r}")
                        greeting_evt.set()
                else:
                    if not answer_evt.is_set() and text.strip():
                        sig.answer_text = text
                        sig.answer_seen = True
                        info(f"ответ агента: {text[:200]!r}")
                        answer_evt.set()
            elif speaker == "respondent":
                if not echo_evt.is_set() and normalize_text(text) == wanted_echo:
                    sig.respondent_echo_seen = True
                    info("эхо своей реплики получено (transcript speaker=respondent)")
                    echo_evt.set()
        elif ftype == "session_ended":
            sig.session_ended_reason = sig.session_ended_reason or str(msg.get("reason") or "")
            info(f"session_ended reason={sig.session_ended_reason}")
            if sig.fatal_end_reason:
                fatal_evt.set()

    @room.on("disconnected")
    def _on_disconnected(reason: Any = None) -> None:
        sig.disconnect_reason = str(reason)

    try:
        await room.connect(token.get("livekit_url") or "", token["token"], options=rtc.RoomOptions(auto_subscribe=True))
    except Exception as exc:  # noqa: BLE001
        raise SetupError(f"вход в chat-комнату LiveKit не удался: {exc}") from exc
    sig.joined_at = time.monotonic() - _T0
    sig.local_identity = str(room.local_participant.identity)
    ok(f"в chat-комнате data-only: identity={sig.local_identity}")

    for p in (room.remote_participants or {}).values():
        sig.participants.setdefault(str(getattr(p, "identity", "?")), sig.joined_at)

    await room.local_participant.publish_data(json.dumps({"type": "client_ready"}), reliable=True)
    ok("client_ready отправлен")

    await _wait_any([greeting_evt, fatal_evt], greeting_timeout)
    if sig.fatal_end_reason:
        await room.disconnect()
        return sig, None
    if not greeting_evt.is_set():
        warn(f"за {greeting_timeout:.0f}s greeting (transcript speaker=agent) не пришёл")
        await room.disconnect()
        return sig, None

    user_sent["at"] = time.monotonic()
    await room.local_participant.publish_data(json.dumps({"type": "user_text", "text": question}), reliable=True)
    ok(f"user_text отправлен: {question[:120]!r}")

    deadline = time.monotonic() + answer_timeout
    while (
        time.monotonic() < deadline
        and not fatal_evt.is_set()
        and not (answer_evt.is_set() and echo_evt.is_set())
    ):
        remaining = max(0.5, deadline - time.monotonic())
        await _wait_any([answer_evt, echo_evt, fatal_evt], remaining)
    if not answer_evt.is_set() and not sig.fatal_end_reason:
        warn(f"за {answer_timeout:.0f}s ответ агента (transcript speaker=agent) не пришёл")
    if not echo_evt.is_set() and not sig.fatal_end_reason:
        warn("эхо своей реплики (transcript speaker=respondent) не пришло — дедуп непроверяем")

    if keep_open and not sig.fatal_end_reason:
        return sig, room
    await room.disconnect()
    ok("вышли из chat-комнаты")
    return sig, None


async def run_voice_dialog(
    token: dict[str, Any],
    *,
    agent_join_timeout: float,
    resume_interval: float,
    resume_attempts: int,
    resume_grace: float,
) -> VoiceSignals:
    """Войти в voice-комнату продолжения, дождаться агента, слать resume_welcome
    3с×5 СТРОГО ПОСЛЕ его входа (фрейм, отправленный раньше, теряется —
    LiveKit data-фреймы не буферизуются), гасить повтор по РЕЧИ агента:
    transcript speaker=agent непустой ИЛИ подписка на его аудио-трек — служебные
    кадры (session_timer/pong) намеренно не считаются (см. task-9-brief.md).

    Микрофон питон-клиент НЕ публикует: проверка «нас слышно» — только в ручном
    браузерном чек-листе (README), тут проверяется исключительно то, что
    аватар САМ заговорил по resume_welcome.
    """
    from livekit import rtc

    sig = VoiceSignals()
    agent_joined_evt = asyncio.Event()
    spoke_evt = asyncio.Event()
    loop = asyncio.get_running_loop()
    room = rtc.Room(loop=loop)

    @room.on("participant_connected")
    def _on_participant(p: Any) -> None:
        identity = str(getattr(p, "identity", "") or "?")
        sig.participants.setdefault(identity, time.monotonic() - _T0)
        info(f"участник вошёл (voice): {identity}")
        if identity.startswith("agent-"):
            agent_joined_evt.set()

    @room.on("track_subscribed")
    def _on_track(track: Any, _pub: Any, participant: Any) -> None:
        identity = str(getattr(participant, "identity", "") or "?")
        if getattr(track, "kind", None) == rtc.TrackKind.KIND_AUDIO:
            sig.audio_track_seen = True
            info(f"аудио-трек аватара подписан: {identity}")
            spoke_evt.set()

    @room.on("data_received")
    def _on_data(packet: Any) -> None:
        raw = getattr(packet, "data", packet)
        try:
            msg = json.loads(raw if isinstance(raw, str) else bytes(raw).decode())
        except Exception:  # noqa: BLE001
            return
        if not isinstance(msg, dict):
            return
        ftype = str(msg.get("type") or "?")
        first = ftype not in sig.frames
        sig.note_frame(ftype)
        if first:
            info(f"кадр от воркера (voice): {ftype}")
        if ftype == "transcript" and str(msg.get("speaker") or "") == "agent":
            text = str(msg.get("text") or "")
            if text.strip() and not spoke_evt.is_set():
                sig.agent_text = text
                spoke_evt.set()
                info(f"аватар заговорил: {text[:160]!r}")
        elif ftype == "session_ended":
            sig.session_ended_reason = sig.session_ended_reason or str(msg.get("reason") or "")

    @room.on("disconnected")
    def _on_disconnected(reason: Any = None) -> None:
        sig.disconnect_reason = str(reason)

    try:
        await room.connect(token.get("livekit_url") or "", token["token"], options=rtc.RoomOptions(auto_subscribe=True))
    except Exception as exc:  # noqa: BLE001
        raise SetupError(f"вход в voice-комнату LiveKit не удался: {exc}") from exc
    sig.joined_at = time.monotonic() - _T0
    ok(f"в voice-комнате: identity={room.local_participant.identity}")

    for p in (room.remote_participants or {}).values():
        identity = str(getattr(p, "identity", "?"))
        sig.participants.setdefault(identity, sig.joined_at)
        if identity.startswith("agent-"):
            agent_joined_evt.set()

    await room.local_participant.publish_data(json.dumps({"type": "client_ready"}), reliable=True)
    ok("client_ready отправлен (voice)")

    await _wait_any([agent_joined_evt], agent_join_timeout)
    if not agent_joined_evt.is_set():
        warn(f"за {agent_join_timeout:.0f}s агент не вошёл в voice-комнату — resume_welcome слать некому")
        await room.disconnect()
        return sig
    ok("агент в voice-комнате — начинаем resume_welcome")

    for attempt in range(1, resume_attempts + 1):
        if spoke_evt.is_set():
            break
        await room.local_participant.publish_data(json.dumps({"type": "resume_welcome"}), reliable=True)
        info(f"resume_welcome отправлен (попытка {attempt}/{resume_attempts})")
        await _wait_any([spoke_evt], resume_interval)

    if not spoke_evt.is_set():
        await _wait_any([spoke_evt], resume_grace)  # доп. пауза — вдруг доедет с опозданием

    sig.agent_spoke = spoke_evt.is_set()
    await room.disconnect()
    ok("вышли из voice-комнаты")
    return sig


# ── Ctx: состояние, разделяемое сценариями ──────────────────────────────────

class Ctx:
    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        psql_prefix: str,
        core_console: str,
        origin: str,
        visitor_key: str,
        capped_visitor: str,
        question: str,
        greeting_timeout: float,
        answer_timeout: float,
        agent_join_timeout: float,
        resume_interval: float,
        resume_attempts: int,
        resume_grace: float,
        webhook_timeout: float,
        http_timeout: float,
    ) -> None:
        self.base_url = base_url
        self.token = token
        self.psql_prefix = psql_prefix
        self.core_console = core_console
        self.origin = origin
        self.visitor_key = visitor_key
        self.capped_visitor = capped_visitor
        self.question = question
        self.greeting_timeout = greeting_timeout
        self.answer_timeout = answer_timeout
        self.agent_join_timeout = agent_join_timeout
        self.resume_interval = resume_interval
        self.resume_attempts = resume_attempts
        self.resume_grace = resume_grace
        self.webhook_timeout = webhook_timeout
        self.http_timeout = http_timeout

        # Состояние, которое сценарии передают друг другу по цепочке 1→2→3→5.
        self.dialog_id: Optional[str] = None
        self.previous_identity: str = ""
        self.core_message_count: int = 0
        self.last_core_session_id: Optional[str] = None
        self.chat_room: Any = None  # rtc.Room, живая между сценариями 1 и 3

    # -- HTTP --------------------------------------------------------------

    def http(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        raw: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
        expect_error: bool = False,  # документирует намерение вызывающего; поведение то же
    ) -> HttpResponse:
        del expect_error
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        return http(method, url, payload=json, raw=raw, headers=headers, timeout=timeout or self.http_timeout)

    # -- psql ----------------------------------------------------------------

    def psql_fields(self, sql: str) -> list[str]:
        return psql_fields(self.psql_prefix, sql, what="запрос BFF-Postgres")

    def psql_exec(self, sql: str) -> None:
        psql_exec(self.psql_prefix, sql)

    def poll_until(self, probe: Any, *, timeout: float, what: str, interval: float = 3.0) -> None:
        poll_until(probe, timeout=timeout, what=what, interval=interval)

    # -- LiveKit -------------------------------------------------------------

    async def run_chat(self, token: dict[str, Any], *, question: str, keep_open: bool = False) -> ChatSignals:
        sig, room = await run_chat_dialog(
            token, question=question,
            greeting_timeout=self.greeting_timeout, answer_timeout=self.answer_timeout,
            keep_open=keep_open,
        )
        self.chat_room = room
        return sig

    async def run_voice(self, token: dict[str, Any]) -> VoiceSignals:
        return await run_voice_dialog(
            token,
            agent_join_timeout=self.agent_join_timeout,
            resume_interval=self.resume_interval, resume_attempts=self.resume_attempts,
            resume_grace=self.resume_grace,
        )

    async def drop_chat_room(self) -> None:
        room = self.chat_room
        self.chat_room = None
        if room is not None:
            try:
                await room.disconnect()
            except Exception:  # noqa: BLE001 — комнату могло уже снести /escalate
                pass


# ── Сценарии §8 ──────────────────────────────────────────────────────────────

async def scenario_1_chat_and_echo_dedup(ctx: Ctx) -> None:
    """(1) конфиг → диалог → «Меня зовут Пётр» → ответ + ДЕДУП ЭХА проверен."""
    config = ctx.http("GET", f"/w/v1/{ctx.token}/config").json()
    assert config.get("enabled") is True, f"виджет выключен: {config}"

    started = ctx.http(
        "POST", f"/w/v1/{ctx.token}/dialogs",
        json={"visitor_key": ctx.visitor_key}, headers={"Origin": ctx.origin},
    )
    assert started.status == 201, f"POST /dialogs -> {started.status}: {started.text[:300]}"
    body = started.json()
    ctx.dialog_id = body["dialog_id"]
    ctx.previous_identity = body["participant_token"]["identity"]
    info(f"диалог {ctx.dialog_id}, identity={ctx.previous_identity}")

    # Комната остаётся ЖИВОЙ до сценария 3: выход участника раньше времени
    # разбудил бы сторож простоя воркера и закрыл chat-сессию до эскалации.
    signals = await ctx.run_chat(body["participant_token"], question=ctx.question, keep_open=True)
    assert signals.greeting_seen, "greeting (transcript speaker=agent) не пришёл"
    assert signals.answer_seen, "ответ агента не пришёл"
    # Столько реплик ОБЯЗАНО осесть в ленте ядра для messages_count эскалации:
    # наш user_text + ответ агента. Greeting в ленту ядра не идёт.
    ctx.core_message_count = 2
    assert signals.respondent_echo_seen, (
        "воркер НЕ вернул эхо (transcript speaker=respondent) — сценарий дедупа "
        "непроверяем, смотреть протокол воркера прежде чем радоваться"
    )

    # Журнал ведёт КЛИЕНТ; смок эмулирует его ровно один раз на реплику (как
    # это делает embed/app/src/App.vue:send через api.journal()).
    journal_write = ctx.http(
        "POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/messages",
        json={"visitor_key": ctx.visitor_key, "role": "user", "text": ctx.question, "seq": 1},
        headers={"Origin": ctx.origin},
    )
    assert journal_write.status in (200, 201), f"журнал не принял реплику: {journal_write.status} {journal_write.text[:200]}"

    journal = ctx.http(
        "GET", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/messages?visitor_key={ctx.visitor_key}",
        headers={"Origin": ctx.origin},
    ).json()["messages"]
    mine = [m for m in journal if m["role"] == "user" and m["text"] == ctx.question]
    assert len(mine) == 1, f"свой текст задвоился в журнале BFF: {mine}"
    ok(f"сценарий 1: диалог {ctx.dialog_id} — greeting+ответ+эхо получены, журнал БФФ без дублей")


def scenario_2_reenter(ctx: Ctx) -> None:
    """(2) re-enter с НОВОЙ respondent-identity: история отдана, диалог жив."""
    if not ctx.dialog_id:
        raise AssertError("сценарий 1 не подготовил dialog_id — re-enter проверить нечем")

    res = ctx.http(
        "POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/reenter",
        json={"visitor_key": ctx.visitor_key}, headers={"Origin": ctx.origin},
    )
    assert res.status == 200, f"POST /reenter -> {res.status}: {res.text[:300]}"
    body = res.json()
    identity = body["participant_token"]["identity"]
    assert identity.startswith("respondent-"), f"identity без префикса: {identity}"
    assert identity != ctx.previous_identity, "identity переиспользована — выкинет живого участника"
    assert any(m["text"] == ctx.question for m in body["messages"]), "история не отдана"
    assert body["next_seq"] >= 2, f"next_seq не продолжает нумерацию журнала: {body['next_seq']}"
    # Свой текст в истории ОДИН раз: повторное открытие вкладки не обязано
    # удваивать историю (сверка ленты ядра дедупится по тексту).
    mine = [m for m in body["messages"] if m["text"] == ctx.question]
    assert len(mine) == 1, f"история задвоилась после re-enter: {mine}"
    # Вторым участником в ту же комнату НЕ входим: живой chat-клиент сценария 1
    # остаётся единственным. Проверяем лишь, что токен выписан на новую identity.
    ok(f"сценарий 2: reenter выдал новую identity {identity}, история цела и без дублей")


async def scenario_3_escalate_to_voice(ctx: Ctx) -> None:
    """(3) escalate{messages_count} → voice-токен → resume_welcome → аватар заговорил.

    ⚠️ ПОРЯДОК: chat-комнату НЕ покидаем до вызова /escalate (её держит открытой
    сценарий 1 через keep_open=True). Уход участника раньше времени взводит
    сторож простоя воркера — он может закрыть chat-сессию раньше нас, диалог
    уедет в ended, и /escalate честно ответит 409 dialog_not_active — это ЛОЖНЫЙ
    красный сценария 3, не баг эскалации. Комнату рвёт САМА ручка /escalate
    (вызывает core.endSession на chat-сессии), поэтому drop_chat_room() ниже —
    только локальная гигиена питон-клиента, не сетевой disconnect.
    """
    if not ctx.dialog_id:
        raise AssertError("сценарий 1 не подготовил dialog_id — эскалацию проверить нечем")

    res = ctx.http(
        "POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/escalate",
        json={"visitor_key": ctx.visitor_key, "messages_count": ctx.core_message_count},
        headers={"Origin": ctx.origin},
    )
    if res.status == 409:
        code = (res.json().get("error") or {}).get("code")
        if code == "dialog_not_active":
            raise AssertError(
                "диалог уже не активен к моменту эскалации: сторож простоя закрыл "
                "chat-сессию раньше, чем мы позвали /escalate. Это НЕ баг эскалации — "
                "смок обязан держать chat-комнату живой между сценариями 1-3 "
                "(проверить keep_open=True в run_chat и что сценарий 2 не тормозит)"
            )
    assert res.status == 201, f"эскалация не прошла: {res.status} {res.text[:300]}"
    body = res.json()
    assert body.get("channel") == "voice", f"channel={body.get('channel')!r}, ожидали 'voice'"
    assert body.get("continued_from"), "связь с прошлой (chat) сессией потеряна — continued_from пуст"
    ctx.last_core_session_id = body.get("core_session_id")

    await ctx.drop_chat_room()  # комнаты уже нет: /escalate снёс её на стороне ядра

    signals = await ctx.run_voice(body["participant_token"])
    # В продолжении greeting гасится — заговорить аватар обязан ИМЕННО по
    # resume_welcome (client_ready сразу, resume_welcome ПОСЛЕ входа агента).
    assert signals.agent_spoke, (
        "аватар молчит: resume_welcome не сработал (ни transcript speaker=agent, "
        "ни аудио-трек не пришли за отведённое время)"
    )
    ok(
        f"сценарий 3: эскалация в voice-сессию {ctx.last_core_session_id}, аватар заговорил "
        f"(audio_track_seen={signals.audio_track_seen}, transcript_complete={body.get('transcript_complete')})"
    )


def scenario_4_lead(ctx: Ctx) -> None:
    """(4) лид с consent."""
    if not ctx.dialog_id:
        raise AssertError("сценарий 1 не подготовил dialog_id — лид проверить нечем")

    res = ctx.http(
        "POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/lead",
        json={"visitor_key": ctx.visitor_key, "name": "Пётр", "phone": "+7 900 000-00-00", "consent": True},
        headers={"Origin": ctx.origin},
    )
    assert res.status == 201, f"лид не принят: {res.status} {res.text[:200]}"

    rows = ctx.psql_fields("SELECT name, consent FROM leads ORDER BY created_at DESC LIMIT 1")
    assert rows[:2] == ["Пётр", "t"], f"лид не в БД (или не тот): {rows}"

    no_consent = ctx.http(
        "POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/lead",
        json={"visitor_key": ctx.visitor_key, "phone": "+7 900 000-00-01", "consent": False},
        headers={"Origin": ctx.origin},
    )
    assert no_consent.status == 422, f"лид без согласия ПРИНЯТ (PII без основания): {no_consent.status} {no_consent.text[:200]}"
    ok("сценарий 4: лид с согласием записан в БД, без согласия — 422")


def scenario_5_webhook_to_usage(ctx: Ctx) -> None:
    """(5) вебхук session.finalized → core_events → dialogs.usage/credits/settled."""
    if not ctx.dialog_id:
        raise AssertError("сценарий 1 не подготовил dialog_id")
    if not ctx.last_core_session_id:
        raise AssertError("сценарий 3 не оставил voice-сессию — заканчивать нечего")
    session_id = _safe_id(ctx.last_core_session_id, what="core_session_id")
    dialog_id = _safe_id(ctx.dialog_id, what="dialog_id")

    end = ctx.http(
        "POST", f"/w/v1/{ctx.token}/dialogs/{ctx.dialog_id}/end",
        json={"visitor_key": ctx.visitor_key}, headers={"Origin": ctx.origin},
    )
    assert end.status == 200, f"POST /end -> {end.status}: {end.text[:200]}"

    # ОТСТУПЛЕНИЕ от буквы брифа (task-9-brief.md): там опрос — общий
    # `count(*) FROM core_events WHERE type='session.finalized'` без привязки к
    # сессии. Проблема: /escalate (сценарий 3) уже закрыл ПЕРВУЮ (chat) сессию
    # этой же нити своим endSession — её вебхук почти наверняка доезжает раньше,
    # чем мы вообще дошли до этого POST /end, и общий count() зажёгся бы зелёным
    # НЕМЕДЛЕННО, не проверив, что финализация именно ЭТОЙ (voice) сессии вообще
    # произошла. Опрос ниже целится в payload КОНКРЕТНОГО session_id.
    hint = f" (проверить подписку: {ctx.core_console} tenant:webhook:list)" if ctx.core_console else ""
    ctx.poll_until(
        lambda: ctx.psql_fields(
            "SELECT count(*) FROM core_events WHERE type = 'session.finalized' "
            f"AND payload->'data'->>'session_id' = '{session_id}'"
        )[0] != "0",
        timeout=ctx.webhook_timeout,
        what=f"вебхук session.finalized voice-сессии {session_id}{hint}",
    )

    usage, credits, status, settled = ctx.psql_fields(
        f"SELECT usage::text, credits_total, status, settled_session_ids::text "
        f"FROM dialogs WHERE id = '{dialog_id}'"
    )
    # Ассертим ЮНИТЫ метра, а не credits: на коротком диалоге credits_total
    # честно бывает нулём (округление per-turn). Нулевой usage — вот это поломка.
    parsed = json.loads(usage)
    assert parsed.get("chat_token", 0) > 0, f"токенный учёт chat-хода не доехал в usage: {usage}"
    assert int(credits) >= 0, f"credits_total отрицательный: {credits}"
    assert status == "ended", f"статус диалога не сведён: {status}"
    ids = json.loads(settled)
    assert session_id in ids, f"voice-сессия {session_id} не попала в settled_session_ids: {ids}"
    # Каждая сессия нити учтена ровно один раз (защита от гонки со свипером).
    assert len(ids) == len(set(ids)), f"сессия учтена дважды: {ids}"
    ok(f"сценарий 5: usage={usage}, credits_total={credits}, settled_session_ids={settled}")


def scenario_6_negatives(ctx: Ctx) -> None:
    """(6) чужой Origin → отказ; суточный кап посетителя → отказ; фейк-подпись вебхука → 401.

    Кредитов НЕ жжёт: все три отказа происходят ДО создания сессии ядра.
    """
    alien = ctx.http(
        "POST", f"/w/v1/{ctx.token}/dialogs",
        json={"visitor_key": str(uuid.uuid4())}, headers={"Origin": "https://evil.example"},
    )
    assert alien.status == 403, f"чужой Origin ПРОПУЩЕН: {alien.status} {alien.text[:200]}"

    # ОТСТУПЛЕНИЕ от буквы брифа: там кап проверялся вставкой 10 фиктивных строк
    # в `dialogs` — это механика ДО фикс-раунда 1 T3 (см. progress.md, «11 платных
    # сессий при капе 2»). Актуальный код (backend/src/dialogs/budget.ts,
    # checkSessionBudget/peekVisitorDayCounter) считает НЕ строки `dialogs`, а
    # СОЗДАНИЯ СЕССИЙ ЯДРА через отдельные счётчики `visitor_day_counters`/
    # `ip_day_counters` — брифовский SQL проверял бы капу, которой в коде больше
    # нет, и молча зеленел бы, даже если реальный кап сломан. Бьём напрямую в
    # счётчик, которым код реально пользуется. Значение — заведомо больше ЛЮБОГО
    # разумного порога (не хардкодим дефолт 20 из config.ts — стенд волен
    # переопределить его env-переменной MAX_DIALOGS_PER_VISITOR_PER_DAY).
    capped_visitor = _safe_id(ctx.capped_visitor, what="capped_visitor")
    ctx.psql_exec(
        f"INSERT INTO visitor_day_counters (visitor_key, day, started) "
        f"VALUES ('{capped_visitor}', current_date, 1000000) "
        f"ON CONFLICT (visitor_key, day) DO UPDATE SET started = 1000000"
    )
    capped = ctx.http(
        "POST", f"/w/v1/{ctx.token}/dialogs",
        json={"visitor_key": ctx.capped_visitor}, headers={"Origin": ctx.origin},
    )
    assert capped.status == 429, f"кап диалогов посетителя не сработал: {capped.status} {capped.text[:200]}"
    cap_code = (capped.json().get("error") or {}).get("code")
    assert cap_code == "visitor_daily_cap", f"кап сработал не тем кодом: {cap_code!r}"

    fake_event_id = f"evt_fake_smoke_{uuid.uuid4().hex[:12]}"
    fake_body = json.dumps(
        {"api_version": "v1", "event_id": fake_event_id, "type": "session.finalized", "data": {}}
    ).encode()
    fake = ctx.http(
        "POST", "/w/v1/core-webhooks", raw=fake_body,
        headers={"Content-Type": "application/json", "X-Core-Signature": "t=1,v1=deadbeef"},
    )
    assert fake.status == 401, f"фейк-подпись вебхука ПРИНЯТА: {fake.status} {fake.text[:200]}"
    rows = ctx.psql_fields(f"SELECT count(*) FROM core_events WHERE event_id = '{fake_event_id}'")
    assert rows[0] == "0", "отвергнутый по подписи вебхук всё равно записан в core_events"

    ok("сценарий 6: чужой Origin/суточный кап/фейк-подпись — все три отклонены корректно")


SCENARIOS: list[tuple[str, Any]] = [
    ("1-chat-and-echo-dedup", scenario_1_chat_and_echo_dedup),
    ("2-reenter", scenario_2_reenter),
    ("3-escalate-to-voice", scenario_3_escalate_to_voice),
    ("4-lead", scenario_4_lead),
    ("5-webhook-to-usage", scenario_5_webhook_to_usage),
    ("6-negatives", scenario_6_negatives),
]

# Сценарии, которым НЕ нужен livekit-rtc: целиком HTTP + psql, комнату не
# поднимают. Нужны отдельным списком, потому что предполётная проверка иначе
# требует интерпретатор ВОРКЕРА ЯДРА — а гейт деплоя гоняется на раннере, где
# venv ядра нет и быть не должно.
#
# 4-lead сюда НЕ входит, хотя сам по себе тоже обходится без LiveKit: он читает
# ctx.dialog_id, который создаёт сценарий 1, и в одиночку падает
# «сценарий 1 не подготовил dialog_id». Отвязка — отдельная работа.
LIVEKIT_FREE: frozenset = frozenset({"6-negatives"})


class OnlyError(Exception):
    """Некорректный --only. Отдельный тип, чтобы main() отработал его как
    SetupError (смок НЕ НАЧАЛСЯ), а не как вердикт о BFF.

    Раньше здесь был голый `raise SystemExit(...)`: он вылетал мимо всех
    except-веток main(), поэтому обязательная машиночитаемая строка
    `SMOKE-RESULT:` НЕ печаталась, а код возврата 1 численно совпадал с
    EXIT_ASSERT — то есть опечатка во флаге была НЕОТЛИЧИМА от красной
    приёмки и утягивала исправный стенд в автооткат. Найдено кросс-ревью
    2026-08-17.
    """


def select_scenarios(only: str) -> list:
    """Отбор по --only: номер («6»), имя («6-negatives») или список через запятую.

    Пустой --only = все шесть (поведение по умолчанию, обратно совместимо).
    Неизвестное имя — ошибка, а НЕ тихий пропуск: молча пустой прогон выглядел
    бы как зелёный гейт, то есть худший из возможных отказов.
    """
    if not only.strip():
        return list(SCENARIOS)

    picked: list = []
    for w in (p.strip() for p in only.split(",")):
        if not w:
            continue
        match = [s for s in SCENARIOS if s[0] == w or s[0].split("-", 1)[0] == w]
        if not match:
            raise OnlyError(
                f"--only: неизвестный сценарий {w!r}. Доступны: "
                + ", ".join(n for n, _ in SCENARIOS)
            )
        for m in match:
            if m not in picked:
                picked.append(m)

    # Пустой результат при НЕПУСТОМ --only — это `--only ","` или `--only " , "`:
    # все токены отсеялись как пустые, ни один не дошёл до проверки на
    # неизвестность, и функция возвращала []. Дальше цикл сценариев не
    # выполнялся ни разу и смок выходил с кодом 0 — ровно «молча пустой
    # прогон выглядит как зелёный гейт», от чего этот докстринг и предостерегает.
    # Воспроизведено 2026-08-17.
    if not picked:
        raise OnlyError(
            f"--only={only!r} не отобрал ни одного сценария (пустые токены). "
            "Пустой прогон не может считаться успешным."
        )

    # Порядок — КАНОНИЧЕСКИЙ, а не порядок перечисления в --only. Сценарии
    # связаны по контексту (4 читает dialog_id, который создаёт 1), и
    # `--only 3,1` прогнал бы третий раньше первого и упал бы на пустом
    # dialog_id — отказ инструмента, выглядящий как вердикт о продукте.
    order = {name: i for i, (name, _) in enumerate(SCENARIOS)}
    picked.sort(key=lambda s: order[s[0]])
    return picked


# ── main ──────────────────────────────────────────────────────────────────

def parse_args(argv: list[str]) -> argparse.Namespace:
    env = os.environ.get
    p = argparse.ArgumentParser(
        prog="widget_smoke.py",
        description="Смок ai-site-widget против дев-стенда ядра: 6 сценариев §8 (см. докстринг файла).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--base-url", default=env("WIDGET_BASE_URL", "http://localhost:8200"),
                   help="базовый URL BFF виджета (без хвостового /)")
    p.add_argument("--token", default=env("WIDGET_PUBLISH_TOKEN", ""),
                   help="publish_token демо-виджета (обязателен)")
    p.add_argument("--only", default=env("WIDGET_ONLY", ""),
                   help="прогнать только указанные сценарии: номер ('6'), имя ('6-negatives') "
                        "или список через запятую. Пусто — все шесть. Гейт деплоя гоняет '6': "
                        "он единственный самодостаточный И не жгущий кредиты вендоров")
    p.add_argument("--psql", default=env("WIDGET_PSQL", "docker compose exec -T widget-db psql -U widget -d site_widget"),
                   help="как звать psql BFF-Postgres (money-ассерты + прямая запись капа/фейка)")
    p.add_argument("--core-console", default=env("WIDGET_CORE_CONSOLE", ""),
                   help="необязательно: как звать консоль control-plane ядра — только для "
                        "диагностической подсказки в тексте ошибки шага 5, ничего не выполняет сам")
    p.add_argument("--origin", default=env("WIDGET_ORIGIN", ""),
                   help="Origin для легитимных запросов; пусто — берём первый allowed_origins из /config")
    p.add_argument("--visitor-key", default=env("WIDGET_VISITOR_KEY", ""),
                   help="UUID посетителя; пусто — сгенерируем свежий")
    p.add_argument("--question", default=env("WIDGET_QUESTION", "Меня зовут Пётр"),
                   help="текст user_text-фрейма сценария 1 (несёт факт для сценариев 2/3)")
    p.add_argument("--greeting-timeout", type=float, default=float(env("WIDGET_GREETING_TIMEOUT", "60")),
                   help="сколько ждать greeting агента в chat после client_ready")
    p.add_argument("--answer-timeout", type=float, default=float(env("WIDGET_ANSWER_TIMEOUT", "60")),
                   help="сколько ждать ответ агента (и эхо) после user_text")
    p.add_argument("--agent-join-timeout", type=float, default=float(env("WIDGET_AGENT_JOIN_TIMEOUT", "60")),
                   help="сколько ждать вход агента в voice-комнату продолжения")
    p.add_argument("--resume-interval", type=float, default=float(env("WIDGET_RESUME_INTERVAL", "3")),
                   help="интервал повтора resume_welcome, секунды")
    p.add_argument("--resume-attempts", type=int, default=int(env("WIDGET_RESUME_ATTEMPTS", "5")),
                   help="сколько раз повторить resume_welcome")
    p.add_argument("--resume-grace", type=float, default=float(env("WIDGET_RESUME_GRACE", "10")),
                   help="доп. пауза после последней попытки resume_welcome")
    p.add_argument("--webhook-timeout", type=float, default=float(env("WIDGET_WEBHOOK_TIMEOUT", "90")),
                   help="сколько ждать session.finalized в core_events после POST /end")
    p.add_argument("--http-timeout", type=float, default=float(env("WIDGET_HTTP_TIMEOUT", "20")),
                   help="таймаут отдельного HTTP-запроса к BFF")
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.token:
        fail("--token обязателен (publish_token демо-виджета)")
        _epilogue(EXIT_SETUP, [])
        return EXIT_SETUP

    base = args.base_url.rstrip("/")
    ctx = Ctx(
        base_url=base, token=args.token, psql_prefix=args.psql, core_console=args.core_console,
        origin=args.origin, visitor_key=args.visitor_key or str(uuid.uuid4()),
        capped_visitor=str(uuid.uuid4()), question=args.question,
        greeting_timeout=args.greeting_timeout, answer_timeout=args.answer_timeout,
        agent_join_timeout=args.agent_join_timeout,
        resume_interval=args.resume_interval, resume_attempts=args.resume_attempts,
        resume_grace=args.resume_grace, webhook_timeout=args.webhook_timeout,
        http_timeout=args.http_timeout,
    )

    verdicts: list[str] = []

    try:
        selected = select_scenarios(args.only)
    except OnlyError as exc:
        # Через тот же путь, что и прочие «смок не смог начать»: с эпилогом и
        # обязательной строкой SMOKE-RESULT, кодом EXIT_SETUP (а не EXIT_ASSERT).
        fail(str(exc))
        _epilogue(EXIT_SETUP, [], 0)
        return EXIT_SETUP

    if args.only.strip():
        info(f"отобрано сценариев: {len(selected)} из {len(SCENARIOS)} "
             f"({', '.join(n for n, _ in selected)})")

    # ── Предполётная проверка: НЕ вердикт о BFF, а "смок вообще может начать" ──
    step("Предполётная проверка: SDK, BFF, конфиг виджета")
    # livekit-rtc спрашиваем, только если он кому-то из ОТОБРАННЫХ нужен.
    # Безусловная проверка делала гейт деплоя невозможным вне сервера с venv
    # воркера ядра — притом что сценарий 6 к LiveKit не прикасается.
    if any(name not in LIVEKIT_FREE for name, _ in selected):
        try:
            import livekit.rtc  # noqa: F401
        except ImportError as exc:
            fail(
                "нет livekit-rtc. Запускай интерпретатором ВОРКЕРА ЯДРА: "
                f"/opt/conversation-core/worker/.venv/bin/python {sys.argv[0]} ... ({exc})"
            )
            _epilogue(EXIT_SETUP, [], len(selected))
            return EXIT_SETUP
    else:
        info("livekit-rtc не требуется: отобранные сценарии комнату не поднимают")

    try:
        health = ctx.http("GET", "/healthz", timeout=10)
        if health.status != 200:
            raise SetupError(f"GET /healthz -> {health.status} {health.text[:200]}: BFF не отвечает")
        mark_bff_alive()
        ok(f"BFF живо: {base}")

        cfg_resp = ctx.http("GET", f"/w/v1/{ctx.token}/config", timeout=10)
        if cfg_resp.status != 200:
            raise SetupError(
                f"GET /w/v1/{{token}}/config -> {cfg_resp.status} {cfg_resp.text[:200]}: "
                "неверный publish_token или BFF не поднялся до конца"
            )
        cfg_body = cfg_resp.json()
        if not cfg_body.get("enabled"):
            raise SetupError(f"виджет выключен (enabled=false) — ни один сценарий не откроет диалог: {cfg_body}")
        if not ctx.origin:
            allowed = cfg_body.get("allowed_origins") or []
            if not allowed:
                raise SetupError(
                    "у виджета пустой allowed_origins и --origin не передан — "
                    "легитимным запросам просто неоткуда взять разрешённый Origin"
                )
            ctx.origin = allowed[0]
        ok(f"виджет '{cfg_body.get('name')}' включён, origin для легитимных запросов: {ctx.origin}")
    except SetupError as exc:
        fail(f"смок не смог начать: {exc}")
        _epilogue(EXIT_SETUP, [], len(selected))
        return EXIT_SETUP
    except CoreLostError as exc:
        # На предполётной проверке это тоже фактически «не смогли начать» —
        # BFF не успел даже толком отдать /healthz.
        fail(str(exc))
        _epilogue(EXIT_SETUP, [], len(selected))
        return EXIT_SETUP

    # ── 6 сценариев: вердикты СОБИРАЮТСЯ, прогон не обрывается на первом ────

    def record(name: str, exc: BaseException) -> None:
        fail(f"[{name}] {exc}")
        verdicts.append(name)

    async def run_all() -> Optional[BaseException]:
        core_lost: Optional[BaseException] = None
        try:
            for i, (name, fn) in enumerate(selected, start=1):
                step(f"Сценарий {i}/{len(selected)}: {name}")
                try:
                    if asyncio.iscoroutinefunction(fn):
                        await fn(ctx)
                    else:
                        fn(ctx)
                except CoreLostError as exc:
                    fail(f"[{name}] {exc}")
                    core_lost = exc
                    break
                except (SetupError, AssertError, AssertionError) as exc:
                    record(name, exc)
                except Exception as exc:  # noqa: BLE001 — баг сценария не должен обрывать остальные
                    record(name, f"необработанное исключение: {exc!r}")
        finally:
            await ctx.drop_chat_room()  # гигиена: не оставляем висящую LiveKit-комнату
        return core_lost

    core_lost = asyncio.run(run_all())

    if core_lost is not None:
        _epilogue(EXIT_CORE_LOST, verdicts, len(selected))
        return EXIT_CORE_LOST
    if verdicts:
        _epilogue(EXIT_ASSERT, verdicts, len(selected))
        return EXIT_ASSERT
    _epilogue(EXIT_OK, verdicts, len(selected))
    return EXIT_OK


def _epilogue(code: int, verdicts: list[str], total: int = len(SCENARIOS)) -> None:
    """Итог человеку + машиночитаемая последняя строка. (из chat_smoke.py ядра)

    `total` — сколько сценариев ОТОБРАНО этим прогоном (--only). Раньше здесь
    было жёстко «все 6»: под --only такой итог врал бы ровно в ту сторону,
    в которую врать нельзя — объявлял бы гейт фазы взятым по одному сценарию.
    """
    partial = total != len(SCENARIOS)
    print("", flush=True)
    if code == EXIT_OK and not partial:
        print(f"ИТОГ ({_stamp()}): все 6 сценариев §8 прошли — чат+дедуп эха, re-enter, "
              "эскалация в голос, лид, вебхук→usage, три негатива. ЭТО ГЕЙТ ФАЗЫ.", flush=True)
    elif code == EXIT_OK:
        print(f"ИТОГ ({_stamp()}): прошли отобранные сценарии ({total} из {len(SCENARIOS)}). "
              "ЭТО НЕ ГЕЙТ ФАЗЫ — гейтом считается только полный прогон без --only.", flush=True)
    elif code == EXIT_SETUP:
        print(f"ИТОГ ({_stamp()}): смок НЕ НАЧАЛСЯ (это не вердикт о BFF). "
              f"Диагностика — в строке FAIL выше. Ни один из {total} сценариев не запускался.",
              flush=True)
    elif code == EXIT_CORE_LOST:
        print(f"ИТОГ ({_stamp()}): BFF/ядро ПРОПАЛИ посреди прогона — это инцидент, "
              "а не сбой инструмента. Остаток сценариев не гонялся.", flush=True)
        print("         Смотреть: docker compose ps на стенде, логи backend/worker за этот момент, "
              "канал до стенда (ssh-туннель).", flush=True)
    else:
        print(f"ИТОГ ({_stamp()}): смок КРАСНЫЙ ({len(verdicts)} сценарий(ев) из {total}: "
              f"{', '.join(verdicts) or '—'}). Диагностика — в строках FAIL выше. Красный смок — "
              "чинить код, а НЕ ослаблять ассерт.", flush=True)
        print("         Логи: docker compose logs --tail 200 backend | grep -Ei "
              "'error|escalat|webhook|budget'", flush=True)

    print(
        f"SMOKE-RESULT: {RESULT_MARKERS.get(code, 'unknown')} exit={code} verdicts={len(verdicts)}",
        flush=True,
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
