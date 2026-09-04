"""
InnerTube: форма запросов и то, из-за чего радио «работало на рандом».

Сети здесь нет — сессия подменена. Проверяется ровно то, что мы отправляем:
станция `RDAMVM<id>`, клиент `WEB_REMIX` и заголовки. Без них ответ формально
приходит, но это не радио.
"""

import pytest

from wireon_music import innertube


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status = status

    async def json(self):
        return self._payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    """Запоминает последний запрос и отдаёт заготовленный ответ."""

    def __init__(self, payload=None, status=200, raise_on_post=None):
        self.payload = payload if payload is not None else {}
        self.status = status
        self.raise_on_post = raise_on_post
        self.last = None

    def post(self, url, json=None, headers=None, timeout=None):
        self.last = {"url": url, "json": json, "headers": headers}
        if self.raise_on_post is not None:
            raise self.raise_on_post
        return FakeResponse(self.payload, self.status)


def radio_payload(video_ids):
    """Ответ `next` той формы, что разбирает клиент."""
    return {
        "contents": {
            "singleColumnMusicWatchNextResultsRenderer": {
                "tabbedRenderer": {
                    "watchNextTabbedResultsRenderer": {
                        "tabs": [
                            {
                                "tabRenderer": {
                                    "content": {
                                        "musicQueueRenderer": {
                                            "content": {
                                                "playlistPanelRenderer": {
                                                    "contents": [
                                                        {"playlistPanelVideoRenderer": {"videoId": vid}}
                                                        for vid in video_ids
                                                    ]
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                }
            }
        }
    }


class TestRadioRequest:
    @pytest.mark.asyncio
    async def test_station_id_is_rdamvm_plus_video_id(self):
        """
        Без `RDAMVM<id>` endpoint отдаёт очередь из одного трека — той же
        песни, — и это выглядит как «радио не работает».
        """
        session = FakeSession(radio_payload(["a", "b"]))
        await innertube.radio(session, "dQw4w9WgXcQ")
        assert session.last["json"]["playlistId"] == "RDAMVMdQw4w9WgXcQ"
        assert session.last["json"]["videoId"] == "dQw4w9WgXcQ"
        assert session.last["json"]["isAudioOnly"] is True

    @pytest.mark.asyncio
    async def test_client_is_web_remix(self):
        """
        `WEB_REMIX` — это YouTube Music. Обычный `WEB` вернул бы рекомендации
        видеохостинга, то есть подкасты и клипы вперемешку с музыкой.
        """
        session = FakeSession(radio_payload([]))
        await innertube.radio(session, "dQw4w9WgXcQ")
        client = session.last["json"]["context"]["client"]
        assert client["clientName"] == "WEB_REMIX"
        assert client["hl"] == "ru" and client["gl"] == "RU"

    @pytest.mark.asyncio
    async def test_headers_match_the_desktop_ones(self):
        """
        Тот же User-Agent и `X-YouTube-Client-Name`, что в главном процессе: InnerTube
        отдаёт мобильным клиентам другую разметку, а разбор на клиенте написан
        под эту.
        """
        session = FakeSession(radio_payload([]))
        await innertube.radio(session, "dQw4w9WgXcQ")
        headers = session.last["headers"]
        assert headers["X-YouTube-Client-Name"] == "67"
        assert headers["Origin"] == "https://music.youtube.com"
        assert "Chrome" in headers["User-Agent"]

    @pytest.mark.asyncio
    async def test_url_is_the_next_endpoint(self):
        session = FakeSession(radio_payload([]))
        await innertube.radio(session, "dQw4w9WgXcQ")
        assert session.last["url"].endswith("/youtubei/v1/next")

    @pytest.mark.asyncio
    async def test_bad_video_id_never_reaches_the_network(self):
        session = FakeSession(radio_payload([]))
        for bad in ("", "short", "has spaces!", None):
            with pytest.raises(innertube.InnerTubeError):
                await innertube.radio(session, bad)
        assert session.last is None

    @pytest.mark.asyncio
    async def test_non_200_becomes_an_error_with_the_status(self):
        session = FakeSession({}, status=429)
        with pytest.raises(innertube.InnerTubeError) as excinfo:
            await innertube.radio(session, "dQw4w9WgXcQ")
        assert "429" in str(excinfo.value)

    @pytest.mark.asyncio
    async def test_network_failure_is_wrapped_not_leaked(self):
        session = FakeSession(raise_on_post=OSError("connection reset"))
        with pytest.raises(innertube.InnerTubeError) as excinfo:
            await innertube.radio(session, "dQw4w9WgXcQ")
        assert "connection reset" in str(excinfo.value)


class TestSearchRequest:
    @pytest.mark.asyncio
    async def test_songs_only_filter_is_passed_verbatim(self):
        """
        `params` закодирован протобуфом. Его нельзя «поправить» — только
        заменить целиком на другой готовый, поэтому он сверяется байт в байт с
        тем, что шлёт главный процесс.
        """
        session = FakeSession({"contents": {}})
        await innertube.search(session, "фонк")
        assert session.last["json"]["params"] == "Eg-KAQwIARAAGAAgACgAMABqChAEEAMQCRAFEAo%3D"
        assert session.last["json"]["query"] == "фонк"
        assert session.last["url"].endswith("/youtubei/v1/search")

    @pytest.mark.asyncio
    async def test_raw_payload_is_returned_unchanged(self):
        """
        Разбор живёт на клиенте и покрыт тестами. Разбирать здесь второй раз —
        значит завести два места, которые обязаны угадать структуру InnerTube
        одинаково, и они разъедутся на первой же смене формата.
        """
        payload = {"contents": {"tabbedSearchResultsRenderer": {"tabs": []}}}
        session = FakeSession(payload)
        assert await innertube.search(session, "x") is payload


class TestQueueLength:
    def test_counts_only_real_queue_items(self):
        assert innertube.queue_length(radio_payload(["a", "b", "c"])) == 3

    def test_empty_queue_is_zero_not_an_error(self):
        """
        Несуществующий videoId деградирует до пустой очереди, а не в HTTP-ошибку.
        Поэтому ноль здесь значит «этим путём не вышло», и это надо различать от
        пятидесяти треков прямо на сервере, по журналу.
        """
        assert innertube.queue_length(radio_payload([])) == 0

    def test_unexpected_shape_is_zero(self):
        assert innertube.queue_length(None) == 0
        assert innertube.queue_length({}) == 0
        assert innertube.queue_length({"contents": "not a dict"}) == 0
