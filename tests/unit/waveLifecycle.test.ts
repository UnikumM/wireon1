import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import '../setup';
import { resetPlayerStore } from '../helpers/testUtils';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { audioEngine } from '../../src/services/audioEngine';
import { streamResolver } from '../../src/services/streamResolver';
import { recommendationEngine } from '../../src/services/recommendationEngine';
import type { UnifiedTrack } from '../../src/types/music';

const track = (id: string): UnifiedTrack => ({ id, originalId: id, source: 'youtube', title: id,
  artist: 'Artist', duration: 200, artworkUrl: '' });
const current = track('current');
const next = track('next');
const later = track('later');
const pending = () => {
  let resolve!: (value: UnifiedTrack[]) => void;
  const promise = new Promise<UnifiedTrack[]>((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  usePlayerStore.getState().clearPlayback();
  resetPlayerStore();
  useUIStore.setState({ toastMessage: null });
  vi.spyOn(audioEngine, 'load').mockResolvedValue();
  vi.spyOn(audioEngine, 'play').mockResolvedValue();
  vi.spyOn(streamResolver, 'prefetch').mockImplementation(() => {});
  vi.spyOn(recommendationEngine, 'getRecommendationsForWave').mockResolvedValue([next, later]);
  usePlayerStore.setState({ currentTrack: current, currentTime: 74, playbackState: 'playing',
    isPlaying: true, sourceQueue: [current], currentIndex: 0, waveSeedKind: 'track', autoplayRadio: false });
});
afterEach(() => {
  usePlayerStore.getState().clearPlayback();
  vi.restoreAllMocks();
});

describe('Stream lifecycle', () => {
  it('keeps the playing song and its position when enabling or tuning the stream', async () => {
    await usePlayerStore.getState().startMyWave();
    expect(audioEngine.load).not.toHaveBeenCalled();
    expect(usePlayerStore.getState()).toMatchObject({ currentTrack: current, currentTime: 74,
      isPlaying: true, queueMode: 'my_wave', sourceQueue: [current, next, later], currentIndex: 0 });
    usePlayerStore.getState().setWaveEnergy(0.9);
    await usePlayerStore.getState().startMyWave();
    expect(audioEngine.load).not.toHaveBeenCalled();
    expect(recommendationEngine.getRecommendationsForWave).toHaveBeenLastCalledWith(
      expect.objectContaining({ energy: 0.9, seedTrack: current }), 10, new Set(['current']));
  });

  it('starts a new song only when explicitly requested', async () => {
    await usePlayerStore.getState().startMyWave(undefined, undefined, 'new');
    expect(audioEngine.load).toHaveBeenCalledWith(next, true);
    expect(usePlayerStore.getState().currentTrack).toEqual(next);
    expect(usePlayerStore.getState().currentTime).toBe(0);
  });

  it('resumes a paused song on first launch, but tuning an active paused stream keeps it paused', async () => {
    usePlayerStore.setState({ isPlaying: false, playbackState: 'paused' });
    await usePlayerStore.getState().startMyWave();
    expect(audioEngine.play).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().currentTrack).toEqual(current);
    expect(usePlayerStore.getState().currentTime).toBe(74);
    usePlayerStore.setState({ isPlaying: false, playbackState: 'paused' });
    await usePlayerStore.getState().startMyWave();
    expect(audioEngine.play).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it('keeps the old queue until a slow request completes', async () => {
    const request = pending();
    vi.mocked(recommendationEngine.getRecommendationsForWave).mockReturnValueOnce(request.promise);
    const started = usePlayerStore.getState().startMyWave();
    expect(usePlayerStore.getState().sourceQueue).toEqual([current]);
    request.resolve([next]);
    await started;
    expect(usePlayerStore.getState().sourceQueue).toEqual([current, next]);
  });

  it.each(['empty', 'error'])('keeps playback and queue after an %s result', async (result) => {
    const spy = vi.mocked(recommendationEngine.getRecommendationsForWave);
    if (result === 'empty') spy.mockResolvedValueOnce([]);
    else spy.mockRejectedValueOnce(new Error('offline'));
    await usePlayerStore.getState().startMyWave();
    expect(usePlayerStore.getState()).toMatchObject({ currentTrack: current, currentTime: 74,
      sourceQueue: [current], queueMode: 'sequential', isReplenishingQueue: false });
    expect(useUIStore.getState().toastMessage).not.toBeNull();
  });

  it('deduplicates a batch and excludes the currently playing track', async () => {
    vi.mocked(recommendationEngine.getRecommendationsForWave).mockResolvedValueOnce([current, next, next, later]);
    await usePlayerStore.getState().startMyWave();
    expect(usePlayerStore.getState().sourceQueue).toEqual([current, next, later]);
  });

  it('ignores an older build when a new setting request finishes first', async () => {
    const first = pending();
    vi.mocked(recommendationEngine.getRecommendationsForWave).mockReturnValueOnce(first.promise);
    const slow = usePlayerStore.getState().startMyWave();
    await usePlayerStore.getState().startMyWave('energy', 'Rock');
    first.resolve([track('obsolete')]);
    await slow;
    expect(usePlayerStore.getState().sourceQueue).toEqual([current, next, later]);
    expect(usePlayerStore.getState().activeWaveGenre).toBe('Rock');
  });

  it('cannot bring cleared playback back after a pending build', async () => {
    const request = pending();
    vi.mocked(recommendationEngine.getRecommendationsForWave).mockReturnValueOnce(request.promise);
    const slow = usePlayerStore.getState().startMyWave();
    usePlayerStore.getState().clearPlayback();
    request.resolve([next]);
    await slow;
    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(usePlayerStore.getState().sourceQueue).toEqual([]);
  });

  it('does not append old recommendations after selecting another playlist', async () => {
    const request = pending();
    usePlayerStore.setState({ queueMode: 'my_wave', activeSeedTrack: current });
    vi.mocked(recommendationEngine.getRecommendationsForWave).mockReturnValueOnce(request.promise);
    const loading = usePlayerStore.getState().replenishAutoplayQueue();
    const selected = track('selected');
    await usePlayerStore.getState().playTrack(selected, [selected], 0);
    request.resolve([next]);
    await loading;
    expect(usePlayerStore.getState()).toMatchObject({ currentTrack: selected,
      sourceQueue: [selected], queueMode: 'sequential', isReplenishingQueue: false });
  });
});
