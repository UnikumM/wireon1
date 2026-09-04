"""
Резолвер: выбор формата, разбор срока жизни, коды отказа и защита от лавины
одинаковых запросов.

Ни сети, ни yt-dlp здесь нет — извлечение и проверка ссылки инжектятся. Это не
удобство тестов, а требование к самому модулю: то, что нельзя подменить, нельзя
и проверить, а неправильный выбор формата виден человеку как «песня не играет».
"""

import asyncio

import pytest

from wireon_music.resolver import (
    ATTEMPT_TIMEOUT_S,
    COOKIES_ENV,
    DEFAULT_COOKIES_NAME,
    JS_RUNTIME_ENV,
    RESOLVE_ATTEMPTS,
    RESOLVE_ATTEMPTS_WITH_COOKIES,
    STALE_TEMP_AGE_S,
    sweep_ytdlp_temp,
    ytdlp_env,
    ytdlp_temp_dir,
    ResolveError,
    StreamResolver,
    _extract_with_ytdlp,
    classify_error,
    attempts_for,
    cookies_file,
    js_runtime,
    pick_audio_format,
    stream_expiry,
)

NOW = 1_800_000_000.0  # фиксированное «сейчас», чтобы сроки были предсказуемы
VIDEO_ID = "dQw4w9WgXcQ"


def audio_format(**overrides) -> dict:
    base = {
        "url": "https://rr1---sn-x.googlevideo.com/videoplayback?expire=1800003600",
        "ext": "m4a",
        "abr": 128,
        "acodec": "mp4a.40.2",
        "vcodec": "none",
        "protocol": "https",
    }
    base.update(overrides)
    return base


def info_with(*formats) -> dict:
    return {"formats": list(formats)}


class TestPickAudioFormat:
    def test_prefers_audio_only_over_video_bearing(self):
        with_video = audio_format(vcodec="avc1", abr=192, format_id="18")
        audio_only = audio_format(abr=128, format_id="140")
        picked = pick_audio_format(info_with(with_video, audio_only))
        assert picked is not None
        assert picked[0]["format_id"] == "140", "картинка тратит трафик телефона зря"

    def test_progressive_beats_a_manifest(self):
        """
        Манифест требует hls.js, а для DASH не играет вовсе. Прогрессивный HTTP
        `<audio>` играет сам.
        """
        manifest = audio_format(protocol="m3u8_native", abr=256, format_id="hls")
        progressive = audio_format(abr=128, format_id="140")
        picked = pick_audio_format(info_with(manifest, progressive))
        assert picked[0]["format_id"] == "140"
        assert picked[1] is False

    def test_manifest_is_flagged_when_it_is_the_only_option(self):
        manifest = audio_format(protocol="m3u8_native", format_id="hls")
        picked = pick_audio_format(info_with(manifest))
        assert picked[1] is True, "манифест нельзя проверять байтовым диапазоном"

    def test_m3u8_in_the_url_counts_as_a_manifest(self):
        # Часть ответов не указывает protocol, и тогда судить можно только по адресу.
        weird = audio_format(protocol="", url="https://host/master.m3u8?token=1")
        assert pick_audio_format(info_with(weird))[1] is True

    def test_m4a_wins_over_webm_at_equal_bitrate(self):
        webm = audio_format(ext="webm", format_id="251")
        m4a = audio_format(ext="m4a", format_id="140")
        assert pick_audio_format(info_with(webm, m4a))[0]["format_id"] == "140"

    def test_higher_bitrate_wins_within_the_same_container(self):
        low = audio_format(abr=64, format_id="139")
        high = audio_format(abr=256, format_id="141")
        assert pick_audio_format(info_with(low, high))[0]["format_id"] == "141"

    def test_formats_without_a_url_are_not_candidates(self):
        assert pick_audio_format(info_with({"ext": "m4a", "abr": 320})) is None

    def test_top_level_url_is_used_when_there_are_no_formats(self):
        info = {"url": "https://host/audio.m4a", "ext": "m4a", "abr": 128}
        picked = pick_audio_format(info)
        assert picked[0]["url"] == "https://host/audio.m4a"

    def test_empty_and_none_are_handled(self):
        assert pick_audio_format(None) is None
        assert pick_audio_format({}) is None
        assert pick_audio_format({"formats": []}) is None


class TestStreamExpiry:
    def test_reads_the_expire_parameter(self):
        url = "https://host/videoplayback?expire=1800003600&other=1"
        assert stream_expiry(url, NOW) == 1_800_003_600 * 1000

    def test_reads_the_expiry_from_the_path(self):
        url = "https://host/expire/1800003600/videoplayback"
        assert stream_expiry(url, NOW) == 1_800_003_600 * 1000

    def test_expired_stamp_falls_back_to_the_default_ttl(self):
        """
        Прошедший срок — не повод отдать ссылку с датой в прошлом: клиент счёл бы
        её мёртвой сразу и запросил заново по кругу.
        """
        url = "https://host/videoplayback?expire=1000000000"
        assert stream_expiry(url, NOW) > NOW * 1000

    def test_garbage_url_gets_the_default_ttl(self):
        assert stream_expiry("not a url at all", NOW) == int((NOW + 5 * 3600) * 1000)

    def test_non_numeric_expire_is_ignored(self):
        url = "https://host/videoplayback?expire=soon"
        assert stream_expiry(url, NOW) == int((NOW + 5 * 3600) * 1000)


class TestClassifyError:
    @pytest.mark.parametrize(
        "message,code",
        [
            ("ERROR: Sign in to confirm your age", "YT_AGE_RESTRICTED"),
            ("This video is age-restricted", "YT_AGE_RESTRICTED"),
            ("Private video. Sign in if you've been granted access", "YT_PRIVATE"),
            ("The uploader has not made this video available in your country", "YT_GEO_BLOCKED"),
            ("Video unavailable", "YT_UNAVAILABLE"),
            ("This video has been removed by the uploader", "YT_UNAVAILABLE"),
            ("This live event will begin in 2 hours", "YT_LIVE"),
        ],
    )
    def test_terminal_failures_get_a_code(self, message, code):
        assert classify_error(message) == code

    def test_bot_check_is_not_terminal(self):
        """
        Один клиент получает проверку «вы не робот», другой в ту же секунду
        отдаёт формат. Признай её терминальной — и перебор остановится на первой
        же ступени, хотя песня играется.
        """
        assert classify_error("Sign in to confirm you're not a bot") is None

    def test_transient_network_error_is_not_terminal(self):
        assert classify_error("Unable to download webpage: timed out") is None


class TestResolveLadder:
    @pytest.mark.asyncio
    async def test_first_working_client_wins(self):
        calls = []

        def extract(url, opts):
            calls.append(opts.get("extractor_args"))
            return info_with(audio_format())

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        resolved = await resolver.resolve(VIDEO_ID)
        assert resolved.format == "m4a"
        assert resolved.bitrate == 128
        assert len(calls) == 1, "лишние попытки — это лишние секунды ожидания"

    @pytest.mark.asyncio
    async def test_ladder_moves_on_after_a_transient_failure(self):
        attempts = []

        def extract(url, opts):
            args = opts.get("extractor_args")
            attempts.append(args)
            if len(attempts) < 3:
                raise RuntimeError("Unable to download webpage: timed out")
            return info_with(audio_format())

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        await resolver.resolve(VIDEO_ID)
        assert len(attempts) == 3
        assert attempts[1]["youtube"]["player_client"] == ["tv"]
        assert attempts[2]["youtube"]["player_client"] == ["tv_downgraded"]

    @pytest.mark.asyncio
    async def test_terminal_failure_stops_the_ladder_immediately(self):
        """
        Удалённое или возрастное видео отказывает одинаково всем клиентам.
        Ещё четыре попытки — это двадцать потраченных секунд и худшая формулировка.
        """
        calls = []

        def extract(url, opts):
            calls.append(1)
            raise RuntimeError("Video unavailable")

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        with pytest.raises(ResolveError) as excinfo:
            await resolver.resolve(VIDEO_ID)
        assert excinfo.value.code == "YT_UNAVAILABLE"
        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_bot_check_on_every_client_gets_its_own_code(self):
        def extract(url, opts):
            raise RuntimeError("Sign in to confirm you're not a bot")

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        with pytest.raises(ResolveError) as excinfo:
            await resolver.resolve(VIDEO_ID)
        assert excinfo.value.code == "YT_BOT_CHECK"

    @pytest.mark.asyncio
    async def test_all_attempts_failing_says_so(self, tmp_path, monkeypatch):
        # Лестница зависит от наличия cookies, поэтому их отсутствие здесь
        # задаётся явно: иначе тест ломался бы у того, кто положил `yt-cookies.txt`
        # рядом с сервером, и ломался бы непонятно почему.
        monkeypatch.setenv(COOKIES_ENV, str(tmp_path / "нет.txt"))

        def extract(url, opts):
            raise RuntimeError("some transient nonsense")

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        with pytest.raises(ResolveError) as excinfo:
            await resolver.resolve(VIDEO_ID)
        assert excinfo.value.code == "YT_ALL_ATTEMPTS_FAILED"
        # В подробностях перечислены все ступени: по журналу видно, что пробовали.
        assert excinfo.value.detail.count(";") == len(RESOLVE_ATTEMPTS) - 1

    @pytest.mark.asyncio
    async def test_response_without_audio_moves_to_the_next_client(self):
        attempts = []

        def extract(url, opts):
            attempts.append(1)
            if len(attempts) == 1:
                return {"formats": []}
            return info_with(audio_format())

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        await resolver.resolve(VIDEO_ID)
        assert len(attempts) == 2

    @pytest.mark.asyncio
    async def test_bad_video_id_is_rejected_before_any_work(self):
        called = []

        def extract(url, opts):
            called.append(1)
            return info_with(audio_format())

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        for bad in ("", "short", "way_too_long_id", "has spaces", None):
            with pytest.raises(ResolveError) as excinfo:
                await resolver.resolve(bad)
            assert excinfo.value.code == "YT_BAD_ID"
        assert called == []


class TestVerification:
    @pytest.mark.asyncio
    async def test_rejected_url_moves_to_the_next_client(self):
        """
        Ровно та беда, ради которой проверка и существует: yt-dlp вернул ссылку,
        а CDN отвечает на неё 403. Без проверки трек «играет» тишиной.
        """
        attempts = []

        def extract(url, opts):
            attempts.append(1)
            return info_with(audio_format(url=f"https://host/{len(attempts)}"))

        async def verify(url):
            return (url.endswith("/2"), "HTTP 403" if url.endswith("/1") else "HTTP 200")

        resolver = StreamResolver(extract=extract, verify=verify, now=lambda: NOW)
        resolved = await resolver.resolve(VIDEO_ID)
        assert resolved.stream_url.endswith("/2")
        assert len(attempts) == 2

    @pytest.mark.asyncio
    async def test_manifest_goes_through_unverified(self):
        verified = []

        def extract(url, opts):
            return info_with(audio_format(protocol="m3u8_native", url="https://host/x.m3u8"))

        async def verify(url):
            verified.append(url)
            return False, "HTTP 403"

        resolver = StreamResolver(extract=extract, verify=verify, now=lambda: NOW)
        resolved = await resolver.resolve(VIDEO_ID)
        assert resolved.stream_url.endswith(".m3u8")
        assert verified == [], "манифест байтовым диапазоном не проверяется"


class TestCacheAndSharing:
    @pytest.mark.asyncio
    async def test_second_request_is_served_from_cache(self):
        calls = []

        def extract(url, opts):
            calls.append(1)
            return info_with(audio_format())

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        first = await resolver.resolve(VIDEO_ID)
        second = await resolver.resolve(VIDEO_ID)
        assert first.stream_url == second.stream_url
        assert len(calls) == 1
        assert resolver.stats == {"hits": 1, "misses": 1, "failures": 0}

    @pytest.mark.asyncio
    async def test_expiring_entry_is_dropped_a_minute_early(self):
        """
        Ссылка, умершая на середине запроса, выглядит как поломка приложения,
        а не как истёкший срок.
        """
        calls = []

        def extract(url, opts):
            calls.append(1)
            return info_with(audio_format(url="https://host/v?expire=1800000100"))

        clock = {"now": NOW}
        resolver = StreamResolver(extract=extract, now=lambda: clock["now"])
        await resolver.resolve(VIDEO_ID)
        assert resolver.cached(VIDEO_ID) is not None

        clock["now"] = 1_800_000_045.0  # до срока 55 с — меньше запаса в минуту
        assert resolver.cached(VIDEO_ID) is None

    @pytest.mark.asyncio
    async def test_a_hundred_phones_on_one_song_make_one_request(self):
        """
        Главная защита сервера: сто одинаковых извлечений с одного адреса и есть
        проверка «вы не робот».
        """
        calls = []
        release = asyncio.Event()

        async def extract(url, opts):
            calls.append(1)
            await release.wait()
            return info_with(audio_format())

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        waiters = [asyncio.ensure_future(resolver.resolve(VIDEO_ID)) for _ in range(100)]
        await asyncio.sleep(0)
        release.set()
        results = await asyncio.gather(*waiters)

        assert len(calls) == 1
        assert len({r.stream_url for r in results}) == 1

    @pytest.mark.asyncio
    async def test_one_cancelled_waiter_does_not_starve_the_others(self):
        """
        Телефон закрыл приложение на середине загрузки. Задача принадлежит
        резолверу, а не ожидающему, поэтому остальные получают свою ссылку.
        """
        release = asyncio.Event()

        async def extract(url, opts):
            await release.wait()
            return info_with(audio_format())

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        first = asyncio.ensure_future(resolver.resolve(VIDEO_ID))
        second = asyncio.ensure_future(resolver.resolve(VIDEO_ID))
        await asyncio.sleep(0)
        first.cancel()
        release.set()
        assert (await second).format == "m4a"

    @pytest.mark.asyncio
    async def test_failure_is_not_cached(self):
        """
        Отказ бывает временным (упало зеркало, дрогнула сеть). Закэшировав его,
        мы отказали бы человеку и на следующей минуте, когда всё уже работает.
        """
        state = {"fail": True}

        def extract(url, opts):
            if state["fail"]:
                raise RuntimeError("transient")
            return info_with(audio_format())

        resolver = StreamResolver(extract=extract, now=lambda: NOW)
        with pytest.raises(ResolveError):
            await resolver.resolve(VIDEO_ID)
        state["fail"] = False
        assert (await resolver.resolve(VIDEO_ID)).format == "m4a"


class TestConcurrencyAndTimeouts:
    @pytest.mark.asyncio
    async def test_extractions_are_capped(self):
        """
        yt-dlp держит GIL и ядро секундами. Без предела десять запросов делают
        друг друга медленнее ровно во столько же раз.
        """
        peak = {"now": 0, "max": 0}
        release = asyncio.Event()

        async def extract(url, opts):
            peak["now"] += 1
            peak["max"] = max(peak["max"], peak["now"])
            await release.wait()
            peak["now"] -= 1
            return info_with(audio_format())

        resolver = StreamResolver(extract=extract, now=lambda: NOW, max_concurrent=3)
        ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee"]
        waiters = [asyncio.ensure_future(resolver.resolve(i)) for i in ids]
        await asyncio.sleep(0.01)
        release.set()
        await asyncio.gather(*waiters)
        assert peak["max"] <= 3

    @pytest.mark.asyncio
    async def test_stuck_attempt_yields_to_the_next_client(self):
        """
        `socket_timeout` ограничивает простой сокета, а не всю попытку. Без
        своего предела застрявший клиент держал бы слот бесконечно — ровно та
        беда, из-за которой загрузка на телефоне «замирала намертво».
        """
        attempts = []

        async def extract(url, opts):
            attempts.append(1)
            if len(attempts) == 1:
                await asyncio.sleep(10)
            return info_with(audio_format())

        resolver = StreamResolver(extract=extract, now=lambda: NOW, attempt_timeout=0.05)
        resolved = await resolver.resolve(VIDEO_ID)
        assert resolved.format == "m4a"
        assert len(attempts) == 2

    def test_default_attempt_timeout_is_shorter_than_the_client_budget(self):
        """
        У renderer на весь источник 30 с (`SOURCE_TIMEOUT_MS`). Попытка сервера
        обязана уложиться внутрь, иначе клиент сдастся раньше, чем сервер
        успеет перейти к следующему клиенту, и лестница окажется бесполезной.
        """
        assert ATTEMPT_TIMEOUT_S < 30.0


class TestCookiesFile:
    """
    Cookies — единственное лекарство от проверки «вы не робот» с адреса
    дата-центра, поэтому важнее всего здесь не «находит файл», а «не ломает
    работу, когда файла нет». `--cookies` с пустым файлом yt-dlp считает
    отказом и валит все пять попыток разом.
    """

    def test_no_file_means_no_cookies(self, tmp_path, monkeypatch):
        monkeypatch.delenv(COOKIES_ENV, raising=False)
        assert cookies_file(str(tmp_path)) is None

    def test_empty_file_is_not_cookies(self, tmp_path, monkeypatch):
        monkeypatch.delenv(COOKIES_ENV, raising=False)
        (tmp_path / DEFAULT_COOKIES_NAME).write_text("")
        assert cookies_file(str(tmp_path)) is None

    def test_file_next_to_the_server_is_found(self, tmp_path, monkeypatch):
        monkeypatch.delenv(COOKIES_ENV, raising=False)
        target = tmp_path / DEFAULT_COOKIES_NAME
        target.write_text("# Netscape HTTP Cookie File")
        assert cookies_file(str(tmp_path)) == str(target)

    def test_environment_wins_over_the_default_place(self, tmp_path, monkeypatch):
        (tmp_path / DEFAULT_COOKIES_NAME).write_text("# рядом")
        elsewhere = tmp_path / "another" / "cookies.txt"
        elsewhere.parent.mkdir()
        elsewhere.write_text("# по переменной")
        monkeypatch.setenv(COOKIES_ENV, str(elsewhere))
        assert cookies_file(str(tmp_path)) == str(elsewhere)

    def test_environment_pointing_at_nothing_degrades_to_none(self, tmp_path, monkeypatch):
        monkeypatch.setenv(COOKIES_ENV, str(tmp_path / "нет-такого.txt"))
        assert cookies_file(str(tmp_path)) is None

    def test_directory_instead_of_a_file_is_not_cookies(self, tmp_path, monkeypatch):
        monkeypatch.setenv(COOKIES_ENV, str(tmp_path))
        assert cookies_file() is None


class TestCookiesReachTheBinary:
    """
    Проверяется именно командная строка: файл, который лежит, но не доехал до
    yt-dlp, лечит ровно ничего, а увидеть это можно только здесь — настоящий
    запуск бинарника в тестах не делается.
    """

    def _spy(self, monkeypatch):
        captured = {}

        class Completed:
            returncode = 0
            stdout = b"{}"
            stderr = b""

        def fake_run(args, **kwargs):
            captured["args"] = args
            return Completed()

        import subprocess

        monkeypatch.setattr(subprocess, "run", fake_run)
        return captured

    def test_cookies_are_passed_when_the_file_exists(self, tmp_path, monkeypatch):
        cookies = tmp_path / "cookies.txt"
        cookies.write_text("# Netscape HTTP Cookie File")
        monkeypatch.setenv(COOKIES_ENV, str(cookies))
        monkeypatch.setenv("WIREON_YTDLP_PATH", "yt-dlp")
        captured = self._spy(monkeypatch)

        _extract_with_ytdlp("https://www.youtube.com/watch?v=" + VIDEO_ID, {})

        args = captured["args"]
        assert "--cookies" in args
        assert args[args.index("--cookies") + 1] == str(cookies)

    def test_without_cookies_the_flag_is_absent(self, tmp_path, monkeypatch):
        monkeypatch.setenv(COOKIES_ENV, str(tmp_path / "нет.txt"))
        monkeypatch.setenv("WIREON_YTDLP_PATH", "yt-dlp")
        captured = self._spy(monkeypatch)

        _extract_with_ytdlp("https://www.youtube.com/watch?v=" + VIDEO_ID, {})

        assert "--cookies" not in captured["args"]


class TestJsRuntime:
    """
    Движок JS ищется рядом с сервером, а не в PATH.

    Это не перестраховка: в контейнере PATH пуст, а найденный неизвестно где
    `node` неизвестной версии превращается в отказ на середине трека вместо
    честного отказа при запуске.
    """

    def test_nothing_next_to_the_server_means_no_runtime(self, tmp_path, monkeypatch):
        monkeypatch.delenv(JS_RUNTIME_ENV, raising=False)
        assert js_runtime(str(tmp_path)) is None

    def test_deno_next_to_the_server_is_found(self, tmp_path, monkeypatch):
        monkeypatch.delenv(JS_RUNTIME_ENV, raising=False)
        binary = tmp_path / "deno"
        binary.write_text("не настоящий, но файл")
        assert js_runtime(str(tmp_path)) == f"deno:{binary}"

    def test_quickjs_is_looked_for_under_its_real_file_name(self, tmp_path, monkeypatch):
        # Движок зовётся quickjs, а файл — qjs. Искать файл «quickjs» значило бы
        # не найти его никогда.
        monkeypatch.delenv(JS_RUNTIME_ENV, raising=False)
        binary = tmp_path / "qjs"
        binary.write_text("x")
        assert js_runtime(str(tmp_path)) == f"quickjs:{binary}"

    def test_quickjs_wins_over_deno_when_both_lie_there(self, tmp_path, monkeypatch):
        # Замерено на контейнере: deno там убивают сигналом 9, памяти не хватает.
        monkeypatch.delenv(JS_RUNTIME_ENV, raising=False)
        (tmp_path / "deno").write_text("x")
        (tmp_path / "qjs").write_text("x")
        assert js_runtime(str(tmp_path)).startswith("quickjs:")

    def test_environment_may_name_the_runtime_outright(self, tmp_path, monkeypatch):
        monkeypatch.setenv(JS_RUNTIME_ENV, "deno:/opt/deno")
        assert js_runtime(str(tmp_path)) == "deno:/opt/deno"

    def test_environment_with_a_bare_path_gets_a_name(self, tmp_path, monkeypatch):
        binary = tmp_path / "node"
        binary.write_text("x")
        monkeypatch.setenv(JS_RUNTIME_ENV, str(binary))
        assert js_runtime() == f"node:{binary}"

    def test_directory_is_not_a_runtime(self, tmp_path, monkeypatch):
        monkeypatch.delenv(JS_RUNTIME_ENV, raising=False)
        (tmp_path / "deno").mkdir()
        assert js_runtime(str(tmp_path)) is None


class TestJsRuntimeReachesTheBinary:
    def _spy(self, monkeypatch):
        captured = {}

        class Completed:
            returncode = 0
            stdout = b"{}"
            stderr = b""

        def fake_run(args, **kwargs):
            captured["args"] = args
            return Completed()

        import subprocess

        monkeypatch.setattr(subprocess, "run", fake_run)
        return captured

    def test_runtime_is_passed_when_it_exists(self, tmp_path, monkeypatch):
        monkeypatch.setenv(JS_RUNTIME_ENV, "deno:/home/container/deno")
        monkeypatch.setenv("WIREON_YTDLP_PATH", "yt-dlp")
        monkeypatch.setenv(COOKIES_ENV, str(tmp_path / "нет.txt"))
        captured = self._spy(monkeypatch)

        _extract_with_ytdlp("https://www.youtube.com/watch?v=" + VIDEO_ID, {})

        args = captured["args"]
        assert "--js-runtimes" in args
        assert args[args.index("--js-runtimes") + 1] == "deno:/home/container/deno"

    def test_without_a_runtime_the_flag_is_absent(self, tmp_path, monkeypatch):
        monkeypatch.delenv(JS_RUNTIME_ENV, raising=False)
        monkeypatch.setenv("WIREON_YTDLP_PATH", "yt-dlp")
        monkeypatch.setenv(COOKIES_ENV, str(tmp_path / "нет.txt"))
        monkeypatch.chdir(tmp_path)
        captured = self._spy(monkeypatch)

        _extract_with_ytdlp("https://www.youtube.com/watch?v=" + VIDEO_ID, {})

        assert "--js-runtimes" not in captured["args"]


class TestStoryboardIsNotAudio:
    """
    Раскадровка объявляет `vcodec: none` — как настоящая аудиодорожка. Пока это
    не отсекалось, ответ «Only images are available» превращался в удачный
    резолв, и человек получал тишину вместо отказа.
    """

    def test_storyboard_alone_is_not_a_stream(self):
        board = {
            "url": "https://i.ytimg.com/sb/x/storyboard3_L2/M0.jpg",
            "ext": "mhtml",
            "acodec": "none",
            "vcodec": "none",
            "format_id": "sb0",
        }
        assert pick_audio_format(info_with(board)) is None

    def test_real_audio_still_wins_when_a_storyboard_is_alongside(self):
        board = {"url": "https://i.ytimg.com/sb/x/M0.jpg", "ext": "mhtml",
                 "acodec": "none", "vcodec": "none"}
        picked = pick_audio_format(info_with(board, audio_format()))
        assert picked is not None
        assert picked[0]["ext"] == "m4a"

    def test_video_without_sound_is_not_a_fallback(self):
        # Дорожка без звука играбельна ровно в том смысле, в каком играбельна
        # тишина: слушателю она не даёт ничего, а трафик тратит.
        mute = {"url": "https://rr1---sn-x.googlevideo.com/videoplayback?x=1",
                "ext": "mp4", "acodec": "none", "vcodec": "avc1.64001f"}
        assert pick_audio_format(info_with(mute)) is None

    def test_missing_codec_fields_are_not_treated_as_silence(self):
        # Часть клиентов кодеки не пишет вовсе. Считать это отсутствием звука
        # значило бы выбрасывать рабочие ссылки.
        vague = {"url": "https://rr1---sn-x.googlevideo.com/videoplayback?x=1", "ext": "m4a"}
        picked = pick_audio_format(info_with(vague))
        assert picked is not None


class TestLadderFollowsCookies:
    def test_without_cookies_the_old_ladder_stands(self):
        assert attempts_for(False) is RESOLVE_ATTEMPTS

    def test_with_cookies_only_the_clients_that_accept_them(self):
        assert attempts_for(True) is RESOLVE_ATTEMPTS_WITH_COOKIES

    def test_cookie_ladder_holds_no_client_known_to_refuse_cookies(self):
        # Замер 2026-08-28: visionos yt-dlp пропускает сам («does not support
        # cookies»), tv и tv_downgraded отвечают «The page needs to be reloaded».
        # Каждая такая ступень — это лишние секунды ожидания на каждый трек.
        refuses = {"visionos", "tv", "tv_downgraded", "web_safari", "mweb"}
        assert not {a.client for a in RESOLVE_ATTEMPTS_WITH_COOKIES} & refuses

    def test_cookie_ladder_is_shorter_than_the_anonymous_one(self):
        assert len(RESOLVE_ATTEMPTS_WITH_COOKIES) < len(RESOLVE_ATTEMPTS)


class TestTempDirIsOurs:
    """
    Распаковка бинарника уводится из общего `/tmp` в свой каталог.

    Поймано 2026-08-28 на живом сервере через консоль WebView: сервер отвечал
    502 на каждый трек с `[PYI-120:ERROR] Failed to extract ...: decompression
    resulted in return code -1`, при том что размер бинарника был байт в байт
    верным. Место кончалось не на диске, а в tmpfs — его добивали каталоги
    `_MEI...`, оставленные попытками, убитыми по таймауту.
    """

    def test_binary_gets_our_tmpdir(self, tmp_path, monkeypatch):
        monkeypatch.setenv("WIREON_YTDLP_TMP", str(tmp_path / "unpack"))
        env = ytdlp_env()
        assert env["TMPDIR"] == str(tmp_path / "unpack")
        # PyInstaller читает `TMPDIR`, часть библиотек — `TMP` и `TEMP`.
        # Разойтись им нельзя, иначе распаковка снова уедет в общий каталог.
        assert env["TMP"] == env["TMPDIR"] == env["TEMP"]

    def test_the_directory_is_created(self, tmp_path, monkeypatch):
        target = tmp_path / "unpack"
        monkeypatch.setenv("WIREON_YTDLP_TMP", str(target))
        assert ytdlp_temp_dir().is_dir()

    def test_abandoned_unpacks_are_swept(self, tmp_path, monkeypatch):
        monkeypatch.setenv("WIREON_YTDLP_TMP", str(tmp_path))
        stale = tmp_path / "_MEI12345"
        stale.mkdir()
        (stale / "big.so").write_bytes(b"x" * 32)

        # Возраст берём от «сейчас», а не трогаем часы файловой системы.
        assert sweep_ytdlp_temp(now=stale.stat().st_mtime + STALE_TEMP_AGE_S + 1) == 1
        assert not stale.exists()

    def test_a_running_unpack_is_left_alone(self, tmp_path, monkeypatch):
        # Подмести каталог работающей попытки — значит сломать её на ровном
        # месте. Отличить её от брошенной можно только по времени.
        monkeypatch.setenv("WIREON_YTDLP_TMP", str(tmp_path))
        fresh = tmp_path / "_MEI99999"
        fresh.mkdir()

        assert sweep_ytdlp_temp(now=fresh.stat().st_mtime + 1) == 0
        assert fresh.exists()

    def test_foreign_files_are_never_touched(self, tmp_path, monkeypatch):
        monkeypatch.setenv("WIREON_YTDLP_TMP", str(tmp_path))
        cookies = tmp_path / "yt-cookies.txt"
        cookies.write_text("не наше", encoding="utf-8")
        other = tmp_path / "somedir"
        other.mkdir()

        sweep_ytdlp_temp(now=cookies.stat().st_mtime + 10_000)

        assert cookies.exists()
        assert other.exists()
