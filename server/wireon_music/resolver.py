"""
Добыча ссылки на аудио через yt-dlp — серверная сторона того, что на десктопе
делает `electron/streamResolver.ts`.

Главное решение владельца, от которого зависит всё остальное: **сервер отдаёт
ссылку, а не поток**. Телефон качает звук напрямую с `googlevideo`, через нас
идёт около килобайта JSON на трек. Иначе один контейнер с 500 МБ памяти
раздавал бы гигабайты всем слушателям сразу, и на нём же живёт VPN.

Исключение появилось 2026-08-28 и живёт в `proxy.py`: ссылка, выданная нам,
подписана вместе с нашим адресом и с телефона отвечает 403, а телефону YouTube
на часть треков не отдаёт ссылку вовсе. Для них байты идут через контейнер —
но только для них, и это запасной путь, а не новый основной.

Лестница попыток скопирована из десктопной не «для единообразия», а потому что
она подобрана под конкретное поведение YouTube и любая правка по памяти её
ломает: `tv` и `tv_downgraded` в извлекателе вообще не имеют политики
PO-токена, у `visionos` её тоже нет и ему не нужен JS-плеер, `web_safari`
отдаёт склеенный HLS. `android_vr` отдаёт 403 на все форматы, `web_music`
требует GVS PO-token — их здесь нет намеренно.

Отличие от десктопа одно, и оно важное: у сервера один IP на всех слушателей,
поэтому проверка «вы не робот» прилетит раньше и чаще. Лекарство на десктопе —
cookies из браузера человека; здесь такого нет, поэтому вместо него стоит
жёсткий предел одновременных извлечений и общий кэш ссылок: сто человек,
слушающих одну песню, дают один запрос к YouTube, а не сто.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse, parse_qs

logger = logging.getLogger("wireon.resolver")

VIDEO_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{11}$")

# Флаги, общие для всех попыток. Держатся словарём, а не строкой аргументов,
# потому что через этот же словарь тесты видят, с каким клиентом ушла попытка;
# в командную строку бинарника их переводит `_extract_with_ytdlp`.
BASE_OPTS: Dict[str, Any] = {
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "nocheckcertificate": True,
    "socket_timeout": 12,
    "retries": 1,
    "skip_download": True,
}


@dataclass(frozen=True)
class Attempt:
    label: str
    client: Optional[str]


# Порядок — от самых живучих к самым капризным. Не менять по памяти: см. шапку.
# Эта лестница — для работы **без** cookies: так ходит десктоп с домашнего адреса.
RESOLVE_ATTEMPTS: Tuple[Attempt, ...] = (
    Attempt("default", None),
    Attempt("tv", "tv"),
    Attempt("tv_downgraded", "tv_downgraded"),
    Attempt("visionos", "visionos"),
    Attempt("web_safari", "web_safari"),
)

# С cookies лестница другая, и это не тонкая настройка, а необходимость.
# Замерено 2026-08-28 через адрес самого контейнера (локальный yt-dlp той же
# ночной сборки, пущенный через SOCKS5 контейнера, — так меняется только адрес):
#
#   default        4 дорожки только-аудио   ← работает
#   web_embedded   4 дорожки только-аудио   ← работает
#   web, mweb, web_safari, web_embedded*    0 дорожек, только картинки
#   tv, tv_downgraded                       «The page needs to be reloaded»
#   visionos                                yt-dlp пропускает: не умеет cookies
#   ios, android, android_vr                ответа плеера нет вовсе
#
# Держать здесь мёртвые ступени — это не «запас надёжности», а лишние 20 секунд
# ожидания на каждый трек, который и так не выйдет.
RESOLVE_ATTEMPTS_WITH_COOKIES: Tuple[Attempt, ...] = (
    Attempt("default", None),
    Attempt("web_embedded", "web_embedded"),
)


def attempts_for(has_cookies: bool) -> Tuple[Attempt, ...]:
    """Лестница под текущую настройку. Отдельной функцией — чтобы её проверяли тесты."""
    return RESOLVE_ATTEMPTS_WITH_COOKIES if has_cookies else RESOLVE_ATTEMPTS

# Отказы, при которых перебор клиентов бессмысленен: возраст, приватность и
# география одинаковы для всех клиентов, а отсутствующий бинарник — тем более.
TERMINAL_PATTERNS: Tuple[Tuple[re.Pattern, str], ...] = (
    (re.compile(r"age[- ]restricted|confirm your age|inappropriate for some users", re.I), "YT_AGE_RESTRICTED"),
    (re.compile(r"private video|sign in if you've been granted access", re.I), "YT_PRIVATE"),
    (
        re.compile(
            r"available in your country|available (?:in|from) your location|geo[- ]?restricted|blocked it in your country",
            re.I,
        ),
        "YT_GEO_BLOCKED",
    ),
    (re.compile(r"video unavailable|has been removed|been terminated|does not exist", re.I), "YT_UNAVAILABLE"),
    (re.compile(r"is live|premiere|live event will begin", re.I), "YT_LIVE"),
)

# «Sign in to confirm you're not a bot». Не приговор видео: один клиент видит
# проверку, другой в ту же секунду отдаёт формат, — поэтому среди терминальных
# её нет. Но если её увидели все, честный ответ человеку не «ничего не вышло».
BOT_CHECK_PATTERN = re.compile(r"not a bot|bot check|confirm your identity", re.I)

# Срок жизни ссылки, если в ней нет `expire`.
DEFAULT_STREAM_TTL_S = 5 * 60 * 60

# Кэш держим до истечения минус минута: ссылка, умершая на середине запроса,
# выглядит как поломка приложения, а не как истёкший срок.
CACHE_MARGIN_S = 60

# Столько извлечений разрешено одновременно. yt-dlp — процесс на полсекунды
# работы и несколько запросов к YouTube; на одном ядре с лимитом 50% больше
# трёх означает, что все ждут дольше, чем если бы стояли в очереди.
MAX_CONCURRENT_EXTRACTIONS = 3

# Файл cookies YouTube. Это единственное лекарство от проверки «вы не робот»
# на адресе дата-центра: замерено 2026-08-28 на этом самом контейнере — первый
# запрос после запуска прошёл, следующие восемь из восьми получили проверку на
# всех пяти клиентах лестницы, и покой её не снимает. У десктопа этой беды нет
# только потому, что там домашний адрес.
#
# Файл в репозиторий не попадает и не попадёт: это доступ к живому аккаунту.
# Он кладётся в контейнер отдельно и читается отсюда по пути из окружения.
COOKIES_ENV = "WIREON_YTDLP_COOKIES"
DEFAULT_COOKIES_NAME = "yt-cookies.txt"

# Движок JavaScript. Нужен из-за связки, которую видно только на живом сервере:
# cookies снимают проверку «вы не робот», но залогиненному запросу YouTube
# отдаёт ответ плеера с зашифрованным параметром `n`, а расшифровать его умеет
# только настоящий JS. Без движка yt-dlp честно пишет «n challenge solving
# failed» и оставляет одни картинки — то есть cookies без движка не лечат
# ничего, а меняют один отказ на другой.
#
# Замерено 2026-08-28: анонимно и с домашнего адреса ссылка достаётся без
# всякого JS, поэтому на десктопе этого файла и не понадобилось.
JS_RUNTIME_ENV = "WIREON_JS_RUNTIME"

# Порядок здесь — результат замера на живом контейнере, а не вкусовщина.
# Deno в нём умирает сигналом 9: у V8 аппетит больше, чем остаток от 500 МБ, на
# которых уже сидят VPN, два телеграм-бота и cloudflared. yt-dlp это показывает
# как `Error running deno process (returncode: -9)`, и без предупреждений в
# stderr отличить это от испорченных cookies невозможно. QuickJS решает тот же
# challenge, весит 2.5 МБ вместо 95 и живёт в остатке памяти спокойно.
#
# Пара «имя для yt-dlp» → «имя файла»: у QuickJS исполняемый файл зовётся `qjs`.
JS_RUNTIME_FILES = (
    ("quickjs", "qjs"),
    ("node", "node"),
    ("bun", "bun"),
    ("deno", "deno"),
)

# Верхняя граница на одну попытку. `socket_timeout` ограничивает простой
# сокета, а не всю попытку, поэтому без этого застрявший клиент держал бы слот
# до бесконечности — ровно та беда, что была у телефона с загрузкой.
ATTEMPT_TIMEOUT_S = 25.0


class ResolveError(Exception):
    """Отказ с кодом, который клиент уже умеет превращать во фразу."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass
class ResolvedStream:
    stream_url: str
    format: str
    bitrate: int
    expires_at: int  # миллисекунды, как ждёт клиент

    def as_json(self) -> Dict[str, Any]:
        return {
            "streamUrl": self.stream_url,
            "format": self.format,
            "bitrate": self.bitrate,
            "expiresAt": self.expires_at,
        }


def stream_expiry(stream_url: str, now: Optional[float] = None) -> int:
    """
    Читает настоящий срок жизни ссылки из `expire` в её адресе.

    Эти ссылки умирают по расписанию YouTube, поэтому фиксированный TTL либо
    выбрасывает годную, либо держит мёртвую. Возвращает миллисекунды.
    """
    moment = time.time() if now is None else now
    try:
        parsed = urlparse(stream_url)
        expire = parse_qs(parsed.query).get("expire", [None])[0]
        if expire and expire.isdigit():
            as_seconds = int(expire)
            if as_seconds > moment:
                return as_seconds * 1000
        # У части ссылок срок лежит в пути: `/expire/1893456000/`.
        in_path = re.search(r"/expire/(\d{9,})", parsed.path)
        if in_path:
            as_seconds = int(in_path.group(1))
            if as_seconds > moment:
                return as_seconds * 1000
    except Exception:  # noqa: BLE001 — адрес мог быть любым мусором
        pass
    return int((moment + DEFAULT_STREAM_TTL_S) * 1000)


def is_ip_locked(stream_url: str) -> bool:
    """
    Привязана ли ссылка к адресу, которому её выдали.

    YouTube кладёт в подписанный адрес параметр `ip`, и с любого другого адреса
    такая ссылка отвечает 403. Для нас это разница между «телефон качает сам» и
    «звук приходится переливать через контейнер», поэтому решение принимается
    здесь, один раз, а не угадывается по 403 на середине трека.

    Отсутствие параметра — не обещание, что ссылка заиграет где угодно, а
    отсутствие известной причины запретить. Поэтому телефон всё равно пробует
    прямую ссылку первой и уходит на перелив только по настоящему отказу.
    """
    try:
        return bool(parse_qs(urlparse(stream_url).query).get("ip", [""])[0])
    except Exception:  # noqa: BLE001 — адрес мог быть любым мусором
        return False


def pick_audio_format(info: Optional[dict]) -> Optional[Tuple[dict, bool]]:
    """
    Выбирает лучший напрямую играбельный формат. Возвращает (формат, это ли манифест).

    Прогрессивный HTTP выигрывает у HLS и DASH: `<audio>` играет первый сам, а
    манифест требует hls.js и для DASH не работает вовсе. Форматы с картинкой —
    последняя надежда: играют, но тратят трафик телефона на кадры, которых никто
    не видит.
    """
    if not info:
        return None

    candidates: List[dict] = []
    formats = info.get("formats")
    if isinstance(formats, list):
        candidates.extend(f for f in formats if isinstance(f, dict))
    if info.get("url"):
        candidates.append(
            {
                "url": info.get("url"),
                "ext": info.get("ext"),
                "abr": info.get("abr"),
                "acodec": "unknown",
                "vcodec": "none",
            }
        )

    def carries_audio(f: dict) -> bool:
        """
        Есть ли в дорожке звук вообще.

        Раскадровка (`mhtml`) объявляет `vcodec: none` — ровно как настоящая
        аудиодорожка, — поэтому раньше она проходила проверку «только аудио» и
        при «Only images are available» отдавалась как удачный резолв. Человек
        получал тишину и потраченный трафик вместо честного отказа. Отсутствие
        кодека (некоторые клиенты его не пишут) отказом не считаем.
        """
        if f.get("acodec") == "none":
            return False
        return f.get("ext") != "mhtml"

    playable = [
        f
        for f in candidates
        if isinstance(f.get("url"), str) and f["url"] and carries_audio(f)
    ]
    if not playable:
        return None

    def is_manifest(f: dict) -> bool:
        protocol = str(f.get("protocol") or "")
        url = str(f.get("url") or "")
        return bool(re.search(r"m3u8|dash|manifest", protocol, re.I)) or bool(
            re.search(r"\.m3u8(\?|$)", url, re.I)
        )

    def is_audio_only(f: dict) -> bool:
        if f.get("vcodec") == "none":
            return True
        acodec = f.get("acodec")
        return bool(acodec) and acodec != "none" and not f.get("vcodec")

    def rate(f: dict) -> float:
        for key in ("abr", "tbr"):
            value = f.get(key)
            if isinstance(value, (int, float)) and value > 0:
                return float(value)
        return 0.0

    def ext_rank(f: dict) -> int:
        # m4a первым: самая широкая поддержка, и это же отдаёт YouTube Music.
        return 2 if f.get("ext") == "m4a" else 1 if f.get("ext") == "webm" else 0

    def score(f: dict) -> float:
        has_audio = f.get("acodec") != "none"
        return (
            (4000 if is_audio_only(f) else 500 if has_audio else 0)
            + (0 if is_manifest(f) else 2000)
            + ext_rank(f) * 100
            + min(rate(f), 320)
        )

    chosen = max(playable, key=score)
    return chosen, is_manifest(chosen)


def classify_error(message: str) -> Optional[str]:
    """Код отказа, при котором перебор дальше бессмысленен, либо None."""
    for pattern, code in TERMINAL_PATTERNS:
        if pattern.search(message):
            return code
    return None


class StreamResolver:
    """
    Кэш ссылок и лестница попыток на один процесс.

    Всё, что трогает мир, инжектится: `extract` (yt-dlp), `verify` (проверка
    ссылки запросом) и `now`. Поэтому тесты гоняют его без сети и без бинарника.
    """

    def __init__(
        self,
        extract: Optional[Callable[[str, Dict[str, Any]], Any]] = None,
        verify: Optional[Callable[[str], Any]] = None,
        now: Callable[[], float] = time.time,
        max_concurrent: int = MAX_CONCURRENT_EXTRACTIONS,
        attempt_timeout: float = ATTEMPT_TIMEOUT_S,
    ) -> None:
        self._extract = extract or _extract_with_ytdlp
        self._verify = verify
        self._now = now
        self._cache: Dict[str, ResolvedStream] = {}
        self._in_flight: Dict[str, "asyncio.Task[ResolvedStream]"] = {}
        self._gate = asyncio.Semaphore(max_concurrent)
        self._attempt_timeout = attempt_timeout
        self._bot_check_seen = False
        # Когда бот-проверку видели в последний раз, в секундах эпохи.
        # Ноль значит «ни разу с запуска».
        self._bot_check_at = 0.0
        self.stats = {"hits": 0, "misses": 0, "failures": 0}

    @property
    def cookies_look_dead(self) -> bool:
        """
        Похоже ли, что cookies перестали работать.

        Нужно наружу, в `/health`. Симптом «сервер отвечает 502 на каждый трек»
        снаружи неотличим от десятка других поломок, и разбираться в нём каждый
        раз заново — это часы. Здесь же видно сразу: cookies подставляются, а
        YouTube всё равно требует доказать, что мы не робот.

        Условие включает наличие файла намеренно: без cookies бот-проверка на
        адресе дата-центра — обычное дело, и поднимать из-за неё тревогу
        значило бы держать её поднятой всегда.
        """
        return self._bot_check_seen and cookies_file() is not None

    def cached(self, video_id: str) -> Optional[ResolvedStream]:
        entry = self._cache.get(video_id)
        if entry is None:
            return None
        if entry.expires_at / 1000 - CACHE_MARGIN_S <= self._now():
            del self._cache[video_id]
            return None
        return entry

    def invalidate(self, video_id: str) -> None:
        """
        Забывает ссылку, не дожидаясь её срока.

        Нужно переливу: 403 на середине трека означает, что ссылка умерла
        раньше написанного в ней `expire`, и без этого следующий же `resolve`
        достал бы из кэша ту самую мёртвую ссылку — то есть повтор выглядел бы
        как «не работает вообще», а не как «переподключились и играем дальше».
        """
        self._cache.pop(video_id, None)

    async def resolve(self, video_id: str) -> ResolvedStream:
        """
        Ссылка на аудио. Кидает {@link ResolveError} с кодом при отказе.

        Один и тот же трек, запрошенный сотней телефонов, даёт один запрос к
        YouTube: сначала кэш, потом общая задача. Это не оптимизация, а защита —
        сто одинаковых извлечений с одного IP и есть проверка «вы не робот».
        """
        if not VIDEO_ID_PATTERN.match(video_id or ""):
            raise ResolveError("YT_BAD_ID", f"invalid video id: {video_id!r}")

        hit = self.cached(video_id)
        if hit is not None:
            self.stats["hits"] += 1
            return hit

        existing = self._in_flight.get(video_id)
        if existing is not None:
            # `shield` не нужен: задача принадлежит словарю, а не тому, кто её
            # ждёт, поэтому отменённый запрос не уносит работу остальных.
            return await asyncio.shield(existing)

        self.stats["misses"] += 1
        task = asyncio.ensure_future(self._resolve_uncached(video_id))
        self._in_flight[video_id] = task
        try:
            return await asyncio.shield(task)
        finally:
            if self._in_flight.get(video_id) is task and task.done():
                del self._in_flight[video_id]

    async def _resolve_uncached(self, video_id: str) -> ResolvedStream:
        url = f"https://www.youtube.com/watch?v={video_id}"
        failures: List[str] = []
        saw_bot_check = False
        started = self._now()

        for attempt in attempts_for(cookies_file() is not None):
            opts = dict(BASE_OPTS)
            if attempt.client:
                opts["extractor_args"] = {"youtube": {"player_client": [attempt.client]}}

            try:
                async with self._gate:
                    info = await asyncio.wait_for(
                        self._run_extract(url, opts), timeout=self._attempt_timeout
                    )
            except asyncio.TimeoutError:
                failures.append(f"{attempt.label}: did not answer in {self._attempt_timeout:.0f}s")
                continue
            except Exception as exc:  # noqa: BLE001 — yt-dlp кидает своё
                message = str(exc)
                failures.append(f"{attempt.label}: {message}")
                if BOT_CHECK_PATTERN.search(message):
                    saw_bot_check = True
                    self._bot_check_at = self._now()
                    if not self._bot_check_seen:
                        self._bot_check_seen = True
                        # Сообщение разное не для красоты: «cookies нет» и
                        # «cookies есть, но не помогли» — это два разных
                        # действия, положить файл и обновить протухший.
                        logger.warning(
                            "YouTube потребовал подтвердить, что запросы не от робота. %s",
                            "Cookies подставляются, значит они протухли — нужен свежий выгруз"
                            if cookies_file()
                            else f"Cookies не заданы: положите файл и укажите {COOKIES_ENV}",
                        )
                terminal = classify_error(message)
                if terminal:
                    self.stats["failures"] += 1
                    raise ResolveError(terminal, message)
                continue

            picked = pick_audio_format(info if isinstance(info, dict) else None)
            if picked is None:
                failures.append(f"{attempt.label}: no audio format in response")
                continue

            fmt, is_manifest = picked
            stream_url = str(fmt["url"])

            # Манифест байтовым диапазоном не проверить, и hls.js сообщит о своих
            # бедах сам, поэтому он проходит без проверки.
            if self._verify is not None and not is_manifest:
                ok, reason = await self._verify(stream_url)
                if not ok:
                    failures.append(f"{attempt.label}: URL rejected on playback ({reason})")
                    continue

            resolved = ResolvedStream(
                stream_url=stream_url,
                format=str(fmt.get("ext") or "m4a"),
                bitrate=int(fmt.get("abr") or fmt.get("tbr") or 128),
                expires_at=stream_expiry(stream_url, self._now()),
            )
            self._cache[video_id] = resolved
            logger.info(
                "resolved %s via %s -> %s %skbps in %.0fms%s",
                video_id,
                attempt.label,
                resolved.format,
                resolved.bitrate,
                (self._now() - started) * 1000,
                f" (after {len(failures)} failed attempt(s))" if failures else "",
            )
            return resolved

        detail = "; ".join(failures)
        self.stats["failures"] += 1
        if saw_bot_check:
            raise ResolveError("YT_BOT_CHECK", detail)
        raise ResolveError("YT_ALL_ATTEMPTS_FAILED", detail)

    async def _run_extract(self, url: str, opts: Dict[str, Any]) -> Any:
        """
        Запускает извлечение так, чтобы оно не останавливало весь процесс.

        Настоящий yt-dlp синхронный и держит GIL секундами, а в этом же процессе
        живут брокер комнат и остальные запросы, — поэтому он уезжает в поток.
        Асинхронную подмену (тесты) ждём как есть: заводить под неё поток
        бессмысленно, а `wait_for` снаружи всё равно ограничит время.
        """
        if asyncio.iscoroutinefunction(self._extract):
            return await self._extract(url, opts)
        return await asyncio.to_thread(self._extract, url, opts)


def ytdlp_temp_dir() -> Path:
    """
    Куда бинарник yt-dlp распаковывает сам себя.

    Свой каталог, а не общий `/tmp`, и это лечит настоящую поломку. Бинарник
    собран PyInstaller: на каждый запуск он распаковывает ~40 МБ в `$TMPDIR`
    и убирает за собой при выходе. Но выходит он не всегда — попытку убивает
    {@link ATTEMPT_TIMEOUT_S}, и убитый процесс уборку не делает. Каталоги
    `_MEI…` копятся по 40 МБ, `/tmp` в контейнере — небольшой tmpfs, и в
    какой-то момент распаковка перестаёт помещаться.

    Наружу это выглядит совершенно не как «кончилось место»:

        [PYI-120:ERROR] Failed to extract Cryptodome/Cipher/_ARC4.abi3.so:
        decompression resulted in return code -1!

    Поймано 2026-08-28 через консоль WebView на эмуляторе: сервер отвечал 502
    на каждый трек, а размер самого бинарника при этом был байт в байт верным.
    Отсюда правило: место для распаковки берём на настоящем диске контейнера
    (там гигабайт), а не в памяти, и подметаем за убитыми процессами сами.
    """
    base = Path(os.getenv("WIREON_YTDLP_TMP") or Path(__file__).resolve().parent.parent / "yt-dlp-tmp")
    base.mkdir(parents=True, exist_ok=True)
    return base


# Столько живёт брошенный каталог распаковки. Больше {@link ATTEMPT_TIMEOUT_S}
# с запасом: подмести каталог работающей попытки — значит сломать её на ровном
# месте, и отличить её от брошенной можно только по времени.
STALE_TEMP_AGE_S = 120.0


def sweep_ytdlp_temp(now: Optional[float] = None) -> int:
    """
    Убирает распаковки, оставшиеся от убитых попыток. Возвращает число убранных.

    Ошибки глотаются намеренно: уборка — не то, ради чего стоит ронять резолв.
    Чужой каталог просто останется лежать до следующего раза.
    """
    import shutil

    moment = time.time() if now is None else now
    removed = 0
    try:
        for entry in ytdlp_temp_dir().iterdir():
            if not entry.name.startswith("_MEI") or not entry.is_dir():
                continue
            try:
                if moment - entry.stat().st_mtime < STALE_TEMP_AGE_S:
                    continue
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
            except OSError:
                continue
    except OSError as exc:
        logger.warning("не удалось подмести распаковки yt-dlp: %s", exc)
    return removed


_last_sweep = 0.0

# Чаще раза в минуту смотреть в каталог незачем: брошенные распаковки
# появляются не быстрее, чем истекают попытки.
SWEEP_INTERVAL_S = 60.0


def _sweep_if_due() -> None:
    global _last_sweep
    moment = time.time()
    if moment - _last_sweep < SWEEP_INTERVAL_S:
        return
    _last_sweep = moment
    removed = sweep_ytdlp_temp(moment)
    if removed:
        logger.info("убрано брошенных распаковок yt-dlp: %d", removed)


def ytdlp_env() -> Dict[str, str]:
    """Окружение для бинарника: то же, что у нас, но со своим `TMPDIR`."""
    env = dict(os.environ)
    location = str(ytdlp_temp_dir())
    # Три имени, потому что разные слои смотрят на разные: PyInstaller читает
    # `TMPDIR`, часть библиотек — `TMP` и `TEMP`. Разойтись им нельзя.
    env["TMPDIR"] = location
    env["TMP"] = location
    env["TEMP"] = location
    return env


def _extract_with_ytdlp(url: str, opts: Dict[str, Any]) -> Any:
    """
    Настоящее извлечение — через **бинарник** yt-dlp, а не через пакет с PyPI.

    Это не вкусовщина, а измерено 2026-08-27: пакет `yt-dlp==2026.7.4` (последний
    на PyPI — 2026.8.19) на всех пяти клиентах лестницы отдаёт ссылку, которую
    googlevideo встречает 403 на `Range: bytes=0-`. Тот же запрос ночным
    бинарником (2026.08.27) отдаёт 206 и читаемое аудио. Причина в том, что
    починки YouTube выходят в ночных сборках в день поломки, а до PyPI доходят
    через недели, — то же самое уже знает десктоп, там `scripts/refresh-ytdlp.mjs`
    гоняет `--update-to nightly` перед каждой сборкой.

    Отсюда же требование к контейнеру: бинарник качается и обновляется сам, см.
    {@link ensure_ytdlp_binary}. Пакета в requirements нет намеренно — он создавал
    бы ложное чувство, что резолвер работает.
    """
    import json
    import subprocess

    # Подметаем перед запуском, а не по таймеру: отдельная периодическая задача
    # в процессе, который делит ядро с VPN, стоит дороже, чем взгляд в каталог
    # раз в минуту. Здесь это безопасно — функция уже выполняется в потоке.
    _sweep_if_due()

    binary = os.getenv("WIREON_YTDLP_PATH", "yt-dlp")
    args = [binary, "--dump-single-json"]
    # `--no-warnings` здесь нет намеренно. Предупреждения yt-dlp уходят в stderr,
    # а stderr читается только когда попытка провалилась, — на успехе он не стоит
    # ничего. Зато при отказе именно в предупреждениях лежит причина: «n challenge
    # solving failed» отличает сломанный движок JS от испорченных cookies, а без
    # них обе беды выглядят одинаково — «The page needs to be reloaded».
    for flag in ("--no-playlist", "--no-check-certificates"):
        args.append(flag)
    args += ["--socket-timeout", "12", "--retries", "1"]

    # yt-dlp дописывает этот файл обратно, обновляя протухающие поля, — поэтому
    # он должен быть доступен на запись, и поэтому же cookies живут дольше, чем
    # если бы мы отдавали их копию.
    cookies = cookies_file()
    if cookies:
        args += ["--cookies", cookies]

    runtime = js_runtime()
    if runtime:
        args += ["--js-runtimes", runtime]

    extractor_args = opts.get("extractor_args")
    if isinstance(extractor_args, dict):
        for extractor, values in extractor_args.items():
            for key, value in values.items():
                joined = ",".join(value) if isinstance(value, list) else str(value)
                args += ["--extractor-args", f"{extractor}:{key}={joined}"]

    args.append(url)

    completed = subprocess.run(  # noqa: S603 — путь из окружения, аргументы собраны здесь
        args,
        capture_output=True,
        timeout=ATTEMPT_TIMEOUT_S,
        env=ytdlp_env(),
    )
    if completed.returncode != 0:
        # stderr yt-dlp — это и есть текст, по которому классифицируется отказ
        # (`Video unavailable`, `not a bot` и остальные), поэтому он идёт наружу
        # как есть, а не заменяется на «команда завершилась с кодом 1».
        raise RuntimeError(completed.stderr.decode("utf-8", errors="replace").strip() or "yt-dlp failed")
    return json.loads(completed.stdout.decode("utf-8", errors="replace"))


def cookies_file(directory: Optional[str] = None) -> Optional[str]:
    """
    Путь к cookies, если они есть и в них что-то лежит, иначе None.

    Проверка на пустоту не придирка: `--cookies` с пустым или нечитаемым файлом
    yt-dlp считает отказом и валит **все** попытки разом. Отсутствие cookies
    должно означать «работаем как раньше», а не «не работаем вообще».
    """
    raw = os.getenv(COOKIES_ENV, "").strip()
    if raw:
        target = Path(raw)
    else:
        base = Path(directory) if directory else Path(__file__).resolve().parent.parent
        target = base / DEFAULT_COOKIES_NAME
    try:
        if target.is_file() and target.stat().st_size > 0:
            return str(target)
    except OSError:
        return None
    return None


def js_runtime(directory: Optional[str] = None) -> Optional[str]:
    """
    Спецификация движка для `--js-runtimes`, вида `deno:/путь/к/deno`, либо None.

    Ищем сначала переменную окружения, потом бинарник рядом с сервером. В PATH
    не лезем нарочно: в контейнере его нет, а найденный где-то «node» неизвестной
    версии — это отказ в середине трека вместо отказа при запуске.
    """
    raw = os.getenv(JS_RUNTIME_ENV, "").strip()
    if raw:
        # Либо готовая спецификация `имя:путь`, либо просто путь — тогда имя
        # берём из названия файла.
        if ":" in raw and not Path(raw).exists():
            return raw
        return f"{Path(raw).stem or 'deno'}:{raw}"

    base = Path(directory) if directory else Path(__file__).resolve().parent.parent
    for name, filename in JS_RUNTIME_FILES:
        candidate = base / filename
        try:
            if candidate.is_file():
                return f"{name}:{candidate}"
        except OSError:
            continue
    return None


def ensure_ytdlp_binary(directory: Optional[str] = None) -> Optional[str]:
    """
    Кладёт рядом с сервером свежий бинарник yt-dlp и возвращает путь к нему.

    Скачивается, если его нет, и обновляется до nightly при каждом запуске: см.
    {@link _extract_with_ytdlp} — на стабильных версиях YouTube отдаёт ссылки,
    которые не играют. Обновление сам yt-dlp откатывает, если новая сборка не
    запускается, поэтому «стало хуже» тут не бывает.

    Возвращает None, если ничего не вышло: музыка тогда не работает, а бот и VPN
    в этом же процессе — работают. Молчать об этом нельзя, поэтому причина
    уходит в журнал контейнера.
    """
    import stat
    import subprocess
    import urllib.request

    base = Path(directory) if directory else Path(__file__).resolve().parent.parent
    is_windows = os.name == "nt"
    target = base / ("yt-dlp.exe" if is_windows else "yt-dlp")

    if not target.exists():
        asset = "yt-dlp.exe" if is_windows else "yt-dlp_linux"
        source = f"https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/{asset}"
        logger.info("качаю yt-dlp: %s", source)
        try:
            urllib.request.urlretrieve(source, str(target))  # noqa: S310 — адрес зашит выше
            if not is_windows:
                target.chmod(target.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        except Exception as exc:  # noqa: BLE001
            logger.error("не удалось скачать yt-dlp: %s", exc)
            return None
    else:
        try:
            subprocess.run(  # noqa: S603
                [str(target), "--update-to", "nightly"], capture_output=True, timeout=180
            )
        except Exception as exc:  # noqa: BLE001
            # Не беда: работаем на том, что есть. Хуже была бы остановка запуска.
            logger.warning("обновить yt-dlp не удалось: %s", exc)

    try:
        probe = subprocess.run(  # noqa: S603
            [str(target), "--version"], capture_output=True, timeout=30
        )
        if probe.returncode != 0:
            logger.error("yt-dlp не отвечает на --version")
            return None
        logger.info("yt-dlp готов: %s", probe.stdout.decode("utf-8", "replace").strip())
    except Exception as exc:  # noqa: BLE001
        logger.error("yt-dlp не запускается: %s", exc)
        return None

    os.environ["WIREON_YTDLP_PATH"] = str(target)
    return str(target)


async def verify_stream_url(session: Any, stream_url: str) -> Tuple[bool, str]:
    """
    Спрашивает у CDN то же, что спросит плеер, и оставляет ссылку только если
    ответ получен.

    Заголовок здесь важнее, чем кажется. googlevideo отдаёт ссылку, которой нужен
    PO-токен, только в узких случаях: на `bytes=0-1` она честно отвечает 206 —
    из-за этого проверка раньше подтверждала ссылки, которые не играли никогда.
    Chromium просит `bytes=0-` (весь файл), и вот на это ссылка с ограничением
    отвечает 403. Задать тот же вопрос, что задаст плеер, — единственный способ,
    которым лестница попыток узнаёт, что пора к следующему клиенту.
    """
    import aiohttp

    try:
        timeout = aiohttp.ClientTimeout(total=6)
        async with session.get(
            stream_url, headers={"Range": "bytes=0-"}, timeout=timeout
        ) as response:
            status = response.status
            # Тело читать незачем, а держать открытым — значит держать сокет
            # под ссылку, которую мы, возможно, выбросим.
            response.close()
            if status in (200, 206):
                return True, f"HTTP {status}"
            return False, f"HTTP {status}"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)
