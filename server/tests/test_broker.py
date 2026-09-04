"""
Поведение брокера в тех случаях, из-за которых «слушать вместе» и ломалось.

Тесты гоняют `Broker` и `ConnectionHandler` напрямую через очереди, без
WebSocket: проверяется протокол, а не aiohttp. Каждый класс назван так, чтобы
было видно, какую именно беду он держит.
"""

import asyncio

import pytest

from wireon_music import mqtt
from wireon_music.broker import Broker, BrokerClient, ConnectionHandler

from .test_mqtt import (
    client_connect,
    client_disconnect,
    client_pingreq,
    client_publish,
    client_subscribe,
)


def drain(queue: "asyncio.Queue[bytes]") -> list:
    """Всё, что брокер положил в очередь отправки, разобранное в пакеты."""
    raw = b""
    while not queue.empty():
        chunk = queue.get_nowait()
        if chunk == b"":
            raw += b""  # маркер закрытия, в пакеты не превращается
            continue
        raw += chunk
    packets, rest = mqtt.decode_packets(raw)
    assert rest == b"", "брокер отправил неполный пакет"
    return packets


def closing_marker_seen(queue: "asyncio.Queue[bytes]") -> bool:
    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    return b"" in items


def make_handler(broker: Broker):
    queue: "asyncio.Queue[bytes]" = asyncio.Queue(maxsize=64)
    return ConnectionHandler(broker, queue), queue


class TestHandshake:
    def test_connect_is_accepted(self):
        broker = Broker()
        handler, queue = make_handler(broker)
        handler.feed(client_connect("wireon_a", keep_alive=30))
        packets = drain(queue)
        assert len(packets) == 1
        assert packets[0].type == mqtt.CONNACK
        assert handler.client is not None
        assert broker.stats["clients"] == 1

    def test_wrong_protocol_level_is_refused_with_a_code(self):
        """
        Отказ, а не тишина: клиент показывает человеку «брокер не поддерживает
        эту версию протокола», и это правда, а не догадка о сети.
        """
        broker = Broker()
        handler, queue = make_handler(broker)
        body = (
            bytes([0x00, 0x04, 0x4D, 0x51, 0x54, 0x54, 0x05, 0x02, 0x00, 0x1E])
            + bytes([0x00, 0x01, 0x41])
        )
        frame = bytes([mqtt.CONNECT << 4]) + mqtt.encode_remaining_length(len(body)) + body
        handler.feed(frame)
        assert queue.get_nowait() == mqtt.encode_connack(mqtt.CONNACK_BAD_PROTOCOL)
        assert handler.closed

    def test_empty_client_id_is_refused(self):
        broker = Broker()
        handler, queue = make_handler(broker)
        body = bytes([0x00, 0x04, 0x4D, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x1E]) + bytes([0x00, 0x00])
        frame = bytes([mqtt.CONNECT << 4]) + mqtt.encode_remaining_length(len(body)) + body
        handler.feed(frame)
        assert queue.get_nowait() == mqtt.encode_connack(mqtt.CONNACK_ID_REJECTED)
        assert handler.closed

    def test_anything_before_connect_closes_the_socket(self):
        broker = Broker()
        handler, _queue = make_handler(broker)
        handler.feed(client_publish("wireon/room/A", "x"))
        assert handler.closed
        assert broker.stats["clients"] == 0

    def test_second_connect_on_one_socket_closes_it(self):
        broker = Broker()
        handler, _queue = make_handler(broker)
        handler.feed(client_connect("a"))
        handler.feed(client_connect("b"))
        assert handler.closed

    def test_malformed_stream_closes_instead_of_resyncing(self):
        """
        Где начинается следующий пакет — уже неизвестно, поэтому единственный
        честный выход закрыть соединение: клиент переподключится с чистого места.
        """
        broker = Broker()
        handler, _queue = make_handler(broker)
        handler.feed(client_connect("a"))
        bad_body = bytes([0x00, 0x40, 0x41])  # строка обещает 64 байта, есть 1
        handler.feed(
            bytes([mqtt.SUBSCRIBE << 4 | 0x02]) + mqtt.encode_remaining_length(len(bad_body)) + bad_body
        )
        assert handler.closed
        assert "protocol error" in (handler.close_reason or "")


class TestDelivery:
    def test_two_clients_in_one_room_see_each_other(self):
        broker = Broker()
        a, a_queue = make_handler(broker)
        b, b_queue = make_handler(broker)
        a.feed(client_connect("a") + client_subscribe("wireon/room/ABCD", 1))
        b.feed(client_connect("b") + client_subscribe("wireon/room/ABCD", 1))
        drain(a_queue)
        drain(b_queue)

        a.feed(client_publish("wireon/room/ABCD", '{"type":"play"}'))
        received = drain(b_queue)
        assert len(received) == 1
        assert received[0].topic == "wireon/room/ABCD"
        assert received[0].payload == b'{"type":"play"}'

    def test_sender_does_not_get_its_own_message_back(self):
        """
        Клиент отбрасывает повторы по идентификатору, так что эхо не сломало бы
        комнату, — но это лишний круг по мобильному трафику на каждое движение
        полосы позиции.
        """
        broker = Broker()
        a, a_queue = make_handler(broker)
        a.feed(client_connect("a") + client_subscribe("wireon/room/ABCD", 1))
        drain(a_queue)
        a.feed(client_publish("wireon/room/ABCD", "x"))
        assert drain(a_queue) == []

    def test_other_rooms_hear_nothing(self):
        broker = Broker()
        a, a_queue = make_handler(broker)
        b, b_queue = make_handler(broker)
        a.feed(client_connect("a") + client_subscribe("wireon/room/AAAA", 1))
        b.feed(client_connect("b") + client_subscribe("wireon/room/BBBB", 1))
        drain(a_queue)
        drain(b_queue)
        a.feed(client_publish("wireon/room/AAAA", "x"))
        assert drain(b_queue) == []

    def test_suback_answers_every_subscribe(self):
        broker = Broker()
        a, a_queue = make_handler(broker)
        a.feed(client_connect("a"))
        drain(a_queue)
        a.feed(client_subscribe("wireon/room/ABCD", 42))
        packets = drain(a_queue)
        assert len(packets) == 1
        assert packets[0].type == mqtt.SUBACK

    def test_pingreq_gets_a_pingresp(self):
        broker = Broker()
        a, a_queue = make_handler(broker)
        a.feed(client_connect("a"))
        drain(a_queue)
        a.feed(client_pingreq())
        assert [p.type for p in drain(a_queue)] == [mqtt.PINGRESP]

    def test_oversized_payload_closes_the_socket(self):
        broker = Broker()
        a, _queue = make_handler(broker)
        a.feed(client_connect("a"))
        a.feed(client_publish("t", "x" * (64 * 1024 + 1)))
        assert a.closed
        assert a.close_reason == "payload too large"


class TestRetained:
    def test_joiner_gets_the_hosts_snapshot_immediately(self):
        """
        Смысл retain целиком в этом: присоединившийся узнаёт позицию хоста в
        момент подписки, а не через полсекунды, когда хост пришлёт следующее
        обновление.
        """
        broker = Broker()
        host, host_queue = make_handler(broker)
        host.feed(client_connect("host") + client_subscribe("wireon/room/ABCD", 1))
        drain(host_queue)
        host.feed(client_publish("wireon/room/ABCD", '{"position":42}', retain=True))

        joiner, joiner_queue = make_handler(broker)
        joiner.feed(client_connect("joiner") + client_subscribe("wireon/room/ABCD", 1))
        packets = [p for p in drain(joiner_queue) if p.type == mqtt.PUBLISH]
        assert len(packets) == 1
        assert packets[0].payload == b'{"position":42}'
        assert packets[0].retain is True, "клиент по этому флагу решает, свежий ли снимок"

    def test_empty_retained_payload_deletes_the_snapshot(self):
        """
        Так в MQTT стирается удержанное сообщение, и `groupListenService` на это
        рассчитывает, закрывая комнату: иначе следующая комната с тем же кодом
        получила бы позицию из прошлой.
        """
        broker = Broker()
        host, host_queue = make_handler(broker)
        host.feed(client_connect("host") + client_subscribe("wireon/room/ABCD", 1))
        drain(host_queue)
        host.feed(client_publish("wireon/room/ABCD", "snapshot", retain=True))
        assert broker.stats["retained"] == 1

        host.feed(client_publish("wireon/room/ABCD", "", retain=True))
        assert broker.stats["retained"] == 0

        joiner, joiner_queue = make_handler(broker)
        joiner.feed(client_connect("j") + client_subscribe("wireon/room/ABCD", 1))
        assert [p for p in drain(joiner_queue) if p.type == mqtt.PUBLISH] == []

    def test_retained_is_kept_per_topic(self):
        broker = Broker()
        host, host_queue = make_handler(broker)
        host.feed(client_connect("host"))
        drain(host_queue)
        host.feed(client_publish("wireon/room/A", "a", retain=True))
        host.feed(client_publish("wireon/room/B", "b", retain=True))

        joiner, joiner_queue = make_handler(broker)
        joiner.feed(client_connect("j") + client_subscribe("wireon/room/B", 1))
        payloads = [p.payload for p in drain(joiner_queue) if p.type == mqtt.PUBLISH]
        assert payloads == [b"b"]


class TestLastWill:
    def test_crashed_peer_stops_being_present(self):
        """
        Упавший участник (закрыли крышку ноутбука) сам «ушёл» не скажет. Без
        last will он остаётся в списке присутствующих навсегда.
        """
        broker = Broker()
        will = {"topic": "wireon/room/ABCD", "payload": '{"type":"leave","userId":"a"}'}
        a, a_queue = make_handler(broker)
        b, b_queue = make_handler(broker)
        a.feed(client_connect("a", will=will) + client_subscribe("wireon/room/ABCD", 1))
        b.feed(client_connect("b") + client_subscribe("wireon/room/ABCD", 1))
        drain(a_queue)
        drain(b_queue)

        a.close("socket closed")  # обрыв, не DISCONNECT
        received = [p for p in drain(b_queue) if p.type == mqtt.PUBLISH]
        assert len(received) == 1
        assert b'"type":"leave"' in received[0].payload

    def test_graceful_disconnect_suppresses_the_will(self):
        """
        Человек нажал «выйти» — приложение уже сказало об этом своим сообщением.
        Второе «ушёл» от брокера показало бы выход дважды.
        """
        broker = Broker()
        will = {"topic": "wireon/room/ABCD", "payload": '{"type":"leave"}'}
        a, a_queue = make_handler(broker)
        b, b_queue = make_handler(broker)
        a.feed(client_connect("a", will=will))
        b.feed(client_connect("b") + client_subscribe("wireon/room/ABCD", 1))
        drain(a_queue)
        drain(b_queue)

        a.feed(client_disconnect())
        assert [p for p in drain(b_queue) if p.type == mqtt.PUBLISH] == []

    def test_will_does_not_come_back_to_its_own_sender(self):
        broker = Broker()
        will = {"topic": "wireon/room/ABCD", "payload": "bye"}
        a, a_queue = make_handler(broker)
        a.feed(client_connect("a", will=will) + client_subscribe("wireon/room/ABCD", 1))
        drain(a_queue)
        a.close("socket closed")
        assert [p for p in drain(a_queue) if p.type == mqtt.PUBLISH] == []


class TestKeepAlive:
    def test_silent_client_expires_after_the_grace_period(self):
        broker = Broker()
        client = BrokerClient(client_id="a", send=asyncio.Queue(), keep_alive=30, last_seen=0.0)
        broker.register(client)
        client.last_seen = 100.0

        # Ровно на границе — ещё жив: 30 × 1.5 = 45 секунд молчания.
        assert broker.expired(now=100.0 + 45.0) == []
        assert [c.client_id for c in broker.expired(now=100.0 + 46.0)] == ["a"]

    def test_traffic_refreshes_the_stamp(self):
        broker = Broker()
        handler, queue = make_handler(broker)
        handler.feed(client_connect("a", keep_alive=30))
        drain(queue)
        handler.client.last_seen = 0.0
        handler.feed(client_pingreq())
        assert handler.client.last_seen > 0.0

    def test_zero_keepalive_still_gets_a_deadline(self):
        """
        Ноль по спецификации значит «не проверяй». Брошенные сокеты тогда
        копились бы вечно в контейнере с 500 МБ памяти, поэтому у нуля есть
        свой предел.
        """
        broker = Broker()
        client = BrokerClient(client_id="a", send=asyncio.Queue(), keep_alive=0)
        broker.register(client)
        # `register` ставит свою метку, поэтому обнуляем её после регистрации.
        client.last_seen = 0.0
        assert broker.expired(now=10.0) == []
        assert [c.client_id for c in broker.expired(now=1000.0)] == ["a"]


class TestClientIdCollision:
    def test_reconnect_with_the_same_id_evicts_the_stale_socket(self):
        """
        Иначе живой участник остаётся с мёртвым сокетом: сообщения уходят в
        соединение, которое уже никто не читает.
        """
        broker = Broker()
        first, first_queue = make_handler(broker)
        first.feed(client_connect("same") + client_subscribe("wireon/room/A", 1))
        drain(first_queue)

        second, second_queue = make_handler(broker)
        second.feed(client_connect("same"))
        assert broker.stats["clients"] == 1
        assert closing_marker_seen(first_queue), "прежний сокет должен получить приказ закрыться"
        assert drain(second_queue)[0].type == mqtt.CONNACK

    def test_eviction_does_not_publish_the_evicted_will(self):
        """
        Переподключение — это тот же человек, а не ушедший. Опубликованный will
        показал бы «участник ушёл» ровно в тот момент, когда он вернулся.
        """
        broker = Broker()
        will = {"topic": "wireon/room/A", "payload": '{"type":"leave"}'}
        watcher, watcher_queue = make_handler(broker)
        watcher.feed(client_connect("watcher") + client_subscribe("wireon/room/A", 1))
        drain(watcher_queue)

        first, _ = make_handler(broker)
        first.feed(client_connect("same", will=will))
        second, _ = make_handler(broker)
        second.feed(client_connect("same", will=will))

        assert [p for p in drain(watcher_queue) if p.type == mqtt.PUBLISH] == []


class TestLimits:
    def test_broker_refuses_beyond_the_client_cap(self):
        broker = Broker()
        for index in range(200):
            assert broker.register(BrokerClient(client_id=f"c{index}", send=asyncio.Queue())) == 0
        code = broker.register(BrokerClient(client_id="one_too_many", send=asyncio.Queue()))
        assert code == mqtt.CONNACK_UNAVAILABLE

    def test_subscription_cap_refuses_the_extra_filter(self):
        broker = Broker()
        client = BrokerClient(client_id="a", send=asyncio.Queue())
        broker.register(client)
        granted = broker.subscribe(client, [(f"t{i}", 0) for i in range(20)])
        assert granted[:16] == [0] * 16
        assert granted[16:] == [0x80] * 4

    def test_slow_client_is_dropped_instead_of_growing_in_memory(self):
        """
        Клиент не успевает читать. Рвать соединение честнее, чем расти в памяти:
        он переподключится и получит удержанный снимок заново.
        """
        broker = Broker()
        slow = BrokerClient(client_id="slow", send=asyncio.Queue(maxsize=1))
        broker.register(slow)
        broker.subscribe(slow, [("wireon/room/A", 0)])
        fast = BrokerClient(client_id="fast", send=asyncio.Queue())
        broker.register(fast)

        for _ in range(5):
            broker.publish("wireon/room/A", b"x", exclude="fast")
        assert slow.connected is False
