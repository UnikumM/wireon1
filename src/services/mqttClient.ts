/**
 * Minimal MQTT 3.1.1 client over WebSocket.
 *
 * Wireon needs exactly one thing from a message broker: two machines that know a
 * room code must see each other's JSON. Public MQTT brokers give that away for
 * free over `wss://`, but they speak the MQTT wire protocol — sending raw JSON
 * down the socket (as the first version of group listening did) gets the
 * connection dropped without a word, which is why it only ever worked between
 * tabs of one browser.
 *
 * So this file speaks MQTT properly: CONNECT/CONNACK, SUBSCRIBE/SUBACK, QoS 0
 * PUBLISH, PINGREQ keepalive, DISCONNECT, and a last will so a crashed peer stops
 * being listed as present. That is the whole protocol surface a listening party
 * needs, which is why it is hand-rolled instead of pulling in `mqtt` and its
 * Node-shim tail: ~300 bytes on the wire per packet, byte-exact tests, no bundler
 * polyfills.
 *
 * Not implemented on purpose: QoS 1/2 (a lost position update is replaced by the
 * next one 500 ms later), username/password (public brokers are anonymous), and
 * MQTT 5 properties.
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Packet type nibbles, as they appear in the fixed header's high 4 bits. */
export const MQTT_PACKET = {
  connect: 1,
  connack: 2,
  publish: 3,
  subscribe: 8,
  suback: 9,
  pingreq: 12,
  pingresp: 13,
  disconnect: 14
} as const;

/** A CONNACK return code other than 0 means the broker refused us. */
export const MQTT_CONNACK_MESSAGES: Record<number, string> = {
  0: 'Соединение принято',
  1: 'Брокер не поддерживает эту версию протокола',
  2: 'Идентификатор клиента отклонён',
  3: 'Сервис недоступен',
  4: 'Неверные логин или пароль',
  5: 'Подключение не авторизовано'
};

export class MqttProtocolError extends Error {}

export interface MqttWill {
  topic: string;
  payload: string;
  retain?: boolean;
}

export interface MqttConnectOptions {
  clientId: string;
  keepAliveSeconds?: number;
  will?: MqttWill;
}

export interface MqttPacket {
  type: number;
  topic?: string;
  payload?: string;
  returnCode?: number;
  retain?: boolean;
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** Remaining Length: 7 bits per byte, high bit continues. Max 4 bytes. */
export function encodeRemainingLength(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 268435455) {
    throw new RangeError(`Remaining length out of range: ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

/** Returns null when the varint is not fully present yet — a split WS frame. */
export function decodeRemainingLength(
  bytes: Uint8Array,
  offset: number
): { value: number; bytesRead: number } | null {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 4; index++) {
    if (offset + index >= bytes.length) return null;
    const byte = bytes[offset + index];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, bytesRead: index + 1 };
    multiplier *= 128;
  }
  throw new MqttProtocolError('Remaining length exceeds four bytes');
}

function mqttString(text: string): Uint8Array {
  const bytes = TEXT_ENCODER.encode(text);
  if (bytes.length > 0xffff) {
    throw new RangeError(`MQTT string too long: ${bytes.length} bytes`);
  }
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

function buildPacket(type: number, flags: number, parts: Uint8Array[]): Uint8Array {
  const bodyLength = parts.reduce((sum, part) => sum + part.length, 0);
  const lengthBytes = encodeRemainingLength(bodyLength);
  const out = new Uint8Array(1 + lengthBytes.length + bodyLength);
  out[0] = ((type << 4) | flags) & 0xff;
  out.set(lengthBytes, 1);
  let offset = 1 + lengthBytes.length;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodeConnect(options: MqttConnectOptions): Uint8Array {
  const keepAlive = Math.min(65535, Math.max(5, Math.round(options.keepAliveSeconds ?? 45)));
  // Clean session: nothing is worth keeping between two listening parties.
  let flags = 0x02;
  if (options.will) {
    flags |= 0x04;
    if (options.will.retain) flags |= 0x20;
  }

  const variableHeader = new Uint8Array([
    0x00,
    0x04,
    0x4d, // M
    0x51, // Q
    0x54, // T
    0x54, // T
    0x04, // protocol level 4 = MQTT 3.1.1
    flags,
    (keepAlive >> 8) & 0xff,
    keepAlive & 0xff
  ]);

  const parts = [variableHeader, mqttString(options.clientId)];
  if (options.will) {
    parts.push(mqttString(options.will.topic), mqttString(options.will.payload));
  }
  return buildPacket(MQTT_PACKET.connect, 0, parts);
}

export function encodeSubscribe(topic: string, packetId: number): Uint8Array {
  const id = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
  // SUBSCRIBE is required to carry the QoS 1 flags nibble (0x02).
  return buildPacket(MQTT_PACKET.subscribe, 0x02, [id, mqttString(topic), new Uint8Array([0x00])]);
}

export function encodePublish(topic: string, payload: string, options: { retain?: boolean } = {}): Uint8Array {
  return buildPacket(MQTT_PACKET.publish, options.retain ? 0x01 : 0x00, [
    mqttString(topic),
    TEXT_ENCODER.encode(payload)
  ]);
}

export function encodePingReq(): Uint8Array {
  return buildPacket(MQTT_PACKET.pingreq, 0, []);
}

export function encodeDisconnect(): Uint8Array {
  return buildPacket(MQTT_PACKET.disconnect, 0, []);
}

/**
 * Decodes every complete packet in `buffer` and hands back the unconsumed tail,
 * because a WebSocket frame boundary has nothing to do with a packet boundary.
 */
export function decodePackets(buffer: Uint8Array): { packets: MqttPacket[]; rest: Uint8Array } {
  const packets: MqttPacket[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const header = buffer[offset];
    const length = decodeRemainingLength(buffer, offset + 1);
    if (!length) break;

    const bodyStart = offset + 1 + length.bytesRead;
    const bodyEnd = bodyStart + length.value;
    if (bodyEnd > buffer.length) break;

    const type = header >> 4;
    const body = buffer.subarray(bodyStart, bodyEnd);

    if (type === MQTT_PACKET.publish) {
      const topicLength = (body[0] << 8) | body[1];
      const qos = (header >> 1) & 0x03;
      // QoS > 0 inserts a packet identifier between topic and payload.
      const payloadStart = 2 + topicLength + (qos > 0 ? 2 : 0);
      packets.push({
        type,
        topic: TEXT_DECODER.decode(body.subarray(2, 2 + topicLength)),
        payload: TEXT_DECODER.decode(body.subarray(payloadStart)),
        retain: (header & 0x01) === 0x01
      });
    } else if (type === MQTT_PACKET.connack) {
      packets.push({ type, returnCode: body.length > 1 ? body[1] : 0 });
    } else {
      packets.push({ type });
    }

    offset = bodyEnd;
  }

  return { packets, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** The slice of `WebSocket` this client uses, so tests can supply a fake broker. */
export interface WebSocketLike {
  readyState: number;
  binaryType?: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type MqttStatus = 'idle' | 'connecting' | 'online' | 'offline';

export interface MqttClientOptions extends MqttConnectOptions {
  /** Tried in order, and rotated through on every reconnect. */
  endpoints: string[];
  connectTimeoutMs?: number;
  /** Reconnect after an unexpected close. Default true. */
  reconnect?: boolean;
  socketFactory?: (url: string) => WebSocketLike;
}

const OPEN = 1;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 20000];

function defaultSocketFactory(url: string): WebSocketLike {
  // The `mqtt` subprotocol is not optional: brokers reject the handshake without
  // it, and the failure looks exactly like a network problem.
  const socket = new WebSocket(url, 'mqtt') as unknown as WebSocketLike;
  socket.binaryType = 'arraybuffer';
  return socket;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return TEXT_ENCODER.encode(data);
  return null;
}

/**
 * A single broker connection: connect, stay connected, deliver messages.
 *
 * Every failure mode here ends in the same honest place — `status` goes
 * `offline` with a reason — because group listening has a working fallback
 * (same-machine BroadcastChannel) and the UI must be able to say which one is
 * live rather than claiming a room is synced when it is not.
 */
export class MqttClient {
  private socket: WebSocketLike | null = null;
  private buffer = new Uint8Array(0);
  private statusValue: MqttStatus = 'idle';
  private lastError: string | null = null;

  private endpointIndex = 0;
  private attempt = 0;
  private closedByUs = false;

  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private nextPacketId = 1;

  private readonly subscriptions = new Set<string>();
  private readonly messageListeners = new Set<(topic: string, payload: string, retained: boolean) => void>();
  private readonly statusListeners = new Set<(status: MqttStatus, error: string | null) => void>();
  private readonly socketFactory: (url: string) => WebSocketLike;

  constructor(private readonly options: MqttClientOptions) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
  }

  public get status(): MqttStatus {
    return this.statusValue;
  }

  public get error(): string | null {
    return this.lastError;
  }

  public get endpoint(): string {
    return this.options.endpoints[this.endpointIndex % this.options.endpoints.length] ?? '';
  }

  public onMessage(listener: (topic: string, payload: string, retained: boolean) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  public onStatus(listener: (status: MqttStatus, error: string | null) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.statusValue, this.lastError);
    return () => this.statusListeners.delete(listener);
  }

  /** Opens the socket. Resolves when the broker answers CONNACK, or rejects. */
  public connect(): Promise<void> {
    if (this.statusValue === 'online') return Promise.resolve();
    this.closedByUs = false;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // `onStatus` replays the current status to every new listener. A stale
      // `offline` left by a previous attempt must not reject the attempt we are
      // about to start, so the listener only counts once `openSocket` is under way.
      let live = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        offStatus();
        if (err) reject(err);
        else resolve();
      };

      const offStatus = this.onStatus((status, error) => {
        if (!live) return;
        if (status === 'online') finish();
        else if (status === 'offline') finish(new Error(error ?? 'Не удалось подключиться к брокеру'));
      });

      live = true;
      this.openSocket();
    });
  }

  public subscribe(topic: string): void {
    this.subscriptions.add(topic);
    if (this.statusValue === 'online') {
      this.send(encodeSubscribe(topic, this.takePacketId()));
    }
  }

  /** Returns false when the message could not be handed to the broker. */
  public publish(topic: string, payload: string, options: { retain?: boolean } = {}): boolean {
    if (this.statusValue !== 'online') return false;
    return this.send(encodePublish(topic, payload, options));
  }

  /** Graceful shutdown: DISCONNECT suppresses the will, so no false "left". */
  public end(): void {
    this.closedByUs = true;
    this.clearTimers();
    if (this.socket && this.socket.readyState === OPEN) {
      this.send(encodeDisconnect());
    }
    this.teardownSocket();
    this.setStatus('idle', null);
  }

  // -- internals ------------------------------------------------------------

  private openSocket(): void {
    this.teardownSocket();
    this.buffer = new Uint8Array(0);
    this.setStatus('connecting', null);

    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(this.endpoint);
    } catch (err) {
      this.failConnection(err instanceof Error ? err.message : 'Не удалось открыть соединение');
      return;
    }
    this.socket = socket;

    this.connectTimer = setTimeout(() => {
      this.failConnection('Брокер не ответил');
    }, this.options.connectTimeoutMs ?? 8000);

    socket.onopen = () => {
      this.send(
        encodeConnect({
          clientId: this.options.clientId,
          keepAliveSeconds: this.options.keepAliveSeconds,
          will: this.options.will
        })
      );
    };

    socket.onmessage = (event) => this.handleData(event.data);

    socket.onerror = () => {
      // `onclose` always follows, and it carries the retry decision.
      this.lastError = 'Ошибка соединения с брокером';
    };

    socket.onclose = () => {
      if (this.closedByUs) return;
      this.failConnection(this.lastError ?? 'Соединение с брокером закрыто');
    };
  }

  private handleData(data: unknown): void {
    const incoming = toBytes(data);
    if (!incoming) return;

    const merged = new Uint8Array(this.buffer.length + incoming.length);
    merged.set(this.buffer, 0);
    merged.set(incoming, this.buffer.length);

    let decoded: { packets: MqttPacket[]; rest: Uint8Array };
    try {
      decoded = decodePackets(merged);
    } catch {
      // A malformed stream cannot be resynchronised; drop it and let the
      // reconnect path start clean.
      this.failConnection('Брокер прислал некорректный пакет');
      return;
    }

    // Copied rather than kept as a view, so a 1-byte tail does not pin the whole
    // merged buffer in memory.
    this.buffer = new Uint8Array(decoded.rest);
    this.lastInboundAt = Date.now();

    for (const packet of decoded.packets) {
      this.handlePacket(packet);
    }
  }

  private handlePacket(packet: MqttPacket): void {
    switch (packet.type) {
      case MQTT_PACKET.connack: {
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        const code = packet.returnCode ?? 0;
        if (code !== 0) {
          this.closedByUs = true; // a refusal will not fix itself on retry
          this.teardownSocket();
          this.setStatus('offline', MQTT_CONNACK_MESSAGES[code] ?? `Брокер отказал (код ${code})`);
          return;
        }
        this.attempt = 0;
        // Subscribe *before* announcing `online`. A listener that publishes on
        // `online` (announcing itself to a room, say) can be answered instantly
        // by a peer, and that answer is dropped by the broker if our
        // subscription is not in place yet.
        for (const topic of this.subscriptions) {
          this.send(encodeSubscribe(topic, this.takePacketId()));
        }
        this.startKeepAlive();
        this.setStatus('online', null);
        return;
      }
      case MQTT_PACKET.publish: {
        if (!packet.topic) return;
        for (const listener of this.messageListeners) {
          try {
            listener(packet.topic, packet.payload ?? '', packet.retain === true);
          } catch (err) {
            console.warn('[mqtt] listener failed:', err);
          }
        }
        return;
      }
      default:
        // SUBACK and PINGRESP need no work beyond the liveness stamp above.
        return;
    }
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    const keepAliveMs = Math.max(5, this.options.keepAliveSeconds ?? 45) * 1000;
    this.lastInboundAt = Date.now();
    this.keepAliveTimer = setInterval(() => {
      // Silence for longer than one and a half keepalive periods means the
      // socket is a zombie: open locally, dead in the middle.
      if (Date.now() - this.lastInboundAt > keepAliveMs * 1.5) {
        this.failConnection('Брокер перестал отвечать');
        return;
      }
      this.send(encodePingReq());
    }, keepAliveMs * 0.75);
  }

  private failConnection(reason: string): void {
    this.clearTimers();
    this.teardownSocket();
    this.setStatus('offline', reason);
    if (this.options.reconnect === false || this.closedByUs) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt += 1;
    // Rotate brokers: the first one being down says nothing about the others.
    this.endpointIndex = (this.endpointIndex + 1) % Math.max(1, this.options.endpoints.length);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUs) this.openSocket();
    }, delay);
  }

  private send(bytes: Uint8Array): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(bytes);
      return true;
    } catch {
      return false;
    }
  }

  private takePacketId(): number {
    this.nextPacketId = this.nextPacketId >= 0xffff ? 1 : this.nextPacketId + 1;
    return this.nextPacketId;
  }

  private clearTimers(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }

  private setStatus(status: MqttStatus, error: string | null): void {
    if (this.statusValue === status && this.lastError === error) return;
    this.statusValue = status;
    this.lastError = error;
    for (const listener of this.statusListeners) {
      try {
        listener(status, error);
      } catch (err) {
        console.warn('[mqtt] status listener failed:', err);
      }
    }
  }
}
