import {
  MQTT_PACKET,
  decodeRemainingLength,
  encodePublish,
  type WebSocketLike
} from '../../src/services/mqttClient';

/**
 * Брокер MQTT без сети.
 *
 * Живёт здесь, а не внутри одного набора проверок, потому что нужен уже двоим:
 * совместному прослушиванию и звонку «медиатека изменилась». Вторая копия
 * такого брокера разошлась бы с первой в первый же день, и тогда один и тот же
 * обмен считался бы верным по двум разным правилам.
 *
 * Умеет то же, что настоящий: подписки на сокет, удержанные сообщения,
 * доставку последней воли и эхо отправителю.
 */
const decoder = new TextDecoder();

function readString(body: Uint8Array, offset: number): { value: string; next: number } {
  const length = (body[offset] << 8) | body[offset + 1];
  const start = offset + 2;
  return { value: decoder.decode(body.subarray(start, start + length)), next: start + length };
}

interface PublishRecord {
  topic: string;
  payload: string;
  retain: boolean;
  from: string;
}

/**
 * An MQTT broker with no network: retained messages, per-socket subscriptions,
 * last-will delivery and echo-to-publisher, which is what a real broker does.
 *
 * This is the piece the group-listen tests were missing. `BroadcastChannel` made
 * two instances in one window look synced no matter what went over the wire, so
 * the transport could be completely broken and every test still passed.
 */
class FakeBroker {
  readonly sockets: BrokerSocket[] = [];
  readonly retained = new Map<string, string>();
  readonly publishes: PublishRecord[] = [];

  connect(url: string): BrokerSocket {
    const socket = new BrokerSocket(this, url);
    this.sockets.push(socket);
    return socket;
  }

  /** One `send()` from the client is exactly one packet, so no buffering here. */
  handle(socket: BrokerSocket, bytes: Uint8Array): void {
    const type = bytes[0] >> 4;
    const length = decodeRemainingLength(bytes, 1);
    if (!length) throw new Error('Broker got a truncated packet');
    const body = bytes.subarray(1 + length.bytesRead);

    switch (type) {
      case MQTT_PACKET.connect: {
        const flags = body[7];
        const clientId = readString(body, 10);
        socket.clientId = clientId.value;
        if ((flags & 0x04) === 0x04) {
          const willTopic = readString(body, clientId.next);
          const willPayload = readString(body, willTopic.next);
          socket.will = { topic: willTopic.value, payload: willPayload.value };
        }
        socket.deliver(new Uint8Array([0x20, 0x02, 0x00, 0x00]));
        return;
      }
      case MQTT_PACKET.subscribe: {
        const packetId = (body[0] << 8) | body[1];
        const topic = readString(body, 2);
        socket.subscriptions.add(topic.value);
        socket.deliver(new Uint8Array([0x90, 0x03, body[0], body[1], 0x00]));
        void packetId;
        const snapshot = this.retained.get(topic.value);
        if (snapshot !== undefined) {
          socket.deliver(encodePublish(topic.value, snapshot, { retain: true }));
        }
        return;
      }
      case MQTT_PACKET.publish: {
        const topic = readString(body, 0);
        const payload = decoder.decode(body.subarray(topic.next));
        const retain = (bytes[0] & 0x01) === 0x01;
        this.publishes.push({ topic: topic.value, payload, retain, from: socket.clientId });
        if (retain) {
          // An empty retained payload deletes the stored one.
          if (payload === '') this.retained.delete(topic.value);
          else this.retained.set(topic.value, payload);
        }
        this.fanOut(topic.value, payload, false);
        return;
      }
      case MQTT_PACKET.pingreq:
        socket.deliver(new Uint8Array([0xd0, 0x00]));
        return;
      case MQTT_PACKET.disconnect:
        // A graceful goodbye cancels the will — that is the whole point of it.
        socket.will = null;
        this.remove(socket);
        return;
      default:
        return;
    }
  }

  fanOut(topic: string, payload: string, retain: boolean): void {
    for (const socket of [...this.sockets]) {
      if (socket.subscriptions.has(topic)) {
        socket.deliver(encodePublish(topic, payload, { retain }));
      }
    }
  }

  /** The peer's process died: no DISCONNECT, so the broker publishes its will. */
  crash(socket: BrokerSocket): void {
    const will = socket.will;
    this.remove(socket);
    socket.readyState = 3;
    socket.onclose?.();
    if (will) this.fanOut(will.topic, will.payload, false);
  }

  private remove(socket: BrokerSocket): void {
    const index = this.sockets.indexOf(socket);
    if (index >= 0) this.sockets.splice(index, 1);
  }

  /**
   * Сообщения заданного вида, которые действительно прошли через брокер.
   *
   * Вид сообщения не типизирован нарочно: брокеру всё равно, что в полезной
   * нагрузке, и знать про формат комнаты он не должен — иначе звонок медиатеки
   * не смог бы им пользоваться.
   */
  messagesOfType<T extends { type?: string }>(type: string): T[] {
    return this.publishes
      .map((record) => {
        try {
          return JSON.parse(record.payload) as T;
        } catch {
          return null;
        }
      })
      .filter((message): message is T => message?.type === type);
  }
}

class BrokerSocket implements WebSocketLike {
  readyState = 0;
  binaryType = 'blob';
  onopen: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  clientId = '';
  will: { topic: string; payload: string } | null = null;
  readonly subscriptions = new Set<string>();

  constructor(
    private readonly broker: FakeBroker,
    public readonly url: string
  ) {
    // Deferred: the client assigns `onopen` after the factory returns.
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 1) return;
    this.broker.handle(this, new Uint8Array(data));
  }

  close(): void {
    this.readyState = 3;
  }

  deliver(bytes: Uint8Array): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: bytes.slice().buffer });
  }
}

export { FakeBroker, BrokerSocket };
export type { PublishRecord };
