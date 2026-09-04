import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../setup';
import {
  fetchLyrics,
  searchLyrics,
  cleanTrackTitle,
  cleanArtistName,
  getLyricsCacheKey,
  formatLrclibResponse,
  clearLyricsCache,
  clearStoredLyrics,
  getCachedLyrics
} from '../../src/services/lyricsService';
import { UnifiedTrack } from '../../src/types/music';

describe('lyricsService', () => {
  // Найденный текст теперь переживает перезапуск, поэтому между тестами нужно
  // чистить и IndexedDB — иначе один тест отвечал бы за следующий.
  beforeEach(async () => {
    clearLyricsCache();
    await clearStoredLyrics();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('cleanTrackTitle', () => {
    it('removes video and bracket tags from title', () => {
      expect(cleanTrackTitle('Starboy (Official Music Video)')).toBe('Starboy');
      expect(cleanTrackTitle('Blinding Lights [Official Audio]')).toBe('Blinding Lights');
      expect(cleanTrackTitle('Believer (Lyric Video)')).toBe('Believer');
      expect(cleanTrackTitle('Radioactive [HD / 4K]')).toBe('Radioactive');
      expect(cleanTrackTitle('Bohemian Rhapsody (Remastered 2011)')).toBe('Bohemian Rhapsody');
      expect(cleanTrackTitle('Numb (Official Video)')).toBe('Numb');
    });

    it('removes artist prefix when formatted as "Artist - Title"', () => {
      expect(cleanTrackTitle('The Weeknd - Blinding Lights (Official Video)')).toBe('Blinding Lights');
      expect(cleanTrackTitle('Queen - Bohemian Rhapsody')).toBe('Bohemian Rhapsody');
    });

    it('removes featuring tags for cleaner search', () => {
      expect(cleanTrackTitle('Cold Heart (feat. Dua Lipa)')).toBe('Cold Heart');
      expect(cleanTrackTitle('Industry Baby feat. Jack Harlow')).toBe('Industry Baby');
      expect(cleanTrackTitle('Levitating (ft. DaBaby)')).toBe('Levitating');
    });

    it('cleans quotes and duplicate whitespace', () => {
      expect(cleanTrackTitle(' "Hello"   (Official Video) ')).toBe('Hello');
    });
  });

  describe('cleanArtistName', () => {
    it('removes " - Topic" and "VEVO" suffixes', () => {
      expect(cleanArtistName('Queen - Topic')).toBe('Queen');
      expect(cleanArtistName('TaylorSwiftVEVO')).toBe('TaylorSwift');
      expect(cleanArtistName('  Daft Punk  ')).toBe('Daft Punk');
    });
  });

  describe('getLyricsCacheKey', () => {
    it('generates a normalized lowercase cache key', () => {
      const key = getLyricsCacheKey({
        title: 'Starboy (Official Video)',
        artist: 'The Weeknd - Topic'
      });
      expect(key).toBe('the weeknd:::starboy');
    });
  });

  describe('formatLrclibResponse', () => {
    it('converts syncedLyrics response to LyricsResult', () => {
      const mockApiRes = {
        id: 12345,
        trackName: 'Bohemian Rhapsody',
        artistName: 'Queen',
        albumName: 'A Night at the Opera',
        duration: 355,
        syncedLyrics: '[00:01.00]Is this the real life?\n[00:04.00]Is this fantasy?',
        plainLyrics: 'Is this the real life?\nIs this fantasy?'
      };

      const result = formatLrclibResponse(mockApiRes);
      expect(result.synced).toBe(true);
      expect(result.id).toBe(12345);
      expect(result.trackName).toBe('Bohemian Rhapsody');
      expect(result.artistName).toBe('Queen');
      expect(result.lines).toHaveLength(2);
      expect(result.lines[0]).toEqual({ time: 1.0, text: 'Is this the real life?' });
      expect(result.lines[1]).toEqual({ time: 4.0, text: 'Is this fantasy?' });
      expect(result.rawLrc).toBe(mockApiRes.syncedLyrics);
    });

    it('falls back to plainLyrics when syncedLyrics is not available', () => {
      const mockApiRes = {
        id: 67890,
        trackName: 'Plain Song',
        artistName: 'Indie Band',
        plainLyrics: 'Line 1\nLine 2\nLine 3'
      };

      const result = formatLrclibResponse(mockApiRes);
      expect(result.synced).toBe(false);
      expect(result.lines).toHaveLength(3);
      expect(result.plainLyrics).toBe('Line 1\nLine 2\nLine 3');
      expect(result.lines[0].text).toBe('Line 1');
    });

    it('handles instrumental tracks', () => {
      const mockApiRes = {
        id: 99999,
        trackName: 'Interlude (Instrumental)',
        artistName: 'Composer',
        instrumental: true
      };

      const result = formatLrclibResponse(mockApiRes);
      expect(result.synced).toBe(false);
      expect(result.instrumental).toBe(true);
      expect(result.lines).toEqual([]);
    });
  });

  describe('fetchLyrics', () => {
    const sampleTrack: UnifiedTrack = {
      id: 'yt_sample123',
      source: 'youtube',
      originalId: 'sample123',
      title: 'Bohemian Rhapsody (Official Video)',
      artist: 'Queen - Topic',
      album: 'A Night at the Opera',
      duration: 355,
      artworkUrl: 'https://example.com/cover.jpg'
    };

    it('fetches synced lyrics via /api/get exact match', async () => {
      const mockLrclibData = {
        id: 101,
        trackName: 'Bohemian Rhapsody',
        artistName: 'Queen',
        duration: 355,
        syncedLyrics: '[00:02.00]Mama, just killed a man\n[00:08.00]Put a gun against his head',
        plainLyrics: 'Mama, just killed a man\nPut a gun against his head'
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockLrclibData
      } as Response);

      const result = await fetchLyrics(sampleTrack);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const requestedUrl = fetchSpy.mock.calls[0][0] as string;
      expect(requestedUrl).toContain('https://lrclib.net/api/get?');
      expect(requestedUrl).toContain('track_name=Bohemian+Rhapsody');
      expect(requestedUrl).toContain('artist_name=Queen');

      expect(result).not.toBeNull();
      expect(result?.synced).toBe(true);
      expect(result?.lines).toHaveLength(2);
      expect(result?.lines[0]).toEqual({ time: 2.0, text: 'Mama, just killed a man' });
    });

    it('falls back to /api/search when /api/get returns 404', async () => {
      const mockSearchResults = [
        {
          id: 201,
          trackName: 'Bohemian Rhapsody',
          artistName: 'Queen',
          duration: 355,
          syncedLyrics: '[00:03.00]Open your eyes\n[00:06.00]Look up to the skies and see',
          plainLyrics: 'Open your eyes\nLook up to the skies and see'
        }
      ];

      // Мок по адресу, а не по порядку вызовов: точных запросов теперь несколько,
      // и их число — деталь реализации, а не обещание сервиса.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const href = String(url);
        if (href.includes('/api/get')) {
          return { ok: false, status: 404, json: async () => ({}) } as Response;
        }
        return { ok: true, status: 200, json: async () => mockSearchResults } as Response;
      });

      const result = await fetchLyrics(sampleTrack);

      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/get'))).toBe(true);
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/search'))).toBe(true);
      expect(result).not.toBeNull();
      expect(result?.synced).toBe(true);
      expect(result?.lines[0].text).toBe('Open your eyes');
    });

    it('caches results in memory and deduplicates identical requests', async () => {
      const mockLrclibData = {
        id: 301,
        trackName: 'Bohemian Rhapsody',
        artistName: 'Queen',
        duration: 355,
        syncedLyrics: '[00:01.00]Test lyrics'
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockLrclibData
      } as Response);

      // First call
      const res1 = await fetchLyrics(sampleTrack);
      // Second call (should hit in-memory cache)
      const res2 = await fetchLyrics(sampleTrack);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(res1).toEqual(res2);

      // getCachedLyrics should return the cached item
      expect(getCachedLyrics(sampleTrack)).toEqual(res1);

      // Память очистили — но найденный текст сохранён на диске, и это главное:
      // после перезапуска приложения в сеть идти не нужно.
      clearLyricsCache();
      expect(getCachedLyrics(sampleTrack)).toBeUndefined();

      const fromDisk = await fetchLyrics(sampleTrack);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fromDisk?.lines[0].text).toBe('Test lyrics');

      // И только полная очистка возвращает сервис в сеть.
      await clearStoredLyrics();
      await fetchLyrics(sampleTrack);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('deduplicates simultaneous in-flight requests', async () => {
      let resolvePromise: (val: any) => void;
      const deferred = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return deferred as any;
      });

      // Fire 2 concurrent requests
      const p1 = fetchLyrics(sampleTrack);
      const p2 = fetchLyrics(sampleTrack);

      // Resolve the single network call
      resolvePromise!({
        ok: true,
        json: async () => ({
          id: 401,
          trackName: 'Bohemian Rhapsody',
          artistName: 'Queen',
          duration: 355,
          syncedLyrics: '[00:01.00]Concurrent line'
        })
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(r2);
      expect(r1?.lines[0].text).toBe('Concurrent line');
    });

    it('returns null gracefully on network errors or 404 with no results', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network offline'));

      const result = await fetchLyrics(sampleTrack);
      expect(result).toBeNull();
    });

    it('returns null for empty track object', async () => {
      const result = await fetchLyrics({ title: '', artist: '' });
      expect(result).toBeNull();
    });
  });

  describe('searchLyrics', () => {
    it('searches lyrics by query string and formats results', async () => {
      const mockList = [
        {
          id: 501,
          trackName: 'Song A',
          artistName: 'Artist A',
          syncedLyrics: '[00:01.00]A lyrics'
        },
        {
          id: 502,
          trackName: 'Song B',
          artistName: 'Artist B',
          plainLyrics: 'B plain lyrics'
        }
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockList
      } as Response);

      const results = await searchLyrics('Queen Bohemian');
      expect(results).toHaveLength(2);
      expect(results[0].synced).toBe(true);
      expect(results[1].synced).toBe(false);
    });

    it('returns empty array for empty search query', async () => {
      const results = await searchLyrics('');
      expect(results).toEqual([]);
    });
  });
});
