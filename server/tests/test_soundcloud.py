"""
Ключ SoundCloud на сервере: один на всех, перепроверка раз в час, поиск не чаще
раза в десять минут. Сети нет — сессия подделана.
"""

import asyncio

import pytest

from wireon_music.soundcloud import (
    SoundCloudKeyKeeper,
    extract_bundle_urls,
    extract_client_id,
)

KEY_A = "A" * 32
KEY_B = "B" * 32
HOME = """
<html><head>
<script src="https://a-v2.sndcdn.com/assets/0-abc.js"></script>
<script src="https://a-v2.sndcdn.com/assets/1-def.js"></script>
<script src="/assets/2-local.js"></script>
<script src="https://cdn.example.com/tracker.js"></script>
</head></html>
"""


class FakeResponse:
    def __init__(self, status=200, text=""):
        self.status = status
        self._text = text

    async def text(self):
        return self._text

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    """Отвечает по таблице адрес → ответ, считает обращения."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        # Самый длинный подходящий префикс: «https://soundcloud.com» не должен
        # перехватывать адреса сборок на том же хосте.
        best = max((p for p in self.routes if url.startswith(p)), key=len, default=None)
        if best is None:
            return FakeResponse(404)
        response = self.routes[best]
        return response() if callable(response) else response


def api_ok_for(*keys):
    """Проверка ключа: 200 только для перечисленных."""

    def route():
        return FakeResponse(200)

    return {f"https://api-v2.soundcloud.com/search/tracks?q=a&limit=1&client_id={k}": route for k in keys}


class Clock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def test_bundles_come_last_first_and_skip_foreign_hosts():
    urls = extract_bundle_urls(HOME)
    assert urls == [
        "https://soundcloud.com/assets/2-local.js",
        "https://a-v2.sndcdn.com/assets/1-def.js",
        "https://a-v2.sndcdn.com/assets/0-abc.js",
    ]


def test_extracts_key_in_both_notations():
    assert extract_client_id(f'var x={{client_id:"{KEY_A}"}}') == KEY_A
    assert extract_client_id(f'{{"client_id":"{KEY_B}"}}') == KEY_B
    assert extract_client_id('client_id:"short"') is None


@pytest.mark.asyncio
async def test_seed_key_served_without_discovery():
    session = FakeSession(api_ok_for(KEY_A))
    keeper = SoundCloudKeyKeeper(seed=[KEY_A], now=Clock())
    key = await keeper.get(session)
    assert key is not None and key.client_id == KEY_A
    # На soundcloud.com не ходили: запасной ключ жив.
    assert all("soundcloud.com/" not in url or "api-v2" in url for url in session.calls)
    assert keeper.stats["discoveries"] == 0


@pytest.mark.asyncio
async def test_dead_seed_leads_to_discovery():
    routes = {
        "https://soundcloud.com": FakeResponse(200, HOME),
        "https://a-v2.sndcdn.com/assets/1-def.js": FakeResponse(200, f'client_id:"{KEY_B}"'),
    }
    routes.update(api_ok_for(KEY_B))
    session = FakeSession(routes)
    keeper = SoundCloudKeyKeeper(seed=[KEY_A], now=Clock())
    key = await keeper.get(session)
    assert key is not None and key.client_id == KEY_B
    assert keeper.stats["discoveries"] == 1
    # Сборки сканировались с хвоста: до первой с ключом дошли за две загрузки.
    assert "https://soundcloud.com/assets/2-local.js" in session.calls
    assert "https://a-v2.sndcdn.com/assets/0-abc.js" not in session.calls


@pytest.mark.asyncio
async def test_key_is_not_rechecked_within_ttl_and_rechecked_after():
    clock = Clock()
    session = FakeSession(api_ok_for(KEY_A))
    keeper = SoundCloudKeyKeeper(seed=[KEY_A], now=clock, ttl_s=3600)
    await keeper.get(session)
    checks = len(session.calls)
    clock.t += 600
    await keeper.get(session)
    assert len(session.calls) == checks
    clock.t += 3600
    await keeper.get(session)
    assert len(session.calls) == checks + 1


@pytest.mark.asyncio
async def test_discovery_respects_cooldown():
    clock = Clock()
    session = FakeSession({"https://soundcloud.com": FakeResponse(503)})
    keeper = SoundCloudKeyKeeper(seed=[], now=clock, cooldown_s=600)
    assert await keeper.get(session) is None
    home_calls = session.calls.count("https://soundcloud.com")
    assert await keeper.get(session) is None
    # Второй поход на soundcloud.com не состоялся: выдержка.
    assert session.calls.count("https://soundcloud.com") == home_calls
    clock.t += 601
    assert await keeper.get(session) is None
    assert session.calls.count("https://soundcloud.com") == home_calls + 1


@pytest.mark.asyncio
async def test_dead_report_about_live_key_changes_nothing():
    session = FakeSession(api_ok_for(KEY_A))
    keeper = SoundCloudKeyKeeper(seed=[KEY_A], now=Clock())
    await keeper.get(session)
    key = await keeper.report_dead(session, KEY_A)
    # Ключ прошёл проверку — жалоба была про загрузку, а не про ключ.
    assert key is not None and key.client_id == KEY_A
    assert keeper.stats["discoveries"] == 0


@pytest.mark.asyncio
async def test_dead_report_about_dead_key_replaces_it():
    live = {KEY_A}
    def api(key):
        return lambda: FakeResponse(200 if key in live else 401)
    routes = {
        f"https://api-v2.soundcloud.com/search/tracks?q=a&limit=1&client_id={KEY_A}": api(KEY_A),
        f"https://api-v2.soundcloud.com/search/tracks?q=a&limit=1&client_id={KEY_B}": api(KEY_B),
        "https://soundcloud.com": FakeResponse(200, HOME),
        "https://soundcloud.com/assets/2-local.js": FakeResponse(200, f'"client_id":"{KEY_B}"'),
    }
    session = FakeSession(routes)
    keeper = SoundCloudKeyKeeper(seed=[KEY_A], now=Clock())
    await keeper.get(session)
    live.clear(); live.add(KEY_B)
    key = await keeper.report_dead(session, KEY_A)
    assert key is not None and key.client_id == KEY_B


@pytest.mark.asyncio
async def test_concurrent_requests_share_one_discovery():
    routes = {
        "https://soundcloud.com": FakeResponse(200, HOME),
        "https://soundcloud.com/assets/2-local.js": FakeResponse(200, f'client_id:"{KEY_B}"'),
    }
    routes.update(api_ok_for(KEY_B))
    session = FakeSession(routes)
    keeper = SoundCloudKeyKeeper(seed=[], now=Clock())
    keys = await asyncio.gather(*(keeper.get(session) for _ in range(5)))
    assert {k.client_id for k in keys} == {KEY_B}
    assert session.calls.count("https://soundcloud.com") == 1


@pytest.mark.asyncio
async def test_http_surface_serves_key_and_requires_token():
    """Ручки на живом сервере: без токена 401, с токеном — ключ, 503 без ключа."""
    from aiohttp.test_utils import TestClient, TestServer

    from wireon_music.app import create_app
    from wireon_music.soundcloud import SoundCloudKey

    from .test_app import TOKEN, FakeResolver

    app = create_app(TOKEN, resolver=FakeResolver())
    keeper = SoundCloudKeyKeeper(seed=[], now=Clock(), ttl_s=10**9)
    keeper._key = SoundCloudKey(KEY_A, 1_000_000.0)  # noqa: SLF001 — заранее найденный ключ, без сети
    app["soundcloud"] = keeper
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        assert (await client.get("/v1/soundcloud/key")).status == 401
        response = await client.get("/v1/soundcloud/key", headers={"X-Wireon-Token": TOKEN})
        assert response.status == 200
        body = await response.json()
        assert body["clientId"] == KEY_A and body["expiresAt"] > body["checkedAt"]

        bad = await client.post("/v1/soundcloud/key/dead", json={"clientId": "x"}, headers={"X-Wireon-Token": TOKEN})
        assert bad.status == 400

        health = await (await client.get("/health")).json()
        assert health["soundcloud"]["hasKey"] is True
    finally:
        await client.close()
