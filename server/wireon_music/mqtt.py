"""
Разбор и сборка пакетов MQTT 3.1.1 — ровно та часть протокола, которой
пользуется `src/services/mqttClient.ts`.

Почему свой кодек, а не библиотека. Клиент в приложении написан вручную и
намеренно неполон: QoS только 0, ни логина с паролем, ни свойств MQTT 5.
Готовый брокер (mosquitto, emqx) пришлось бы ставить в контейнер, где живёт
python-egg без прав root, и он всё равно принёс бы с собой ворох настроек,
которые нам не нужны. Здесь ~200 строк, и каждая проверяется тестом против
байтов, которые действительно шлёт клиент.

Формат разбирается по спецификации OASIS MQTT 3.1.1, но с одной оговоркой,
за которую и написан этот файл: клиент отправляет PUBLISH с QoS 0 и флагом
retain в младшем бите, а SUBSCRIBE — с фиксированными флагами 0x02. Разбор
обязан совпадать с той стороной байт в байт, иначе брокер молча роняет
соединение — это ровно то, на чём Group Listen сломался в прошлый раз.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

# Типы пакетов — старшие 4 бита фиксированного заголовка.
CONNECT = 1
CONNACK = 2
PUBLISH = 3
PUBACK = 4
SUBSCRIBE = 8
SUBACK = 9
UNSUBSCRIBE = 10
UNSUBACK = 11
PINGREQ = 12
PINGRESP = 13
DISCONNECT = 14

# Коды ответа CONNACK. Клиент знает их все и показывает человеку фразой.
CONNACK_ACCEPTED = 0
CONNACK_BAD_PROTOCOL = 1
CONNACK_ID_REJECTED = 2
CONNACK_UNAVAILABLE = 3
CONNACK_BAD_CREDENTIALS = 4
CONNACK_NOT_AUTHORIZED = 5

MAX_REMAINING_LENGTH = 268_435_455


class MqttProtocolError(Exception):
    """Поток не разобрать. Пересинхронизировать нельзя — только закрыть."""


@dataclass
class Will:
    topic: str
    payload: bytes
    retain: bool = False
    qos: int = 0


@dataclass
class ConnectPacket:
    client_id: str
    keep_alive: int
    clean_session: bool
    protocol_level: int
    protocol_name: str
    will: Optional[Will] = None
    username: Optional[str] = None
    password: Optional[bytes] = None

    # `type` есть у каждого разобранного пакета, чтобы вызывающий мог
    # отфильтровать поток по типу, не перебирая isinstance по всем классам.
    type: int = field(default=CONNECT, init=False)


@dataclass
class PublishPacket:
    topic: str
    payload: bytes
    qos: int = 0
    retain: bool = False
    packet_id: Optional[int] = None

    type: int = field(default=PUBLISH, init=False)


@dataclass
class SubscribePacket:
    packet_id: int
    # (топик, запрошенный QoS) — QoS запоминается, чтобы SUBACK отвечал честно.
    topics: List[Tuple[str, int]] = field(default_factory=list)

    type: int = field(default=SUBSCRIBE, init=False)


@dataclass
class UnsubscribePacket:
    packet_id: int
    topics: List[str] = field(default_factory=list)

    type: int = field(default=UNSUBSCRIBE, init=False)


@dataclass
class SimplePacket:
    """PINGREQ, PINGRESP, DISCONNECT — тело пустое, важен только тип."""

    type: int


Packet = object


# ---------------------------------------------------------------------------
# Примитивы
# ---------------------------------------------------------------------------


def encode_remaining_length(value: int) -> bytes:
    """7 бит на байт, старший бит продолжает. Максимум 4 байта."""
    if value < 0 or value > MAX_REMAINING_LENGTH:
        raise ValueError(f"remaining length out of range: {value}")
    out = bytearray()
    remaining = value
    while True:
        byte = remaining % 128
        remaining //= 128
        if remaining > 0:
            byte |= 0x80
        out.append(byte)
        if remaining == 0:
            break
    return bytes(out)


def decode_remaining_length(data: bytes, offset: int) -> Optional[Tuple[int, int]]:
    """
    Возвращает (значение, сколько байт прочитано) либо None.

    None — это «варинт ещё не весь пришёл», обычное дело на границе кадра, а не
    ошибка. Пятый байт — уже ошибка: длиннее варинта в этом протоколе нет.
    """
    value = 0
    multiplier = 1
    for index in range(4):
        if offset + index >= len(data):
            return None
        byte = data[offset + index]
        value += (byte & 0x7F) * multiplier
        if byte & 0x80 == 0:
            return value, index + 1
        multiplier *= 128
    raise MqttProtocolError("remaining length exceeds four bytes")


def _read_string(body: bytes, offset: int) -> Tuple[str, int]:
    if offset + 2 > len(body):
        raise MqttProtocolError("truncated string length")
    length = (body[offset] << 8) | body[offset + 1]
    start = offset + 2
    end = start + length
    if end > len(body):
        raise MqttProtocolError("truncated string body")
    # errors="replace": испорченная кодировка не повод рвать соединение,
    # тему всё равно сравнивают на точное совпадение и она не совпадёт.
    return body[start:end].decode("utf-8", errors="replace"), end


def _read_bytes(body: bytes, offset: int) -> Tuple[bytes, int]:
    if offset + 2 > len(body):
        raise MqttProtocolError("truncated binary length")
    length = (body[offset] << 8) | body[offset + 1]
    start = offset + 2
    end = start + length
    if end > len(body):
        raise MqttProtocolError("truncated binary body")
    return body[start:end], end


def _mqtt_string(text: str) -> bytes:
    raw = text.encode("utf-8")
    if len(raw) > 0xFFFF:
        raise ValueError(f"MQTT string too long: {len(raw)} bytes")
    return bytes([(len(raw) >> 8) & 0xFF, len(raw) & 0xFF]) + raw


def _build(packet_type: int, flags: int, body: bytes) -> bytes:
    head = bytes([((packet_type << 4) | flags) & 0xFF])
    return head + encode_remaining_length(len(body)) + body


# ---------------------------------------------------------------------------
# Сборка (то, что брокер отправляет)
# ---------------------------------------------------------------------------


def encode_connack(return_code: int, session_present: bool = False) -> bytes:
    return _build(CONNACK, 0, bytes([0x01 if session_present else 0x00, return_code]))


def encode_publish(topic: str, payload: bytes, retain: bool = False) -> bytes:
    """
    Только QoS 0: потерянное обновление позиции заменяется следующим через
    полсекунды, и клиент всё равно не подтверждает доставку.
    """
    flags = 0x01 if retain else 0x00
    return _build(PUBLISH, flags, _mqtt_string(topic) + payload)


def encode_suback(packet_id: int, granted: List[int]) -> bytes:
    body = bytes([(packet_id >> 8) & 0xFF, packet_id & 0xFF]) + bytes(granted)
    return _build(SUBACK, 0, body)


def encode_unsuback(packet_id: int) -> bytes:
    return _build(UNSUBACK, 0, bytes([(packet_id >> 8) & 0xFF, packet_id & 0xFF]))


def encode_pingresp() -> bytes:
    return _build(PINGRESP, 0, b"")


# ---------------------------------------------------------------------------
# Разбор (то, что брокер получает)
# ---------------------------------------------------------------------------


def _parse_connect(body: bytes) -> ConnectPacket:
    protocol_name, offset = _read_string(body, 0)
    if offset >= len(body):
        raise MqttProtocolError("CONNECT without protocol level")
    protocol_level = body[offset]
    offset += 1
    if offset >= len(body):
        raise MqttProtocolError("CONNECT without connect flags")
    flags = body[offset]
    offset += 1
    if offset + 2 > len(body):
        raise MqttProtocolError("CONNECT without keep alive")
    keep_alive = (body[offset] << 8) | body[offset + 1]
    offset += 2

    client_id, offset = _read_string(body, offset)

    will: Optional[Will] = None
    if flags & 0x04:
        will_topic, offset = _read_string(body, offset)
        will_payload, offset = _read_bytes(body, offset)
        will = Will(
            topic=will_topic,
            payload=will_payload,
            retain=bool(flags & 0x20),
            qos=(flags >> 3) & 0x03,
        )

    username: Optional[str] = None
    password: Optional[bytes] = None
    if flags & 0x80:
        username, offset = _read_string(body, offset)
    if flags & 0x40:
        password, offset = _read_bytes(body, offset)

    return ConnectPacket(
        client_id=client_id,
        keep_alive=keep_alive,
        clean_session=bool(flags & 0x02),
        protocol_level=protocol_level,
        protocol_name=protocol_name,
        will=will,
        username=username,
        password=password,
    )


def _parse_publish(header: int, body: bytes) -> PublishPacket:
    qos = (header >> 1) & 0x03
    retain = bool(header & 0x01)
    topic, offset = _read_string(body, 0)
    packet_id: Optional[int] = None
    if qos > 0:
        if offset + 2 > len(body):
            raise MqttProtocolError("PUBLISH with QoS but no packet id")
        packet_id = (body[offset] << 8) | body[offset + 1]
        offset += 2
    return PublishPacket(
        topic=topic,
        payload=body[offset:],
        qos=qos,
        retain=retain,
        packet_id=packet_id,
    )


def _parse_subscribe(body: bytes) -> SubscribePacket:
    if len(body) < 2:
        raise MqttProtocolError("SUBSCRIBE without packet id")
    packet_id = (body[0] << 8) | body[1]
    offset = 2
    topics: List[Tuple[str, int]] = []
    while offset < len(body):
        topic, offset = _read_string(body, offset)
        if offset >= len(body):
            raise MqttProtocolError("SUBSCRIBE topic without QoS byte")
        topics.append((topic, body[offset] & 0x03))
        offset += 1
    if not topics:
        raise MqttProtocolError("SUBSCRIBE without topics")
    return SubscribePacket(packet_id=packet_id, topics=topics)


def _parse_unsubscribe(body: bytes) -> UnsubscribePacket:
    if len(body) < 2:
        raise MqttProtocolError("UNSUBSCRIBE without packet id")
    packet_id = (body[0] << 8) | body[1]
    offset = 2
    topics: List[str] = []
    while offset < len(body):
        topic, offset = _read_string(body, offset)
        topics.append(topic)
    return UnsubscribePacket(packet_id=packet_id, topics=topics)


def decode_packets(buffer: bytes) -> Tuple[List[Packet], bytes]:
    """
    Разбирает все целые пакеты и возвращает неразобранный хвост.

    Граница кадра WebSocket не имеет отношения к границе пакета: в одном кадре
    может лежать три пакета, а может половина одного. Хвост возвращается
    вызывающему, чтобы дописать к нему следующий кадр.
    """
    packets: List[Packet] = []
    offset = 0

    while offset < len(buffer):
        header = buffer[offset]
        length = decode_remaining_length(buffer, offset + 1)
        if length is None:
            break
        value, read = length
        body_start = offset + 1 + read
        body_end = body_start + value
        if body_end > len(buffer):
            break

        packet_type = header >> 4
        body = buffer[body_start:body_end]

        if packet_type == CONNECT:
            packets.append(_parse_connect(body))
        elif packet_type == PUBLISH:
            packets.append(_parse_publish(header, body))
        elif packet_type == SUBSCRIBE:
            packets.append(_parse_subscribe(body))
        elif packet_type == UNSUBSCRIBE:
            packets.append(_parse_unsubscribe(body))
        elif packet_type in (PINGREQ, DISCONNECT):
            packets.append(SimplePacket(type=packet_type))
        else:
            # Неизвестный или неподдержанный тип — не повод рвать связь.
            # Клиент не шлёт QoS 1/2, а если появится другой клиент, пусть
            # его PUBACK просто пройдёт мимо.
            packets.append(SimplePacket(type=packet_type))

        offset = body_end

    return packets, buffer[offset:]


def topic_matches(filter_: str, topic: str) -> bool:
    """
    Совпадение темы с фильтром, включая `+` и `#`.

    Приложение подписывается только на точную тему `wireon/room/<код>`, но
    фильтры реализованы полностью: без них любой другой клиент (mqtt.js в
    браузере, mosquitto_sub при отладке) получил бы тишину вместо сообщений и
    решил, что брокер сломан.
    """
    if filter_ == topic:
        return True
    filter_parts = filter_.split("/")
    topic_parts = topic.split("/")

    for index, part in enumerate(filter_parts):
        if part == "#":
            # `#` обязан быть последним и покрывает остаток, но не тему,
            # начинающуюся с `$` — таких у нас нет, проверка на всякий случай.
            if index == 0 and topic_parts and topic_parts[0].startswith("$"):
                return False
            return True
        if index >= len(topic_parts):
            return False
        if part == "+":
            if index == 0 and topic_parts[0].startswith("$"):
                return False
            continue
        if part != topic_parts[index]:
            return False

    return len(filter_parts) == len(topic_parts)
