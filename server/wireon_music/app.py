"""
Музыкальный сервер Wireon: ссылка на поток, радио, поиск и брокер комнат.

Один процесс на весь телефон. Что он делает и, главное, чего не делает:

- `GET /v1/resolve?id=<videoId>` — **ссылка** на аудио, около килобайта JSON.
  Звук телефон качает сам, напрямую с `googlevideo`. Это решение владельца:
  гонять поток через контейнер, на котором живёт VPN, — значит раздавать
  гигабайты с канала, который нужен другим.
- `GET /v1/stream?id=<videoId>` — **байты** аудио, и только для тех треков, где
  первый путь не работает: телефону YouTube ссылки не дал, а наша с его адреса
  не открылась. Решение владельца от 2026-08-28: пусть такие треки идут через
  канал, чем не играют вовсе. Обычный трек сюда не попадает — телефон приходит
  сюда, только исчерпав оба дешёвых пути. Подробности — в шапке `proxy.py`.
- `GET /v1/radio?id=<videoId>` и `GET /v1/search?q=<строка>` — сырой ответ
  InnerTube. Разбор уже написан на клиенте и покрыт тестами; второй разбор
  здесь означал бы два места, которые обязаны угадать структуру одинаково.
- `GET /mqtt` — WebSocket с MQTT 3.1.1 для «слушать вместе». Публичные брокеры
  режут соединения и глотают сообщения, отсюда свой.
- `GET /health` — без токена, чтобы проверять живость снаружи не приоткрывая
  ничего лишнего.

Авторизация. Токен (`WIREON_API_TOKEN`) сверяется в постоянном по времени
сравнении и передаётся заголовком `X-Wireon-Token` либо `?token=`. Второй
вариант — только ради WebSocket: браузерный `WebSocket` не умеет задавать
заголовки. Токен живёт в переменной окружения и никогда в файле репозитория.

Без токена сервер не поднимается. Открытая ручка, гоняющая yt-dlp, — это
бесплатный резолвер для всего интернета с нашего IP, и YouTube заметит это
раньше, чем мы.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import time
from typing import Any, Dict, Optional

from aiohttp import web

from . import innertube
from . import proxy
from .broker import Broker, ConnectionHandler
from .identity import DiscordIdentity, IdentityError
from .sync import KIND_FAVORITE, KIND_PLAYLIST, SyncError, SyncStore, sanitize_records
from .resolver import (
    ResolveError,
    StreamResolver,
    cookies_file,
    ensure_ytdlp_binary,
    is_ip_locked,
    js_runtime,
    verify_stream_url,
)

logger = logging.getLogger("wireon.server")

DEFAULT_PORT = 25545

# Столько запросов в минуту на адрес. Телефон в обычной работе делает один
# `resolve` на трек и один `radio` на поток; шестьдесят — это запас в разы, но
# заметно меньше, чем нужно, чтобы использовать нас как публичный резолвер.
RATE_LIMIT_PER_MINUTE = 60
RATE_WINDOW_S = 60.0

# Предел на длину поискового запроса: всё, что длиннее, — не запрос человека.
MAX_QUERY_LENGTH = 200

# Сколько принимаем в теле запроса. У aiohttp по умолчанию мегабайт, и на нём
# отправка медиатеки среднего размера обрывалась бы без внятной причины. Четыре
# — с запасом под пачку в пятьсот записей и всё ещё далеко от того, чем можно
# занять память контейнера, где рядом живут VPN и бот.
MAX_BODY_BYTES = 4 * 1024 * 1024


class RateLimiter:
    """
    Скользящее окно на адрес. Память чистится лениво, при обращении: отдельная
    задача-уборщик для десятка адресов — лишний таймер в процессе, который и
    так делит ядро с VPN.
    """

    def __init__(self, limit: int = RATE_LIMIT_PER_MINUTE, window: float = RATE_WINDOW_S) -> None:
        self.limit = limit
        self.window = window
        self._hits: Dict[str, list] = {}

    def allow(self, key: str, now: Optional[float] = None) -> bool:
        moment = time.monotonic() if now is None else now
        bucket = self._hits.setdefault(key, [])
        cutoff = moment - self.window
        bucket[:] = [stamp for stamp in bucket if stamp > cutoff]
        if len(bucket) >= self.limit:
            return False
        bucket.append(moment)
        return True


def _client_ip(request: web.Request) -> str:
    """
    Адрес обращающегося. За обратным прокси (cloudflared) настоящий адрес
    приходит заголовком, и без него все слушатели выглядели бы одним клиентом,
    то есть первый же человек выедал бы лимит на всех.
    """
    forwarded = request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    peer = request.transport.get_extra_info("peername") if request.transport else None
    if isinstance(peer, tuple) and peer:
        return str(peer[0])
    return "unknown"


def _token_matches(expected: str, supplied: Optional[str]) -> bool:
    """
    Сравнение постоянного времени. Обычное `==` выходит из цикла на первом
    несовпавшем байте, и по времени ответа токен подбирается посимвольно.
    """
    if not supplied:
        return False
    return hmac.compare_digest(expected, supplied)


def _supplied_token(request: web.Request) -> Optional[str]:
    header = request.headers.get("X-Wireon-Token")
    if header:
        return header
    # `?token=` существует ровно для WebSocket: браузерный `WebSocket` не умеет
    # задавать заголовки. Для обычных ручек предпочтителен заголовок — адрес с
    # токеном оседает в журналах прокси.
    return request.query.get("token")


# Заголовки, без которых страница приложения не может к нам обратиться.
#
# На телефоне запрос уходит мимо движка страницы (`CapacitorHttp`), и о CORS там
# никто не спрашивает. На компьютере окно грузится с `file://`, источник у него
# `null`, а к нам идут свои заголовки `X-Wireon-Token` и `X-Discord-Token` — то
# есть запрос непростой, и браузер сначала спрашивает разрешения методом
# `OPTIONS`. Мы отвечали на него `401`, потому что токена в предзапросе нет и
# быть не может: браузер его не отправляет. Разрешения не было, настоящий запрос
# не уходил вовсе — и приложение показывало «Failed to fetch», то самое, ради
# которого владелец каждый раз нажимал «Проверить». Синхронизация на ПК не
# работала ни разу.
#
# `*`, а не список источников: у окна с `file://` источник `null`, и перечислять
# тут нечего. Дверь этим не открывается — читает и пишет по-прежнему только тот,
# кто предъявил оба токена, а `credentials` мы не шлём: ни одной cookie в
# запросе нет.
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "X-Wireon-Token, X-Discord-Token, Content-Type",
    # Сутки: набор заголовков у нас не меняется, а лишний предзапрос перед каждой
    # выгрузкой медиатеки — это второй сетевой заход там, где хватает одного.
    "Access-Control-Max-Age": "86400",
}


@web.middleware
async def cors_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    """
    Разрешение браузеру и ответ на предзапрос.

    Стоит **перед** проверкой токена: предзапрос приходит без заголовков, и
    проверять в нём нечего. Ответ на него ничего не выдаёт — только перечисляет,
    что позволено спросить.
    """
    if request.method == "OPTIONS":
        return web.Response(status=204, headers=CORS_HEADERS)

    response = await handler(request)
    # У WebSocket заголовки уже ушли к моменту возврата — трогать их поздно, да и
    # незачем: `/mqtt` открывается не через `fetch`.
    if not isinstance(response, web.WebSocketResponse):
        response.headers.update(CORS_HEADERS)
    return response


@web.middleware
async def auth_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    if request.path == "/health":
        return await handler(request)

    expected: str = request.app["token"]
    if not _token_matches(expected, _supplied_token(request)):
        logger.warning("rejected %s %s from %s: bad token", request.method, request.path, _client_ip(request))
        return web.json_response({"error": "unauthorized"}, status=401)

    limiter: RateLimiter = request.app["limiter"]
    if not limiter.allow(_client_ip(request)):
        return web.json_response({"error": "rate limited"}, status=429)

    return await handler(request)


# ---------------------------------------------------------------------------
# Ручки
# ---------------------------------------------------------------------------


async def handle_preflight(request: web.Request) -> web.Response:
    """Ответ на предзапрос. Прослойка перехватывает его раньше; маршрут нужен,
    чтобы aiohttp не отвечал `405` до неё."""
    return web.Response(status=204, headers=CORS_HEADERS)


async def handle_health(request: web.Request) -> web.Response:
    """
    Живость без токена. Наружу уходят только счётчики, ничего о содержимом:
    сколько комнат открыто и попадает ли кэш — этого достаточно, чтобы понять,
    что сервер жив, и недостаточно, чтобы что-то о нём узнать.
    """
    broker: Broker = request.app["broker"]
    resolver: StreamResolver = request.app["resolver"]
    return web.json_response(
        {
            "ok": True,
            "service": "wireon-music",
            "uptimeSeconds": int(time.monotonic() - request.app["started_at"]),
            "broker": broker.stats,
            "resolver": dict(resolver.stats),
            # Только «да» или «нет». Само содержимое — доступ к живому аккаунту,
            # но не знать снаружи, подставляются ли cookies, значит гадать о
            # причине каждого отказа: файл не положили или он протух.
            "cookies": cookies_file() is not None,
            # Отдельный признак «cookies есть, но YouTube всё равно требует
            # доказать, что мы не робот». Снаружи смерть cookies неотличима от
            # десятка других поломок — сервер просто отвечает 502 на каждый
            # трек. Здесь она названа своим именем.
            "cookiesLookDead": request.app["resolver"].cookies_look_dead,
            "sync": await request.app["sync"].stats(),
            # Сколько треков пошло через нас вместо прямой ссылки. Это цена
            # запасного пути в байтах нашего канала, и видеть её надо снаружи,
            # а не догадываться по счёту за трафик.
            "proxy": dict(request.app["proxy_stats"]),
            # Без движка cookies бесполезны: залогиненному запросу YouTube
            # отдаёт зашифрованный параметр, который без JS не развернуть.
            "jsRuntime": (js_runtime() or "").split(":", 1)[0] or None,
        }
    )


async def handle_resolve(request: web.Request) -> web.Response:
    """
    Ссылка на аудио. Коды отказа те же, что у десктопа (`YT_*`), потому что
    фразы для человека уже написаны под них в `playbackErrors.ts` — сервер,
    придумавший свои коды, показал бы «что-то пошло не так».
    """
    video_id = (request.query.get("id") or "").strip()
    resolver: StreamResolver = request.app["resolver"]
    try:
        resolved = await resolver.resolve(video_id)
    except ResolveError as exc:
        # 404 для «этого видео нет», 403 для проверки «вы не робот», 502 для
        # остального: по коду ответа видно, стоит ли повторять запрос.
        status = 404 if exc.code in ("YT_UNAVAILABLE", "YT_PRIVATE", "YT_BAD_ID") else (
            403 if exc.code == "YT_BOT_CHECK" else 502
        )
        return web.json_response({"error": exc.code, "detail": exc.detail}, status=status)

    payload = resolved.as_json()
    # Телефону нужно знать не только «вот ссылка», но и «сработает ли она у
    # тебя». Ссылка с `ip=` подписана вместе с нашим адресом и с телефона
    # отвечает 403 — сказать об этом здесь дешевле, чем дать ему выяснить это
    # неудачной попыткой на каждый трек.
    locked = is_ip_locked(resolved.stream_url)
    payload["ipLocked"] = locked
    if locked:
        payload["proxyUrl"] = f"/v1/stream?id={video_id}"
    return web.json_response(payload)


async def handle_stream(request: web.Request) -> web.StreamResponse:
    """
    Перелив звука. Запасной путь: см. шапку `proxy.py`.

    Токен здесь приходится принимать и через `?token=`, как у WebSocket, и по
    той же причине — `<audio src=...>` заголовков не задаёт. Это уже учтено
    `_supplied_token`, отдельного послабления не появляется.
    """
    video_id = (request.query.get("id") or "").strip()
    try:
        return await proxy.stream_audio(
            request,
            video_id,
            request.app["resolver"],
            request.app["session"],
            request.app["proxy_gate"],
            request.app["proxy_stats"],
        )
    except ResolveError as exc:
        status = 404 if exc.code in ("YT_UNAVAILABLE", "YT_PRIVATE", "YT_BAD_ID") else (
            403 if exc.code == "YT_BOT_CHECK" else 502
        )
        return web.json_response({"error": exc.code, "detail": exc.detail}, status=status)
    except proxy.ProxyError as exc:
        return web.json_response({"error": exc.code, "detail": exc.detail}, status=exc.status)


async def handle_radio(request: web.Request) -> web.Response:
    video_id = (request.query.get("id") or "").strip()
    session = request.app["session"]
    try:
        data = await innertube.radio(session, video_id)
    except innertube.InnerTubeError as exc:
        return web.json_response({"error": "RADIO_FAILED", "detail": str(exc)}, status=502)
    logger.info("radio for %s -> %d tracks", video_id, innertube.queue_length(data))
    return web.json_response(data)


async def handle_search(request: web.Request) -> web.Response:
    query = (request.query.get("q") or "").strip()
    if not query:
        return web.json_response({"error": "QUERY_REQUIRED"}, status=400)
    if len(query) > MAX_QUERY_LENGTH:
        return web.json_response({"error": "QUERY_TOO_LONG"}, status=400)
    session = request.app["session"]
    try:
        data = await innertube.search(session, query)
    except innertube.InnerTubeError as exc:
        return web.json_response({"error": "SEARCH_FAILED", "detail": str(exc)}, status=502)
    return web.json_response(data)


async def _owner(request: web.Request) -> str:
    """
    Чьи это записи. Общий токен сюда не годится — см. шапку `identity.py`.
    """
    identity: DiscordIdentity = request.app["identity"]
    return await identity.user_id(request.app["session"], request.headers.get("X-Discord-Token"))


def _identity_status(code: str) -> int:
    # 401 — «войди заново», 503 — «Discord прилёг, повтори позже». Один код на
    # оба означал бы, что клиент разлогинивает человека всякий раз, когда у
    # Discord плохой день.
    return 503 if code == "DISCORD_UNAVAILABLE" else 401


async def handle_sync_pull(request: web.Request) -> web.Response:
    """Всё живое плюс идентификаторы удалённого — одним запросом."""
    try:
        owner = await _owner(request)
    except IdentityError as exc:
        return web.json_response({"error": exc.code, "detail": exc.detail}, status=_identity_status(exc.code))

    store: SyncStore = request.app["sync"]
    return web.json_response(await store.pull(owner))


#: Столько держим запрос ожидания, если ничего не произошло.
#:
#: Двадцать пять секунд, а не минута: прокси и мобильные операторы рвут молчащее
#: соединение примерно на тридцати, и обрыв выглядел бы для клиента отказом.
SYNC_WAIT_SECONDS = 25


def _sync_waiters(app: web.Application) -> Dict[str, asyncio.Event]:
    return app.setdefault("sync_waiters", {})


def _sync_notify(app: web.Application, owner: str) -> None:
    """
    Будит всех, кто ждёт изменений этого человека.

    Событие снимается из словаря целиком, а не сбрасывается: тот, кто придёт
    ждать после пробуждения, должен получить **новое** событие, иначе он
    вернулся бы мгновенно на уже отработавшем.
    """
    event = _sync_waiters(app).pop(owner, None)
    if event is not None:
        event.set()


async def handle_sync_wait(request: web.Request) -> web.Response:
    """
    Держит запрос, пока у человека что-нибудь не изменится.

    Зачем это вместо оповещения через брокер: на Android страница приложения
    живёт на `https`, а брокер отвечает по незащищённому `ws://`, и браузер
    запрещает такое соединение сам — телефон не может слушать брокер в
    принципе. Обычные же запросы оттуда проходят, поэтому ожидание сделано
    обычным запросом: клиент спрашивает «что нового после этой отметки»,
    сервер молчит, пока нечего сказать, и отвечает сразу, как только есть.

    Отметка — `MAX(updated_at)` по записям человека. Клиент присылает ту, что
    видел; если она отстала, ответ приходит немедленно, без ожидания: значит
    изменение случилось, пока клиент был в пути.
    """
    try:
        owner = await _owner(request)
    except IdentityError as exc:
        return web.json_response({"error": exc.code, "detail": exc.detail}, status=_identity_status(exc.code))

    try:
        since = int(request.query.get("since", "0"))
    except (TypeError, ValueError):
        since = 0

    store: SyncStore = request.app["sync"]
    revision = await store.revision(owner)
    if revision != since:
        return web.json_response({"revision": revision, "changed": True})

    event = _sync_waiters(request.app).setdefault(owner, asyncio.Event())
    try:
        await asyncio.wait_for(event.wait(), timeout=SYNC_WAIT_SECONDS)
    except asyncio.TimeoutError:
        # Тишина — это тоже ответ: клиент спросит снова, соединение не висит
        # дольше, чем его терпят прокси.
        pass

    revision = await store.revision(owner)
    return web.json_response({"revision": revision, "changed": revision != since})


async def handle_sync_push(request: web.Request) -> web.Response:
    """
    Приём записей. В ответе — сколько **приняли**, а не сколько получили:
    запись старше уже лежащей отбрасывается, и клиент по этому числу решает,
    помечать ли своё отправленным.
    """
    try:
        owner = await _owner(request)
    except IdentityError as exc:
        return web.json_response({"error": exc.code, "detail": exc.detail}, status=_identity_status(exc.code))

    try:
        body = await request.json()
    except web.HTTPRequestEntityTooLarge:
        # Отдельно от «не JSON»: у человека с большой медиатекой это самый
        # вероятный отказ, и «тело не JSON» отправило бы его искать поломку в
        # своих данных вместо того, чтобы отправлять их частями.
        return web.json_response(
            {"error": "SYNC_BODY_TOO_LARGE", "detail": f"тело больше {MAX_BODY_BYTES} байт"},
            status=413,
        )
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "SYNC_BAD_BODY", "detail": "тело не JSON"}, status=400)

    store: SyncStore = request.app["sync"]
    try:
        playlists = await store.push(owner, KIND_PLAYLIST, sanitize_records(body.get("playlists", [])))
        favorites = await store.push(owner, KIND_FAVORITE, sanitize_records(body.get("favorites", [])))
    except SyncError as exc:
        status = 413 if exc.code in ("SYNC_QUOTA_EXCEEDED", "SYNC_BATCH_TOO_LARGE") else 400
        return web.json_response({"error": exc.code, "detail": exc.detail}, status=status)

    # Будим только когда что-то действительно приняли: отправка, из которой всё
    # оказалось старее лежащего, изменением не является, и гонять соседей за
    # ней незачем.
    if playlists or favorites:
        _sync_notify(request.app, owner)
    return web.json_response({"playlists": playlists, "favorites": favorites})


async def handle_sync_delete(request: web.Request) -> web.Response:
    """
    Удаление ставит надгробие, а не стирает строку.

    Без него удалённое возвращается: движок клиента сливает пришедшее в местное
    и отправляет местное целиком, поэтому сосед, у которого запись ещё есть,
    привозит её обратно. Дата надгробия и есть та причина, по которой он её
    забудет.
    """
    try:
        owner = await _owner(request)
    except IdentityError as exc:
        return web.json_response({"error": exc.code, "detail": exc.detail}, status=_identity_status(exc.code))

    kind = KIND_PLAYLIST if request.match_info.get("kind") == "playlists" else KIND_FAVORITE
    record_id = (request.match_info.get("id") or "").strip()
    if not record_id:
        return web.json_response({"error": "SYNC_BAD_ID", "detail": "пустой идентификатор"}, status=400)

    store: SyncStore = request.app["sync"]
    try:
        await store.delete(owner, kind, record_id)
    except SyncError as exc:
        return web.json_response({"error": exc.code, "detail": exc.detail}, status=400)
    _sync_notify(request.app, owner)
    return web.json_response({"deleted": True})


async def handle_mqtt(request: web.Request) -> web.StreamResponse:
    """
    MQTT поверх WebSocket.

    Подпротокол `mqtt` не формальность: клиент открывает сокет именно с ним, и
    без ответного подтверждения браузер закрывает соединение — а выглядит это
    как сетевая ошибка, то есть отладить почти невозможно.

    Писатель отдельной задачей, потому что доставка приходит не в ответ на
    запрос: сообщение другого участника комнаты может прийти в любой момент.
    Пустой кадр в очереди — договорённость с брокером «пора закрывать».
    """
    ws = web.WebSocketResponse(protocols=("mqtt",), heartbeat=None, max_msg_size=256 * 1024)
    await ws.prepare(request)

    broker: Broker = request.app["broker"]
    send_queue: "asyncio.Queue[bytes]" = asyncio.Queue(maxsize=64)
    handler = ConnectionHandler(broker, send_queue)

    async def writer() -> None:
        while True:
            payload = await send_queue.get()
            if payload == b"":
                break
            try:
                await ws.send_bytes(payload)
            except Exception:  # noqa: BLE001 — сокет уже мог закрыться
                break

    writer_task = asyncio.ensure_future(writer())
    peer = _client_ip(request)
    logger.info("mqtt socket opened from %s", peer)

    try:
        async for message in ws:
            if message.type == web.WSMsgType.BINARY:
                handler.feed(message.data)
            elif message.type == web.WSMsgType.TEXT:
                # Первая версия «слушать вместе» шла сырым JSON и умирала молча.
                # Здесь это отказ с причиной, а не тишина.
                handler.close("text frame on an MQTT socket")
            elif message.type == web.WSMsgType.ERROR:
                break
            if handler.closed:
                break
    finally:
        handler.close("socket closed")
        await writer_task
        await ws.close()
        logger.info("mqtt socket from %s closed: %s", peer, handler.close_reason)

    return ws


# ---------------------------------------------------------------------------
# Сборка приложения
# ---------------------------------------------------------------------------


async def _keepalive_reaper(app: web.Application) -> None:
    """
    Выселяет клиентов, замолчавших дольше своего keepalive.

    Без этого упавший участник остаётся в списке присутствующих навсегда: его
    сокет открыт с нашей стороны, а с той — нет. Здесь же публикуется его
    last will, то есть комната узнаёт, что он ушёл.
    """
    broker: Broker = app["broker"]
    try:
        while True:
            await asyncio.sleep(15)
            for client in broker.expired():
                logger.info("client %s timed out on keepalive", client.client_id)
                broker.disconnect(client, graceful=False)
                client.send.put_nowait(b"")
    except asyncio.CancelledError:
        return


async def _on_startup(app: web.Application) -> None:
    import aiohttp

    # Один пул соединений на процесс: InnerTube и проверка ссылок ходят к
    # одним и тем же хостам, и переустанавливать TLS на каждый трек — заметная
    # часть времени ожидания.
    app["session"] = aiohttp.ClientSession()
    app["resolver"]._verify = lambda url: verify_stream_url(app["session"], url)  # noqa: SLF001
    app["reaper"] = asyncio.ensure_future(_keepalive_reaper(app))

    # Надгробия чистим один раз при запуске, а не по таймеру: их единицы, и
    # лишняя периодическая задача в процессе, который делит ядро с VPN, стоит
    # дороже, чем те несколько строк, что она уберёт.
    try:
        removed = await app["sync"].prune_tombstones()
        if removed:
            logger.info("убрано просроченных надгробий: %d", removed)
    except Exception as exc:  # noqa: BLE001 — синхронизация не должна мешать запуску
        logger.warning("не удалось почистить надгробия: %s", exc)


async def _on_cleanup(app: web.Application) -> None:
    reaper = app.get("reaper")
    if reaper is not None:
        reaper.cancel()
        try:
            await reaper
        except asyncio.CancelledError:
            pass
    session = app.get("session")
    if session is not None:
        await session.close()
    store = app.get("sync")
    if store is not None:
        store.close()


def create_app(token: Optional[str] = None, *, resolver: Optional[StreamResolver] = None) -> web.Application:
    """
    Собирает приложение. `token` — только для тестов; в работе он берётся из
    окружения и его отсутствие останавливает запуск.
    """
    api_token = token if token is not None else os.getenv("WIREON_API_TOKEN", "").strip()
    if not api_token:
        raise RuntimeError(
            "WIREON_API_TOKEN не задан. Открытая ручка, гоняющая yt-dlp, — "
            "бесплатный резолвер для всего интернета с нашего адреса."
        )

    app = web.Application(
        middlewares=[cors_middleware, auth_middleware], client_max_size=MAX_BODY_BYTES
    )
    app["token"] = api_token
    app["limiter"] = RateLimiter()
    app["broker"] = Broker()
    app["resolver"] = resolver if resolver is not None else StreamResolver()
    app["identity"] = DiscordIdentity()
    app["sync"] = SyncStore()
    app["proxy_gate"] = asyncio.Semaphore(proxy.MAX_CONCURRENT_STREAMS)
    app["proxy_stats"] = proxy.new_stats()
    app["started_at"] = time.monotonic()

    app.router.add_get("/health", handle_health)
    app.router.add_get("/v1/resolve", handle_resolve)
    app.router.add_get("/v1/stream", handle_stream)
    app.router.add_get("/v1/radio", handle_radio)
    app.router.add_get("/v1/search", handle_search)
    app.router.add_get("/v1/sync", handle_sync_pull)
    # Порядок важен: `/v1/sync/wait` обязан стоять раньше маршрута удаления,
    # иначе `wait` разобралось бы как `{kind}` — впрочем, метод там другой,
    # так что это лишь ради читаемости.
    app.router.add_get("/v1/sync/wait", handle_sync_wait)
    app.router.add_post("/v1/sync", handle_sync_push)
    app.router.add_delete("/v1/sync/{kind:playlists|favorites}/{id}", handle_sync_delete)
    app.router.add_get("/mqtt", handle_mqtt)
    # Предзапрос приходит на тот же адрес, что и настоящий запрос, а маршрута
    # с методом `OPTIONS` у нас нет — без этой строки aiohttp отвечал бы `405`
    # раньше, чем до дела дошла бы прослойка.
    app.router.add_route("OPTIONS", "/{tail:.*}", handle_preflight)

    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)
    return app


async def start_music_server(
    port: Optional[int] = None, host: str = "0.0.0.0"
) -> Optional[web.AppRunner]:
    """
    Поднимает сервер и возвращает runner, не блокируя вызывающего.

    Такая форма нужна, чтобы врезаться в `bot.py` рядом с VPN: там уже есть
    работающий event loop и свой `start_vpn_server()`, который тоже ничего не
    блокирует. Отказ здесь не должен уронить VPN — поэтому None вместо
    исключения, с записью в журнал.
    """
    chosen = port if port is not None else int(os.getenv("WIREON_MUSIC_PORT", str(DEFAULT_PORT)))
    try:
        app = create_app()
    except RuntimeError as exc:
        logger.error("музыкальный сервер не запущен: %s", exc)
        return None

    # Бинарник готовится до того, как порт открыт: иначе первый же слушатель
    # получил бы отказ, пока идёт скачивание. Скачивание блокирующее — уводим в
    # поток, чтобы не держать event loop бота и VPN.
    binary = await asyncio.to_thread(ensure_ytdlp_binary)
    if binary is None:
        logger.error("yt-dlp недоступен — ссылки отдавать нечем, сервер не поднят")
        return None

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    try:
        site = web.TCPSite(runner, host, chosen)
        await site.start()
    except OSError as exc:
        logger.error("не удалось занять порт %s: %s", chosen, exc)
        await runner.cleanup()
        return None

    logger.info("музыкальный сервер слушает %s:%s (ссылки, радио, брокер)", host, chosen)
    return runner


def main() -> None:
    """Отдельный запуск: `python -m wireon_music`."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    async def run() -> None:
        runner = await start_music_server()
        if runner is None:
            raise SystemExit(1)
        try:
            # Ждать бесконечно: сервер живёт в задачах, а этой корутине надо
            # просто не завершиться, иначе runner уберётся вместе с ней.
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        logger.info("остановлен")
