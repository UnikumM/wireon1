import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import {
  GroupListenService,
  type GroupConnectionStatus,
  type GroupListenMessage,
  type GroupState
} from '../../src/services/groupListenService';
import { UnifiedTrack } from '../../src/types/music';

import { FakeBroker } from '../helpers/fakeBroker';

const TRACK: UnifiedTrack = {
  id: 'yt_abc123',
  originalId: 'abc123',
  title: 'Ночной эфир',
  artist: 'Кто-то',
  duration: 214,
  source: 'youtube',
  artworkUrl: '',
  sourceUrl: 'https://example.invalid/abc123'
};

let broker: FakeBroker;
const created: GroupListenService[] = [];

/**
 * A service whose only link to the outside world is the fake broker.
 *
 * `BroadcastChannel` is removed while the instance is constructed: both halves of
 * these tests live in one jsdom window, so a real channel would sync them
 * locally and the assertions would hold even with the wire torn out.
 */
function makeService(userId: string, username: string): GroupListenService {
  const original = (globalThis as any).BroadcastChannel;
  (globalThis as any).BroadcastChannel = undefined;
  try {
    const service = new GroupListenService(userId, username);
    service.configureTransport({
      endpoints: ['wss://fake.broker/mqtt'],
      socketFactory: (url) => broker.connect(url)
    });
    created.push(service);
    return service;
  } finally {
    (globalThis as any).BroadcastChannel = original;
  }
}

/** Lets the deferred socket open and every synchronous reply settle. */
async function flush(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function playing(currentTime: number): GroupState {
  return { track: TRACK, trackId: TRACK.id, isPlaying: true, currentTime, queue: [TRACK] };
}

describe('Совместное прослушивание — через настоящий брокер', () => {
  beforeEach(() => {
    broker = new FakeBroker();
    created.length = 0;
  });

  afterEach(() => {
    for (const service of created) {
      service.leaveRoom();
    }
    vi.useRealTimers();
  });

  describe('Комната между двумя машинами', () => {
    it('хост и гость видят друг друга в списке участников', async () => {
      const host = makeService('host_1', 'Хозяин');
      const guest = makeService('guest_1', 'Гость');

      await host.createRoom('ABC123');
      await flush();
      await guest.joinRoom('ABC123');
      await flush();

      expect(host.getConnectionStatus()).toBe('online');
      expect(guest.getConnectionStatus()).toBe('online');
      expect(host.getParticipants().map((p) => p.id).sort()).toEqual(['guest_1', 'host_1']);
      expect(guest.getParticipants().map((p) => p.id).sort()).toEqual(['guest_1', 'host_1']);
      expect(host.getParticipants().find((p) => p.id === 'guest_1')?.username).toBe('Гость');
      expect(guest.getParticipants().find((p) => p.id === 'host_1')?.isHost).toBe(true);
    });

    it('гость получает позицию, которую играет хост', async () => {
      const host = makeService('host_1', 'Хозяин');
      const guest = makeService('guest_1', 'Гость');
      await host.createRoom('ABC123');
      await guest.joinRoom('ABC123');
      await flush();

      host.broadcastState(playing(42.5));
      await flush();

      const received = guest.getLastReceivedState();
      expect(received?.track?.id).toBe('yt_abc123');
      expect(received?.track?.title).toBe('Ночной эфир');
      expect(received?.isPlaying).toBe(true);
      expect(received?.currentTime).toBeCloseTo(42.5, 1);
      expect(received?.queue).toHaveLength(1);
    });

    it('гость не получает эхо собственных сообщений', async () => {
      const host = makeService('host_1', 'Хозяин');
      const guest = makeService('guest_1', 'Гость');
      await host.createRoom('ABC123');
      await guest.joinRoom('ABC123');
      await flush();

      const seen: GroupListenMessage[] = [];
      guest.onMessage((message) => seen.push(message));
      guest.sendChat('слышно?');
      await flush();

      expect(seen).toHaveLength(0);
    });

    it('чат доходит в обе стороны', async () => {
      const host = makeService('host_1', 'Хозяин');
      const guest = makeService('guest_1', 'Гость');
      await host.createRoom('ABC123');
      await guest.joinRoom('ABC123');
      await flush();

      const atHost: string[] = [];
      const atGuest: string[] = [];
      host.onMessage((m) => m.type === 'chat' && atHost.push(`${m.senderName}: ${m.chatText}`));
      guest.onMessage((m) => m.type === 'chat' && atGuest.push(`${m.senderName}: ${m.chatText}`));

      guest.sendChat('привет!');
      await flush();
      host.sendChat('и тебе');
      await flush();

      expect(atHost).toEqual(['Гость: привет!']);
      expect(atGuest).toEqual(['Хозяин: и тебе']);
    });

    it('одно и то же сообщение, пришедшее дважды, обрабатывается один раз', async () => {
      // Оба транспорта работают одновременно, так что дубли — норма, а не сбой.
      const host = makeService('host_1', 'Хозяин');
      const guest = makeService('guest_1', 'Гость');
      await host.createRoom('ABC123');
      await guest.joinRoom('ABC123');
      await flush();

      const seen: GroupListenMessage[] = [];
      guest.onMessage((message) => seen.push(message));

      const sent = host.sendChat('дубль')!;
      await flush();
      broker.fanOut('wireon/room/ABC123', JSON.stringify(sent), false);
      await flush();

      expect(seen.filter((m) => m.type === 'chat')).toHaveLength(1);
    });
  });

  describe('Поздний гость', () => {
    it('получает сохранённый снимок от брокера, не дожидаясь хоста', async () => {
      // Хост на другой машине, его последний снимок лежит на брокере.
      broker.retained.set(
        'wireon/room/ABC123',
        JSON.stringify({
          type: 'sync_state',
          roomId: 'ABC123',
          senderId: 'host_1',
          senderName: 'Хозяин',
          hostTimestamp: Date.now(),
          state: playing(93.25),
          messageId: 'host_1_snapshot'
        })
      );

      const late = makeService('late_1', 'Опоздавший');
      await late.joinRoom('ABC123');
      await flush();

      expect(late.getLastReceivedState()?.currentTime).toBeCloseTo(93.25, 1);
      expect(late.getLastReceivedState()?.track?.title).toBe('Ночной эфир');
      // Живых sync_state не было ни одного: позицию отдал сам брокер.
      expect(broker.messagesOfType('sync_state')).toHaveLength(0);
    });

    it('хост досылает свою позицию, даже если её никто не подсказывает', async () => {
      const host = makeService('host_1', 'Хозяин');
      await host.createRoom('ABC123');
      await flush();
      host.broadcastState(playing(61));
      await flush();

      const guest = makeService('guest_1', 'Гость');
      await guest.joinRoom('ABC123');
      await flush();

      // Без stateProvider хост отвечает последним, что сам передавал, — а не
      // тем, что последним получил (это чужой join с нулями).
      expect(guest.getLastReceivedState()?.currentTime).toBeCloseTo(61, 1);
      expect(broker.messagesOfType('sync_state')).toHaveLength(2);
    });

    it('получает живую позицию от хоста, если тот её сообщает', async () => {
      const host = makeService('host_1', 'Хозяин');
      let position = 10;
      host.setStateProvider(() => playing(position));
      await host.createRoom('ABC123');
      await flush();

      position = 137.5;
      const guest = makeService('guest_1', 'Гость');
      await guest.joinRoom('ABC123');
      await flush();

      expect(guest.getLastReceivedState()?.currentTime).toBeCloseTo(137.5, 1);
    });

    it('не подхватывает вчерашний снимок как позицию', async () => {
      // Ретейн живёт на брокере, пока его не удалят: часовой давности снимок
      // компенсация задержки утащила бы на час вперёд.
      broker.retained.set(
        'wireon/room/ABC123',
        JSON.stringify({
          type: 'sync_state',
          roomId: 'ABC123',
          senderId: 'host_1',
          hostTimestamp: Date.now() - 3600_000,
          state: playing(500),
          messageId: 'host_1_old_sync'
        })
      );

      const guest = makeService('guest_1', 'Гость');
      await guest.joinRoom('ABC123');
      await flush();

      expect(guest.getLastReceivedState()).toBeNull();
    });

    it('без хоста никакого снимка не остаётся', async () => {
      const host = makeService('host_1', 'Хозяин');
      await host.createRoom('ABC123');
      await flush();
      host.broadcastState(playing(20));
      await flush();

      host.leaveRoom();
      await flush();

      // Иначе следующий, кто наберёт этот код, попадёт во вчерашнюю сессию.
      expect(broker.retained.has('wireon/room/ABC123')).toBe(false);

      const later = makeService('later_1', 'Следующий');
      await later.joinRoom('ABC123');
      await flush();
      expect(later.getLastReceivedState()).toBeNull();
    });

    it('гость ничего не сохраняет на брокере', async () => {
      const host = makeService('host_1', 'Хозяин');
      const guest = makeService('guest_1', 'Гость');
      await host.createRoom('ABC123');
      await guest.joinRoom('ABC123');
      await flush();

      guest.broadcastState(playing(5));
      await flush();

      expect(broker.publishes.filter((p) => p.retain && p.payload.includes('"guest_1"'))).toHaveLength(0);
    });
  });

  describe('Уход из комнаты', () => {
    it('обычный выход убирает участника у остальных', async () => {
      const host = makeService('host_1', 'Хозяин');
      const guest = makeService('guest_1', 'Гость');
      await host.createRoom('ABC123');
      await guest.joinRoom('ABC123');
      await flush();
      expect(host.getParticipants()).toHaveLength(2);

      guest.leaveRoom();
      await flush();

      expect(host.getParticipants().map((p) => p.id)).toEqual(['host_1']);
    });

    it('упавший клиент исчезает по завещанию, а не висит навсегда', async () => {
      const host = makeService('host_1', 'Хозяин');
      const guest = makeService('guest_1', 'Гость');
      await host.createRoom('ABC123');
      await guest.joinRoom('ABC123');
      await flush();
      expect(host.getParticipants()).toHaveLength(2);

      // Закрытая крышка ноутбука: никакого «leave» никто не отправит.
      const guestSocket = broker.sockets.find((s) => s.clientId.includes('guest_1'))!;
      expect(guestSocket.will).not.toBeNull();
      broker.crash(guestSocket);
      await flush();

      expect(host.getParticipants().map((p) => p.id)).toEqual(['host_1']);
    });

    it('корректный выход отменяет завещание — второго «ушёл» не будет', async () => {
      const host = makeService('host_1', 'Хозяин');
      const guest = makeService('guest_1', 'Гость');
      await host.createRoom('ABC123');
      await guest.joinRoom('ABC123');
      await flush();

      const guestSocket = broker.sockets.find((s) => s.clientId.includes('guest_1'))!;
      guest.leaveRoom();
      await flush();

      expect(guestSocket.will).toBeNull();
      expect(broker.messagesOfType('leave')).toHaveLength(1);
    });
  });

  describe('Честный статус соединения', () => {
    it('идёт от «подключаемся» к «на связи»', async () => {
      const host = makeService('host_1', 'Хозяин');
      const seen: Array<[GroupConnectionStatus, string | null]> = [];
      host.onConnectionChange((status, error) => seen.push([status, error]));

      await host.createRoom('ABC123');
      await flush();

      expect(host.getConnectionStatus()).toBe('online');
      expect(seen[0]).toEqual(['offline', null]);
      // «Подключаемся» обязательно проходит: именно это модалка и показывает,
      // пока брокер не ответил.
      expect(seen.map(([status]) => status)).toContain('connecting');
      expect(seen[seen.length - 1]).toEqual(['online', null]);
    });

    it('без комнаты статус — «оффлайн»', () => {
      const service = makeService('solo_1', 'Один');
      expect(service.getConnectionStatus()).toBe('offline');
      expect(service.isConnected()).toBe(false);
    });

    it('недоступный брокер даёт «только это устройство» с причиной', async () => {
      const service = makeService('solo_1', 'Один');
      service.configureTransport({
        socketFactory: () => {
          throw new Error('Сеть недоступна');
        }
      });

      await service.createRoom('ABC123');
      await flush();

      // Комната работает между окнами этой машины — и только.
      expect(service.isConnected()).toBe(true);
      expect(service.getConnectionStatus()).toBe('local');
      expect(service.getConnectionError()).toBe('Сеть недоступна');
    });

    it('выключенный транспорт остаётся локальным и не открывает сокетов', async () => {
      const service = makeService('solo_1', 'Один');
      service.configureTransport({ enabled: false });

      await service.createRoom('ABC123');
      await flush();

      expect(service.getConnectionStatus()).toBe('local');
      expect(broker.sockets).toHaveLength(0);
    });

    it('после выхода из комнаты статус снова «оффлайн»', async () => {
      const host = makeService('host_1', 'Хозяин');
      await host.createRoom('ABC123');
      await flush();
      expect(host.getConnectionStatus()).toBe('online');

      host.leaveRoom();

      expect(host.getConnectionStatus()).toBe('offline');
      expect(broker.sockets).toHaveLength(0);
    });

    it('после переподключения заново объявляет себя в комнате', async () => {
      vi.useFakeTimers();
      const host = makeService('host_1', 'Хозяин');
      const guest = makeService('guest_1', 'Гость');
      await host.createRoom('ABC123');
      await guest.joinRoom('ABC123');
      await vi.advanceTimersByTimeAsync(1);

      const guestSocket = broker.sockets.find((s) => s.clientId.includes('guest_1'))!;
      broker.crash(guestSocket);
      await vi.advanceTimersByTimeAsync(1);
      expect(host.getParticipants()).toHaveLength(1);

      // Клиент возвращается сам, и хост должен снова увидеть гостя.
      await vi.advanceTimersByTimeAsync(1100);

      expect(guest.getConnectionStatus()).toBe('online');
      expect(host.getParticipants().map((p) => p.id).sort()).toEqual(['guest_1', 'host_1']);
    });
  });

  describe('Чужой трафик на публичном брокере', () => {
    it('мусор в теме не ломает комнату', async () => {
      const host = makeService('host_1', 'Хозяин');
      await host.createRoom('ABC123');
      await flush();
      const seen: GroupListenMessage[] = [];
      host.onMessage((message) => seen.push(message));

      broker.fanOut('wireon/room/ABC123', 'не JSON вообще', false);
      broker.fanOut('wireon/room/ABC123', '', false);
      broker.fanOut('wireon/room/ABC123', 'null', false);
      broker.fanOut('wireon/room/ABC123', JSON.stringify({ hello: 'world' }), false);
      await flush();

      expect(seen).toHaveLength(0);
      expect(host.getConnectionStatus()).toBe('online');
      expect(host.getParticipants()).toHaveLength(1);
    });

    it('сообщение с чужим кодом комнаты игнорируется', async () => {
      const host = makeService('host_1', 'Хозяин');
      await host.createRoom('ABC123');
      await flush();
      const seen: GroupListenMessage[] = [];
      host.onMessage((message) => seen.push(message));

      broker.fanOut(
        'wireon/room/ABC123',
        JSON.stringify({
          type: 'sync_state',
          roomId: 'ZZZ999',
          senderId: 'stranger',
          hostTimestamp: Date.now(),
          state: playing(1),
          messageId: 'stranger_1'
        }),
        false
      );
      await flush();

      expect(seen).toHaveLength(0);
      expect(host.getLastReceivedState()).toBeNull();
    });
  });
});
