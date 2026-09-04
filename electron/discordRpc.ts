/**
 * Native Node.js `net.Socket` Discord Rich Presence (RPC) IPC Client
 *
 * Zero-dependency IPC client communicating directly with Discord desktop
 * over local named pipes (Windows: `\\?\pipe\discord-ipc-0..3`, Unix: `/tmp/discord-ipc-0..3`).
 *
 * Features:
 * - Pure Node.js `net.Socket` buffer framing & IPC opcode protocol
 * - Opcode 1 Handshake with Discord client ID (`DEFAULT_CLIENT_ID`)
 * - Opcode 2 `SET_ACTIVITY` command broadcasting track, artist, album art, timestamps
 * - Graceful offline reconnection with exponential backoff if Discord is not running
 * - Never throws or crashes the Electron main process
 */

import net from 'net';
import path from 'path';

import { DISCORD_CLIENT_ID } from './authWindow.js';

/**
 * Заявка, от чьего имени показывается активность.
 *
 * Здесь стоял чужой идентификатор — заглушка, оставшаяся с первого наброска.
 * Discord на рукопожатие с незнакомой заявкой отвечает отказом, поэтому
 * активность не появлялась ни разу: `setActivity` молча возвращал `false`.
 * Идентификатор тот же, что и у входа, — заявка одна.
 */
export const DEFAULT_CLIENT_ID = DISCORD_CLIENT_ID;

/**
 * Номера опкодов протокола Discord.
 *
 * Здесь была вторая причина, по которой активность не появлялась никогда: весь
 * набор был сдвинут на единицу, и рукопожатие уходило под номером кадра.
 * Discord на это отвечает `{"code":1003,"message":"did not handshake"}` и
 * закрывает трубу — а `connect()` просто возвращал `false`, ничего не объясняя.
 * Проверено вживую: с нулём Discord отвечает `READY`.
 */
export const OPCODES = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
} as const;

/**
 * Вид активности.
 *
 * `0` — «играет в», `2` — «слушает». Разница не косметическая: со вторым
 * Discord рисует полосу воспроизведения с оставшимся временем — то же, что у
 * Spotify, — а с первым показывает только «прошло столько-то».
 */
export const ACTIVITY_TYPE_LISTENING = 2;

/**
 * Не чаще одного кадра в эту выдержку.
 *
 * Замерено разговором с настоящим Discord: кадры без картинки он принимает хоть
 * каждые 900 мс, но с **разной обложкой** каждый раз ему приходится тащить её
 * через свой прокси — и на седьмом подряд он ответил «Unknown Error», а
 * восьмой и девятый подтвердил только через пять секунд. Отказ означает, что
 * песня не появилась в статусе вовсе, а висит предыдущая. Владелец так и
 * описал: «кучу песен не регает, пишет что слушаешь прошлую».
 *
 * Две секунды — заметно реже, чем человек листает треки, и достаточно редко,
 * чтобы прокси успевал. Промежуточные состояния при этом не теряются: при
 * склейке отправляется **последнее**, а не первое.
 */
export const ACTIVITY_MIN_INTERVAL_MS = 2000;

/** Через сколько повторить кадр, который Discord отклонил. */
export const ACTIVITY_RETRY_MS = 2500;

/** Сколько раз пробовать. Дальше — не наша беда, и висеть в цикле незачем. */
export const ACTIVITY_MAX_RETRIES = 3;

export interface DiscordActivityPayload {
  details: string;
  state: string;
  /** По умолчанию «слушает». Явное значение нужно только тестам. */
  type?: number;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  instance?: boolean;
  timestamps?: {
    start?: number;
    end?: number;
  };
  assets?: {
    large_image?: string;
    large_text?: string;
    small_image?: string;
    small_text?: string;
  };
}

export interface DiscordRpcStatus {
  connected: boolean;
  ready: boolean;
  enabled: boolean;
  clientId: string;
  currentActivity: DiscordActivityPayload | null;
  /**
   * Почему активности нет. Пока поля не было, отказ выглядел одинаково при
   * выключенном Discord, чужой заявке и запрете в самом Discord: `setActivity`
   * возвращал `false`, и всё. Владелец на это справедливо отвечал «не
   * работает» — сказать ему было нечего.
   */
  lastError: string | null;
  /** Когда Discord последний раз принял активность. */
  lastAcceptedAt: number | null;
}

export interface DiscordRpcOptions {
  clientId?: string;
  autoReconnect?: boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Generates an array of potential named pipe socket paths for Windows and Unix
 */
export function getAvailableIpcPipes(): string[] {
  const pipes: string[] = [];

  if (process.platform === 'win32') {
    for (let i = 0; i < 4; i++) {
      pipes.push(`\\\\?\\pipe\\discord-ipc-${i}`);
      pipes.push(`\\\\.\\pipe\\discord-ipc-${i}`);
    }
    return pipes;
  }

  const prefixDirs: string[] = [];
  if (process.env.XDG_RUNTIME_DIR) {
    prefixDirs.push(process.env.XDG_RUNTIME_DIR);
    prefixDirs.push(path.join(process.env.XDG_RUNTIME_DIR, 'app', 'com.discordapp.Discord'));
  }
  if (process.env.TMPDIR) prefixDirs.push(process.env.TMPDIR);
  if (process.env.TMP) prefixDirs.push(process.env.TMP);
  if (process.env.TEMP) prefixDirs.push(process.env.TEMP);
  prefixDirs.push('/tmp');
  prefixDirs.push('/tmp/app/com.discordapp.Discord');

  for (let i = 0; i < 4; i++) {
    for (const dir of prefixDirs) {
      if (dir) {
        pipes.push(path.join(dir, `discord-ipc-${i}`));
      }
    }
  }

  return Array.from(new Set(pipes));
}

/**
 * Дополнение до двух символов. Неразрывный пробел, а не обычный.
 *
 * Discord срезает обычные пробелы **до** проверки длины, поэтому «A » для
 * него по-прежнему один символ и отказ остаётся. Неразрывный он не срезает —
 * проверено вживую, такая пара принимается. На виду он неотличим от пробела.
 */
const PAD = ' ';

/**
 * Текст, который Discord обязан получить: от 2 до 128 символов.
 *
 * Нижняя граница — не педантизм, а причина, по которой **часть треков не
 * показывалась в активности вовсе**. Discord проверяет каждое текстовое поле
 * и на коротком отвечает отказом на **всю** активность целиком, кодом 4000
 * и словами «length must be at least 2 characters long».
 *
 * Защита у `details` и `state` была, но не работала: она дополняла обычным
 * пробелом, а его Discord срезает раньше, чем считает длину. Трек с названием
 * из одного знака — «4», «?», «М» — исчезал из статуса молча, и следующий
 * появлялся как ни в чём не бывало. Снаружи это ровно то, что описал
 * владелец: «показываются не все песни».
 */
function requiredActivityText(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  const base = trimmed.length > 0 ? trimmed : fallback;
  const cut = base.length > 128 ? base.slice(0, 128) : base;
  return cut.length < 2 ? `${cut}${PAD}` : cut;
}


/**
 * Formats a user-supplied activity into Discord's native wire activity object
 */
export function formatActivityForDiscord(payload: DiscordActivityPayload | null): Record<string, any> | null {
  if (!payload) return null;

  const details = requiredActivityText(payload.details, 'Wireon');
  const state = requiredActivityText(payload.state, 'Listening to music');

  const assets: Record<string, string> = {
    large_image: payload.largeImageKey || payload.assets?.large_image || 'wireon_logo'
  };

  // Подпись под обложкой — тот же порог в два символа. Здесь защиты не было
  // вовсе, а шло в неё название альбома: альбом из одного знака или из одного
  // пробела (у пробела `||` не срабатывает — непустая строка истинна), и
  // Discord отказывал во всей активности, то есть трек пропадал из статуса.
  assets.large_text = requiredActivityText(
    payload.largeImageText || payload.assets?.large_text,
    'Wireon'
  );

  const smallImage = payload.smallImageKey || payload.assets?.small_image;
  if (smallImage) {
    assets.small_image = smallImage;
  }

  const smallText = payload.smallImageText || payload.assets?.small_text;
  if (smallText) {
    assets.small_text = requiredActivityText(smallText, 'Wireon');
  }

  const result: Record<string, any> = {
    type: payload.type ?? ACTIVITY_TYPE_LISTENING,
    details,
    state,
    assets,
    instance: false
  };

  if (payload.startTimestamp) {
    result.timestamps = {
      start: payload.startTimestamp
    };
    if (payload.endTimestamp) {
      result.timestamps.end = payload.endTimestamp;
    }
  } else if (payload.timestamps) {
    result.timestamps = payload.timestamps;
  }

  return result;
}

export class DiscordRpcClient {
  private clientId: string;
  private socket: net.Socket | null = null;
  private isConnected = false;
  private isReady = false;
  private isEnabled = true;
  private isDestroyed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffDelay: number;
  private minBackoffMs: number;
  private maxBackoffMs: number;
  private currentPipeIndex = 0;
  private pipes: string[] = [];
  private lastError: string | null = null;
  private lastAcceptedAt: number | null = null;
  /** Отправка, на ответ которой мы ждём. Нужна, чтобы узнать свой отказ. */
  private inFlightNonce: string | null = null;
  /** Когда последний кадр ушёл в трубу — для выдержки между отправками. */
  private lastSentAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private activityRetries = 0;
  private currentActivity: DiscordActivityPayload | null = null;
  private incomingBuffer: Buffer = Buffer.alloc(0);
  private connectionPromise: Promise<boolean> | null = null;

  constructor(options: DiscordRpcOptions = {}) {
    this.clientId = options.clientId || DEFAULT_CLIENT_ID;
    this.minBackoffMs = options.minBackoffMs || 5000;
    this.maxBackoffMs = options.maxBackoffMs || 30000;
    this.backoffDelay = this.minBackoffMs;
    this.pipes = getAvailableIpcPipes();
  }

  /**
   * Initializes or gets the current connection
   */
  public async connect(): Promise<boolean> {
    if (this.isDestroyed || !this.isEnabled) {
      return false;
    }
    if (this.isConnected && this.isReady) {
      return true;
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.attemptConnection();
    try {
      return await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  /**
   * Tries connecting to the available Discord IPC named pipes
   */
  private attemptConnection(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.isDestroyed || !this.isEnabled) {
        resolve(false);
        return;
      }

      this.cleanupSocket();

      if (this.pipes.length === 0) {
        this.pipes = getAvailableIpcPipes();
      }

      const pipePath = this.pipes[this.currentPipeIndex % this.pipes.length];
      const socket = net.createConnection(pipePath);
      this.socket = socket;

      let resolved = false;

      const finish = (success: boolean) => {
        if (!resolved) {
          resolved = true;
          resolve(success);
        }
      };

      // Set timeout for handshake response
      const timeoutTimer = setTimeout(() => {
        if (!this.isReady) {
          this.handleConnectionFailure();
          finish(false);
        }
      }, 4000);

      socket.on('connect', () => {
        this.isConnected = true;
        this.backoffDelay = this.minBackoffMs;
        this.sendHandshake();
      });

      socket.on('data', (data: Buffer) => {
        this.handleIncomingData(data);
        if (this.isReady) {
          clearTimeout(timeoutTimer);
          finish(true);
        }
      });

      socket.on('error', () => {
        clearTimeout(timeoutTimer);
        // Silently handle expected disconnect / pipe absence
        this.handleConnectionFailure();
        finish(false);
      });

      socket.on('close', () => {
        clearTimeout(timeoutTimer);
        this.handleConnectionFailure();
        finish(false);
      });
    });
  }

  /**
   * Handles incoming binary IPC buffer framing
   */
  private handleIncomingData(chunk: Buffer): void {
    this.incomingBuffer = Buffer.concat([this.incomingBuffer, chunk]);

    while (this.incomingBuffer.length >= 8) {
      const opcode = this.incomingBuffer.readUInt32LE(0);
      const length = this.incomingBuffer.readUInt32LE(4);

      if (this.incomingBuffer.length < 8 + length) {
        // Wait for remaining chunk
        break;
      }

      const payloadBuf = this.incomingBuffer.subarray(8, 8 + length);
      this.incomingBuffer = this.incomingBuffer.subarray(8 + length);

      try {
        const payloadStr = payloadBuf.toString('utf-8');
        const json = JSON.parse(payloadStr);
        this.handleMessage(opcode, json);
      } catch {
        // Ignore unparseable frames
      }
    }
  }

  /**
   * Processes a complete IPC message from Discord
   */
  private handleMessage(opcode: number, payload: any): void {
    if (opcode === OPCODES.HANDSHAKE || opcode === OPCODES.FRAME) {
      if (payload.cmd === 'DISPATCH' && payload.evt === 'READY') {
        this.isReady = true;
        this.lastError = null;
        // If we have a queued activity, broadcast it now
        if (this.currentActivity && this.isEnabled) {
          this.sendActivityPacket(this.currentActivity);
        }
      } else if (payload.evt === 'ERROR') {
        // Discord отвечает на каждый кадр, и на отказ тоже. Раньше отказ уходил
        // в консоль главного процесса, которую никто не видит, — а приложение
        // продолжало считать, что всё отправлено.
        this.lastError = String(payload.data?.message || 'Discord отклонил активность');
        console.warn('[DiscordRpc] Received error from Discord:', payload.data?.message || payload);
        /*
         * Отказ на нашу отправку — повод повторить, а не забыть.
         *
         * Замерено: подряд идущие кадры с разными обложками Discord иногда
         * отклоняет («Unknown Error»), пока тащит картинку через свой прокси. Без
         * повтора эта песня не появляется в статусе вовсе — висит предыдущая.
         */
        if (payload.nonce && payload.nonce === this.inFlightNonce) {
          this.inFlightNonce = null;
          this.scheduleActivityRetry();
        }
      } else if (payload.cmd === 'SET_ACTIVITY') {
        if (payload.nonce === this.inFlightNonce) this.inFlightNonce = null;
        this.lastAcceptedAt = Date.now();
        this.lastError = null;
        this.activityRetries = 0;
      }
    } else if (opcode === OPCODES.PING) {
      this.sendPacket(OPCODES.PONG, payload);
    } else if (opcode === OPCODES.CLOSE) {
      this.disconnect();
    }
  }

  /**
   * Sends Opcode 1 Handshake
   */
  private sendHandshake(): void {
    const payload = {
      v: 1,
      client_id: this.clientId
    };
    this.sendPacket(OPCODES.HANDSHAKE, payload);
  }

  /**
   * Writes framed packet to socket
   */
  private sendPacket(opcode: number, payload: any): boolean {
    if (!this.socket || !this.isConnected || this.socket.destroyed) {
      return false;
    }

    try {
      const payloadStr = JSON.stringify(payload);
      const payloadBuf = Buffer.from(payloadStr, 'utf-8');
      const header = Buffer.alloc(8);
      header.writeUInt32LE(opcode, 0);
      header.writeUInt32LE(payloadBuf.length, 4);

      return this.socket.write(Buffer.concat([header, payloadBuf]));
    } catch (err) {
      console.warn('[DiscordRpc] Failed to write packet to socket:', err);
      return false;
    }
  }

  /**
   * Sends `SET_ACTIVITY` command (Opcode 2)
   */
  private sendActivityPacket(payload: DiscordActivityPayload | null): boolean {
    if (!this.isConnected || !this.isReady || !this.socket) {
      return false;
    }

    const activity = formatActivityForDiscord(payload);
    const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.inFlightNonce = nonce;
    this.lastSentAt = Date.now();

    return this.sendPacket(OPCODES.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity
      },
      nonce
    });
  }

  /**
   * Ставит повтор последней активности после отказа Discord.
   *
   * Повторов немного и они редкие: если Discord отказывает трижды подряд, дело
   * не в спешке, и молотить в трубу бессмысленно.
   */
  private scheduleActivityRetry(): void {
    if (this.isDestroyed || !this.isEnabled) return;
    if (this.activityRetries >= ACTIVITY_MAX_RETRIES) return;
    if (this.retryTimer) return;

    this.activityRetries += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.isDestroyed || !this.isEnabled || !this.isConnected || !this.isReady) return;
      this.sendActivityPacket(this.currentActivity);
    }, ACTIVITY_RETRY_MS);
  }

  /** Снимает отложенную отправку и отложенный повтор. */
  private clearActivityTimers(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Sets or clears the Discord Rich Presence activity
   *
   * Отправка идёт с выдержкой (см. {@link ACTIVITY_MIN_INTERVAL_MS}). Если с
   * прошлого кадра прошло меньше, новый не выбрасывается и не встаёт в очередь —
   * он **заменяет** отложенный: в статусе должно оказаться последнее состояние, а
   * не все промежуточные по очереди. Из-за этого же `currentActivity`
   * записывается всегда, даже когда отправка отложена: именно её отправит и
   * таймер, и повтор после отказа, и рукопожатие после переподключения.
   */
  public async setActivity(activity: DiscordActivityPayload | null): Promise<boolean> {
    if (this.isDestroyed) {
      return false;
    }

    this.currentActivity = activity;
    // Новое состояние отменяет повтор старого: чинить то, чего уже нет на экране
    // у человека, незачем.
    this.activityRetries = 0;
    this.clearActivityTimers();

    if (!this.isEnabled) {
      return false;
    }

    if (!this.isConnected || !this.isReady) {
      // Trigger lazy connection
      void this.connect();
      return false;
    }

    const waited = Date.now() - this.lastSentAt;
    if (waited < ACTIVITY_MIN_INTERVAL_MS) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.isDestroyed || !this.isEnabled) return;
        this.sendActivityPacket(this.currentActivity);
      }, ACTIVITY_MIN_INTERVAL_MS - waited);
      // Отложено — не отправлено, но и не потеряно. Для вызывающей стороны это
      // успех: состояние принято и доедет.
      return true;
    }

    return this.sendActivityPacket(activity);
  }

  /**
   * Clears active presence from Discord
   */
  public async clearActivity(): Promise<boolean> {
    return this.setActivity(null);
  }

  /**
   * Enables or disables Discord RPC presence
   */
  public async setEnabled(enabled: boolean): Promise<void> {
    this.isEnabled = enabled;
    // Отложенная отправка и повтор пережили бы выключение и разбудили бы статус
    // через две секунды после того, как человек его погасил.
    this.clearActivityTimers();

    if (!enabled) {
      // Clear presence from Discord if connected
      if (this.isConnected && this.isReady) {
        this.sendActivityPacket(null);
      }
      this.clearReconnectTimer();
      this.cleanupSocket();
      this.isConnected = false;
      this.isReady = false;
    } else {
      // Re-enable and connect
      this.currentPipeIndex = 0;
      this.backoffDelay = this.minBackoffMs;
      void this.connect();
    }
  }

  /**
   * Disconnects the current socket
   */
  public disconnect(): void {
    this.clearActivityTimers();
    this.cleanupSocket();
    this.isConnected = false;
    this.isReady = false;
    this.incomingBuffer = Buffer.alloc(0);
  }

  /**
   * Handles failure and schedules reconnection backoff
   */
  private handleConnectionFailure(): void {
    this.cleanupSocket();
    this.isConnected = false;
    this.isReady = false;
    this.incomingBuffer = Buffer.alloc(0);
    // Труба есть только у запущенного Discord. Это самая частая причина
    // «активности нет», и её стоит называть прямо, а не молчать.
    if (!this.lastError) this.lastError = 'Discord не запущен на этом компьютере';

    if (this.isDestroyed || !this.isEnabled) {
      return;
    }

    // Try next pipe index
    this.currentPipeIndex = (this.currentPipeIndex + 1) % Math.max(1, this.pipes.length);

    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.isEnabled && !this.isConnected) {
          void this.connect();
        }
      }, this.backoffDelay);

      // Exponential backoff with ceiling
      this.backoffDelay = Math.min(this.backoffDelay * 1.5, this.maxBackoffMs);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cleanupSocket(): void {
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.destroy();
      } catch {
        // Ignore errors during destroy
      }
      this.socket = null;
    }
  }

  /**
   * Returns current status snapshot
   */
  public getStatus(): DiscordRpcStatus {
    return {
      connected: this.isConnected,
      ready: this.isReady,
      enabled: this.isEnabled,
      clientId: this.clientId,
      currentActivity: this.currentActivity,
      lastError: this.lastError,
      lastAcceptedAt: this.lastAcceptedAt
    };
  }

  /**
   * Destroys client on app shutdown
   */
  public destroy(): void {
    this.isDestroyed = true;
    this.clearActivityTimers();
    this.clearReconnectTimer();
    this.cleanupSocket();
    this.isConnected = false;
    this.isReady = false;
    this.currentActivity = null;
  }
}

// Export singleton instance
export const discordRpc = new DiscordRpcClient();
export default discordRpc;
