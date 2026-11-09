/**
 * Превью трека по наведению (`src/services/previewPlayer.ts`).
 *
 * Отдельный `<audio>`: десять секунд с 40 % записи, пока основной плеер
 * продолжает играть приглушённым до четверти. Поток грузится только после
 * задержки — пролёт курсора по списку ничего не запускает.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import '../setup';
import {
  PreviewPlayer,
  PREVIEW_DUCK_RATIO,
  PREVIEW_DWELL_MS,
  PREVIEW_FALLBACK_START_SEC,
  PREVIEW_LENGTH_MS,
  PREVIEW_START_RATIO,
  PREVIEW_VOLUME
} from '../../src/services/previewPlayer';
import { streamResolver, type ResolvedStreamInfo } from '../../src/services/streamResolver';
import { audioEngine } from '../../src/services/audioEngine';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import type { UnifiedTrack } from '../../src/types/music';

const track = (id: string, duration = 200): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title: `Трек ${id}`,
  artist: 'Исполнитель',
  duration,
  artworkUrl: ''
});

/** Голый элемент вместо jsdom: нам важны `src`, `currentTime` и вызовы, а не медиа. */
class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  src = '';
  currentTime = 0;
  volume = 1;
  preload = '';
  paused = true;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  getAttribute(name: string) {
    return name === 'src' && this.src ? this.src : null;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  constructor() {
    super();
    FakeAudio.instances.push(this);
  }
}

describe('превью по наведению', () => {
  let player: PreviewPlayer;
  let resolve: MockInstance<typeof streamResolver.resolve>;
  let fade: MockInstance<typeof audioEngine.fadeVolumeTo>;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudio.instances = [];
    vi.stubGlobal('Audio', FakeAudio);
    usePlayerStore.setState({ currentTrack: null, isPlaying: true });
    vi.spyOn(audioEngine, 'getVolume').mockReturnValue(0.8);
    fade = vi.spyOn(audioEngine, 'fadeVolumeTo').mockResolvedValue(undefined);
    resolve = vi
      .spyOn(streamResolver, 'resolve')
      .mockResolvedValue({ streamUrl: 'https://cdn.example/a.webm', format: 'webm', bitrate: 128, expiresAt: 0, cached: false });
    player = new PreviewPlayer();
  });

  afterEach(() => {
    player.resetForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('ранний уход курсора не грузит поток', async () => {
    player.request(track('a1'));
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS - 1);
    player.cancel('a1');
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);

    expect(resolve).not.toHaveBeenCalled();
    expect(FakeAudio.instances).toHaveLength(0);
    expect(player.getState().status).toBe('idle');
  });

  it('после задержки стартует с 40 % записи, тихо и приоритетом prefetch', async () => {
    player.request(track('a1', 200));
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), false, 'prefetch');
    const audio = FakeAudio.instances[0];
    expect(audio.src).toBe('https://cdn.example/a.webm');
    expect(audio.currentTime).toBe(200 * PREVIEW_START_RATIO);
    expect(audio.volume).toBe(PREVIEW_VOLUME);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(player.getState()).toMatchObject({ trackId: 'a1', status: 'playing' });
  });

  it('длительность неизвестна — начинаем с 30 с', async () => {
    player.request(track('a1', 0));
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);
    expect(FakeAudio.instances[0].currentTime).toBe(PREVIEW_FALLBACK_START_SEC);
  });

  it('останавливается через 10 с, прогресс доходит до единицы', async () => {
    player.request(track('a1'));
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);
    await vi.advanceTimersByTimeAsync(PREVIEW_LENGTH_MS / 2);
    expect(player.getState().progress).toBeCloseTo(0.5, 1);

    await vi.advanceTimersByTimeAsync(PREVIEW_LENGTH_MS / 2);
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(FakeAudio.instances[0].src).toBe('');
    expect(player.getState()).toEqual({ trackId: null, status: 'idle', progress: 0 });
  });

  it('приглушает основной плеер до четверти и возвращает после', async () => {
    player.request(track('a1'));
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);
    expect(fade).toHaveBeenCalledTimes(1);
    expect(fade.mock.calls[0][0]).toBeCloseTo(0.8 * PREVIEW_DUCK_RATIO);

    player.cancel('a1');
    expect(fade).toHaveBeenCalledTimes(2);
    // Цель равна текущей громкости — множитель движка возвращается к 1.
    expect(fade.mock.calls[1][0]).toBe(0.8);
  });

  it('основной плеер на паузе — не приглушаем и не «возвращаем»', async () => {
    usePlayerStore.setState({ isPlaying: false });
    player.request(track('a1'));
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);
    player.cancel('a1');
    expect(fade).not.toHaveBeenCalled();
  });

  it('не стартует для трека, который играет сейчас', async () => {
    usePlayerStore.setState({ currentTrack: track('a1') });
    expect(player.request(track('a1'))).toBe(false);
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);
    expect(resolve).not.toHaveBeenCalled();
    expect(player.getState().status).toBe('idle');
  });

  it('уход с соседней обложки не гасит текущее превью', async () => {
    player.request(track('a1'));
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);
    player.cancel('b2');
    expect(player.getState().status).toBe('playing');
  });

  it('ошибка резолва — тихо в покой, без исключений', async () => {
    resolve.mockRejectedValue(new Error('нет источника'));
    player.request(track('a1'));
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);
    expect(player.getState().status).toBe('idle');
    expect(fade).not.toHaveBeenCalled();
  });

  it('новый запрос во время загрузки старого: старый ответ не играет', async () => {
    let release!: (v: ResolvedStreamInfo) => void;
    resolve.mockImplementationOnce(() => new Promise((r) => (release = r)));
    player.request(track('a1'));
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);
    expect(player.getState()).toMatchObject({ trackId: 'a1', status: 'loading' });

    player.request(track('b2'));
    release({ streamUrl: 'https://cdn.example/old.webm', format: 'webm', bitrate: 128, expiresAt: 0, cached: false });
    await vi.advanceTimersByTimeAsync(PREVIEW_DWELL_MS);

    expect(player.getState()).toMatchObject({ trackId: 'b2', status: 'playing' });
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe('https://cdn.example/a.webm');
  });
});
