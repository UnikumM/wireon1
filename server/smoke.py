"""
Живая проверка сервера: поднимает его в этом процессе и стучится по всем ручкам.

Отличается от тестов тем, что здесь настоящая сеть. Запускается вручную и
осмысленно двумя способами:

    python smoke.py            # без сети к YouTube: ручки, авторизация, брокер
    python smoke.py --online    # плюс настоящий resolve и radio одного трека

`--online` нужен только для того, чтобы один раз убедиться: с адреса этой
машины YouTube отдаёт ссылку. С сервера ответ может быть другим — там один IP на
всех слушателей, и проверка «вы не робот» приходит раньше.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import sys

import aiohttp

from wireon_music import mqtt
from wireon_music.app import create_app

# Заведомо живой и не возрастной трек с музыкой: Rick Astley, Never Gonna Give
# You Up. Взят не ради шутки — у него самая долгая история доступности из всего,
# что можно назвать по памяти.
ONLINE_VIDEO_ID = "dQw4w9WgXcQ"

PORT = 25998


def connect_frame(client_id: str, keep_alive: int = 30) -> bytes:
    body = (
        bytes([0x00, 0x04, 0x4D, 0x51, 0x54, 0x54, 0x04, 0x02, (keep_alive >> 8) & 0xFF, keep_alive & 0xFF])
        + len(client_id.encode()).to_bytes(2, "big")
        + client_id.encode()
    )
    return bytes([mqtt.CONNECT << 4]) + mqtt.encode_remaining_length(len(body)) + body


def subscribe_frame(topic: str, packet_id: int) -> bytes:
    raw = topic.encode()
    body = packet_id.to_bytes(2, "big") + len(raw).to_bytes(2, "big") + raw + b"\x00"
    return bytes([(mqtt.SUBSCRIBE << 4) | 0x02]) + mqtt.encode_remaining_length(len(body)) + body


def publish_frame(topic: str, payload: str) -> bytes:
    raw = topic.encode()
    body = len(raw).to_bytes(2, "big") + raw + payload.encode()
    return bytes([mqtt.PUBLISH << 4]) + mqtt.encode_remaining_length(len(body)) + body


class Report:
    def __init__(self) -> None:
        self.failures: list = []

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        mark = "OK  " if ok else "FAIL"
        print(f"[{mark}] {name}{f' — {detail}' if detail else ''}")
        if not ok:
            self.failures.append(name)


async def run(online: bool) -> int:
    token = secrets.token_urlsafe(24)
    app = create_app(token)
    runner = aiohttp.web.AppRunner(app, access_log=None)
    await runner.setup()
    site = aiohttp.web.TCPSite(runner, "127.0.0.1", PORT)
    await site.start()
    base = f"http://127.0.0.1:{PORT}"
    report = Report()

    try:
        async with aiohttp.ClientSession() as session:
            # -- живость без токена ------------------------------------------
            async with session.get(f"{base}/health") as response:
                body = await response.json()
                report.check("health без токена", response.status == 200 and body["ok"] is True)

            # -- закрытость ---------------------------------------------------
            async with session.get(f"{base}/v1/resolve?id={ONLINE_VIDEO_ID}") as response:
                report.check("resolve без токена — 401", response.status == 401, f"HTTP {response.status}")

            async with session.get(
                f"{base}/v1/resolve?id={ONLINE_VIDEO_ID}", headers={"X-Wireon-Token": "wrong"}
            ) as response:
                report.check("resolve с чужим токеном — 401", response.status == 401)

            # -- разбор аргументов -------------------------------------------
            async with session.get(
                f"{base}/v1/resolve?id=nope", headers={"X-Wireon-Token": token}
            ) as response:
                payload = await response.json()
                report.check(
                    "плохой videoId — 404 YT_BAD_ID",
                    response.status == 404 and payload.get("error") == "YT_BAD_ID",
                )

            async with session.get(f"{base}/v1/search?q=", headers={"X-Wireon-Token": token}) as response:
                report.check("пустой запрос поиска — 400", response.status == 400)

            # -- брокер --------------------------------------------------------
            async with session.ws_connect(f"{base}/mqtt?token={token}", protocols=("mqtt",)) as a:
                report.check("WebSocket отвечает подпротоколом mqtt", a.protocol == "mqtt")
                await a.send_bytes(connect_frame("smoke_a"))
                connack = await asyncio.wait_for(a.receive_bytes(), timeout=5)
                report.check("CONNACK принят", connack == mqtt.encode_connack(0), connack.hex())

                async with session.ws_connect(
                    f"{base}/mqtt?token={token}", protocols=("mqtt",)
                ) as b:
                    await b.send_bytes(connect_frame("smoke_b"))
                    await asyncio.wait_for(b.receive_bytes(), timeout=5)
                    await b.send_bytes(subscribe_frame("wireon/room/SMOKE", 1))
                    await asyncio.wait_for(b.receive_bytes(), timeout=5)

                    await a.send_bytes(publish_frame("wireon/room/SMOKE", '{"type":"play"}'))
                    delivered = await asyncio.wait_for(b.receive_bytes(), timeout=5)
                    packets, _ = mqtt.decode_packets(delivered)
                    report.check(
                        "сообщение доехало из одного сокета в другой",
                        bool(packets) and packets[0].payload == b'{"type":"play"}',
                    )

            async with session.get(f"{base}/health") as response:
                body = await response.json()
                report.check(
                    "закрытые сокеты не остались в брокере",
                    body["broker"]["clients"] == 0,
                    f"clients={body['broker']['clients']}",
                )

            # -- настоящая сеть -----------------------------------------------
            if online:
                async with session.get(
                    f"{base}/v1/resolve?id={ONLINE_VIDEO_ID}",
                    headers={"X-Wireon-Token": token},
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as response:
                    payload = await response.json()
                    ok = response.status == 200 and payload.get("streamUrl", "").startswith("http")
                    size = len(json.dumps(payload).encode())
                    report.check(
                        "resolve отдал настоящую ссылку",
                        ok,
                        f"HTTP {response.status}, {size} байт, {payload.get('format')} "
                        f"{payload.get('bitrate')}kbps"
                        if ok
                        else json.dumps(payload, ensure_ascii=False)[:200],
                    )

                async with session.get(
                    f"{base}/v1/radio?id={ONLINE_VIDEO_ID}",
                    headers={"X-Wireon-Token": token},
                    timeout=aiohttp.ClientTimeout(total=60),
                ) as response:
                    from wireon_music.innertube import queue_length

                    payload = await response.json() if response.status == 200 else {}
                    count = queue_length(payload)
                    report.check(
                        "radio отдал очередь длиннее одного трека",
                        response.status == 200 and count > 1,
                        f"HTTP {response.status}, треков: {count}",
                    )

                async with session.get(
                    f"{base}/v1/search?q=phonk",
                    headers={"X-Wireon-Token": token},
                    timeout=aiohttp.ClientTimeout(total=60),
                ) as response:
                    payload = await response.json() if response.status == 200 else {}
                    report.check(
                        "search ответил разметкой InnerTube",
                        response.status == 200 and "contents" in payload,
                        f"HTTP {response.status}",
                    )
    finally:
        await runner.cleanup()

    print()
    if report.failures:
        print(f"Провалено: {', '.join(report.failures)}")
        return 1
    print("Всё сошлось.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Живая проверка музыкального сервера Wireon")
    parser.add_argument(
        "--online",
        action="store_true",
        help="дополнительно сходить к YouTube за настоящей ссылкой, радио и поиском",
    )
    args = parser.parse_args()
    sys.exit(asyncio.run(run(args.online)))


if __name__ == "__main__":
    main()
