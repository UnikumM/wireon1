import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  usePlayerStore,
  remapShuffleOrder,
  snapshotQueue
} from '../../src/store/usePlayerStore';
import { audioEngine } from '../../src/services/audioEngine';
import { streamResolver } from '../../src/services/streamResolver';
import { recommendationEngine } from '../../src/services/recommendationEngine';
import * as dbService from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

const track = (n: number): UnifiedTrack => ({
  id: `yt_${n}`,
  source: 'youtube',
  originalId: String(n),
  title: `Song ${n}`,
  artist: `Artist ${n % 3}`,
  duration: 200,
  artworkUrl: ''
});

const list = (count: number) => Array.from({ length: count }, (_, i) => track(i));

function reset() {
  usePlayerStore.setState({
    currentTrack: null,
    playbackState: 'idle',
    isPlaying: false,
    isLoading: false,
    currentTime: 0,
    duration: 0,
    repeatMode: 'off',
    isShuffled: false,
    userQueue: [],
    sourceQueue: [],
    history: [],
    currentIndex: -1,
    shuffleOrder: [],
    queueMode: 'sequential',
    activeSeedTrack: null,
    isReplenishingQueue: false,
    sleepTimerEndsAt: null,
    sleepAtTrackEnd: false,
    autoplayRadio: false,
    crossfadeEnabled: false,
    suggestedTrackIds: [],
    resumePosition: null,
    settingsHydrated: false
  });
}

describe('3.0: перемешивание переживает правку очереди', () => {
  it('сохраняет порядок по трекам и выбрасывает исчезнувшие', () => {
    const before = list(5);
    const order = [2, 0, 4, 1, 3];
    const after = before.filter((t) => t.id !== 'yt_4');
    const remapped = remapShuffleOrder(before, order, after, 2);
    expect(remapped.map((i) => after[i].id)).toEqual(['yt_2', 'yt_0', 'yt_1', 'yt_3']);
  });

  it('новые треки ложатся только в несыгранную часть', () => {
    const before = list(4);
    const order = [3, 1, 0, 2];
    const after = [...before, track(9)];
    // Играет yt_1 (позиция 1 в порядке): новое может встать только после неё.
    for (let i = 0; i < 20; i++) {
      const remapped = remapShuffleOrder(before, order, after, 1);
      expect(remapped).toHaveLength(5);
      expect(new Set(remapped).size).toBe(5);
      expect(remapped.indexOf(4)).toBeGreaterThan(remapped.indexOf(1));
      expect(remapped.slice(0, 2)).toEqual([3, 1]);
    }
  });

  it('разбирает дубликаты по очереди, а не склеивает', () => {
    const t = list(2);
    const before = [t[0], t[1], t[0]];
    const remapped = remapShuffleOrder(before, [2, 1, 0], before, 0);
    expect(remapped.sort()).toEqual([0, 1, 2]);
  });
});

describe('3.0: исправления стора', () => {
  beforeEach(() => {
    reset();
    vi.spyOn(streamResolver, 'prefetch').mockImplementation(() => {});
    vi.spyOn(audioEngine, 'load').mockResolvedValue();
    vi.spyOn(audioEngine, 'play').mockResolvedValue();
  });
  afterEach(() => {
    usePlayerStore.getState().setSleepTimer(null);
    vi.restoreAllMocks();
  });

  it('дизлайк в перемешанной очереди не оставляет номеров за краем', async () => {
    vi.spyOn(recommendationEngine, 'recordFeedback').mockResolvedValue();
    const q = list(6);
    usePlayerStore.setState({
      sourceQueue: q,
      currentTrack: q[3],
      currentIndex: 3,
      isShuffled: true,
      shuffleOrder: [3, 5, 0, 2, 4, 1]
    });
    await usePlayerStore.getState().dislikeAndSkipCurrentTrack();
    const s = usePlayerStore.getState();
    expect(s.sourceQueue.some((t) => t.id === 'yt_3')).toBe(false);
    expect(s.shuffleOrder).toHaveLength(5);
    expect(s.shuffleOrder.every((i) => i >= 0 && i < s.sourceQueue.length)).toBe(true);
    // Следующим сыграл тот, кто стоял следующим в перемешанном порядке.
    expect(s.currentTrack?.id).toBe('yt_5');
  });

  it('правка плейлиста не перемешивает уже сыгранное заново', () => {
    const q = list(5);
    usePlayerStore.setState({
      sourceQueue: q,
      currentTrack: q[4],
      currentIndex: 4,
      isShuffled: true,
      shuffleOrder: [1, 4, 0, 3, 2]
    });
    usePlayerStore.getState().syncSourceQueue([...q, track(7)]);
    const s = usePlayerStore.getState();
    expect(s.shuffleOrder.slice(0, 2)).toEqual([1, 4]);
    expect(s.shuffleOrder).toHaveLength(6);
  });

  it('новый список сбрасывает пометки «подобрано»', async () => {
    usePlayerStore.setState({ suggestedTrackIds: ['yt_1'] });
    const q = list(3);
    await usePlayerStore.getState().playTrack(q[0], q, 0);
    expect(usePlayerStore.getState().suggestedTrackIds).toEqual([]);
  });

  it('таймер «до конца трека» ставит следующий трек на паузе, не открывая его', async () => {
    const q = list(3);
    await usePlayerStore.getState().playTrack(q[0], q, 0);
    const loads = (audioEngine.load as any).mock.calls.length;
    usePlayerStore.getState().setSleepAtTrackEnd(true);
    expect(usePlayerStore.getState().sleepAtTrackEnd).toBe(true);

    await usePlayerStore.getState().onTrackEnded();
    const s = usePlayerStore.getState();
    expect(s.currentTrack?.id).toBe('yt_1');
    expect(s.currentIndex).toBe(1);
    expect(s.playbackState).toBe('paused');
    expect(s.sleepAtTrackEnd).toBe(false);
    expect((audioEngine.load as any).mock.calls.length).toBe(loads);

    // «Играть» открывает поставленный трек.
    vi.spyOn(audioEngine, 'getCurrentTrack').mockReturnValue(q[0]);
    await usePlayerStore.getState().play();
    expect(audioEngine.load).toHaveBeenLastCalledWith(q[1], true);
    expect(usePlayerStore.getState().playbackState).toBe('playing');
  });

  it('минутный таймер и «до конца трека» взаимоисключающие', () => {
    usePlayerStore.getState().setSleepAtTrackEnd(true);
    usePlayerStore.getState().setSleepTimer(15);
    expect(usePlayerStore.getState().sleepAtTrackEnd).toBe(false);
    expect(usePlayerStore.getState().sleepTimerEndsAt).not.toBeNull();
    usePlayerStore.getState().setSleepAtTrackEnd(true);
    expect(usePlayerStore.getState().sleepTimerEndsAt).toBeNull();
  });

  it('кроссфейд не начинает следующий трек, пока ждём конца для сна', () => {
    const next = vi.spyOn(usePlayerStore.getState(), 'nextTrack');
    const q = list(2);
    usePlayerStore.setState({
      currentTrack: q[0],
      sourceQueue: q,
      currentIndex: 0,
      isPlaying: true,
      crossfadeEnabled: true,
      crossfadeDuration: 5,
      sleepAtTrackEnd: true
    });
    usePlayerStore.getState().syncProgress(197, 200, 200);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('3.0: очередь переживает перезапуск', () => {
  beforeEach(async () => {
    reset();
    await dbService.clearAllData();
  });

  it('снимок не несёт ссылок на звук и ограничен по длине', () => {
    const long = Array.from({ length: 700 }, (_, i) => ({ ...track(i), streamUrl: 'https://x', streamExpiry: 1 }));
    const snap = snapshotQueue({
      ...usePlayerStore.getState(),
      currentTrack: long[600],
      sourceQueue: long,
      currentIndex: 600
    });
    expect(snap).not.toBeNull();
    expect(snap!.sourceQueue.length).toBe(500);
    expect(snap!.sourceQueue[snap!.currentIndex].id).toBe('yt_600');
    expect(snap!.sourceQueue[0].streamUrl).toBeUndefined();
  });

  it('пустой плеер даёт пустой снимок', () => {
    expect(snapshotQueue(usePlayerStore.getState())).toBeNull();
  });

  it('восстанавливает очередь вместе с треком', async () => {
    const q = list(4);
    await dbService.setSetting('lastSession', { track: q[1], position: 42, savedAt: Date.now() });
    await dbService.setSetting('lastQueue', {
      ...snapshotQueue({ ...usePlayerStore.getState(), currentTrack: q[1], sourceQueue: q, currentIndex: 1, userQueue: [track(9)] }),
      queueMode: 'sequential'
    });
    await usePlayerStore.getState().hydrateSettings();
    const s = usePlayerStore.getState();
    expect(s.currentTrack?.id).toBe('yt_1');
    expect(s.sourceQueue.map((t) => t.id)).toEqual(q.map((t) => t.id));
    expect(s.currentIndex).toBe(1);
    expect(s.userQueue.map((t) => t.id)).toEqual(['yt_9']);
  });

  it('чужую очередь под другим треком не подставляет', async () => {
    const q = list(4);
    await dbService.setSetting('lastSession', { track: q[2], position: 0, savedAt: Date.now() });
    await dbService.setSetting('lastQueue', snapshotQueue({ ...usePlayerStore.getState(), currentTrack: q[1], sourceQueue: q, currentIndex: 1 }));
    await usePlayerStore.getState().hydrateSettings();
    expect(usePlayerStore.getState().sourceQueue).toEqual([]);
  });
});
