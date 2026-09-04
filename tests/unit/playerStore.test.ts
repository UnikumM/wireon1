import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import { usePlayerStore, generateShuffledIndices } from '../../src/store/usePlayerStore';
import { audioEngine } from '../../src/services/audioEngine';
import { MediaSessionService } from '../../src/services/mediaSession';
import { streamResolver } from '../../src/services/streamResolver';
import { searchAggregator } from '../../src/services/aggregator';
import { recommendationEngine } from '../../src/services/recommendationEngine';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import * as dbService from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

const mockTracks: UnifiedTrack[] = [
  {
    id: 'yt_track_1',
    source: 'youtube',
    originalId: 'track_1',
    title: 'Track One',
    artist: 'Artist One',
    duration: 200,
    artworkUrl: 'https://example.com/1.jpg',
    streamUrl: 'https://example.com/stream1.mp3'
  },
  {
    id: 'sc_track_2',
    source: 'soundcloud',
    originalId: 'track_2',
    title: 'Track Two',
    artist: 'Artist Two',
    duration: 180,
    artworkUrl: 'https://example.com/2.jpg',
    streamUrl: 'https://example.com/stream2.mp3'
  },
  {
    id: 'yt_track_3',
    source: 'youtube',
    originalId: 'track_3',
    title: 'Track Three',
    artist: 'Artist Three',
    duration: 240,
    artworkUrl: 'https://example.com/3.jpg',
    streamUrl: 'https://example.com/stream3.mp3'
  }
];

describe('Player Store (usePlayerStore & 2-Tier Queue)', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      currentTrack: null,
      playbackState: 'idle',
      isPlaying: false,
      isLoading: false,
      currentTime: 0,
      duration: 0,
      buffered: 0,
      volume: 0.8,
      isMuted: false,
      previousVolume: 0.8,
      repeatMode: 'off',
      isShuffled: false,
      error: null,
      errorDetail: null,
      errorCanRetry: true,
      isPreviewStream: false,
      userQueue: [],
      sourceQueue: [],
      history: [],
      currentIndex: -1,
      shuffleOrder: [],
      queueMode: 'sequential',
      activeWaveMood: 'favorite',
      activeWaveGenre: null,
      activeSeedTrack: null,
      isReplenishingQueue: false,
      visualizerEnabled: true,
      visualizerPreset: 'CYBER_BARS',
      sleepTimerEndsAt: null,
      autoplayRadio: false,
      eq: { bass: 0, mid: 0, treble: 0 },
      mediaKeysEnabled: true,
      settingsHydrated: false
    });

    // Prefetching the upcoming track must never reach the network in tests
    vi.spyOn(streamResolver, 'prefetch').mockImplementation(() => {});
  });

  afterEach(() => {
    usePlayerStore.getState().setSleepTimer(null);
    vi.restoreAllMocks();
  });

  describe('Initial State & Basics', () => {
    it('has proper default state values', () => {
      const state = usePlayerStore.getState();
      expect(state.currentTrack).toBeNull();
      expect(state.isPlaying).toBe(false);
      expect(state.volume).toBe(0.8);
      expect(state.repeatMode).toBe('off');
      expect(state.isShuffled).toBe(false);
      expect(state.userQueue).toEqual([]);
      expect(state.sourceQueue).toEqual([]);
      expect(state.history).toEqual([]);
    });

    it('generates Fisher-Yates shuffled indices correctly', () => {
      const indices = generateShuffledIndices(5, 2);
      expect(indices).toHaveLength(5);
      expect(indices[0]).toBe(2); // Current index preserved at front
      expect(new Set(indices).size).toBe(5); // All indices 0..4 present
    });
  });

  describe('Track Loading & Playback Actions', () => {
    it('plays a track and updates queue and history', async () => {
      const loadSpy = vi.spyOn(audioEngine, 'load').mockResolvedValue();

      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);

      const state = usePlayerStore.getState();
      expect(state.currentTrack?.id).toBe('yt_track_1');
      expect(state.sourceQueue).toHaveLength(3);
      expect(state.currentIndex).toBe(0);
      expect(loadSpy).toHaveBeenCalledWith(mockTracks[0], true);

      // Play second track and verify first track moved to history
      await usePlayerStore.getState().playTrack(mockTracks[1], mockTracks, 1);
      const updatedState = usePlayerStore.getState();
      expect(updatedState.currentTrack?.id).toBe('sc_track_2');
      expect(updatedState.history).toHaveLength(1);
      expect(updatedState.history[0].id).toBe('yt_track_1');
    });

    it('toggles play/pause, pauses, and resumes', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const playSpy = vi.spyOn(audioEngine, 'play').mockResolvedValue();
      const pauseSpy = vi.spyOn(audioEngine, 'pause');

      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);
      usePlayerStore.setState({ playbackState: 'playing', isPlaying: true });

      // Toggle to pause
      await usePlayerStore.getState().togglePlayPause();
      expect(pauseSpy).toHaveBeenCalled();
      expect(usePlayerStore.getState().playbackState).toBe('paused');

      // Toggle to play
      await usePlayerStore.getState().togglePlayPause();
      expect(playSpy).toHaveBeenCalled();
      expect(usePlayerStore.getState().playbackState).toBe('playing');
    });

    it('seeks to position and adjusts volume & mute', () => {
      const seekSpy = vi.spyOn(audioEngine, 'seek');
      const setVolSpy = vi.spyOn(audioEngine, 'setVolume');
      const setMuteSpy = vi.spyOn(audioEngine, 'setMuted');

      usePlayerStore.setState({ duration: 200 });

      usePlayerStore.getState().seekTo(75);
      expect(seekSpy).toHaveBeenCalledWith(75);
      expect(usePlayerStore.getState().currentTime).toBe(75);

      usePlayerStore.getState().setVolume(0.5);
      expect(setVolSpy).toHaveBeenCalledWith(0.5);
      expect(usePlayerStore.getState().volume).toBe(0.5);

      usePlayerStore.getState().toggleMute();
      expect(setMuteSpy).toHaveBeenCalledWith(true);
      expect(usePlayerStore.getState().isMuted).toBe(true);

      usePlayerStore.getState().toggleMute();
      expect(setMuteSpy).toHaveBeenCalledWith(false);
      expect(usePlayerStore.getState().isMuted).toBe(false);
    });

    it('cycles repeat mode (off -> all -> one -> off)', () => {
      expect(usePlayerStore.getState().repeatMode).toBe('off');

      usePlayerStore.getState().cycleRepeatMode();
      expect(usePlayerStore.getState().repeatMode).toBe('all');

      usePlayerStore.getState().cycleRepeatMode();
      expect(usePlayerStore.getState().repeatMode).toBe('one');

      usePlayerStore.getState().cycleRepeatMode();
      expect(usePlayerStore.getState().repeatMode).toBe('off');
    });
  });

  describe('2-Tier Queue Priority & Management', () => {
    it('consumes userQueue (Up Next) before advancing sourceQueue', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();

      // Start playing track 0 from sourceQueue
      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);

      // User queues track 3 as high priority Up Next
      usePlayerStore.getState().addToUserQueue(mockTracks[2]);
      expect(usePlayerStore.getState().userQueue).toHaveLength(1);

      // Calling nextTrack should play queued track 3
      await usePlayerStore.getState().nextTrack();
      expect(usePlayerStore.getState().currentTrack?.id).toBe('yt_track_3');
      expect(usePlayerStore.getState().userQueue).toHaveLength(0);

      // Calling nextTrack again should resume sourceQueue at track 1
      await usePlayerStore.getState().nextTrack();
      expect(usePlayerStore.getState().currentTrack?.id).toBe('sc_track_2');
      expect(usePlayerStore.getState().currentIndex).toBe(1);
    });

    it('supports addToQueueNext, reordering, and removing from userQueue', () => {
      usePlayerStore.getState().addToUserQueue(mockTracks[0]);
      usePlayerStore.getState().addToUserQueue(mockTracks[1]);
      usePlayerStore.getState().addToQueueNext(mockTracks[2]); // Insert at top

      let q = usePlayerStore.getState().userQueue;
      expect(q[0].id).toBe('yt_track_3');
      expect(q[1].id).toBe('yt_track_1');
      expect(q[2].id).toBe('sc_track_2');

      // Reorder track 0 (track 3) to position 2
      usePlayerStore.getState().reorderUserQueue(0, 2);
      q = usePlayerStore.getState().userQueue;
      expect(q[0].id).toBe('yt_track_1');
      expect(q[1].id).toBe('sc_track_2');
      expect(q[2].id).toBe('yt_track_3');

      // Remove index 1 (track 2)
      usePlayerStore.getState().removeFromUserQueue(1);
      q = usePlayerStore.getState().userQueue;
      expect(q).toHaveLength(2);
      expect(q[0].id).toBe('yt_track_1');
      expect(q[1].id).toBe('yt_track_3');

      // Clear user queue
      usePlayerStore.getState().clearQueue();
      expect(usePlayerStore.getState().userQueue).toHaveLength(0);
    });
  });

  describe('Next & Previous Deterministic Navigation', () => {
    it('handles repeat mode "one" by seeking to 0 and replaying', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const seekSpy = vi.spyOn(audioEngine, 'seek');
      const playSpy = vi.spyOn(audioEngine, 'play').mockResolvedValue();

      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);
      usePlayerStore.setState({ repeatMode: 'one', currentTime: 40 });

      await usePlayerStore.getState().nextTrack();
      expect(seekSpy).toHaveBeenCalledWith(0);
      expect(playSpy).toHaveBeenCalled();
      expect(usePlayerStore.getState().currentTrack?.id).toBe('yt_track_1');
    });

    it('loops playlist when repeatMode is "all" at the end of queue', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();

      await usePlayerStore.getState().playTrack(mockTracks[2], mockTracks, 2); // last track
      usePlayerStore.setState({ repeatMode: 'all' });

      await usePlayerStore.getState().nextTrack();
      expect(usePlayerStore.getState().currentIndex).toBe(0);
      expect(usePlayerStore.getState().currentTrack?.id).toBe('yt_track_1');
    });

    it('prevTrack restarts current track if played > 3 seconds', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const seekSpy = vi.spyOn(audioEngine, 'seek');

      await usePlayerStore.getState().playTrack(mockTracks[1], mockTracks, 1);
      usePlayerStore.setState({ currentTime: 15.0 });

      await usePlayerStore.getState().prevTrack();
      expect(seekSpy).toHaveBeenCalledWith(0);
      expect(usePlayerStore.getState().currentTrack?.id).toBe('sc_track_2');
    });

    it('prevTrack navigates back using history stack when <= 3 seconds', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();

      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);
      await usePlayerStore.getState().playTrack(mockTracks[2], mockTracks, 2);

      usePlayerStore.setState({ currentTime: 1.5 });
      expect(usePlayerStore.getState().history).toHaveLength(1);

      await usePlayerStore.getState().prevTrack();
      expect(usePlayerStore.getState().currentTrack?.id).toBe('yt_track_1');
      expect(usePlayerStore.getState().history).toHaveLength(0);
    });
  });

  describe('Non-Destructive Shuffle Mode', () => {
    it('toggles shuffle on and off without mutating sourceQueue', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();

      await usePlayerStore.getState().playTrack(mockTracks[1], mockTracks, 1);
      usePlayerStore.getState().toggleShuffle();

      const stateShuffled = usePlayerStore.getState();
      expect(stateShuffled.isShuffled).toBe(true);
      expect(stateShuffled.shuffleOrder).toHaveLength(3);
      expect(stateShuffled.shuffleOrder[0]).toBe(1); // Current track index is first
      expect(stateShuffled.sourceQueue).toEqual(mockTracks); // Unmutated

      // Toggle off
      usePlayerStore.getState().toggleShuffle();
      const stateRestored = usePlayerStore.getState();
      expect(stateRestored.isShuffled).toBe(false);
      expect(stateRestored.shuffleOrder).toEqual([]);
      expect(stateRestored.sourceQueue).toEqual(mockTracks);
      expect(stateRestored.currentIndex).toBe(1);
    });
  });

  describe('Visualizer & Progress Sync', () => {
    it('toggles visualizer and updates presets', () => {
      expect(usePlayerStore.getState().visualizerEnabled).toBe(true);
      usePlayerStore.getState().toggleVisualizer();
      expect(usePlayerStore.getState().visualizerEnabled).toBe(false);

      usePlayerStore.getState().setVisualizerPreset('HOLOGRAPHIC_WAVE');
      expect(usePlayerStore.getState().visualizerPreset).toBe('HOLOGRAPHIC_WAVE');
    });

    it('syncs progress from audio engine', () => {
      usePlayerStore.getState().syncProgress(42.5, 200, 80);
      const state = usePlayerStore.getState();
      expect(state.currentTime).toBe(42.5);
      expect(state.duration).toBe(200);
      expect(state.buffered).toBe(80);
    });

    it('never stores a non-finite duration for chunked streams', () => {
      usePlayerStore.setState({ duration: 180 });
      usePlayerStore.getState().syncProgress(10, Infinity, NaN);
      const state = usePlayerStore.getState();
      expect(state.duration).toBe(180); // last known good value, never Infinity
      expect(Number.isFinite(state.duration)).toBe(true);
      expect(state.buffered).toBe(0);
    });
  });

  describe('C2 Regression: mute / unmute round trip', () => {
    it('restores an audible volume after setVolume(0) followed by toggleMute()', () => {
      const setVolSpy = vi.spyOn(audioEngine, 'setVolume');
      const setMuteSpy = vi.spyOn(audioEngine, 'setMuted');
      setVolSpy.mockClear();
      setMuteSpy.mockClear();

      usePlayerStore.getState().setVolume(0);
      let state = usePlayerStore.getState();
      expect(state.volume).toBe(0);
      expect(state.isMuted).toBe(true);
      expect(state.previousVolume).toBe(0.8); // remembered, not overwritten with 0
      expect(setMuteSpy).toHaveBeenNthCalledWith(1, true);

      usePlayerStore.getState().toggleMute();
      state = usePlayerStore.getState();
      expect(state.isMuted).toBe(false);
      expect(state.volume).toBeGreaterThan(0);
      expect(state.volume).toBe(0.8);
      expect(setMuteSpy).toHaveBeenNthCalledWith(2, false);
      expect(setVolSpy).toHaveBeenLastCalledWith(0.8);
    });

    it('falls back to a default level when nothing audible was ever set', () => {
      usePlayerStore.setState({ volume: 0, previousVolume: 0, isMuted: true });

      usePlayerStore.getState().toggleMute();
      const state = usePlayerStore.getState();
      expect(state.isMuted).toBe(false);
      expect(state.volume).toBe(0.5);
    });

    it('setMuted(false) is consistent with toggleMute()', () => {
      usePlayerStore.getState().setVolume(0.4);
      usePlayerStore.getState().setMuted(true);
      expect(usePlayerStore.getState().isMuted).toBe(true);

      usePlayerStore.getState().setMuted(false);
      const state = usePlayerStore.getState();
      expect(state.isMuted).toBe(false);
      expect(state.volume).toBe(0.4);
    });
  });

  describe('M4 Regression: single track-commit path', () => {
    it('reports "loading" to the OS and only claims "playing" once the stream resolved', async () => {
      const sessionSpy = vi.spyOn(MediaSessionService, 'updatePlaybackState');
      sessionSpy.mockClear();

      let resolveLoad: () => void = () => {};
      vi.spyOn(audioEngine, 'load').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveLoad = resolve;
          })
      );

      const pending = usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);
      await Promise.resolve();

      expect(usePlayerStore.getState().playbackState).toBe('loading');
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      expect(sessionSpy.mock.calls.map((c) => c[0])).toEqual(['loading']);

      resolveLoad();
      await pending;

      expect(usePlayerStore.getState().playbackState).toBe('playing');
      expect(sessionSpy.mock.calls.map((c) => c[0])).toEqual(['loading', 'playing']);
    });

    it('flags a snipped SoundCloud stream and clears the flag on the next track', async () => {
      // The store cannot know a stream is a 30-second snippet until the engine
      // has resolved it, so the flag has to be read back off the enriched track.
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const trackSpy = vi
        .spyOn(audioEngine, 'getCurrentTrack')
        .mockReturnValue({ ...mockTracks[1], isPreview: true });

      await usePlayerStore.getState().playTrack(mockTracks[1], mockTracks, 1);
      expect(usePlayerStore.getState().isPreviewStream).toBe(true);

      trackSpy.mockReturnValue({ ...mockTracks[0], isPreview: false });
      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);
      expect(usePlayerStore.getState().isPreviewStream).toBe(false);
    });

    it('records a human-readable error and keeps the track when the stream fails', async () => {
      vi.spyOn(audioEngine, 'load').mockRejectedValue(new Error('CDN returned 403'));

      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);

      const state = usePlayerStore.getState();
      expect(state.playbackState).toBe('error');
      // The bar shows copy a listener can act on; the thrown message stays
      // reachable as `errorDetail` (the tooltip) so a report still has the cause.
      expect(state.error).toMatch(/ссылка на поток истекла/i);
      expect(state.errorDetail).toContain('CDN returned 403');
      expect(state.errorCanRetry).toBe(true);
      expect(state.isPlaying).toBe(false);
      expect(state.isLoading).toBe(false);
      expect(state.currentTrack?.id).toBe('yt_track_1');
    });

    it('does not write history-sourced tracks back into the database history', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();

      const realAddToHistory = useLibraryStore.getState().addToHistory;
      const historySpy = vi.fn().mockResolvedValue(true);
      useLibraryStore.setState({ addToHistory: historySpy });

      try {
        await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);
        await usePlayerStore.getState().playTrack(mockTracks[1], mockTracks, 1);
        expect(historySpy).toHaveBeenCalledTimes(2);

        usePlayerStore.setState({ currentTime: 0.5 });
        await usePlayerStore.getState().prevTrack();

        expect(usePlayerStore.getState().currentTrack?.id).toBe('yt_track_1');
        expect(historySpy).toHaveBeenCalledTimes(2); // no extra DB write
      } finally {
        useLibraryStore.setState({ addToHistory: realAddToHistory });
      }
    });

    it('keeps the current track when the queue is exhausted', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();

      await usePlayerStore.getState().playTrackSingle(mockTracks[0]);
      usePlayerStore.setState({
        sourceQueue: [],
        userQueue: [],
        currentIndex: -1,
        repeatMode: 'off',
        autoplayRadio: false,
        currentTime: 42,
        playbackState: 'playing',
        isPlaying: true
      });

      await usePlayerStore.getState().nextTrack(true);

      const state = usePlayerStore.getState();
      expect(state.currentTrack).not.toBeNull();
      expect(state.currentTrack?.id).toBe('yt_track_1');
      expect(state.isPlaying).toBe(false);
      expect(state.playbackState).toBe('paused');
      expect(state.currentTime).toBe(0);
    });

    it('exposes both queue action aliases backed by one implementation', () => {
      usePlayerStore.getState().addToQueueEnd(mockTracks[0]);
      usePlayerStore.getState().addToUserQueue(mockTracks[1]);
      expect(usePlayerStore.getState().userQueue.map((t) => t.id)).toEqual(['yt_track_1', 'sc_track_2']);

      usePlayerStore.getState().addToQueueNext(mockTracks[2]);
      expect(usePlayerStore.getState().userQueue[0].id).toBe('yt_track_3');

      usePlayerStore.getState().clearUserQueue();
      expect(usePlayerStore.getState().userQueue).toEqual([]);

      usePlayerStore.getState().addToQueueEnd(mockTracks[0]);
      usePlayerStore.getState().clearQueue();
      expect(usePlayerStore.getState().userQueue).toEqual([]);
    });

    it('prefetches the upcoming track once playback started', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const prefetchSpy = vi.spyOn(streamResolver, 'prefetch').mockImplementation(() => {});

      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);

      expect(prefetchSpy).toHaveBeenCalledWith(mockTracks[1]);
    });

    it('warms more than one track ahead, in the order they will play', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const prefetchSpy = vi.spyOn(streamResolver, 'prefetch').mockImplementation(() => {});

      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);

      // Второе «дальше» подряд не должно снова ждать yt-dlp.
      expect(prefetchSpy.mock.calls.map(([track]) => track.id)).toEqual([
        'sc_track_2',
        'yt_track_3'
      ]);
    });

    it('warms the manual queue before the rest, and never the same track twice', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      usePlayerStore.getState().addToQueueEnd(mockTracks[2]);
      const prefetchSpy = vi.spyOn(streamResolver, 'prefetch').mockImplementation(() => {});

      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);

      // Третий трек стоит и в ручной очереди, и в основной — греем его один раз.
      expect(prefetchSpy.mock.calls.map(([track]) => track.id)).toEqual([
        'yt_track_3',
        'sc_track_2'
      ]);
    });

    it('does not warm past the end of the queue unless repeat is on', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const prefetchSpy = vi.spyOn(streamResolver, 'prefetch').mockImplementation(() => {});

      await usePlayerStore.getState().playTrack(mockTracks[2], mockTracks, 2);
      expect(prefetchSpy).not.toHaveBeenCalled();

      usePlayerStore.setState({ repeatMode: 'all' });
      await usePlayerStore.getState().playTrack(mockTracks[2], mockTracks, 2);
      expect(prefetchSpy.mock.calls.map(([track]) => track.id)).toEqual([
        'yt_track_1',
        'sc_track_2'
      ]);
    });
  });

  describe('M5 Regression: syncSourceQueue', () => {
    it('relocates the playing track without interrupting playback', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      await usePlayerStore.getState().playTrack(mockTracks[1], mockTracks, 1);

      // Playlist edited: the first track was removed
      usePlayerStore.getState().syncSourceQueue([mockTracks[1], mockTracks[2]]);

      let state = usePlayerStore.getState();
      expect(state.sourceQueue).toHaveLength(2);
      expect(state.currentIndex).toBe(0);
      expect(state.currentTrack?.id).toBe('sc_track_2');
      expect(state.playbackState).toBe('playing');

      // Advancing now continues after the relocated track
      await usePlayerStore.getState().nextTrack(true);
      expect(usePlayerStore.getState().currentTrack?.id).toBe('yt_track_3');
    });

    it('clamps the index when the playing track disappeared, without changing playback', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      await usePlayerStore.getState().playTrack(mockTracks[2], mockTracks, 2);

      usePlayerStore.getState().syncSourceQueue([mockTracks[0]]);

      const state = usePlayerStore.getState();
      expect(state.currentTrack?.id).toBe('yt_track_3'); // untouched
      expect(state.currentIndex).toBe(0);
      expect(state.sourceQueue).toHaveLength(1);
    });

    it('rebuilds the shuffle order when shuffle is active', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);
      usePlayerStore.getState().toggleShuffle();

      usePlayerStore.getState().syncSourceQueue([mockTracks[2], mockTracks[0]]);

      const state = usePlayerStore.getState();
      expect(state.currentIndex).toBe(1);
      expect(state.shuffleOrder).toHaveLength(2);
      expect(state.shuffleOrder[0]).toBe(1);
      expect(new Set(state.shuffleOrder).size).toBe(2);
    });
  });

  describe('M7 Regression: settings persistence', () => {
    it('restores persisted volume and repeat mode exactly once', async () => {
      await dbService.setSetting('volume', 0.42);
      await dbService.setSetting('repeatMode', 'all');
      usePlayerStore.setState({ volume: 0.8, repeatMode: 'off', settingsHydrated: false });

      await usePlayerStore.getState().hydrateSettings();

      let state = usePlayerStore.getState();
      expect(state.volume).toBe(0.42);
      expect(state.repeatMode).toBe('all');
      expect(state.settingsHydrated).toBe(true);

      // Idempotent: a second call must not re-read or overwrite live state
      await dbService.setSetting('volume', 0.11);
      await usePlayerStore.getState().hydrateSettings();
      state = usePlayerStore.getState();
      expect(state.volume).toBe(0.42);
    });

    it('persists volume, repeat mode and eq settings through the db service', async () => {
      usePlayerStore.getState().setVolume(0.33);
      usePlayerStore.getState().setRepeatMode('one');
      usePlayerStore.getState().setEq({ bass: 6 });
      await Promise.resolve();

      expect(await dbService.getSetting<number>('volume', -1)).toBe(0.33);
      expect(await dbService.getSetting<string>('repeatMode', 'off')).toBe('one');
      expect(await dbService.getSetting<{ bass: number }>('eq', { bass: 0 })).toMatchObject({ bass: 6 });
    });

    it('never throws when the settings table is unavailable', async () => {
      vi.spyOn(dbService, 'getSetting').mockRejectedValue(new Error('IndexedDB blocked'));
      usePlayerStore.setState({ settingsHydrated: false });

      await expect(usePlayerStore.getState().hydrateSettings()).resolves.toBeUndefined();
      expect(usePlayerStore.getState().settingsHydrated).toBe(true);
    });

    it('clamps eq gains to the supported range', () => {
      usePlayerStore.getState().setEq({ bass: 99, mid: -99, treble: NaN });
      expect(usePlayerStore.getState().eq).toEqual({ bass: 12, mid: -12, treble: 0 });
    });
  });

  describe('Sleep timer & autoplay radio', () => {
    it('fades out, pauses playback and restores the previous volume', async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(audioEngine, 'load').mockResolvedValue();
        const pauseSpy = vi.spyOn(audioEngine, 'pause');

        await usePlayerStore.getState().playTrackSingle(mockTracks[0]);
        usePlayerStore.setState({ playbackState: 'playing', isPlaying: true, volume: 0.6 });
        pauseSpy.mockClear();

        usePlayerStore.getState().setSleepTimer(1);
        expect(usePlayerStore.getState().sleepTimerEndsAt).toBeGreaterThan(Date.now());
        expect(pauseSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(60_000); // timer fires, fade starts
        await vi.advanceTimersByTimeAsync(6_000); // 5s fade completes

        const state = usePlayerStore.getState();
        expect(pauseSpy).toHaveBeenCalled();
        expect(state.isPlaying).toBe(false);
        expect(state.playbackState).toBe('paused');
        expect(state.volume).toBe(0.6); // stored level untouched by the fade
        expect(state.sleepTimerEndsAt).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('setSleepTimer(null) cancels a pending timer', async () => {
      vi.useFakeTimers();
      try {
        const pauseSpy = vi.spyOn(audioEngine, 'pause');
        pauseSpy.mockClear();

        usePlayerStore.getState().setSleepTimer(10);
        usePlayerStore.getState().setSleepTimer(null);
        expect(usePlayerStore.getState().sleepTimerEndsAt).toBeNull();

        await vi.advanceTimersByTimeAsync(11 * 60_000);
        expect(pauseSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('extends an exhausted queue with related tracks when autoplay radio is on', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const radioTrack: UnifiedTrack = {
        id: 'yt_radio_1',
        source: 'youtube',
        originalId: 'radio_1',
        title: 'Radio Pick',
        artist: 'Related Artist',
        duration: 210,
        artworkUrl: 'https://example.com/r.jpg'
      };
      const relatedSpy = vi.spyOn(searchAggregator, 'getRelatedTracks').mockResolvedValue([radioTrack]);

      await usePlayerStore.getState().playTrack(mockTracks[2], mockTracks, 2); // last track
      usePlayerStore.setState({ autoplayRadio: true, repeatMode: 'off' });

      await usePlayerStore.getState().nextTrack(true);

      const state = usePlayerStore.getState();
      expect(relatedSpy).toHaveBeenCalledWith(mockTracks[2], 10);
      expect(state.sourceQueue).toHaveLength(4);
      expect(state.currentTrack?.id).toBe('yt_radio_1');
      expect(state.currentIndex).toBe(3);
    });

    it('stops instead of looping when radio returns nothing usable', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const relatedSpy = vi.spyOn(searchAggregator, 'getRelatedTracks').mockResolvedValue([]);

      await usePlayerStore.getState().playTrack(mockTracks[2], mockTracks, 2);
      usePlayerStore.setState({ autoplayRadio: true, repeatMode: 'off' });

      await usePlayerStore.getState().nextTrack(true);

      expect(relatedSpy).toHaveBeenCalledTimes(1);
      const state = usePlayerStore.getState();
      expect(state.currentTrack?.id).toBe('yt_track_3');
      expect(state.playbackState).toBe('paused');
    });
  });

  describe('Wave & Track Radio Integration (Milestone 2)', () => {
    it('setQueueMode switches modes and synchronizes autoplayRadio', () => {
      usePlayerStore.getState().setQueueMode('track_radio');
      expect(usePlayerStore.getState().queueMode).toBe('track_radio');
      expect(usePlayerStore.getState().autoplayRadio).toBe(true);

      usePlayerStore.getState().setQueueMode('my_wave');
      expect(usePlayerStore.getState().queueMode).toBe('my_wave');
      expect(usePlayerStore.getState().autoplayRadio).toBe(true);

      usePlayerStore.getState().setQueueMode('sequential');
      expect(usePlayerStore.getState().queueMode).toBe('sequential');
      expect(usePlayerStore.getState().autoplayRadio).toBe(false);
    });

    it('startTrackRadio initializes queue with seed track and requests initial batch', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const radioTracks: UnifiedTrack[] = [
        {
          id: 'yt_radio_1',
          source: 'youtube',
          originalId: 'r1',
          title: 'Radio Track 1',
          artist: 'Artist One',
          duration: 180,
          artworkUrl: 'https://example.com/r1.jpg'
        }
      ];
      const recSpy = vi.spyOn(recommendationEngine, 'getTrackRadio').mockResolvedValue(radioTracks);

      await usePlayerStore.getState().startTrackRadio(mockTracks[0]);

      const state = usePlayerStore.getState();
      expect(state.queueMode).toBe('track_radio');
      expect(state.autoplayRadio).toBe(true);
      expect(state.currentTrack?.id).toBe('yt_track_1');
      expect(state.activeSeedTrack?.id).toBe('yt_track_1');
      expect(recSpy).toHaveBeenCalled();
    });

    it('startMyWave sets mood and genre, fetches recommendations, and starts playing first track', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const waveRecs: UnifiedTrack[] = [
        mockTracks[1],
        mockTracks[2]
      ];
      const waveSpy = vi.spyOn(recommendationEngine, 'getRecommendationsForWave').mockResolvedValue(waveRecs);

      await usePlayerStore.getState().startMyWave('energy', 'Rock');

      const state = usePlayerStore.getState();
      expect(state.queueMode).toBe('my_wave');
      expect(state.activeWaveMood).toBe('energy');
      expect(state.activeWaveGenre).toBe('Rock');
      expect(waveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          mood: 'energy',
          genre: 'Rock',
          // Регуляторы и посев волна докладывает сама, из своего состояния.
          novelty: expect.any(Number),
          energy: expect.any(Number),
          seedKind: 'library'
        }),
        10
      );
      expect(state.currentTrack?.id).toBe('sc_track_2');
      expect(state.sourceQueue).toHaveLength(2);
    });

    it('источник «от этой песни» отдаёт движку саму песню', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const waveSpy = vi
        .spyOn(recommendationEngine, 'getRecommendationsForWave')
        .mockResolvedValue([mockTracks[1]]);

      usePlayerStore.setState({ currentTrack: mockTracks[0], waveSeedKind: 'track' });
      await usePlayerStore.getState().startMyWave();

      // Без этого Поток не «отталкивался от конкретной песни»: семя обнулялось
      // всегда, и движок уходил в поиск по жанру.
      expect(waveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ seedKind: 'track', seedTrack: mockTracks[0] }),
        10
      );
      expect(usePlayerStore.getState().activeSeedTrack?.id).toBe(mockTracks[0].id);
    });

    it('«от этой песни» без песни ведёт себя как обычный Поток', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const waveSpy = vi
        .spyOn(recommendationEngine, 'getRecommendationsForWave')
        .mockResolvedValue([mockTracks[1]]);

      usePlayerStore.setState({ currentTrack: null, waveSeedKind: 'track' });
      await usePlayerStore.getState().startMyWave();

      expect(waveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ seedTrack: undefined }),
        10
      );
    });

    it('startWave alias correctly accepts config object or string mood', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const waveSpy = vi.spyOn(recommendationEngine, 'getRecommendationsForWave').mockResolvedValue([mockTracks[0]]);

      await usePlayerStore.getState().startWave({ mood: 'chill', genre: 'Ambient' });
      expect(usePlayerStore.getState().activeWaveMood).toBe('chill');
      expect(usePlayerStore.getState().activeWaveGenre).toBe('Ambient');

      await usePlayerStore.getState().startWave('focus');
      expect(usePlayerStore.getState().activeWaveMood).toBe('focus');
      expect(waveSpy).toHaveBeenCalled();
    });

    it('dislikeAndSkipCurrentTrack records dislike feedback, purges track, and advances', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const feedbackSpy = vi.spyOn(recommendationEngine, 'recordFeedback').mockResolvedValue();

      usePlayerStore.getState().setSourceQueue([mockTracks[0], mockTracks[1], mockTracks[2]], 0);
      await usePlayerStore.getState().playTrack(mockTracks[0]);

      await usePlayerStore.getState().dislikeAndSkipCurrentTrack();

      expect(feedbackSpy).toHaveBeenCalledWith(mockTracks[0], 'dislike');
      const state = usePlayerStore.getState();
      expect(state.currentTrack?.id).toBe('sc_track_2');
      expect(state.sourceQueue.some((t) => t.id === 'yt_track_1')).toBe(false);
    });

    it('replenishAutoplayQueue appends unique candidate tracks and respects exclusions', async () => {
      usePlayerStore.setState({
        queueMode: 'track_radio',
        activeSeedTrack: mockTracks[0],
        sourceQueue: [mockTracks[0]],
        currentIndex: 0,
        isReplenishingQueue: false
      });

      const newRecs: UnifiedTrack[] = [
        mockTracks[0], // Duplicate, should be ignored
        mockTracks[1],
        mockTracks[2]
      ];
      vi.spyOn(recommendationEngine, 'getTrackRadio').mockResolvedValue(newRecs);

      await usePlayerStore.getState().replenishAutoplayQueue();

      const state = usePlayerStore.getState();
      expect(state.sourceQueue).toHaveLength(3);
      expect(state.sourceQueue.map((t) => t.id)).toEqual(['yt_track_1', 'sc_track_2', 'yt_track_3']);
    });

    it('setWaveMood and setWaveGenre reconfigure wave and re-seed in my_wave mode', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const waveSpy = vi.spyOn(recommendationEngine, 'getRecommendationsForWave').mockResolvedValue([mockTracks[0]]);

      usePlayerStore.setState({ queueMode: 'my_wave', activeWaveMood: 'favorite', activeWaveGenre: null });

      await usePlayerStore.getState().setWaveMood('discovery');
      expect(usePlayerStore.getState().activeWaveMood).toBe('discovery');
      expect(waveSpy).toHaveBeenCalled();

      await usePlayerStore.getState().setWaveGenre('Jazz');
      expect(usePlayerStore.getState().activeWaveGenre).toBe('Jazz');
    });

    it('records feedback "complete" on track ended and "skip" on manual skip', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      const feedbackSpy = vi.spyOn(recommendationEngine, 'recordFeedback').mockResolvedValue();

      await usePlayerStore.getState().playTrack(mockTracks[0], mockTracks, 0);

      // Natural track ended
      await usePlayerStore.getState().onTrackEnded();
      expect(feedbackSpy).toHaveBeenCalledWith(mockTracks[0], 'complete');

      // Manual skip
      await usePlayerStore.getState().nextTrack(true);
      expect(feedbackSpy).toHaveBeenCalledWith(mockTracks[1], 'skip');
    });

    it('triggers lookahead replenishment when remaining tracks in queue <= 2', async () => {
      vi.spyOn(audioEngine, 'load').mockResolvedValue();
      vi.spyOn(recommendationEngine, 'getTrackRadio').mockResolvedValue([]);
      const replenishSpy = vi.spyOn(usePlayerStore.getState(), 'replenishAutoplayQueue');

      usePlayerStore.setState({
        queueMode: 'track_radio',
        sourceQueue: [mockTracks[0], mockTracks[1]],
        currentIndex: 0
      });

      // Playing track with 1 remaining track triggers replenish
      await usePlayerStore.getState().playTrack(mockTracks[0]);
      expect(replenishSpy).toHaveBeenCalled();
    });
  });
});
