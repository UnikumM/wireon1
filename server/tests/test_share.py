"""Страница «поделиться треком»: публичная, экранирует всё, что пришло, 404 на мусор."""

import pytest
from aiohttp.test_utils import TestClient, TestServer

from wireon_music.app import create_app
from wireon_music.share import render_share_page

from .test_app import TOKEN, FakeResolver


def test_page_escapes_and_builds_links():
    page = render_share_page("yt", "dQw4w9WgXcQ", {"n": "<b>Город спит</b>", "a": "Лампа & Ко", "img": "https://i.ytimg.com/vi/x/hq.jpg"})
    assert page is not None
    assert "&lt;b&gt;Город спит&lt;/b&gt;" in page
    assert "<b>" not in page.split("<style>")[0].split("<title>")[1]
    assert 'href="wireon://track/yt/dQw4w9WgXcQ"' in page
    assert "music.youtube.com/watch?v=dQw4w9WgXcQ" in page
    assert 'property="og:image" content="https://i.ytimg.com/vi/x/hq.jpg"' in page
    assert "Лампа &amp; Ко" in page


def test_bad_source_or_id_is_none():
    assert render_share_page("vk", "123", {}) is None
    assert render_share_page("yt", "../etc", {}) is None
    assert render_share_page("yt", "", {}) is None


def test_soundcloud_permalink_goes_to_button_and_deep_link():
    page = render_share_page("sc", "123456", {"n": "x", "u": "https://soundcloud.com/kino/kukushka"})
    assert page is not None
    assert 'href="https://soundcloud.com/kino/kukushka"' in page
    assert "wireon://track/sc/123456?u=https%3A%2F%2Fsoundcloud.com%2Fkino%2Fkukushka" in page
    # Чужой адрес в `u` отбрасывается: кнопка ведёт в поиск SoundCloud.
    evil = render_share_page("sc", "1", {"u": "https://evil.example/x"})
    assert evil is not None and "evil.example" not in evil and "soundcloud.com/search" in evil


def test_non_https_image_is_dropped():
    page = render_share_page("sc", "123456", {"img": "http://evil/x.jpg", "n": "x"})
    assert page is not None and "og:image" not in page and "cover-empty" in page


@pytest.mark.asyncio
async def test_public_route_without_token():
    app = create_app(TOKEN, resolver=FakeResolver())
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        ok = await client.get("/t/yt/abcDEF123?n=%D0%A2%D1%80%D0%B5%D0%BA&a=%D0%90")
        assert ok.status == 200
        assert "text/html" in ok.headers["Content-Type"]
        body = await ok.text()
        assert "Открыть в Wireon" in body
        bad = await client.get("/t/yt/not%20an%20id")
        assert bad.status == 404
        # Остальные ручки по-прежнему закрыты.
        assert (await client.get("/v1/sync")).status == 401
    finally:
        await client.close()
