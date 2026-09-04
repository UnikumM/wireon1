import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { youtubeService, YouTubeService } from '../../src/services/youtube';
import { soundCloudService, SoundCloudService } from '../../src/services/soundcloud';
import { streamResolver, StreamResolver } from '../../src/services/streamResolver';
import { searchAggregator, SearchAggregator } from '../../src/services/aggregator';
import { UnifiedTrack } from '../../src/types/music';

describe('Adversarial Challenge & Stress Suite (Milestone 1)', () => {
  let ytService: YouTubeService;
  let scService: SoundCloudService;
  let resolver: StreamResolver;
  let aggregator: SearchAggregator;

  beforeEach(() => {
    ytService = youtubeService;
    scService = soundCloudService;
    resolver = streamResolver;
    aggregator = searchAggregator;
    resolver.clearCache();
    aggregator.clearCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resolver.clearCache();
    aggregator.clearCache();
  });

  // ==========================================================================
  // STRESS SUITE 1: Adversarial Queries & Boundary Inputs
  // ==========================================================================
  describe('1. Adversarial Queries & Boundary Inputs', () => {
    it('handles empty, whitespace, and null/undefined-like query strings without making network calls', async () => {
      const ytSpy = vi.spyOn(ytService, 'search');
      const scSpy = vi.spyOn(scService, 'search');

      const emptyQueries = ['', '   ', '\t\n\r  ', null as any, undefined as any];

      for (const q of emptyQueries) {
        const res = await aggregator.search(q);
        expect(res.results).toEqual([]);
        expect(res.sources.youtube).toBe(0);
        expect(res.sources.soundcloud).toBe(0);
      }

      expect(ytSpy).not.toHaveBeenCalled();
      expect(scSpy).not.toHaveBeenCalled();
    });

    it('handles massive 1,000 to 10,000 character queries safely without crashing or hanging', async () => {
      const longQuery1k = 'Supercalifragilisticexpialidocious '.repeat(35); // >1000 chars
      const longQuery10k = 'A'.repeat(10000);

      vi.spyOn(ytService, 'search').mockResolvedValue([]);
      vi.spyOn(scService, 'search').mockResolvedValue([]);

      const res1k = await aggregator.search(longQuery1k);
      expect(res1k.results).toEqual([]);

      const res10k = await aggregator.search(longQuery10k);
      expect(res10k.results).toEqual([]);
    });

    it('safely handles XSS vectors, SQL injection strings, and template injections in search', async () => {
      const attackVectors = [
        '<script>alert("xss")</script>',
        '<img src=x onerror=alert(document.cookie)>',
        "'; DROP TABLE tracks; --",
        '${7*7}{{constructor.constructor("return this")()}}',
        '"><svg onload=alert(1)>',
        '\\x00\\x1b[31mRED_COLOR\\x1b[0m',
        'http://evil.com/payload.js'
      ];

      vi.spyOn(ytService, 'search').mockResolvedValue([]);
      vi.spyOn(scService, 'search').mockResolvedValue([]);

      for (const vector of attackVectors) {
        const res = await aggregator.search(vector);
        expect(res).toBeDefined();
        expect(Array.isArray(res.results)).toBe(true);
      }
    });

    it('handles international unicode, CJK, RTL languages, emojis, and Zalgo text', async () => {
      const internationalQueries = [
        '🎵 🎶 🎧 🎸 🎹 👑 Queen & Freddie Mercury',
        'موسيقى عربية عود 2026',
        'Виреон Музыка — Ночной город',
        '日本語の歌 宇多田ヒカル First Love',
        '한국 음악 BTS 방탄소년단',
        'Ḧ̵̟́e̸͙̾l̶̘̇ĺ̶̤ọ̵͊ ̸̛̜Ẁ̶̧ô̷̜r̵̢̈l̵̬̽ḓ̵́ Zalgo',
        '%20%2F%3F%26%3D'
      ];

      vi.spyOn(ytService, 'search').mockImplementation(async (q) => [
        {
          id: 'yt_test',
          source: 'youtube',
          originalId: 'test_vid',
          title: `Result for ${q}`,
          artist: 'Global Artist',
          duration: 180,
          artworkUrl: 'https://i.ytimg.com/vi/test_vid/hqdefault.jpg'
        }
      ]);
      vi.spyOn(scService, 'search').mockResolvedValue([]);

      for (const q of internationalQueries) {
        const res = await aggregator.search(q);
        expect(res.results.length).toBe(1);
        expect(res.results[0].title).toBe(`Result for ${q}`);
      }
    });
  });

  // ==========================================================================
  // STRESS SUITE 2: Concurrency & Promise De-duplication Stress Testing
  // ==========================================================================
  describe('2. Concurrency & Promise De-duplication', () => {
    const mockTrack: UnifiedTrack = {
      id: 'yt_stress_001',
      source: 'youtube',
      originalId: 'stress_001',
      title: 'Concurrency Stress Track',
      artist: 'Load Tester',
      duration: 300,
      artworkUrl: 'https://i.ytimg.com/vi/stress_001/hqdefault.jpg'
    };

    it('deduplicates 50 simultaneous identical resolve requests into exactly 1 network call', async () => {
      let networkCalls = 0;
      vi.spyOn(ytService, 'resolveStreamUrl').mockImplementation(async () => {
        networkCalls++;
        await new Promise(r => setTimeout(r, 60)); // Simulate 60ms latency
        return {
          streamUrl: 'https://googlevideo.com/videoplayback?id=stress_001',
          format: 'm4a',
          bitrate: 128,
          expiresAt: Date.now() + 3600 * 1000
        };
      });

      // Launch 50 concurrent requests
      const promises = Array.from({ length: 50 }, () => resolver.resolve(mockTrack));
      const results = await Promise.all(promises);

      expect(networkCalls).toBe(1);
      expect(results).toHaveLength(50);
      results.forEach(res => {
        expect(res.streamUrl).toBe('https://googlevideo.com/videoplayback?id=stress_001');
      });
    });

    it('deduplicates 100 concurrent requests across 5 distinct tracks into exactly 5 network calls', async () => {
      let networkCalls = 0;
      vi.spyOn(ytService, 'resolveStreamUrl').mockImplementation(async (vidId) => {
        networkCalls++;
        await new Promise(r => setTimeout(r, 40));
        return {
          streamUrl: `https://googlevideo.com/stream_${vidId}`,
          format: 'm4a',
          bitrate: 128,
          expiresAt: Date.now() + 3600 * 1000
        };
      });

      const tracks: UnifiedTrack[] = Array.from({ length: 5 }, (_, i) => ({
        id: `yt_multi_${i}`,
        source: 'youtube',
        originalId: `multi_${i}`,
        title: `Track ${i}`,
        artist: 'Artist',
        duration: 200,
        artworkUrl: ''
      }));

      // Interleave 100 requests (20 per track)
      const promises: Promise<any>[] = [];
      for (let i = 0; i < 100; i++) {
        const track = tracks[i % 5];
        promises.push(resolver.resolve(track));
      }

      const results = await Promise.all(promises);
      expect(networkCalls).toBe(5);
      expect(results).toHaveLength(100);
    });

    it('cleans up in-flight promise map when resolution fails, allowing immediate retry', async () => {
      let attempt = 0;
      vi.spyOn(ytService, 'resolveStreamUrl').mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          await new Promise(r => setTimeout(r, 20));
          throw new Error('Network Timeout (InnerTube 504)');
        }
        return {
          streamUrl: 'https://googlevideo.com/recovered',
          format: 'm4a',
          bitrate: 128,
          expiresAt: Date.now() + 3600 * 1000
        };
      });

      // 5 concurrent requests during first failure
      const failPromises = Array.from({ length: 5 }, () => resolver.resolve(mockTrack));
      await expect(Promise.all(failPromises)).rejects.toThrow('Network Timeout (InnerTube 504)');

      // In-flight map should now be clean, so next call performs retry
      const retryResult = await resolver.resolve(mockTrack);
      expect(retryResult.streamUrl).toBe('https://googlevideo.com/recovered');
      expect(attempt).toBe(2);
    });

    it('respects forceRefresh parameter to bypass cache and re-resolve', async () => {
      let callCount = 0;
      vi.spyOn(ytService, 'resolveStreamUrl').mockImplementation(async () => {
        callCount++;
        return {
          streamUrl: `https://googlevideo.com/v${callCount}`,
          format: 'm4a',
          bitrate: 128,
          expiresAt: Date.now() + 3600 * 1000
        };
      });

      const res1 = await resolver.resolve(mockTrack);
      expect(res1.streamUrl).toBe('https://googlevideo.com/v1');
      expect(res1.cached).toBe(false);

      // Cached call
      const res2 = await resolver.resolve(mockTrack);
      expect(res2.streamUrl).toBe('https://googlevideo.com/v1');
      expect(res2.cached).toBe(true);
      expect(callCount).toBe(1);

      // Force refresh
      const res3 = await resolver.resolve(mockTrack, true);
      expect(res3.streamUrl).toBe('https://googlevideo.com/v2');
      expect(res3.cached).toBe(false);
      expect(callCount).toBe(2);
    });

    it('handles prefetch errors gracefully without crashing or throwing unhandled rejections', async () => {
      vi.spyOn(ytService, 'resolveStreamUrl').mockRejectedValue(new Error('Prefetch 403 Forbidden'));

      expect(() => {
        resolver.prefetch(mockTrack);
      }).not.toThrow();

      // Wait a tick for the async catch to run
      await new Promise(r => setTimeout(r, 50));
    });
  });

  // ==========================================================================
  // STRESS SUITE 3: Fault Injection & Partial Failure Resilience
  // ==========================================================================
  describe('3. Fault Injection & Partial Failure Resilience', () => {
    const mockYtTrack: UnifiedTrack = {
      id: 'yt_res_1',
      source: 'youtube',
      originalId: 'res_1',
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      duration: 355,
      artworkUrl: 'https://i.ytimg.com/vi/res_1/hqdefault.jpg'
    };

    const mockScTrack: UnifiedTrack = {
      id: 'sc_res_2',
      source: 'soundcloud',
      originalId: 'res_2',
      title: 'Bohemian Rhapsody (Live SC)',
      artist: 'Queen Live',
      duration: 360,
      artworkUrl: 'https://i1.sndcdn.com/artworks-res_2-t500x500.jpg'
    };

    it('retains SoundCloud results and records error when YouTube network call fails with 500 error', async () => {
      vi.spyOn(ytService, 'search').mockRejectedValue(new Error('HTTP 500 Internal Server Error'));
      vi.spyOn(scService, 'search').mockResolvedValue([mockScTrack]);

      const res = await aggregator.search('Bohemian Rhapsody');

      expect(res.results).toHaveLength(1);
      expect(res.results[0].source).toBe('soundcloud');
      expect(res.sources.youtube).toBe(0);
      expect(res.sources.soundcloud).toBe(1);
      expect(res.errors?.youtube).toContain('500');
      expect(res.errors?.soundcloud).toBeUndefined();
    });

    it('retains YouTube results and records error when SoundCloud is rate limited with 429', async () => {
      vi.spyOn(ytService, 'search').mockResolvedValue([mockYtTrack]);
      vi.spyOn(scService, 'search').mockRejectedValue(new Error('HTTP 429 Too Many Requests'));

      const res = await aggregator.search('Bohemian Rhapsody');

      expect(res.results).toHaveLength(1);
      expect(res.results[0].source).toBe('youtube');
      expect(res.sources.youtube).toBe(1);
      expect(res.sources.soundcloud).toBe(0);
      expect(res.errors?.soundcloud).toContain('429');
      expect(res.errors?.youtube).toBeUndefined();
    });

    it('handles total outage (both YouTube & SoundCloud failing) gracefully without crashing', async () => {
      vi.spyOn(ytService, 'search').mockRejectedValue(new Error('YouTube Network Down'));
      vi.spyOn(scService, 'search').mockRejectedValue(new Error('SoundCloud Gateway Timeout'));

      const res = await aggregator.search('Bohemian Rhapsody');

      expect(res.results).toEqual([]);
      expect(res.sources.youtube).toBe(0);
      expect(res.sources.soundcloud).toBe(0);
      expect(res.errors?.youtube).toContain('YouTube Network Down');
      expect(res.errors?.soundcloud).toContain('SoundCloud Gateway Timeout');
    });

    it('handles asymmetric response latency between services without race conditions or loss of order', async () => {
      // YouTube responds fast (10ms), SoundCloud responds slow (80ms)
      vi.spyOn(ytService, 'search').mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 10));
        return [mockYtTrack];
      });
      vi.spyOn(scService, 'search').mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 80));
        return [mockScTrack];
      });

      const res = await aggregator.search('Bohemian Rhapsody');
      expect(res.results).toHaveLength(2);
      expect(res.results[0].source).toBe('youtube');
      expect(res.results[1].source).toBe('soundcloud');
    });

    it('перебор ключей SoundCloud обходит набор и не зацикливается', () => {
      /*
       * Раньше перебор шёл по кругу и возвращался к ключу, который только что
       * ответил отказом. Теперь отвергнутый помечается негодным и пропускается
       * — но последний живой не помечается никогда: иначе один отказ отключал
       * бы SoundCloud целиком на полчаса.
       */
      const keys = ['key_A', 'key_B', 'key_C'];
      const customSc = new SoundCloudService({ clientIds: keys });

      expect(customSc.rotateClientId()).toBe('key_B');
      expect(customSc.rotateClientId()).toBe('key_C');
      // A и B уже негодны; C остаётся в строю, а не уступает место мёртвому.
      expect(customSc.rotateClientId()).toBe('key_C');
      expect(customSc.getCachedClientId()).toBe('key_C');
    });
  });

  // ==========================================================================
  // STRESS SUITE 4: Payload Normalizer & Parser Resilience
  // ==========================================================================
  describe('4. Parser Robustness & Malformed Payload Handling', () => {
    it('InnerTube parser survives corrupt / unexpected structures without throwing', () => {
      const malformedPayloads = [
        null,
        undefined,
        {},
        { contents: null },
        { contents: { sectionListRenderer: { contents: [null, undefined, {}] } } },
        { contents: { tabbedSearchResultsRenderer: { tabs: [{}] } } },
        { contents: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: [{}] } }] } } }
      ];

      for (const payload of malformedPayloads) {
        expect(() => {
          const res = ytService.parseInnerTubeResponse(payload, 10);
          expect(Array.isArray(res)).toBe(true);
        }).not.toThrow();
      }
    });

    it('SoundCloud tracks parser survives corrupt / empty collection objects', () => {
      const malformedScPayloads = [
        null,
        undefined,
        {},
        { collection: null },
        { collection: [null, undefined, {}, { id: null }, { id: 123, title: '' }] },
        [{ id: 456, title: 'Valid Track', duration: 120000 }]
      ];

      for (const payload of malformedScPayloads) {
        expect(() => {
          const res = scService.parseTracksResponse(payload, 10);
          expect(Array.isArray(res)).toBe(true);
        }).not.toThrow();
      }
    });
  });
});
