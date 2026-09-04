"""
Перелив звука через сервер — запасной путь, когда прямая ссылка не играет.

Основной путь остался прежним и остаётся предпочтительным: телефон добывает
ссылку сам (`youtubeOnDevice.ts`) и качает звук напрямую с `googlevideo`, мимо
нас. Через контейнер тогда идёт ноль байт музыки, и канал, на котором живут VPN
и боты, никто не занимает.

Но у части треков этот путь заканчивается ничем: YouTube отвечает телефону
SABR-ответом без пригодной ссылки. Тогда телефон берёт ссылку у нас — и она
подписана вместе с нашим адресом (`ip=` внутри). Иногда такая ссылка с чужого
адреса всё равно открывается (проверено 2026-08-28), иногда отвечает 403;
телефон это выясняет запросом на два байта, а не гаданием. Когда не открылась,
выбор простой: либо трек не играет вовсе, либо байты идут через нас. Этот файл
— второе, и только для таких треков.

Четыре решения, от которых зависит, переживёт ли это контейнер на 500 МБ.

- **Чанками, никогда целиком.** Трек в памяти — это десятки мегабайт на
  слушателя; здесь через процесс проходит окно в 64 КБ независимо от длины.
- **Без cookies.** Подписанному адресу они не нужны, а вот качать с адреса
  дата-центра сотни часов звука под живым гугл-аккаунтом — ровно тот шаблон,
  за который аккаунт улетает в бан. Cookies остаются только на добыче ссылки,
  и риск не переносится на объём.
- **Свой таймаут.** У `ClientSession` по умолчанию `total=5 минут` на запрос —
  для JSON это щедро, для трека это обрыв на пятой минуте. Здесь общего срока
  нет вовсе, а сторожит простой сокета.
- **Предел одновременных переливов.** Это тот же канал, что у VPN. Лучше
  честный отказ седьмому слушателю, чем всем семерым по трети скорости.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Optional, Tuple

import aiohttp
from aiohttp import web

from .resolver import ResolveError, StreamResolver

logger = logging.getLogger("wireon.proxy")

# Окно, которым байты идут через процесс. 64 КБ — это меньше секунды звука на
# любом битрейте: память не растёт, а системных вызовов всё ещё немного.
CHUNK_SIZE = 64 * 1024

# Столько переливов одновременно. Не про память — про канал: 128 кбит/с на
# слушателя это мелочь, но это та же полоса, по которой ходит VPN.
MAX_CONCURRENT_STREAMS = 6

# Простой сокета, после которого считаем, что раздача умерла. Общего срока
# нет намеренно: он ограничивал бы длину трека, а не живость соединения.
UPSTREAM_TIMEOUT = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=30)

# С чем ходим к `googlevideo`. Обычный браузерный заголовок: yt-dlp'шный на
# раздаче встречается заметно реже и привлекает внимание там, где не нужно.
UPSTREAM_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Что переносим из ответа раздачи. Всё остальное — её внутренние заголовки,
# и пересказывать их клиенту незачем.
FORWARDED_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")

# `bytes=0-1023`, `bytes=5000-`. Несколько диапазонов в одном заголовке не
# поддерживаем: ни один плеер их не шлёт, а ответ на них — multipart, то есть
# втрое больше кода ради никогда не наступающего случая.
RANGE_PATTERN = re.compile(r"^bytes=(\d*)-(\d*)$")

# Сколько раз перевыдаём ссылку, если раздача оборвалась. Один: второй обрыв
# подряд — это не протухшая ссылка, а что-то, что повторами не лечится.
MAX_UPSTREAM_RETRIES = 1


def parse_range(header: Optional[str]) -> Optional[Tuple[int, Optional[int]]]:
    """
    Разбирает `Range` в пару (первый байт, последний включительно или None).

    Возвращает None и на отсутствие заголовка, и на непонятную форму: для нас
    это одно и то же — «отдавай с начала». Отвечать 416 на кривой заголовок
    формально правильнее, но означало бы молчащий плеер вместо играющего.
    """
    if not header:
        return None
    match = RANGE_PATTERN.match(header.strip())
    if not match:
        return None
    raw_start, raw_end = match.group(1), match.group(2)
    if not raw_start:
        # `bytes=-500` — «последние 500 байт». Пересчитать его при перевыдаче
        # ссылки нельзя, не зная длины, поэтому отдаём целиком: проигрывание
        # от этого не ломается, а код остаётся честным.
        return None
    start = int(raw_start)
    end = int(raw_end) if raw_end else None
    if end is not None and end < start:
        return None
    return start, end


def range_header(start: int, end: Optional[int]) -> Optional[str]:
    """Собирает `Range` обратно. None означает «с начала и до конца»."""
    if start <= 0 and end is None:
        return None
    return f"bytes={start}-{'' if end is None else end}"


class ProxyError(Exception):
    """
    Отказ **до** первого байта: заголовки ещё не ушли, поэтому клиенту можно
    отдать код и внятную причину.
    """

    def __init__(self, code: str, detail: str, status: int) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail
        self.status = status


class StreamAborted(Exception):
    """
    Отказ **после** первого байта.

    Отдельным типом, а не общим `ProxyError`, из-за жёсткого свойства HTTP:
    заголовки уже ушли, и второй ответ на тот же запрос отправить нельзя —
    попытка отдать здесь красивый JSON с кодом кончилась бы исключением в
    середине ответа. Остаётся оборвать соединение: плеер услышит это как
    ошибку сети, что и произошло.
    """


async def _open_upstream(
    session: aiohttp.ClientSession, url: str, start: int, end: Optional[int]
) -> aiohttp.ClientResponse:
    headers = {"User-Agent": UPSTREAM_USER_AGENT, "Accept": "*/*"}
    wanted = range_header(start, end)
    if wanted:
        headers["Range"] = wanted
    return await session.get(url, headers=headers, timeout=UPSTREAM_TIMEOUT, allow_redirects=True)


def new_stats() -> dict:
    """
    Счётчики перелива. Не для красоты: по ним видно главное — сколько треков
    пошло через нас вместо прямой ссылки, то есть во что обходится запасной
    путь. Утекают наружу через `/health`, поэтому здесь только числа.
    """
    return {"streams": 0, "bytes": 0, "retries": 0, "busy": 0, "reresolved": 0}


async def stream_audio(
    request: web.Request,
    video_id: str,
    resolver: StreamResolver,
    session: aiohttp.ClientSession,
    gate: asyncio.Semaphore,
    stats: Optional[dict] = None,
) -> web.StreamResponse:
    """
    Переливает звук одного трека, сохраняя перемотку.

    Вынесено из ручки отдельной функцией, чтобы тесты гоняли её с поддельными
    сессией и резолвером: настоящий путь лезет и к YouTube, и к yt-dlp.
    """
    counters = stats if stats is not None else new_stats()

    if gate.locked():
        counters["busy"] += 1
        # Отказ раньше, чем начали качать. Ждать очереди означало бы держать
        # плеер в тишине без объяснений, а так клиент видит причину.
        raise ProxyError(
            "STREAM_BUSY",
            f"одновременных переливов уже {MAX_CONCURRENT_STREAMS}",
            503,
        )

    async with gate:
        resolved = await resolver.resolve(video_id)
        url = resolved.stream_url

        wanted = parse_range(request.headers.get("Range"))
        start, end = wanted if wanted else (0, None)

        upstream = await _open_upstream(session, url, start, end)
        if upstream.status == 403:
            # Ссылка умерла раньше своего `expire` — это единственный отказ,
            # который лечится перевыдачей, и потому единственный, ради
            # которого мы ходим к yt-dlp второй раз.
            upstream.release()
            resolver.invalidate(video_id)
            counters["reresolved"] += 1
            resolved = await resolver.resolve(video_id)
            url = resolved.stream_url
            upstream = await _open_upstream(session, url, start, end)

        if upstream.status >= 400:
            status = upstream.status
            upstream.release()
            raise ProxyError("UPSTREAM_REFUSED", f"раздача ответила {status}", 502)

        response = web.StreamResponse(status=upstream.status)
        for name in FORWARDED_HEADERS:
            value = upstream.headers.get(name)
            if value:
                response.headers[name] = value
        # Перемотка возможна всегда, даже когда раздача об этом промолчала:
        # без этого заголовка `<audio>` считает поток непрокручиваемым и
        # прячет ползунок.
        response.headers.setdefault("Accept-Ranges", "bytes")
        await response.prepare(request)

        counters["streams"] += 1
        sent = 0
        attempts = 0
        while True:
            try:
                async for chunk in upstream.content.iter_chunked(CHUNK_SIZE):
                    await response.write(chunk)
                    sent += len(chunk)
                break
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                upstream.release()
                if attempts >= MAX_UPSTREAM_RETRIES:
                    logger.warning("перелив %s оборвался после %d байт: %s", video_id, sent, exc)
                    response.force_close()
                    raise StreamAborted(f"обрыв раздачи после {sent} байт") from exc
                attempts += 1
                counters["retries"] += 1
                logger.info("перелив %s: переподключение на байте %d (%s)", video_id, start + sent, exc)

                resolver.invalidate(video_id)
                try:
                    resolved = await resolver.resolve(video_id)
                except ResolveError as failure:
                    response.force_close()
                    raise StreamAborted(f"ссылка не перевыдана: {failure.code}") from failure
                upstream = await _open_upstream(session, resolved.stream_url, start + sent, end)

                # Раздача, не понявшая `Range`, начнёт с нуля — и склеенный
                # ответ был бы треком с повтором середины. Такое лучше
                # оборвать: обрыв слышно как ошибку, а повтор — как поломку
                # приложения, которую никто не свяжет с сетью.
                if sent and upstream.status != 206:
                    upstream.release()
                    response.force_close()
                    raise StreamAborted(f"раздача не приняла докачку ({upstream.status})")

        await response.write_eof()
        counters["bytes"] += sent
        logger.info("перелив %s завершён: %d байт", video_id, sent)
        return response
