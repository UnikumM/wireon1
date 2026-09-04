import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioEngine } from '../../src/services/audioEngine';
import { StreamResolver } from '../../src/services/streamResolver';
import { UnifiedTrack } from '../../src/types/music';

describe('AudioEngine Hardening & Auto-Recovery Adversarial Challenge', () => {
  let engine: AudioEngine;
  let mockResolver: StreamResolver;
  let mockAudio: any;
  let listeners: Record<string, Function[]>;

  const testTrack: UnifiedTrack = {
    id: 'yt_hardening_track_1',
    source: 'youtube',
    originalId: 'hard1',
    title: 'Hardening Stress Track',
    artist: 'Challenger',
    duration: 240,
    artworkUrl: 'https://example.com/art.jpg'
  };

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = {};
    mockResolver = new StreamResolver();

    vi.spyOn(mockResolver, 'resolve').mockImplementation(async (track: UnifiedTrack, forceRefresh?: boolean) => ({
      streamUrl: `https://cdn.example.com/stream_${track.id}_${forceRefresh ? 'refreshed' : 'init'}.mp4`,
      format: 'm4a',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000,
      cached: !forceRefresh
    }));

    mockAudio = {
      src: '',
      currentTime: 0,
      duration: 240,
      volume: 1,
      muted: false,
      crossOrigin: '',
      preload: '',
      readyState: 4,
      paused: false,
      ended: false,
      error: null,
      buffered: {
        length: 1,
        end: () => 120
      },
      seekable: {
        length: 1,
        start: () => 0,
        end: () => 240
      },
      addEventListener: vi.fn((event: string, cb: Function) => {
        listeners[event] = listeners[event] || [];
        if (!listeners[event].includes(cb)) {
          listeners[event].push(cb);
        }
      }),
      removeEventListener: vi.fn((event: string, cb: Function) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter(fn => fn !== cb);
        }
      }),
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockImplementation(() => {
        mockAudio.paused = true;
      }),
      load: vi.fn()
    };

    engine = new AudioEngine(mockResolver, mockAudio);
  });

  afterEach(() => {
    engine.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const emitAudioEvent = (eventName: string, eventObj: any = {}) => {
    const handlers = listeners[eventName] || [];
    for (const fn of handlers) {
      fn(eventObj);
    }
  };

  // =========================================================================
  // 1. Transparent Auto-Recovery on MediaError & Mid-Stream CDN Drops
  // =========================================================================
  describe('1. Transparent Auto-Recovery on MediaError & CDN Glitches', () => {
    it('seamlessly recovers from mid-track network error (code 2) and resumes at exact currentTime', async () => {
      await engine.load(testTrack, true);
      expect(mockAudio.src).toBe('https://cdn.example.com/stream_yt_hardening_track_1_init.mp4');

      // Playback advances to 75.4 seconds
      mockAudio.currentTime = 75.4;
      emitAudioEvent('timeupdate');

      // Simulate CDN socket drop emitting error code 2 (MEDIA_ERR_NETWORK)
      mockAudio.error = { code: 2, message: 'MEDIA_ERR_NETWORK: connection reset by peer' };
      const errorSpy = vi.fn();
      engine.onError(errorSpy);

      // Trigger error event
      emitAudioEvent('error');

      // State transitions to buffering while auto-recovering
      expect(engine.getState()).toBe('buffering');
      expect(errorSpy).not.toHaveBeenCalled(); // No fatal error surfaced to user yet

      // Advance timers through backoff delay (400ms + jitter)
      await vi.advanceTimersByTimeAsync(600);

      // Verify streamResolver was called with forceRefresh=true
      // Четвёртым аргументом уезжает адрес, на котором всё сломалось: разбор на
      // телефоне пропустит эту дорожку и отдаст другую.
      expect(mockResolver.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'yt_hardening_track_1' }),
        true,
        'user',
        expect.stringContaining('http')
      );

      // Verify new URL is loaded and seek position is preserved
      expect(mockAudio.src).toBe('https://cdn.example.com/stream_yt_hardening_track_1_refreshed.mp4');
      expect(mockAudio.currentTime).toBe(75.4);
      expect(mockAudio.play).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('ignores MEDIA_ERR_ABORTED (code 1) without triggering auto-recovery', async () => {
      const resolveSpy = vi.spyOn(mockResolver, 'resolve');
      await engine.load(testTrack, true);
      expect(resolveSpy).toHaveBeenCalledTimes(1);

      mockAudio.error = { code: 1, message: 'The fetching process was aborted by the user agent' };
      emitAudioEvent('error');

      await vi.advanceTimersByTimeAsync(1000);
      expect(resolveSpy).toHaveBeenCalledTimes(1); // Only initial load, no recovery resolve
    });

    it('surfaces fatal error after exhausting max retries (3 attempts)', async () => {
      vi.spyOn(mockResolver, 'resolve')
        .mockResolvedValueOnce({
          streamUrl: 'https://cdn.example.com/initial.mp4',
          format: 'm4a',
          bitrate: 128,
          expiresAt: Date.now() + 3600000,
          cached: false
        })
        .mockRejectedValue(new Error('Persistent 403 Forbidden on CDN mirror'));

      await engine.load(testTrack, true);
      const errorSpy = vi.fn();
      engine.onError(errorSpy);

      mockAudio.error = { code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
      emitAudioEvent('error');

      // Advance through retry 1, 2, 3
      await vi.advanceTimersByTimeAsync(8000);

      expect(errorSpy).toHaveBeenCalled();
      expect(engine.getState()).toBe('error');
    });

    it('resets retryCount to 0 after 10s of healthy uninterrupted playback', async () => {
      await engine.load(testTrack, true);
      mockAudio.currentTime = 10;
      emitAudioEvent('timeupdate');

      // First glitch at 10s -> recovers
      mockAudio.error = { code: 2, message: 'Socket drop 1' };
      emitAudioEvent('error');
      await vi.advanceTimersByTimeAsync(600);
      expect((engine as any).retryCount).toBe(1);

      // Playback resumes healthy: playing state for 10.5 seconds
      mockAudio.error = null;
      mockAudio.paused = false;
      emitAudioEvent('playing');
      await vi.advanceTimersByTimeAsync(10500);

      // retryCount should be reset to 0
      expect((engine as any).retryCount).toBe(0);

      // Second glitch at 90s -> can recover with fresh 3 attempts
      mockAudio.currentTime = 90;
      mockAudio.error = { code: 2, message: 'Socket drop 2' };
      emitAudioEvent('error');
      await vi.advanceTimersByTimeAsync(600);
      expect((engine as any).retryCount).toBe(1);
    });
  });

  // =========================================================================
  // 2. Stall Watchdog & Silent Buffer Freeze Detection
  // =========================================================================
  describe('2. Stall Watchdog & Silent Buffer Freeze Detection', () => {
    it('triggers auto-recovery when audio stalls for 3.5s without progress or native error event', async () => {
      await engine.load(testTrack, true);
      mockAudio.currentTime = 45;
      mockAudio.paused = false;
      emitAudioEvent('playing');

      // Audio engine enters waiting / stalled state
      emitAudioEvent('waiting');
      expect(engine.getState()).toBe('buffering');

      // Wait 3.5s stall timeout
      await vi.advanceTimersByTimeAsync(3600);

      // Полторы секунды на то, чтобы заминка прошла сама: поход за новой
      // ссылкой стоит на ПК четыре-восемь секунд, и платить их за каждую
      // случайную паузу в буфере — это и есть «поиграло, повисло, снова
      // грузится». Позиция здесь не двигается, значит поток правда встал.
      await vi.advanceTimersByTimeAsync(1600);

      // Watchdog triggers recovery backoff
      await vi.advanceTimersByTimeAsync(600);

      // Заминка — это про буфер, а не про адрес: отказываться от рабочей
      // ссылки здесь значило бы менять хорошее на неизвестное.
      expect(mockResolver.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'yt_hardening_track_1' }),
        true,
        'user',
        undefined
      );
      expect(mockAudio.currentTime).toBe(45);
    });

    it('cancels stall watchdog if playback makes progress before 3.5s threshold', async () => {
      await engine.load(testTrack, true);
      mockAudio.currentTime = 45;
      mockAudio.paused = false;
      emitAudioEvent('playing');

      // Stall begins
      emitAudioEvent('stalled');

      // 2 seconds later, buffer arrives and time advances
      await vi.advanceTimersByTimeAsync(2000);
      mockAudio.currentTime = 46;
      emitAudioEvent('timeupdate');

      // Another 2 seconds pass
      await vi.advanceTimersByTimeAsync(2000);

      // Watchdog should NOT have triggered recovery because time advanced
      expect(mockResolver.resolve).toHaveBeenCalledTimes(1); // Only initial load
    });

    it('does not fire stall watchdog when user manually pauses audio', async () => {
      await engine.load(testTrack, true);
      mockAudio.currentTime = 30;
      engine.pause();

      emitAudioEvent('waiting');
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockResolver.resolve).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 3. Concurrency & Race Conditions during Recovery / Seeking
  // =========================================================================
  describe('3. Concurrency, Race Conditions & Rapid Seeking', () => {
    it('discards in-flight auto-recovery without corrupting track B or emitting false error', async () => {
      await engine.load(testTrack, true);
      mockAudio.currentTime = 50;

      // Track A fails and starts auto-recovery backoff
      mockAudio.error = { code: 2, message: 'Glitch on track 1' };
      emitAudioEvent('error');
      expect(engine.getState()).toBe('buffering');

      // User immediately switches to track B while track A backoff is waiting
      const trackB: UnifiedTrack = {
        id: 'yt_hardening_track_2',
        source: 'youtube',
        originalId: 'hard2',
        title: 'Track B',
        artist: 'Challenger',
        duration: 180,
        artworkUrl: ''
      };
      await engine.load(trackB, true);
      expect(engine.getCurrentTrack()?.id).toBe('yt_hardening_track_2');
      expect(engine.getState()).toBe('playing');

      const errorListener = vi.fn();
      engine.onError(errorListener);

      // Advance timers past track A's old backoff delay
      await vi.advanceTimersByTimeAsync(3000);

      // Track B must remain playing and must NOT receive track A's failure error
      expect(engine.getState()).toBe('playing');
      expect(errorListener).not.toHaveBeenCalled();
      expect(engine.getCurrentTrack()?.id).toBe('yt_hardening_track_2');
    });

    it('safely destroys engine while auto-recovery backoff timer is active without throwing or leaking', async () => {
      await engine.load(testTrack, true);
      mockAudio.currentTime = 80;

      mockAudio.error = { code: 2, message: 'Glitch' };
      emitAudioEvent('error');

      // Destroy while recovering
      expect(() => engine.destroy()).not.toThrow();

      // Advancing timers should not crash or execute callbacks
      await vi.advanceTimersByTimeAsync(5000);
      expect(engine.getAudioContext()).toBeNull();
      expect(engine.getAnalyser()).toBeNull();
    });

    it('handles 50 rapid seeks during buffering without corrupted pendingSeek', async () => {
      mockAudio.duration = 240;
      await engine.load(testTrack, false);

      for (let i = 1; i <= 50; i++) {
        engine.seek(i * 4);
      }

      // The last seek was 200
      expect(mockAudio.currentTime).toBe(200);
    });

    it('handles seek to non-finite, negative, and oversized values robustly', async () => {
      await engine.load(testTrack, false);

      engine.seek(-100);
      expect(mockAudio.currentTime).toBe(0);

      engine.seek(500);
      expect(mockAudio.currentTime).toBe(240);

      engine.seek(NaN);
      expect(mockAudio.currentTime).toBe(240); // Unchanged

      engine.seek(Infinity);
      expect(mockAudio.currentTime).toBe(240);
    });
  });

  // =========================================================================
  // 4. Volume Fading and Audio Graph Resilience
  // =========================================================================
  describe('4. Volume Fading and Perceptual Volume Curve', () => {
    it('smoothly fades volume to target level over specified duration', async () => {
      engine.setVolume(1.0);
      const fadePromise = engine.fadeVolumeTo(0.2, 500);

      // Advance 5 steps of 100ms
      await vi.advanceTimersByTimeAsync(600);
      await fadePromise;

      // Effective volume multiplier is reduced, while user volume setting is preserved
      expect(engine.getVolume()).toBe(1.0);
      expect((engine as any).fadeMultiplier).toBeCloseTo(0.2, 2);
    });

    it('cancels volume fade immediately when user calls setVolume()', async () => {
      engine.setVolume(1.0);
      void engine.fadeVolumeTo(0.1, 1000);

      await vi.advanceTimersByTimeAsync(200);
      engine.setVolume(0.5); // User changes volume mid-fade

      expect((engine as any).fadeMultiplier).toBe(1.0);
      expect(engine.getVolume()).toBe(0.5);
    });
  });
});
