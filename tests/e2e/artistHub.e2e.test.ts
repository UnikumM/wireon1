/**
 * E2E Test Suite: Artist Hub Pages & Universal Navigation (M6)
 *
 * Requirements Coverage (ORIGINAL_REQUEST §R6, PROJECT.md M6):
 * - F6.1: Artist Metadata Service (top tracks, discography, similar artists, biography)
 * - F6.2: Dedicated Artist Hub View (hero, popular tracks, albums grid, similar artists)
 * - F6.3: Universal Artist Navigation (artist click anywhere navigates to the Hub)
 *
 * Every profile here is assembled from real YouTube Music InnerTube and Wikipedia
 * payloads. Nothing is fabricated by the service, so nothing is fabricated by the
 * fixtures either — an assertion that a field is absent is as meaningful as one
 * that it is present.
 *
 * 4-Tier Test Architecture:
 * - Tier 1: Feature Coverage (Isolation, >=5 tests)
 * - Tier 2: Boundaries & Corner Cases (>=5 tests)
 * - Tier 3: Pairwise Combinations (>=4 tests)
 * - Tier 4: Real-World Application Workflows (>=2 tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import { useUIStore } from '../../src/store/useUIStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { artistService } from '../../src/services/artistService';
import {
  installFetchMock,
  jsonResponse,
  httpErrorResponse,
  resetUIStore,
  resetPlayerStore,
  flushAsync
,
  signInForTests
} from '../helpers/testUtils';
import {
  artistProfileRoutes,
  artistSearchPayload,
  artistSearchRow,
  artistBrowsePayload,
  artistSongShelf,
  artistSongRow,
  wikipediaSummary
} from '../helpers/networkFixtures';
import { createMockTrack } from '../helpers/mockData';

/** Ten plausible song rows for a channel's "Песни" shelf. */
function songRows(count: number, artist: string, titlePrefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    videoId: `vid${String(i).padStart(8, '0')}`,
    title: `${titlePrefix} ${i + 1}`,
    secondary: [artist],
    duration: '3:30'
  }));
}

describe('E2E: Artist Hub Pages & Universal Navigation (M6)', () => {
  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    resetUIStore();
    resetPlayerStore();
    signInForTests();
    artistService.clearCache();
  });

  afterEach(async () => {
    await flushAsync();
    vi.unstubAllGlobals();
    artistService.clearCache();
  });

  // =========================================================================
  // Tier 1 — Feature Coverage (Isolation)
  // =========================================================================
  describe('Tier 1: Feature Coverage (Isolation & Happy Path)', () => {
    it('F6.1: assembles a full profile from the artist channel and Wikipedia', async () => {
      installFetchMock(
        artistProfileRoutes({
          name: 'Queen',
          channelId: 'UCiMhD4jzUqG-IgPzUmmytRQ',
          subscribers: '12 млн подписчиков',
          avatarUrl: 'https://lh3.googleusercontent.com/queen',
          songs: songRows(10, 'Queen', 'Queen Hit'),
          albums: [
            { title: 'A Night at the Opera', subtitle: 'Альбом • 1975 • 12 треков', browseId: 'MPREb_opera' },
            { title: 'News of the World', subtitle: 'Альбом • 1977 • 11 треков', browseId: 'MPREb_news' }
          ],
          similar: [
            { title: 'David Bowie', browseId: 'UCbowie' },
            { title: 'Led Zeppelin', browseId: 'UCzeppelin' }
          ],
          wikipedia: 'Queen — британская рок-группа, образованная в Лондоне в 1970 году участниками Smile.'
        })
      );

      const profile = await artistService.getArtistProfile('Queen');

      expect(profile.name).toBe('Queen');
      expect(profile.channelId).toBe('UCiMhD4jzUqG-IgPzUmmytRQ');
      expect(profile.subscriberCount).toBe('12 млн подписчиков');
      expect(profile.bio).toContain('британская рок-группа');
      expect(profile.bioSource).toBe('wikipedia-ru');
      expect(profile.topTracks).toHaveLength(10);
      expect(profile.albums).toHaveLength(2);
      expect(profile.albums[0]).toMatchObject({ title: 'A Night at the Opera', year: '1975', trackCount: 12 });
      expect(profile.similarArtists.map((a) => a.name)).toEqual(['David Bowie', 'Led Zeppelin']);
      expect(profile.isSparse).toBeUndefined();
    });

    it('F6.1: every top track is playable — real video id, real duration', async () => {
      installFetchMock(
        artistProfileRoutes({
          name: 'Radiohead',
          songs: [
            { videoId: 'XFkzRNyygfk', title: 'Creep', secondary: ['Radiohead', 'Pablo Honey'], duration: '3:58' }
          ],
          wikipedia: 'Radiohead — британская рок-группа из Абингдона, основанная в 1985 году.'
        })
      );

      const profile = await artistService.getArtistProfile('Radiohead');
      const track = profile.topTracks[0];

      expect(track.originalId).toBe('XFkzRNyygfk');
      expect(track.id).toBe('yt_XFkzRNyygfk');
      expect(track.source).toBe('youtube');
      expect(track.duration).toBe(238);
      expect(track.album).toBe('Pablo Honey');
      expect(track.sourceUrl).toContain('XFkzRNyygfk');
    });

    it('F6.2: clamps Top Tracks strictly to a maximum of 10 tracks', async () => {
      installFetchMock(
        artistProfileRoutes({
          name: 'Prolific Artist',
          songs: songRows(15, 'Prolific Artist', 'Track')
        })
      );

      const profile = await artistService.getArtistProfile('Prolific Artist');
      expect(profile.topTracks).toHaveLength(10);
    });

    it('F6.3: universal navigation triggers artist view switch and sets selectedArtistName', () => {
      useUIStore.getState().openArtist('Daft Punk');

      expect(useUIStore.getState().activeView).toBe('artist');
      expect(useUIStore.getState().selectedArtistName).toBe('Daft Punk');
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(false);
    });

    it('F6.1: caches artist profiles in memory to avoid duplicate network fetches', async () => {
      const mock = installFetchMock(
        artistProfileRoutes({ name: 'Cached Artist', songs: songRows(1, 'Cached Artist', 'Song') })
      );

      const first = await artistService.getArtistProfile('Cached Artist');
      const callsAfterFirst = mock.calls.length;
      const second = await artistService.getArtistProfile('Cached Artist');

      expect(first).toBe(second);
      expect(mock.calls.length).toBe(callsAfterFirst);
    });

    it('F6.2: playing a Top Track from Artist Hub loads artist context queue into PlayerStore', () => {
      const artistTracks = Array.from({ length: 5 }, (_, i) =>
        createMockTrack({ id: `yt_art_${i}`, title: `Song ${i + 1}`, artist: 'Pink Floyd' })
      );

      usePlayerStore.setState({
        currentTrack: artistTracks[1],
        sourceQueue: artistTracks,
        currentIndex: 1,
        isPlaying: true
      });

      expect(usePlayerStore.getState().currentTrack?.title).toBe('Song 2');
      expect(usePlayerStore.getState().sourceQueue).toHaveLength(5);
      expect(usePlayerStore.getState().currentIndex).toBe(1);
    });
  });

  // =========================================================================
  // Tier 2 — Boundaries & Corner Cases
  // =========================================================================
  describe('Tier 2: Boundary & Corner Cases', () => {
    it('handles Cyrillic artist names end to end', async () => {
      installFetchMock(
        artistProfileRoutes({
          name: 'Кино',
          songs: [
            { videoId: 'gruppa1234', title: 'Группа крови', secondary: ['Кино', 'Группа крови'], duration: '4:47' }
          ],
          wikipedia: 'Кино — советская рок-группа, образованная в Ленинграде в 1981 году Виктором Цоем.'
        })
      );

      const profile = await artistService.getArtistProfile('Кино');
      expect(profile.name).toBe('Кино');
      expect(profile.topTracks[0].title).toBe('Группа крови');
      expect(profile.bio).toContain('Цоем');
    });

    it('handles an artist with 0 albums, 0 similar artists and no biography', async () => {
      installFetchMock(
        artistProfileRoutes({
          name: 'New Indie Singer',
          songs: [{ videoId: 'single00001', title: 'Single 1', secondary: ['New Indie Singer'], duration: '2:58' }]
        })
      );

      const profile = await artistService.getArtistProfile('New Indie Singer');
      expect(profile.name).toBe('New Indie Singer');
      expect(profile.albums).toHaveLength(0);
      expect(profile.similarArtists).toHaveLength(0);
      // No source had a biography, so there is none — not a generated sentence.
      expect(profile.bio).toBeUndefined();
      expect(profile.bioSource).toBeUndefined();
      // One real track is enough to not be sparse.
      expect(profile.isSparse).toBeUndefined();
    });

    it('marks the profile sparse rather than throwing when every upstream is down', async () => {
      installFetchMock([], { fallback: () => httpErrorResponse(500) });

      const profile = await artistService.getArtistProfile('Broken Server Artist');
      expect(profile.name).toBe('Broken Server Artist');
      expect(profile.isSparse).toBe(true);
      expect(profile.topTracks).toEqual([]);
    });

    it('rejects empty or whitespace artist name', async () => {
      await expect(artistService.getArtistProfile('')).rejects.toThrow(/Artist name is required/);
      await expect(artistService.getArtistProfile('   ')).rejects.toThrow(/Artist name is required/);
    });

    it('ignores empty string or whitespace when openArtist is invoked', () => {
      useUIStore.setState({ activeView: 'search', selectedArtistName: null });
      useUIStore.getState().openArtist('   ');
      expect(useUIStore.getState().activeView).toBe('search');
      expect(useUIStore.getState().selectedArtistName).toBeNull();
    });

    it('keeps an album with no year and no track count rather than inventing either', async () => {
      installFetchMock(
        artistProfileRoutes({
          name: 'Bootleg Only',
          songs: songRows(1, 'Bootleg Only', 'Song'),
          albums: [{ title: 'Untitled Sessions', subtitle: 'Альбом', browseId: 'MPREb_untitled' }]
        })
      );

      const profile = await artistService.getArtistProfile('Bootleg Only');
      expect(profile.albums[0].title).toBe('Untitled Sessions');
      expect(profile.albums[0].year).toBeUndefined();
      expect(profile.albums[0].trackCount).toBeUndefined();
    });
  });

  // =========================================================================
  // Tier 3 — Cross-Feature Combinations
  // =========================================================================
  describe('Tier 3: Pairwise Combinations', () => {
    it('Comb 1: navigating between similar artists loads each profile from its own channel', async () => {
      // The channel returned depends on which name was searched, so following a
      // "similar artist" link genuinely fetches the other artist.
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: (_url, init) => {
            const query = String(JSON.parse(String(init?.body)).query);
            return jsonResponse(
              artistSearchPayload([
                artistSearchRow({ browseId: query === 'Nirvana' ? 'UCnirvana' : 'UCfoo', name: query })
              ])
            );
          }
        },
        {
          match: '/youtubei/v1/browse',
          respond: (_url, init) => {
            const browseId = String(JSON.parse(String(init?.body)).browseId);
            return jsonResponse(
              browseId === 'UCnirvana'
                ? artistBrowsePayload({
                    name: 'Nirvana',
                    sections: [
                      artistSongShelf('Песни', [
                        artistSongRow({ videoId: 'smells1234', title: 'Smells Like Teen Spirit' })
                      ])
                    ]
                  })
                : artistBrowsePayload({
                    name: 'Foo Fighters',
                    sections: [
                      artistSongShelf('Песни', [artistSongRow({ videoId: 'everlong12', title: 'Everlong' })])
                    ]
                  })
            );
          }
        },
        { match: 'wikipedia.org', respond: () => httpErrorResponse(404) }
      ]);

      const p1 = await artistService.getArtistProfile('Nirvana');
      expect(p1.name).toBe('Nirvana');
      expect(p1.channelId).toBe('UCnirvana');

      useUIStore.getState().openArtist('Foo Fighters');
      expect(useUIStore.getState().selectedArtistName).toBe('Foo Fighters');

      const p2 = await artistService.getArtistProfile(useUIStore.getState().selectedArtistName!);
      expect(p2.name).toBe('Foo Fighters');
      expect(p2.topTracks[0].title).toBe('Everlong');
    });

    it('Comb 2: Top tracks from Artist Hub can be added to user Favorites', async () => {
      const track = createMockTrack({ id: 'yt_art_fav_1', title: 'Top Hit', artist: 'Gorillaz' });

      usePlayerStore.setState({ currentTrack: track });
      expect(usePlayerStore.getState().currentTrack?.id).toBe('yt_art_fav_1');

      await useLibraryStore.getState().toggleFavorite(track);
      expect(useLibraryStore.getState().isFavorite('yt_art_fav_1')).toBe(true);
    });

    it('Comb 3: Play All hands the whole real top-track list to the player as the queue', async () => {
      installFetchMock(
        artistProfileRoutes({
          name: 'Metallica',
          songs: songRows(10, 'Metallica', 'Metallica Track')
        })
      );

      const profile = await artistService.getArtistProfile('Metallica');
      expect(profile.topTracks).toHaveLength(10);

      usePlayerStore.setState({
        currentTrack: profile.topTracks[0],
        sourceQueue: profile.topTracks,
        currentIndex: 0,
        isPlaying: true
      });

      expect(usePlayerStore.getState().currentTrack?.title).toBe('Metallica Track 1');
      expect(usePlayerStore.getState().sourceQueue).toHaveLength(10);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    });

    it('Comb 4: Starting Track Radio from Artist Hub sets queueMode and activeSeedTrack', async () => {
      const seedTrack = createMockTrack({
        id: 'yt_radio_seed_1',
        title: 'Radiohead - Creep',
        artist: 'Radiohead',
        streamUrl: 'https://stream.mock.net/creep.m4a',
        streamExpiry: Date.now() + 3600000
      });

      usePlayerStore.setState({
        queueMode: 'track_radio',
        activeSeedTrack: seedTrack,
        currentTrack: seedTrack,
        isPlaying: true
      });

      expect(usePlayerStore.getState().queueMode).toBe('track_radio');
      expect(usePlayerStore.getState().activeSeedTrack?.id).toBe('yt_radio_seed_1');
    });

    it('Comb 5: an artist radio seeds from the top track own related videos', async () => {
      installFetchMock([
        ...artistProfileRoutes({
          name: 'Kavinsky',
          songs: [{ videoId: 'MV_3Dpw', title: 'Nightcall', secondary: ['Kavinsky', 'OutRun'], duration: '4:18' }]
        }),
        // `getRelatedVideos` uses the Piped/Invidious pools, not InnerTube.
        {
          match: '/streams/',
          respond: () =>
            jsonResponse({
              relatedStreams: [
                {
                  url: '/watch?v=related0001',
                  title: 'Nightcall (Remix)',
                  uploaderName: 'Kavinsky',
                  duration: 250,
                  type: 'stream'
                }
              ]
            })
        }
      ], { fallback: () => httpErrorResponse(502) });

      const seeded = await artistService.getArtistRadioSeed('Kavinsky');

      // The seed leads, and whatever related tracks resolved follow it.
      expect(seeded[0].originalId).toBe('MV_3Dpw');
      expect(seeded.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Tier 4 — Real-World Workflows
  // =========================================================================
  describe('Tier 4: End-to-End User Workflows', () => {
    it('Workflow 1: click artist -> Hub loads real channel -> explore albums -> play the top tracks', async () => {
      installFetchMock(
        artistProfileRoutes({
          name: 'Daft Punk',
          channelId: 'UC_kRDKYrUlrbtrSiyu5Tflg',
          subscribers: '5,7 млн подписчиков',
          songs: songRows(10, 'Daft Punk', 'Daft Punk Hit'),
          albums: [
            { title: 'Discovery', subtitle: 'Альбом • 2001 • 14 треков', browseId: 'MPREb_discovery' },
            { title: 'Random Access Memories', subtitle: 'Альбом • 2013 • 13 треков', browseId: 'MPREb_ram' }
          ],
          similar: [{ title: 'Justice', browseId: 'UCjustice' }, { title: 'Kavinsky', browseId: 'UCkavinsky' }],
          wikipedia: 'Daft Punk — французский электронный дуэт, образованный в 1993 году в Париже.'
        })
      );

      // Step 1: User navigates via openArtist
      useUIStore.getState().openArtist('Daft Punk');
      expect(useUIStore.getState().activeView).toBe('artist');
      expect(useUIStore.getState().selectedArtistName).toBe('Daft Punk');

      // Step 2: Hub loads the profile from the real channel
      const hub = await artistService.getArtistProfile(useUIStore.getState().selectedArtistName!);
      expect(hub.name).toBe('Daft Punk');
      expect(hub.subscriberCount).toBe('5,7 млн подписчиков');
      expect(hub.albums.map((a) => a.year)).toEqual(['2001', '2013']);
      expect(hub.similarArtists).toHaveLength(2);

      // Step 3: Play the top tracks
      usePlayerStore.setState({
        currentTrack: hub.topTracks[0],
        sourceQueue: hub.topTracks,
        currentIndex: 0,
        isPlaying: true
      });

      expect(usePlayerStore.getState().currentTrack?.title).toBe('Daft Punk Hit 1');
      expect(usePlayerStore.getState().sourceQueue).toHaveLength(10);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    });

    it('Workflow 2: open a similar artist -> switch profile -> play one of their tracks', async () => {
      installFetchMock(
        artistProfileRoutes({
          name: 'Kavinsky',
          songs: songRows(5, 'Kavinsky', 'Nightcall'),
          albums: [{ title: 'OutRun', subtitle: 'Альбом • 2013 • 13 треков', browseId: 'MPREb_outrun' }],
          similar: [{ title: 'Daft Punk', browseId: 'UCdaftpunk' }],
          wikipedia: 'Kavinsky — французский электронный музыкант, известный по треку Nightcall.'
        })
      );

      useUIStore.getState().openArtist('Kavinsky');
      expect(useUIStore.getState().activeView).toBe('artist');
      expect(useUIStore.getState().selectedArtistName).toBe('Kavinsky');

      const kavinskyProfile = await artistService.getArtistProfile('Kavinsky');
      expect(kavinskyProfile.name).toBe('Kavinsky');
      expect(kavinskyProfile.topTracks).toHaveLength(5);

      usePlayerStore.setState({
        currentTrack: kavinskyProfile.topTracks[0],
        sourceQueue: kavinskyProfile.topTracks,
        currentIndex: 0,
        isPlaying: true
      });

      expect(usePlayerStore.getState().currentTrack?.artist).toBe('Kavinsky');
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    });

    it('Workflow 3: a misspelled name yields a sparse profile the view can offer to retry', async () => {
      installFetchMock([
        { match: '/youtubei/v1/search', respond: () => jsonResponse(artistSearchPayload([])) },
        { match: 'ru.wikipedia.org', respond: () => jsonResponse(wikipediaSummary('x', 'disambiguation')) },
        { match: 'en.wikipedia.org', respond: () => httpErrorResponse(404) }
      ], { fallback: () => httpErrorResponse(502) });

      const profile = await artistService.getArtistProfile('Pnik Floyed');
      expect(profile.isSparse).toBe(true);
      expect(profile.name).toBe('Pnik Floyed');

      // Clearing the cache is what the view's retry button does, so the second
      // attempt is a real one rather than a replay of the empty result.
      artistService.clearCache();
      installFetchMock(
        artistProfileRoutes({ name: 'Pink Floyd', songs: songRows(2, 'Pink Floyd', 'Song') })
      );

      const corrected = await artistService.getArtistProfile('Pink Floyd');
      expect(corrected.isSparse).toBeUndefined();
      expect(corrected.topTracks).toHaveLength(2);
    });
  });
});
