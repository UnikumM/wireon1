/**
 * Tier 2 — Boundaries.
 *
 * The inputs that break naive code: dead mirrors, HTML where JSON was promised,
 * expired client ids, `Infinity` durations, HLS-only streams in an environment
 * without MSE, 5 000-character queries, RTL and zero-width titles, 500-track
 * playlists, and corrupt backup files.
 *
 * Everything here runs against the real modules. `hls.js` is the one exception:
 * jsdom has no Media Source Extensions, so the `services/hls` boundary is
 * replaced by a switchable stub while `isHlsUrl` keeps its real implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { SearchAggregator, searchAggregator } from '../../src/services/aggregator';
import { YouTubeService, ALL_BACKENDS_UNAVAILABLE_MESSAGE } from '../../src/services/youtube';
import { SoundCloudService } from '../../src/services/soundcloud';
import { StreamResolver, streamResolver } from '../../src/services/streamResolver';
import { importLibrary, BackupError, BACKUP_VERSION } from '../../src/services/backup';
import * as dbService from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

import {
  installFetchMock,
  jsonResponse,
  htmlResponse,
  httpErrorResponse,
  unreachable,
  resetPlayerStore,
  resetLibraryStore,
  resetUIStore,
  flushAsync,
  signInForTests
} from '../helpers/testUtils';
import {
  healthySourceRoutes,
  youtubeTotalOutageRoutes,
  youtubeEmptySearchPayload,
  youtubeVideoOnlyPlayerPayload,
  youtubeCipheredPlayerPayload,
  soundcloudSearchPayload,
  soundcloudTrackPayload,
  soundcloudTranscoding
} from '../helpers/networkFixtures';
import { AWKWARD_TITLES, HUGE_QUERY, createMockTrackList } from '../helpers/mockData';

/** Switchable HLS capability, read by the mocked `services/hls` boundary. */
const hlsState = vi.hoisted(() => ({ supported: true, attached: [] as string[] }));

// The factory must not import anything that (transitively) imports `services/hls`
// — audioEngine does, and awaiting it here deadlocks module resolution. So the
// handle is built inline instead of borrowing `createStubHlsHandle`.
vi.mock('../../src/services/hls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/hls')>();
  return {
    ...actual,
    isHlsSupported: async () => hlsState.supported,
    isHlsJsSupported: async () => hlsState.supported,
    attachHls: async (_audio: HTMLMediaElement, url: string) => {
      if (!hlsState.supported) {
        throw new Error('HLS playback unavailable: hls.js could not be loaded');
      }
      hlsState.attached.push(url);
      return { url, usingNative: false, destroy: () => {} };
    }
  };
});

const player = () => usePlayerStore.getState();
const library = () => useLibraryStore.getState();

/** A fresh service graph: the singletons remember which mirrors are dead. */
function isolatedAggregator(): SearchAggregator {
  return new SearchAggregator(new YouTubeService(), new SoundCloudService(), new StreamResolver());
}

describe('Tier 2 — Boundaries', () => {
  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    hlsState.supported = true;
    hlsState.attached = [];

    resetPlayerStore();
    resetLibraryStore();
    signInForTests();
    resetUIStore();
    searchAggregator.clearCache();
    streamResolver.clearCache();
    await dbService.clearAllData();
  });

  afterEach(async () => {
    player().setSleepTimer(null);
    await flushAsync();
    vi.unstubAllGlobals();
    if (!dbService.db.isOpen()) await dbService.db.open();
    await dbService.clearAllData();
  });

  // -------------------------------------------------------------------------
  // Search input boundaries
  // -------------------------------------------------------------------------

  it('answers an empty or whitespace query without touching the network', async () => {
    const { calls } = installFetchMock(healthySourceRoutes());

    for (const query of ['', '   ', '\n\t']) {
      const res = await searchAggregator.search(query);
      expect(res.results).toEqual([]);
      expect(res.sources).toEqual({ youtube: 0, soundcloud: 0 });
    }
    expect(calls).toHaveLength(0);
  });

  it('sends a 5 000-character query as a single encoded request', async () => {
    const { calls } = installFetchMock(healthySourceRoutes());

    const res = await searchAggregator.search(HUGE_QUERY, { source: 'soundcloud', limit: 5 });

    expect(res.results.length).toBeGreaterThan(0);
    const searchCall = calls.find((url) => url.includes('api-v2.soundcloud.com/search/tracks'))!;
    expect(searchCall).toBeDefined();
    // Encoded, not truncated and not injected into another parameter.
    expect(searchCall).toContain(`q=${'a'.repeat(5000)}`);
    expect(searchCall.split('q=')[1].split('&')[0]).toHaveLength(5000);
  });

  it('preserves emoji, CJK, RTL, combining and zero-width titles end to end', async () => {
    const titles = [
      AWKWARD_TITLES.emoji,
      AWKWARD_TITLES.cjk,
      AWKWARD_TITLES.rtl,
      AWKWARD_TITLES.combining,
      AWKWARD_TITLES.zeroWidth,
      AWKWARD_TITLES.veryLong
    ];
    installFetchMock(
      healthySourceRoutes({
        soundcloud: titles.map((title, i) => ({ id: 900 + i, title, username: 'Unicode Test' }))
      })
    );

    const res = await searchAggregator.search('unicode', { source: 'soundcloud', limit: 10 });

    expect(res.results).toHaveLength(titles.length);
    // Titles are trimmed but never mangled, and every one still has an id.
    res.results.forEach((track, i) => {
      expect(track.title).toBe(titles[i].trim());
      expect(track.id).toBe(`sc_${900 + i}`);
    });

    // The very long title survives a round trip through the library too.
    const longTrack = res.results[titles.indexOf(AWKWARD_TITLES.veryLong)];
    expect(await library().toggleFavorite(longTrack)).toBe(true);
    const stored = await dbService.getFavorites();
    expect(stored[0].title).toBe(AWKWARD_TITLES.veryLong.trim());
  });

  // -------------------------------------------------------------------------
  // Upstream failure boundaries
  // -------------------------------------------------------------------------

  it('distinguishes "no results" from "no backend answered"', async () => {
    // Every backend answers 200 with an empty payload: a real empty result.
    installFetchMock([
      { match: 'music.youtube.com/youtubei/v1/search', respond: () => jsonResponse(youtubeEmptySearchPayload()) },
      { match: '/search?q=', respond: () => jsonResponse({ items: [] }) },
      { match: '/api/v1/search', respond: () => jsonResponse([]) }
    ]);
    await expect(new YouTubeService().search('nothing matches this')).resolves.toEqual([]);

    // Nobody answers at all: that is an outage, and it must be reported as one.
    installFetchMock(youtubeTotalOutageRoutes());
    await expect(new YouTubeService().search('anything')).rejects.toThrow(ALL_BACKENDS_UNAVAILABLE_MESSAGE);
  });

  it('isolates a total YouTube outage so SoundCloud results still arrive', async () => {
    installFetchMock([
      ...youtubeTotalOutageRoutes(),
      { match: 'api-v2.soundcloud.com/search/tracks', respond: () => jsonResponse(soundcloudSearchPayload([{ id: 71, title: 'Survivor' }])) }
    ]);

    const res = await isolatedAggregator().search('half broken', { source: 'all', limit: 10 });

    expect(res.sources.youtube).toBe(0);
    expect(res.sources.soundcloud).toBe(1);
    expect(res.results.map((t) => t.source)).toEqual(['soundcloud']);
    expect(res.errors?.youtube).toContain(ALL_BACKENDS_UNAVAILABLE_MESSAGE);
  });

  it('rejects a mirror that serves an HTML landing page instead of JSON', async () => {
    installFetchMock([
      { match: 'music.youtube.com/youtubei/v1/search', respond: () => htmlResponse() },
      { match: '/search?q=', respond: () => htmlResponse() },
      { match: '/api/v1/search', respond: () => htmlResponse() }
    ]);

    // A captive portal answers 200 with HTML for every request. It parses as
    // neither InnerTube nor Piped nor Invidious, so no half-parsed track escapes
    // — and because nothing well-formed came back, this is reported as an outage
    // rather than as a query with no matches.
    await expect(new YouTubeService().search('captive portal')).rejects.toThrow(
      ALL_BACKENDS_UNAVAILABLE_MESSAGE
    );
  });

  it('rotates an expired SoundCloud client_id and retries the search', async () => {
    let attempts = 0;
    const { calls } = installFetchMock([
      {
        match: 'api-v2.soundcloud.com/search/tracks',
        respond: () => {
          attempts += 1;
          if (attempts === 1) return httpErrorResponse(401, 'expired client_id');
          return jsonResponse(soundcloudSearchPayload([{ id: 42, title: 'After Rotation' }]));
        }
      }
    ]);

    const tracks = await new SoundCloudService().search('rotate me', 5);

    expect(attempts).toBe(2);
    expect(tracks.map((t) => t.title)).toEqual(['After Rotation']);
    // The retry used a different client_id, not the rejected one.
    const usedIds = calls.map((url) => new URL(url).searchParams.get('client_id'));
    expect(new Set(usedIds).size).toBe(2);
  });

  it('returns an empty list rather than throwing when SoundCloud is entirely down', async () => {
    installFetchMock([
      { match: 'api-v2.soundcloud.com', respond: () => httpErrorResponse(503, 'maintenance') },
      { match: 'soundcloud.com', respond: unreachable('DNS failure') }
    ]);

    await expect(new SoundCloudService().search('down', 5)).resolves.toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Stream resolution boundaries
  // -------------------------------------------------------------------------

  it('refuses a player response with no directly playable audio format', async () => {
    const videoOnly: UnifiedTrack = {
      id: 'yt_videoonly',
      source: 'youtube',
      originalId: 'videoonly',
      title: 'Video Only',
      artist: 'Test',
      duration: 100,
      artworkUrl: ''
    };

    installFetchMock([
      { match: 'www.youtube.com/youtubei/v1/player', respond: () => jsonResponse(youtubeVideoOnlyPlayerPayload()) }
    ]);
    await expect(new StreamResolver().resolve(videoOnly)).rejects.toThrow(/Unable to resolve audio stream/i);

    // Signature-ciphered formats have no plain `url` either.
    installFetchMock([
      { match: 'www.youtube.com/youtubei/v1/player', respond: () => jsonResponse(youtubeCipheredPlayerPayload()) }
    ]);
    await expect(new StreamResolver().resolve(videoOnly)).rejects.toThrow(/Unable to resolve audio stream/i);
  });

  it('rejects an unknown source instead of guessing a resolver', async () => {
    installFetchMock(healthySourceRoutes());
    const alien = { id: 'xx_1', source: 'bandcamp', originalId: '1', title: 'X', artist: 'Y', duration: 10 } as unknown as UnifiedTrack;

    await expect(new StreamResolver().resolve(alien)).rejects.toThrow(/Unsupported audio source/i);
  });

  it('plays an HLS-only SoundCloud track when hls.js is available', async () => {
    installFetchMock(healthySourceRoutes({ soundcloudProtocol: 'hls', soundcloudStreamUrl: 'https://cf-hls-media.sndcdn.com/playlist/1.m3u8?Policy=abc' }));
    hlsState.supported = true;

    const res = await searchAggregator.search('hls', { source: 'soundcloud', limit: 1 });
    const track = res.results[0];

    await player().playTrack(track, res.results, 0);

    expect(player().playbackState).toBe('playing');
    expect(player().error).toBeNull();
    expect(hlsState.attached).toHaveLength(1);
    expect(hlsState.attached[0]).toContain('.m3u8');
  });

  it('refuses an HLS-only track when the environment cannot play HLS', async () => {
    installFetchMock(healthySourceRoutes({ soundcloudProtocol: 'hls' }));
    hlsState.supported = false;

    const res = await searchAggregator.search('hls', { source: 'soundcloud', limit: 1 });
    const track = res.results[0];

    await player().playTrack(track, res.results, 0);

    // A refusal up front beats handing an unplayable URL to <audio>.
    expect(player().playbackState).toBe('error');
    expect(player().isPlaying).toBe(false);
    expect(player().error).toMatch(/HLS/i);
    expect(player().errorCanRetry).toBe(false);
    expect(hlsState.attached).toHaveLength(0);
  });

  it('treats a progressive transcoding that resolves to a manifest as HLS', async () => {
    // SoundCloud sometimes labels a transcoding progressive and then hands back
    // an .m3u8 anyway. Without HLS support that must fail loudly.
    installFetchMock([
      { match: /api-v2\.soundcloud\.com\/media\//, respond: () => jsonResponse({ url: 'https://cf-hls-media.sndcdn.com/playlist/2.m3u8' }) },
      {
        match: /api-v2\.soundcloud\.com\/tracks\/[^/?]+/,
        respond: () => jsonResponse(soundcloudTrackPayload('808', [soundcloudTranscoding('808', { protocol: 'progressive' })]))
      }
    ]);
    hlsState.supported = false;

    const track: UnifiedTrack = { id: 'sc_808', source: 'soundcloud', originalId: '808', title: 'Mislabelled', artist: 'SC', duration: 200, artworkUrl: '' };
    await expect(new StreamResolver().resolve(track)).rejects.toThrow(/HLS/i);
  });

  // -------------------------------------------------------------------------
  // Duration & seek boundaries
  // -------------------------------------------------------------------------

  it('never lets a non-finite duration reach the store', async () => {
    installFetchMock(healthySourceRoutes());
    const live: UnifiedTrack = {
      id: 'yt_live',
      source: 'youtube',
      originalId: 'live',
      title: 'Endless Radio',
      artist: 'Stream',
      duration: Number.POSITIVE_INFINITY,
      artworkUrl: '',
      streamUrl: 'https://example.com/live.mp3'
    };

    await player().playTrack(live, [live], 0);

    expect(player().duration).toBe(0);
    expect(Number.isFinite(player().duration)).toBe(true);
  });

  it('clamps seeks and ignores non-numeric ones', async () => {
    installFetchMock(healthySourceRoutes());
    const track: UnifiedTrack = {
      id: 'yt_seek',
      source: 'youtube',
      originalId: 'seek',
      title: 'Seekable',
      artist: 'Test',
      duration: 120,
      artworkUrl: '',
      streamUrl: 'https://example.com/seek.mp3'
    };
    await player().playTrack(track, [track], 0);
    expect(player().duration).toBe(120);

    player().seekTo(-50);
    expect(player().currentTime).toBe(0);

    player().seekTo(999);
    expect(player().currentTime).toBe(120);

    player().seekTo(Number.NaN);
    expect(player().currentTime).toBe(120); // unchanged

    player().seekTo(Number.POSITIVE_INFINITY);
    expect(player().currentTime).toBe(120);
  });

  it('ignores non-finite volumes and clamps the rest', () => {
    player().setVolume(2.5);
    expect(player().volume).toBe(1);

    player().setVolume(-1);
    expect(player().volume).toBe(0);

    player().setVolume(Number.NaN);
    expect(player().volume).toBe(0); // NaN is not a volume; the last value stands
  });

  // -------------------------------------------------------------------------
  // Queue & playlist boundaries
  // -------------------------------------------------------------------------

  it('handles a 500-track playlist and rejects out-of-range mutations', async () => {
    const tracks = createMockTrackList(500, 'big');
    const playlist = await library().createPlaylist('Five Hundred');
    expect(playlist).not.toBeNull();

    for (const track of tracks.slice(0, 500)) {
      await library().addTrackToPlaylist(playlist!.id, track);
    }
    expect(library().playlists[0].tracks).toHaveLength(500);

    // Out-of-range indices are refused, not silently clamped into a mutation.
    expect(await library().removeTrackFromPlaylist(playlist!.id, 500)).toBe(false);
    expect(await library().removeTrackFromPlaylist(playlist!.id, -1)).toBe(false);
    expect(await library().reorderPlaylistTracks(playlist!.id, 0, 500)).toBe(false);
    expect(library().playlists[0].tracks).toHaveLength(500);

    // A legal reorder across the whole span still works.
    expect(await library().reorderPlaylistTracks(playlist!.id, 0, 499)).toBe(true);
    expect(library().playlists[0].tracks[499].id).toBe(tracks[0].id);
  }, 15000);

  it('removes only the addressed occurrence when a playlist holds duplicates', async () => {
    const [a, b] = createMockTrackList(2, 'dup');
    const playlist = await library().createPlaylist('Duplicates');

    await library().addTrackToPlaylist(playlist!.id, a);
    await library().addTrackToPlaylist(playlist!.id, b);
    await library().addTrackToPlaylist(playlist!.id, a);

    const before = library().playlists[0].tracks.map((t) => t.id);
    // A playlist is an ordered list, so the same track may legitimately repeat.
    expect(before).toEqual([a.id, b.id, a.id]);

    expect(await library().removeTrackFromPlaylist(playlist!.id, 0)).toBe(true);
    expect(library().playlists[0].tracks.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it('keeps the playing track addressable when the source queue shrinks under it', async () => {
    installFetchMock(healthySourceRoutes());
    const tracks = createMockTrackList(4, 'shrink').map((t) => ({ ...t, streamUrl: 'https://example.com/s.mp3' }));

    await player().playTrack(tracks[2], tracks, 2);
    expect(player().currentIndex).toBe(2);

    // The user deletes the tracks around the one that is playing.
    player().syncSourceQueue([tracks[2]]);
    expect(player().currentIndex).toBe(0);
    expect(player().sourceQueue).toHaveLength(1);

    // And now deletes the playing track itself: the index must stay in range.
    player().syncSourceQueue([tracks[3]]);
    expect(player().currentIndex).toBe(0);

    // Emptying the queue leaves no index pointing at nothing.
    player().syncSourceQueue([]);
    expect(player().sourceQueue).toEqual([]);
    expect(player().currentIndex).toBe(-1);
  });

  it('stops at the end of the queue with repeat off', async () => {
    installFetchMock(healthySourceRoutes());
    const tracks = createMockTrackList(2, 'end').map((t) => ({ ...t, streamUrl: 'https://example.com/s.mp3' }));

    await player().playTrack(tracks[1], tracks, 1);
    await player().nextTrack(false);

    // Nothing after the last track and no radio: playback stops where it is.
    expect(player().currentTrack?.id).toBe(tracks[1].id);
    expect(player().isPlaying).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Backup boundaries
  // -------------------------------------------------------------------------

  it('rejects corrupt backup files with a typed code and changes nothing', async () => {
    const cases: Array<[string, string]> = [
      ['not json at all', 'INVALID_JSON'],
      ['[]', 'NOT_A_BACKUP'],
      [JSON.stringify({ favorites: [], playlists: [] }), 'NOT_A_BACKUP'],
      [JSON.stringify({ version: BACKUP_VERSION + 99, exportedAt: Date.now(), favorites: [], playlists: [], history: [] }), 'UNSUPPORTED_VERSION'],
      [JSON.stringify({ version: BACKUP_VERSION, exportedAt: Date.now(), favorites: [{ nope: true }], playlists: [], history: [] }), 'INVALID_RECORD']
    ];

    for (const [json, code] of cases) {
      await expect(importLibrary(json, 'merge')).rejects.toBeInstanceOf(BackupError);
      const error = await importLibrary(json, 'merge').catch((err: BackupError) => err);
      expect((error as BackupError).code).toBe(code);
    }

    // Nothing was written by any of the failed attempts.
    expect(await dbService.getFavorites()).toHaveLength(0);
    expect(await dbService.getPlaylists()).toHaveLength(0);
  });
});
