import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import '../setup';
import { FakeBroker } from '../helpers/fakeBroker';
import { encodePublish } from '../../src/services/mqttClient';
import {
  publishNowPlaying,
  startLibrarySignal,
  stopLibrarySignal,
  topicForUser,
  type RemotePlaying
} from '../../src/services/librarySignal';
import { remotePosition, useHandoffStore } from '../../src/store/useHandoffStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { resetPlayerStore } from '../helpers/testUtils';
import type { UnifiedTrack } from '../../src/types/music';

const BROKER = 'ws://broker.test:8099/mqtt';

const track: UnifiedTrack = {
  id: 'yt_handoff',
  source: 'youtube',
  originalId: 'handoff',
  title: 'Город спит',
  artist: 'Лампа',
  duration: 240,
  artworkUrl: ''
};

async function connected(broker: FakeBroker) {
  const socket = broker.connect(BROKER);
  await Promise.resolve();
  socket.onopen?.();
  await Promise.resolve();
  return socket;
}

describe('Продолжить на другом устройстве', () => {
  beforeEach(() => {
    resetPlayerStore();
    useHandoffStore.setState({ remote: null, dismissedAt: null });
  });
  afterEach(() => {
    stopLibrarySignal();
    vi.restoreAllMocks();
  });

  it('звонок о медиатеке по-прежнему идёт в свою тему, «что играет» — в соседнюю и удерживается', async () => {
    const broker = new FakeBroker();
    await startLibrarySignal({
      userId: 'discord_777',
      onNudge: vi.fn(),
      onRemotePlaying: vi.fn(),
      endpoints: [BROKER],
      socketFactory: (url) => broker.connect(url)
    });
    const topic = (await topicForUser('discord_777')) as string;

    expect(publishNowPlaying({ track, position: 84, playing: true })).toBe(true);

    expect(broker.publishes).toHaveLength(1);
    expect(broker.publishes[0].topic).toBe(`${topic}/np`);
    expect(broker.publishes[0].retain).toBe(true);
    const payload = JSON.parse(broker.publishes[0].payload) as Record<string, unknown>;
    expect(payload.kind).toBe('playing');
    expect((payload.track as UnifiedTrack).title).toBe('Город спит');
  });

  it('сообщение с другого устройства попадает в стор, своё эхо — нет', async () => {
    const broker = new FakeBroker();
    const onRemotePlaying = vi.fn();
    await startLibrarySignal({
      userId: 'discord_777',
      onNudge: vi.fn(),
      onRemotePlaying,
      endpoints: [BROKER],
      socketFactory: (url) => broker.connect(url)
    });
    const topic = (await topicForUser('discord_777')) as string;

    // Своё.
    publishNowPlaying({ track, position: 10, playing: true });
    expect(onRemotePlaying).not.toHaveBeenCalled();

    // Чужое.
    const other = await connected(broker);
    const remote: RemotePlaying & { kind: 'playing' } = {
      kind: 'playing', device: 'телефон', platform: 'mobile', at: Date.now(), track, position: 84, playing: true
    };
    other.send(encodePublish(`${topic}/np`, JSON.stringify(remote)));
    expect(onRemotePlaying).toHaveBeenCalledTimes(1);
    expect(onRemotePlaying.mock.calls[0][0]).toMatchObject({ platform: 'mobile', position: 84 });

    // Там остановились.
    other.send(encodePublish(`${topic}/np`, JSON.stringify({ kind: 'idle', device: 'телефон', at: Date.now() })));
    expect(onRemotePlaying).toHaveBeenLastCalledWith(null);
  });

  it('позиция досчитывается по часам, пока там играет, и не уходит за длительность', () => {
    const at = 1_000_000;
    const remote: RemotePlaying = { device: 'd', platform: 'mobile', at, track, position: 100, playing: true };
    expect(remotePosition(remote, at + 30_000)).toBe(130);
    expect(remotePosition(remote, at + 10_000_000)).toBe(240);
    expect(remotePosition({ ...remote, playing: false }, at + 30_000)).toBe(100);
  });

  it('«Продолжить здесь» включает трек с той же секунды, отмахнувшись — то же сообщение не возвращается', async () => {
    const playTrack = vi.fn().mockResolvedValue(undefined);
    const seekTo = vi.fn();
    usePlayerStore.setState({ playTrack, seekTo } as never);
    const remote: RemotePlaying = { device: 'd', platform: 'electron', at: Date.now() - 5000, track, position: 60, playing: true };

    useHandoffStore.getState().setRemote(remote);
    expect(useHandoffStore.getState().remote).not.toBeNull();
    await useHandoffStore.getState().takeOver();
    expect(playTrack).toHaveBeenCalledWith(track);
    expect(seekTo.mock.calls[0][0]).toBeGreaterThanOrEqual(65);
    expect(useHandoffStore.getState().remote).toBeNull();

    // То же сообщение после отказа не воскресает, более новое — показывается.
    useHandoffStore.getState().setRemote(remote);
    expect(useHandoffStore.getState().remote).toBeNull();
    useHandoffStore.getState().setRemote({ ...remote, at: Date.now() + 1 });
    expect(useHandoffStore.getState().remote).not.toBeNull();
    useHandoffStore.getState().dismiss();
    expect(useHandoffStore.getState().remote).toBeNull();
  });
});
