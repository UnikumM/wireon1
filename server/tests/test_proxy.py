"""
Перелив звука: разбор `Range`, перевыдача ссылки и предел одновременных потоков.

Через настоящий aiohttp-сервер, а не вызовом функции: половина здешних решений
живёт в транспорте — код 206 вместо 200, заголовки, ушедшие до первого байта, и
невозможность отдать после них JSON с ошибкой. Подделана только раздача
(`googlevideo`), потому что проверяем мы своё поведение, а не её.
"""

import asyncio

import aiohttp
import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

from wireon_music import proxy
from wireon_music.app import create_app
from wireon_music.resolver import ResolveError, ResolvedStream, StreamResolver, is_ip_locked

TOKEN = "test-token-not-a-real-one"
VIDEO_ID = "dQw4w9WgXcQ"

LOCKED_URL = "https://rr1---sn-x.googlevideo.com/videoplayback?expire=1800003600&ip=203.0.113.10"
FREE_URL = "https://rr1---sn-x.googlevideo.com/videoplayback?expire=1800003600"


class CountingResolver(StreamResolver):
    """Резолвер без сети: считает обращения и умеет отдавать новую ссылку."""

    def __init__(self, urls=None) -> None:
        super().__init__(extract=lambda url, opts: {}, now=lambda: 1_800_000_000.0)
        self._urls = list(urls or [LOCKED_URL])
        self.calls = []
        self.invalidated = []

    def invalidate(self, video_id: str) -> None:
        self.invalidated.append(video_id)

    async def resolve(self, video_id: str) -> ResolvedStream:  # type: ignore[override]
        self.calls.append(video_id)
        url = self._urls[min(len(self.calls) - 1, len(self._urls) - 1)]
        return ResolvedStream(url, "m4a", 128, 1_800_003_600_000)


class FailingResolver(StreamResolver):
    def __init__(self, error: ResolveError) -> None:
        super().__init__(extract=lambda url, opts: {}, now=lambda: 1_800_000_000.0)
        self._error = error

    async def resolve(self, video_id: str) -> ResolvedStream:  # type: ignore[override]
        raise self._error


class FakeBody:
    def __init__(self, chunks, fail_after=None) -> None:
        self._chunks = list(chunks)
        self._fail_after = fail_after

    async def iter_chunked(self, size):
        for index, chunk in enumerate(self._chunks):
            if self._fail_after is not None and index == self._fail_after:
                raise aiohttp.ClientPayloadError("раздача оборвалась")
            yield chunk


class FakeUpstream:
    def __init__(self, status=200, headers=None, chunks=(), fail_after=None) -> None:
        self.status = status
        self.headers = headers or {}
        self.content = FakeBody(chunks, fail_after)
        self.released = False

    def release(self) -> None:
        self.released = True


class FakeSession:
    """Подделка `ClientSession.get`: отдаёт заготовки по очереди и пишет запросы."""

    def __init__(self, responses) -> None:
        self._responses = list(responses)
        self.requests = []

    async def close(self) -> None:
        """Приложение закрывает сессию при остановке — подделке нужен тот же вид."""

    async def get(self, url, headers=None, timeout=None, allow_redirects=True):
        self.requests.append({"url": url, "headers": dict(headers or {}), "timeout": timeout})
        if not self._responses:
            raise AssertionError("к раздаче обратились больше раз, чем заготовлено ответов")
        return self._responses.pop(0)


@pytest_asyncio.fixture
async def make_client():
    created = []

    async def build(resolver, responses):
        app = create_app(TOKEN, resolver=resolver)
        client = TestClient(TestServer(app))
        await client.start_server()
        created.append(client)
        # Настоящую сессию, поднятую при старте, закрываем: до `googlevideo`
        # в тестах никто не ходит, а незакрытая сессия шумит предупреждением.
        await app["session"].close()
        app["session"] = FakeSession(responses)
        return client

    yield build

    for client in created:
        await client.close()


def auth(extra=None):
    headers = {"X-Wireon-Token": TOKEN}
    headers.update(extra or {})
    return headers


# --- разбор Range ---------------------------------------------------------


@pytest.mark.parametrize(
    "header,expected",
    [
        (None, None),
        ("", None),
        ("bytes=0-", (0, None)),
        ("bytes=1024-", (1024, None)),
        ("bytes=0-1023", (0, 1023)),
        ("bytes=100-50", None),  # конец раньше начала — бессмыслица
        ("bytes=-500", None),  # «последние N» без длины не пересчитать
        ("items=0-10", None),
        ("bytes=0-10, 20-30", None),  # несколько диапазонов не поддерживаем
    ],
)
def test_parse_range(header, expected):
    assert proxy.parse_range(header) == expected


@pytest.mark.parametrize(
    "start,end,expected",
    [(0, None, None), (0, 1023, "bytes=0-1023"), (500, None, "bytes=500-")],
)
def test_range_header(start, end, expected):
    assert proxy.range_header(start, end) == expected


# --- признак привязки к адресу -------------------------------------------


def test_ip_locked_detects_signed_address():
    assert is_ip_locked(LOCKED_URL) is True


def test_ip_locked_false_without_parameter():
    assert is_ip_locked(FREE_URL) is False


def test_ip_locked_survives_garbage():
    assert is_ip_locked("не адрес вовсе") is False


# --- /v1/resolve сообщает, сработает ли ссылка у телефона -----------------


@pytest.mark.asyncio
async def test_resolve_marks_locked_link_and_offers_proxy(make_client):
    client = await make_client(CountingResolver([LOCKED_URL]), [])
    response = await client.get(f"/v1/resolve?id={VIDEO_ID}", headers=auth())
    body = await response.json()

    assert body["ipLocked"] is True
    assert body["proxyUrl"] == f"/v1/stream?id={VIDEO_ID}"


@pytest.mark.asyncio
async def test_resolve_leaves_free_link_alone(make_client):
    client = await make_client(CountingResolver([FREE_URL]), [])
    body = await (await client.get(f"/v1/resolve?id={VIDEO_ID}", headers=auth())).json()

    assert body["ipLocked"] is False
    # Ручки перелива в ответе нет: телефон должен качать сам, а не через нас.
    assert "proxyUrl" not in body


# --- сам перелив ----------------------------------------------------------


@pytest.mark.asyncio
async def test_streams_bytes_through(make_client):
    upstream = FakeUpstream(200, {"Content-Type": "audio/mp4", "Content-Length": "6"}, [b"abc", b"def"])
    client = await make_client(CountingResolver(), [upstream])

    response = await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())

    assert response.status == 200
    assert await response.read() == b"abcdef"
    assert response.headers["Content-Type"] == "audio/mp4"


@pytest.mark.asyncio
async def test_advertises_range_support_even_when_upstream_is_silent(make_client):
    # Без этого заголовка `<audio>` считает поток неперематываемым и прячет
    # ползунок — а перематывать мы умеем.
    client = await make_client(CountingResolver(), [FakeUpstream(200, {}, [b"x"])])
    response = await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())

    assert response.headers["Accept-Ranges"] == "bytes"


@pytest.mark.asyncio
async def test_forwards_range_and_206(make_client):
    upstream = FakeUpstream(
        206,
        {"Content-Range": "bytes 100-105/6000", "Content-Type": "audio/mp4"},
        [b"middle"],
    )
    session_holder = CountingResolver()
    client = await make_client(session_holder, [upstream])

    response = await client.get(
        f"/v1/stream?id={VIDEO_ID}", headers=auth({"Range": "bytes=100-105"})
    )

    assert response.status == 206
    assert response.headers["Content-Range"] == "bytes 100-105/6000"
    assert client.app["session"].requests[0]["headers"]["Range"] == "bytes=100-105"


@pytest.mark.asyncio
async def test_does_not_send_cookies_upstream(make_client):
    # Cookies живого аккаунта нужны добыче ссылки, но не скачиванию байтов.
    # Слать их на объём — верный способ потерять аккаунт, на котором всё стоит.
    client = await make_client(CountingResolver(), [FakeUpstream(200, {}, [b"x"])])
    await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())

    sent = client.app["session"].requests[0]["headers"]
    assert "Cookie" not in sent and "cookie" not in sent


@pytest.mark.asyncio
async def test_upstream_timeout_has_no_total_limit(make_client):
    # У сессии по умолчанию `total=5 минут`: трек длиннее оборвался бы ровно
    # на пятой минуте, и выглядело бы это как случайная поломка.
    client = await make_client(CountingResolver(), [FakeUpstream(200, {}, [b"x"])])
    await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())

    assert client.app["session"].requests[0]["timeout"].total is None


@pytest.mark.asyncio
async def test_reresolves_once_on_403(make_client):
    resolver = CountingResolver([LOCKED_URL, FREE_URL])
    client = await make_client(
        resolver, [FakeUpstream(403), FakeUpstream(200, {}, [b"second-try"])]
    )

    response = await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())

    assert await response.read() == b"second-try"
    assert resolver.invalidated == [VIDEO_ID]
    assert len(resolver.calls) == 2
    assert client.app["session"].requests[1]["url"] == FREE_URL


@pytest.mark.asyncio
async def test_gives_up_when_upstream_refuses_twice(make_client):
    client = await make_client(CountingResolver(), [FakeUpstream(403), FakeUpstream(403)])
    response = await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())

    assert response.status == 502
    assert (await response.json())["error"] == "UPSTREAM_REFUSED"


@pytest.mark.asyncio
async def test_resumes_from_the_byte_it_stopped_on(make_client):
    broken = FakeUpstream(200, {}, [b"aaaa", b"bbbb", b"cccc"], fail_after=2)
    resumed = FakeUpstream(206, {}, [b"cccc"])
    client = await make_client(CountingResolver(), [broken, resumed])

    response = await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())

    assert await response.read() == b"aaaabbbbcccc"
    # Докачка начинается ровно там, где оборвалось: восемь отданных байт.
    assert client.app["session"].requests[1]["headers"]["Range"] == "bytes=8-"


@pytest.mark.asyncio
async def test_aborts_rather_than_repeating_the_middle(make_client):
    # Раздача не поняла `Range` и начала сначала. Склеить это значило бы отдать
    # трек с повторённой серединой — поломка, которую никто не свяжет с сетью.
    broken = FakeUpstream(200, {}, [b"aaaa", b"bbbb"], fail_after=1)
    ignoring_range = FakeUpstream(200, {}, [b"aaaa", b"bbbb"])
    client = await make_client(CountingResolver(), [broken, ignoring_range])

    response = await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())
    with pytest.raises(aiohttp.ClientError):
        await response.read()


@pytest.mark.asyncio
async def test_second_break_ends_the_stream(make_client):
    broken = FakeUpstream(200, {}, [b"aaaa", b"bbbb"], fail_after=1)
    broken_again = FakeUpstream(206, {}, [b"bbbb"], fail_after=0)
    client = await make_client(CountingResolver(), [broken, broken_again])

    response = await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())
    with pytest.raises(aiohttp.ClientError):
        await response.read()


@pytest.mark.asyncio
async def test_refuses_when_all_slots_are_busy(make_client):
    client = await make_client(CountingResolver(), [])
    # Это тот же канал, что у VPN: честный отказ лучше, чем всем поровну плохо.
    client.app["proxy_gate"] = asyncio.Semaphore(0)

    response = await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())

    assert response.status == 503
    assert (await response.json())["error"] == "STREAM_BUSY"
    assert client.app["proxy_stats"]["busy"] == 1


@pytest.mark.asyncio
async def test_passes_resolve_failure_through_with_its_code(make_client):
    client = await make_client(FailingResolver(ResolveError("YT_UNAVAILABLE", "нет такого")), [])
    response = await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())

    assert response.status == 404
    assert (await response.json())["error"] == "YT_UNAVAILABLE"


@pytest.mark.asyncio
async def test_requires_a_token(make_client):
    client = await make_client(CountingResolver(), [])
    assert (await client.get(f"/v1/stream?id={VIDEO_ID}")).status == 401


@pytest.mark.asyncio
async def test_accepts_token_in_query_because_audio_tags_cannot_send_headers(make_client):
    client = await make_client(CountingResolver(), [FakeUpstream(200, {}, [b"x"])])
    response = await client.get(f"/v1/stream?id={VIDEO_ID}&token={TOKEN}")

    assert response.status == 200


@pytest.mark.asyncio
async def test_health_reports_the_cost_of_the_fallback(make_client):
    client = await make_client(CountingResolver(), [FakeUpstream(200, {}, [b"abcd"])])
    await (await client.get(f"/v1/stream?id={VIDEO_ID}", headers=auth())).read()

    body = await (await client.get("/health")).json()
    assert body["proxy"]["streams"] == 1
    assert body["proxy"]["bytes"] == 4
