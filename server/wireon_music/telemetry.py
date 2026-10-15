"""
Статистика и ошибки от приложений: сколько установок живо, у кого что не играет.

Что хранится и чего нет — это и есть договор с пользователями:

- установка — случайный идентификатор, который приложение придумало само;
  к нему версия, платформа и, если человек вошёл, имя и id Discord (как
  прислал клиент — для статистики этого хватает, сверять с Discord незачем);
- события загрузки трека: у удачных только источник и время, у неудачных ещё
  код, текст ошибки и id трека — без него ошибку не воспроизвести;
- **адреса не хранятся нигде**: ни здесь, ни в журнале запросов (он выключен в
  `start_server`), события старше {RETENTION_DAYS} дней удаляются.

Сводка — `python -m wireon_music.telemetry` в контейнере.
"""

from __future__ import annotations

import asyncio
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

DB_PATH_ENV = "WIREON_TELEMETRY_DB"
DEFAULT_DB_NAME = "wireon_telemetry.db"

RETENTION_DAYS = 30
MAX_EVENTS_PER_REPORT = 100
MAX_DETAIL = 300
DAY_MS = 24 * 60 * 60 * 1000

PLATFORMS = ("windows", "linux", "mac", "android", "browser")
_INSTALL_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
_VIDEO_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
_URL_RE = re.compile(r"[a-z][a-z0-9+.-]*://\S+", re.I)
_IPV4_RE = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
_IPV6_RE = re.compile(r"\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b", re.I)


def scrub(text: str) -> str:
    """Ссылки и адреса прочь: в ссылке googlevideo зашит IP человека (`ip=…`)."""
    return _IPV6_RE.sub("<адрес>", _IPV4_RE.sub("<адрес>", _URL_RE.sub("<ссылка>", text)))


class TelemetryError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def database_path() -> str:
    raw = os.getenv(DB_PATH_ENV, "").strip()
    return raw or str(Path(__file__).resolve().parent.parent / DEFAULT_DB_NAME)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _text(value: Any, limit: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned[:limit] if cleaned else None


def sanitize_report(body: Any) -> Dict[str, Any]:
    """Отчёт клиента в проверенную форму или {@link TelemetryError}."""
    if not isinstance(body, dict):
        raise TelemetryError("TELEMETRY_BAD_BODY", "ожидался объект")
    install = body.get("install")
    if not isinstance(install, str) or not _INSTALL_RE.match(install):
        raise TelemetryError("TELEMETRY_BAD_INSTALL", "нет идентификатора установки")
    platform = body.get("platform") if body.get("platform") in PLATFORMS else "unknown"
    raw_events = body.get("events") or []
    if not isinstance(raw_events, list):
        raise TelemetryError("TELEMETRY_BAD_BODY", "events — не список")

    events: List[Dict[str, Any]] = []
    for raw in raw_events[:MAX_EVENTS_PER_REPORT]:
        if not isinstance(raw, dict):
            continue
        ok = raw.get("ok") is True
        at = raw.get("at")
        ms = raw.get("ms")
        video = raw.get("videoId")
        events.append(
            {
                "at": int(at) if isinstance(at, (int, float)) and at > 0 else None,
                "kind": _text(raw.get("kind"), 32) or "resolve",
                "ok": ok,
                "source": _text(raw.get("source"), 32),
                "ms": int(ms) if isinstance(ms, (int, float)) and 0 <= ms < 10 * 60 * 1000 else None,
                # Подробности только у отказов: у удачных они — просто список
                # того, что человек слушал, а нам нужна статистика, не слежка.
                "code": None if ok else _text(raw.get("code"), 48),
                "detail": None if ok else _text(scrub(str(raw.get("detail") or "")), MAX_DETAIL),
                "video_id": None if ok or not isinstance(video, str) or not _VIDEO_RE.match(video) else video,
            }
        )

    return {
        "install": install,
        "version": _text(body.get("version"), 24),
        "platform": platform,
        "discord_id": _text(body.get("discordId"), 32),
        "discord_name": _text(body.get("discordName"), 64),
        "events": events,
    }


class TelemetryStore:
    def __init__(self, path: Optional[str] = None, now: Any = _now_ms) -> None:
        self._path = path or database_path()
        self._now = now
        self._lock = asyncio.Lock()
        self._conn: Optional[sqlite3.Connection] = None

    def _connect(self) -> sqlite3.Connection:
        if self._conn is None:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS installs (
                    install      TEXT PRIMARY KEY,
                    first_seen   INTEGER NOT NULL,
                    last_seen    INTEGER NOT NULL,
                    version      TEXT,
                    platform     TEXT,
                    discord_id   TEXT,
                    discord_name TEXT
                );
                CREATE TABLE IF NOT EXISTS events (
                    install  TEXT NOT NULL,
                    at       INTEGER NOT NULL,
                    kind     TEXT NOT NULL,
                    ok       INTEGER NOT NULL,
                    source   TEXT,
                    ms       INTEGER,
                    code     TEXT,
                    detail   TEXT,
                    video_id TEXT
                );
                CREATE INDEX IF NOT EXISTS events_by_time ON events (at);
                """
            )
            self._conn = conn
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    async def record(self, report: Dict[str, Any]) -> int:
        async with self._lock:
            return await asyncio.to_thread(self._record_sync, report)

    def _record_sync(self, report: Dict[str, Any]) -> int:
        conn = self._connect()
        now = self._now()
        conn.execute(
            """
            INSERT INTO installs (install, first_seen, last_seen, version, platform, discord_id, discord_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(install) DO UPDATE SET
                last_seen = excluded.last_seen,
                version = COALESCE(excluded.version, installs.version),
                platform = excluded.platform,
                discord_id = COALESCE(excluded.discord_id, installs.discord_id),
                discord_name = COALESCE(excluded.discord_name, installs.discord_name)
            """,
            (report["install"], now, now, report["version"], report["platform"], report["discord_id"], report["discord_name"]),
        )
        rows = [
            (
                report["install"],
                # Часы телефона врут; дата из будущего или из прошлого года
                # сломала бы и сводку «за сутки», и чистку.
                e["at"] if e["at"] and abs(e["at"] - now) < DAY_MS else now,
                e["kind"],
                1 if e["ok"] else 0,
                e["source"],
                e["ms"],
                e["code"],
                e["detail"],
                e["video_id"],
            )
            for e in report["events"]
        ]
        conn.executemany("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        conn.execute("DELETE FROM events WHERE at < ?", (now - RETENTION_DAYS * DAY_MS,))
        conn.commit()
        return len(rows)

    def summary(self) -> Dict[str, Any]:
        conn = self._connect()
        now = self._now()
        one = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
        week = now - 7 * DAY_MS
        day = now - DAY_MS
        times = [r[0] for r in conn.execute(
            "SELECT ms FROM events WHERE ok = 1 AND ms IS NOT NULL AND at >= ? ORDER BY ms", (day,)
        )]
        return {
            "installs": one("SELECT COUNT(*) FROM installs"),
            "active_day": one("SELECT COUNT(*) FROM installs WHERE last_seen >= ?", day),
            "active_week": one("SELECT COUNT(*) FROM installs WHERE last_seen >= ?", week),
            "platforms_week": conn.execute(
                "SELECT platform, COUNT(*) FROM installs WHERE last_seen >= ? GROUP BY 1 ORDER BY 2 DESC", (week,)
            ).fetchall(),
            "versions_week": conn.execute(
                "SELECT version, COUNT(*) FROM installs WHERE last_seen >= ? GROUP BY 1 ORDER BY 2 DESC", (week,)
            ).fetchall(),
            "users_week": [r[0] for r in conn.execute(
                "SELECT discord_name FROM installs WHERE last_seen >= ? AND discord_name IS NOT NULL ORDER BY last_seen DESC",
                (week,),
            )],
            "resolves_day": one("SELECT COUNT(*) FROM events WHERE at >= ?", day),
            "failures_day": one("SELECT COUNT(*) FROM events WHERE at >= ? AND ok = 0", day),
            "median_ms_day": times[len(times) // 2] if times else None,
            "top_failures_week": conn.execute(
                """
                SELECT COALESCE(code, '?'), COUNT(*), COUNT(DISTINCT install), MAX(detail)
                FROM events WHERE at >= ? AND ok = 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 10
                """,
                (week,),
            ).fetchall(),
        }


def _print_summary(s: Dict[str, Any]) -> None:
    print(f"установок всего: {s['installs']}; за сутки: {s['active_day']}; за неделю: {s['active_week']}")
    print("платформы (неделя):", ", ".join(f"{p or '?'} {n}" for p, n in s["platforms_week"]) or "—")
    print("версии (неделя):", ", ".join(f"{v or '?'} {n}" for v, n in s["versions_week"]) or "—")
    print("кто (Discord, неделя):", ", ".join(s["users_week"]) or "—")
    median = f"{s['median_ms_day'] / 1000:.1f} с" if s["median_ms_day"] is not None else "—"
    print(f"загрузок за сутки: {s['resolves_day']}, ошибок: {s['failures_day']}, медиана до звука: {median}")
    print("частые ошибки (неделя):")
    for code, count, installs, detail in s["top_failures_week"]:
        print(f"  {code}: {count} раз у {installs} установок — {(detail or '')[:160]}")


if __name__ == "__main__":
    store = TelemetryStore(sys.argv[1] if len(sys.argv) > 1 else None)
    _print_summary(store.summary())
