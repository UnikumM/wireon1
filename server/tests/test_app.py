"""
HTTP-поверхность сервера: авторизация, ограничение частоты, коды ответов и
WebSocket с MQTT.

Проверяется через реальный aiohttp-сервер (`aiohttp.test_utils`), потому что
половина здешних решений — про сам транспорт: подпротокол `mqtt`, адрес
обращающегося за прокси, живость без токена.
"""

import asyncio
import json

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

from wireon_music import mqtt
from wireon_music.app import RateLimiter, create_app
from wireon_music.resolver import ResolveError, ResolvedStream, StreamResolver

from .test_mqtt import client_connect, client_publish, client_subscribe

TOKEN = "test-token-not-a-real-one"
VIDEO_ID = "dQw4w9WgXcQ"


class FakeResolver(StreamResolver):
    """Резолвер без сети: отдаёт заготовку либо кидает заданный отказ."""

    def __init__(self, *, error: ResolveError = None) -> None:
        super().__init__(extract=lambda url, opts: {}, now=lambda: 1_800_000_000.0)
        self._error = error
        self.calls = []

    async def resolve(self, video_id: str) -> ResolvedStream:  # type: ignore[override]
        self.calls.append(video_id)
        if self._error is not None:
            raise self._error
        return ResolvedStream(
            stream_url="https://rr1---sn-x.googlevideo.com/videoplayback?expire=1800003600",
            format="m4a",
            bitrate=128,
            expires_at=1_800_003_600_000,
        )


@pytest_asyncio.fixture
async def client(request):
    """
    Клиент к настоящему серверу.

    Маркеры: `resolver_error` задаёт отказ резолвера, `rate_limit` — свой предел
    частоты. Оба ставятся до старта: менять состояние поднятого приложения
    aiohttp запрещает, и не зря — middleware читает эти ключи на каждом запросе.
    """
    error_marker = request.node.get_closest_marker("resolver_error")
    limit_marker = request.node.get_closest_marker("rate_limit")
    resolver = FakeResolver(error=error_marker.args[0] if error_marker else None)
    app = create_app(TOKEN, resolver=resolver)
    if limit_marker:
        app["limiter"] = RateLimiter(limit=limit_marker.args[0], window=60.0)
    server = TestServer(app)
    test_client = TestClient(server)
    await test_client.start_server()
    test_client.resolver = resolver
    try:
        yield test_client
    finally:
        await test_client.close()


class TestCors:
    """
    Разрешение браузеру.

    Без него синхронизация на компьютере не работала ни разу: окно приложения
    грузится с `file://`, к нам идут свои заголовки, поэтому браузер сначала
    спрашивает разрешения методом `OPTIONS` — а мы отвечали на него `401`, ведь
    токена в предзапросе нет и быть не может. Настоящий запрос после отказа не
    уходит вовсе, и приложение показывает «Failed to fetch» — без строчки в
    журнале сервера, потому что до сервера ничего и не доехало.
    """

    @pytest.mark.asyncio
    async def test_preflight_passes_without_token(self, client):
        response = await client.options(
            "/v1/sync",
            headers={
                "Origin": "null",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "x-wireon-token,x-discord-token",
            },
        )
        assert response.status == 204
        assert response.headers["Access-Control-Allow-Origin"] == "*"
        allowed = response.headers["Access-Control-Allow-Headers"].lower()
        # Именно эти два заголовка и делают запрос непростым.
        assert "x-wireon-token" in allowed
        assert "x-discord-token" in allowed
        assert "DELETE" in response.headers["Access-Control-Allow-Methods"]

    @pytest.mark.asyncio
    async def test_real_answer_carries_permission(self, client):
        """Разрешение нужно и на самом ответе: без него браузер прячет тело."""
        response = await client.get("/health")
        assert response.status == 200
        assert response.headers["Access-Control-Allow-Origin"] == "*"

    @pytest.mark.asyncio
    async def test_permission_is_not_a_key(self, client):
        """Разрешение браузеру не отменяет проверку токена."""
        response = await client.get("/v1/sync", headers={"Origin": "null"})
        assert response.status == 401
        assert response.headers["Access-Control-Allow-Origin"] == "*"


class TestAuth:
    @pytest.mark.asyncio
    async def test_health_needs_no_token(self):
        """
        Живость проверяется снаружи, в том числе мониторингом, у которого токена
        нет. Наружу уходят только счётчики.
        """
        app = create_app(TOKEN, resolver=FakeResolver())
        server = TestServer(app)
        test_client = TestClient(server)
        await test_client.start_server()
        try:
            response = await test_client.get("/health")
            assert response.status == 200
            body = await response.json()
            assert body["ok"] is True
            assert body["service"] == "wireon-music"
            assert "broker" in body and "resolver" in body
        finally:
            await test_client.close()

    @pytest.mark.asyncio
    async def test_no_token_is_401(self, client):
        response = await client.get(f"/v1/resolve?id={VIDEO_ID}")
        assert response.status == 401
        assert client.resolver.calls == [], "работа не должна начинаться до проверки токена"

    @pytest.mark.asyncio
    async def test_wrong_token_is_401(self, client):
        response = await client.get(
            f"/v1/resolve?id={VIDEO_ID}", headers={"X-Wireon-Token": "wrong"}
        )
        assert response.status == 401

    @pytest.mark.asyncio
    async def test_header_token_works(self, client):
        response = await client.get(
            f"/v1/resolve?id={VIDEO_ID}", headers={"X-Wireon-Token": TOKEN}
        )
        assert response.status == 200

    @pytest.mark.asyncio
    async def test_query_token_works_for_websocket_only_reasons(self, client):
        """
        `?token=` существует ровно потому, что браузерный `WebSocket` не умеет
        задавать заголовки. Для обычных ручек он тоже работает, но заголовок
        предпочтителен: адрес с токеном оседает в журналах прокси.
        """
        response = await client.get(f"/v1/resolve?id={VIDEO_ID}&token={TOKEN}")
        assert response.status == 200

    def test_server_refuses_to_start_without_a_token(self, monkeypatch):
        """
        Открытая ручка, гоняющая yt-dlp, — бесплатный резолвер для всего
        интернета с нашего адреса, и YouTube заметит это раньше нас.
        """
        monkeypatch.delenv("WIREON_API_TOKEN", raising=False)
        with pytest.raises(RuntimeError) as excinfo:
            create_app()
        assert "WIREON_API_TOKEN" in str(excinfo.value)


class TestResolveEndpoint:
    @pytest.mark.asyncio
    async def test_returns_only_the_link(self, client):
        """
        Ключевое свойство всей затеи: наружу уходит ссылка и метаданные, около
        килобайта, а не поток. Звук телефон качает сам.

        `ipLocked` этого не отменяет: это по-прежнему метаданные, ответ на
        вопрос «сработает ли ссылка у тебя». Перелив живёт на отдельной ручке,
        и попасть на неё случайно нельзя.
        """
        response = await client.get(
            f"/v1/resolve?id={VIDEO_ID}", headers={"X-Wireon-Token": TOKEN}
        )
        body = await response.json()
        assert set(body) == {"streamUrl", "format", "bitrate", "expiresAt", "ipLocked"}
        assert body["streamUrl"].startswith("https://")
        assert len(json.dumps(body).encode()) < 2048

    @pytest.mark.asyncio
    @pytest.mark.resolver_error(ResolveError("YT_UNAVAILABLE", "Video unavailable"))
    async def test_missing_video_is_404(self, client):
        response = await client.get(
            f"/v1/resolve?id={VIDEO_ID}", headers={"X-Wireon-Token": TOKEN}
        )
        assert response.status == 404
        assert (await response.json())["error"] == "YT_UNAVAILABLE"

    @pytest.mark.asyncio
    @pytest.mark.resolver_error(ResolveError("YT_BOT_CHECK", "not a bot"))
    async def test_bot_check_is_403(self, client):
        """
        Отдельный код ответа, потому что это единственный отказ, который лечится
        действием, а не ожиданием: сменой адреса сервера.
        """
        response = await client.get(
            f"/v1/resolve?id={VIDEO_ID}", headers={"X-Wireon-Token": TOKEN}
        )
        assert response.status == 403

    @pytest.mark.asyncio
    @pytest.mark.resolver_error(ResolveError("YT_ALL_ATTEMPTS_FAILED", "everything failed"))
    async def test_transient_failure_is_502(self, client):
        response = await client.get(
            f"/v1/resolve?id={VIDEO_ID}", headers={"X-Wireon-Token": TOKEN}
        )
        assert response.status == 502

    @pytest.mark.asyncio
    @pytest.mark.resolver_error(ResolveError("YT_BAD_ID", "invalid"))
    async def test_bad_id_is_404_not_500(self, client):
        response = await client.get("/v1/resolve?id=nope", headers={"X-Wireon-Token": TOKEN})
        assert response.status == 404

    @pytest.mark.asyncio
    async def test_error_codes_match_the_desktop_ones(self, client):
        """
        Коды те же, что у десктопа (`YT_*`), потому что фразы для человека уже
        написаны под них в `playbackErrors.ts`. Свои коды означали бы «что-то
        пошло не так» на экране.
        """
        from wireon_music.resolver import TERMINAL_PATTERNS

        codes = {code for _pattern, code in TERMINAL_PATTERNS}
        assert codes == {
            "YT_AGE_RESTRICTED",
            "YT_PRIVATE",
            "YT_GEO_BLOCKED",
            "YT_UNAVAILABLE",
            "YT_LIVE",
        }


class TestSearchEndpoint:
    @pytest.mark.asyncio
    async def test_empty_query_is_400(self, client):
        response = await client.get("/v1/search?q=", headers={"X-Wireon-Token": TOKEN})
        assert response.status == 400
        assert (await response.json())["error"] == "QUERY_REQUIRED"

    @pytest.mark.asyncio
    async def test_absurdly_long_query_is_400(self, client):
        response = await client.get(
            "/v1/search?q=" + "a" * 500, headers={"X-Wireon-Token": TOKEN}
        )
        assert response.status == 400
        assert (await response.json())["error"] == "QUERY_TOO_LONG"


class TestRateLimit:
    def test_window_slides(self):
        limiter = RateLimiter(limit=3, window=60.0)
        assert limiter.allow("1.2.3.4", now=0.0)
        assert limiter.allow("1.2.3.4", now=1.0)
        assert limiter.allow("1.2.3.4", now=2.0)
        assert not limiter.allow("1.2.3.4", now=3.0)
        # Окно проехало — снова можно.
        assert limiter.allow("1.2.3.4", now=62.0)

    def test_addresses_are_counted_separately(self):
        limiter = RateLimiter(limit=1, window=60.0)
        assert limiter.allow("1.1.1.1", now=0.0)
        assert not limiter.allow("1.1.1.1", now=0.0)
        assert limiter.allow("2.2.2.2", now=0.0)

    @pytest.mark.asyncio
    @pytest.mark.rate_limit(1)
    async def test_forwarded_header_separates_listeners_behind_a_proxy(self, client):
        """
        За cloudflared все обращения приходят с одного сокета. Не читая
        заголовок, первый же человек выел бы лимит на всех.
        """
        first = await client.get(
            f"/v1/resolve?id={VIDEO_ID}",
            headers={"X-Wireon-Token": TOKEN, "CF-Connecting-IP": "10.0.0.1"},
        )
        second = await client.get(
            f"/v1/resolve?id={VIDEO_ID}",
            headers={"X-Wireon-Token": TOKEN, "CF-Connecting-IP": "10.0.0.2"},
        )
        assert first.status == 200
        assert second.status == 200

        third = await client.get(
            f"/v1/resolve?id={VIDEO_ID}",
            headers={"X-Wireon-Token": TOKEN, "CF-Connecting-IP": "10.0.0.1"},
        )
        assert third.status == 429

    @pytest.mark.asyncio
    @pytest.mark.rate_limit(1)
    async def test_health_is_not_rate_limited(self, client):
        """Мониторинг стучится часто; закрыть ему живость — потерять живость."""
        for _ in range(5):
            assert (await client.get("/health")).status == 200


class TestMqttWebSocket:
    @pytest.mark.asyncio
    async def test_handshake_and_room_delivery(self, client):
        """
        Полный путь двух участников комнаты через настоящий WebSocket: подпротокол,
        CONNACK, SUBACK и доставка сообщения от одного другому.
        """
        a = await client.ws_connect(f"/mqtt?token={TOKEN}", protocols=("mqtt",))
        b = await client.ws_connect(f"/mqtt?token={TOKEN}", protocols=("mqtt",))
        try:
            await a.send_bytes(client_connect("peer_a", keep_alive=30))
            connack = await a.receive_bytes(timeout=2)
            assert connack == mqtt.encode_connack(mqtt.CONNACK_ACCEPTED)

            await b.send_bytes(client_connect("peer_b", keep_alive=30))
            await b.receive_bytes(timeout=2)

            await b.send_bytes(client_subscribe("wireon/room/ABCD", 1))
            suback = await b.receive_bytes(timeout=2)
            assert suback[0] >> 4 == mqtt.SUBACK

            await a.send_bytes(client_publish("wireon/room/ABCD", '{"type":"play"}'))
            delivered = await b.receive_bytes(timeout=2)
            packets, rest = mqtt.decode_packets(delivered)
            assert rest == b""
            assert packets[0].topic == "wireon/room/ABCD"
            assert packets[0].payload == b'{"type":"play"}'
        finally:
            await a.close()
            await b.close()

    @pytest.mark.asyncio
    async def test_subprotocol_is_answered(self, client):
        """
        Клиент открывает сокет с подпротоколом `mqtt`. Без ответного
        подтверждения браузер закрывает соединение, и выглядит это как сетевая
        ошибка — отладить почти невозможно.
        """
        ws = await client.ws_connect(f"/mqtt?token={TOKEN}", protocols=("mqtt",))
        try:
            assert ws.protocol == "mqtt"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_websocket_without_a_token_is_refused(self, client):
        from aiohttp import WSServerHandshakeError

        with pytest.raises(WSServerHandshakeError) as excinfo:
            await client.ws_connect("/mqtt", protocols=("mqtt",))
        assert excinfo.value.status == 401

    @pytest.mark.asyncio
    async def test_text_frame_is_refused_with_a_reason(self, client):
        """
        Первая версия «слушать вместе» шла сырым JSON и умирала молча — именно
        поэтому она работала только между вкладками одного браузера.
        """
        ws = await client.ws_connect(f"/mqtt?token={TOKEN}", protocols=("mqtt",))
        try:
            await ws.send_str('{"type":"join"}')
            # Сокет закрывается: сервер не молчит и не делает вид, что принял.
            await asyncio.wait_for(ws.receive(), timeout=2)
            assert ws.closed or (await ws.receive()).type.name in ("CLOSED", "CLOSE")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_retained_snapshot_reaches_a_later_joiner(self, client):
        """
        Пришедший позже узнаёт позицию хоста сразу, а не через полсекунды, когда
        хост пришлёт следующее обновление.
        """
        host = await client.ws_connect(f"/mqtt?token={TOKEN}", protocols=("mqtt",))
        try:
            await host.send_bytes(client_connect("host"))
            await host.receive_bytes(timeout=2)
            await host.send_bytes(
                client_publish("wireon/room/WXYZ", '{"position":42}', retain=True)
            )

            joiner = await client.ws_connect(f"/mqtt?token={TOKEN}", protocols=("mqtt",))
            try:
                await joiner.send_bytes(client_connect("joiner"))
                await joiner.receive_bytes(timeout=2)
                await joiner.send_bytes(client_subscribe("wireon/room/WXYZ", 1))
                raw = b""
                # SUBACK и удержанный PUBLISH могут прийти как одним кадром, так
                # и двумя: граница кадра не связана с границей пакета.
                for _ in range(2):
                    raw += await joiner.receive_bytes(timeout=2)
                    packets, _ = mqtt.decode_packets(raw)
                    if any(p.type == mqtt.PUBLISH for p in packets):
                        break
                packets, _ = mqtt.decode_packets(raw)
                published = [p for p in packets if p.type == mqtt.PUBLISH]
                assert published and published[0].payload == b'{"position":42}'
            finally:
                await joiner.close()
        finally:
            await host.close()

    @pytest.mark.asyncio
    async def test_broker_count_shows_up_in_health(self, client):
        ws = await client.ws_connect(f"/mqtt?token={TOKEN}", protocols=("mqtt",))
        try:
            await ws.send_bytes(client_connect("counted"))
            await ws.receive_bytes(timeout=2)
            body = await (await client.get("/health")).json()
            assert body["broker"]["clients"] == 1
        finally:
            await ws.close()


class TestCookieDeathIsVisible:
    """
    Смерть cookies видна снаружи по имени, а не по «серверу плохо».

    Снаружи протухшие cookies выглядят как 502 на каждый трек — ровно так же,
    как сломанный бинарник, забитый tmpfs или упавший JS-движок. Разбираться в
    этом каждый раз заново стоит часов, поэтому признак назван отдельно.
    """

    @pytest.mark.asyncio
    async def test_quiet_while_nothing_is_wrong(self, client):
        body = await (await client.get("/health")).json()
        assert body["cookiesLookDead"] is False

    @pytest.mark.asyncio
    async def test_raised_when_cookies_are_there_and_youtube_still_refuses(
        self, client, tmp_path, monkeypatch
    ):
        cookies = tmp_path / "yt-cookies.txt"
        cookies.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
        monkeypatch.setenv("WIREON_YTDLP_COOKIES", str(cookies))
        client.app["resolver"]._bot_check_seen = True  # noqa: SLF001

        body = await (await client.get("/health")).json()
        assert body["cookiesLookDead"] is True

    @pytest.mark.asyncio
    async def test_silent_without_cookies(self, client, monkeypatch):
        # Без cookies бот-проверка на адресе дата-центра — обычное дело.
        # Тревога, поднятая навсегда, перестаёт быть тревогой.
        monkeypatch.setenv("WIREON_YTDLP_COOKIES", "")
        client.app["resolver"]._bot_check_seen = True  # noqa: SLF001

        body = await (await client.get("/health")).json()
        assert body["cookiesLookDead"] is False
