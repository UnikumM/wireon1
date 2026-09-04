"""
Кто именно пришёл за своими плейлистами.

Общий токен сервера (`X-Wireon-Token`) для этого не годится и годиться не
может: он лежит внутри APK, а APK распаковывается. Он держит ручки закрытыми
от всего интернета — но сказать, чьи это плейлисты, он не в состоянии, и если
бы личность определялась им, любой распаковавший сборку читал бы чужое.

Поэтому личность подтверждает сам Discord. Клиент присылает свой токен доступа
заголовком `X-Discord-Token`, сервер спрашивает у Discord `/users/@me` и
получает оттуда идентификатор. Токен у нас не хранится нигде — ни в базе, ни в
журнале: он живёт в памяти на время запроса и в кэше ответов, ключом которого
служит его отпечаток, а не он сам.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger("wireon.identity")

DISCORD_ME_URL = "https://discord.com/api/v10/users/@me"

# Сколько держим подтверждённую личность. Discord не любит, когда его
# спрашивают об одном и том же на каждый запрос, а синхронизация ходит пачками:
# пять минут превращают десяток обращений в одно.
POSITIVE_TTL_S = 300.0

# Отказ кэшируется тоже, но коротко. Без этого клиент с протухшим токеном
# устраивает Discord поток запросов со скоростью своих повторов, и по этому
# потоку нас ограничат уже всех вместе.
NEGATIVE_TTL_S = 30.0

# Токен Discord — это компактная строка. Всё, что заметно длиннее, к Discord не
# поедет вовсе: проверять такое — значит пересылать чужой мусор со своего адреса.
MAX_TOKEN_LENGTH = 512


class IdentityError(Exception):
    """Личность не подтверждена. `code` уходит клиенту, подробности — в журнал."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def _fingerprint(token: str) -> str:
    """
    Ключ кэша вместо самого токена.

    Кэш живёт в памяти процесса, где рядом работают бот и VPN; класть в него
    ключи доступа к чужим аккаунтам в открытом виде незачем, когда для роли
    ключа словаря достаточно отпечатка.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class DiscordIdentity:
    """
    Проверка токенов с кэшем. Обращение к Discord инжектится, поэтому тесты
    гоняют это без сети.
    """

    def __init__(
        self,
        fetch_me: Optional[Any] = None,
        now: Any = time.monotonic,
        positive_ttl: float = POSITIVE_TTL_S,
        negative_ttl: float = NEGATIVE_TTL_S,
    ) -> None:
        self._fetch_me = fetch_me
        self._now = now
        self._positive_ttl = positive_ttl
        self._negative_ttl = negative_ttl
        # отпечаток -> (срок годности, идентификатор либо None у отказа)
        self._cache: Dict[str, Tuple[float, Optional[str]]] = {}
        self._lock = asyncio.Lock()
        self.stats = {"hits": 0, "asked": 0, "rejected": 0}

    async def user_id(self, session: Any, token: Optional[str]) -> str:
        """
        Идентификатор пользователя Discord или {@link IdentityError}.

        Возвращается именно `id`, а не имя: имя человек меняет когда захочет, и
        плейлисты, привязанные к имени, при первой же смене окажутся ничьими.
        """
        cleaned = (token or "").strip()
        if not cleaned:
            raise IdentityError("DISCORD_TOKEN_REQUIRED", "заголовок X-Discord-Token пуст")
        if len(cleaned) > MAX_TOKEN_LENGTH:
            raise IdentityError("DISCORD_TOKEN_INVALID", "токен неправдоподобно длинный")
        # Только ASCII, и это не придирка к алфавиту. Значения заголовков
        # приходят из сети как latin-1 с суррогатами, и первый же байт вне ASCII
        # валил `encode('utf-8')` внутри — то есть ручка отвечала 500 на любой
        # кривой заголовок, а не отказом. Настоящий токен Discord — base64url с
        # точками, в нём ничего кроме ASCII не бывает.
        if not cleaned.isascii():
            raise IdentityError("DISCORD_TOKEN_INVALID", "в токене есть символы вне ASCII")

        key = _fingerprint(cleaned)
        moment = self._now()

        cached = self._cache.get(key)
        if cached is not None and cached[0] > moment:
            self.stats["hits"] += 1
            if cached[1] is None:
                raise IdentityError("DISCORD_TOKEN_REJECTED", "Discord отказал (из кэша)")
            return cached[1]

        # Замок общий на всех: сто телефонов, проснувшихся одновременно, не
        # должны превратиться в сто одинаковых запросов к Discord.
        async with self._lock:
            cached = self._cache.get(key)
            if cached is not None and cached[0] > self._now():
                if cached[1] is None:
                    raise IdentityError("DISCORD_TOKEN_REJECTED", "Discord отказал (из кэша)")
                return cached[1]

            self.stats["asked"] += 1
            try:
                profile = await self._ask_discord(session, cleaned)
            except IdentityError:
                self._cache[key] = (self._now() + self._negative_ttl, None)
                self.stats["rejected"] += 1
                raise

            user_id = str(profile.get("id") or "").strip()
            if not user_id:
                self._cache[key] = (self._now() + self._negative_ttl, None)
                self.stats["rejected"] += 1
                raise IdentityError("DISCORD_TOKEN_REJECTED", "в ответе Discord нет id")

            self._cache[key] = (self._now() + self._positive_ttl, user_id)
            self._prune()
            return user_id

    async def _ask_discord(self, session: Any, token: str) -> Dict[str, Any]:
        if self._fetch_me is not None:
            return await self._fetch_me(session, token)

        import aiohttp

        try:
            timeout = aiohttp.ClientTimeout(total=8)
            async with session.get(
                DISCORD_ME_URL,
                headers={"Authorization": f"Bearer {token}"},
                timeout=timeout,
            ) as response:
                if response.status == 401:
                    raise IdentityError("DISCORD_TOKEN_REJECTED", "Discord ответил 401")
                if response.status != 200:
                    # Отличать «токен плохой» от «Discord прилёг» обязательно:
                    # по первому надо входить заново, по второму — подождать.
                    raise IdentityError(
                        "DISCORD_UNAVAILABLE", f"Discord ответил {response.status}"
                    )
                return await response.json()
        except IdentityError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise IdentityError("DISCORD_UNAVAILABLE", str(exc)) from exc

    def _prune(self) -> None:
        """Чистка по обращению: отдельный таймер ради десятка ключей — лишняя задача."""
        moment = self._now()
        stale = [key for key, (expires, _) in self._cache.items() if expires <= moment]
        for key in stale:
            del self._cache[key]
