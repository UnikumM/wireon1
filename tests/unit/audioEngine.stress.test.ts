import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioEngine } from '../../src/services/audioEngine';
import { StreamResolver } from '../../src/services/streamResolver';
import { UnifiedTrack } from '../../src/types/music';

describe('AudioEngine Adversarial Stress Testing', () => {
  let engine: AudioEngine;
  let mockResolver: StreamResolver;
  let mockAudio: any;
  let listeners: Record<string, Function[]>;

  const sampleTrack: UnifiedTrack = {
    id: 'yt_stress_1',
    source: 'youtube',
    originalId: 'stress1',
    title: 'Stress Test Track',
    artist: 'Challenger',
    duration: 300,
    artworkUrl: 'https://example.com/art.jpg'
  };

  beforeEach(() => {
    listeners = {};
    mockResolver = new StreamResolver();
    vi.spyOn(mockResolver, 'resolve').mockImplementation(async (track: UnifiedTrack) => ({
      streamUrl: `https://cdn.example.com/stream_${track.id}.mp4`,
      format: 'm4a',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000,
      cached: false
    }));

    mockAudio = {
      src: '',
      currentTime: 0,
      duration: 300,
      volume: 1,
      muted: false,
      crossOrigin: '',
      preload: '',
      buffered: {
        length: 1,
        end: (idx: number) => (idx === 0 ? 150 : 0)
      },
      addEventListener: vi.fn((event: string, cb: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      }),
      removeEventListener: vi.fn((event: string, cb: Function) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter(fn => fn !== cb);
        }
      }),
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      load: vi.fn()
    };

    engine = new AudioEngine(mockResolver, mockAudio);
  });

  afterEach(() => {
    engine.destroy();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Rapid Play / Pause Interleaving (100 rapid calls)
  // =========================================================================
  describe('1. Rapid Play/Pause Interleaving', () => {
    it('handles 100 alternating synchronous play() and pause() calls without crashing or corrupted state', async () => {
      await engine.load(sampleTrack, false);

      const stateHistory: string[] = [];
      engine.onStateChange(state => stateHistory.push(state));

      const playPromises: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        if (i % 2 === 0) {
          playPromises.push(engine.play());
        } else {
          engine.pause();
        }
      }

      await Promise.all(playPromises);

      // The last call in loop (i=99) is pause()
      expect(mockAudio.pause).toHaveBeenCalledTimes(50);
      expect(mockAudio.play).toHaveBeenCalledTimes(50);
      expect(engine.getState()).toBe('paused');
      expect(['paused', 'playing']).toContain(engine.getState());
    });

    it('handles simulated browser AbortError on rapid pause during pending play()', async () => {
      await engine.load(sampleTrack, false);

      let playReject: (err: any) => void;
      mockAudio.play = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          playReject = reject;
        });
      });

      const errors: Error[] = [];
      engine.onError((err) => errors.push(err));

      const playPromise = engine.play();
      engine.pause();

      // Simulate browser aborting the play promise when paused
      const abortError = new Error('The play() request was interrupted by a call to pause().');
      abortError.name = 'AbortError';
      playReject!(abortError);

      // Losing the race to pause() is not a failure: the listener asked for
      // silence and got it, so nothing is reported and the state stays honest.
      await expect(playPromise).resolves.toBeUndefined();
      expect(engine.getState()).toBe('paused');
      expect(errors).toEqual([]);
    });

    it('swallows the AbortError raised when a new load interrupts a pending play()', async () => {
      await engine.load(sampleTrack, false);

      let playReject: (err: any) => void;
      mockAudio.play = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          playReject = reject;
        });
      });

      const errors: Error[] = [];
      engine.onError((err) => errors.push(err));

      const playPromise = engine.play();

      // A newer track starts loading, which is what makes the browser abort the
      // pending play() — the exact case the friend's SoundCloud toast came from.
      const nextLoad = engine.load({ ...sampleTrack, id: 'yt_next' }, false);

      const abortError = new Error('The play() request was interrupted by a new load request.');
      abortError.name = 'AbortError';
      playReject!(abortError);

      await expect(playPromise).resolves.toBeUndefined();
      await nextLoad;
      expect(errors).toEqual([]);
      expect(engine.getState()).not.toBe('error');
    });

    it('still reports a genuine play() rejection', async () => {
      await engine.load(sampleTrack, false);

      mockAudio.play = vi.fn().mockRejectedValue(
        Object.assign(new Error('play() failed because the user agent does not support the source'), {
          name: 'NotSupportedError'
        })
      );

      const errors: Error[] = [];
      engine.onError((err) => errors.push(err));

      await expect(engine.play()).rejects.toThrow(/Audio playback failed/);
      expect(engine.getState()).toBe('error');
      expect(errors).toHaveLength(1);
    });

    it('survives 100 rapid load() and play() requests in random succession', async () => {
      const loadPromises: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        const trk = { ...sampleTrack, id: `yt_trk_${i}` };
        loadPromises.push(
          engine.load(trk, i % 3 === 0).catch(() => {
            // Check if any unexpected crash occurs
            return;
          })
        );
        if (i % 5 === 0) {
          engine.pause();
        }
      }

      await Promise.all(loadPromises);
      expect(engine.getCurrentTrack()).not.toBeNull();
    });
  });

  // =========================================================================
  // 2. Extreme Seek Values (Negative, > Duration, NaN, Infinity, -Infinity)
  // =========================================================================
  describe('2. Extreme Seek Values', () => {
    it('clamps negative seek values to 0', async () => {
      await engine.load(sampleTrack, false);

      engine.seek(-1);
      expect(mockAudio.currentTime).toBe(0);

      engine.seek(-999999);
      expect(mockAudio.currentTime).toBe(0);

      engine.seek(-Infinity);
      expect(mockAudio.currentTime).toBe(0);
    });

    it('clamps seek values exceeding duration to track duration', async () => {
      await engine.load(sampleTrack, false);
      // Track duration is 300
      engine.seek(301);
      expect(mockAudio.currentTime).toBe(300);

      engine.seek(999999);
      expect(mockAudio.currentTime).toBe(300);

      engine.seek(Infinity);
      expect(mockAudio.currentTime).toBe(300);
    });

    it('handles seek with exact boundary values (0 and duration)', async () => {
      await engine.load(sampleTrack, false);

      engine.seek(0);
      expect(mockAudio.currentTime).toBe(0);

      engine.seek(300);
      expect(mockAudio.currentTime).toBe(300);
    });

    it('does not propagate NaN to audio currentTime on seek(NaN)', async () => {
      await engine.load(sampleTrack, false);
      mockAudio.currentTime = 50;
      engine.seek(NaN);
      // currentTime should either stay unchanged or fallback to a valid finite number, not NaN
      expect(Number.isFinite(mockAudio.currentTime)).toBe(true);
    });

    it('does not propagate Infinity to audio currentTime when duration is 0', () => {
      mockAudio.duration = 0;
      const unkTrack = { ...sampleTrack, duration: 0 };
      engine.load(unkTrack, false);

      engine.seek(Infinity);
      expect(Number.isFinite(mockAudio.currentTime)).toBe(true);
    });

    it('does not propagate NaN to volume on setVolume(NaN)', () => {
      engine.setVolume(0.5);
      expect(engine.getVolume()).toBe(0.5);

      engine.setVolume(NaN);
      // Volume should remain valid finite number between 0 and 1, not NaN
      expect(Number.isFinite(engine.getVolume())).toBe(true);
    });

    it('mute overrides volume to 0 without losing the stored volume level', () => {
      engine.setVolume(0.75);
      expect(engine.getVolume()).toBe(0.75);

      engine.setMuted(true);
      expect(engine.isMuted()).toBe(true);
      expect(engine.getVolume()).toBe(0.75); // Stored volume retained

      // Check effective gain is 0
      const gainNode = (engine as any).gainNode;
      if (gainNode) {
        expect(gainNode.gain.value).toBe(0);
      }

      engine.setMuted(false);
      expect(engine.isMuted()).toBe(false);
      expect(engine.getVolume()).toBe(0.75);
      if (gainNode) {
        expect(gainNode.gain.value).toBeCloseTo(0.75 * 0.75, 4);
      }
    });

    it('rapid volume adjustments (1000 consecutive changes) perform smoothly', () => {
      for (let i = 0; i <= 1000; i++) {
        const v = i / 1000;
        engine.setVolume(v);
      }
      expect(engine.getVolume()).toBe(1.0);
    });
  });

  // =========================================================================
  // 4. AudioContext Suspension/Resume & Event Listener Cleanup
  // =========================================================================
  describe('4. AudioContext Suspension / Resume & Lifecycle', () => {
    it('resumes suspended AudioContext when play() is invoked', async () => {
      await engine.load(sampleTrack, false);
      const ctx = engine.getAudioContext();
      if (ctx) {
        (ctx as any).state = 'suspended';
        const resumeSpy = vi.spyOn(ctx, 'resume');

        await engine.play();

        expect(resumeSpy).toHaveBeenCalled();
        expect(ctx.state).toBe('running');
      }
    });

    it('cleans up all native audio event listeners and closes AudioContext on destroy()', async () => {
      await engine.load(sampleTrack, false);

      const ctx = engine.getAudioContext();
      expect(ctx).not.toBeNull();

      expect(mockAudio.addEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function));
      expect(mockAudio.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
      expect(mockAudio.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));

      engine.destroy();

      expect(mockAudio.removeEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function));
      expect(mockAudio.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
      expect(mockAudio.removeEventListener).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockAudio.src).toBe('');

      if (ctx) {
        expect(ctx.state).toBe('closed');
      }
    });

    it('clears all internal listener sets on destroy() to prevent memory leaks', () => {
      const timeCb = vi.fn();
      const endCb = vi.fn();
      const errCb = vi.fn();
      const stateCb = vi.fn();

      engine.onTimeUpdate(timeCb);
      engine.onEnded(endCb);
      engine.onError(errCb);
      engine.onStateChange(stateCb);

      engine.destroy();

      // Trigger events on audio element after destroy
      if (listeners['timeupdate']) {
        listeners['timeupdate'].forEach(fn => fn());
      }
      if (listeners['ended']) {
        listeners['ended'].forEach(fn => fn());
      }

      expect(timeCb).not.toHaveBeenCalled();
      expect(endCb).not.toHaveBeenCalled();
    });

    it('individual unsubscribe callbacks successfully remove listeners without affecting others', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const unsub1 = engine.onTimeUpdate(cb1);
      const unsub2 = engine.onTimeUpdate(cb2);

      engine.seek(10);
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);

      unsub1();
      engine.seek(20);
      expect(cb1).toHaveBeenCalledTimes(1); // Unsubscribed, not called again
      expect(cb2).toHaveBeenCalledTimes(2); // Still active

      unsub2();
      engine.seek(30);
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(2); // Unsubscribed
    });

    it('survives throwing listeners without stopping other listeners or crashing engine', () => {
      const badListener = vi.fn(() => {
        throw new Error('Exploding listener');
      });
      const goodListener = vi.fn();

      engine.onTimeUpdate(badListener);
      engine.onTimeUpdate(goodListener);

      expect(() => engine.seek(40)).not.toThrow();
      expect(badListener).toHaveBeenCalled();
      expect(goodListener).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Concurrency, Spectrum Data & Edge Cases
  // =========================================================================
  describe('5. Concurrency & Frequency Visualizer Spectrum', () => {
    it('returns empty spectrum Uint8Array safely before audio graph or without AnalyserNode', () => {
      const freshEngine = new AudioEngine(mockResolver, mockAudio);
      const freq = freshEngine.getFrequencyData();
      expect(freq).toBeInstanceOf(Uint8Array);
      expect(freq.length).toBe(128);
      freshEngine.destroy();
    });

    it('returns AnalyserNode frequency data accurately when initialized', async () => {
      await engine.load(sampleTrack, false);
      const freq = engine.getFrequencyData();
      expect(freq).toBeInstanceOf(Uint8Array);
      expect(freq.length).toBe(128);
      // AnalyserNode populates array
      const hasNonZero = Array.from(freq).some(v => v > 0);
      expect(hasNonZero).toBe(true);
    });

    it('handles load() error gracefully when stream resolver fails', async () => {
      const freshTrack = { ...sampleTrack, streamUrl: undefined, streamExpiry: undefined };
      vi.spyOn(mockResolver, 'resolve').mockRejectedValueOnce(new Error('Network CDN Timeout'));

      const errorListener = vi.fn();
      engine.onError(errorListener);

      await expect(engine.load(freshTrack, true)).rejects.toThrow('Network CDN Timeout');
      expect(engine.getState()).toBe('error');
      expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
    });

    it('handles frozen track objects without mutation TypeError', async () => {
      const frozenTrack: UnifiedTrack = Object.freeze({
        id: 'yt_frozen_1',
        source: 'youtube' as const,
        originalId: 'frozen1',
        title: 'Frozen Track',
        artist: 'Challenger',
        duration: 200,
        artworkUrl: 'https://example.com/art.jpg'
      });

      // Loading a frozen object should NOT throw TypeError on property assignment
      await expect(engine.load(frozenTrack, false)).resolves.not.toThrow();
    });

    it('handles reuse after destroy() without using closed AudioContext', async () => {
      await engine.load(sampleTrack, false);
      const ctx1 = engine.getAudioContext();
      expect(ctx1?.state).toBe('running');

      engine.destroy();
      expect(ctx1?.state).toBe('closed');

      // Re-loading track after destroy
      const freshTrack = { ...sampleTrack, id: 'yt_after_destroy' };
      await engine.load(freshTrack, false);

      const ctx2 = engine.getAudioContext();
      expect(ctx2?.state).toBe('running');
      expect(ctx2).not.toBe(ctx1);
    });

    it('calculates getBuffered() safely with empty or multi-range TimeRanges', () => {
      // Empty buffered
      mockAudio.buffered = { length: 0 };
      expect(engine.getBuffered()).toBe(0);

      // Null buffered
      mockAudio.buffered = null;
      expect(engine.getBuffered()).toBe(0);

      // Multi-range buffered
      mockAudio.buffered = {
        length: 3,
        end: (i: number) => [10, 50, 180][i]
      };
      expect(engine.getBuffered()).toBe(180);
    });

    it('calculates getDuration() fallback from track when HTMLAudioElement duration is NaN or unready', () => {
      mockAudio.duration = NaN;
      expect(engine.getDuration()).toBe(0);

      (engine as any).currentTrack = sampleTrack;
      expect(engine.getDuration()).toBe(300);

      mockAudio.duration = 240;
      expect(engine.getDuration()).toBe(240);
    });
  });

  // =========================================================================
  // 6. C3 Regression: chunked streams reporting Infinity duration
  // =========================================================================
  describe('6. Chunked Stream Duration & Deferred Seek', () => {
    const chunkedTrack: UnifiedTrack = { ...sampleTrack, id: 'yt_chunked_1', duration: 0 };

    const fireMetadata = () => {
      (listeners['loadedmetadata'] || []).forEach(fn => fn());
    };

    it('reports duration 0 while the element reports Infinity', async () => {
      mockAudio.duration = Infinity;
      await engine.load(chunkedTrack, false);

      expect(engine.getDuration()).toBe(0);
      expect(Number.isFinite(engine.getDuration())).toBe(true);
    });

    it('remembers a seek made before metadata and lands on the requested position', async () => {
      mockAudio.duration = Infinity;
      mockAudio.seekable = { length: 0, start: () => 0, end: () => 0 };
      await engine.load(chunkedTrack, false);

      mockAudio.currentTime = 0;
      engine.seek(184);

      // Nothing to clamp against yet: the request must not collapse to 0:00
      expect(mockAudio.currentTime).toBe(0);

      // Metadata lands with the real duration
      mockAudio.duration = 600;
      mockAudio.seekable = { length: 1, start: () => 0, end: () => 600 };
      fireMetadata();

      expect(mockAudio.currentTime).toBe(184);
      expect(engine.getDuration()).toBe(600);
    });

    it('seeks immediately when the target is already inside the seekable range', async () => {
      mockAudio.duration = Infinity;
      mockAudio.seekable = { length: 1, start: () => 0, end: () => 120 };
      await engine.load(chunkedTrack, false);

      engine.seek(60);
      expect(mockAudio.currentTime).toBe(60);
    });

    it('prefers fastSeek() when the element provides it', async () => {
      mockAudio.duration = Infinity;
      mockAudio.seekable = { length: 1, start: () => 0, end: () => 300 };
      mockAudio.fastSeek = vi.fn((t: number) => {
        mockAudio.currentTime = t;
      });
      await engine.load(chunkedTrack, false);

      engine.seek(95);
      expect(mockAudio.fastSeek).toHaveBeenCalledWith(95);
      expect(mockAudio.currentTime).toBe(95);
    });

    it('emits a finite duration to time-update listeners for chunked streams', async () => {
      mockAudio.duration = Infinity;
      await engine.load(chunkedTrack, false);

      const reported: Array<{ time: number; duration: number }> = [];
      engine.onTimeUpdate((time, duration) => reported.push({ time, duration }));

      engine.seek(0);

      expect(reported.length).toBeGreaterThan(0);
      reported.forEach(entry => {
        expect(Number.isFinite(entry.duration)).toBe(true);
        expect(Number.isFinite(entry.time)).toBe(true);
      });
    });

    it('drops a pending seek when a different track is loaded', async () => {
      mockAudio.duration = Infinity;
      mockAudio.seekable = { length: 0, start: () => 0, end: () => 0 };
      await engine.load(chunkedTrack, false);

      engine.seek(184);
      await engine.load({ ...sampleTrack, id: 'yt_other' }, false);

      mockAudio.currentTime = 0;
      mockAudio.duration = 600;
      fireMetadata();

      expect(mockAudio.currentTime).toBe(0);
    });
  });

  // =========================================================================
  // 7. M13 Regression: audio graph lifecycle and 3-band EQ
  // =========================================================================
  describe('7. Audio Graph Lifecycle & EQ', () => {
    it('builds the media element source exactly once across many loads and plays', async () => {
      const ctxBefore = engine.getAudioContext();
      expect(ctxBefore).toBeNull();

      await engine.load(sampleTrack, false);
      const ctx = engine.getAudioContext() as any;
      expect(ctx).not.toBeNull();
      const sourceCalls = ctx.createMediaElementSource.mock
        ? ctx.createMediaElementSource.mock.calls.length
        : null;

      await engine.load({ ...sampleTrack, id: 'yt_second' }, false);
      await engine.play();
      engine.pause();

      const analyser = engine.getAnalyser();
      expect(analyser).not.toBeNull();
      if (sourceCalls !== null) {
        expect(ctx.createMediaElementSource.mock.calls.length).toBe(sourceCalls);
      }
      expect(engine.getAudioContext()).toBe(ctx);
    });

    it('destroy() is safe to call twice', async () => {
      await engine.load(sampleTrack, false);
      expect(() => {
        engine.destroy();
        engine.destroy();
      }).not.toThrow();
      expect(engine.getAudioContext()).toBeNull();
      expect(engine.getAnalyser()).toBeNull();
    });

    it('clamps EQ gains to +/-12 dB and stays transparent at 0', () => {
      expect(engine.getEqGains()).toEqual({ bass: 0, mid: 0, treble: 0 });

      engine.setEqGains({ bass: 40, mid: -40, treble: 6 });
      expect(engine.getEqGains()).toEqual({ bass: 12, mid: -12, treble: 6 });

      engine.setEqGains({ treble: NaN });
      expect(engine.getEqGains().treble).toBe(6); // invalid input ignored

      engine.setEqGains({ bass: 0, mid: 0, treble: 0 });
      expect(engine.getEqGains()).toEqual({ bass: 0, mid: 0, treble: 0 });
    });

    it('falls back to element volume when the audio graph cannot be created', async () => {
      const brokenAudio = { ...mockAudio };
      const brokenEngine = new AudioEngine(mockResolver, brokenAudio as any);
      const ctxProto = (globalThis as any).AudioContext.prototype;
      const spy = vi.spyOn(ctxProto, 'createMediaElementSource').mockImplementation(() => {
        throw new Error('MediaElementSource unavailable');
      });

      await brokenEngine.load(sampleTrack, false);
      brokenEngine.setVolume(0.5);

      expect(brokenAudio.volume).toBeCloseTo(0.25, 4); // quadratic curve on the element
      expect(brokenEngine.getAnalyser()).toBeNull();

      spy.mockRestore();
      brokenEngine.destroy();
    });
  });
});
