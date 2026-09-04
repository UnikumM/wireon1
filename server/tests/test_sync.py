"""
Синхронизация медиатеки между устройствами одного человека.

Проверяется здесь не «сохранил и отдал» — это видно и так, — а то, из-за чего
синхронизация выглядит сломанной, оставаясь формально рабочей:

1. **Удалённое возвращается.** Движок клиента сливает пришедшее в местное, а потом
   отправляет местное целиком. Без надгробия сосед, у которого запись ещё есть,
   привозит её обратно, и удаление на телефоне отменяется само.
2. **Старое затирает новое.** Устройство, не выходившее на связь неделю, при
   первой же отправке откатывает чужие правки, если сервер принимает всё подряд.
3. **Чужое видно.** Личность обязан подтверждать Discord, а не общий токен
   сервера: тот лежит внутри APK и известен каждому, кто его распаковал.
4. **«Discord прилёг» неотличимо от «войди заново».** По первому надо подождать,
   по второму — заново входить, и один код на оба разлогинивал бы человека
   каждый раз, когда у Discord плохой день.
"""

import time

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

from wireon_music.app import create_app
from wireon_music.identity import DiscordIdentity, IdentityError
from wireon_music.sync import SyncStore

from .test_app import TOKEN, FakeResolver

ALICE = "discord-token-alice"
BOB = "discord-token-bob"


def fake_identity(unavailable: bool = False) -> DiscordIdentity:
    """Discord без Discord: токен и есть имя, кроме заведомо чужих."""

    async def fetch_me(_session, token: str):
        if unavailable:
            raise IdentityError("DISCORD_UNAVAILABLE", "Discord прилёг")
        if token in (ALICE, BOB):
            return {"id": f"id-of-{token}"}
        raise IdentityError("DISCORD_TOKEN_REJECTED", "Discord ответил 401")

    return DiscordIdentity(fetch_me=fetch_me)


@pytest_asyncio.fixture
async def client(tmp_path, request):
    marker = request.node.get_closest_marker("discord_down")
    app = create_app(TOKEN, resolver=FakeResolver())
    # База — во временной папке теста: хранилище по умолчанию ложится рядом с
    # сервером, и прогон оставлял бы файл в репозитории.
    app["sync"] = SyncStore(path=str(tmp_path / "sync.db"))
    app["identity"] = fake_identity(unavailable=marker is not None)
    server = TestServer(app)
    test_client = TestClient(server)
    await test_client.start_server()
    try:
        yield test_client
    finally:
        await test_client.close()


def headers(discord_token: str = ALICE) -> dict:
    return {"X-Wireon-Token": TOKEN, "X-Discord-Token": discord_token}


def playlist(pid: str, title: str, updated_at: int) -> dict:
    return {
        "id": pid,
        "title": title,
        "tracks": [],
        "createdAt": 1,
        "updatedAt": updated_at,
        "isSynced": True,
    }


def favorite(tid: str, title: str, added_at: int) -> dict:
    return {
        "id": tid,
        "source": "youtube",
        "originalId": tid,
        "title": title,
        "artist": "Кто-то",
        "duration": 100,
        "artworkUrl": "",
        "addedAt": added_at,
    }


class TestRoundTrip:
    @pytest.mark.asyncio
    async def test_what_one_device_sent_another_sees(self, client):
        pushed = await client.post(
            "/v1/sync",
            headers=headers(),
            json={
                "playlists": [playlist("p1", "Вечер", 100)],
                "favorites": [favorite("t1", "Трек", 100)],
            },
        )
        assert pushed.status == 200
        assert await pushed.json() == {"playlists": 1, "favorites": 1}

        pulled = await client.get("/v1/sync", headers=headers())
        body = await pulled.json()
        assert [p["title"] for p in body["playlists"]] == ["Вечер"]
        assert [t["title"] for t in body["favorites"]] == ["Трек"]

    @pytest.mark.asyncio
    async def test_empty_shelf_is_not_an_error(self, client):
        body = await (await client.get("/v1/sync", headers=headers())).json()
        assert body == {
            "playlists": [],
            "favorites": [],
            "deleted": {"playlists": [], "favorites": []},
            "deletedAt": {"playlists": {}, "favorites": {}},
        }


class TestLastWriteWins:
    @pytest.mark.asyncio
    async def test_newer_edit_replaces_older(self, client):
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Старое", 100)]})
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Новое", 200)]})

        body = await (await client.get("/v1/sync", headers=headers())).json()
        assert [p["title"] for p in body["playlists"]] == ["Новое"]

    @pytest.mark.asyncio
    async def test_stale_device_cannot_roll_back_the_others(self, client):
        # Телефон, неделю лежавший в кармане, не должен отменять правки с ПК.
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Новое", 200)]})
        response = await client.post(
            "/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Позавчерашнее", 100)]}
        )
        assert (await response.json())["playlists"] == 0

        body = await (await client.get("/v1/sync", headers=headers())).json()
        assert [p["title"] for p in body["playlists"]] == ["Новое"]

    @pytest.mark.asyncio
    async def test_equal_stamps_do_not_ping_pong(self, client):
        # При равных отметках побеждает уже лежащее: иначе два устройства с
        # одинаковой датой переписывали бы друг друга на каждой синхронизации.
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Первое", 100)]})
        response = await client.post(
            "/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Второе", 100)]}
        )
        assert (await response.json())["playlists"] == 0

    @pytest.mark.asyncio
    async def test_favorites_are_compared_by_their_own_field(self, client):
        # У избранного нет `updatedAt` — сравнивать надо по `addedAt`, тем же
        # числом, которым сравнивает клиент.
        await client.post("/v1/sync", headers=headers(), json={"favorites": [favorite("t1", "Новое", 200)]})
        response = await client.post(
            "/v1/sync", headers=headers(), json={"favorites": [favorite("t1", "Старое", 100)]}
        )
        assert (await response.json())["favorites"] == 0


class TestDeletionSticks:
    @pytest.mark.asyncio
    async def test_deleted_record_leaves_a_tombstone(self, client):
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Вечер", 100)]})
        assert (await client.delete("/v1/sync/playlists/p1", headers=headers())).status == 200

        body = await (await client.get("/v1/sync", headers=headers())).json()
        assert body["playlists"] == []
        assert body["deleted"]["playlists"] == ["p1"]

    @pytest.mark.asyncio
    async def test_a_neighbour_cannot_resurrect_what_was_deleted(self, client):
        """Та самая беда: удалил на телефоне — вернулось с ПК."""
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Вечер", 100)]})
        await client.delete("/v1/sync/playlists/p1", headers=headers())

        # ПК ещё не знает об удалении и отправляет свою копию — с той же датой,
        # что была до удаления.
        response = await client.post(
            "/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Вечер", 100)]}
        )
        assert (await response.json())["playlists"] == 0

        body = await (await client.get("/v1/sync", headers=headers())).json()
        assert body["playlists"] == []
        assert body["deleted"]["playlists"] == ["p1"]

    @pytest.mark.asyncio
    async def test_the_same_name_can_be_created_again_later(self, client):
        # Надгробие — не запрет. Запись с более поздней датой его перекрывает,
        # иначе восстановление из копии не работало бы никогда.
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Вечер", 100)]})
        await client.delete("/v1/sync/playlists/p1", headers=headers())

        response = await client.post(
            "/v1/sync",
            headers=headers(),
            json={"playlists": [playlist("p1", "Вечер снова", 9_999_999_999_999)]},
        )
        assert (await response.json())["playlists"] == 1

        body = await (await client.get("/v1/sync", headers=headers())).json()
        assert [p["title"] for p in body["playlists"]] == ["Вечер снова"]
        assert body["deleted"]["playlists"] == []

    @pytest.mark.asyncio
    async def test_a_tombstone_says_when_it_was_made(self, client):
        """
        Без даты удаления обратное действие невозможно.

        Клиент применяет чужие удаления перед тем, как отправить своё, и без
        даты делает это вслепую. Тогда «убрал трек, передумал, вернул» откатывалось
        ближайшей сверкой: надгробие просто есть, и возврат ему не указ. С датой
        удаление подчиняется общему правилу — побеждает более позднее.
        """
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Вечер", 100)]})
        before = int(time.time() * 1000)
        await client.delete("/v1/sync/playlists/p1", headers=headers())
        after = int(time.time() * 1000)

        body = await (await client.get("/v1/sync", headers=headers())).json()
        stamp = body["deletedAt"]["playlists"]["p1"]
        assert before <= stamp <= after
        # Список идентификаторов остался прежним: сборки, которые про дату не
        # знают, читают ответ как раньше.
        assert body["deleted"]["playlists"] == ["p1"]

    @pytest.mark.asyncio
    async def test_a_record_that_came_back_has_no_tombstone_date(self, client):
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Вечер", 100)]})
        await client.delete("/v1/sync/playlists/p1", headers=headers())
        await client.post(
            "/v1/sync",
            headers=headers(),
            json={"playlists": [playlist("p1", "Вечер снова", 9_999_999_999_999)]},
        )

        body = await (await client.get("/v1/sync", headers=headers())).json()
        assert body["deletedAt"]["playlists"] == {}

    @pytest.mark.asyncio
    async def test_deleting_something_never_seen_still_leaves_a_mark(self, client):
        # Устройство удалило запись раньше, чем успело её отправить. Без
        # надгробия сосед вернул бы её — для человека это одно и то же
        # удаление, которое не сработало.
        assert (await client.delete("/v1/sync/playlists/never-sent", headers=headers())).status == 200
        body = await (await client.get("/v1/sync", headers=headers())).json()
        assert body["deleted"]["playlists"] == ["never-sent"]


class TestOwnership:
    @pytest.mark.asyncio
    async def test_one_persons_records_are_invisible_to_another(self, client):
        await client.post("/v1/sync", headers=headers(ALICE), json={"playlists": [playlist("p1", "Моё", 100)]})

        body = await (await client.get("/v1/sync", headers=headers(BOB))).json()
        assert body["playlists"] == []

    @pytest.mark.asyncio
    async def test_the_shared_server_token_alone_proves_nothing(self, client):
        # Он лежит внутри APK. Если бы личность определялась им, любой
        # распаковавший сборку читал бы чужие плейлисты.
        response = await client.get("/v1/sync", headers={"X-Wireon-Token": TOKEN})
        assert response.status == 401
        assert (await response.json())["error"] == "DISCORD_TOKEN_REQUIRED"

    @pytest.mark.asyncio
    async def test_without_the_server_token_nothing_is_reachable(self, client):
        response = await client.get("/v1/sync", headers={"X-Discord-Token": ALICE})
        assert response.status == 401

    @pytest.mark.asyncio
    async def test_a_token_discord_refuses_is_a_401(self, client):
        # Латиницей нарочно: кириллица упёрлась бы в проверку «только ASCII»
        # строкой выше, и тест проверял бы не то, что написано в его названии.
        response = await client.get("/v1/sync", headers=headers("someone-elses-token"))
        assert response.status == 401
        assert (await response.json())["error"] == "DISCORD_TOKEN_REJECTED"

    @pytest.mark.asyncio
    async def test_a_broken_header_is_a_refusal_not_a_crash(self, client):
        # Значения заголовков приходят из сети байтами и разбираются как
        # latin-1. Первый же байт вне ASCII валил кодирование внутри, и ручка
        # отвечала 500 на любой кривой заголовок — то есть уронить её мог кто
        # угодно одним запросом.
        broken = bytes([0xD0, 0xB0]).decode("latin-1")
        response = await client.get(
            "/v1/sync", headers={"X-Wireon-Token": TOKEN, "X-Discord-Token": broken}
        )
        assert response.status == 401
        assert (await response.json())["error"] == "DISCORD_TOKEN_INVALID"

    @pytest.mark.discord_down
    @pytest.mark.asyncio
    async def test_discord_being_down_is_not_a_reason_to_sign_out(self, client):
        response = await client.get("/v1/sync", headers=headers())
        assert response.status == 503
        assert (await response.json())["error"] == "DISCORD_UNAVAILABLE"


class TestGuards:
    @pytest.mark.asyncio
    async def test_body_that_is_not_json_is_refused_plainly(self, client):
        response = await client.post("/v1/sync", headers=headers(), data="не json")
        assert response.status == 400
        assert (await response.json())["error"] == "SYNC_BAD_BODY"

    @pytest.mark.asyncio
    async def test_records_without_an_id_are_dropped_not_stored(self, client):
        response = await client.post(
            "/v1/sync",
            headers=headers(),
            json={"playlists": [{"title": "без имени"}, playlist("p1", "С именем", 100)]},
        )
        assert (await response.json())["playlists"] == 1

    @pytest.mark.asyncio
    async def test_a_huge_record_does_not_take_the_disk_down(self, client):
        # Диск в контейнере один на всех, и бот живёт на нём же. Запись сверх
        # предела молча не сохраняется — остальная пачка при этом проходит.
        # Кириллица в UTF-8 — два байта на знак, а предел записи в 256 КБ
        # считается по ним же: 200 тысяч знаков его переходят.
        fat = playlist("p1", "Ж" * 200_000, 100)
        response = await client.post(
            "/v1/sync", headers=headers(), json={"playlists": [fat, playlist("p2", "Обычный", 100)]}
        )
        assert (await response.json())["playlists"] == 1

        body = await (await client.get("/v1/sync", headers=headers())).json()
        assert [p["id"] for p in body["playlists"]] == ["p2"]

    @pytest.mark.asyncio
    async def test_a_body_over_the_limit_says_so_instead_of_blaming_json(self, client):
        # Раньше это приходило как «тело не JSON» — и человек с большой
        # медиатекой шёл искать поломку в своих данных.
        huge = [playlist(f"p{i}", "Щ" * 4_000, 100) for i in range(400)]
        response = await client.post("/v1/sync", headers=headers(), json={"playlists": huge})
        assert response.status == 413
        assert (await response.json())["error"] == "SYNC_BODY_TOO_LARGE"

    @pytest.mark.asyncio
    async def test_too_many_records_at_once_are_refused(self, client):
        many = [playlist(f"p{i}", "Много", 100) for i in range(600)]
        response = await client.post("/v1/sync", headers=headers(), json={"playlists": many})
        assert response.status == 413
        assert (await response.json())["error"] == "SYNC_BATCH_TOO_LARGE"


class TestWaitForChange:
    """
    Ожидание изменений обычным запросом.

    Зачем оно вообще: на Android страница приложения живёт на `https`, а брокер
    отвечает по незащищённому `ws://` — браузер запрещает такое соединение сам,
    и телефон не может слушать брокер в принципе. Обычные запросы оттуда
    проходят, поэтому ожидание сделано обычным запросом.

    Проверяется то, чем такая ручка ломается: молчанием, когда изменение уже
    случилось (клиент повиснет до срока и пропустит его), и вечным висением,
    когда не случилось ничего.
    """

    @pytest.mark.asyncio
    async def test_отвечает_сразу_если_изменение_уже_было(self, client):
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Раз", 100)]})

        body = await (await client.get("/v1/sync/wait?since=0", headers=headers())).json()

        assert body["changed"] is True
        assert body["revision"] == 100

    @pytest.mark.asyncio
    async def test_молчит_пока_ничего_не_меняется(self, client):
        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Раз", 100)]})

        import asyncio

        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(
                client.get("/v1/sync/wait?since=100", headers=headers()),
                timeout=0.5,
            )

    @pytest.mark.asyncio
    async def test_будит_когда_другое_устройство_прислало_правку(self, client):
        import asyncio

        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Раз", 100)]})

        waiting = asyncio.ensure_future(client.get("/v1/sync/wait?since=100", headers=headers()))
        await asyncio.sleep(0.05)
        assert not waiting.done(), "ручка обязана держать запрос, а не отвечать сразу"

        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p2", "Два", 200)]})

        body = await (await asyncio.wait_for(waiting, timeout=2)).json()
        assert body["changed"] is True
        assert body["revision"] == 200

    @pytest.mark.asyncio
    async def test_чужая_правка_не_будит(self, client):
        import asyncio

        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Раз", 100)]})
        waiting = asyncio.ensure_future(client.get("/v1/sync/wait?since=100", headers=headers()))
        await asyncio.sleep(0.05)

        # Боб пишет в свой шкаф — Алису это не касается.
        await client.post("/v1/sync", headers=headers(BOB), json={"playlists": [playlist("b1", "Чужое", 300)]})
        await asyncio.sleep(0.1)

        assert not waiting.done()
        waiting.cancel()

    @pytest.mark.asyncio
    async def test_удаление_тоже_будит(self, client):
        import asyncio

        await client.post("/v1/sync", headers=headers(), json={"playlists": [playlist("p1", "Раз", 100)]})
        waiting = asyncio.ensure_future(client.get("/v1/sync/wait?since=100", headers=headers()))
        await asyncio.sleep(0.05)

        await client.delete("/v1/sync/playlists/p1", headers=headers())

        body = await (await asyncio.wait_for(waiting, timeout=2)).json()
        assert body["changed"] is True

    @pytest.mark.asyncio
    async def test_без_подтверждённой_личности_не_ждёт(self, client):
        response = await client.get("/v1/sync/wait?since=0", headers=headers("кто-то-чужой"))
        assert response.status == 401
