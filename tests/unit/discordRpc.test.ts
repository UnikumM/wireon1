/**
 * Unit Test Suite: Discord Rich Presence (RPC) Integration (M4)
 *
 * Tests:
 * 1. Protocol framing, opcode handling, packet serialization & deserialization
 * 2. DiscordRpcClient (native net.Socket named pipe IPC client)
 * 3. formatActivityForDiscord & getAvailableIpcPipes
 * 4. DiscordRpcService (renderer store binding & debouncing)
 * 5. Main process IPC handlers & error resilience
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import net from 'net';
import {
  DiscordRpcClient,
  ACTIVITY_TYPE_LISTENING,
  DEFAULT_CLIENT_ID,
  OPCODES,
  formatActivityForDiscord,
  getAvailableIpcPipes,
  DiscordActivityPayload
} from '../../electron/discordRpc';
import { DISCORD_CLIENT_ID } from '../../electron/authWindow';
import { DiscordRpcService, discordRpcService, DISCORD_RPC_SETTING_KEY } from '../../src/services/discordRpcService';
import { setupIpcHandlers } from '../../electron/main';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import * as dbService from '../../src/services/db';
import { createMockTrack } from '../helpers/mockData';
import { resetPlayerStore, flushAsync } from '../helpers/testUtils';

class MockSocket extends EventEmitter {
  destroyed = false;
  writtenBuffers: Buffer[] = [];

  write(buffer: Buffer): boolean {
    if (this.destroyed) return false;
    this.writtenBuffers.push(buffer);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }

  end(): void {
    this.destroy();
  }

  simulateServerPacket(opcode: number, payload: any): void {
    const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf-8');
    const header = Buffer.alloc(8);
    header.writeUInt32LE(opcode, 0);
    header.writeUInt32LE(payloadBuf.length, 4);
    this.emit('data', Buffer.concat([header, payloadBuf]));
  }

  simulatePartialChunks(opcode: number, payload: any, chunkSize = 4): void {
    const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf-8');
    const header = Buffer.alloc(8);
    header.writeUInt32LE(opcode, 0);
    header.writeUInt32LE(payloadBuf.length, 4);
    const full = Buffer.concat([header, payloadBuf]);

    for (let i = 0; i < full.length; i += chunkSize) {
      this.emit('data', full.subarray(i, i + chunkSize));
    }
  }
}

describe('Milestone 4: Discord Rich Presence (RPC) Unit Tests', () => {
  let mockSocket: MockSocket;

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetPlayerStore();
    await dbService.clearAllData();
    mockSocket = new MockSocket();
    vi.spyOn(net, 'createConnection').mockReturnValue(mockSocket as any);
  });

  afterEach(async () => {
    await flushAsync();
  });

  // =========================================================================
  // 1. formatActivityForDiscord & Payload Formatting
  // =========================================================================
  /*
   * Числа опкодов проверяются как числа, а не через саму же константу.
   *
   * Так эта поломка и дожила до релиза: весь набор был сдвинут на единицу, но
   * тесты сверяли `OPCODES.HANDSHAKE` с `OPCODES.HANDSHAKE` и оставались
   * зелёными. Discord же отвечал `did not handshake` и закрывал трубу, а
   * активность не появлялась ни разу за всё время.
   */
  describe('Номера опкодов протокола', () => {
    it('совпадают с теми, что ждёт Discord', () => {
      expect(OPCODES.HANDSHAKE).toBe(0);
      expect(OPCODES.FRAME).toBe(1);
      expect(OPCODES.CLOSE).toBe(2);
      expect(OPCODES.PING).toBe(3);
      expect(OPCODES.PONG).toBe(4);
    });

    it('заявка та же, что и у входа через Discord', () => {
      expect(DEFAULT_CLIENT_ID).toBe(DISCORD_CLIENT_ID);
      expect(DEFAULT_CLIENT_ID).toMatch(/^\d{17,20}$/);
    });
  });

  describe('formatActivityForDiscord helper', () => {
    it('formats basic track activity correctly', () => {
      const payload: DiscordActivityPayload = {
        details: 'Bohemian Rhapsody',
        state: 'Queen',
        largeImageKey: 'queen_cover.jpg',
        largeImageText: 'A Night at the Opera',
        smallImageKey: 'play_icon',
        smallImageText: 'Играет',
        startTimestamp: 1700000000,
        endTimestamp: 1700000354
      };

      const formatted = formatActivityForDiscord(payload);
      expect(formatted).not.toBeNull();
      expect(formatted?.details).toBe('Bohemian Rhapsody');
      expect(formatted?.state).toBe('Queen');
      expect(formatted?.assets?.large_image).toBe('queen_cover.jpg');
      expect(formatted?.assets?.large_text).toBe('A Night at the Opera');
      expect(formatted?.assets?.small_image).toBe('play_icon');
      expect(formatted?.assets?.small_text).toBe('Играет');
      expect(formatted?.timestamps?.start).toBe(1700000000);
      expect(formatted?.timestamps?.end).toBe(1700000354);
      expect(formatted?.instance).toBe(false);
    });

    it('truncates strings longer than 128 characters', () => {
      const longTitle = 'X'.repeat(200);
      const longArtist = 'Y'.repeat(250);
      const payload: DiscordActivityPayload = {
        details: longTitle,
        state: longArtist
      };

      const formatted = formatActivityForDiscord(payload);
      expect(formatted?.details.length).toBe(128);
      expect(formatted?.state.length).toBe(128);
      expect(formatted?.details).toBe('X'.repeat(128));
      expect(formatted?.state).toBe('Y'.repeat(128));
    });

    it('pads 1-character strings to 2 characters to satisfy Discord RPC spec', () => {
      const payload: DiscordActivityPayload = {
        details: 'A',
        state: 'B'
      };

      const formatted = formatActivityForDiscord(payload);
      // Неразрывный пробел, а не обычный: обычный Discord срезает до проверки
      // длины, и «A » для него по-прежнему один символ — отказ остаётся.
      expect(formatted?.details).toBe('A ');
      expect(formatted?.state).toBe('B ');
    });

    it('returns null when payload is null', () => {
      expect(formatActivityForDiscord(null)).toBeNull();
    });

    it('uses fallback defaults when optional fields are omitted', () => {
      const payload: DiscordActivityPayload = {
        details: '',
        state: ''
      };

      const formatted = formatActivityForDiscord(payload);
      expect(formatted?.details).toBe('Wireon');
      expect(formatted?.state).toBe('Listening to music');
      expect(formatted?.assets?.large_image).toBe('wireon_logo');
      expect(formatted?.assets?.large_text).toBe('Wireon');
    });
  });

  // =========================================================================
  // 2. Named Pipe Discovery
  // =========================================================================
  /*
   * Вид активности — «слушает», а не «играет в».
   *
   * От него зависит не подпись, а полоса воспроизведения: с «слушает» Discord
   * рисует её с оставшимся временем, как у Spotify, с «играет» — только
   * «прошло столько-то».
   */
  describe('Вид активности', () => {
    it('по умолчанию «слушает»', () => {
      const result = formatActivityForDiscord({ details: 'Песня', state: 'Исполнитель' });
      expect(result?.type).toBe(ACTIVITY_TYPE_LISTENING);
      expect(ACTIVITY_TYPE_LISTENING).toBe(2);
    });

    it('переданный вид уважается', () => {
      const result = formatActivityForDiscord({ details: 'Песня', state: 'Исполнитель', type: 0 });
      expect(result?.type).toBe(0);
    });
  });

  describe('getAvailableIpcPipes', () => {
    it('returns named pipes according to current platform', () => {
      const pipes = getAvailableIpcPipes();
      expect(Array.isArray(pipes)).toBe(true);
      expect(pipes.length).toBeGreaterThan(0);

      if (process.platform === 'win32') {
        expect(pipes.some((p) => p.includes('pipe\\discord-ipc-0'))).toBe(true);
      } else {
        expect(pipes.some((p) => p.includes('discord-ipc-0'))).toBe(true);
      }
    });
  });

  // =========================================================================
  // 3. DiscordRpcClient (Main Process Native IPC Client)
  // =========================================================================
  describe('DiscordRpcClient Protocol & State Machine', () => {
    let client: DiscordRpcClient;

    beforeEach(() => {
      client = new DiscordRpcClient({ clientId: DEFAULT_CLIENT_ID, minBackoffMs: 100 });
    });

    afterEach(() => {
      client.destroy();
    });

    it('initializes with default values and status', () => {
      const status = client.getStatus();
      expect(status.clientId).toBe(DEFAULT_CLIENT_ID);
      expect(status.connected).toBe(false);
      expect(status.ready).toBe(false);
      expect(status.enabled).toBe(true);
      expect(status.currentActivity).toBeNull();
    });

    it('sends Opcode 1 Handshake upon socket connection', async () => {
      const connectPromise = client.connect();

      mockSocket.emit('connect');

      expect(mockSocket.writtenBuffers.length).toBe(1);
      const handshakeBuf = mockSocket.writtenBuffers[0];
      const opcode = handshakeBuf.readUInt32LE(0);
      const len = handshakeBuf.readUInt32LE(4);
      const body = JSON.parse(handshakeBuf.subarray(8, 8 + len).toString('utf-8'));

      expect(opcode).toBe(OPCODES.HANDSHAKE);
      expect(body.v).toBe(1);
      expect(body.client_id).toBe(DEFAULT_CLIENT_ID);

      // Server responds with Opcode 0 READY
      mockSocket.simulateServerPacket(0, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'test' } } });

      const connected = await connectPromise;
      expect(connected).toBe(true);
      expect(client.getStatus().ready).toBe(true);
      expect(client.getStatus().connected).toBe(true);
    });

    /**
     * Почему кадры уходят с выдержкой и почему отказ повторяется.
     *
     * Замерено разговором с настоящим Discord: кадры без обложки он принимает
     * хоть каждые 900 мс, но с **разной** обложкой каждый раз ему приходится
     * тащить картинку через свой прокси — на седьмом подряд он ответил
     * «Unknown Error», а следующие подтвердил только через пять секунд. Отказ
     * означает, что песня не появилась в статусе вовсе и висит предыдущая.
     * Владелец описал это как «кучу песен не регает, пишет что слушаешь
     * прошлую».
     */
    describe('Выдержка между кадрами и повтор после отказа', () => {
      async function makeReady() {
        const connectPromise = client.connect();
        mockSocket.emit('connect');
        mockSocket.simulateServerPacket(0, { cmd: 'DISPATCH', evt: 'READY', data: {} });
        await connectPromise;
        mockSocket.writtenBuffers.length = 0;
      }

      function framesSent(): any[] {
        return mockSocket.writtenBuffers
          .map((b) => {
            try {
              return JSON.parse(b.subarray(8).toString('utf-8'));
            } catch {
              return null;
            }
          })
          .filter((f) => f && f.cmd === 'SET_ACTIVITY');
      }

      it('вторая смена подряд не уходит сразу, а заменяет отложенную', async () => {
        vi.useFakeTimers();
        try {
          await makeReady();

          await client.setActivity({ details: 'Песня 1', state: 'Артист' });
          await client.setActivity({ details: 'Песня 2', state: 'Артист' });
          await client.setActivity({ details: 'Песня 3', state: 'Артист' });

          // Ушёл только первый: остальные два сложились в один отложенный.
          expect(framesSent()).toHaveLength(1);
          expect(framesSent()[0].args.activity.details).toBe('Песня 1');

          await vi.advanceTimersByTimeAsync(2100);

          // И в статус попало ПОСЛЕДНЕЕ состояние, а не второе по очереди.
          const frames = framesSent();
          expect(frames).toHaveLength(2);
          expect(frames[1].args.activity.details).toBe('Песня 3');
        } finally {
          vi.useRealTimers();
        }
      });

      it('отказ Discord приводит к повтору, а не к потере песни', async () => {
        vi.useFakeTimers();
        try {
          await makeReady();

          await client.setActivity({ details: 'Отклонённая', state: 'Артист' });
          const sent = framesSent();
          expect(sent).toHaveLength(1);

          // Discord отвечает отказом на наш же кадр.
          mockSocket.simulateServerPacket(1, {
            cmd: 'SET_ACTIVITY',
            evt: 'ERROR',
            nonce: sent[0].nonce,
            data: { code: 4000, message: 'Unknown Error' }
          });

          await vi.advanceTimersByTimeAsync(3000);

          const after = framesSent();
          expect(after.length).toBeGreaterThan(1);
          expect(after[after.length - 1].args.activity.details).toBe('Отклонённая');
        } finally {
          vi.useRealTimers();
        }
      });

      it('новое состояние отменяет повтор старого', async () => {
        vi.useFakeTimers();
        try {
          await makeReady();

          await client.setActivity({ details: 'Старая', state: 'Артист' });
          const sent = framesSent();
          mockSocket.simulateServerPacket(1, {
            cmd: 'SET_ACTIVITY',
            evt: 'ERROR',
            nonce: sent[0].nonce,
            data: { message: 'Unknown Error' }
          });

          // Пока повтор ждал, человек включил другое.
          await client.setActivity({ details: 'Новая', state: 'Артист' });
          await vi.advanceTimersByTimeAsync(4000);

          const frames = framesSent();
          expect(frames[frames.length - 1].args.activity.details).toBe('Новая');
          // Отклонённой в статусе быть уже не должно: её там никто не ждёт.
          expect(frames.filter((f) => f.args.activity?.details === 'Старая')).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('sends Opcode 2 SET_ACTIVITY command when ready', async () => {
      const connectPromise = client.connect();
      mockSocket.emit('connect');
      mockSocket.simulateServerPacket(0, { cmd: 'DISPATCH', evt: 'READY', data: {} });
      await connectPromise;

      mockSocket.writtenBuffers.length = 0;

      const activity: DiscordActivityPayload = {
        details: 'Starboy',
        state: 'The Weeknd',
        startTimestamp: 1700000000,
        endTimestamp: 1700000230
      };

      const success = await client.setActivity(activity);
      expect(success).toBe(true);
      expect(mockSocket.writtenBuffers.length).toBe(1);

      const packetBuf = mockSocket.writtenBuffers[0];
      const opcode = packetBuf.readUInt32LE(0);
      const len = packetBuf.readUInt32LE(4);
      const body = JSON.parse(packetBuf.subarray(8, 8 + len).toString('utf-8'));

      expect(opcode).toBe(OPCODES.FRAME);
      expect(body.cmd).toBe('SET_ACTIVITY');
      expect(body.args.activity.details).toBe('Starboy');
      expect(body.args.activity.state).toBe('The Weeknd');
      expect(body.nonce).toBeDefined();
    });

    it('handles partial chunk streaming & buffer framing correctly', async () => {
      const connectPromise = client.connect();
      mockSocket.emit('connect');

      // Simulate packet split across tiny 3-byte chunks
      mockSocket.simulatePartialChunks(0, { cmd: 'DISPATCH', evt: 'READY', data: {} }, 3);

      const connected = await connectPromise;
      expect(connected).toBe(true);
      expect(client.getStatus().ready).toBe(true);
    });

    it('handles PING opcode by responding with PONG', async () => {
      const connectPromise = client.connect();
      mockSocket.emit('connect');
      mockSocket.simulateServerPacket(0, { cmd: 'DISPATCH', evt: 'READY', data: {} });
      await connectPromise;

      mockSocket.writtenBuffers.length = 0;
      mockSocket.simulateServerPacket(OPCODES.PING, { pingData: 'abc' });

      expect(mockSocket.writtenBuffers.length).toBe(1);
      const pongBuf = mockSocket.writtenBuffers[0];
      expect(pongBuf.readUInt32LE(0)).toBe(OPCODES.PONG);
    });

    it('handles CLOSE opcode by disconnecting gracefully', async () => {
      const connectPromise = client.connect();
      mockSocket.emit('connect');
      mockSocket.simulateServerPacket(0, { cmd: 'DISPATCH', evt: 'READY', data: {} });
      await connectPromise;

      expect(client.getStatus().connected).toBe(true);
      mockSocket.simulateServerPacket(OPCODES.CLOSE, {});

      expect(client.getStatus().connected).toBe(false);
      expect(client.getStatus().ready).toBe(false);
    });

    it('handles socket error and close without throwing', async () => {
      const connectPromise = client.connect();

      mockSocket.emit('error', new Error('ECONNREFUSED'));
      const result = await connectPromise;

      expect(result).toBe(false);
      expect(client.getStatus().connected).toBe(false);
      expect(client.getStatus().ready).toBe(false);
    });

    it('setEnabled(false) clears activity and closes socket', async () => {
      const connectPromise = client.connect();
      mockSocket.emit('connect');
      mockSocket.simulateServerPacket(0, { cmd: 'DISPATCH', evt: 'READY', data: {} });
      await connectPromise;

      mockSocket.writtenBuffers.length = 0;
      await client.setEnabled(false);

      expect(client.getStatus().enabled).toBe(false);
      expect(client.getStatus().connected).toBe(false);
    });

    it('destroy cleans up all state and timers', async () => {
      const connectPromise = client.connect();
      mockSocket.emit('connect');
      mockSocket.simulateServerPacket(0, { cmd: 'DISPATCH', evt: 'READY', data: {} });
      await connectPromise;

      client.destroy();
      expect(client.getStatus().connected).toBe(false);
      expect(client.getStatus().ready).toBe(false);
    });
  });

  // =========================================================================
  // 4. Main Process IPC Handler Binding
  // =========================================================================
  describe('setupIpcHandlers with Discord RPC', () => {
    it('handles discord-rpc-set-activity and discord-rpc-set-enabled channels', async () => {
      const registeredHandlers: Record<string, Function> = {};
      const mockIpc = {
        on: vi.fn(),
        handle: vi.fn((channel: string, handler: Function) => {
          registeredHandlers[channel] = handler;
        })
      };

      const mockClient = {
        setActivity: vi.fn().mockResolvedValue(true),
        setEnabled: vi.fn().mockResolvedValue(undefined)
      };

      setupIpcHandlers(mockIpc as any, () => null, {} as any, mockClient as any);

      expect(registeredHandlers['discord-rpc-set-activity']).toBeDefined();
      expect(registeredHandlers['discord-rpc-set-enabled']).toBeDefined();

      const activityPayload: DiscordActivityPayload = { details: 'Song', state: 'Artist' };
      const res = await registeredHandlers['discord-rpc-set-activity']({}, activityPayload);
      expect(res).toBe(true);
      expect(mockClient.setActivity).toHaveBeenCalledWith(activityPayload);

      await registeredHandlers['discord-rpc-set-enabled']({}, false);
      expect(mockClient.setEnabled).toHaveBeenCalledWith(false);
    });
  });

  // =========================================================================
  // 5. DiscordRpcService (Renderer Store Synchronization & Debouncing)
  // =========================================================================
  describe('DiscordRpcService (Renderer Service)', () => {
    let mockElectronApi: any;

    beforeEach(async () => {
      mockElectronApi = {
        discordRpcSetActivity: vi.fn().mockResolvedValue(true),
        discordRpcSetEnabled: vi.fn().mockResolvedValue(undefined)
      };
      (window as any).electronAPI = mockElectronApi;
      discordRpcService.destroy();
      await discordRpcService.init();
    });

    afterEach(() => {
      discordRpcService.destroy();
      delete (window as any).electronAPI;
    });

    it('builds valid payload from Track with playing status and timestamps', () => {
      const track = createMockTrack({
        title: 'Instant Crush',
        artist: 'Daft Punk',
        album: 'RAM',
        duration: 337,
        artworkUrl: 'https://cdn.art/ram.jpg'
      });

      const payload = discordRpcService.buildPayloadFromTrack(track, true, 30);
      expect(payload).not.toBeNull();
      expect(payload?.details).toBe('Instant Crush');
      expect(payload?.state).toBe('Daft Punk');
      expect(payload?.largeImageKey).toBe('https://cdn.art/ram.jpg');
      expect(payload?.largeImageText).toBe('RAM');
      // Ключа маленького значка нет и не должно быть: в этот слот идёт имя
      // картинки, заранее загруженной в заявку Discord, а `play_icon` там
      // никогда не лежал. Discord выбрасывал его из каждой активности молча.
      expect(payload?.smallImageKey).toBeUndefined();
      expect(payload?.assets?.small_image).toBeUndefined();
      expect(payload?.smallImageText).toBe('Играет');
      expect(payload?.startTimestamp).toBeDefined();
      expect(payload?.endTimestamp).toBeDefined();
    });

    it('builds payload with paused status when isPlaying is false', () => {
      const track = createMockTrack({ title: 'Song', artist: 'Artist', duration: 200 });
      const payload = discordRpcService.buildPayloadFromTrack(track, false, 50);

      expect(payload?.smallImageKey).toBeUndefined();
      expect(payload?.smallImageText).toBe('Пауза');
      expect(payload?.endTimestamp).toBeUndefined();
    });

    it('returns null payload when track is null or service is disabled', () => {
      const track = createMockTrack();
      expect(discordRpcService.buildPayloadFromTrack(null, true)).toBeNull();

      discordRpcService.setEnabled(false);
      expect(discordRpcService.buildPayloadFromTrack(track, true)).toBeNull();
    });

    it('forwards activity to electronAPI when setActivity is invoked', async () => {
      const payload: DiscordActivityPayload = { details: 'Track A', state: 'Artist A' };
      const success = await discordRpcService.setActivity(payload);

      expect(success).toBe(true);
      expect(mockElectronApi.discordRpcSetActivity).toHaveBeenCalledWith(payload);
    });

    /**
     * Пауза снимает статус, а не оставляет его висеть.
     *
     * Раньше на паузу уходила та же активность, только без отметок времени, и
     * Discord честно показывал «слушает» у человека, который ничего не слушает.
     * Владелец: «когда вырубишь песню, пишется что слушаешь».
     */
    it('на паузе статус снимается, а по play возвращается', async () => {
      const track = createMockTrack({ title: 'Instant Crush', artist: 'Daft Punk', duration: 337 });

      (discordRpcService as any).syncActivity(track, true, 30, 337, true);
      await flushAsync();
      expect(mockElectronApi.discordRpcSetActivity).toHaveBeenLastCalledWith(
        expect.objectContaining({ details: 'Instant Crush' })
      );

      (discordRpcService as any).syncActivity(track, false, 42, 337, true);
      await flushAsync();
      expect(mockElectronApi.discordRpcSetActivity).toHaveBeenLastCalledWith(null);

      // Обратно play: `clearActivity` обнуляет `lastTrackId`, поэтому обычный
      // путь через `handleStoreUpdate` обязан снова счесть это сменой трека —
      // без этого статус не вернулся бы вовсе.
      (discordRpcService as any).handleStoreUpdate(track, true, 42, 337);
      await flushAsync();
      expect(mockElectronApi.discordRpcSetActivity).toHaveBeenLastCalledWith(
        expect.objectContaining({ details: 'Instant Crush' })
      );
    });

    it('clears activity when clearActivity is called', async () => {
      await discordRpcService.clearActivity();
      expect(mockElectronApi.discordRpcSetActivity).toHaveBeenCalledWith(null);
    });

    it('persists enabled setting to database and notifies Electron on setEnabled', async () => {
      await discordRpcService.setEnabled(false);

      expect(discordRpcService.isEnabled()).toBe(false);
      expect(mockElectronApi.discordRpcSetEnabled).toHaveBeenCalledWith(false);
      expect(await dbService.getSetting(DISCORD_RPC_SETTING_KEY, null)).toBe(false);

      await discordRpcService.setEnabled(true);
      expect(discordRpcService.isEnabled()).toBe(true);
      expect(mockElectronApi.discordRpcSetEnabled).toHaveBeenCalledWith(true);
      expect(await dbService.getSetting(DISCORD_RPC_SETTING_KEY, null)).toBe(true);
    });

    it('subscribes to PlayerStore and updates presence when track starts playing', async () => {
      const track = createMockTrack({ title: 'Midnight', artist: 'Artist X' });

      usePlayerStore.setState({
        currentTrack: track,
        isPlaying: true,
        currentTime: 0,
        duration: 240
      });

      await flushAsync();

      expect(mockElectronApi.discordRpcSetActivity).toHaveBeenCalled();
      const lastCall = mockElectronApi.discordRpcSetActivity.mock.calls[mockElectronApi.discordRpcSetActivity.mock.calls.length - 1][0];
      expect(lastCall.details).toBe('Midnight');
      expect(lastCall.state).toBe('Artist X');
    });

    it('handles seek jumps (> 2.5s) with debounced dispatch', () => {
      vi.useFakeTimers();
      try {
        const track = createMockTrack({ title: 'Seek Test', duration: 300 });
        usePlayerStore.setState({ currentTrack: track, isPlaying: true, currentTime: 10, duration: 300 });

        mockElectronApi.discordRpcSetActivity.mockClear();

        // Big jump from 10s to 120s
        usePlayerStore.setState({ currentTime: 120 });

        expect(mockElectronApi.discordRpcSetActivity).not.toHaveBeenCalled();

        // Advance debounce timer (300ms)
        vi.advanceTimersByTime(350);

        expect(mockElectronApi.discordRpcSetActivity).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('survives safely in a browser environment without electronAPI', async () => {
      delete (window as any).electronAPI;

      const nonDesktopService = new DiscordRpcService();
      await nonDesktopService.init();

      expect(nonDesktopService.isDesktop()).toBe(false);
      const res = await nonDesktopService.setActivity({ details: 'A', state: 'B' });
      expect(res).toBe(false);

      nonDesktopService.destroy();
    });
  });

  /**
   * Почему часть треков не показывалась в активности вовсе.
   *
   * Discord проверяет каждое текстовое поле и на коротком отвечает отказом на
   * **всю** активность целиком (код 4000, «length must be at least 2 characters
   * long»). Защита у `details` и `state` была, но не работала: она дополняла
   * обычным пробелом, а его Discord срезает раньше, чем считает длину. У
   * `large_text` защиты не было вовсе, и туда шло название альбома.
   *
   * Всё проверено вживую разговором по трубе с настоящим Discord 2026-08-31:
   * до правки эти случаи получали отказ, после — принимаются все.
   */
  describe('Короткие поля: причина «показываются не все песни»', () => {
    const PAD = ' ';

    it('название из одного знака дополняется неразрывным пробелом, а не обычным', () => {
      const formatted = formatActivityForDiscord({ details: '4', state: 'Artist' });
      expect(formatted?.details).toBe(`4${PAD}`);
      // Обычный пробел Discord срезает до проверки длины — отказ остался бы.
      expect(formatted?.details).not.toBe('4 ');
      expect(String(formatted?.details).length).toBeGreaterThanOrEqual(2);
    });

    it('исполнитель из одного знака тоже доезжает', () => {
      const formatted = formatActivityForDiscord({ details: 'Track', state: 'M' });
      expect(String(formatted?.state).length).toBeGreaterThanOrEqual(2);
    });

    it('короткий альбом доезжает и не роняет всю активность', () => {
      // Именно здесь защиты не было вовсе, и трек пропадал из статуса целиком.
      const short = formatActivityForDiscord({
        details: 'Track',
        state: 'Artist',
        largeImageText: '4'
      });
      expect(short?.assets?.large_text).toBe(`4${PAD}`);

      // Пробел вместо альбома — не альбом: `||` его не отсеивает, потому что
      // непустая строка истинна, и раньше он уезжал в Discord как есть.
      for (const album of [' ', '', '  ']) {
        const formatted = formatActivityForDiscord({
          details: 'Track',
          state: 'Artist',
          largeImageText: album
        });
        expect(formatted?.assets?.large_text, `альбом ${JSON.stringify(album)}`).toBe('Wireon');
      }
    });

    it('нормальный альбом остаётся на месте', () => {
      const formatted = formatActivityForDiscord({
        details: 'Track',
        state: 'Artist',
        largeImageText: 'The Payback'
      });
      expect(formatted?.assets?.large_text).toBe('The Payback');
    });

    it('название из одних пробелов заменяется, а не превращается в пустоту', () => {
      const formatted = formatActivityForDiscord({ details: '   ', state: '   ' });
      expect(formatted?.details).toBe('Wireon');
      expect(formatted?.state).toBe('Listening to music');
    });

    it('длинное название по-прежнему обрезается до 128', () => {
      const formatted = formatActivityForDiscord({ details: 'Ы'.repeat(200), state: 'Artist' });
      expect(String(formatted?.details).length).toBe(128);
    });
  });
});
