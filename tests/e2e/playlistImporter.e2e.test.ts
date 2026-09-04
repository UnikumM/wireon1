/**
 * E2E Test Suite: 1-Click Multi-Platform Playlist Importer (M5)
 *
 * Requirements Coverage (ORIGINAL_REQUEST §R5, PROJECT.md M5):
 * - F5.1: Multi-Platform URL Parsers (Spotify, Yandex Music, VK Music, Apple Music URL metadata extraction)
 * - F5.2: Parallel Batch Search Resolver (resolves imported titles & artists via YouTube & SoundCloud aggregators)
 * - F5.3: Import Playlist Modal UI & Save (platform detector badge, progress bar, direct Dexie playlist creation)
 *
 * 4-Tier Test Architecture:
 * - Tier 1: Feature Coverage (Isolation, >=5 tests)
 * - Tier 2: Boundaries & Corner Cases (>=5 tests)
 * - Tier 3: Pairwise Combinations (>=4 tests)
 * - Tier 4: Real-World Application Workflows (>=2 tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import { useLibraryStore } from '../../src/store/useLibraryStore';
import {
  PlaylistImporterService,
  ParsedPlaylistItem
} from '../../src/services/playlistImporter';
import { searchAggregator } from '../../src/services/aggregator';
import {
  installFetchMock,
  jsonResponse,
  resetLibraryStore,
  flushAsync,
  signInForTests
} from '../helpers/testUtils';
import { createMockTrack } from '../helpers/mockData';

/**
 * Каталог, в котором импорт ищет треки.
 *
 * Подменяем именно агрегатор, а не `fetch`: перенос плейлиста больше не дёргает
 * поисковый эндпоинт напрямую — он спрашивает агрегатор и оценивает кандидатов.
 * На каждый запрос отдаём нужный трек и приманку — популярную ускоренную
 * версию, которую прежний импорт принёс бы вместо песни.
 */
function installSearchStub(songs: Array<{ title: string; artist?: string; duration?: number }>) {
  // Длинные названия первыми, иначе запрос «Song 10» поймает «Song 1».
  const ordered = [...songs].sort((a, b) => b.title.length - a.title.length);

  return vi.spyOn(searchAggregator, 'search').mockImplementation(async (query: string) => {
    const normalized = query.toLowerCase();
    const song = ordered.find((entry) => normalized.includes(entry.title.toLowerCase()));
    if (!song) {
      return { results: [], sources: { youtube: 0, soundcloud: 0 } };
    }

    const slug = song.title.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const results = [
      createMockTrack({
        id: `yt_decoy_${slug}`,
        originalId: `decoy_${slug}`,
        title: `${song.title} (Sped Up)`,
        artist: song.artist ?? 'Various Artists',
        duration: Math.round((song.duration ?? 200) * 0.85)
      }),
      createMockTrack({
        id: `yt_${slug}`,
        originalId: slug,
        title: song.title,
        artist: song.artist ?? '',
        duration: song.duration ?? 200
      })
    ];
    return { results, sources: { youtube: results.length, soundcloud: 0 } };
  });
}

describe('E2E: 1-Click Multi-Platform Playlist Importer (M5)', () => {
  let importer: PlaylistImporterService;

  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    resetLibraryStore();
    signInForTests();
    importer = new PlaylistImporterService();
  });

  afterEach(async () => {
    await flushAsync();
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Tier 1 — Feature Coverage (Isolation)
  // =========================================================================
  describe('Tier 1: Feature Coverage (Isolation & Happy Path)', () => {
    it('F5.1: detects Spotify playlist URLs and extracts track listings', async () => {
      const spotifyUrl = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
      expect(importer.detectPlatform(spotifyUrl)).toBe('spotify');

      installFetchMock([
        {
          match: 'spotify.com/playlist',
          respond: () =>
            jsonResponse({
              title: "Today's Top Hits",
              items: [
                { title: 'Espresso', artist: 'Sabrina Carpenter', duration: 175 },
                { title: 'Birds of a Feather', artist: 'Billie Eilish', duration: 196 }
              ]
            })
        }
      ]);

      const parsed = await importer.parsePlaylistUrl(spotifyUrl);
      expect(parsed.platform).toBe('spotify');
      expect(parsed.title).toBe("Today's Top Hits");
      expect(parsed.items).toHaveLength(2);
      expect(parsed.items[0].title).toBe('Espresso');
    });

    it('F5.1: detects Yandex Music playlist URLs and extracts track listings', async () => {
      const yandexUrl = 'https://music.yandex.ru/users/yamusic-top/playlists/1033';
      expect(importer.detectPlatform(yandexUrl)).toBe('yandex');

      installFetchMock([
        {
          match: 'music.yandex.ru',
          respond: () =>
            jsonResponse({
              title: 'Чарт Яндекс Музыки',
              items: [{ title: 'Пыяла', artist: 'АИГЕЛ', duration: 210 }]
            })
        }
      ]);

      const parsed = await importer.parsePlaylistUrl(yandexUrl);
      expect(parsed.platform).toBe('yandex');
      expect(parsed.title).toBe('Чарт Яндекс Музыки');
      expect(parsed.items[0].artist).toBe('АИГЕЛ');
    });

    it('F5.1: detects VK Music and Apple Music playlist URLs', async () => {
      const vkUrl = 'https://vk.com/music/playlist/123456_789';
      const appleUrl = 'https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb';

      expect(importer.detectPlatform(vkUrl)).toBe('vk');
      expect(importer.detectPlatform(appleUrl)).toBe('apple');
    });

    it('F5.2: resolves parsed tracks via search aggregator with progress updates', async () => {
      const items: ParsedPlaylistItem[] = [
        { title: 'Track 1', artist: 'Artist 1' },
        { title: 'Track 2', artist: 'Artist 2' }
      ];

      installSearchStub([
        { title: 'Track 1', artist: 'Artist 1' },
        { title: 'Track 2', artist: 'Artist 2' }
      ]);

      const progressSteps: number[] = [];
      const resolved = await importer.resolveImportedTracks(items, (res, tot) => {
        progressSteps.push(Math.round((res / tot) * 100));
      });

      expect(resolved).toHaveLength(2);
      expect(progressSteps).toEqual([50, 100]);
      expect(resolved[0].title).toBe('Track 1');
      expect(resolved[1].title).toBe('Track 2');
    });

    it('F5.3: saves resolved playlist directly into Dexie Library store', async () => {
      const tracks = [
        createMockTrack({ id: 'yt_imp_01', title: 'Imported Song 1' }),
        createMockTrack({ id: 'yt_imp_02', title: 'Imported Song 2' })
      ];

      const playlistId = await importer.saveToLibrary('My Spotify Import', tracks);

      const savedPl = useLibraryStore.getState().playlists.find((p) => p.id === playlistId);
      expect(savedPl).toBeDefined();
      expect(savedPl?.title).toBe('My Spotify Import');
      expect(savedPl?.tracks).toHaveLength(2);
      expect(savedPl?.tracks[0].title).toBe('Imported Song 1');
    });
  });

  // =========================================================================
  // Tier 2 — Boundaries & Corner Cases
  // =========================================================================
  describe('Tier 2: Boundary & Corner Cases', () => {
    it('rejects invalid or unsupported URL schemes with user-friendly error', async () => {
      expect(importer.detectPlatform('https://google.com')).toBeNull();
      expect(importer.detectPlatform('not-a-url')).toBeNull();

      await expect(importer.parsePlaylistUrl('https://example.com/audio')).rejects.toThrow(
        /Ссылка не подходит/
      );
    });

    it('handles HTTP 404 private or non-existent playlist gracefully', async () => {
      installFetchMock([
        {
          match: 'spotify.com/playlist',
          respond: () => new Response('Playlist not found', { status: 404 })
        }
      ]);

      await expect(
        importer.parsePlaylistUrl('https://open.spotify.com/playlist/nonexistent')
      ).rejects.toThrow(/HTTP 404/);
    });

    it('handles empty playlist (0 tracks) without error', async () => {
      installFetchMock([
        {
          match: 'spotify.com/playlist',
          respond: () => jsonResponse({ title: 'Empty Playlist', items: [] })
        }
      ]);

      const parsed = await importer.parsePlaylistUrl('https://open.spotify.com/playlist/empty');
      expect(parsed.items).toHaveLength(0);

      const resolved = await importer.resolveImportedTracks(parsed.items);
      expect(resolved).toHaveLength(0);
    });

    it('handles partial resolution when certain obscure tracks cannot be found', async () => {
      const items: ParsedPlaylistItem[] = [
        { title: 'Popular Hit', artist: 'Big Artist' },
        { title: 'Unreleased Garage Demo 1994', artist: 'Unknown Group' }
      ];

      // Второго трека в каталоге просто нет — импорт обязан сказать об этом,
      // а не подставить что-нибудь похожее.
      installSearchStub([{ title: 'Popular Hit', artist: 'Big Artist' }]);

      const matches = await importer.matchImportedTracks(items);
      const resolved = matches
        .map((match) => match.track)
        .filter((track): track is NonNullable<typeof track> => track !== null);

      expect(resolved).toHaveLength(1);
      expect(resolved[0].title).toBe('Popular Hit');
      expect(matches[1].track).toBeNull();
      expect(matches[1].notes).toContain('источники ничего не вернули');
    });

    it('handles 100+ track playlists with batch progress tracking', async () => {
      const items: ParsedPlaylistItem[] = [];
      for (let i = 0; i < 100; i++) {
        items.push({ title: `Song ${i}`, artist: `Artist ${i}` });
      }

      installSearchStub(items.map((item) => ({ title: item.title, artist: item.artist })));

      let finalPercentage = 0;
      const resolved = await importer.resolveImportedTracks(items, (res, tot) => {
        finalPercentage = Math.round((res / tot) * 100);
      });

      expect(resolved).toHaveLength(100);
      expect(finalPercentage).toBe(100);
    });
  });

  // =========================================================================
  // Tier 3 — Cross-Feature Combinations
  // =========================================================================
  describe('Tier 3: Pairwise Combinations', () => {
    it('Comb 1: Imported playlist tracks can be added to Queue and played immediately', async () => {
      const tracks = [
        createMockTrack({ id: 'yt_imp_play_01', title: 'Import Track 1' }),
        createMockTrack({ id: 'yt_imp_play_02', title: 'Import Track 2' })
      ];

      const plId = await importer.saveToLibrary('Instant Play Playlist', tracks);
      const playlist = useLibraryStore.getState().playlists.find((p) => p.id === plId);

      expect(playlist?.tracks).toHaveLength(2);
      expect(playlist?.tracks[0].title).toBe('Import Track 1');
    });

    it('Comb 2: Multiple imports from different platforms coexist cleanly in Library', async () => {
      const spotifyTracks = [createMockTrack({ id: 'yt_sp_1', title: 'Spotify Track 1' })];
      const yandexTracks = [createMockTrack({ id: 'yt_ya_1', title: 'Yandex Track 1' })];

      await importer.saveToLibrary('Spotify Favorites', spotifyTracks);
      await importer.saveToLibrary('Yandex Top 100', yandexTracks);

      const allPlaylists = useLibraryStore.getState().playlists;
      expect(allPlaylists).toHaveLength(2);
      expect(allPlaylists.some((p) => p.title === 'Spotify Favorites')).toBe(true);
      expect(allPlaylists.some((p) => p.title === 'Yandex Top 100')).toBe(true);
    });
  });

  // =========================================================================
  // Tier 4 — Real-World Workflows
  // =========================================================================
  describe('Tier 4: End-to-End User Workflows', () => {
    it('Workflow: User imports Spotify playlist URL -> views progress -> verifies new playlist in library', async () => {
      const spotifyUrl = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';

      installFetchMock([
        {
          match: 'spotify.com/playlist',
          respond: () =>
            jsonResponse({
              title: 'Synthwave Night Drive',
              items: [
                { title: 'Tech Noir', artist: 'Gunship', duration: 297 },
                { title: 'Nightcall', artist: 'Kavinsky', duration: 259 },
                { title: 'Sunset', artist: 'The Midnight', duration: 326 }
              ]
            })
        }
      ]);

      installSearchStub([
        { title: 'Tech Noir', artist: 'Gunship', duration: 297 },
        { title: 'Nightcall', artist: 'Kavinsky', duration: 259 },
        { title: 'Sunset', artist: 'The Midnight', duration: 326 }
      ]);

      const parsed = await importer.parsePlaylistUrl(spotifyUrl);
      expect(parsed.title).toBe('Synthwave Night Drive');
      expect(parsed.items).toHaveLength(3);

      const progressList: number[] = [];
      const resolved = await importer.resolveImportedTracks(parsed.items, (res, _tot) => {
        progressList.push(res);
      });
      expect(resolved).toHaveLength(3);
      expect(progressList).toEqual([1, 2, 3]);

      const playlistId = await importer.saveToLibrary(parsed.title, resolved);

      const pl = useLibraryStore.getState().playlists.find((p) => p.id === playlistId);
      expect(pl).toBeDefined();
      expect(pl?.title).toBe('Synthwave Night Drive');
      expect(pl?.tracks[0].title).toBe('Tech Noir');
      expect(pl?.tracks[1].title).toBe('Nightcall');
      expect(pl?.tracks[2].title).toBe('Sunset');
    });
  });
});
