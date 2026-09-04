/**
 * Unit Test Suite: 1-Click Multi-Platform Playlist Importer (M5)
 *
 * Tests:
 * - Platform URL detection (Spotify, Yandex Music, VK Music, Apple Music, invalid)
 * - ISO-8601 duration and time string parsing
 * - Parsing Spotify (HTML with __NEXT_DATA__, Schema.org JSON-LD, JSON handlers)
 * - Parsing Yandex Music (HTML with window.__DATA__, JSON handlers, .d-track markup)
 * - Parsing VK Music (HTML with data-audio attributes, audio_row markup)
 * - Parsing Apple Music (HTML with Schema.org LD+JSON, songs-list markup)
 * - Error handling for HTTP errors (404/500), network failures, and unsupported schemes
 * - Parallel batch search resolution via SearchAggregator with progress tracking
 * - Dexie library store saving and playlist creation
 * - End-to-end importPlaylist orchestration
 * - ImportPlaylistModal UI component rendering, badge detection, preview, and progress
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup';

import {
  PlaylistImporterService,
  detectPlatform,
  parseIsoDuration,
  parseTimeString,
  ParsedPlaylistItem
} from '../../src/services/playlistImporter';
import { searchAggregator } from '../../src/services/aggregator';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { ImportPlaylistModal } from '../../src/components/modals/ImportPlaylistModal';
import {
  installFetchMock,
  jsonResponse,
  resetLibraryStore,
  flushAsync,
  signInForTests
} from '../helpers/testUtils';
import { createMockTrack } from '../helpers/mockData';

/**
 * Файл, который компонент действительно сможет прочитать: в jsdom у `File` нет
 * метода `text()`, а без него импорт уйдёт в ветку «файл не читается».
 */
function playlistFile(contents: string, name: string, type = 'application/json'): File {
  const file = new File([contents], name, { type });
  if (typeof file.text !== 'function') {
    Object.defineProperty(file, 'text', { value: async () => contents });
  }
  return file;
}

describe('Unit: Playlist Importer Service (M5)', () => {
  let service: PlaylistImporterService;

  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    resetLibraryStore();
    signInForTests();
    service = new PlaylistImporterService();
  });

  afterEach(async () => {
    await flushAsync();
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // 1. Platform Detection
  // =========================================================================
  describe('1. Platform URL Detection', () => {
    it('detects Spotify playlist and album URLs', () => {
      expect(detectPlatform('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe('spotify');
      expect(detectPlatform('https://open.spotify.com/album/4LH4d3cOWNNXdUMIL4122G')).toBe('spotify');
      expect(detectPlatform('https://spotify.link/AbCdEf123')).toBe('spotify');
      expect(detectPlatform('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toBe('spotify');
    });

    it('detects Yandex Music playlist and album URLs', () => {
      expect(detectPlatform('https://music.yandex.ru/users/yamusic-top/playlists/1033')).toBe('yandex');
      expect(detectPlatform('https://music.yandex.ru/album/28495034')).toBe('yandex');
      expect(detectPlatform('https://music.yandex.com/users/test/playlists/1')).toBe('yandex');
      expect(detectPlatform('https://music.yandex.kz/album/12345')).toBe('yandex');
    });

    it('detects VK Music playlist and audio URLs', () => {
      expect(detectPlatform('https://vk.com/music/playlist/123456_789')).toBe('vk');
      expect(detectPlatform('https://vk.com/audio?z=audio_playlist123456_789')).toBe('vk');
      expect(detectPlatform('https://vk.com/audios123456')).toBe('vk');
      expect(detectPlatform('https://vk.ru/music/playlist/111_222')).toBe('vk');
    });

    it('detects Apple Music playlist and album URLs', () => {
      expect(
        detectPlatform('https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb')
      ).toBe('apple');
      expect(
        detectPlatform('https://music.apple.com/ru/album/the-dark-side-of-the-moon/1065973699')
      ).toBe('apple');
    });

    it('returns null for unsupported domains or invalid strings', () => {
      expect(detectPlatform('https://youtube.com/playlist?list=PL123')).toBeNull();
      expect(detectPlatform('https://soundcloud.com/user/sets/playlist')).toBeNull();
      expect(detectPlatform('https://google.com')).toBeNull();
      expect(detectPlatform('not-a-valid-url')).toBeNull();
      expect(detectPlatform('')).toBeNull();
    });
  });

  // =========================================================================
  // 2. Duration Parsers
  // =========================================================================
  describe('2. Duration Parsers', () => {
    it('parseIsoDuration correctly converts ISO-8601 duration strings', () => {
      expect(parseIsoDuration('PT3M45S')).toBe(225);
      expect(parseIsoDuration('PT210S')).toBe(210);
      expect(parseIsoDuration('PT1H2M30S')).toBe(3750);
      expect(parseIsoDuration('PT4M')).toBe(240);
      expect(parseIsoDuration('invalid')).toBe(0);
      expect(parseIsoDuration('')).toBe(0);
    });

    it('parseTimeString correctly converts MM:SS and HH:MM:SS strings', () => {
      expect(parseTimeString('3:45')).toBe(225);
      expect(parseTimeString('03:45')).toBe(225);
      expect(parseTimeString('1:02:30')).toBe(3750);
      expect(parseTimeString('invalid')).toBe(0);
      expect(parseTimeString('')).toBe(0);
    });
  });

  // =========================================================================
  // 3. Multi-Platform Parsing
  // =========================================================================
  describe('3. Multi-Platform URL Parsers', () => {
    it('parses Spotify playlist with __NEXT_DATA__ JSON script', async () => {
      const htmlPayload = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta property="og:title" content="Today's Top Hits | Spotify" />
            <meta property="og:description" content="The biggest hits right now" />
            <meta property="og:image" content="https://i.scdn.co/image/ab67706f00000002top" />
          </head>
          <body>
            <script id="__NEXT_DATA__" type="application/json">
              {
                "props": {
                  "pageProps": {
                    "state": {
                      "data": {
                        "entity": {
                          "name": "Today's Top Hits",
                          "description": "The biggest hits right now",
                          "trackList": [
                            { "name": "Espresso", "artists": [{ "name": "Sabrina Carpenter" }], "duration_ms": 175000 },
                            { "name": "Birds of a Feather", "artists": [{ "name": "Billie Eilish" }], "duration_ms": 196000 }
                          ]
                        }
                      }
                    }
                  }
                }
              }
            </script>
          </body>
        </html>
      `;

      installFetchMock([
        {
          match: 'spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
          respond: () => new Response(htmlPayload, { headers: { 'Content-Type': 'text/html' } })
        }
      ]);

      const result = await service.parsePlaylistUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
      expect(result.platform).toBe('spotify');
      expect(result.title).toBe("Today's Top Hits");
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toEqual({
        title: 'Espresso',
        artist: 'Sabrina Carpenter',
        duration: 175
      });
      expect(result.items[1]).toEqual({
        title: 'Birds of a Feather',
        artist: 'Billie Eilish',
        duration: 196
      });
    });

    it('parses Spotify playlist with Schema.org JSON-LD when __NEXT_DATA__ is absent', async () => {
      const htmlPayload = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Chill Hits</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "MusicPlaylist",
                "name": "Chill Hits",
                "numTracks": 2,
                "track": [
                  {
                    "@type": "MusicRecording",
                    "name": "Sunroof",
                    "byArtist": { "@type": "MusicGroup", "name": "Nicky Youre" },
                    "duration": "PT2M43S"
                  },
                  {
                    "@type": "MusicRecording",
                    "name": "Heat Waves",
                    "byArtist": { "@type": "MusicGroup", "name": "Glass Animals" },
                    "duration": "PT3M58S"
                  }
                ]
              }
            </script>
          </head>
        </html>
      `;

      installFetchMock([
        {
          match: 'spotify.com/playlist',
          respond: () => new Response(htmlPayload, { headers: { 'Content-Type': 'text/html' } })
        }
      ]);

      const result = await service.parsePlaylistUrl('https://open.spotify.com/playlist/chillhits');
      expect(result.platform).toBe('spotify');
      expect(result.title).toBe('Chill Hits');
      expect(result.items).toHaveLength(2);
      expect(result.items[0].title).toBe('Sunroof');
      expect(result.items[0].artist).toBe('Nicky Youre');
      expect(result.items[0].duration).toBe(163);
    });

    it('parses Yandex Music playlist with JSON handler', async () => {
      installFetchMock([
        {
          match: 'music.yandex.ru/users/yamusic-top/playlists/1033',
          respond: () =>
            jsonResponse({
              playlist: {
                title: 'Чарт Яндекс Музыки',
                description: 'Топ треков прямо сейчас',
                tracks: [
                  {
                    title: 'Пыяла',
                    artists: [{ name: 'АИГЕЛ' }],
                    durationMs: 210000
                  },
                  {
                    title: 'Царица',
                    artists: [{ name: 'ANNA ASTI' }],
                    durationMs: 215000
                  }
                ]
              }
            })
        }
      ]);

      const result = await service.parsePlaylistUrl('https://music.yandex.ru/users/yamusic-top/playlists/1033');
      expect(result.platform).toBe('yandex');
      expect(result.title).toBe('Чарт Яндекс Музыки');
      expect(result.items).toHaveLength(2);
      expect(result.items[0].title).toBe('Пыяла');
      expect(result.items[0].artist).toBe('АИГЕЛ');
      expect(result.items[0].duration).toBe(210);
    });

    it('parses Yandex Music HTML with window.__DATA__ preload state', async () => {
      const html = `
        <html>
          <head><title>Мой Плейлист — Яндекс Музыка</title></head>
          <body>
            <script>
              window.__DATA__ = {
                "playlist": {
                  "title": "Любимые треки",
                  "tracks": [
                    { "title": "Группа крови", "artists": [{ "name": "КИНО" }], "durationMs": 285000 }
                  ]
                }
              };
            </script>
          </body>
        </html>
      `;

      installFetchMock([
        {
          match: 'music.yandex.ru',
          respond: () => new Response(html, { headers: { 'Content-Type': 'text/html' } })
        }
      ]);

      const result = await service.parsePlaylistUrl('https://music.yandex.ru/users/user/playlists/3');
      expect(result.platform).toBe('yandex');
      expect(result.title).toBe('Любимые треки');
      expect(result.items[0].title).toBe('Группа крови');
      expect(result.items[0].artist).toBe('КИНО');
      expect(result.items[0].duration).toBe(285);
    });

    it('parses VK Music HTML with data-audio JSON attributes', async () => {
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Русский Рок | ВКонтакте" />
          </head>
          <body>
            <div class="audio_row" data-audio='[101, 202, "url", "Лесник", "Король и Шут", 192]'></div>
            <div class="audio_row" data-audio='[102, 202, "url", "Кукла колдуна", "Король и Шут", 204]'></div>
          </body>
        </html>
      `;

      installFetchMock([
        {
          match: 'vk.com/music/playlist',
          respond: () => new Response(html, { headers: { 'Content-Type': 'text/html' } })
        }
      ]);

      const result = await service.parsePlaylistUrl('https://vk.com/music/playlist/1234_5678');
      expect(result.platform).toBe('vk');
      expect(result.title).toBe('Русский Рок');
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toEqual({
        title: 'Лесник',
        artist: 'Король и Шут',
        duration: 192
      });
      expect(result.items[1]).toEqual({
        title: 'Кукла колдуна',
        artist: 'Король и Шут',
        duration: 204
      });
    });

    it('parses Apple Music HTML with Schema.org JSON-LD playlist', async () => {
      const html = `
        <html>
          <head>
            <title>Today's Hits on Apple Music</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "MusicPlaylist",
                "name": "Today's Hits",
                "track": [
                  {
                    "@type": "MusicRecording",
                    "name": "Greedy",
                    "byArtist": [{ "name": "Tate McRae" }],
                    "duration": "PT2M11S"
                  },
                  {
                    "@type": "MusicRecording",
                    "name": "Cruel Summer",
                    "byArtist": { "name": "Taylor Swift" },
                    "duration": "PT2M58S"
                  }
                ]
              }
            </script>
          </head>
        </html>
      `;

      installFetchMock([
        {
          match: 'music.apple.com',
          respond: () => new Response(html, { headers: { 'Content-Type': 'text/html' } })
        }
      ]);

      const result = await service.parsePlaylistUrl(
        'https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb'
      );
      expect(result.platform).toBe('apple');
      expect(result.title).toBe("Today's Hits");
      expect(result.items).toHaveLength(2);
      expect(result.items[0].title).toBe('Greedy');
      expect(result.items[0].artist).toBe('Tate McRae');
      expect(result.items[0].duration).toBe(131);
    });

    it('throws descriptive error on HTTP 404 or unsupported URL', async () => {
      await expect(service.parsePlaylistUrl('https://example.com/not-supported')).rejects.toThrow(
        /Ссылка не подходит/
      );

      installFetchMock([
        {
          match: 'spotify.com/playlist/nonexistent',
          respond: () => new Response('Not found', { status: 404, statusText: 'Not Found' })
        }
      ]);

      await expect(
        service.parsePlaylistUrl('https://open.spotify.com/playlist/nonexistent')
      ).rejects.toThrow(/HTTP 404/);
    });
  });

  // =========================================================================
  // 4. Batch Search Resolution
  // =========================================================================
  describe('4. Batch Search Resolution (F5.2)', () => {
    it('resolves track list in batches and invokes progress callback', async () => {
      const items: ParsedPlaylistItem[] = [
        { title: 'Song Alpha', artist: 'Artist A', duration: 180 },
        { title: 'Song Beta', artist: 'Artist B', duration: 210 },
        { title: 'Song Gamma', artist: 'Artist C', duration: 195 }
      ];

      const searchSpy = vi.spyOn(searchAggregator, 'search').mockImplementation(async (query) => {
        // Длительность берём из запрошенного трека: оценщик сравнивает её с
        // ожидаемой, и кандидат «на минуту короче» справедливо не проходит.
        const asked = items.find((item) => query.includes(item.title));
        return {
          results: [
            createMockTrack({
              id: `yt_${query.replace(/\s+/g, '_')}`,
              title: asked?.title ?? query,
              artist: asked?.artist ?? 'Matched Artist',
              duration: asked?.duration ?? 200,
              source: 'youtube'
            })
          ],
          sources: { youtube: 1, soundcloud: 0 }
        };
      });

      const progressLogs: Array<{ resolved: number; total: number; current?: string }> = [];
      const resolved = await service.resolveImportedTracks(items, (res, tot, cur) => {
        progressLogs.push({ resolved: res, total: tot, current: cur });
      });

      expect(resolved).toHaveLength(3);
      expect(progressLogs).toHaveLength(3);
      expect(progressLogs[progressLogs.length - 1].resolved).toBe(3);
      expect(progressLogs[progressLogs.length - 1].total).toBe(3);
      expect(searchSpy).toHaveBeenCalled();
    });

    it('tolerates missing or unresolvable tracks without failing the entire batch', async () => {
      const items: ParsedPlaylistItem[] = [
        { title: 'Resolvable Song', artist: 'Known Artist' },
        { title: 'Ultra Rare Obscure Tape 1982', artist: 'Unknown Ghost' }
      ];

      vi.spyOn(searchAggregator, 'search').mockImplementation(async (query) => {
        if (query.includes('Obscure')) {
          return { results: [], sources: { youtube: 0, soundcloud: 0 } };
        }
        return {
          results: [createMockTrack({ id: 'yt_known', title: 'Resolvable Song' })],
          sources: { youtube: 1, soundcloud: 0 }
        };
      });

      const resolved = await service.resolveImportedTracks(items);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].title).toBe('Resolvable Song');
    });

    it('returns empty array when items list is empty', async () => {
      const resolved = await service.resolveImportedTracks([]);
      expect(resolved).toEqual([]);
    });
  });

  // =========================================================================
  // 4b. Отчёт о совпадениях — из-за него и переписывался перенос
  // =========================================================================
  describe('4b. Отчёт о совпадениях (matchImportedTracks)', () => {
    it('выбирает настоящую песню, а не популярную ускоренную версию', async () => {
      vi.spyOn(searchAggregator, 'search').mockResolvedValue({
        results: [
          // Первым результатом YouTube почти всегда отдаёт вот это.
          createMockTrack({
            id: 'yt_sped',
            title: 'Кино - Группа крови (sped up)',
            artist: 'Nightcore Zone',
            duration: 240
          }),
          createMockTrack({
            id: 'yt_hour',
            title: 'Группа крови [1 hour loop]',
            artist: 'Loops',
            duration: 3600
          }),
          createMockTrack({
            id: 'yt_real',
            title: 'Кино - Группа крови',
            artist: 'Кино - Topic',
            duration: 285
          })
        ],
        sources: { youtube: 3, soundcloud: 0 }
      });

      const matches = await service.matchImportedTracks([
        { title: 'Группа крови', artist: 'Кино', duration: 285 }
      ]);

      expect(matches).toHaveLength(1);
      expect(matches[0].track?.id).toBe('yt_real');
      expect(matches[0].confidence).toBe('high');
    });

    it('честно сообщает о ненайденном вместо того, чтобы подставить похожее', async () => {
      vi.spyOn(searchAggregator, 'search').mockResolvedValue({
        results: [
          createMockTrack({
            id: 'yt_other',
            title: 'Совершенно другая песня',
            artist: 'Кто-то ещё',
            duration: 120
          })
        ],
        sources: { youtube: 1, soundcloud: 0 }
      });

      const matches = await service.matchImportedTracks([
        { title: 'Редкая запись 1982', artist: 'Неизвестная группа', duration: 300 }
      ]);

      expect(matches[0].track).toBeNull();
      expect(matches[0].confidence).toBeNull();
      // В отчёте должно быть видно, чем именно не подошёл лучший кандидат.
      expect(matches[0].notes.length).toBeGreaterThan(0);
    });

    it('складывает остальных кандидатов в альтернативы — для выбора вручную', async () => {
      vi.spyOn(searchAggregator, 'search').mockResolvedValue({
        results: [
          createMockTrack({ id: 'yt_a', title: 'Пачка сигарет', artist: 'Кино', duration: 270 }),
          createMockTrack({ id: 'yt_b', title: 'Пачка сигарет (live)', artist: 'Кино', duration: 280 }),
          createMockTrack({ id: 'yt_c', title: 'Пачка сигарет (cover)', artist: 'Другие', duration: 265 })
        ],
        sources: { youtube: 3, soundcloud: 0 }
      });

      const matches = await service.matchImportedTracks([
        { title: 'Пачка сигарет', artist: 'Кино', duration: 270 }
      ]);

      expect(matches[0].track?.id).toBe('yt_a');
      expect(matches[0].alternatives.map((t) => t.id)).toEqual(['yt_b', 'yt_c']);
      expect(matches[0].alternatives).not.toContainEqual(
        expect.objectContaining({ id: 'yt_a' })
      );
    });

    it('не ищет строку, в которой вместо названия осталась ссылка', async () => {
      const searchSpy = vi.spyOn(searchAggregator, 'search');

      const matches = await service.matchImportedTracks([
        { title: 'https://open.spotify.com/track/123', artist: '' }
      ]);

      expect(matches[0].track).toBeNull();
      expect(matches[0].notes).toContain('в строке нет названия трека');
      expect(searchSpy).not.toHaveBeenCalled();
    });

    it('повторяет поиск по одному названию, когда с исполнителем ничего не нашлось', async () => {
      const searchSpy = vi
        .spyOn(searchAggregator, 'search')
        .mockImplementation(async (query: string) => {
          if (query.toLowerCase().includes('kino')) {
            return { results: [], sources: { youtube: 0, soundcloud: 0 } };
          }
          return {
            results: [
              createMockTrack({ id: 'yt_fallback', title: 'Звезда по имени Солнце', artist: 'Кино', duration: 230 })
            ],
            sources: { youtube: 1, soundcloud: 0 }
          };
        });

      const matches = await service.matchImportedTracks([
        { title: 'Звезда по имени Солнце', artist: 'Kino', duration: 230 }
      ]);

      expect(searchSpy).toHaveBeenCalledTimes(2);
      expect(matches[0].track?.id).toBe('yt_fallback');
    });

    it('переживает падение поиска: один сломанный запрос не рушит перенос', async () => {
      vi.spyOn(searchAggregator, 'search').mockImplementation(async (query: string) => {
        if (query.includes('Beta')) {
          throw new Error('network down');
        }
        return {
          results: [createMockTrack({ id: 'yt_ok', title: 'Song Alpha', artist: 'Artist A', duration: 200 })],
          sources: { youtube: 1, soundcloud: 0 }
        };
      });

      const matches = await service.matchImportedTracks([
        { title: 'Song Alpha', artist: 'Artist A', duration: 200 },
        { title: 'Song Beta', artist: 'Artist B', duration: 200 }
      ]);

      expect(matches[0].track?.id).toBe('yt_ok');
      expect(matches[1].track).toBeNull();
      expect(matches[1].notes).toContain('поиск завершился ошибкой');
    });

    it('сохраняет порядок треков плейлиста, хотя ищет их пачками', async () => {
      vi.spyOn(searchAggregator, 'search').mockImplementation(async (query: string) => {
        const index = Number((query.match(/(\d+)/) ?? [])[1] ?? 0);
        // Поздние запросы отвечают быстрее — порядок обеспечивает не он.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, 12 - index)));
        return {
          results: [
            createMockTrack({ id: `yt_${index}`, title: `Трек ${index}`, artist: `Автор ${index}`, duration: 200 })
          ],
          sources: { youtube: 1, soundcloud: 0 }
        };
      });

      const items: ParsedPlaylistItem[] = Array.from({ length: 12 }, (_, i) => ({
        title: `Трек ${i}`,
        artist: `Автор ${i}`,
        duration: 200
      }));

      const matches = await service.matchImportedTracks(items);
      expect(matches.map((m) => m.track?.id)).toEqual(items.map((_, i) => `yt_${i}`));
    });
  });

  // =========================================================================
  // 5. Library Save & End-to-End Orchestration
  // =========================================================================
  describe('5. Library Save & importPlaylist pipeline', () => {
    it('saves resolved tracks into Dexie Library store and returns playlist ID', async () => {
      const tracks = [
        createMockTrack({ id: 'yt_saved_1', title: 'Saved Track 1' }),
        createMockTrack({ id: 'yt_saved_2', title: 'Saved Track 2' })
      ];

      const playlistId = await service.saveToLibrary('My Summer Playlist', tracks, 'Custom description');
      expect(playlistId).toBeTruthy();

      const playlists = useLibraryStore.getState().playlists;
      const created = playlists.find((p) => p.id === playlistId);
      expect(created).toBeDefined();
      expect(created?.title).toBe('My Summer Playlist');
      expect(created?.description).toBe('Custom description');
      expect(created?.tracks).toHaveLength(2);
      expect(created?.tracks[0].title).toBe('Saved Track 1');
    });

    it('executes full importPlaylist end-to-end pipeline successfully', async () => {
      installFetchMock([
        {
          match: 'spotify.com/playlist/top',
          respond: () =>
            jsonResponse({
              title: 'Full Pipeline Playlist',
              items: [
                { title: 'Pipeline Track 1', artist: 'Artist 1' },
                { title: 'Pipeline Track 2', artist: 'Artist 2' }
              ]
            })
        }
      ]);

      vi.spyOn(searchAggregator, 'search').mockImplementation(async (query) => ({
        results: [createMockTrack({ id: `yt_${query}`, title: query })],
        sources: { youtube: 1, soundcloud: 0 }
      }));

      const progressSteps: number[] = [];
      const result = await service.importPlaylist('https://open.spotify.com/playlist/top', (res, _tot) => {
        progressSteps.push(res);
      });

      expect(result.title).toBe('Full Pipeline Playlist');
      expect(result.platform).toBe('spotify');
      expect(result.resolvedTracks).toHaveLength(2);
      expect(result.playlistId).toBeTruthy();
      expect(progressSteps).toEqual([1, 2]);

      const stored = useLibraryStore.getState().playlists.find((p) => p.id === result.playlistId);
      expect(stored).toBeDefined();
      expect(stored?.tracks).toHaveLength(2);
    });
  });

  // =========================================================================
  // 6. UI Modal: ImportPlaylistModal
  // =========================================================================
  describe('6. ImportPlaylistModal UI Component', () => {
    it('renders input, auto-detects platform badge, previews tracks, and runs import', async () => {
      const handleClose = vi.fn();
      const handleImported = vi.fn();

      installFetchMock([
        {
          match: 'open.spotify.com/playlist/test',
          respond: () =>
            jsonResponse({
              title: 'Synthwave Night Drive',
              items: [
                { title: 'Tech Noir', artist: 'GUNSHIP', duration: 297 },
                { title: 'Nightcall', artist: 'Kavinsky', duration: 259 }
              ]
            })
        }
      ]);

      vi.spyOn(searchAggregator, 'search').mockImplementation(async (query) => {
        // Отдаём ровно то, что просили, вместе с длительностью: оценщик её
        // сверяет, и «тот же трек, но на минуту короче» уже не проходит.
        const song = [
          { title: 'Tech Noir', artist: 'GUNSHIP', duration: 297 },
          { title: 'Nightcall', artist: 'Kavinsky', duration: 259 }
        ].find((entry) => query.includes(entry.title));
        return {
          results: song ? [createMockTrack({ id: `yt_${song.title.replace(/\s+/g, '_')}`, ...song })] : [],
          sources: { youtube: song ? 1 : 0, soundcloud: 0 }
        };
      });

      render(
        React.createElement(ImportPlaylistModal, {
          isOpen: true,
          onClose: handleClose,
          onImported: handleImported
        })
      );

      // Verify modal is open
      expect(screen.getByTestId('import-playlist-modal')).toBeInTheDocument();
      const input = screen.getByTestId('import-url-input');

      // Type Spotify URL
      fireEvent.change(input, {
        target: { value: 'https://open.spotify.com/playlist/test' }
      });

      // Platform badge appears
      expect(screen.getByTestId('platform-detected-badge')).toHaveTextContent('Spotify');

      // Click Fetch Playlist button
      const fetchBtn = screen.getByTestId('fetch-playlist-btn');
      fireEvent.click(fetchBtn);

      // Wait for Preview screen
      await waitFor(() => {
        expect(screen.getByTestId('preview-playlist-title')).toHaveTextContent('Synthwave Night Drive');
      });
      expect(screen.getByTestId('preview-track-list')).toHaveTextContent('Tech Noir');
      expect(screen.getByTestId('preview-track-list')).toHaveTextContent('Nightcall');

      // Click Start Import
      const startImportBtn = screen.getByTestId('start-import-btn');
      fireEvent.click(startImportBtn);

      // Wait for Complete screen
      await waitFor(() => {
        expect(screen.getByText(/Готово!/i)).toBeInTheDocument();
      });

      expect(handleImported).toHaveBeenCalled();
      // Оба трека нашлись — раздела «не нашли» быть не должно.
      expect(screen.queryByTestId('import-unmatched-list')).not.toBeInTheDocument();

      // Click Open Playlist
      const openBtn = screen.getByTestId('open-imported-playlist-btn');
      fireEvent.click(openBtn);

      expect(useUIStore.getState().activeView).toBe('playlist');
      expect(handleClose).toHaveBeenCalled();
    });

    it('переносит файл Wireon целиком, без поиска по источникам', async () => {
      const searchSpy = vi.spyOn(searchAggregator, 'search');
      const fileBody = JSON.stringify({
        format: 'wireon-playlist',
        version: 1,
        exportedAt: Date.now(),
        title: 'Ночная дорога',
        trackCount: 2,
        tracks: [
          {
            id: 'yt_road1',
            source: 'youtube',
            originalId: 'road1',
            title: 'Первая',
            artist: 'Мотор',
            duration: 200
          },
          {
            id: 'sc_road2',
            source: 'soundcloud',
            originalId: 'road2',
            title: 'Вторая',
            artist: 'Мотор',
            duration: 180
          }
        ]
      });

      render(
        React.createElement(ImportPlaylistModal, { isOpen: true, onClose: () => {} })
      );

      fireEvent.change(screen.getByTestId('import-file-input'), {
        target: { files: [playlistFile(fileBody, 'nochnaya-doroga.wireon.json')] }
      });

      await waitFor(() => {
        expect(screen.getByTestId('preview-playlist-title')).toHaveTextContent('Ночная дорога');
      });
      expect(screen.getByTestId('preview-file-badge')).toHaveTextContent('nochnaya-doroga.wireon.json');
      expect(screen.getByTestId('preview-track-list')).toHaveTextContent('Первая');

      fireEvent.click(screen.getByTestId('start-import-btn'));

      await waitFor(() => {
        expect(screen.getByText(/Готово!/i)).toBeInTheDocument();
      });

      // Треки пришли готовыми — искать их незачем.
      expect(searchSpy).not.toHaveBeenCalled();
      const created = useLibraryStore.getState().playlists.find((p) => p.title === 'Ночная дорога');
      expect(created?.tracks.map((t) => t.id)).toEqual(['yt_road1', 'sc_road2']);
    });

    it('читает m3u8 из другого плеера и ищет его строки в источниках', async () => {
      vi.spyOn(searchAggregator, 'search').mockImplementation(async (query) => {
        const song = [
          { title: 'Группа крови', artist: 'Кино', duration: 285 },
          { title: 'Пачка сигарет', artist: 'Кино', duration: 270 }
        ].find((entry) => query.includes(entry.title));
        return {
          results: song ? [createMockTrack({ id: `yt_${song.duration}`, ...song })] : [],
          sources: { youtube: song ? 1 : 0, soundcloud: 0 }
        };
      });

      const m3u = [
        '#EXTM3U',
        '#PLAYLIST:Старое',
        '#EXTINF:285,Кино - Группа крови',
        'https://www.youtube.com/watch?v=aaa',
        '#EXTINF:270,Кино - Пачка сигарет',
        'https://www.youtube.com/watch?v=bbb',
        ''
      ].join('\n');

      render(React.createElement(ImportPlaylistModal, { isOpen: true, onClose: () => {} }));

      fireEvent.change(screen.getByTestId('import-file-input'), {
        target: { files: [playlistFile(m3u, 'old.m3u8', 'audio/x-mpegurl')] }
      });

      await waitFor(() => {
        expect(screen.getByTestId('preview-playlist-title')).toHaveTextContent('Старое');
      });

      fireEvent.click(screen.getByTestId('start-import-btn'));

      await waitFor(() => {
        expect(screen.getByText(/Готово!/i)).toBeInTheDocument();
      });
      const created = useLibraryStore.getState().playlists.find((p) => p.title === 'Старое');
      expect(created?.tracks).toHaveLength(2);
    });

    it('показывает ненайденные строки и даёт выбрать трек вручную', async () => {
      vi.spyOn(searchAggregator, 'search').mockImplementation(async (query) => {
        if (query.includes('Tech Noir')) {
          return {
            results: [createMockTrack({ id: 'yt_tech', title: 'Tech Noir', artist: 'GUNSHIP', duration: 297 })],
            sources: { youtube: 1, soundcloud: 0 }
          };
        }
        // Для второго трека источники отдают только чужую версию — уверенного
        // совпадения нет, но выбрать её вручную пользователь вправе.
        return {
          results: [
            createMockTrack({
              id: 'yt_wrong',
              title: 'Nightcall (Karaoke Version)',
              artist: 'Karaoke Kings',
              duration: 259
            })
          ],
          sources: { youtube: 1, soundcloud: 0 }
        };
      });

      installFetchMock([
        {
          match: 'open.spotify.com/playlist/mixed',
          respond: () =>
            jsonResponse({
              title: 'Mixed Bag',
              items: [
                { title: 'Tech Noir', artist: 'GUNSHIP', duration: 297 },
                { title: 'Nightcall', artist: 'Kavinsky', duration: 259 }
              ]
            })
        }
      ]);

      render(React.createElement(ImportPlaylistModal, { isOpen: true, onClose: () => {} }));

      fireEvent.change(screen.getByTestId('import-url-input'), {
        target: { value: 'https://open.spotify.com/playlist/mixed' }
      });
      fireEvent.click(screen.getByTestId('fetch-playlist-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('preview-playlist-title')).toHaveTextContent('Mixed Bag');
      });
      fireEvent.click(screen.getByTestId('start-import-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('import-unmatched-list')).toBeInTheDocument();
      });
      const row = screen.getByTestId('import-unmatched-row-1');
      expect(row).toHaveTextContent('Nightcall');
      expect(row).toHaveTextContent('караоке');

      fireEvent.click(screen.getByTestId('import-manual-search-1'));

      const candidate = await waitFor(() =>
        screen.getByTestId('import-manual-candidate-1-yt_wrong')
      );
      fireEvent.click(candidate);

      await waitFor(() => {
        expect(screen.getByTestId('import-manual-added-1')).toBeInTheDocument();
      });
      const created = useLibraryStore.getState().playlists.find((p) => p.title === 'Mixed Bag');
      expect(created?.tracks.map((t) => t.id)).toEqual(['yt_tech', 'yt_wrong']);
    });

    it('объясняет, что файл не похож на плейлист', async () => {
      render(React.createElement(ImportPlaylistModal, { isOpen: true, onClose: () => {} }));

      fireEvent.change(screen.getByTestId('import-file-input'), {
        target: { files: [playlistFile('{"format":"spotify-export"}', 'strange.json')] }
      });

      await waitFor(() => {
        expect(screen.getByTestId('import-error-banner')).toHaveTextContent(/не файл плейлиста/i);
      });
    });

    it('shows error banner when invalid link is submitted', async () => {
      render(
        React.createElement(ImportPlaylistModal, {
          isOpen: true,
          onClose: () => {}
        })
      );

      const input = screen.getByTestId('import-url-input');
      fireEvent.change(input, {
        target: { value: 'https://unsupported.com/music' }
      });

      const fetchBtn = screen.getByTestId('fetch-playlist-btn');
      fireEvent.click(fetchBtn);

      await waitFor(() => {
        expect(screen.getByTestId('import-error-banner')).toBeInTheDocument();
      });
      expect(screen.getByTestId('import-error-banner')).toHaveTextContent(/Ссылка не подходит/i);
    });
  });
});
