import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup';
import { AudioEngine } from '../../src/services/audioEngine';
import { StreamResolver } from '../../src/services/streamResolver';
import { UnifiedTrack } from '../../src/types/music';
import { usePlayerStore, PLAYER_SETTING_KEYS } from '../../src/store/usePlayerStore';
import { PlaybackSettings } from '../../src/components/settings/PlaybackSettings';
import * as dbService from '../../src/services/db';
import { resetPlayerStore } from '../helpers/testUtils';

// Mock HLS adapter
vi.mock('../../src/services/hls', () => ({
  isHlsUrl: (url?: string) => (url ? /\.m3u8(\?|#|$)/i.test(url) : false),
  isNativeHlsSupported: () => false,
  isHlsJsSupported: async () => true,
  isHlsSupported: async () => true,
  attachHls: vi.fn()
}));

describe('M1: DJ Crossfade, Loudness Normalization & Settings Core', () => {
  let engine: AudioEngine;
  let mockResolver: StreamResolver;
  let mockAudioA: any;
  let mockAudioB: any;

  const track1: UnifiedTrack = {
    id: 'yt_crossfade_1',
    source: 'youtube',
    originalId: 'crossfade_1',
    title: 'Midnight City',
    artist: 'M83',
    duration: 244,
    artworkUrl: 'https://example.com/art1.jpg'
  };

  const track2: UnifiedTrack = {
    id: 'sc_crossfade_2',
    source: 'soundcloud',
    originalId: 'crossfade_2',
    title: 'Strobe',
    artist: 'deadmau5',
    duration: 637,
    artworkUrl: 'https://example.com/art2.jpg'
  };

  const createMockAudioElement = () => {
    const listeners: Record<string, Function[]> = {};
    return {
      src: '',
      currentTime: 0,
      duration: 300,
      volume: 1,
      muted: false,
      paused: true,
      ended: false,
      buffered: {
        length: 1,
        end: () => 100
      },
      addEventListener: vi.fn((event, cb) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      }),
      removeEventListener: vi.fn((event, cb) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((fn) => fn !== cb);
        }
      }),
      play: vi.fn().mockImplementation(function (this: any) {
        this.paused = false;
        return Promise.resolve();
      }),
      pause: vi.fn().mockImplementation(function (this: any) {
        this.paused = true;
      }),
      load: vi.fn()
    };
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetPlayerStore();
    await dbService.clearAllData();

    mockResolver = new StreamResolver();
    vi.spyOn(mockResolver, 'resolve').mockImplementation(async (track: UnifiedTrack) => ({
      streamUrl: `https://audio.wireon.io/stream_${track.id}.mp3`,
      format: 'mp3',
      bitrate: 320,
      expiresAt: Date.now() + 3600 * 1000,
      cached: false
    }));

    mockAudioA = createMockAudioElement();
    mockAudioB = createMockAudioElement();

    engine = new AudioEngine(mockResolver, mockAudioA, mockAudioB);
  });

  afterEach(async () => {
    engine.destroy();
    await dbService.clearAllData();
    vi.restoreAllMocks();
  });

  describe('1. Dual-Deck Architecture & Gain Routing', () => {
    it('initializes dual audio elements and connects independent Web Audio GainNodes', () => {
      expect(engine.getActiveDeck()).toBe('A');
      expect(engine.getActiveAudio()).toBe(mockAudioA);
      expect(engine.getSecondaryAudio()).toBe(mockAudioB);

      // Force Web Audio graph initialization
      (engine as any).initAudioGraph();

      const ctx = engine.getAudioContext();
      expect(ctx).not.toBeNull();

      const gainA = engine.getDeckAGainNode();
      const gainB = engine.getDeckBGainNode();
      const masterGain = engine.getMasterGainNode();

      expect(gainA).not.toBeNull();
      expect(gainB).not.toBeNull();
      expect(masterGain).not.toBeNull();

      // Deck A starts active with gain 1.0, Deck B starts silent with gain 0.0
      expect(gainA?.gain.value).toBe(1.0);
      expect(gainB?.gain.value).toBe(0.0);
    });

    it('sets and gets crossfade parameters with bounds clamping (0s–12s)', () => {
      expect(engine.isCrossfadeEnabled()).toBe(false);
      expect(engine.getCrossfadeDuration()).toBe(3);

      engine.setCrossfade(true, 6);
      expect(engine.isCrossfadeEnabled()).toBe(true);
      expect(engine.getCrossfadeDuration()).toBe(6);

      // Clamps to [0, 12]
      engine.setCrossfade(true, 18);
      expect(engine.getCrossfadeDuration()).toBe(12);

      engine.setCrossfade(false, -5);
      expect(engine.isCrossfadeEnabled()).toBe(false);
      expect(engine.getCrossfadeDuration()).toBe(0);
    });
  });

  describe('2. DJ Crossfade Execution & Deck Transitions', () => {
    it('switches instantly without crossfade when crossfade is disabled', async () => {
      engine.setCrossfade(false, 0);

      await engine.load(track1, true);
      expect(mockAudioA.src).toBe(`https://audio.wireon.io/stream_${track1.id}.mp3`);
      expect(mockAudioA.play).toHaveBeenCalled();
      expect(engine.getActiveDeck()).toBe('A');

      await engine.load(track2, true);
      // Immediately loads on Deck A or switches without crossfade overlap
      expect(engine.getCurrentTrack()?.id).toBe(track2.id);
    });

    it('performs smooth dual-deck crossfade with linearRampToValueAtTime when enabled', async () => {
      engine.setCrossfade(true, 4);

      // Load and play Track 1 on Deck A
      await engine.load(track1, true);
      expect(engine.getActiveDeck()).toBe('A');
      expect(mockAudioA.play).toHaveBeenCalled();

      // Initiate Crossfade to Track 2
      const gainA = engine.getDeckAGainNode();
      const gainB = engine.getDeckBGainNode();
      const cancelSpyA = vi.spyOn(gainA!.gain, 'cancelScheduledValues');
      const rampSpyA = vi.spyOn(gainA!.gain, 'linearRampToValueAtTime');
      const cancelSpyB = vi.spyOn(gainB!.gain, 'cancelScheduledValues');
      const rampSpyB = vi.spyOn(gainB!.gain, 'linearRampToValueAtTime');

      await engine.load(track2, true);

      // Verify Deck B starts playing Track 2
      expect(mockAudioB.src).toBe(`https://audio.wireon.io/stream_${track2.id}.mp3`);
      expect(mockAudioB.play).toHaveBeenCalled();
      expect(engine.getActiveDeck()).toBe('B');
      expect(engine.getCurrentTrack()?.id).toBe(track2.id);

      // Verify gain ramp commands on both Deck A (outgoing: 1 -> 0) and Deck B (incoming: 0 -> 1)
      expect(cancelSpyA).toHaveBeenCalled();
      expect(rampSpyA).toHaveBeenCalledWith(0.0001, expect.any(Number));
      expect(cancelSpyB).toHaveBeenCalled();
      expect(rampSpyB).toHaveBeenCalledWith(1.0, expect.any(Number));
    });

    it('cleans up outgoing deck and resets gains after crossfade duration expires', async () => {
      vi.useFakeTimers();
      try {
        engine.setCrossfade(true, 3);

        await engine.load(track1, true);
        await engine.load(track2, true);

        expect(mockAudioA.pause).not.toHaveBeenCalled();

        // Advance past crossfade timer (3s)
        await vi.advanceTimersByTimeAsync(3100);

        // Outgoing Deck A is now paused and reset
        expect(mockAudioA.pause).toHaveBeenCalled();
        expect(mockAudioA.src).toBe('');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('3. Loudness Normalization with DynamicsCompressorNode', () => {
    it('creates DynamicsCompressorNode with precise specifications (-24dB, knee 30dB, ratio 4:1, attack 0.003s, release 0.25s)', () => {
      (engine as any).initAudioGraph();
      const compressor = engine.getCompressorNode();

      expect(compressor).not.toBeNull();
      expect(compressor?.threshold.value).toBe(-24);
      expect(compressor?.knee.value).toBe(30);
      expect(compressor?.ratio.value).toBe(4);
      expect(compressor?.attack.value).toBe(0.003);
      expect(compressor?.release.value).toBe(0.25);
    });

    it('toggles loudness normalization into and out of the master audio graph', () => {
      (engine as any).initAudioGraph();
      const compressor = engine.getCompressorNode();
      expect(compressor).not.toBeNull();

      expect(engine.isLoudnessNormalizationEnabled()).toBe(false);

      // Enable loudness normalization
      engine.setLoudnessNormalization(true);
      expect(engine.isLoudnessNormalizationEnabled()).toBe(true);

      // Disable loudness normalization
      engine.setLoudnessNormalization(false);
      expect(engine.isLoudnessNormalizationEnabled()).toBe(false);
    });
  });

  describe('4. Store Integration & Persistence', () => {
    it('updates crossfade and loudness normalization state via store actions and persists to database', async () => {
      const store = usePlayerStore.getState();

      store.setCrossfadeEnabled(true);
      store.setCrossfadeDuration(7);
      store.setLoudnessNormalization(true);

      const updated = usePlayerStore.getState();
      expect(updated.crossfadeEnabled).toBe(true);
      expect(updated.crossfadeDuration).toBe(7);
      expect(updated.loudnessNormalization).toBe(true);

      await waitFor(async () => {
        const persistedEnabled = await dbService.getSetting(PLAYER_SETTING_KEYS.crossfadeEnabled, null);
        const persistedDuration = await dbService.getSetting(PLAYER_SETTING_KEYS.crossfadeDuration, null);
        const persistedLoudness = await dbService.getSetting(PLAYER_SETTING_KEYS.loudnessNormalization, null);
        expect(persistedEnabled).toBe(true);
        expect(persistedDuration).toBe(7);
        expect(persistedLoudness).toBe(true);
      });
    });

    it('hydrates crossfade and loudness normalization settings from database on startup', async () => {
      await dbService.setSetting(PLAYER_SETTING_KEYS.crossfadeEnabled, true);
      await dbService.setSetting(PLAYER_SETTING_KEYS.crossfadeDuration, 5);
      await dbService.setSetting(PLAYER_SETTING_KEYS.loudnessNormalization, true);

      resetPlayerStore();
      expect(usePlayerStore.getState().crossfadeEnabled).toBe(false);

      await usePlayerStore.getState().hydrateSettings();

      const hydrated = usePlayerStore.getState();
      expect(hydrated.crossfadeEnabled).toBe(true);
      expect(hydrated.crossfadeDuration).toBe(5);
      expect(hydrated.loudnessNormalization).toBe(true);
    });

    it('triggers early crossfade progression during syncProgress when approaching track end', async () => {
      usePlayerStore.setState({
        currentTrack: track1,
        sourceQueue: [track1, track2],
        currentIndex: 0,
        isPlaying: true,
        isLoading: false,
        duration: 200,
        currentTime: 100,
        crossfadeEnabled: true,
        crossfadeDuration: 5
      });

      const nextTrackSpy = vi.spyOn(usePlayerStore.getState(), 'nextTrack').mockResolvedValue();

      // Current time is 196s out of 200s (4s remaining <= 5s crossfadeDuration)
      usePlayerStore.getState().syncProgress(196, 200, 200);

      expect(nextTrackSpy).toHaveBeenCalledWith(false);
    });
  });

  describe('5. PlaybackSettings UI Controls', () => {
    it('renders Crossfade and Loudness Normalization controls with accessible labels', () => {
      render(<PlaybackSettings />);

      const crossfadeToggle = screen.getByTestId('setting-crossfade-enabled');
      const crossfadeSlider = screen.getByTestId('setting-crossfade-duration');
      const loudnessToggle = screen.getByTestId('setting-loudness-normalization');

      expect(crossfadeToggle).toBeInTheDocument();
      expect(crossfadeSlider).toBeInTheDocument();
      expect(loudnessToggle).toBeInTheDocument();

      expect(screen.getByText('Плавный переход между треками')).toBeInTheDocument();
      expect(screen.getByText('Длительность перехода')).toBeInTheDocument();
      expect(screen.getByText('Выравнивание громкости')).toBeInTheDocument();
    });

    it('enables/disables crossfade duration slider based on crossfade toggle state', async () => {
      render(<PlaybackSettings />);

      const crossfadeToggle = screen.getByTestId('setting-crossfade-enabled');
      const crossfadeSlider = screen.getByTestId('setting-crossfade-duration');

      expect(crossfadeToggle).not.toBeChecked();
      expect(crossfadeSlider).toBeDisabled();

      // Enable crossfade
      fireEvent.click(crossfadeToggle);

      expect(crossfadeToggle).toBeChecked();
      expect(crossfadeSlider).toBeEnabled();
      expect(usePlayerStore.getState().crossfadeEnabled).toBe(true);

      // Adjust crossfade duration slider
      fireEvent.change(crossfadeSlider, { target: { value: '8' } });

      expect(usePlayerStore.getState().crossfadeDuration).toBe(8);
      expect(screen.getByTestId('setting-crossfade-duration-value')).toHaveTextContent('8 с');
    });

    it('toggles loudness normalization and updates player store', async () => {
      render(<PlaybackSettings />);

      const loudnessToggle = screen.getByTestId('setting-loudness-normalization');
      expect(loudnessToggle).not.toBeChecked();

      fireEvent.click(loudnessToggle);

      expect(loudnessToggle).toBeChecked();
      expect(usePlayerStore.getState().loudnessNormalization).toBe(true);

      await waitFor(async () => {
        expect(await dbService.getSetting(PLAYER_SETTING_KEYS.loudnessNormalization, null)).toBe(true);
      });
    });
  });
});
