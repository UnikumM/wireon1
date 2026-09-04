import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StreamResolver,
  SOURCE_TIMEOUT_MS,
  SOURCE_TIMEOUT_MOBILE_MS,
  RESOLVE_TIMEOUT_MESSAGE
} from '../../src/services/streamResolver';
import { youtubeService, YouTubeService } from '../../src/services/youtube';
import { soundCloudService, SoundCloudService } from '../../src/services/soundcloud';
import { UnifiedTrack } from '../../src/types/music';

describe('StreamResolver Service', () => {
  let resolver: StreamResolver;

  const mockYtTrack: UnifiedTrack = {
    id: 'yt_vid123',
    source: 'youtube',
    originalId: 'vid123',
    title: 'Test YouTube Track',
    artist: 'Test Artist',
    duration: 200,
    artworkUrl: 'https://i.ytimg.com/vi/vid123/hqdefault.jpg'
  };

  const mockScTrack: UnifiedTrack = {
    id: 'sc_sc456',
    source: 'soundcloud',
    originalId: 'sc456',
    title: 'Test SoundCloud Track',
    artist: 'Test SC Artist',
    duration: 180,
    artworkUrl: 'https://i1.sndcdn.com/artworks-001-t500x500.jpg'
  };

  beforeEach(() => {
    resolver = new StreamResolver();
    resolver.clearCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves YouTube track stream and caches result', async () => {
    const mockResolveYt = vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
      streamUrl: 'https://googlevideo.com/stream123',
      format: 'm4a',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000
    });

    const res1 = await resolver.resolve(mockYtTrack);
    expect(res1.streamUrl).toBe('https://googlevideo.com/stream123');
    expect(res1.cached).toBe(false);
    expect(mockResolveYt).toHaveBeenCalledTimes(1);

    // Second call should return cached
    const res2 = await resolver.resolve(mockYtTrack);
    expect(res2.streamUrl).toBe('https://googlevideo.com/stream123');
    expect(res2.cached).toBe(true);
    expect(mockResolveYt).toHaveBeenCalledTimes(1); // No second network call
  });

  it('resolves SoundCloud track stream', async () => {
    const mockResolveSc = vi.spyOn(soundCloudService, 'resolveStreamUrl').mockResolvedValue({
      streamUrl: 'https://cf-media.sndcdn.com/stream456',
      format: 'mp3',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000
    });

    const res = await resolver.resolve(mockScTrack);
    expect(res.streamUrl).toBe('https://cf-media.sndcdn.com/stream456');
    expect(res.format).toBe('mp3');
    expect(mockResolveSc).toHaveBeenCalledTimes(1);
  });

  it('propagates the hls format so the audio engine can attach hls.js', async () => {
    vi.spyOn(soundCloudService, 'resolveStreamUrl').mockResolvedValue({
      streamUrl: 'https://playback.soundcloud.cloud/abc/playlist.m3u8',
      format: 'hls',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000
    });

    const res = await resolver.resolve(mockScTrack);
    expect(res.format).toBe('hls');
  });

  it('deduplicates concurrent in-flight resolution requests for the same track', async () => {
    let resolveCount = 0;
    vi.spyOn(youtubeService, 'resolveStreamUrl').mockImplementation(async () => {
      resolveCount++;
      await new Promise(r => setTimeout(r, 50));
      return {
        streamUrl: 'https://googlevideo.com/stream123',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 3600 * 1000
      };
    });

    const [r1, r2, r3] = await Promise.all([
      resolver.resolve(mockYtTrack),
      resolver.resolve(mockYtTrack),
      resolver.resolve(mockYtTrack)
    ]);

    expect(r1.streamUrl).toBe('https://googlevideo.com/stream123');
    expect(r2.streamUrl).toBe('https://googlevideo.com/stream123');
    expect(r3.streamUrl).toBe('https://googlevideo.com/stream123');
    expect(resolveCount).toBe(1);
  });

  it('invalidates cache correctly', async () => {
    const mockResolveYt = vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
      streamUrl: 'https://googlevideo.com/stream123',
      format: 'm4a',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000
    });

    await resolver.resolve(mockYtTrack);
    expect(mockResolveYt).toHaveBeenCalledTimes(1);

    resolver.invalidate(mockYtTrack.id);

    await resolver.resolve(mockYtTrack);
    expect(mockResolveYt).toHaveBeenCalledTimes(2);
  });

  it('throws for invalid or unsupported tracks', async () => {
    await expect(resolver.resolve(null as any)).rejects.toThrow();
    await expect(resolver.resolve({ id: 'bad_1', source: 'spotify' as any } as any)).rejects.toThrow();
  });

  it('rejects a resolution that produced no stream URL', async () => {
    vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
      streamUrl: '',
      format: 'm4a',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000
    });

    await expect(resolver.resolve(mockYtTrack)).rejects.toThrow(/no URL/i);
  });

  it('supports dependency injection with custom YouTubeService and SoundCloudService', async () => {
    const customYt = new YouTubeService();
    const customSc = new SoundCloudService();
    const customResolver = new StreamResolver(customYt, customSc);

    const customYtSpy = vi.spyOn(customYt, 'resolveStreamUrl').mockResolvedValue({
      streamUrl: 'https://custom-yt.com/stream',
      format: 'opus',
      bitrate: 160,
      expiresAt: Date.now() + 3600 * 1000
    });

    const customScSpy = vi.spyOn(customSc, 'resolveStreamUrl').mockResolvedValue({
      streamUrl: 'https://custom-sc.com/stream',
      format: 'mp3',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000
    });

    const resYt = await customResolver.resolve(mockYtTrack);
    expect(resYt.streamUrl).toBe('https://custom-yt.com/stream');
    expect(customYtSpy).toHaveBeenCalledTimes(1);

    const resSc = await customResolver.resolve(mockScTrack);
    expect(resSc.streamUrl).toBe('https://custom-sc.com/stream');
    expect(customScSpy).toHaveBeenCalledTimes(1);
  });

  describe('cache expiry', () => {
    it('re-resolves a stream once it is within the expiry margin', async () => {
      const spy = vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
        streamUrl: 'https://googlevideo.com/stream123',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 20000 // inside the 30 s margin
      });

      await resolver.resolve(mockYtTrack);
      const second = await resolver.resolve(mockYtTrack);

      expect(second.cached).toBe(false);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('keeps a realistic 5.5 h YouTube expiry cached across a whole song', async () => {
      const spy = vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
        streamUrl: 'https://googlevideo.com/stream123?expire=1893456000',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 5.5 * 3600 * 1000
      });

      await resolver.resolve(mockYtTrack);

      vi.useFakeTimers();
      // 4 minutes later — the old approxDurationMs expiry would already be stale
      vi.setSystemTime(Date.now() + 4 * 60 * 1000);

      const second = await resolver.resolve(mockYtTrack);
      expect(second.cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('forceRefresh bypasses the cache', async () => {
      const spy = vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
        streamUrl: 'https://googlevideo.com/stream123',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 3600 * 1000
      });

      await resolver.resolve(mockYtTrack);
      const refreshed = await resolver.resolve(mockYtTrack, true);

      expect(refreshed.cached).toBe(false);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('prefetch', () => {
    it('warms the cache so the later resolve is a cache hit', async () => {
      const spy = vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
        streamUrl: 'https://googlevideo.com/stream123',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 3600 * 1000
      });

      resolver.prefetch(mockYtTrack);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

      const res = await resolver.resolve(mockYtTrack);
      expect(res.cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('is safe to call repeatedly: one resolution for many calls', async () => {
      let calls = 0;
      vi.spyOn(youtubeService, 'resolveStreamUrl').mockImplementation(async () => {
        calls++;
        await new Promise(r => setTimeout(r, 20));
        return {
          streamUrl: 'https://googlevideo.com/stream123',
          format: 'm4a',
          bitrate: 128,
          expiresAt: Date.now() + 3600 * 1000
        };
      });

      for (let i = 0; i < 10; i++) resolver.prefetch(mockYtTrack);
      await vi.waitFor(() => expect(calls).toBe(1));

      // Cache is warm now: further prefetches are no-ops
      for (let i = 0; i < 10; i++) resolver.prefetch(mockYtTrack);
      await new Promise(r => setTimeout(r, 30));
      expect(calls).toBe(1);
    });

    it('never produces an unhandled rejection and backs off after a failure', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spy = vi
        .spyOn(youtubeService, 'resolveStreamUrl')
        .mockRejectedValue(new Error('yt-dlp exploded'));

      resolver.prefetch(mockYtTrack);
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(spy).toHaveBeenCalledTimes(1);

      // Cooldown: an immediate retry must not hammer the network
      resolver.prefetch(mockYtTrack);
      await new Promise(r => setTimeout(r, 10));
      expect(spy).toHaveBeenCalledTimes(1);

      // An explicit resolve() is still allowed to try again
      await expect(resolver.resolve(mockYtTrack)).rejects.toThrow('yt-dlp exploded');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('ignores invalid input', () => {
      expect(() => resolver.prefetch(null as any)).not.toThrow();
      expect(() => resolver.prefetch({ title: 'no id' } as any)).not.toThrow();
    });
  });

  // ==========================================================================
  // Приоритет: главный процесс должен знать, кто ждёт ссылку
  // ==========================================================================
  describe('priority', () => {
    const stream = {
      streamUrl: 'https://googlevideo.com/stream123',
      format: 'm4a',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000
    };

    it('marks a prefetch as background and a play as urgent', async () => {
      const spy = vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue(stream);

      resolver.prefetch(mockYtTrack);
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      expect(spy).toHaveBeenLastCalledWith('vid123', 'prefetch', undefined);

      resolver.clearCache();
      await resolver.resolve(mockYtTrack);
      expect(spy).toHaveBeenLastCalledWith('vid123', 'user', undefined);
    });

    it('raises the priority of a prefetch the listener has caught up with', async () => {
      let release: (() => void) | null = null;
      vi.spyOn(youtubeService, 'resolveStreamUrl').mockImplementation(
        () => new Promise((resolve) => { release = () => resolve(stream); })
      );
      const raise = vi.spyOn(youtubeService, 'raiseStreamPriority').mockImplementation(() => {});

      resolver.prefetch(mockYtTrack);
      await vi.waitFor(() => expect(release).not.toBeNull());

      // Тот же трек, но теперь его ждёт человек. Второй раз запрашивать нечего —
      // склейка вернёт ту же работу, поэтому приоритет поднимаем отдельно.
      const playing = resolver.resolve(mockYtTrack);
      await vi.waitFor(() => expect(raise).toHaveBeenCalledWith('vid123'));

      release!();
      await playing;
      // Повторное нажатие ничего не поднимает: заявка уже срочная.
      expect(raise).toHaveBeenCalledTimes(1);
    });

    it('does not raise anything for SoundCloud: there is no extractor queue there', async () => {
      let release: (() => void) | null = null;
      vi.spyOn(soundCloudService, 'resolveStreamUrl').mockImplementation(
        () => new Promise((resolve) => { release = () => resolve(stream); })
      );
      const raise = vi.spyOn(youtubeService, 'raiseStreamPriority').mockImplementation(() => {});

      resolver.prefetch(mockScTrack);
      await vi.waitFor(() => expect(release).not.toBeNull());
      const playing = resolver.resolve(mockScTrack);
      release!();
      await playing;

      expect(raise).not.toHaveBeenCalled();
    });
  });

  describe('источник молчит', () => {
    const scStream = {
      streamUrl: 'https://cf-media.sndcdn.com/alt789.mp3',
      format: 'mp3',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000
    };

    /** Кандидат, проходящий все три условия подмены: название, артист, длительность. */
    const scCandidate: UnifiedTrack = {
      id: 'sc_alt789',
      source: 'soundcloud',
      originalId: 'alt789',
      title: 'Test YouTube Track',
      artist: 'Test Artist',
      duration: 205,
      artworkUrl: 'https://i1.sndcdn.com/artworks-alt.jpg'
    };

    beforeEach(() => {
      // Ограничитель ждёт настоящим `setTimeout`, поэтому без подменённых часов
      // тест простоял бы полные тридцать секунд.
      vi.useFakeTimers();
    });

    it('превращает зависание в отказ, а не ждёт вечно', async () => {
      vi.spyOn(youtubeService, 'resolveStreamUrl').mockImplementation(
        () => new Promise(() => {})
      );
      // Подмены нет — значит наверх должен уйти именно истёкший срок.
      const search = vi.spyOn(soundCloudService, 'search').mockResolvedValue([]);

      const pending = resolver.resolve(mockYtTrack);
      const rejected = expect(pending).rejects.toThrow(new RegExp(RESOLVE_TIMEOUT_MESSAGE));
      await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS + 100);
      await rejected;

      expect(search).toHaveBeenCalled();
    });

    it('подменяет молчащий YouTube версией с SoundCloud', async () => {
      vi.spyOn(youtubeService, 'resolveStreamUrl').mockImplementation(
        () => new Promise(() => {})
      );
      vi.spyOn(soundCloudService, 'search').mockResolvedValue([scCandidate]);
      const scResolve = vi
        .spyOn(soundCloudService, 'resolveStreamUrl')
        .mockResolvedValue(scStream);

      const pending = resolver.resolve(mockYtTrack);
      await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS + 100);
      const result = await pending;

      expect(result.streamUrl).toBe(scStream.streamUrl);
      expect(result.substitutedFrom).toBe('soundcloud');
      expect(scResolve).toHaveBeenCalledWith('alt789');
    });

    it('не выдаёт обрезанное превью за подмену', async () => {
      vi.spyOn(youtubeService, 'resolveStreamUrl').mockImplementation(
        () => new Promise(() => {})
      );
      vi.spyOn(soundCloudService, 'search').mockResolvedValue([scCandidate]);
      vi.spyOn(soundCloudService, 'resolveStreamUrl').mockResolvedValue({
        ...scStream,
        isPreview: true
      });

      const pending = resolver.resolve(mockYtTrack);
      const rejected = expect(pending).rejects.toThrow(new RegExp(RESOLVE_TIMEOUT_MESSAGE));
      await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS + 100);
      await rejected;
    });

    it('не принимает чужую песню похожей длины', async () => {
      vi.spyOn(youtubeService, 'resolveStreamUrl').mockImplementation(
        () => new Promise(() => {})
      );
      vi.spyOn(soundCloudService, 'search').mockResolvedValue([
        { ...scCandidate, title: 'Совершенно другая песня', artist: 'Кто-то ещё' }
      ]);
      const scResolve = vi
        .spyOn(soundCloudService, 'resolveStreamUrl')
        .mockResolvedValue(scStream);

      const pending = resolver.resolve(mockYtTrack);
      const rejected = expect(pending).rejects.toThrow(new RegExp(RESOLVE_TIMEOUT_MESSAGE));
      await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS + 100);
      await rejected;

      expect(scResolve).not.toHaveBeenCalled();
    });

    it('ограничивает и SoundCloud, когда он сам источник', async () => {
      vi.spyOn(soundCloudService, 'resolveStreamUrl').mockImplementation(
        () => new Promise(() => {})
      );

      const pending = resolver.resolve(mockScTrack);
      const rejected = expect(pending).rejects.toThrow(new RegExp(RESOLVE_TIMEOUT_MESSAGE));
      await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS + 100);
      await rejected;
    });
  });
});

describe('Кэш ссылок переживает перезапуск', () => {
  /*
   * Ради чего. Разбор трека на телефоне занимает секунды — замерено 35 с на
   * эмуляторе и 9,5 с на настольной машине. Ускорить сам разбор нечем: клиенты
   * YouTube, отвечающие быстрее, отдают форматы, которые `<audio>` не играет.
   * Зато ссылка живёт около шести часов, и всё это время повторное включение
   * могло бы быть мгновенным — а кэш жил только в памяти, поэтому каждый
   * запуск начинался с нуля.
   */

  it('восстанавливает живые ссылки и отбрасывает протухшие', async () => {
    const db = await import('../../src/services/db');
    const { StreamResolver, STREAM_CACHE_KEY } = await import('../../src/services/streamResolver');

    vi.spyOn(db, 'getSetting').mockImplementation(async (key: string) => {
      if (key !== STREAM_CACHE_KEY) return undefined as never;
      return {
        yt_live: {
          streamUrl: 'https://example.test/live.m4a',
          format: 'm4a',
          bitrate: 128,
          expiresAt: Date.now() + 3_600_000
        },
        yt_stale: {
          streamUrl: 'https://example.test/stale.m4a',
          format: 'm4a',
          bitrate: 128,
          // Протухшая ссылка хуже отсутствия: её отдали бы плееру, и он молча
          // не заиграл бы.
          expiresAt: Date.now() - 1000
        },
        yt_blob: {
          // Адрес офлайн-копии живёт в памяти одного запуска и после
          // перезапуска не значит ничего.
          streamUrl: 'blob:whatever',
          format: 'm4a',
          bitrate: 128,
          expiresAt: Date.now() + 3_600_000
        }
      } as never;
    });

    const resolver = new StreamResolver();
    await resolver.hydrateCache();

    const cache = (resolver as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.has('yt_live')).toBe(true);
    expect(cache.has('yt_stale')).toBe(false);
    expect(cache.has('yt_blob')).toBe(false);
  });

  it('испорченная запись не роняет запуск', async () => {
    // Кэш — ускорение, а не условие работы приложения.
    const db = await import('../../src/services/db');
    const { StreamResolver } = await import('../../src/services/streamResolver');
    vi.spyOn(db, 'getSetting').mockRejectedValue(new Error('база недоступна') as never);

    const resolver = new StreamResolver();
    await expect(resolver.hydrateCache()).resolves.toBeUndefined();
  });
});

describe('Медленный YouTube уступает SoundCloud', () => {
  /*
   * Ради чего. Разбор ссылки YouTube на телефоне идёт секундами — замерено 35 с
   * на эмуляторе и 9,5 с на настольной машине. Ускорить его нечем: клиенты
   * YouTube, отвечающие быстрее, отдают форматы, которые `<audio>` не играет.
   * SoundCloud отвечает почти сразу — там ссылка отдаётся как есть.
   *
   * Поэтому YouTube получает фору, а потом за ту же песню берётся SoundCloud, и
   * играет то, что готово первым. Проверяется здесь именно то, чем такой приём
   * опасен: что фора соблюдается, что быстрый YouTube не подменяется, что
   * подмена проходит строгую сверку и что фоновые прогревы в гонку не идут.
   */

  const ytTrack = {
    id: 'yt_slow',
    source: 'youtube' as const,
    originalId: 'slow1',
    title: 'Кукушка',
    artist: 'Кино',
    duration: 240,
    artworkUrl: ''
  };

  it('быстрый YouTube играет сам: подмены не происходит', async () => {
    const { StreamResolver, SUBSTITUTE_HEAD_START_MS } = await import(
      '../../src/services/streamResolver'
    );
    const yt = {
      resolveStreamUrl: vi.fn(async () => ({
        streamUrl: 'https://yt.test/a.m4a',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 3_600_000
      }))
    };
    const sc = { search: vi.fn(async () => []), resolveStreamUrl: vi.fn() };

    const resolver = new StreamResolver(yt as never, sc as never);
    const out = await resolver.resolve(ytTrack);

    expect(out.streamUrl).toContain('yt.test');
    // Поиск на SoundCloud даже не начинался: фора не истекла.
    expect(sc.search).not.toHaveBeenCalled();
    expect(SUBSTITUTE_HEAD_START_MS).toBeGreaterThan(0);
  });

  it('молчащий YouTube уступает: играет строго та же песня с SoundCloud', async () => {
    const { StreamResolver } = await import('../../src/services/streamResolver');
    const yt = {
      // Никогда не отвечает — ровно то, на что жалуются.
      resolveStreamUrl: vi.fn(() => new Promise(() => {}))
    };
    const sc = {
      search: vi.fn(async () => [
        { id: 'sc_1', source: 'soundcloud', originalId: 'sc1', title: 'Кукушка', artist: 'Кино', duration: 242, artworkUrl: '' }
      ]),
      resolveStreamUrl: vi.fn(async () => ({
        streamUrl: 'https://sc.test/a.mp3',
        format: 'mp3',
        bitrate: 128,
        expiresAt: Date.now() + 3_600_000
      }))
    };

    const resolver = new StreamResolver(yt as never, sc as never);
    const out = await resolver.resolve(ytTrack);

    expect(out.streamUrl).toContain('sc.test');
  }, 20000);

  it('чужая песня не подставляется, даже если YouTube молчит', async () => {
    // Иначе вместо заблокированного трека молча заиграл бы кавер или часовой
    // микс — это хуже честного ожидания.
    const { StreamResolver } = await import('../../src/services/streamResolver');
    const yt = { resolveStreamUrl: vi.fn(() => new Promise(() => {})) };
    const sc = {
      search: vi.fn(async () => [
        { id: 'sc_x', source: 'soundcloud', originalId: 'scx', title: 'Совсем другое', artist: 'Кто-то', duration: 240, artworkUrl: '' }
      ]),
      resolveStreamUrl: vi.fn()
    };

    const resolver = new StreamResolver(yt as never, sc as never);
    let settled = false;
    void resolver.resolve(ytTrack).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await new Promise((r) => setTimeout(r, 5000));
    expect(settled).toBe(false);
    expect(sc.resolveStreamUrl).not.toHaveBeenCalled();
  }, 20000);

  it('фоновый прогрев очереди в гонку не идёт', async () => {
    // Там никто не ждёт, а лишний поиск на каждый трек очереди — трафик впустую.
    const { StreamResolver } = await import('../../src/services/streamResolver');
    const yt = { resolveStreamUrl: vi.fn(() => new Promise(() => {})) };
    const sc = { search: vi.fn(async () => []), resolveStreamUrl: vi.fn() };

    const resolver = new StreamResolver(yt as never, sc as never);
    void resolver.resolve(ytTrack, false, 'prefetch').catch(() => {});

    await new Promise((r) => setTimeout(r, 5000));
    expect(sc.search).not.toHaveBeenCalled();
  }, 20000);
});

/**
 * На телефоне те же сроки означают другое.
 *
 * Дыра, из-за которой это дожило до людей: все проверки шли в jsdom, где
 * платформа — «браузер», и десктопные числа выглядели разумно. На устройстве
 * ссылку добывает сам телефон: поднимается Python, перебираются клиенты
 * YouTube, каждая ссылка проверяется запросом к раздаче. Тридцати секунд там не
 * хватало, а трёхсекундной форы не хватало никогда — подмена с SoundCloud
 * выигрывала почти на каждом треке, и человек слушал чужую загрузку вместо
 * выбранной записи.
 */
describe('Сроки на телефоне', () => {
  const ytTrack: UnifiedTrack = {
    id: 'yt_mobile',
    source: 'youtube',
    originalId: 'mob1',
    title: 'Кукушка',
    artist: 'Кино',
    duration: 240,
    artworkUrl: ''
  };

  const realElectron = (window as unknown as { electronAPI?: unknown }).electronAPI;

  beforeEach(() => {
    vi.useFakeTimers();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    (window as unknown as { electronAPI?: unknown }).electronAPI = realElectron;
  });

  it('фора YouTube длится дольше трёх секунд, иначе он не выигрывает никогда', async () => {
    const yt = { resolveStreamUrl: vi.fn(() => new Promise(() => {})) };
    const sc = { search: vi.fn(async () => []), resolveStreamUrl: vi.fn() };
    const resolver = new StreamResolver(yt as never, sc as never);

    const pending = resolver.resolve(ytTrack);
    pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(4000);
    // На десктопе поиск подмены здесь уже идёт. На телефоне за это время
    // обычный разбор ещё даже не закончился.
    expect(sc.search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(9000);
    expect(sc.search).toHaveBeenCalled();
  });

  it('молчание в тридцать секунд ещё не повод объявлять отказ', async () => {
    const yt = { resolveStreamUrl: vi.fn(() => new Promise(() => {})) };
    const sc = { search: vi.fn(async () => []), resolveStreamUrl: vi.fn() };
    const resolver = new StreamResolver(yt as never, sc as never);

    let settled = false;
    const pending = resolver.resolve(ytTrack).catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS + 5000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MOBILE_MS);
    await pending;
    expect(settled).toBe(true);
  });
});
