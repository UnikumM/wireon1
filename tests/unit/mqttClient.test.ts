import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import {
  MQTT_PACKET,
  MQTT_CONNACK_MESSAGES,
  MqttClient,
  MqttProtocolError,
  decodePackets,
  decodeRemainingLength,
  encodeConnect,
  encodeDisconnect,
  encodePingReq,
  encodePublish,
  encodeRemainingLength,
  encodeSubscribe,
  type WebSocketLike
} from '../../src/services/mqttClient';

const encoder = new TextEncoder();

/** A broker that never leaves memory: every byte written is inspectable. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0;
  binaryType = 'blob';
  onopen: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  readonly sent: Uint8Array[] = [];
  closeCalls = 0;

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  // -- test-side controls ---------------------------------------------------

  /** The TCP handshake completed; the client now sends CONNECT. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Hands bytes to the client the way a real socket would. */
  deliver(bytes: Uint8Array | ArrayBuffer | string): void {
    this.onmessage?.({ data: bytes });
  }

  /** The broker (or the network) dropped us. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Packet types written so far, in order. */
  get types(): number[] {
    return this.sent.map((packet) => packet[0] >> 4);
  }

  get last(): Uint8Array {
    return this.sent[this.sent.length - 1];
  }
}

function connack(returnCode = 0): Uint8Array {
  return new Uint8Array([0x20, 0x02, 0x00, returnCode]);
}

function suback(packetId = 2): Uint8Array {
  return new Uint8Array([0x90, 0x03, (packetId >> 8) & 0xff, packetId & 0xff, 0x00]);
}

const PINGRESP = new Uint8Array([0xd0, 0x00]);

type ClientOptions = ConstructorParameters<typeof MqttClient>[0];

/** Builds a client wired to `FakeSocket`, plus a handle on the socket it opens. */
function makeClient(overrides: Partial<ClientOptions> = {}): MqttClient {
  return new MqttClient({
    endpoints: ['wss://broker.one/mqtt'],
    clientId: 'wireon_test',
    keepAliveSeconds: 10,
    socketFactory: (url) => new FakeSocket(url),
    ...overrides
  });
}

/**
 * Catches a `connect()` rejection the moment it happens — the test still has to
 * drive the socket afterwards, and an unattached rejection would be reported as
 * unhandled in the meantime.
 */
function capture(promise: Promise<void>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('Ожидалась неудача подключения, а connect() выполнился');
    },
    (err: Error) => err
  );
}

function socketAt(index: number): FakeSocket {
  const socket = FakeSocket.instances[index];
  if (!socket) throw new Error(`No socket opened at index ${index}`);
  return socket;
}

/** Drives a client all the way to `online` and returns its socket. */
async function bringOnline(client: MqttClient, index = 0): Promise<FakeSocket> {
  const connected = client.connect();
  const socket = socketAt(index);
  socket.open();
  socket.deliver(connack(0));
  await connected;
  return socket;
}

describe('MQTT — байты на проводе', () => {
  describe('Remaining Length', () => {
    it('кодирует однобайтовые длины как есть', () => {
      expect(encodeRemainingLength(0)).toEqual([0x00]);
      expect(encodeRemainingLength(2)).toEqual([0x02]);
      expect(encodeRemainingLength(127)).toEqual([0x7f]);
    });

    it('переходит на второй байт со 128', () => {
      // 128 = 0x80 0x01: младшие 7 бит, старший бит «продолжение».
      expect(encodeRemainingLength(128)).toEqual([0x80, 0x01]);
      expect(encodeRemainingLength(16383)).toEqual([0xff, 0x7f]);
      expect(encodeRemainingLength(16384)).toEqual([0x80, 0x80, 0x01]);
      expect(encodeRemainingLength(268435455)).toEqual([0xff, 0xff, 0xff, 0x7f]);
    });

    it('отказывается кодировать то, что в четыре байта не влезет', () => {
      expect(() => encodeRemainingLength(268435456)).toThrow(RangeError);
      expect(() => encodeRemainingLength(-1)).toThrow(RangeError);
      expect(() => encodeRemainingLength(1.5)).toThrow(RangeError);
    });

    it.each([0, 1, 127, 128, 8192, 16383, 16384, 2097151, 2097152, 268435455])(
      'декодирует обратно ровно то, что закодировал: %s',
      (value) => {
        const bytes = new Uint8Array(encodeRemainingLength(value));
        expect(decodeRemainingLength(bytes, 0)).toEqual({ value, bytesRead: bytes.length });
      }
    );

    it('возвращает null, когда varint ещё не дошёл целиком', () => {
      // Признак разорванного WS-кадра, а не ошибки: ждём следующий.
      expect(decodeRemainingLength(new Uint8Array([0x80]), 0)).toBeNull();
      expect(decodeRemainingLength(new Uint8Array([0x80, 0x80]), 0)).toBeNull();
      expect(decodeRemainingLength(new Uint8Array([]), 0)).toBeNull();
    });

    it('ругается на пятый байт продолжения', () => {
      expect(() => decodeRemainingLength(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x01]), 0)).toThrow(
        MqttProtocolError
      );
    });

    it('читает с указанного смещения', () => {
      expect(decodeRemainingLength(new Uint8Array([0xff, 0xff, 0x7f]), 1)).toEqual({
        value: 16383,
        bytesRead: 2
      });
    });
  });

  describe('CONNECT', () => {
    it('содержит имя протокола, уровень 3.1.1 и clean session', () => {
      const packet = encodeConnect({ clientId: 'abc', keepAliveSeconds: 30 });

      expect(packet[0]).toBe(0x10); // тип 1, флаги 0
      expect(Array.from(packet.subarray(2, 8))).toEqual([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54]);
      expect(packet[8]).toBe(0x04); // MQTT 3.1.1
      expect(packet[9]).toBe(0x02); // clean session, без завещания
      expect(packet[10]).toBe(0x00);
      expect(packet[11]).toBe(30); // keepalive, старший байт нулевой
      expect(Array.from(packet.subarray(12, 14))).toEqual([0x00, 0x03]);
      expect(new TextDecoder().decode(packet.subarray(14))).toBe('abc');
    });

    it('объявленная длина совпадает с фактической', () => {
      const packet = encodeConnect({ clientId: 'wireon_client_id' });
      const length = decodeRemainingLength(packet, 1)!;
      expect(length.value).toBe(packet.length - 1 - length.bytesRead);
    });

    it('поднимает флаг завещания и дописывает его тему с телом', () => {
      const packet = encodeConnect({
        clientId: 'a',
        will: { topic: 'wireon/room/ABC123', payload: '{"type":"leave"}' }
      });

      expect(packet[9]).toBe(0x06); // clean session + will
      const text = new TextDecoder().decode(packet);
      expect(text).toContain('wireon/room/ABC123');
      expect(text).toContain('{"type":"leave"}');
    });

    it('добавляет бит retain, если завещание должно остаться на брокере', () => {
      const packet = encodeConnect({ clientId: 'a', will: { topic: 't', payload: 'p', retain: true } });
      expect(packet[9]).toBe(0x26); // clean session + will + will retain
    });

    it('держит keepalive в разумных границах', () => {
      expect(encodeConnect({ clientId: 'a', keepAliveSeconds: 0 })[11]).toBe(5);
      const huge = encodeConnect({ clientId: 'a', keepAliveSeconds: 999999 });
      expect((huge[10] << 8) | huge[11]).toBe(65535);
    });

    it('считает длину строк в байтах, а не в символах', () => {
      // «Гости» — 5 символов, 10 байт UTF-8: перепутать значит сломать поток.
      const packet = encodeConnect({ clientId: 'Гости' });
      expect(Array.from(packet.subarray(12, 14))).toEqual([0x00, 0x0a]);
    });
  });

  describe('SUBSCRIBE / PUBLISH / служебные', () => {
    it('SUBSCRIBE несёт обязательный флаг 0x02, идентификатор и запрошенный QoS', () => {
      const packet = encodeSubscribe('wireon/room/ABC123', 7);

      expect(packet[0]).toBe(0x82); // без 0x02 брокер разрывает соединение
      expect(Array.from(packet.subarray(2, 4))).toEqual([0x00, 0x07]);
      expect(packet[packet.length - 1]).toBe(0x00); // QoS 0
      expect(new TextDecoder().decode(packet.subarray(6, packet.length - 1))).toBe('wireon/room/ABC123');
    });

    it('PUBLISH по умолчанию идёт без retain и без идентификатора пакета', () => {
      const packet = encodePublish('t', 'hi');

      expect(packet[0]).toBe(0x30); // тип 3, QoS 0, retain 0
      expect(packet[1]).toBe(2 + 1 + 2); // длина темы + тема + тело
      expect(new TextDecoder().decode(packet.subarray(5))).toBe('hi');
    });

    it('PUBLISH с retain поднимает младший бит заголовка', () => {
      expect(encodePublish('t', 'hi', { retain: true })[0]).toBe(0x31);
    });

    it('PINGREQ и DISCONNECT — это два байта без тела', () => {
      expect(Array.from(encodePingReq())).toEqual([0xc0, 0x00]);
      expect(Array.from(encodeDisconnect())).toEqual([0xe0, 0x00]);
    });
  });

  describe('decodePackets', () => {
    it('читает PUBLISH туда и обратно, включая русское тело', () => {
      const payload = JSON.stringify({ type: 'chat', chatText: 'Привет, это трек' });
      const { packets, rest } = decodePackets(encodePublish('wireon/room/ABC123', payload));

      expect(rest).toHaveLength(0);
      expect(packets).toEqual([
        { type: MQTT_PACKET.publish, topic: 'wireon/room/ABC123', payload, retain: false }
      ]);
    });

    it('различает свежее сообщение и сохранённый снимок', () => {
      const { packets } = decodePackets(encodePublish('t', 'x', { retain: true }));
      expect(packets[0].retain).toBe(true);
    });

    it('разбирает несколько пакетов из одного кадра', () => {
      const merged = new Uint8Array([...connack(0), ...encodePublish('a', '1'), ...PINGRESP]);

      const { packets, rest } = decodePackets(merged);

      expect(packets.map((p) => p.type)).toEqual([
        MQTT_PACKET.connack,
        MQTT_PACKET.publish,
        MQTT_PACKET.pingresp
      ]);
      expect(packets[0].returnCode).toBe(0);
      expect(packets[1].payload).toBe('1');
      expect(rest).toHaveLength(0);
    });

    it('оставляет незавершённый пакет в остатке, ничего не выдумывая', () => {
      const full = encodePublish('topic', 'payload');
      const cut = full.subarray(0, full.length - 3);

      const { packets, rest } = decodePackets(cut);

      expect(packets).toHaveLength(0);
      expect(Array.from(rest)).toEqual(Array.from(cut));
    });

    it('склеенный из двух половин поток даёт тот же пакет', () => {
      const full = encodePublish('topic', 'payload');
      const first = decodePackets(full.subarray(0, 4));
      const second = decodePackets(new Uint8Array([...first.rest, ...full.subarray(4)]));

      expect(first.packets).toHaveLength(0);
      expect(second.packets[0]).toMatchObject({ topic: 'topic', payload: 'payload' });
      expect(second.rest).toHaveLength(0);
    });

    it('отдаёт целые пакеты и придерживает хвост', () => {
      const whole = encodePublish('a', 'first');
      const partial = encodePublish('b', 'second').subarray(0, 3);

      const { packets, rest } = decodePackets(new Uint8Array([...whole, ...partial]));

      expect(packets).toHaveLength(1);
      expect(packets[0].payload).toBe('first');
      expect(Array.from(rest)).toEqual(Array.from(partial));
    });

    it('пропускает идентификатор пакета у QoS 1', () => {
      // QoS 1 вставляет два байта между темой и телом; без учёта этого тело
      // начиналось бы с мусора.
      const topic = encoder.encode('t');
      const body = new Uint8Array([0x00, topic.length, ...topic, 0x00, 0x09, ...encoder.encode('ok')]);
      const packet = new Uint8Array([0x32, body.length, ...body]);

      const { packets } = decodePackets(packet);

      expect(packets[0]).toMatchObject({ topic: 't', payload: 'ok' });
    });

    it('вытаскивает код отказа из CONNACK', () => {
      expect(decodePackets(connack(5)).packets[0]).toEqual({ type: MQTT_PACKET.connack, returnCode: 5 });
    });

    it('незнакомые типы отдаёт как есть, не падая', () => {
      expect(decodePackets(suback()).packets).toEqual([{ type: MQTT_PACKET.suback }]);
    });

    it('на пустом буфере ничего не возвращает', () => {
      expect(decodePackets(new Uint8Array(0))).toEqual({ packets: [], rest: new Uint8Array(0) });
    });
  });
});

describe('MqttClient — жизнь соединения', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Рукопожатие', () => {
    it('после открытия сокета сразу отправляет CONNECT', async () => {
      const client = makeClient();
      const connected = client.connect();
      const socket = socketAt(0);

      expect(socket.url).toBe('wss://broker.one/mqtt');
      expect(client.status).toBe('connecting');
      expect(socket.sent).toHaveLength(0);

      socket.open();
      expect(socket.types).toEqual([MQTT_PACKET.connect]);

      socket.deliver(connack(0));
      await expect(connected).resolves.toBeUndefined();
      expect(client.status).toBe('online');
      expect(client.error).toBeNull();
      client.end();
    });

    it('переводит отказ брокера в понятный текст и не долбится повторно', async () => {
      vi.useFakeTimers();
      const client = makeClient();
      const failed = capture(client.connect());
      const socket = socketAt(0);
      socket.open();

      socket.deliver(connack(5));

      const error = await failed;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(MQTT_CONNACK_MESSAGES[5]);
      expect(client.status).toBe('offline');

      // Отказ в авторизации не «пройдёт сам»: переподключаться бессмысленно.
      vi.advanceTimersByTime(60000);
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it('на неизвестный код отказа тоже даёт внятное сообщение', async () => {
      const client = makeClient({ reconnect: false });
      const failed = capture(client.connect());
      socketAt(0).open();
      socketAt(0).deliver(connack(42));

      expect((await failed).message).toBe('Брокер отказал (код 42)');
    });

    it('сдаётся, если брокер молчит вместо CONNACK', async () => {
      vi.useFakeTimers();
      const client = makeClient({ connectTimeoutMs: 3000, reconnect: false });
      const failed = capture(client.connect());
      socketAt(0).open();

      vi.advanceTimersByTime(3000);

      expect((await failed).message).toBe('Брокер не ответил');
      expect(client.status).toBe('offline');
      expect(socketAt(0).closeCalls).toBe(1);
    });

    it('обрыв до рукопожатия — это неудача, а не тишина', async () => {
      const client = makeClient({ reconnect: false });
      const failed = capture(client.connect());
      socketAt(0).open();

      socketAt(0).drop();

      expect((await failed).message).toBe('Соединение с брокером закрыто');
      expect(client.status).toBe('offline');
    });

    it('сокет, который не удалось открыть, не роняет клиент', async () => {
      const client = makeClient({
        reconnect: false,
        socketFactory: () => {
          throw new Error('Сеть недоступна');
        }
      });

      expect((await capture(client.connect())).message).toBe('Сеть недоступна');
      expect(client.status).toBe('offline');
    });

    it('повторный connect после неудачи снова пробует, а не отказывает мгновенно', async () => {
      // Регрессия: onStatus проигрывает новому слушателю текущий статус, и
      // прошлый «offline» отклонял следующую попытку до открытия сокета.
      const client = makeClient({ reconnect: false });
      const failed = capture(client.connect());
      socketAt(0).open();
      socketAt(0).drop();
      await failed;

      const connected = client.connect();
      expect(FakeSocket.instances).toHaveLength(2);
      socketAt(1).open();
      socketAt(1).deliver(connack(0));

      await expect(connected).resolves.toBeUndefined();
      client.end();
    });

    it('повторный connect на живом соединении ничего не открывает', async () => {
      const client = makeClient();
      await bringOnline(client);

      await expect(client.connect()).resolves.toBeUndefined();
      expect(FakeSocket.instances).toHaveLength(1);
      client.end();
    });

    it('спрашивает подпротокол mqtt — без него брокеры не отвечают', async () => {
      const original = (globalThis as any).WebSocket;
      const seen: Array<{ url: string; protocols: unknown; binaryType: string }> = [];
      (globalThis as any).WebSocket = class {
        readyState = 0;
        binaryType = 'blob';
        onopen = null;
        onclose = null;
        onerror = null;
        onmessage = null;
        constructor(url: string, protocols?: string | string[]) {
          seen.push({ url, protocols, binaryType: 'blob' });
        }
        send(): void {}
        close(): void {}
      };

      try {
        const client = new MqttClient({
          endpoints: ['wss://real.broker/mqtt'],
          clientId: 'x',
          reconnect: false
        });
        void client.connect().catch(() => undefined);

        expect(seen[0].url).toBe('wss://real.broker/mqtt');
        expect(seen[0].protocols).toBe('mqtt');
        client.end();
      } finally {
        (globalThis as any).WebSocket = original;
      }
    });
  });

  describe('Подписки и сообщения', () => {
    it('подписки, сделанные до подключения, уходят после CONNACK', async () => {
      const client = makeClient();
      client.subscribe('wireon/room/AAA111');
      const connected = client.connect();
      const socket = socketAt(0);
      socket.open();

      expect(socket.types).toEqual([MQTT_PACKET.connect]);

      socket.deliver(connack(0));
      await connected;

      expect(socket.types).toEqual([MQTT_PACKET.connect, MQTT_PACKET.subscribe]);
      expect(new TextDecoder().decode(socket.last)).toContain('wireon/room/AAA111');
      client.end();
    });

    it('подписка на живом соединении уходит сразу', async () => {
      const client = makeClient();
      const socket = await bringOnline(client);

      client.subscribe('wireon/room/BBB222');

      expect(socket.types).toEqual([MQTT_PACKET.connect, MQTT_PACKET.subscribe]);
      client.end();
    });

    it('восстанавливает подписки после переподключения', async () => {
      vi.useFakeTimers();
      const client = makeClient();
      const first = client.connect();
      socketAt(0).open();
      socketAt(0).deliver(connack(0));
      await first;
      client.subscribe('wireon/room/CCC333');

      socketAt(0).drop();
      vi.advanceTimersByTime(1000);
      socketAt(1).open();
      socketAt(1).deliver(connack(0));

      expect(socketAt(1).types).toEqual([MQTT_PACKET.connect, MQTT_PACKET.subscribe]);
      expect(new TextDecoder().decode(socketAt(1).last)).toContain('wireon/room/CCC333');
      client.end();
    });

    it('publish в офлайне возвращает false и ничего не пишет', () => {
      const client = makeClient();
      expect(client.publish('t', 'x')).toBe(false);
      expect(FakeSocket.instances).toHaveLength(0);
    });

    it('publish на живом соединении доходит до брокера с нужным retain', async () => {
      const client = makeClient();
      const socket = await bringOnline(client);

      expect(client.publish('wireon/room/DDD444', '{"a":1}', { retain: true })).toBe(true);

      expect(socket.last[0]).toBe(0x31);
      expect(new TextDecoder().decode(socket.last)).toContain('{"a":1}');
      client.end();
    });

    it('раздаёт входящие сообщения слушателям с темой и признаком снимка', async () => {
      const client = makeClient();
      const socket = await bringOnline(client);
      const received: Array<[string, string, boolean]> = [];
      const off = client.onMessage((topic, payload, retained) => received.push([topic, payload, retained]));

      socket.deliver(encodePublish('wireon/room/EEE555', 'свежее'));
      socket.deliver(encodePublish('wireon/room/EEE555', 'снимок', { retain: true }));

      expect(received).toEqual([
        ['wireon/room/EEE555', 'свежее', false],
        ['wireon/room/EEE555', 'снимок', true]
      ]);

      off();
      socket.deliver(encodePublish('wireon/room/EEE555', 'после отписки'));
      expect(received).toHaveLength(2);
      client.end();
    });

    it('упавший слушатель не мешает остальным', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const client = makeClient();
      const socket = await bringOnline(client);
      const seen: string[] = [];
      client.onMessage(() => {
        throw new Error('обработчик сломался');
      });
      client.onMessage((_topic, payload) => seen.push(payload));

      socket.deliver(encodePublish('t', 'дошло'));

      expect(seen).toEqual(['дошло']);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      client.end();
    });

    it('собирает сообщение из разорванных кадров', async () => {
      const client = makeClient();
      const socket = await bringOnline(client);
      const received: string[] = [];
      client.onMessage((_topic, payload) => received.push(payload));

      const packet = encodePublish('wireon/room/FFF666', JSON.stringify({ type: 'sync_state' }));
      socket.deliver(packet.subarray(0, 5));
      expect(received).toHaveLength(0);
      socket.deliver(packet.subarray(5));

      expect(received).toEqual([JSON.stringify({ type: 'sync_state' })]);
      client.end();
    });

    it('принимает и ArrayBuffer, и строку — как разные брокеры и присылают', async () => {
      const client = makeClient();
      const socket = await bringOnline(client);
      const received: string[] = [];
      client.onMessage((_topic, payload) => received.push(payload));

      const bytes = encodePublish('t', 'ab');
      socket.deliver(bytes.slice().buffer);
      socket.deliver('\x30\x05\x00\x01t' + 'cd');

      expect(received).toEqual(['ab', 'cd']);
      client.end();
    });

    it('на мусорный поток честно отваливается, а не молчит', async () => {
      const client = makeClient({ reconnect: false });
      const socket = await bringOnline(client);

      socket.deliver(new Uint8Array([0x30, 0x80, 0x80, 0x80, 0x80, 0x01]));

      expect(client.status).toBe('offline');
      expect(client.error).toBe('Брокер прислал некорректный пакет');
    });
  });

  describe('Keepalive', () => {
    it('пингует брокер, не дожидаясь конца интервала', async () => {
      vi.useFakeTimers();
      const client = makeClient({ keepAliveSeconds: 10 });
      const socket = await bringOnline(client);

      vi.advanceTimersByTime(7500);

      expect(socket.types.filter((t) => t === MQTT_PACKET.pingreq)).toHaveLength(1);
      expect(client.status).toBe('online');
      client.end();
    });

    it('считает молчащий сокет мёртвым и переподключается', async () => {
      vi.useFakeTimers();
      const client = makeClient({ keepAliveSeconds: 10, endpoints: ['wss://a/mqtt', 'wss://b/mqtt'] });
      await bringOnline(client);

      // Локально сокет «открыт», но с той стороны уже никого: PINGRESP не приходит.
      // Полтора интервала тишины (15 с) — и соединение объявляется мёртвым.
      vi.advanceTimersByTime(22500);

      expect(client.status).toBe('offline');
      expect(client.error).toBe('Брокер перестал отвечать');

      vi.advanceTimersByTime(1000);
      expect(FakeSocket.instances).toHaveLength(2);
      expect(socketAt(1).url).toBe('wss://b/mqtt');
      client.end();
    });

    it('PINGRESP продлевает жизнь соединению', async () => {
      vi.useFakeTimers();
      const client = makeClient({ keepAliveSeconds: 10 });
      const socket = await bringOnline(client);

      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(7500);
        socket.deliver(PINGRESP);
      }

      expect(client.status).toBe('online');
      expect(socket.types.filter((t) => t === MQTT_PACKET.pingreq)).toHaveLength(6);
      client.end();
    });
  });

  describe('Переподключение', () => {
    it('перебирает брокеров: первый упавший не значит, что упали все', async () => {
      vi.useFakeTimers();
      const client = makeClient({ endpoints: ['wss://a/mqtt', 'wss://b/mqtt', 'wss://c/mqtt'] });
      const failed = client.connect().catch(() => undefined);
      socketAt(0).open();
      socketAt(0).drop();
      await failed;

      vi.advanceTimersByTime(1000);
      expect(socketAt(1).url).toBe('wss://b/mqtt');
      expect(client.endpoint).toBe('wss://b/mqtt');

      socketAt(1).drop();
      vi.advanceTimersByTime(2000);
      expect(socketAt(2).url).toBe('wss://c/mqtt');

      socketAt(2).drop();
      vi.advanceTimersByTime(5000);
      expect(socketAt(3).url).toBe('wss://a/mqtt');
      client.end();
    });

    it('растягивает паузы между попытками и обнуляет их после успеха', async () => {
      vi.useFakeTimers();
      const client = makeClient();
      const failed = client.connect().catch(() => undefined);
      socketAt(0).open();
      socketAt(0).drop();
      await failed;

      vi.advanceTimersByTime(999);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(2);

      socketAt(1).drop();
      vi.advanceTimersByTime(1999);
      expect(FakeSocket.instances).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(3);

      // Успех сбрасывает счётчик: следующий обрыв снова ждёт секунду.
      socketAt(2).open();
      socketAt(2).deliver(connack(0));
      socketAt(2).drop();
      vi.advanceTimersByTime(1000);
      expect(FakeSocket.instances).toHaveLength(4);
      client.end();
    });

    it('с reconnect: false обрыв остаётся обрывом', async () => {
      vi.useFakeTimers();
      const client = makeClient({ reconnect: false });
      const failed = client.connect().catch(() => undefined);
      socketAt(0).open();
      socketAt(0).drop();
      await failed;

      vi.advanceTimersByTime(60000);

      expect(FakeSocket.instances).toHaveLength(1);
      expect(client.status).toBe('offline');
    });

    it('сообщает подписчикам каждую смену статуса', async () => {
      const client = makeClient({ reconnect: false });
      const seen: Array<[string, string | null]> = [];
      client.onStatus((status, error) => seen.push([status, error]));

      const connected = client.connect();
      socketAt(0).open();
      socketAt(0).deliver(connack(0));
      await connected;
      client.end();

      expect(seen).toEqual([
        ['idle', null],
        ['connecting', null],
        ['online', null],
        ['idle', null]
      ]);
    });
  });

  describe('end()', () => {
    it('прощается по-человечески, чтобы завещание не сработало', async () => {
      const client = makeClient();
      const socket = await bringOnline(client);

      client.end();

      // DISCONNECT отменяет last will: иначе все увидели бы «вышел из комнаты».
      expect(Array.from(socket.last)).toEqual([0xe0, 0x00]);
      expect(socket.closeCalls).toBe(1);
      expect(client.status).toBe('idle');
    });

    it('после end() не переподключается и не пингует', async () => {
      vi.useFakeTimers();
      const client = makeClient();
      const socket = await bringOnline(client);
      const sentBefore = socket.sent.length;

      client.end();
      socket.drop();
      vi.advanceTimersByTime(60000);

      expect(FakeSocket.instances).toHaveLength(1);
      expect(socket.sent).toHaveLength(sentBefore + 1); // только DISCONNECT
      expect(client.status).toBe('idle');
    });

    it('на неподключённом клиенте безопасен', () => {
      const client = makeClient();
      expect(() => client.end()).not.toThrow();
      expect(client.status).toBe('idle');
    });
  });
});
