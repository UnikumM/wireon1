import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearchAggregator } from '../../src/services/aggregator';
import { YouTubeService } from '../../src/services/youtube';
import { SoundCloudService } from '../../src/services/soundcloud';
import { StreamResolver } from '../../src/services/streamResolver';
import { UnifiedTrack } from '../../src/types/music';

describe('SearchAggregator Service', () => {
  let aggregator: SearchAggregator;
  let mockYtService: YouTubeService;
  let mockScService: SoundCloudService;
  let mockResolver: StreamResolver;

  const mockYtTracks: UnifiedTrack[] = [
    {
      id: 'yt_1',
      source: 'youtube',
      originalId: '1',
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      duration: 355,
      artworkUrl: 'https://i.ytimg.com/vi/1/hqdefault.jpg'
    },
    {
      id: 'yt_2',
      source: 'youtube',
      originalId: '2',
      title: 'Another One Bites the Dust',
      artist: 'Queen',
      duration: 215,
      artworkUrl: 'https://i.ytimg.com/vi/2/hqdefault.jpg'
    }
  ];

  const mockScTracks: UnifiedTrack[] = [
    {
      id: 'sc_1',
      source: 'soundcloud',
      originalId: '101',
      title: 'Bohemian Rhapsody (Live Remix)',
      artist: 'Queen DJ',
      duration: 240,
      artworkUrl: 'https://i1.sndcdn.com/artworks-1-t500x500.jpg'
    },
    {
      id: 'sc_2',
      source: 'soundcloud',
      originalId: '102',
      title: 'Radio Ga Ga Remix',
      artist: 'Queen DJ',
      duration: 190,
      artworkUrl: 'https://i1.sndcdn.com/artworks-2-t500x500.jpg'
    }
  ];

  beforeEach(() => {
    mockYtService = new YouTubeService();
    mockScService = new SoundCloudService();
    mockResolver = new StreamResolver();

    vi.spyOn(mockYtService, 'search').mockResolvedValue(mockYtTracks);
    vi.spyOn(mockScService, 'search').mockResolvedValue(mockScTracks);

    aggregator = new SearchAggregator(mockYtService, mockScService, mockResolver);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('performs parallel search across YouTube and SoundCloud and interleaves results', async () => {
    const res = await aggregator.search('Queen', { source: 'all' });

    expect(res.sources.youtube).toBe(2);
    expect(res.sources.soundcloud).toBe(2);
    expect(res.results.length).toBe(4);

    // Verify 1:1 interleaving (yt0, sc0, yt1, sc1)
    expect(res.results[0].source).toBe('youtube');
    expect(res.results[1].source).toBe('soundcloud');
    expect(res.results[2].source).toBe('youtube');
    expect(res.results[3].source).toBe('soundcloud');
  });

  it('filters search strictly to YouTube when specified', async () => {
    const res = await aggregator.search('Queen', { source: 'youtube' });

    expect(res.results.every(t => t.source === 'youtube')).toBe(true);
    expect(res.results.length).toBe(2);
  });

  it('filters search strictly to SoundCloud when specified', async () => {
    const res = await aggregator.search('Queen', { source: 'soundcloud' });

    expect(res.results.every(t => t.source === 'soundcloud')).toBe(true);
    expect(res.results.length).toBe(2);
  });

  it('isolates provider errors without crashing the entire search', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(mockScService, 'search').mockRejectedValue(new Error('SoundCloud 429 Rate Limit'));

    const res = await aggregator.search('Queen', { source: 'all' });

    expect(res.results.length).toBe(2);
    expect(res.results.every(t => t.source === 'youtube')).toBe(true);
    expect(res.errors).toBeDefined();
    expect(res.errors?.soundcloud).toContain('SoundCloud 429');
  });

  it('caches search results for repeated queries', async () => {
    await aggregator.search('Queen');
    await aggregator.search('Queen');

    expect(mockYtService.search).toHaveBeenCalledTimes(1);
    expect(mockScService.search).toHaveBeenCalledTimes(1);
  });

  it('handles empty query without making network requests', async () => {
    const res = await aggregator.search('');
    expect(res.results).toEqual([]);
    expect(res.sources.youtube).toBe(0);
    expect(res.sources.soundcloud).toBe(0);
    expect(mockYtService.search).not.toHaveBeenCalled();
  });

  describe('cache eviction', () => {
    it('evicts entries once their TTL has elapsed', async () => {
      await aggregator.search('Queen');
      expect(aggregator.getCacheSize()).toBe(1);
      expect(mockYtService.search).toHaveBeenCalledTimes(1);

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 61000);

      // Expired entries are dropped on access, so the provider is queried again
      expect(aggregator.getCacheSize()).toBe(0);
      await aggregator.search('Queen');
      expect(mockYtService.search).toHaveBeenCalledTimes(2);
    });

    it('enforces a hard size cap with LRU eviction', async () => {
      for (let i = 0; i < 60; i++) {
        await aggregator.search(`query-${i}`);
      }

      expect(aggregator.getCacheSize()).toBe(50);

      // The 10 oldest queries were evicted, so they hit the providers again
      const callsBefore = (mockYtService.search as any).mock.calls.length;
      await aggregator.search('query-0');
      expect((mockYtService.search as any).mock.calls.length).toBe(callsBefore + 1);

      // ...while a recent one is still cached
      const callsAfter = (mockYtService.search as any).mock.calls.length;
      await aggregator.search('query-59');
      expect((mockYtService.search as any).mock.calls.length).toBe(callsAfter);
    });

    it('keeps a re-read entry alive as the most recently used', async () => {
      await aggregator.search('sticky');
      for (let i = 0; i < 49; i++) {
        await aggregator.search(`filler-${i}`);
        // Touch 'sticky' so it never becomes the least recently used entry
        await aggregator.search('sticky');
      }

      expect(aggregator.getCacheSize()).toBe(50);
      const calls = (mockYtService.search as any).mock.calls.length;
      await aggregator.search('sticky');
      expect((mockYtService.search as any).mock.calls.length).toBe(calls);
    });

    it('clearCache() empties the cache', async () => {
      await aggregator.search('Queen');
      expect(aggregator.getCacheSize()).toBe(1);
      aggregator.clearCache();
      expect(aggregator.getCacheSize()).toBe(0);
    });
  });

  describe('getSuggestions', () => {
    it('delegates to the YouTube service', async () => {
      vi.spyOn(mockYtService, 'getSuggestions').mockResolvedValue(['queen', 'queen live']);
      await expect(aggregator.getSuggestions('que')).resolves.toEqual(['queen', 'queen live']);
    });

    it('degrades to an empty list when the provider throws', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(mockYtService, 'getSuggestions').mockRejectedValue(new Error('offline'));
      await expect(aggregator.getSuggestions('que')).resolves.toEqual([]);
    });
  });

  describe('getRelatedTracks', () => {
    const seedYt: UnifiedTrack = {
      id: 'yt_seed',
      source: 'youtube',
      originalId: 'seed',
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      duration: 355,
      artworkUrl: ''
    };

    const seedSc: UnifiedTrack = {
      id: 'sc_seed',
      source: 'soundcloud',
      originalId: '900',
      title: 'Some Remix',
      artist: 'Queen DJ',
      duration: 240,
      artworkUrl: ''
    };

    it('uses the platform recommendations for a YouTube track', async () => {
      const related: UnifiedTrack[] = [
        { ...mockYtTracks[1] },
        { ...seedYt } // the seed itself must be filtered out
      ];
      const spy = vi.spyOn(mockYtService, 'getRelatedVideos').mockResolvedValue(related);

      const res = await aggregator.getRelatedTracks(seedYt, 10);
      expect(spy).toHaveBeenCalledWith('seed', 20);
      expect(res.map(t => t.id)).toEqual(['yt_2']);
    });

    it('uses the platform recommendations for a SoundCloud track', async () => {
      const spy = vi.spyOn(mockScService, 'getRelatedTracks').mockResolvedValue([mockScTracks[1]]);

      const res = await aggregator.getRelatedTracks(seedSc, 1);
      expect(spy).toHaveBeenCalledWith('900', 2);
      expect(res.map(t => t.id)).toEqual(['sc_2']);
    });

    it('tops the radio up with an artist search when recommendations are short', async () => {
      vi.spyOn(mockScService, 'getRelatedTracks').mockResolvedValue([mockScTracks[1]]);

      const res = await aggregator.getRelatedTracks(seedSc, 10);
      // Platform recommendation first, then same-source search results
      expect(res[0].id).toBe('sc_2');
      expect(res.map(t => t.id)).toContain('sc_1');
      expect(res.every(t => t.id !== 'sc_seed')).toBe(true);
    });

    it('falls back to an artist search when recommendations come back empty', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(mockYtService, 'getRelatedVideos').mockResolvedValue([]);

      const res = await aggregator.getRelatedTracks(seedYt, 10);
      expect(mockYtService.search).toHaveBeenCalledWith('Queen', 20);
      // 'Bohemian Rhapsody' by 'Queen' is the seed and is deduped away
      expect(res.map(t => t.id)).toEqual(['yt_2']);
    });

    it('respects the limit and removes duplicates', async () => {
      const duplicated: UnifiedTrack[] = [
        { ...mockYtTracks[1] },
        { ...mockYtTracks[1], id: 'yt_2_copy' },
        { ...mockYtTracks[0], id: 'yt_other', title: 'Radio Ga Ga', artist: 'Queen' }
      ];
      vi.spyOn(mockYtService, 'getRelatedVideos').mockResolvedValue(duplicated);

      const res = await aggregator.getRelatedTracks(seedYt, 1);
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe('yt_2');
    });

    it('returns an empty array instead of throwing when the network fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(mockYtService, 'getRelatedVideos').mockRejectedValue(new Error('offline'));
      vi.spyOn(mockYtService, 'search').mockRejectedValue(new Error('offline'));
      vi.spyOn(mockScService, 'search').mockRejectedValue(new Error('offline'));

      await expect(aggregator.getRelatedTracks(seedYt, 10)).resolves.toEqual([]);
    });

    it('returns an empty array for an invalid track', async () => {
      await expect(aggregator.getRelatedTracks(null as any)).resolves.toEqual([]);
      await expect(aggregator.getRelatedTracks({ id: 'x' } as any)).resolves.toEqual([]);
    });
  });

  describe('getRelatedTracks radio quality filter', () => {
    const seedYt: UnifiedTrack = {
      id: 'yt_seed',
      source: 'youtube',
      originalId: 'seed',
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      duration: 355,
      artworkUrl: ''
    };

    /** Keeps the filter isolated: no artist-search top-up to muddy assertions. */
    function isolateFilter() {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(mockYtService, 'search').mockResolvedValue([]);
      vi.spyOn(mockScService, 'search').mockResolvedValue([]);
    }

    function candidate(id: string, title: string, duration: number): UnifiedTrack {
      return {
        id,
        source: 'youtube',
        originalId: id,
        title,
        artist: 'Somebody',
        duration,
        artworkUrl: ''
      };
    }

    /** Three in-band tracks, so the relax-and-top-up path stays dormant. */
    const inBandTrio = [
      candidate('yt_a', 'Song A', 200),
      candidate('yt_b', 'Song B', 30),
      candidate('yt_c', 'Song C', 900)
    ];

    it('keeps tracks inside the 30s-15min band, including the boundaries', async () => {
      isolateFilter();
      vi.spyOn(mockYtService, 'getRelatedVideos').mockResolvedValue([
        ...inBandTrio,
        candidate('yt_short', 'Too Short', 29),
        candidate('yt_long', 'Too Long', 901)
      ]);

      const res = await aggregator.getRelatedTracks(seedYt, 10);
      expect(res.map(t => t.id)).toEqual(['yt_a', 'yt_b', 'yt_c']);
    });

    it('drops a 40-minute upload', async () => {
      isolateFilter();
      vi.spyOn(mockYtService, 'getRelatedVideos').mockResolvedValue([
        ...inBandTrio,
        candidate('yt_pod', 'Some Long Talk', 2400)
      ]);

      const res = await aggregator.getRelatedTracks(seedYt, 10);
      expect(res.map(t => t.id)).not.toContain('yt_pod');
      expect(res).toHaveLength(3);
    });

    it('keeps tracks with an unknown duration rather than assuming the worst', async () => {
      isolateFilter();
      vi.spyOn(mockYtService, 'getRelatedVideos').mockResolvedValue([
        candidate('yt_zero', 'Unknown Length', 0),
        candidate('yt_nan', 'Also Unknown', NaN),
        candidate('yt_inf', 'Broken Metadata', Infinity)
      ]);

      const res = await aggregator.getRelatedTracks(seedYt, 10);
      expect(res.map(t => t.id)).toEqual(['yt_zero', 'yt_nan', 'yt_inf']);
    });

    it('keeps a remix but drops a DJ set that sneaks under the duration cap', async () => {
      isolateFilter();
      vi.spyOn(mockYtService, 'getRelatedVideos').mockResolvedValue([
        candidate('yt_remix', 'Artist - Song (Club Remix)', 200),
        candidate('yt_remixes', 'Artist - Song (Remixes)', 240),
        candidate('yt_vip', 'Artist - Song (VIP Mix)', 260),
        candidate('yt_djset', 'Best of 2026 | DJ Set', 400),
        candidate('yt_pod', 'The Music Show Podcast', 500),
        candidate('yt_ep', 'The Music Show Ep. 12', 500),
        candidate('yt_album', 'Artist - Greatest Hits (Full Album)', 600),
        candidate('yt_nonstop', 'Non-Stop Party Hits', 700),
        candidate('yt_hours', '2 Hours of Chill', 800)
      ]);

      const res = await aggregator.getRelatedTracks(seedYt, 10);
      expect(res.map(t => t.id)).toEqual(['yt_remix', 'yt_remixes', 'yt_vip']);
    });

    it('relaxes the band rather than returning nothing, but never queues a multi-hour stream', async () => {
      isolateFilter();
      vi.spyOn(mockYtService, 'getRelatedVideos').mockResolvedValue([
        candidate('yt_jam', 'Extended Jam', 1200),
        candidate('yt_3h', 'Chill Mix', 13347),
        candidate('yt_skit', 'Skit', 20)
      ]);

      const res = await aggregator.getRelatedTracks(seedYt, 2);
      expect(res.map(t => t.id)).toEqual(['yt_jam', 'yt_skit']);
    });

    it('still returns an empty array when the upstream result is genuinely empty', async () => {
      isolateFilter();
      vi.spyOn(mockYtService, 'getRelatedVideos').mockResolvedValue([]);

      await expect(aggregator.getRelatedTracks(seedYt, 10)).resolves.toEqual([]);
    });
  });

  it('resolveStream delegates to the stream resolver', async () => {
    vi.spyOn(mockResolver, 'resolve').mockResolvedValue({
      streamUrl: 'https://cdn.test/stream.mp3',
      format: 'mp3',
      bitrate: 128,
      expiresAt: Date.now() + 3600 * 1000,
      cached: false
    });

    await expect(aggregator.resolveStream(mockYtTracks[0])).resolves.toBe('https://cdn.test/stream.mp3');
  });
});
