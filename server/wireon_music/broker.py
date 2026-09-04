"""
MQTT-брокер поверх WebSocket — ровно столько протокола, сколько нужно комнате
«слушать вместе».

Зачем он вообще. До этого Group Listen ездил на публичных брокерах
(`broker.emqx.io`, `broker.hivemq.com`, `test.mosquitto.org`). Они живы, но
общие: режут соединения по своим лимитам и молча глотают сообщения, поэтому
синхронизация то работает, то нет — а человеку это видно как «слушать вместе
не синхронизируется». Свой брокер закрывает пункт насовсем.

Чего здесь нет и почему:
- QoS 1 и 2. Клиент их не шлёт, а потерянное обновление позиции заменяется
  следующим через полсекунды. Подтверждения хранили бы состояние, которое в
  комнате на четыре человека никому не нужно.
- Сессии между подключениями. Клиент всегда ставит clean session.
- Логин с паролем. Секрет здесь — код комнаты, ровно как при отправке ссылки.
  Ограничение доступа — на уровне HTTP-токена в `music_server.py`.

Что есть, потому что без этого комната ломается:
- retain на тему: присоединившийся получает последний снимок хоста сразу, а не
  через полсекунды ожидания. Пустая retain-полезная нагрузка удаляет снимок —
  так MQTT стирает retained-сообщение, и клиент на это рассчитывает.
- last will: упавший участник (закрыли крышку ноутбука) сам «ушёл» не скажет,
  за него это делает брокер.
- keepalive с запасом: молчание дольше полутора периодов — это мёртвый сокет,
  открытый только с нашей стороны.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from . import mqtt

logger = logging.getLogger("wireon.broker")

# Верхний предел на комнату и на брокер. Комната «слушать вместе» — это
# несколько друзей, а не стадион; предел защищает контейнер с 500 МБ памяти от
# случайного цикла переподключений, а не пользователей друг от друга.
MAX_CLIENTS = 200
MAX_SUBSCRIPTIONS_PER_CLIENT = 16
MAX_PAYLOAD_BYTES = 64 * 1024
MAX_BUFFER_BYTES = 256 * 1024

# Сколько ждать CONNECT после открытия сокета. Тот, кто молчит, — не клиент.
CONNECT_TIMEOUT_S = 10.0

# Во сколько раз keepalive от клиента можно превысить, прежде чем считать его
# мёртвым. 1.5 — то же число, что в `mqttClient.ts`, и это не совпадение:
# обе стороны должны сдаваться примерно одновременно.
KEEPALIVE_GRACE = 1.5

# Клиент присылает keepalive 30 с; ноль означает «не проверяй», но брошенные
# сокеты тогда копятся вечно, поэтому у нуля есть свой предел.
DEFAULT_KEEPALIVE_S = 60


@dataclass
class BrokerClient:
    """Одно соединение. `send` — то, куда уходят байты (сокет или тест)."""

    client_id: str
    send: "asyncio.Queue[bytes]"
    subscriptions: Set[str] = field(default_factory=set)
    will: Optional[mqtt.Will] = None
    keep_alive: int = DEFAULT_KEEPALIVE_S
    last_seen: float = field(default_factory=time.monotonic)
    connected: bool = False


class Broker:
    """
    Состояние брокера: кто подключён, кто на что подписан, что удержано.

    Отдельно от транспорта нарочно: тесты гоняют его напрямую очередями, без
    WebSocket, поэтому проверяется поведение протокола, а не aiohttp.
    """

    def __init__(self) -> None:
        self.clients: Dict[str, BrokerClient] = {}
        self.retained: Dict[str, bytes] = {}
        self._published = 0

    # -- учёт клиентов -----------------------------------------------------

    def register(self, client: BrokerClient) -> int:
        """
        Принимает клиента. Возвращает код CONNACK.

        Совпадение client_id по спецификации выгоняет прежнего владельца.
        Клиент приложения добавляет к идентификатору случайный хвост, так что
        до этого доходит либо чужой софт, либо переподключение после обрыва,
        который мы ещё не заметили, — и в обоих случаях выгнать старого
        правильно: иначе живой участник остался бы с мёртвым сокетом.
        """
        if len(self.clients) >= MAX_CLIENTS and client.client_id not in self.clients:
            return mqtt.CONNACK_UNAVAILABLE

        existing = self.clients.get(client.client_id)
        if existing is not None:
            logger.info("client id %s reconnected, evicting the previous socket", client.client_id)
            existing.connected = False
            self._drain_will(existing, send_will=False)
            existing.send.put_nowait(b"")  # закрывает писателя

        client.connected = True
        client.last_seen = time.monotonic()
        self.clients[client.client_id] = client
        return mqtt.CONNACK_ACCEPTED

    def disconnect(self, client: BrokerClient, *, graceful: bool) -> None:
        """
        Убирает клиента. `graceful` — пришёл DISCONNECT.

        Разница ровно в last will: штатный уход подавляет его (человек нажал
        «выйти» и уже сказал об этом сам), обрыв — публикует, иначе упавший
        участник навсегда останется в списке присутствующих.
        """
        if self.clients.get(client.client_id) is client:
            del self.clients[client.client_id]
        client.connected = False
        self._drain_will(client, send_will=not graceful)

    def _drain_will(self, client: BrokerClient, *, send_will: bool) -> None:
        will = client.will
        client.will = None
        if will is None or not send_will:
            return
        logger.info("publishing last will of %s to %s", client.client_id, will.topic)
        self.publish(will.topic, will.payload, retain=will.retain, exclude=client.client_id)

    # -- протокол ----------------------------------------------------------

    def subscribe(self, client: BrokerClient, topics: List[tuple]) -> List[int]:
        """
        Подписывает и сразу отдаёт удержанные сообщения по каждому фильтру.

        Отдать retained именно здесь, а не при следующей публикации, —
        единственный способ, которым присоединившийся узнаёт позицию хоста
        раньше, чем хост пришлёт очередное обновление.
        """
        granted: List[int] = []
        for topic, _qos in topics:
            if len(client.subscriptions) >= MAX_SUBSCRIPTIONS_PER_CLIENT:
                granted.append(0x80)  # отказ по этому фильтру
                continue
            client.subscriptions.add(topic)
            granted.append(0)
            for retained_topic, payload in self.retained.items():
                if mqtt.topic_matches(topic, retained_topic):
                    self._deliver(client, retained_topic, payload, retain=True)
        return granted

    def unsubscribe(self, client: BrokerClient, topics: List[str]) -> None:
        for topic in topics:
            client.subscriptions.discard(topic)

    def publish(
        self,
        topic: str,
        payload: bytes,
        *,
        retain: bool = False,
        exclude: Optional[str] = None,
    ) -> int:
        """
        Раздаёт сообщение подписчикам. Возвращает число доставок.

        Отправитель исключается по идентификатору: своё же сообщение вернулось
        бы ему эхом, и хотя клиент отбрасывает повторы по `id`, лишний круг
        тратит трафик телефона.
        """
        if retain:
            # Пустая полезная нагрузка удаляет удержанное — так в MQTT
            # стирается retained-сообщение, и `groupListenService` этим
            # пользуется, закрывая комнату.
            if payload:
                self.retained[topic] = payload
            else:
                self.retained.pop(topic, None)

        delivered = 0
        for client in list(self.clients.values()):
            if client.client_id == exclude or not client.connected:
                continue
            if any(mqtt.topic_matches(f, topic) for f in client.subscriptions):
                self._deliver(client, topic, payload, retain=False)
                delivered += 1
        self._published += 1
        return delivered

    def _deliver(self, client: BrokerClient, topic: str, payload: bytes, *, retain: bool) -> None:
        try:
            client.send.put_nowait(mqtt.encode_publish(topic, payload, retain=retain))
        except asyncio.QueueFull:
            # Клиент не успевает читать. Рвать соединение честнее, чем расти в
            # памяти: он переподключится и получит удержанный снимок заново.
            logger.warning("send queue full for %s, dropping the connection", client.client_id)
            client.connected = False

    def touch(self, client: BrokerClient) -> None:
        client.last_seen = time.monotonic()

    def expired(self, now: Optional[float] = None) -> List[BrokerClient]:
        """Клиенты, молчащие дольше своего keepalive с запасом."""
        moment = time.monotonic() if now is None else now
        dead: List[BrokerClient] = []
        for client in self.clients.values():
            budget = (client.keep_alive or DEFAULT_KEEPALIVE_S) * KEEPALIVE_GRACE
            if moment - client.last_seen > budget:
                dead.append(client)
        return dead

    @property
    def stats(self) -> dict:
        return {
            "clients": len(self.clients),
            "retained": len(self.retained),
            "published": self._published,
        }


class ConnectionHandler:
    """
    Обслуживает одно соединение: байты внутрь, пакеты наружу.

    Отделено от `Broker`, потому что состояние брокера переживает соединения, а
    буфер и порядок пакетов — нет. Так же выглядит и клиентская сторона.
    """

    def __init__(self, broker: Broker, send_queue: "asyncio.Queue[bytes]") -> None:
        self.broker = broker
        self.send_queue = send_queue
        self.buffer = b""
        self.client: Optional[BrokerClient] = None
        self.closed = False
        self.close_reason: Optional[str] = None

    def feed(self, data: bytes) -> None:
        """Принимает кадр. Всё, что решено, уходит в очередь отправки."""
        if self.closed:
            return
        self.buffer += data
        if len(self.buffer) > MAX_BUFFER_BYTES:
            self._close("buffer overflow")
            return
        try:
            packets, self.buffer = mqtt.decode_packets(self.buffer)
        except mqtt.MqttProtocolError as exc:
            # Поток не пересинхронизировать: где начинается следующий пакет,
            # уже неизвестно. Клиент переподключится с чистого места.
            self._close(f"protocol error: {exc}")
            return

        for packet in packets:
            self._handle(packet)
            if self.closed:
                return

    def _handle(self, packet: object) -> None:
        if isinstance(packet, mqtt.ConnectPacket):
            self._handle_connect(packet)
            return

        if self.client is None or not self.client.connected:
            # Всё до CONNECT — не наш клиент. Спецификация велит закрыть.
            self._close("packet before CONNECT")
            return

        self.broker.touch(self.client)

        if isinstance(packet, mqtt.PublishPacket):
            if len(packet.payload) > MAX_PAYLOAD_BYTES:
                self._close("payload too large")
                return
            self.broker.publish(
                packet.topic,
                packet.payload,
                retain=packet.retain,
                exclude=self.client.client_id,
            )
        elif isinstance(packet, mqtt.SubscribePacket):
            granted = self.broker.subscribe(self.client, packet.topics)
            self.send_queue.put_nowait(mqtt.encode_suback(packet.packet_id, granted))
        elif isinstance(packet, mqtt.UnsubscribePacket):
            self.broker.unsubscribe(self.client, packet.topics)
            self.send_queue.put_nowait(mqtt.encode_unsuback(packet.packet_id))
        elif isinstance(packet, mqtt.SimplePacket):
            if packet.type == mqtt.PINGREQ:
                self.send_queue.put_nowait(mqtt.encode_pingresp())
            elif packet.type == mqtt.DISCONNECT:
                self._close("client disconnected", graceful=True)

    def _handle_connect(self, packet: mqtt.ConnectPacket) -> None:
        if self.client is not None:
            self._close("second CONNECT on one connection")
            return

        if packet.protocol_name != "MQTT" or packet.protocol_level != 4:
            # Отказ, а не тишина: клиент показывает человеку «брокер не
            # поддерживает эту версию протокола», и это правда.
            self.send_queue.put_nowait(mqtt.encode_connack(mqtt.CONNACK_BAD_PROTOCOL))
            self._close("unsupported protocol level")
            return

        if not packet.client_id:
            self.send_queue.put_nowait(mqtt.encode_connack(mqtt.CONNACK_ID_REJECTED))
            self._close("empty client id")
            return

        client = BrokerClient(
            client_id=packet.client_id,
            send=self.send_queue,
            will=packet.will,
            keep_alive=packet.keep_alive or DEFAULT_KEEPALIVE_S,
        )
        code = self.broker.register(client)
        self.send_queue.put_nowait(mqtt.encode_connack(code))
        if code != mqtt.CONNACK_ACCEPTED:
            self._close(f"connection refused with code {code}")
            return
        self.client = client
        logger.info("client %s connected (keepalive %ss)", client.client_id, client.keep_alive)

    def close(self, reason: str = "closed", *, graceful: bool = False) -> None:
        self._close(reason, graceful=graceful)

    def _close(self, reason: str, *, graceful: bool = False) -> None:
        if self.closed:
            return
        self.closed = True
        self.close_reason = reason
        if self.client is not None:
            self.broker.disconnect(self.client, graceful=graceful)
        # Пустой кадр — договорённость с писателем: пора закрывать сокет.
        self.send_queue.put_nowait(b"")
