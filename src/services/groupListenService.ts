import { UnifiedTrack } from '../types/music';
import { MqttClient, type MqttStatus, type WebSocketLike } from './mqttClient';
import {
  CLOCK_SAMPLE_LIMIT,
  DRIFT_THRESHOLD_SECONDS,
  clockSampleFromRoundTrip,
  estimateClock,
  projectHostPosition,
  pushClockSample,
  type ClockSample
} from './groupSync';

export type GroupMessageType =
  | 'sync_state'
  | 'heartbeat'
  | 'join'
  | 'leave'
  | 'chat'
  | 'queue_update'
  /** Clock probe from a listener; only the host answers it. */
  | 'ping'
  /** The host's answer, carrying the two timestamps a round trip needs. */
  | 'pong';

/**
 * What the room can honestly claim about itself.
 *
 * `local` is the important one: the broker is unreachable, so the room works
 * between windows of this machine and nowhere else. Reporting that as "connected"
 * is what made group listening look broken — everything seemed fine until the
 * other person swore they saw nothing.
 */
export type GroupConnectionStatus = 'offline' | 'connecting' | 'online' | 'local';

export interface GroupState {
  trackId?: string;
  track?: UnifiedTrack | null;
  isPlaying: boolean;
  currentTime: number;
  queue: UnifiedTrack[];
}

export interface GroupParticipant {
  id: string;
  username: string;
  isHost: boolean;
  joinedAt: number;
  lastSeen?: number;
  avatarUrl?: string;
  ping?: number;
}

export interface GroupListenMessage {
  type: GroupMessageType;
  roomId: string;
  senderId: string;
  senderName?: string;
  hostTimestamp: number;
  state: GroupState;
  chatText?: string;
  participant?: GroupParticipant;
  messageId?: string;
  /** `ping`/`pong`: the listener's clock when the probe left. */
  clientTime?: number;
  /** `pong`: the host's clock when the probe arrived. */
  hostReceivedAt?: number;
  /**
   * `pong`: who asked.
   *
   * Answers go to the same room topic as everything else, so every listener sees
   * every answer. Without this field each of them would fold a stranger's round
   * trip into its own clock estimate.
   */
  replyTo?: string;
}

export interface SyncAdjustmentResult {
  adjustedTime: number;
  isPlaying: boolean;
  /** Absolute distance between local and host position, in seconds. */
  drift: number;
  shouldSeek: boolean;
}

const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HEARTBEAT_INTERVAL_MS = 10000;
const PARTICIPANT_TIMEOUT_MS = 30000;
const BROADCAST_CHANNEL_NAME = 'wireon_group_listen';
const TOPIC_PREFIX = 'wireon/room/';
const KEEP_ALIVE_SECONDS = 30;
/** A retained snapshot older than this is history, not a position to seek to. */
const RETAINED_STATE_MAX_AGE_MS = 60000;
/** How often a listener re-measures the host's clock while in the room. */
const CLOCK_PROBE_INTERVAL_MS = 15000;
/**
 * Public anonymous brokers, tried in order. The room code is the only secret —
 * the same trust model as sharing a link — so nothing private goes over them:
 * track titles and positions, never account data.
 */
const DEFAULT_MQTT_WS_ENDPOINTS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];

/**
 * Broker list override, read from the environment rather than from a file.
 *
 * The public brokers above are a fallback anyone can use with no setup, but they
 * are shared with the whole internet and can disappear without notice. Anyone
 * running their own broker points `VITE_WIREON_MQTT_URL` at it (several URLs
 * separated by commas are allowed) and the public list is not touched. Nothing
 * secret belongs here either way — the value is a URL, not a credential, and it
 * is never written into the repository.
 */
export function resolveBrokerEndpoints(raw?: string | null): string[] {
  const candidates = (raw ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^wss?:\/\//i.test(url));
  return candidates.length > 0 ? candidates : DEFAULT_MQTT_WS_ENDPOINTS;
}

function configuredEndpoints(): string[] {
  let fromEnv: string | undefined;
  try {
    fromEnv = import.meta.env?.VITE_WIREON_MQTT_URL as string | undefined;
  } catch {
    fromEnv = undefined; // no bundler-injected env, e.g. under plain Node
  }
  return resolveBrokerEndpoints(fromEnv);
}

type MessageListener = (message: GroupListenMessage, adjustment: SyncAdjustmentResult | null) => void;
type ParticipantsListener = (participants: GroupParticipant[]) => void;
type StatusListener = (connected: boolean, error?: string | null) => void;
type ConnectionListener = (status: GroupConnectionStatus, error: string | null) => void;
/** `null` means the room currently has nobody claiming to lead it. */
type HostListener = (hostId: string | null) => void;
type ClockListener = (clock: { offsetMs: number; rttMs: number }) => void;

export interface GroupTransportOptions {
  /** Broker URLs to try. Defaults to the public list above. */
  endpoints?: string[];
  /** Injected in tests to run a fake broker; production uses a real WebSocket. */
  socketFactory?: (url: string) => WebSocketLike;
  /** false keeps everything on this machine (BroadcastChannel only). */
  enabled?: boolean;
}

/**
 * Group listening: one room, one host, everyone else following the host's clock.
 *
 * Two transports run side by side. MQTT over WebSocket carries the room between
 * machines; a `BroadcastChannel` carries it between windows of this machine and
 * keeps working when no broker can be reached. Both deliver the same JSON
 * messages, and `processedMessageIds` makes a message that arrives twice harmless.
 */
export class GroupListenService {
  private roomId: string | null = null;
  private userId: string = '';
  private username: string = 'User';
  private avatarUrl?: string;
  private isHost: boolean = false;
  private connected: boolean = false;
  private participants: Map<string, GroupParticipant> = new Map();
  private lastReceivedState: GroupState | null = null;
  /** The last snapshot this instance sent, i.e. what a host is playing. */
  private lastBroadcastState: GroupState | null = null;
  private messageLog: GroupListenMessage[] = [];

  private broadcastChannel: BroadcastChannel | null = null;
  private mqtt: MqttClient | null = null;
  private mqttOffMessage: (() => void) | null = null;
  private mqttOffStatus: (() => void) | null = null;
  private transportStatus: MqttStatus = 'idle';
  private transportError: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private messageListeners: Set<MessageListener> = new Set();
  private participantListeners: Set<ParticipantsListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private connectionListeners: Set<ConnectionListener> = new Set();
  private hostListeners: Set<HostListener> = new Set();
  private clockListeners: Set<ClockListener> = new Set();

  /**
   * Who the room takes orders from.
   *
   * A listener that has not met the host yet leaves this `null` and applies the
   * first `sync_state` it sees, because the alternative is silence. Once known,
   * everything from anyone else is dropped: two listeners answering each other's
   * snapshots is how a room ends up flipping tracks in a loop.
   */
  private hostId: string | null = null;
  private clockSamples: ClockSample[] = [];
  private clockOffsetMs = 0;
  private clockRttMs = 0;
  private clockProbeTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Probes still waiting for an answer, by their send time.
   *
   * An answer is only believed when it matches one of these. Room traffic is
   * public, so an unmatched `pong` is either somebody else's or made up, and
   * either way it would poison the clock estimate.
   */
  private pendingProbes: Set<number> = new Set();

  private processedMessageIds: Set<string> = new Set();
  private transportOptions: GroupTransportOptions = {};
  /** Set by the store so the host can answer a join with its live playback. */
  private stateProvider: (() => GroupState | null) | null = null;
  private messageSeq = 0;

  constructor(initialUserId?: string, initialUsername?: string) {
    this.userId = initialUserId || `user_${Math.random().toString(36).slice(2, 9)}`;
    this.username = initialUsername || 'Гость';
    this.initBroadcastChannel();
  }

  // =========================================================================
  // Room Code Utilities
  // =========================================================================

  /**
   * Generates a 6-character uppercase alphanumeric room code.
   */
  static generateRoomCode(): string {
    let code = '';
    for (let i = 0; i < 6; i++) {
      const idx = Math.floor(Math.random() * ROOM_CODE_CHARSET.length);
      code += ROOM_CODE_CHARSET.charAt(idx);
    }
    return code;
  }

  /**
   * Sanitizes and validates a 6-character room code.
   */
  static sanitizeRoomCode(code: string): string {
    if (!code || typeof code !== 'string') {
      throw new Error('Код комнаты — ровно 6 символов');
    }
    const sanitized = code.trim().toUpperCase();
    if (sanitized.length !== 6) {
      throw new Error('Код комнаты — ровно 6 символов');
    }
    if (!/^[A-Z0-9]{6}$/.test(sanitized)) {
      throw new Error('В коде комнаты только латинские буквы и цифры');
    }
    return sanitized;
  }

  // =========================================================================
  // Initialization & Transport
  // =========================================================================

  public setUser(userId: string, username: string, avatarUrl?: string): void {
    this.userId = userId;
    this.username = username;
    this.avatarUrl = avatarUrl;
    if (this.roomId && this.participants.has(userId)) {
      const p = this.participants.get(userId)!;
      p.username = username;
      p.avatarUrl = avatarUrl;
      this.notifyParticipants();
    }
  }

  /** Injection point for tests and for a fully local mode. */
  public configureTransport(options: GroupTransportOptions): void {
    this.transportOptions = { ...this.transportOptions, ...options };
  }

  /** The host registers its live playback here so joiners get the real position. */
  public setStateProvider(provider: (() => GroupState | null) | null): void {
    this.stateProvider = provider;
  }

  private topic(): string {
    return `${TOPIC_PREFIX}${this.roomId ?? 'none'}`;
  }

  /**
   * A unique id per message, used to drop the duplicate that arrives when both
   * transports deliver the same thing. `Date.now()` alone is not enough: two
   * position updates in the same millisecond would share an id and the second
   * one would be discarded as an echo.
   */
  private nextMessageId(kind: string): string {
    this.messageSeq += 1;
    return `${this.userId}_${Date.now()}_${this.messageSeq}_${kind}`;
  }

  private initBroadcastChannel(): void {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
        this.broadcastChannel.onmessage = (event: MessageEvent) => {
          if (event.data && typeof event.data === 'object' && event.data.roomId === this.roomId) {
            this.handleInboundMessage(event.data as GroupListenMessage);
          }
        };
      } catch {
        this.broadcastChannel = null;
      }
    }
  }

  /**
   * Opens the broker connection for the current room.
   *
   * Deliberately not awaited by `createRoom`/`joinRoom`: the room is usable the
   * moment it exists locally, and the connection state is reported separately as
   * it changes. Waiting would make joining feel broken on a slow network while
   * telling the user nothing.
   */
  private connectBroker(): void {
    this.disconnectBroker();
    if (this.transportOptions.enabled === false || !this.roomId) {
      this.notifyConnection();
      return;
    }

    const factory = this.transportOptions.socketFactory;
    if (!factory && typeof WebSocket === 'undefined') {
      this.notifyConnection();
      return;
    }

    const topic = this.topic();
    const leaveMessage: GroupListenMessage = {
      type: 'leave',
      roomId: this.roomId,
      senderId: this.userId,
      senderName: this.username,
      hostTimestamp: Date.now(),
      state: { isPlaying: false, currentTime: 0, queue: [] },
      messageId: `${this.userId}_will_leave`
    };

    const client = new MqttClient({
      endpoints: this.transportOptions.endpoints ?? configuredEndpoints(),
      // Broker-unique per session: two windows of one machine must not evict
      // each other, which is what a room-derived client id would do.
      clientId: `wireon_${this.userId}_${Date.now().toString(36)}`.slice(0, 64),
      keepAliveSeconds: KEEP_ALIVE_SECONDS,
      // A crashed peer never sends `leave`; the broker sends this for it.
      will: { topic, payload: JSON.stringify(leaveMessage) },
      socketFactory: factory
    });

    this.mqtt = client;
    this.mqttOffMessage = client.onMessage((incomingTopic, payload, retained) => {
      if (incomingTopic !== this.topic()) return;
      this.handleBrokerPayload(payload, retained);
    });
    this.mqttOffStatus = client.onStatus((status, error) => {
      this.transportStatus = status;
      this.transportError = error;
      this.notifyConnection();
      // A reconnect drops the subscription's view of the room, so re-announce.
      if (status === 'online' && this.connected) {
        this.publishSelfPresence();
        // The old clock samples were measured over a connection that no longer
        // exists, quite possibly to a different broker; keeping them would carry
        // a stale offset into the new route.
        if (!this.isHost) {
          this.clockSamples = [];
          this.sendClockProbe();
        }
      }
    });

    client.subscribe(topic);
    void client.connect().catch(() => {
      // Already reported through `onStatus`; the local transport carries on.
    });
  }

  private disconnectBroker(): void {
    this.mqttOffMessage?.();
    this.mqttOffStatus?.();
    this.mqttOffMessage = null;
    this.mqttOffStatus = null;
    if (this.mqtt) {
      this.mqtt.end();
      this.mqtt = null;
    }
    this.transportStatus = 'idle';
    this.transportError = null;
  }

  private handleBrokerPayload(payload: string, retained: boolean): void {
    let message: GroupListenMessage;
    try {
      message = JSON.parse(payload) as GroupListenMessage;
    } catch {
      return; // someone else's traffic on a colliding topic
    }
    if (!message || typeof message !== 'object' || message.roomId !== this.roomId) return;

    if (retained) {
      // The broker replays the host's last snapshot to every joiner. Useful
      // within a minute, misleading after that — an hour-old position would be
      // "compensated" forward by an hour.
      const age = Date.now() - (message.hostTimestamp || 0);
      if (age > RETAINED_STATE_MAX_AGE_MS) return;
    }

    this.handleInboundMessage(message);
  }

  /** Re-announces this participant, e.g. after a reconnect. */
  private publishSelfPresence(): void {
    if (!this.roomId) return;
    const self = this.selfParticipant();
    this.emitTransportMessage({
      type: 'join',
      roomId: this.roomId,
      senderId: this.userId,
      senderName: this.username,
      hostTimestamp: Date.now(),
      state: { isPlaying: false, currentTime: 0, queue: [] },
      participant: self,
      messageId: this.nextMessageId('join')
    });
  }

  private selfParticipant(): GroupParticipant {
    const existing = this.participants.get(this.userId);
    const self: GroupParticipant = existing ?? {
      id: this.userId,
      username: this.username,
      isHost: this.isHost,
      joinedAt: Date.now(),
      avatarUrl: this.avatarUrl
    };
    self.lastSeen = Date.now();
    self.username = this.username;
    self.isHost = this.isHost;
    self.avatarUrl = this.avatarUrl;
    this.participants.set(this.userId, self);
    return self;
  }

  // =========================================================================
  // Host role & clock synchronisation
  // =========================================================================

  /**
   * Records who the room takes orders from and tells the UI.
   *
   * `null` is a real, reportable state, not "unknown yet" — it is what a listener
   * sees the moment the host's window closes, and the interface has to say so
   * instead of pretending the room is still being led.
   */
  private setHostId(hostId: string | null): void {
    if (this.hostId === hostId) return;
    this.hostId = hostId;
    for (const listener of this.hostListeners) {
      try {
        listener(hostId);
      } catch (err) {
        console.error('[GroupListenService] Host listener error:', err);
      }
    }
  }

  private resetClock(): void {
    this.clockSamples = [];
    this.clockOffsetMs = 0;
    this.clockRttMs = 0;
    this.pendingProbes.clear();
  }

  private notifyClock(): void {
    const snapshot = { offsetMs: this.clockOffsetMs, rttMs: this.clockRttMs };
    for (const listener of this.clockListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error('[GroupListenService] Clock listener error:', err);
      }
    }
  }

  /**
   * Listeners keep re-measuring the host's clock for as long as they are in the room.
   *
   * One measurement at join time is not enough: consumer clocks drift by seconds a
   * day, the route can change under a reconnect, and a single sample can land in a
   * router queue. Re-probing costs two tiny messages a quarter-minute.
   */
  private startClockProbe(): void {
    this.stopClockProbe();
    if (this.isHost) return; // the host is the reference; it has nobody to ask
    this.sendClockProbe();
    this.clockProbeTimer = setInterval(() => this.sendClockProbe(), CLOCK_PROBE_INTERVAL_MS);
  }

  private stopClockProbe(): void {
    if (this.clockProbeTimer) {
      clearInterval(this.clockProbeTimer);
      this.clockProbeTimer = null;
    }
    this.pendingProbes.clear();
  }

  /** Sends one clock probe. Public only so tests can force a measurement. */
  public sendClockProbe(): void {
    if (!this.connected || !this.roomId || this.isHost) return;

    const clientTime = Date.now();
    this.pendingProbes.add(clientTime);
    // Unanswered probes are dead weight; keeping a handful is enough to match the
    // answers that do arrive.
    if (this.pendingProbes.size > 4) {
      const oldest = this.pendingProbes.values().next().value;
      if (oldest !== undefined) this.pendingProbes.delete(oldest);
    }

    this.emitTransportMessage({
      type: 'ping',
      roomId: this.roomId,
      senderId: this.userId,
      senderName: this.username,
      hostTimestamp: clientTime,
      clientTime,
      state: { isPlaying: false, currentTime: 0, queue: [] },
      messageId: this.nextMessageId('ping')
    });
  }

  /** The host answers a probe, adding the two timestamps only it can supply. */
  private answerClockProbe(message: GroupListenMessage): void {
    if (!this.isHost || !this.connected || !this.roomId) return;
    if (typeof message.clientTime !== 'number' || !Number.isFinite(message.clientTime)) return;

    const hostReceivedAt = Date.now();
    this.emitTransportMessage({
      type: 'pong',
      roomId: this.roomId,
      senderId: this.userId,
      senderName: this.username,
      // Sent last, so the pair (received, sent) exposes how long the host itself held it.
      hostTimestamp: Date.now(),
      hostReceivedAt,
      clientTime: message.clientTime,
      replyTo: message.senderId,
      state: { isPlaying: false, currentTime: 0, queue: [] },
      messageId: this.nextMessageId('pong')
    });
  }

  /** A listener folds the host's answer into its clock estimate. */
  private applyClockProbeAnswer(message: GroupListenMessage): void {
    if (message.replyTo !== this.userId) return;

    const t0 = message.clientTime;
    const t1 = message.hostReceivedAt;
    const t2 = message.hostTimestamp;
    const t3 = Date.now();
    if (typeof t0 !== 'number' || typeof t1 !== 'number' || typeof t2 !== 'number') return;
    if (!this.pendingProbes.delete(t0)) return; // not an answer to anything we asked
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) return;

    // The answer proves the sender is the host: nobody else replies to probes.
    this.setHostId(message.senderId);

    const sample = clockSampleFromRoundTrip(t0, t1, t2, t3);
    this.clockSamples = pushClockSample(this.clockSamples, sample, CLOCK_SAMPLE_LIMIT);
    const estimate = estimateClock(this.clockSamples);
    if (!estimate) return;

    this.clockOffsetMs = estimate.offsetMs;
    this.clockRttMs = estimate.rttMs;

    const self = this.participants.get(this.userId);
    if (self) {
      self.ping = Math.round(estimate.rttMs);
      this.notifyParticipants();
    }
    this.notifyClock();
  }

  // =========================================================================
  // Room Lifecycle (Create, Join, Leave)
  // =========================================================================

  /**
   * Creates a new Group Listen room as Host.
   */
  public async createRoom(customCode?: string): Promise<string> {
    const code = customCode ? GroupListenService.sanitizeRoomCode(customCode) : GroupListenService.generateRoomCode();
    this.roomId = code;
    this.isHost = true;
    this.connected = true;
    this.participants.clear();
    this.setHostId(this.userId);
    this.resetClock();

    const hostParticipant: GroupParticipant = {
      id: this.userId,
      username: this.username,
      isHost: true,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      avatarUrl: this.avatarUrl
    };
    this.participants.set(this.userId, hostParticipant);

    this.connectBroker();
    this.startHeartbeat();

    // Broadcast join
    this.emitTransportMessage({
      type: 'join',
      roomId: code,
      senderId: this.userId,
      senderName: this.username,
      hostTimestamp: Date.now(),
      state: { isPlaying: false, currentTime: 0, queue: [] },
      participant: hostParticipant,
      messageId: this.nextMessageId('join')
    });

    this.notifyParticipants();
    this.notifyStatus(true);
    this.notifyConnection();
    return code;
  }

  /**
   * Joins an existing Group Listen room by 6-char code as Peer/Member.
   */
  public async joinRoom(code: string): Promise<boolean> {
    const sanitized = GroupListenService.sanitizeRoomCode(code);
    this.roomId = sanitized;
    this.isHost = false;
    this.connected = true;
    this.participants.clear();
    // Whoever the previous room called host is irrelevant here, and an offset
    // measured against their clock is worse than no offset at all.
    this.setHostId(null);
    this.resetClock();

    const selfParticipant: GroupParticipant = {
      id: this.userId,
      username: this.username,
      isHost: false,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      avatarUrl: this.avatarUrl
    };
    this.participants.set(this.userId, selfParticipant);

    this.connectBroker();
    this.startHeartbeat();
    this.startClockProbe();

    // Announce join to room peers
    this.emitTransportMessage({
      type: 'join',
      roomId: sanitized,
      senderId: this.userId,
      senderName: this.username,
      hostTimestamp: Date.now(),
      state: { isPlaying: false, currentTime: 0, queue: [] },
      participant: selfParticipant,
      messageId: this.nextMessageId('join')
    });

    this.notifyParticipants();
    this.notifyStatus(true);
    this.notifyConnection();
    return true;
  }

  /**
   * Leaves the active Group Listen room and cleans up resources.
   */
  public leaveRoom(): void {
    if (this.connected && this.roomId) {
      this.emitTransportMessage({
        type: 'leave',
        roomId: this.roomId,
        senderId: this.userId,
        senderName: this.username,
        hostTimestamp: Date.now(),
        state: { isPlaying: false, currentTime: 0, queue: [] },
        messageId: this.nextMessageId('leave')
      });

      // The host's retained snapshot must not outlive the room, or the next
      // person to use this code joins a session that ended yesterday. An empty
      // retained payload is how MQTT deletes one.
      if (this.isHost) {
        this.mqtt?.publish(this.topic(), '', { retain: true });
      }
    }

    this.stopHeartbeat();
    this.stopClockProbe();
    this.disconnectBroker();
    this.roomId = null;
    this.isHost = false;
    this.connected = false;
    this.participants.clear();
    this.lastReceivedState = null;
    this.lastBroadcastState = null;
    this.messageLog = [];
    this.processedMessageIds.clear();
    this.resetClock();
    this.setHostId(null);

    this.notifyParticipants();
    this.notifyStatus(false);
    this.notifyConnection();
  }

  // =========================================================================
  // State Broadcasting & Reception
  // =========================================================================

  /**
   * Publishes playback state to the room. Host only.
   *
   * The role check is the point: a listener's own player is being pushed around
   * by the host, so anything it published would be a stale echo of the host's own
   * command — and every other listener would obey it.
   */
  public broadcastState(state: GroupState): GroupListenMessage | null {
    if (!this.connected || !this.roomId || !this.isHost) return null;

    const message: GroupListenMessage = {
      type: 'sync_state',
      roomId: this.roomId,
      senderId: this.userId,
      senderName: this.username,
      hostTimestamp: Date.now(),
      state: {
        trackId: state.trackId || state.track?.id,
        track: state.track || null,
        isPlaying: Boolean(state.isPlaying),
        currentTime: typeof state.currentTime === 'number' && Number.isFinite(state.currentTime) ? state.currentTime : 0,
        queue: Array.isArray(state.queue) ? state.queue : []
      },
      messageId: this.nextMessageId('sync')
    };

    this.messageLog.push(message);
    this.lastBroadcastState = message.state;
    // Retained, so that whoever joins next is handed the current position by the
    // broker instead of waiting for the host's next update.
    this.emitTransportMessage(message, { retain: this.isHost });
    return message;
  }

  /**
   * Sends a text chat message in the room.
   */
  public sendChat(text: string): GroupListenMessage | null {
    if (!this.connected || !this.roomId || !text.trim()) return null;

    const message: GroupListenMessage = {
      type: 'chat',
      roomId: this.roomId,
      senderId: this.userId,
      senderName: this.username,
      hostTimestamp: Date.now(),
      chatText: text.trim(),
      state: this.lastReceivedState || { isPlaying: false, currentTime: 0, queue: [] },
      messageId: this.nextMessageId('chat')
    };

    this.messageLog.push(message);
    this.emitTransportMessage(message);
    return message;
  }

  /**
   * Processes an incoming message and computes drift-compensated playback timing.
   */
  public receiveMessage(message: GroupListenMessage, localCurrentTime?: number): SyncAdjustmentResult {
    if (!message || typeof message !== 'object') {
      throw new Error('Invalid message payload');
    }

    if (message.roomId !== this.roomId) {
      throw new Error('Room ID mismatch');
    }

    this.messageLog.push(message);

    // Track sender in participant list
    if (message.senderId && message.senderId !== this.userId) {
      const existing = this.participants.get(message.senderId);
      if (existing) {
        existing.lastSeen = Date.now();
        if (message.senderName) existing.username = message.senderName;
        if (message.participant) {
          // A presence message is the authority on the role: someone who took over
          // as host must stop being listed as an ordinary listener.
          existing.isHost = message.participant.isHost;
          existing.avatarUrl = message.participant.avatarUrl ?? existing.avatarUrl;
        }
        if (message.participant) this.notifyParticipants();
      } else if (message.participant) {
        this.participants.set(message.senderId, {
          ...message.participant,
          lastSeen: Date.now()
        });
        this.notifyParticipants();
      } else {
        this.participants.set(message.senderId, {
          id: message.senderId,
          username: message.senderName || 'Слушатель',
          isHost: false,
          joinedAt: Date.now(),
          lastSeen: Date.now()
        });
        this.notifyParticipants();
      }
    }

    // Who leads the room. The flag is set by `createRoom` and travels with the
    // sender's own participant record, so it cannot be claimed on someone's behalf.
    if (message.senderId !== this.userId) {
      if (message.participant?.isHost) {
        this.setHostId(message.senderId);
      } else if (message.type === 'sync_state' && !this.isHost && !this.hostId) {
        // No presence message has arrived yet — but only a host publishes
        // snapshots, so the first one identifies him. Without this a listener that
        // joined mid-session would ignore every command until the next heartbeat.
        this.setHostId(message.senderId);
      }
    }

    if (message.type === 'leave' && message.senderId) {
      this.participants.delete(message.senderId);
      // The room is now leaderless. Said out loud rather than papered over: the
      // remaining listeners keep playing, but nothing will steer them any more.
      if (message.senderId === this.hostId) this.setHostId(null);
      this.notifyParticipants();
    }

    // Where the host is now, not where he was when the snapshot left him. The
    // measured clock offset is what separates "the network took 400 ms" from
    // "our two computers disagree about what time it is".
    const adjustedTime = projectHostPosition(
      {
        senderId: message.senderId,
        hostTimestamp: message.hostTimestamp || Date.now(),
        trackId: message.state?.trackId,
        isPlaying: Boolean(message.state?.isPlaying),
        currentTime: message.state?.currentTime ?? 0
      },
      Date.now(),
      this.clockOffsetMs
    );
    const isPlaying = Boolean(message.state?.isPlaying);

    const currentLocal = typeof localCurrentTime === 'number' ? localCurrentTime : adjustedTime;
    const drift = Math.abs(currentLocal - adjustedTime);
    const shouldSeek = drift > DRIFT_THRESHOLD_SECONDS;

    this.lastReceivedState = {
      trackId: message.state?.trackId,
      track: message.state?.track,
      isPlaying,
      currentTime: adjustedTime,
      queue: message.state?.queue || []
    };

    return {
      adjustedTime,
      isPlaying,
      drift,
      shouldSeek
    };
  }

  private handleInboundMessage(message: GroupListenMessage): void {
    if (!message || message.roomId !== this.roomId) return;
    if (message.senderId === this.userId) return; // ignore own echoes

    if (message.messageId) {
      if (this.processedMessageIds.has(message.messageId)) return;
      this.processedMessageIds.add(message.messageId);
      if (this.processedMessageIds.size > 200) {
        const first = this.processedMessageIds.values().next().value;
        if (first) this.processedMessageIds.delete(first);
      }
    }

    // Clock probes carry no playback state, so they skip the sync path entirely.
    if (message.type === 'ping') {
      this.answerClockProbe(message);
      return;
    }
    if (message.type === 'pong') {
      this.applyClockProbeAnswer(message);
      return;
    }

    // Handle heartbeats & state
    if (message.type === 'heartbeat') {
      if (message.participant) {
        this.participants.set(message.senderId, {
          ...message.participant,
          lastSeen: Date.now()
        });
        if (message.participant.isHost) this.setHostId(message.senderId);
        this.notifyParticipants();
      }
      return;
    }

    if (message.type === 'join') {
      // A newcomer arrives knowing nobody, so everyone already in the room
      // answers with their own presence — otherwise the participant list stays
      // empty until the next heartbeat, ten seconds later.
      //
      // The reply is a heartbeat rather than another `join` on purpose:
      // heartbeats are not answered, so two peers cannot greet each other
      // forever.
      this.sendHeartbeat();

      if (this.isHost) {
        // Answer with what the host is actually playing. The old code replayed
        // `lastReceivedState`, but a host only ever receives other people's
        // joins and heartbeats — so a joiner was handed a zeroed position.
        const live = this.stateProvider?.() ?? this.lastBroadcastState;
        if (live) this.broadcastState(live);
      }
    }

    // One call, one place. The store used to compute this a second time, which
    // meant the position was projected twice from two different "now"s.
    let adjustment: SyncAdjustmentResult | null = null;
    try {
      adjustment = this.receiveMessage(message);
    } catch (err) {
      console.error('[GroupListenService] Message rejected:', err);
      return;
    }

    for (const listener of this.messageListeners) {
      try {
        listener(message, adjustment);
      } catch (err) {
        console.error('[GroupListenService] Listener error:', err);
      }
    }
  }

  private emitTransportMessage(message: GroupListenMessage, options: { retain?: boolean } = {}): void {
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage(message);
      } catch {
        // Another window closed mid-post; the broker copy still goes out.
      }
    }

    this.mqtt?.publish(this.topic(), JSON.stringify(message), options);
  }

  // =========================================================================
  // Heartbeat & Participant Tracking
  // =========================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
      this.pruneStaleParticipants();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public sendHeartbeat(): void {
    if (!this.connected || !this.roomId) return;

    const self = this.selfParticipant();

    this.emitTransportMessage({
      type: 'heartbeat',
      roomId: this.roomId,
      senderId: this.userId,
      senderName: this.username,
      hostTimestamp: Date.now(),
      state: this.lastReceivedState || { isPlaying: false, currentTime: 0, queue: [] },
      participant: self,
      messageId: this.nextMessageId('hb')
    });
  }

  private pruneStaleParticipants(): void {
    const now = Date.now();
    let changed = false;
    let hostLost = false;
    for (const [id, p] of this.participants.entries()) {
      if (id !== this.userId && p.lastSeen && now - p.lastSeen > PARTICIPANT_TIMEOUT_MS) {
        this.participants.delete(id);
        changed = true;
        // A host that crashed or lost its network never sends `leave`. Silence
        // past the timeout is the only signal there is, and the room has to act
        // on it — otherwise listeners wait forever for commands nobody will send.
        if (id === this.hostId) hostLost = true;
      }
    }
    if (hostLost) {
      this.setHostId(null);
    }
    if (changed) {
      this.notifyParticipants();
    }
  }

  // =========================================================================
  // Listeners & Getters
  // =========================================================================

  public onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  public onParticipantsChange(listener: ParticipantsListener): () => void {
    this.participantListeners.add(listener);
    listener(this.getParticipants());
    return () => {
      this.participantListeners.delete(listener);
    };
  }

  public onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.connected, null);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Transport truth, separate from "am I in a room".
   *
   * The UI needs both: a room can be live locally while the broker is down, and
   * the difference decides whether anyone else can hear it.
   */
  public onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    listener(this.getConnectionStatus(), this.transportError);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  /**
   * Who is leading the room. `null` while nobody is — see `setHostId`.
   *
   * Fires immediately with the current value so a late subscriber does not sit on
   * a stale "waiting for the host" state.
   */
  public onHostChange(listener: HostListener): () => void {
    this.hostListeners.add(listener);
    listener(this.hostId);
    return () => {
      this.hostListeners.delete(listener);
    };
  }

  /** Measured round trip and clock offset, for the honest latency readout. */
  public onClockChange(listener: ClockListener): () => void {
    this.clockListeners.add(listener);
    listener({ offsetMs: this.clockOffsetMs, rttMs: this.clockRttMs });
    return () => {
      this.clockListeners.delete(listener);
    };
  }

  public getConnectionStatus(): GroupConnectionStatus {
    if (!this.connected) return 'offline';
    if (this.transportStatus === 'online') return 'online';
    if (this.transportStatus === 'connecting') return 'connecting';
    // In a room, no broker: this machine only.
    return 'local';
  }

  public getConnectionError(): string | null {
    return this.transportError;
  }

  private notifyConnection(): void {
    const status = this.getConnectionStatus();
    for (const listener of this.connectionListeners) {
      try {
        listener(status, this.transportError);
      } catch (err) {
        console.error('[GroupListenService] Connection listener error:', err);
      }
    }
  }

  private notifyParticipants(): void {
    const list = this.getParticipants();
    for (const l of this.participantListeners) {
      try {
        l(list);
      } catch (err) {
        console.error('[GroupListenService] Participant listener error:', err);
      }
    }
  }

  private notifyStatus(connected: boolean, error?: string | null): void {
    for (const l of this.statusListeners) {
      try {
        l(connected, error);
      } catch (err) {
        console.error('[GroupListenService] Status listener error:', err);
      }
    }
  }

  public getRoomId(): string | null {
    return this.roomId;
  }

  public isRoomHost(): boolean {
    return this.isHost;
  }

  /** True while a room session is active locally — see `getConnectionStatus()`. */
  public isConnected(): boolean {
    return this.connected;
  }

  public getParticipants(): GroupParticipant[] {
    return Array.from(this.participants.values());
  }

  public getLastReceivedState(): GroupState | null {
    return this.lastReceivedState;
  }

  public getHostId(): string | null {
    return this.hostId;
  }

  /** Host clock minus local clock, ms. Zero until a probe has been answered. */
  public getClockOffsetMs(): number {
    return this.clockOffsetMs;
  }

  /** Measured round trip to the host, ms. Zero on the host itself. */
  public getRoundTripMs(): number {
    return this.clockRttMs;
  }

  public getMessageLog(): GroupListenMessage[] {
    return [...this.messageLog];
  }
}

export const groupListenService = new GroupListenService();
