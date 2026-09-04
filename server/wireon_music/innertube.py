"""
InnerTube через сервер — то же, что делают IPC-хендлеры `search-youtube` и
`youtube-radio` в `electron/main.ts`.

Почему это обязано жить на сервере. Ответ на такой запрос можно получить только
у InnerTube, а из renderer он недостижим: запрос уходит с
`Content-Type: application/json` и `X-YouTube-Client-Name`, поэтому браузер
обязан сделать предзапрос CORS, а `OPTIONS` на `music.youtube.com/youtubei/v1/*`
отвечает отказом. На десктопе это обходится главным процессом. На Android
главного процесса нет вовсе — значит, обходить приходится здесь.

Возвращаем **сырой JSON**, а не разобранные треки. Разбор уже написан на
клиенте (`parseInnerTubeResponse`, `parseRadioResponse`) и проверен тестами;
второй разбор на сервере означал бы два места, где надо одинаково угадать
структуру InnerTube, и они разъехались бы на первой же смене формата.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional

logger = logging.getLogger("wireon.innertube")

SEARCH_URL = "https://music.youtube.com/youtubei/v1/search"
NEXT_URL = "https://music.youtube.com/youtubei/v1/next"

# Тот же User-Agent, что в главном процессе: InnerTube отдаёт другую разметку
# мобильным клиентам, а разбор на клиенте написан под эту.
DESKTOP_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

CLIENT_NAME = "WEB_REMIX"
CLIENT_VERSION = "1.20240101.01.00"

# `Eg-KAQwIARAAGAAgACgAMABqChAEEAMQCRAFEAo%3D` — фильтр «только песни».
# Скопирован из главного процесса как есть: он закодирован протобуфом, и
# «поправить» его нельзя, только заменить целиком на другой готовый.
SONGS_ONLY_PARAMS = "Eg-KAQwIARAAGAAgACgAMABqChAEEAMQCRAFEAo%3D"

VIDEO_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{11}$")

REQUEST_TIMEOUT_S = 12


def _headers() -> Dict[str, str]:
    return {
        "Content-Type": "application/json",
        "User-Agent": DESKTOP_USER_AGENT,
        "X-YouTube-Client-Name": "67",
        "Origin": "https://music.youtube.com",
        "Referer": "https://music.youtube.com/",
    }


def _context(hl: str, gl: str) -> Dict[str, Any]:
    return {"client": {"clientName": CLIENT_NAME, "clientVersion": CLIENT_VERSION, "hl": hl, "gl": gl}}


class InnerTubeError(Exception):
    """InnerTube ответил не 200 либо не ответил вовсе."""


async def search(session: Any, query: str, *, hl: str = "ru", gl: str = "RU") -> Dict[str, Any]:
    """Поиск песен. Отдаёт сырой ответ InnerTube."""
    import aiohttp

    payload = {"context": _context(hl, gl), "query": query, "params": SONGS_ONLY_PARAMS}
    try:
        timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_S)
        async with session.post(SEARCH_URL, json=payload, headers=_headers(), timeout=timeout) as response:
            if response.status != 200:
                raise InnerTubeError(f"search HTTP {response.status}")
            return await response.json()
    except InnerTubeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise InnerTubeError(f"search failed: {exc}") from exc


async def radio(session: Any, video_id: str, *, hl: str = "ru", gl: str = "RU") -> Dict[str, Any]:
    """
    Радио YouTube Music от конкретной песни — то самое «слушая фонк, получаете фонк».

    `playlistId` обязателен и обязан быть `RDAMVM<id>`: это идентификатор
    радиостанции для данного видео. Без него `next` отдаёт очередь из одного
    трека — той же песни, — и это выглядит как «радио не работает».

    Несуществующий videoId деградирует до пустой очереди, а не в HTTP-ошибку,
    поэтому пустой разбор действительно означает «этим путём не вышло».
    """
    import aiohttp

    if not VIDEO_ID_PATTERN.match(video_id or ""):
        raise InnerTubeError(f"invalid video id: {video_id!r}")

    payload = {
        "context": _context(hl, gl),
        "videoId": video_id,
        "playlistId": f"RDAMVM{video_id}",
        "isAudioOnly": True,
    }
    try:
        timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_S)
        async with session.post(NEXT_URL, json=payload, headers=_headers(), timeout=timeout) as response:
            if response.status != 200:
                raise InnerTubeError(f"next HTTP {response.status}")
            return await response.json()
    except InnerTubeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise InnerTubeError(f"radio failed: {exc}") from exc


def queue_length(data: Optional[dict]) -> int:
    """
    Сколько треков в очереди радио. Нужно только для журнала и проверок:
    разбором занимается клиент, но «ответ пришёл и он пустой» стоит различать от
    «ответ пришёл с пятьюдесятью треками» прямо здесь.
    """
    try:
        contents = (
            (data or {})
            .get("contents", {})
            .get("singleColumnMusicWatchNextResultsRenderer", {})
            .get("tabbedRenderer", {})
            .get("watchNextTabbedResultsRenderer", {})
            .get("tabs", [{}])[0]
            .get("tabRenderer", {})
            .get("content", {})
            .get("musicQueueRenderer", {})
            .get("content", {})
            .get("playlistPanelRenderer", {})
            .get("contents", [])
        )
        return sum(1 for item in contents if isinstance(item, dict) and "playlistPanelVideoRenderer" in item)
    except Exception:  # noqa: BLE001 — структура InnerTube меняется без предупреждения
        return 0
