"""
Ключ SoundCloud — один на всех, добывается сервером.

Откуда боль. У SoundCloud нет публичного API: `client_id` вычитывается из их же
веб-сборок и живёт недели. До 4.0 каждое устройство искало ключ само: грузило
soundcloud.com и несколько мегабайт его бандлов, нередко по мобильной сети, а
когда ключ протухал у всех разом — сотни телефонов шли за новым одновременно, и
SoundCloud отвечал 429. Десять правок в changelog лечили следствия.

Здесь причина убирается: ключ ищет один процесс, проверяет его раз в час и
отдаёт клиентам готовым (`GET /v1/soundcloud/key`). Клиент сообщает, если ключ
не принят (`POST /v1/soundcloud/key/dead`), и сервер идёт за новым — но не чаще
раза в `DISCOVERY_COOLDOWN_S`, чтобы не долбиться в SoundCloud при его поломке.

Сети в модуле нет напрямую: ему отдают `session` с методом `get(...)`, который
в работе — `aiohttp.ClientSession`, а в тестах — подделка.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, List, Optional

logger = logging.getLogger("wireon.soundcloud")

HOME_URL = "https://soundcloud.com"
API_URL = "https://api-v2.soundcloud.com"

#: Как долго ключ считается живым без перепроверки.
KEY_TTL_S = 60 * 60
#: Чаще этого за свежим ключом не ходим, даже если клиенты жалуются.
DISCOVERY_COOLDOWN_S = 10 * 60
#: Ключ лежит в одном из последних бандлов — весь список качать незачем.
MAX_BUNDLES = 8
REQUEST_TIMEOUT_S = 12

_SCRIPT_RE = re.compile(r'<script[^>]+src="([^">]+\.js)"')
_KEY_RES = (
    re.compile(r'client_id\s*[:=]\s*["\']([A-Za-z0-9]{32})["\']'),
    re.compile(r'["\']client_id["\']\s*:\s*["\']([A-Za-z0-9]{32})["\']'),
)
_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


@dataclass
class SoundCloudKey:
    client_id: str
    #: Когда ключ последний раз подтверждён запросом к API (unix-секунды).
    checked_at: float

    def as_json(self, ttl_s: float = KEY_TTL_S) -> dict:
        return {
            "clientId": self.client_id,
            "checkedAt": int(self.checked_at * 1000),
            # Клиенту отдаём срок, до которого можно не спрашивать снова.
            "expiresAt": int((self.checked_at + ttl_s) * 1000),
        }


def extract_bundle_urls(html: str) -> List[str]:
    """Адреса сборок со страницы, последние — первыми: ключ лежит в хвосте."""
    seen: List[str] = []
    for src in _SCRIPT_RE.findall(html):
        if "sndcdn.com" not in src and "/assets/" not in src:
            continue
        url = src if src.startswith("http") else f"{HOME_URL}{src}"
        if url not in seen:
            seen.append(url)
    return list(reversed(seen[-MAX_BUNDLES:]))


def extract_client_id(js: str) -> Optional[str]:
    for pattern in _KEY_RES:
        match = pattern.search(js)
        if match:
            return match.group(1)
    return None


async def _get_text(session: Any, url: str) -> Optional[str]:
    try:
        async with session.get(url, headers=_HEADERS, timeout=REQUEST_TIMEOUT_S) as response:
            if response.status != 200:
                logger.warning("soundcloud: %s ответил %s", url, response.status)
                return None
            return await response.text()
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — сеть; любой отказ равен «не достали»
        logger.warning("soundcloud: %s недоступен: %s", url, exc)
        return None


async def discover_client_id(session: Any) -> Optional[str]:
    """Вычитывает ключ из сборок soundcloud.com. `None` — не нашли."""
    html = await _get_text(session, HOME_URL)
    if not html:
        return None
    for url in extract_bundle_urls(html):
        js = await _get_text(session, url)
        if js:
            key = extract_client_id(js)
            if key:
                return key
    logger.warning("soundcloud: ключ не найден ни в одной из %d сборок", MAX_BUNDLES)
    return None


async def verify_client_id(session: Any, client_id: str) -> bool:
    """Ключ жив, если API отвечает на самый дешёвый запрос с ним."""
    url = f"{API_URL}/search/tracks?q=a&limit=1&client_id={client_id}"
    try:
        async with session.get(url, headers=_HEADERS, timeout=REQUEST_TIMEOUT_S) as response:
            return response.status == 200
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("soundcloud: проверка ключа не удалась: %s", exc)
        return False


class SoundCloudKeyKeeper:
    """
    Держит один ключ и решает, когда идти за новым.

    Параллельные запросы делят один поиск: иначе десять телефонов, пришедшие в
    одну секунду после протухания, устроили бы десять походов на soundcloud.com.
    """

    def __init__(
        self,
        *,
        seed: Iterable[str] = (),
        now: Callable[[], float] = time.time,
        ttl_s: float = KEY_TTL_S,
        cooldown_s: float = DISCOVERY_COOLDOWN_S,
    ) -> None:
        self._now = now
        self._ttl = ttl_s
        self._cooldown = cooldown_s
        #: Запасные ключи, с которых начинаем, пока свой не найден.
        self._seed = [key for key in seed if key]
        self._key: Optional[SoundCloudKey] = None
        self._last_discovery_at: float = float("-inf")
        self._inflight: Optional[asyncio.Task] = None
        self.stats = {"served": 0, "discoveries": 0, "dead_reports": 0}

    @property
    def current(self) -> Optional[SoundCloudKey]:
        return self._key

    def _fresh(self) -> bool:
        return self._key is not None and self._now() - self._key.checked_at < self._ttl

    async def get(self, session: Any) -> Optional[SoundCloudKey]:
        """Живой ключ или `None`, если взять негде."""
        if not self._fresh():
            await self._refresh(session)
        if self._key is not None:
            self.stats["served"] += 1
        return self._key

    async def report_dead(self, session: Any, client_id: str) -> Optional[SoundCloudKey]:
        """
        Клиент не смог воспользоваться ключом. Отказ про *этот* ключ, а не про
        загрузку — проверяется здесь же: если ключ всё ещё проходит проверку,
        жалоба считается отказом по конкретному треку и ключ не трогается.
        """
        self.stats["dead_reports"] += 1
        if self._key is None or self._key.client_id != client_id:
            return self._key
        if await verify_client_id(session, client_id):
            self._key = SoundCloudKey(client_id, self._now())
            return self._key
        self._key = None
        await self._refresh(session)
        return self._key

    async def _refresh(self, session: Any) -> None:
        if self._inflight is not None:
            await self._inflight
            return
        self._inflight = asyncio.ensure_future(self._do_refresh(session))
        try:
            await self._inflight
        finally:
            self._inflight = None

    async def _do_refresh(self, session: Any) -> None:
        # Сначала то, что уже есть: ключ мог просто просрочиться по времени, а не умереть.
        candidates: List[str] = []
        if self._key is not None:
            candidates.append(self._key.client_id)
        candidates.extend(key for key in self._seed if key not in candidates)
        for key in candidates:
            if await verify_client_id(session, key):
                self._key = SoundCloudKey(key, self._now())
                return

        if self._now() - self._last_discovery_at < self._cooldown:
            # Недавно уже искали и не нашли: SoundCloud лежит или сменил вёрстку.
            # Не молотим — клиенты получат «ключа нет» и пойдут своим запасным путём.
            self._key = None
            return
        self._last_discovery_at = self._now()
        self.stats["discoveries"] += 1
        found = await discover_client_id(session)
        if found and await verify_client_id(session, found):
            self._key = SoundCloudKey(found, self._now())
        else:
            self._key = None
