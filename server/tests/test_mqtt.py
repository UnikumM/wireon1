"""
Проверка кодека MQTT против байтов, которые действительно шлёт клиент.

Ценность этого файла — в первом классе тестов: пакеты собраны здесь той же
логикой, что в `src/services/mqttClient.ts`, поэтому расхождение кодеков
всплывает тут, а не в виде «слушать вместе иногда не работает».
"""

import pytest

from wireon_music import mqtt


# ---------------------------------------------------------------------------
# Вспомогательное: собираем то же, что собирает клиент на TypeScript
# ---------------------------------------------------------------------------


def client_string(text: str) -> bytes:
    raw = text.encode("utf-8")
    return bytes([(len(raw) >> 8) & 0xFF, len(raw) & 0xFF]) + raw


def client_connect(client_id: str, keep_alive: int = 30, will=None) -> bytes:
    flags = 0x02  # clean session, как у клиента всегда
    if will is not None:
        flags |= 0x04
        if will.get("retain"):
            flags |= 0x20
    body = (
        bytes([0x00, 0x04, 0x4D, 0x51, 0x54, 0x54, 0x04, flags, (keep_alive >> 8) & 0xFF, keep_alive & 0xFF])
        + client_string(client_id)
    )
    if will is not None:
        body += client_string(will["topic"]) + client_string(will["payload"])
    return bytes([mqtt.CONNECT << 4]) + mqtt.encode_remaining_length(len(body)) + body


def client_subscribe(topic: str, packet_id: int) -> bytes:
    body = bytes([(packet_id >> 8) & 0xFF, packet_id & 0xFF]) + client_string(topic) + bytes([0x00])
    # Флаги 0x02 — ровно то, что ставит клиент.
    return bytes([(mqtt.SUBSCRIBE << 4) | 0x02]) + mqtt.encode_remaining_length(len(body)) + body


def client_publish(topic: str, payload: str, retain: bool = False) -> bytes:
    body = client_string(topic) + payload.encode("utf-8")
    flags = 0x01 if retain else 0x00
    return bytes([(mqtt.PUBLISH << 4) | flags]) + mqtt.encode_remaining_length(len(body)) + body


def client_pingreq() -> bytes:
    return bytes([mqtt.PINGREQ << 4, 0x00])


def client_disconnect() -> bytes:
    return bytes([mqtt.DISCONNECT << 4, 0x00])


# ---------------------------------------------------------------------------
# Remaining Length
# ---------------------------------------------------------------------------


class TestRemainingLength:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (0, b"\x00"),
            (127, b"\x7f"),
            (128, b"\x80\x01"),
            (16383, b"\xff\x7f"),
            (16384, b"\x80\x80\x01"),
            (2097151, b"\xff\xff\x7f"),
            (2097152, b"\x80\x80\x80\x01"),
        ],
    )
    def test_encodes_the_documented_boundaries(self, value, expected):
        assert mqtt.encode_remaining_length(value) == expected

    def test_rejects_more_than_four_bytes_worth(self):
        with pytest.raises(ValueError):
            mqtt.encode_remaining_length(mqtt.MAX_REMAINING_LENGTH + 1)

    def test_round_trips_every_boundary(self):
        for value in (0, 1, 127, 128, 16383, 16384, 2097151, 2097152, mqtt.MAX_REMAINING_LENGTH):
            encoded = mqtt.encode_remaining_length(value)
            assert mqtt.decode_remaining_length(encoded, 0) == (value, len(encoded))

    def test_partial_varint_is_not_an_error(self):
        """
        Половина варинта на границе кадра — обычное дело, а не поломка.
        Если бы это было исключением, брокер рвал бы соединение на каждом
        большом сообщении, разбитом на два кадра.
        """
        assert mqtt.decode_remaining_length(b"\x80", 0) is None

    def test_fifth_continuation_byte_is_an_error(self):
        with pytest.raises(mqtt.MqttProtocolError):
            mqtt.decode_remaining_length(b"\x80\x80\x80\x80\x01", 0)


# ---------------------------------------------------------------------------
# Разбор того, что шлёт клиент
# ---------------------------------------------------------------------------


class TestDecodeClientPackets:
    def test_connect_from_the_real_client(self):
        packets, rest = mqtt.decode_packets(client_connect("wireon_abc123", keep_alive=30))
        assert rest == b""
        assert len(packets) == 1
        connect = packets[0]
        assert isinstance(connect, mqtt.ConnectPacket)
        assert connect.client_id == "wireon_abc123"
        assert connect.keep_alive == 30
        assert connect.clean_session is True
        assert connect.protocol_name == "MQTT"
        assert connect.protocol_level == 4
        assert connect.will is None

    def test_connect_carries_the_last_will(self):
        will = {"topic": "wireon/room/ABCD", "payload": '{"type":"leave"}'}
        packets, _ = mqtt.decode_packets(client_connect("wireon_x", will=will))
        connect = packets[0]
        assert connect.will is not None
        assert connect.will.topic == "wireon/room/ABCD"
        assert connect.will.payload == b'{"type":"leave"}'
        assert connect.will.retain is False

    def test_subscribe_flags_and_qos_byte(self):
        packets, _ = mqtt.decode_packets(client_subscribe("wireon/room/ABCD", 7))
        sub = packets[0]
        assert isinstance(sub, mqtt.SubscribePacket)
        assert sub.packet_id == 7
        assert sub.topics == [("wireon/room/ABCD", 0)]

    def test_publish_qos0_has_no_packet_id(self):
        packets, _ = mqtt.decode_packets(client_publish("wireon/room/ABCD", '{"a":1}'))
        pub = packets[0]
        assert isinstance(pub, mqtt.PublishPacket)
        assert pub.topic == "wireon/room/ABCD"
        assert pub.payload == b'{"a":1}'
        assert pub.qos == 0
        assert pub.retain is False
        assert pub.packet_id is None

    def test_retain_flag_survives(self):
        packets, _ = mqtt.decode_packets(client_publish("wireon/room/A", "snapshot", retain=True))
        assert packets[0].retain is True

    def test_publish_with_qos1_skips_the_packet_id(self):
        """
        Клиент QoS 1 не шлёт, но другой мог бы. Идентификатор пакета лежит
        между темой и телом — не пропустив его, брокер отдал бы два лишних
        байта в начале полезной нагрузки, и JSON перестал бы разбираться.
        """
        body = client_string("t") + bytes([0x00, 0x09]) + b"payload"
        frame = bytes([(mqtt.PUBLISH << 4) | 0x02]) + mqtt.encode_remaining_length(len(body)) + body
        packets, _ = mqtt.decode_packets(frame)
        assert packets[0].qos == 1
        assert packets[0].packet_id == 9
        assert packets[0].payload == b"payload"

    def test_pingreq_and_disconnect(self):
        packets, _ = mqtt.decode_packets(client_pingreq() + client_disconnect())
        assert [p.type for p in packets] == [mqtt.PINGREQ, mqtt.DISCONNECT]

    def test_three_packets_in_one_frame(self):
        stream = client_connect("c") + client_subscribe("t", 1) + client_pingreq()
        packets, rest = mqtt.decode_packets(stream)
        assert rest == b""
        assert isinstance(packets[0], mqtt.ConnectPacket)
        assert isinstance(packets[1], mqtt.SubscribePacket)
        assert packets[2].type == mqtt.PINGREQ

    def test_split_packet_returns_the_tail(self):
        """
        Граница кадра WebSocket не имеет отношения к границе пакета. Хвост
        обязан вернуться целым, иначе половина сообщения теряется, а вторая
        разбирается как мусор.
        """
        whole = client_publish("wireon/room/ABCD", '{"position":42}')
        head, tail = whole[:6], whole[6:]
        packets, rest = mqtt.decode_packets(head)
        assert packets == []
        assert rest == head
        packets, rest = mqtt.decode_packets(rest + tail)
        assert rest == b""
        assert packets[0].payload == b'{"position":42}'

    def test_unknown_packet_type_does_not_break_the_stream(self):
        """
        Неизвестный тип — не повод рвать связь: за ним в том же кадре может
        лежать нужный пакет, и потерять его хуже, чем пропустить чужой.
        """
        puback = bytes([mqtt.PUBACK << 4, 0x02, 0x00, 0x01])
        packets, _ = mqtt.decode_packets(puback + client_pingreq())
        assert len(packets) == 2
        assert packets[1].type == mqtt.PINGREQ

    def test_truncated_string_inside_a_complete_packet_is_an_error(self):
        # Длина строки обещает 10 байт, а в теле их 2.
        body = bytes([0x00, 0x0A, 0x41, 0x42])
        frame = bytes([mqtt.SUBSCRIBE << 4 | 0x02]) + mqtt.encode_remaining_length(len(body)) + body
        with pytest.raises(mqtt.MqttProtocolError):
            mqtt.decode_packets(frame)


# ---------------------------------------------------------------------------
# Сборка того, что клиент обязан понять
# ---------------------------------------------------------------------------


class TestEncodeForClient:
    def test_connack_shape(self):
        assert mqtt.encode_connack(0) == bytes([0x20, 0x02, 0x00, 0x00])
        assert mqtt.encode_connack(1) == bytes([0x20, 0x02, 0x00, 0x01])

    def test_connack_session_present_bit(self):
        assert mqtt.encode_connack(0, session_present=True) == bytes([0x20, 0x02, 0x01, 0x00])

    def test_publish_round_trips_through_the_client_decoder_shape(self):
        frame = mqtt.encode_publish("wireon/room/ABCD", b'{"x":1}')
        packets, rest = mqtt.decode_packets(frame)
        assert rest == b""
        assert packets[0].topic == "wireon/room/ABCD"
        assert packets[0].payload == b'{"x":1}'
        assert packets[0].qos == 0

    def test_publish_retain_sets_only_the_low_bit(self):
        frame = mqtt.encode_publish("t", b"x", retain=True)
        assert frame[0] == (mqtt.PUBLISH << 4) | 0x01

    def test_suback_lists_one_code_per_topic(self):
        frame = mqtt.encode_suback(5, [0, 0x80])
        assert frame == bytes([0x90, 0x04, 0x00, 0x05, 0x00, 0x80])

    def test_pingresp_is_two_bytes(self):
        assert mqtt.encode_pingresp() == bytes([0xD0, 0x00])

    def test_large_payload_uses_a_multibyte_length(self):
        payload = b"x" * 300
        frame = mqtt.encode_publish("t", payload)
        packets, rest = mqtt.decode_packets(frame)
        assert rest == b""
        assert packets[0].payload == payload


# ---------------------------------------------------------------------------
# Совпадение тем
# ---------------------------------------------------------------------------


class TestTopicMatching:
    def test_exact_match_is_what_the_app_uses(self):
        assert mqtt.topic_matches("wireon/room/ABCD", "wireon/room/ABCD")
        assert not mqtt.topic_matches("wireon/room/ABCD", "wireon/room/EFGH")

    @pytest.mark.parametrize(
        "filter_,topic,expected",
        [
            ("wireon/room/+", "wireon/room/ABCD", True),
            ("wireon/room/+", "wireon/room/ABCD/extra", False),
            ("wireon/#", "wireon/room/ABCD", True),
            ("wireon/#", "wireon", True),
            ("#", "anything/at/all", True),
            ("wireon/+/ABCD", "wireon/room/ABCD", True),
            ("wireon/room", "wireon/room/ABCD", False),
            ("wireon/room/ABCD", "wireon/room", False),
        ],
    )
    def test_wildcards(self, filter_, topic, expected):
        assert mqtt.topic_matches(filter_, topic) is expected

    def test_wildcards_do_not_reach_dollar_topics(self):
        """
        `$SYS/...` по спецификации не покрывается ни `#`, ни `+` в начале.
        У нас таких тем нет, но подписка `#` из отладочного клиента иначе
        получала бы служебный поток брокера как обычные сообщения комнаты.
        """
        assert not mqtt.topic_matches("#", "$SYS/broker/uptime")
        assert not mqtt.topic_matches("+/broker", "$SYS/broker")
