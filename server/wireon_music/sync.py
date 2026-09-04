"""
Хранилище плейлистов и избранного, общее для всех устройств одного человека.

Сервер здесь намеренно глупый. Он не решает, чья запись правильнее по смыслу, и
не склеивает содержимое плейлистов: разрешение конфликтов уже написано и
покрыто тестами в клиенте (`cloudSync.ts`, победа за более поздним
`updatedAt`). Второе такое же решение на сервере означало бы два места,
обязанных выбрать одинаково, — а расходиться они начнут в первый же день.

Чем сервер всё-таки распоряжается сам — это **надгробия**. Без них
синхронизация выглядит сломанной именно так, как это заметит человек: удалил
плейлист на телефоне, а он вернулся. Причина в порядке действий движка — он
сливает пришедшее в местное, а потом отправляет местное целиком, — поэтому
запись, которой у второго устройства ещё нет причины забывать, приезжает
обратно. Надгробие даёт эту причину: удаление живёт своей строкой с датой и
переживает следующую отправку.

Хранится всё в SQLite рядом с базой бота. Обычный `sqlite3` из стандартной
библиотеки, а не `aiosqlite`: запись занимает микросекунды и уходит в поток
тем же приёмом, что и вызов yt-dlp, — а зависимостей у контейнера с 500 МБ
памяти и без того достаточно.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("wireon.sync")

DB_PATH_ENV = "WIREON_SYNC_DB"
DEFAULT_DB_NAME = "wireon_sync.db"

KIND_PLAYLIST = "playlist"
KIND_FAVORITE = "favorite"
KINDS = (KIND_PLAYLIST, KIND_FAVORITE)

# Пределы на человека. Контейнер делит один гигабайт диска с ботом и его базой,
# поэтому «сколько пришлют» — не вариант: один сломанный клиент в цикле забьёт
# место и уронит заодно бота.
MAX_RECORD_BYTES = 256 * 1024
MAX_RECORDS_PER_KIND = 2000
MAX_PUSH_BATCH = 500

# Надгробия живут долго, но не вечно: устройство, не выходившее на связь дольше
# этого, всё равно уже разошлось с остальными сильнее, чем помнит база.
TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000


class SyncError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def database_path(directory: Optional[str] = None) -> str:
    raw = os.getenv(DB_PATH_ENV, "").strip()
    if raw:
        return raw
    base = Path(directory) if directory else Path(__file__).resolve().parent.parent
    return str(base / DEFAULT_DB_NAME)


def _now_ms() -> int:
    return int(time.time() * 1000)


class SyncStore:
    """
    Одна таблица на всё. Записи и надгробия лежат вместе: у надгробия просто нет
    содержимого, зато есть дата — и по ней видно, что новее, удаление или правка.
    """

    def __init__(self, path: Optional[str] = None, now: Any = _now_ms) -> None:
        self._path = path or database_path()
        self._now = now
        self._lock = asyncio.Lock()
        self._conn: Optional[sqlite3.Connection] = None

    # -- служебное ----------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        if self._conn is None:
            # `check_same_thread=False` безопасно ровно потому, что каждое
            # обращение идёт через `asyncio.to_thread` под общим замком ниже:
            # двух одновременных пользователей у соединения не бывает.
            conn = sqlite3.connect(self._path, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS records (
                    user_id    TEXT NOT NULL,
                    kind       TEXT NOT NULL,
                    record_id  TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    deleted    INTEGER NOT NULL DEFAULT 0,
                    payload    TEXT,
                    PRIMARY KEY (user_id, kind, record_id)
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS records_by_owner ON records (user_id, kind, deleted)"
            )
            conn.commit()
            self._conn = conn
        return self._conn

    async def _run(self, func: Any, *args: Any) -> Any:
        async with self._lock:
            return await asyncio.to_thread(func, *args)

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # -- чтение -------------------------------------------------------------

    async def pull(self, user_id: str) -> Dict[str, Any]:
        """Всё живое плюс идентификаторы удалённого."""
        return await self._run(self._pull_sync, user_id)

    def _pull_sync(self, user_id: str) -> Dict[str, Any]:
        conn = self._connect()
        alive: Dict[str, List[dict]] = {kind: [] for kind in KINDS}
        deleted: Dict[str, List[str]] = {kind: [] for kind in KINDS}

        # Когда именно удалили — отдельным полем рядом со списком.
        #
        # Без даты надгробие применяется вслепую, и это ломает обратное
        # действие: человек убрал трек, передумал, вернул — а сверка сносит его
        # снова, потому что удаление «просто есть». С датой видно, что возврат
        # новее, и он побеждает по тому же правилу, что и любая правка.
        #
        # Новым полем, а не заменой списка: сборки, которые про дату не знают,
        # продолжают читать `deleted` как раньше.
        deleted_at: Dict[str, Dict[str, int]] = {kind: {} for kind in KINDS}

        cursor = conn.execute(
            "SELECT kind, record_id, deleted, payload, updated_at FROM records WHERE user_id = ?",
            (user_id,),
        )
        for kind, record_id, is_deleted, payload, updated_at in cursor:
            if kind not in alive:
                continue
            if is_deleted:
                deleted[kind].append(record_id)
                deleted_at[kind][record_id] = int(updated_at)
                continue
            try:
                alive[kind].append(json.loads(payload))
            except (TypeError, ValueError):
                # Испорченную строку молча пропускаем: одна нечитаемая запись не
                # повод отказать человеку во всей медиатеке.
                logger.warning("битая запись %s/%s у %s", kind, record_id, user_id)

        return {
            "playlists": alive[KIND_PLAYLIST],
            "favorites": alive[KIND_FAVORITE],
            "deleted": {
                "playlists": deleted[KIND_PLAYLIST],
                "favorites": deleted[KIND_FAVORITE],
            },
            "deletedAt": {
                "playlists": deleted_at[KIND_PLAYLIST],
                "favorites": deleted_at[KIND_FAVORITE],
            },
        }

    async def revision(self, user_id: str) -> int:
        """
        Отметка последнего изменения медиатеки этого человека.

        Берётся из самих записей (`MAX(updated_at)`), а не из счётчика в памяти,
        и это важно: счётчик обнулялся бы при каждом перезапуске контейнера, и
        все устройства разом решали бы, что что-то изменилось.

        Ноль означает «у этого человека ещё ничего нет» — и это тоже валидная
        отметка: как только появится первая запись, число станет больше.
        """
        return await self._run(self._revision_sync, user_id)

    def _revision_sync(self, user_id: str) -> int:
        conn = self._connect()
        row = conn.execute(
            "SELECT COALESCE(MAX(updated_at), 0) FROM records WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        return int(row[0]) if row else 0

    # -- запись -------------------------------------------------------------

    async def push(self, user_id: str, kind: str, records: List[dict]) -> int:
        """
        Кладёт записи и возвращает, сколько из них приняли.

        «Приняли» — это не «получили»: запись старше уже лежащей отбрасывается,
        и число в ответе отличается от числа отправленных именно на такие. Врать
        тут нельзя, клиент по этому числу решает, помечать ли своё как
        отправленное.
        """
        if kind not in KINDS:
            raise SyncError("SYNC_BAD_KIND", f"неизвестный раздел: {kind}")
        if len(records) > MAX_PUSH_BATCH:
            raise SyncError(
                "SYNC_BATCH_TOO_LARGE",
                f"за раз принимается не больше {MAX_PUSH_BATCH} записей",
            )
        return await self._run(self._push_sync, user_id, kind, records)

    def _push_sync(self, user_id: str, kind: str, records: List[dict]) -> int:
        conn = self._connect()
        moment = self._now()
        stored = 0

        existing = self._existing_count(conn, user_id, kind)

        for record in records:
            record_id = str(record.get("id") or "").strip()
            if not record_id:
                continue

            payload = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
            if len(payload.encode("utf-8")) > MAX_RECORD_BYTES:
                logger.warning("запись %s/%s у %s слишком велика", kind, record_id, user_id)
                continue

            updated_at = _record_stamp(record, moment)

            row = conn.execute(
                "SELECT updated_at, deleted FROM records WHERE user_id = ? AND kind = ? AND record_id = ?",
                (user_id, kind, record_id),
            ).fetchone()

            if row is not None:
                known_at, is_deleted = row
                # Строго старше: при равных датах побеждает то, что уже лежит.
                # Иначе два устройства с одинаковой отметкой перезаписывали бы
                # друг друга по кругу на каждой синхронизации.
                if updated_at <= known_at:
                    continue
                if is_deleted and updated_at <= known_at:
                    continue
            elif existing >= MAX_RECORDS_PER_KIND:
                raise SyncError(
                    "SYNC_QUOTA_EXCEEDED",
                    f"больше {MAX_RECORDS_PER_KIND} записей в разделе {kind} не храним",
                )
            else:
                existing += 1

            conn.execute(
                """
                INSERT INTO records (user_id, kind, record_id, updated_at, deleted, payload)
                VALUES (?, ?, ?, ?, 0, ?)
                ON CONFLICT(user_id, kind, record_id)
                DO UPDATE SET updated_at = excluded.updated_at, deleted = 0, payload = excluded.payload
                """,
                (user_id, kind, record_id, updated_at, payload),
            )
            stored += 1

        conn.commit()
        return stored

    async def delete(self, user_id: str, kind: str, record_id: str) -> bool:
        if kind not in KINDS:
            raise SyncError("SYNC_BAD_KIND", f"неизвестный раздел: {kind}")
        return await self._run(self._delete_sync, user_id, kind, record_id)

    def _delete_sync(self, user_id: str, kind: str, record_id: str) -> bool:
        conn = self._connect()
        # Надгробие ставится и на то, чего у нас не было. Устройство, удалившее
        # запись раньше, чем успело её отправить, иначе получило бы её обратно
        # от соседа — а для человека это одно и то же удаление, которое не
        # сработало.
        conn.execute(
            """
            INSERT INTO records (user_id, kind, record_id, updated_at, deleted, payload)
            VALUES (?, ?, ?, ?, 1, NULL)
            ON CONFLICT(user_id, kind, record_id)
            DO UPDATE SET updated_at = excluded.updated_at, deleted = 1, payload = NULL
            """,
            (user_id, kind, record_id, self._now()),
        )
        conn.commit()
        return True

    # -- уборка -------------------------------------------------------------

    async def prune_tombstones(self) -> int:
        return await self._run(self._prune_sync)

    def _prune_sync(self) -> int:
        conn = self._connect()
        cutoff = self._now() - TOMBSTONE_TTL_MS
        cursor = conn.execute(
            "DELETE FROM records WHERE deleted = 1 AND updated_at < ?", (cutoff,)
        )
        conn.commit()
        return cursor.rowcount or 0

    async def stats(self) -> Dict[str, int]:
        return await self._run(self._stats_sync)

    def _stats_sync(self) -> Dict[str, int]:
        conn = self._connect()
        rows = conn.execute(
            "SELECT deleted, COUNT(*) FROM records GROUP BY deleted"
        ).fetchall()
        counts = {int(flag): int(total) for flag, total in rows}
        owners = conn.execute("SELECT COUNT(DISTINCT user_id) FROM records").fetchone()
        return {
            "records": counts.get(0, 0),
            "tombstones": counts.get(1, 0),
            "owners": int(owners[0]) if owners else 0,
        }

    @staticmethod
    def _existing_count(conn: sqlite3.Connection, user_id: str, kind: str) -> int:
        row = conn.execute(
            "SELECT COUNT(*) FROM records WHERE user_id = ? AND kind = ? AND deleted = 0",
            (user_id, kind),
        ).fetchone()
        return int(row[0]) if row else 0


def _record_stamp(record: dict, fallback: int) -> int:
    """
    Отметка времени записи в том виде, в каком её понимает клиент.

    У плейлиста это `updatedAt`, у избранного — `addedAt`: своих полей у них
    разный набор, а сравнивать надо тем же числом, которым сравнивает
    `cloudSync`, иначе победитель на сервере и на клиенте окажется разным.
    """
    for key in ("updatedAt", "addedAt", "createdAt"):
        value = record.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
    return fallback


def sanitize_records(records: Any) -> List[dict]:
    """Оставляет то, что вообще похоже на запись. Ключ — непустой `id`."""
    if not isinstance(records, list):
        raise SyncError("SYNC_BAD_BODY", "ожидался список записей")
    clean: List[dict] = []
    for item in records:
        if isinstance(item, dict) and str(item.get("id") or "").strip():
            clean.append(item)
    return clean
