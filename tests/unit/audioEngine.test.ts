import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioEngine, LOAD_WATCHDOG_MS } from '../../src/services/audioEngine';
import { StreamResolver } from '../../src/services/streamResolver';
import { attachHls, isHlsUrl } from '../../src/services/hls';
import { UnifiedTrack } from '../../src/types/music';

// The HLS adapter is mocked: no hls.js, no network, no MSE in jsdom.
vi.mock('../../src/services/hls', () => ({
  isHlsUrl: (url?: string) => (url ? /\.m3u8(\?|#|$)/i.test(url) : false),
  isNativeHlsSupported: () => false,
  isHlsJsSupported: async () => true,
  isHlsSupported: async () => true,
  attachHls: vi.fn()
}));

describe('AudioEngine DSP & Playback Core', () => {
  let engine: AudioEngine;
  let mockResolver: StreamResolver;
  let mockAudio: any;

  const mockTrack: UnifiedTrack = {
    id: 'yt_test123',
    source: 'youtube',
    originalId: 'test123',
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    duration: 355,
    artworkUrl: 'https://i.ytimg.com/vi/test123/hqdefault.jpg'
  };

  beforeEach(() => {
    mockResolver = new StreamResolver();
    vi.spyOn(mockResolver, 'resolve').mockResolvedValue({
      streamUrl: 'https://googlevideo.com/stream123',
      format: 'm4a',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000,
      cached: false
    });

    const listeners: Record<string, Function[]> = {};
    mockAudio = {
      src: '',
      currentTime: 0,
      duration: 355,
      volume: 1,
      muted: false,
      buffered: {
        length: 1,
        end: () => 120
      },
      addEventListener: vi.fn((event, cb) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      }),
      removeEventListener: vi.fn((event, cb) => {
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

  it('loads track, resolves stream, and initiates playback', async () => {
    const stateChanges: string[] = [];
    engine.onStateChange(s => stateChanges.push(s));

    await engine.load(mockTrack, true);

    expect(mockResolver.resolve).toHaveBeenCalledWith(mockTrack);
    expect(mockAudio.src).toBe('https://googlevideo.com/stream123');
    expect(mockAudio.load).toHaveBeenCalled();
    expect(mockAudio.play).toHaveBeenCalled();
    expect(engine.getCurrentTrack()).toEqual(expect.objectContaining({ id: 'yt_test123' }));
    expect(stateChanges).toContain('loading');
    expect(stateChanges).toContain('playing');
  });

  it('pauses and resumes playback', async () => {
    await engine.load(mockTrack, true);

    engine.pause();
    expect(mockAudio.pause).toHaveBeenCalled();
    expect(engine.getState()).toBe('paused');

    await engine.play();
    expect(mockAudio.play).toHaveBeenCalledTimes(2);
    expect(engine.getState()).toBe('playing');
  });

  it('seeks to target time in seconds', async () => {
    await engine.load(mockTrack, true);

    let reportedTime = 0;
    engine.onTimeUpdate(t => { reportedTime = t; });

    engine.seek(150);
    expect(mockAudio.currentTime).toBe(150);
    expect(reportedTime).toBe(150);
  });

  it('applies quadratic perceptual volume curve V = x^2', () => {
    // 0.8 volume -> 0.8^2 = 0.64
    engine.setVolume(0.8);
    expect(engine.getVolume()).toBe(0.8);

    // 0.5 volume -> 0.5^2 = 0.25
    engine.setVolume(0.5);
    expect(engine.getVolume()).toBe(0.5);

    // Bounds checking
    engine.setVolume(1.5);
    expect(engine.getVolume()).toBe(1.0);

    engine.setVolume(-0.2);
    expect(engine.getVolume()).toBe(0.0);
  });

  it('handles mute and unmute transitions', () => {
    engine.setVolume(0.8);
    engine.setMuted(true);
    expect(engine.isMuted()).toBe(true);

    engine.setMuted(false);
    expect(engine.isMuted()).toBe(false);
    expect(engine.getVolume()).toBe(0.8);
  });

  it('subscribes and unsubscribes event listeners', () => {
    const timeCb = vi.fn();
    const unsubscribe = engine.onTimeUpdate(timeCb);

    engine.seek(50);
    expect(timeCb).toHaveBeenCalledTimes(1);

    unsubscribe();
    engine.seek(60);
    expect(timeCb).toHaveBeenCalledTimes(1); // Not called again
  });

  it('provides real-time frequency data array from AnalyserNode', () => {
    const data = engine.getFrequencyData();
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBeGreaterThan(0);
  });

  it('reuses one spectrum buffer instead of allocating per frame', () => {
    // The orb and the bar visualiser ask sixty times a second each; a fresh
    // array per call is pure garbage for data that dies with the frame.
    const first = engine.getFrequencyData();
    const second = engine.getFrequencyData();
    expect(second).toBe(first);
  });

  describe('HLS streams (SoundCloud m3u8)', () => {
    const HLS_URL = 'https://cf-hls-media.sndcdn.com/playlist/abc.m3u8?Policy=xyz';
    const hlsTrack: UnifiedTrack = {
      id: 'sc_hls_1',
      source: 'soundcloud',
      originalId: 'hls1',
      title: 'Cloud Set',
      artist: 'DJ Stream',
      duration: 3600,
      artworkUrl: 'https://example.com/hls.jpg'
    };

    const makeHandle = (url = HLS_URL) => ({ url, usingNative: false, destroy: vi.fn() });

    const resolveAs = (streamUrl: string, format: string) => {
      vi.spyOn(mockResolver, 'resolve').mockResolvedValue({
        streamUrl,
        format,
        bitrate: 128,
        expiresAt: Date.now() + 3600 * 1000,
        cached: false
      });
    };

    beforeEach(() => {
      vi.mocked(attachHls).mockReset();
    });

    it('attaches the manifest through the HLS adapter instead of audio.src', async () => {
      const handle = makeHandle();
      vi.mocked(attachHls).mockResolvedValue(handle);
      resolveAs(HLS_URL, 'hls');

      await engine.load(hlsTrack, false);

      expect(attachHls).toHaveBeenCalledTimes(1);
      expect(vi.mocked(attachHls).mock.calls[0][0]).toBe(mockAudio);
      expect(vi.mocked(attachHls).mock.calls[0][1]).toBe(HLS_URL);
      expect(mockAudio.src).toBe(''); // never assigned directly
      expect(mockAudio.load).not.toHaveBeenCalled();
    });

    it('detects HLS from the URL even when the reported format lies', async () => {
      expect(isHlsUrl(HLS_URL)).toBe(true);
      vi.mocked(attachHls).mockResolvedValue(makeHandle());
      resolveAs(HLS_URL, 'mp3');

      await engine.load(hlsTrack, false);

      expect(attachHls).toHaveBeenCalledTimes(1);
      expect(mockAudio.src).toBe('');
    });

    it('keeps using audio.src for progressive streams', async () => {
      await engine.load(mockTrack, false);

      expect(attachHls).not.toHaveBeenCalled();
      expect(mockAudio.src).toBe('https://googlevideo.com/stream123');
      expect(mockAudio.load).toHaveBeenCalled();
    });

    it('destroys the previous handle before the next load and on destroy()', async () => {
      const first = makeHandle('https://cdn/first.m3u8');
      const second = makeHandle('https://cdn/second.m3u8');
      vi.mocked(attachHls).mockResolvedValueOnce(first).mockResolvedValueOnce(second);

      resolveAs('https://cdn/first.m3u8', 'hls');
      await engine.load(hlsTrack, false);

      resolveAs('https://cdn/second.m3u8', 'hls');
      await engine.load({ ...hlsTrack, id: 'sc_hls_2' }, false);

      expect(first.destroy).toHaveBeenCalledTimes(1);
      expect(second.destroy).not.toHaveBeenCalled();

      engine.destroy();
      expect(second.destroy).toHaveBeenCalledTimes(1);

      engine.destroy(); // idempotent
      expect(second.destroy).toHaveBeenCalledTimes(1);
    });

    it('releases the handle when switching back to a progressive stream', async () => {
      const handle = makeHandle();
      vi.mocked(attachHls).mockResolvedValue(handle);
      resolveAs(HLS_URL, 'hls');
      await engine.load(hlsTrack, false);

      resolveAs('https://googlevideo.com/progressive.m4a', 'm4a');
      await engine.load(mockTrack, false);

      expect(handle.destroy).toHaveBeenCalledTimes(1);
      expect(mockAudio.src).toBe('https://googlevideo.com/progressive.m4a');
    });

    it('surfaces an attach failure as an engine error instead of an unhandled rejection', async () => {
      vi.mocked(attachHls).mockRejectedValue(
        new Error('HLS playback unavailable: hls.js could not be loaded')
      );
      resolveAs(HLS_URL, 'hls');
      const errorListener = vi.fn();
      engine.onError(errorListener);

      await expect(engine.load(hlsTrack, true)).rejects.toThrow('HLS playback unavailable');
      expect(engine.getState()).toBe('error');
      expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
      expect(mockAudio.play).not.toHaveBeenCalled();
    });

    it('routes fatal post-attach errors to listeners but ignores recoverable warnings', async () => {
      const handle = makeHandle();
      let reportError: ((err: Error) => void) | undefined;
      vi.mocked(attachHls).mockImplementation(async (_el, _url, options) => {
        reportError = options?.onError;
        return handle;
      });
      resolveAs(HLS_URL, 'hls');

      await engine.load(hlsTrack, false);
      const errorListener = vi.fn();
      engine.onError(errorListener);

      reportError?.(new Error('HLS warning: mediaError/bufferStalledError: stalled'));
      expect(engine.getState()).not.toBe('error');
      expect(errorListener).not.toHaveBeenCalled();

      reportError?.(new Error('HLS playback unavailable: fatal networkError'));
      expect(engine.getState()).toBe('error');
      expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
    });

    it('keeps the Web Audio graph (EQ, analyser) alive across HLS loads', async () => {
      vi.mocked(attachHls).mockResolvedValue(makeHandle());
      resolveAs(HLS_URL, 'hls');

      await engine.load(hlsTrack, false);
      const ctx = engine.getAudioContext();
      const analyser = engine.getAnalyser();
      expect(ctx).not.toBeNull();
      expect(analyser).not.toBeNull();

      engine.setEqGains({ bass: 4 });
      await engine.load({ ...hlsTrack, id: 'sc_hls_3' }, false);

      expect(engine.getAudioContext()).toBe(ctx);
      expect(engine.getAnalyser()).toBe(analyser); // source created only once
      expect(engine.getEqGains().bass).toBe(4);
      expect(engine.getFrequencyData().length).toBe(128);
    });

    it('plays after the manifest has been parsed', async () => {
      vi.mocked(attachHls).mockResolvedValue(makeHandle());
      resolveAs(HLS_URL, 'hls');

      await engine.load(hlsTrack, true);

      expect(attachHls).toHaveBeenCalledTimes(1);
      expect(mockAudio.play).toHaveBeenCalledTimes(1);
      expect(engine.getState()).toBe('playing');
    });
  });

  describe('AudioEngine Resilience & Transparent Auto-Recovery', () => {
    it('transparently auto-recovers from mid-stream glitch without fatal error', async () => {
      await engine.load(mockTrack, true);
      mockAudio.currentTime = 65.5;

      const invalidateSpy = vi.spyOn(mockResolver, 'invalidate');
      const resolveSpy = vi.spyOn(mockResolver, 'resolve').mockResolvedValue({
        streamUrl: 'https://googlevideo.com/fresh_stream_456',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 3600 * 1000,
        cached: false
      });

      const errorListener = vi.fn();
      engine.onError(errorListener);

      mockAudio.error = { code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };

      // Simulate mid-track error event
      const errorPromise = (engine as any).handleError();
      expect(engine.getState()).toBe('buffering'); // User sees buffering, NOT fatal error toast

      await errorPromise;

      expect(invalidateSpy).toHaveBeenCalledWith(mockTrack.id);
      expect(resolveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: mockTrack.id }),
        true,
        'user',
        expect.anything()
      );
      expect(mockAudio.src).toBe('https://googlevideo.com/fresh_stream_456');
      expect(mockAudio.currentTime).toBe(65.5);
      expect(mockAudio.play).toHaveBeenCalledTimes(2);
      expect(engine.getState()).toBe('playing');
      expect(errorListener).not.toHaveBeenCalled();
    });

    it('вторая попытка не отматывает трек назад, к месту первой поломки', async () => {
      // Позиция снималась один раз до цикла попыток и переиспользовалась
      // всеми тремя: вторая и третья возвращали трек туда же, где он сломался
      // в первый раз. Снаружи это слышно как один и тот же кусок по кругу —
      // «трек перемалывается».
      //
      // Проверяется именно **внутренний** цикл одной починки: первая попытка
      // отказывает, между попытками трек успевает доиграть до 50 секунд, и
      // вторая обязана продолжить оттуда, а не с тридцатой.
      await engine.load(mockTrack, true);
      mockAudio.currentTime = 30;

      let attempt = 0;
      vi.spyOn(mockResolver, 'resolve').mockImplementation(async () => {
        attempt += 1;
        if (attempt === 1) {
          mockAudio.currentTime = 50;
          throw new Error('первая попытка починки не удалась');
        }
        return {
          streamUrl: 'https://googlevideo.com/fresh_stream_456',
          format: 'm4a',
          bitrate: 128,
          expiresAt: Date.now() + 3600 * 1000,
          cached: false
        };
      });

      mockAudio.error = { code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
      await (engine as any).handleError();

      expect(attempt).toBe(2);
      expect(mockAudio.currentTime).toBe(50);
    });

    it('stall watchdog triggers auto-recovery when playback freezes for > 3.5s', async () => {
      vi.useFakeTimers();
      try {
        await engine.load(mockTrack, true);
        mockAudio.currentTime = 40.0;
        mockAudio.paused = false;
        mockAudio.ended = false;

        const recoverSpy = vi.spyOn(engine as any, 'recoverStream');

        // Fire waiting event (stall)
        (engine as any).handleWaiting();
        expect(engine.getState()).toBe('buffering');

        // Advance 3.5s
        await vi.advanceTimersByTimeAsync(3600);

        expect(recoverSpy).toHaveBeenCalledWith(expect.stringContaining('watchdog'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('спасает включение, которое застыло на загрузке и не прислало событий', async () => {
      vi.useFakeTimers();
      try {
        // Так ведёт себя мёртвая ссылка: байты не идут, событий нет, а промис
        // play() не разрешается никогда. Именно этот случай оставался на экране
        // бесконечной загрузкой.
        mockAudio.play = vi.fn(() => new Promise(() => {}));
        const recoverSpy = vi
          .spyOn(engine as any, 'recoverStream')
          .mockResolvedValue(undefined);

        void engine.load(mockTrack, true);
        await vi.advanceTimersByTimeAsync(0);
        expect(engine.getState()).toBe('loading');

        // Событийный сторож здесь не заводился: ни waiting, ни stalled не было.
        expect(recoverSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(LOAD_WATCHDOG_MS + 500);

        expect(recoverSpy).toHaveBeenCalledWith(expect.stringContaining('watchdog'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('не трогает медленную, но живую загрузку', async () => {
      vi.useFakeTimers();
      try {
        mockAudio.play = vi.fn(() => new Promise(() => {}));
        const recoverSpy = vi
          .spyOn(engine as any, 'recoverStream')
          .mockResolvedValue(undefined);

        void engine.load(mockTrack, true);
        await vi.advanceTimersByTimeAsync(0);
        // Позиция сдвинулась — поток идёт, просто не торопится.
        mockAudio.currentTime = 0.4;

        await vi.advanceTimersByTimeAsync(LOAD_WATCHDOG_MS + 500);

        expect(recoverSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('снимает сторож включения, когда звук пошёл', async () => {
      vi.useFakeTimers();
      try {
        const recoverSpy = vi
          .spyOn(engine as any, 'recoverStream')
          .mockResolvedValue(undefined);

        await engine.load(mockTrack, true);
        (engine as any).handlePlaying();
        expect((engine as any).loadWatchdogTimer).toBeNull();

        await vi.advanceTimersByTimeAsync(LOAD_WATCHDOG_MS + 500);

        expect(recoverSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('сторож простоя теперь считает зависанием и саму загрузку', async () => {
      vi.useFakeTimers();
      try {
        mockAudio.play = vi.fn(() => new Promise(() => {}));
        const recoverSpy = vi
          .spyOn(engine as any, 'recoverStream')
          .mockResolvedValue(undefined);

        void engine.load(mockTrack, true);
        await vi.advanceTimersByTimeAsync(0);
        expect(engine.getState()).toBe('loading');

        // До починки эта ветка молча ничего не делала: в колбэке сторожа
        // состояние `loading` не признавалось зависанием.
        (engine as any).handleStalled();
        await vi.advanceTimersByTimeAsync(3600);

        expect(recoverSpy).toHaveBeenCalledWith(expect.stringContaining('watchdog'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('resets retryCount to 0 after 10s of healthy uninterrupted playback', async () => {
      vi.useFakeTimers();
      try {
        await engine.load(mockTrack, true);
        (engine as any).retryCount = 2;

        (engine as any).handlePlaying();
        expect((engine as any).retryCount).toBe(2);

        // Advance 10s of healthy playback
        await vi.advanceTimersByTimeAsync(10500);

        expect((engine as any).retryCount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * Заминка и поломка — разные вещи, и лечатся они по-разному.
     *
     * Владелец описал беду так: «грузится начало песни первые 5-15 секунд и
     * виснет и потом снова догружает». Тяжёлая починка выбрасывает запомненную
     * ссылку и просит новую, а поход за ней стоит на ПК четыре-восемь секунд по
     * замерам — то есть за полторы секунды заминки человек платил пятью
     * секундами тишины. При этом заминка чаще проходит сама.
     */
    it('заминка, которая прошла сама, не стоит похода за новой ссылкой', async () => {
      await engine.load(mockTrack, true);
      mockAudio.currentTime = 30;
      mockAudio.paused = false;
      mockAudio.error = null;

      const resolve = vi.spyOn(mockResolver, 'resolve');
      resolve.mockClear();

      // Поток оживает через полсекунды — позиция едет дальше.
      setTimeout(() => {
        mockAudio.currentTime = 31.2;
      }, 500);

      await (engine as any).recoverStream('Playback stall watchdog triggered');

      expect(resolve).not.toHaveBeenCalled();
      expect((engine as any).retryCount).toBe(0);
      expect((engine as any).isRecovering).toBe(false);
    });

    it('заминка, которая не прошла, всё-таки ведёт за новой ссылкой', async () => {
      await engine.load(mockTrack, true);
      mockAudio.currentTime = 30;
      mockAudio.paused = false;
      mockAudio.error = null;

      const resolve = vi.spyOn(mockResolver, 'resolve');
      resolve.mockClear();

      await (engine as any).recoverStream('Playback stall watchdog triggered');

      expect(resolve).toHaveBeenCalled();
    });

    it('surfaces fatal error only after exhausting all 3 auto-recovery attempts', async () => {
      await engine.load(mockTrack, true);
      mockAudio.currentTime = 100.0;

      vi.spyOn(mockResolver, 'resolve').mockRejectedValue(new Error('Network drop unrecoverable'));

      const errorListener = vi.fn();
      engine.onError(errorListener);

      mockAudio.error = { code: 2, message: 'MEDIA_ERR_NETWORK' };

      await (engine as any).handleError();

      expect((engine as any).retryCount).toBe(3);
      expect(engine.getState()).toBe('error');
      expect(errorListener).toHaveBeenCalledTimes(1);
      expect(errorListener.mock.calls[0][0].message).toMatch(/Network drop unrecoverable|Playback failed/);
    });
  });
});

/**
 * Телефон: звук идёт мимо Web Audio, и это не упрощение, а единственный путь.
 *
 * Замерено на устройстве 2026-08-29 на одной и той же ссылке от yt-dlp:
 * элемент без `crossOrigin` доходит до `canplay`, элемент с
 * `crossOrigin='anonymous'` отвечает ошибкой 4 — у ссылок `googlevideo.com`
 * нет заголовков CORS, а страница в WebView живёт на `https://localhost`.
 * Снаружи это выглядело как «этот аудиоформат здесь не воспроизводится», то
 * есть как беда с треком.
 *
 * Обратная сторона снятого атрибута тоже замерена: `createMediaElementSource`
 * на запятнанном ресурсе отдаёт тишину — элемент играет, `currentTime` растёт,
 * анализатор видит нули. Поэтому граф на телефоне не строится вовсе.
 */
describe('AudioEngine на телефоне', () => {
  const realElectron = (window as unknown as { electronAPI?: unknown }).electronAPI;

  function pretendMobile(): void {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
  }

  function makeElement(): HTMLAudioElement {
    return {
      crossOrigin: null,
      preload: '',
      volume: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
      pause: () => {}
    } as unknown as HTMLAudioElement;
  }

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    (window as unknown as { electronAPI?: unknown }).electronAPI = realElectron;
  });

  it('не ставит crossOrigin: с ним YouTube не отдаёт ссылку вовсе', () => {
    pretendMobile();
    const a = makeElement();
    const b = makeElement();

    new AudioEngine(new StreamResolver(), a, b);

    expect(a.crossOrigin).toBeNull();
    expect(b.crossOrigin).toBeNull();
    // Предзагрузка при этом остаётся: она к заголовкам отношения не имеет.
    expect(a.preload).toBe('auto');
  });

  it('на десктопе атрибут остаётся — там ссылку добывает главный процесс', () => {
    const a = makeElement();
    const b = makeElement();

    new AudioEngine(new StreamResolver(), a, b);

    expect(a.crossOrigin).toBe('anonymous');
    expect(b.crossOrigin).toBe('anonymous');
  });
});
