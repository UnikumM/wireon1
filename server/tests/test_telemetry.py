"""
Статистика: что принимается, что отбрасывается и что остаётся в базе.

Главное здесь — договор с пользователями: у удачной загрузки не остаётся ни
трека, ни текста; адреса нет нигде; мусорный отчёт — отказ, а не падение.
"""

import sqlite3

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

from wireon_music.app import create_app
from wireon_music.telemetry import DAY_MS, TelemetryError, TelemetryStore, sanitize_report

from .test_app import TOKEN, FakeResolver

INSTALL = "3f6c1d2e-aaaa-bbbb-cccc-0123456789ab"


def report(**extra):
    body = {
        "install": INSTALL,
        "version": "3.2.0",
        "platform": "windows",
        "discordName": "slushatel",
        "events": [
            {"kind": "resolve", "ok": True, "source": "youtube", "ms": 300, "videoId": "dQw4w9WgXcQ", "detail": "x"},
            {"kind": "resolve", "ok": False, "source": "youtube", "ms": 9000, "code": "YT_ALL_ATTEMPTS_FAILED",
             "detail": "default: URL rejected on playback (HTTP 403)", "videoId": "kJQP7kiw5Fk"},
        ],
    }
    body.update(extra)
    return body


@pytest_asyncio.fixture
async def client(tmp_path):
    app = create_app(TOKEN, resolver=FakeResolver())
    app["telemetry"] = TelemetryStore(path=str(tmp_path / "t.db"))
    test_client = TestClient(TestServer(app))
    await test_client.start_server()
    try:
        yield test_client, str(tmp_path / "t.db")
    finally:
        await test_client.close()


class TestSanitize:
    def test_success_keeps_no_track_and_no_text(self):
        clean = sanitize_report(report())
        ok, fail = clean["events"]
        assert ok["video_id"] is None and ok["detail"] is None and ok["code"] is None
        assert fail["video_id"] == "kJQP7kiw5Fk" and fail["code"] == "YT_ALL_ATTEMPTS_FAILED"

    def test_report_without_install_is_refused(self):
        with pytest.raises(TelemetryError):
            sanitize_report({"events": []})

    def test_events_and_text_are_bounded(self):
        clean = sanitize_report(report(events=[{"ok": False, "detail": "я" * 5000}] * 500))
        assert len(clean["events"]) == 100
        assert len(clean["events"][0]["detail"]) == 300

    def test_addresses_never_reach_the_database(self):
        detail = "probe 403 https://rr1.googlevideo.com/videoplayback?ip=41.66.99.238&x=1 from 10.0.0.5 / 2001:41d0:1008:4a0::1"
        clean = sanitize_report(report(events=[{"ok": False, "detail": detail}]))["events"][0]["detail"]
        assert "41.66" not in clean and "10.0.0.5" not in clean and "2001:41d0" not in clean and "http" not in clean

    def test_unknown_platform_is_not_stored_verbatim(self):
        assert sanitize_report(report(platform="<script>"))["platform"] == "unknown"


class TestEndpoint:
    @pytest.mark.asyncio
    async def test_needs_the_app_token(self, client):
        c, _ = client
        response = await c.post("/v1/telemetry", json=report())
        assert response.status == 401

    @pytest.mark.asyncio
    async def test_stores_report_and_no_address(self, client):
        c, path = client
        response = await c.post("/v1/telemetry", json=report(), headers={"X-Wireon-Token": TOKEN})
        assert response.status == 200
        assert (await response.json())["accepted"] == 2

        conn = sqlite3.connect(path)
        columns = {row[1] for table in ("installs", "events") for row in conn.execute(f"PRAGMA table_info({table})")}
        assert not any("ip" == c or "addr" in c or "remote" in c for c in columns)
        assert conn.execute("SELECT discord_name, platform FROM installs").fetchone() == ("slushatel", "windows")

    @pytest.mark.asyncio
    async def test_garbage_is_a_400_not_a_crash(self, client):
        c, _ = client
        response = await c.post("/v1/telemetry", data="не json", headers={"X-Wireon-Token": TOKEN})
        assert response.status == 400


class TestSummary:
    @pytest.mark.asyncio
    async def test_counts_and_retention(self, tmp_path):
        clock = {"now": 100 * DAY_MS}
        store = TelemetryStore(path=str(tmp_path / "s.db"), now=lambda: clock["now"])
        await store.record(sanitize_report(report()))
        summary = store.summary()
        assert summary["active_day"] == 1
        assert summary["failures_day"] == 1
        assert summary["median_ms_day"] == 300
        assert summary["users_week"] == ["slushatel"]

        clock["now"] += 31 * DAY_MS
        await store.record(sanitize_report(report(events=[])))
        assert store.summary()["resolves_day"] == 0
        store.close()
