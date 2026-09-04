import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '../setup';
import {
  artistService,
  ArtistService,
  extractTrackCount,
  extractYear
} from '../../src/services/artistService';
import { ArtistHubView } from '../../src/components/artist/ArtistHubView';
import { TrackCard } from '../../src/components/search/TrackCard';
import { PlayerBar } from '../../src/components/player/PlayerBar';
import { FullscreenPlayer } from '../../src/components/player/FullscreenPlayer';
import { QueueDrawer } from '../../src/components/player/QueueDrawer';
import { useUIStore } from '../../src/store/useUIStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { createMockTrack } from '../helpers/mockData';
import {
  installFetchMock,
  jsonResponse,
  httpErrorResponse,
  flushAsync,
  resetUIStore,
  resetPlayerStore,
  FetchRoute
} from '../helpers/testUtils';
import {
  artistSearchRow,
  artistSearchPayload as searchResponse,
  artistSongRow as songRow,
  artistTwoRowItem as twoRowItem,
  artistCarouselShelf as carousel,
  artistSongShelf as songShelf,
  artistBrowsePayload as browseResponse,
  wikipediaSummary as wikiSummary
} from '../helpers/networkFixtures';

// ---------------------------------------------------------------------------
// The InnerTube fixture builders live in `tests/helpers/networkFixtures.ts`
// alongside the other wire-format builders, so the artist parser and the e2e
// workflows are held to the same payload shapes.
// ---------------------------------------------------------------------------

/** Routes for a fully-populated Pink Floyd profile. */
function pinkFloydRoutes(): FetchRoute[] {
  return [
    {
      match: '/youtubei/v1/search',
      respond: () =>
        jsonResponse(
          searchResponse([
            artistSearchRow({ browseId: 'PL_not_a_channel', name: 'Pink Floyd Mix' }),
            artistSearchRow({
              browseId: 'UCY2qt3dw2TQJxvBrDiYGHdQ',
              name: 'Pink Floyd',
              subtitle: 'Исполнитель · 4,5 млн подписчиков',
              thumbUrl: 'https://lh3.googleusercontent.com/pf'
            })
          ])
        )
    },
    {
      match: '/youtubei/v1/browse',
      respond: () =>
        jsonResponse(
          browseResponse({
            name: 'Pink Floyd',
            description: 'Британская рок-группа, образованная в Лондоне в 1965 году.',
            subscribers: '4,5 млн подписчиков',
            avatarUrl: 'https://lh3.googleusercontent.com/pf-large',
            sections: [
              songShelf('Песни', [
                songRow({
                  videoId: 'JwYX52BP2Sk',
                  title: 'Money',
                  secondary: ['Pink Floyd', 'The Dark Side of the Moon'],
                  duration: '6:23',
                  thumbUrl: 'https://i.ytimg.com/money.jpg'
                }),
                songRow({
                  videoId: '_FrOQC-zEog',
                  title: 'Time',
                  secondary: ['Pink Floyd', 'The Dark Side of the Moon'],
                  duration: '7:01'
                })
              ]),
              carousel('Альбомы', [
                twoRowItem({
                  title: 'The Dark Side of the Moon',
                  subtitle: 'Альбом • 1973',
                  browseId: 'MPREb_dsotm',
                  thumbUrl: 'https://lh3.googleusercontent.com/dsotm'
                }),
                twoRowItem({ title: 'Wish You Were Here', subtitle: 'Альбом • 1975 • 5 треков' })
              ]),
              carousel('Похожие исполнители', [
                twoRowItem({
                  title: 'Roger Waters',
                  browseId: 'UCroger',
                  thumbUrl: 'https://lh3.googleusercontent.com/rw'
                }),
                twoRowItem({ title: 'David Gilmour', browseId: 'UCdavid' })
              ])
            ]
          })
        )
    },
    {
      match: 'ru.wikipedia.org',
      respond: () =>
        jsonResponse(
          wikiSummary(
            'Pink Floyd — британская рок-группа, знаменитая своими психоделическими и философскими композициями, а также концертными шоу.'
          )
        )
    }
  ];
}

describe('ArtistService & ArtistHubView Component Tests', () => {
  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    cleanup();
    resetUIStore();
    resetPlayerStore();
    artistService.clearCache();
  });

  afterEach(async () => {
    await flushAsync();
    vi.unstubAllGlobals();
    cleanup();
    artistService.clearCache();
  });

  describe('Subtitle parsing', () => {
    it('extracts a release year only from a plausible year range', () => {
      expect(extractYear('Альбом • 1973')).toBe('1973');
      expect(extractYear('Single • 2021 • 3 songs')).toBe('2021');
      expect(extractYear('Альбом')).toBeUndefined();
      // A track count must never be mistaken for a year.
      expect(extractYear('Альбом • 12 треков')).toBeUndefined();
      expect(extractYear('EP • 1899')).toBeUndefined();
    });

    it('extracts a track count in either language, and nothing when absent', () => {
      expect(extractTrackCount('Альбом • 1975 • 5 треков')).toBe(5);
      expect(extractTrackCount('Album • 1975 • 5 songs')).toBe(5);
      expect(extractTrackCount('Альбом • 1 трек')).toBe(1);
      expect(extractTrackCount('Альбом • 1973')).toBeUndefined();
      expect(extractTrackCount('Сингл')).toBeUndefined();
    });
  });

  describe('Service Unit Logic', () => {
    it('validates artistName input and throws if empty or whitespace', async () => {
      await expect(artistService.getArtistProfile('')).rejects.toThrow(/Artist name is required/);
      await expect(artistService.getArtistProfile('   ')).rejects.toThrow(/Artist name is required/);
      // @ts-expect-error test null input
      await expect(artistService.getArtistProfile(null)).rejects.toThrow(/Artist name is required/);
      // @ts-expect-error test undefined input
      await expect(artistService.getArtistProfile(undefined)).rejects.toThrow(/Artist name is required/);
    });

    it('builds a profile entirely out of real InnerTube and Wikipedia data', async () => {
      installFetchMock(pinkFloydRoutes());

      const profile = await artistService.getArtistProfile('Pink Floyd');

      expect(profile.name).toBe('Pink Floyd');
      expect(profile.channelId).toBe('UCY2qt3dw2TQJxvBrDiYGHdQ');
      // Largest thumbnail wins, not the first one listed.
      expect(profile.avatarUrl).toBe('https://lh3.googleusercontent.com/pf-large');
      expect(profile.subscriberCount).toBe('4,5 млн подписчиков');
      expect(profile.isSparse).toBeUndefined();

      // Wikipedia outranks the channel's own description.
      expect(profile.bio).toContain('психоделическими');
      expect(profile.bioSource).toBe('wikipedia-ru');

      expect(profile.topTracks.map((t) => t.title)).toEqual(['Money', 'Time']);
      expect(profile.topTracks[0]).toMatchObject({
        id: 'yt_JwYX52BP2Sk',
        source: 'youtube',
        originalId: 'JwYX52BP2Sk',
        artist: 'Pink Floyd',
        album: 'The Dark Side of the Moon',
        duration: 383,
        durationFormatted: '6:23',
        artworkUrl: 'https://i.ytimg.com/money.jpg',
        sourceUrl: 'https://www.youtube.com/watch?v=JwYX52BP2Sk'
      });

      expect(profile.albums).toHaveLength(2);
      expect(profile.albums[0]).toMatchObject({
        id: 'MPREb_dsotm',
        browseId: 'MPREb_dsotm',
        title: 'The Dark Side of the Moon',
        year: '1973',
        coverUrl: 'https://lh3.googleusercontent.com/dsotm'
      });
      // Nothing reported a track count for this one, so it has none.
      expect(profile.albums[0].trackCount).toBeUndefined();
      expect(profile.albums[1]).toMatchObject({ title: 'Wish You Were Here', year: '1975', trackCount: 5 });

      expect(profile.similarArtists).toEqual([
        { name: 'Roger Waters', imageUrl: 'https://lh3.googleusercontent.com/rw', browseId: 'UCroger' },
        { name: 'David Gilmour', imageUrl: undefined, browseId: 'UCdavid' }
      ]);
    });

    it('prefers an exact name match over YouTube own ranking', async () => {
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: () =>
            jsonResponse(
              searchResponse([
                artistSearchRow({ browseId: 'UCtribute', name: 'Nirvana Tribute Band' }),
                artistSearchRow({ browseId: 'UCreal', name: 'Nirvana' })
              ])
            )
        },
        { match: '/youtubei/v1/browse', respond: () => jsonResponse(browseResponse({ name: 'Nirvana' })) },
        { match: 'wikipedia.org', respond: () => httpErrorResponse(404) }
      ]);

      const profile = await artistService.getArtistProfile('Nirvana');
      expect(profile.channelId).toBe('UCreal');
    });

    it('falls back to the first candidate when nothing matches exactly', async () => {
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: () =>
            jsonResponse(searchResponse([artistSearchRow({ browseId: 'UCclose', name: 'The Beatles' })]))
        },
        {
          match: '/youtubei/v1/browse',
          respond: () =>
            jsonResponse(
              browseResponse({
                name: 'The Beatles',
                sections: [songShelf('Песни', [songRow({ videoId: 'abc12345678', title: 'Help!' })])]
              })
            )
        },
        { match: 'wikipedia.org', respond: () => httpErrorResponse(404) }
      ]);

      const profile = await artistService.getArtistProfile('Beatles');
      expect(profile.channelId).toBe('UCclose');
      expect(profile.name).toBe('The Beatles');
    });

    it('ignores search rows that are playlists rather than artist channels', async () => {
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: () =>
            jsonResponse(
              searchResponse([
                artistSearchRow({ browseId: 'VLPL_mix', name: 'Adele Radio' }),
                artistSearchRow({ browseId: 'MPREb_album', name: 'Adele — 30' })
              ])
            )
        },
        { match: 'wikipedia.org', respond: () => jsonResponse(wikiSummary('x'.repeat(60))) },
        // No channel found, so the aggregator supplies the tracks.
        { match: 'piped', respond: () => httpErrorResponse(502) },
        { match: 'invidious', respond: () => httpErrorResponse(502) }
      ], { fallback: () => httpErrorResponse(502) });

      const profile = await artistService.getArtistProfile('Adele');
      expect(profile.channelId).toBeUndefined();
      expect(profile.albums).toEqual([]);
    });

    it('clamps top tracks to at most 10 items', async () => {
      const rows = Array.from({ length: 20 }, (_, i) =>
        songRow({ videoId: `vid${String(i).padStart(8, '0')}`, title: `Song ${i + 1}`, secondary: ['Muse'] })
      );

      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: () => jsonResponse(searchResponse([artistSearchRow({ browseId: 'UCmuse', name: 'Muse' })]))
        },
        {
          match: '/youtubei/v1/browse',
          respond: () => jsonResponse(browseResponse({ name: 'Muse', sections: [songShelf('Песни', rows)] }))
        },
        { match: 'wikipedia.org', respond: () => httpErrorResponse(404) }
      ]);

      const profile = await artistService.getArtistProfile('Muse');
      expect(profile.topTracks).toHaveLength(10);
      expect(profile.topTracks[0].title).toBe('Song 1');
      expect(profile.topTracks[9].title).toBe('Song 10');
    });

    it('skips a Wikipedia disambiguation page and a too-short extract', async () => {
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: () => jsonResponse(searchResponse([artistSearchRow({ browseId: 'UCq', name: 'Queen' })]))
        },
        {
          match: '/youtubei/v1/browse',
          respond: () =>
            jsonResponse(browseResponse({ name: 'Queen', description: 'Описание с канала YouTube Music.' }))
        },
        { match: 'ru.wikipedia.org', respond: () => jsonResponse(wikiSummary('Queen', 'disambiguation')) },
        { match: 'en.wikipedia.org', respond: () => jsonResponse(wikiSummary('Short.')) }
      ]);

      const profile = await artistService.getArtistProfile('Queen');
      // Both Wikipedia answers were unusable, so the channel description shows —
      // credited as such, never as an encyclopaedia entry.
      expect(profile.bio).toBe('Описание с канала YouTube Music.');
      expect(profile.bioSource).toBe('youtube-music');
    });

    it('falls back to English Wikipedia when the Russian page is missing', async () => {
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: () => jsonResponse(searchResponse([artistSearchRow({ browseId: 'UCa', name: 'Aphex Twin' })]))
        },
        { match: '/youtubei/v1/browse', respond: () => jsonResponse(browseResponse({ name: 'Aphex Twin' })) },
        { match: 'ru.wikipedia.org', respond: () => httpErrorResponse(404) },
        {
          match: 'en.wikipedia.org',
          respond: () =>
            jsonResponse(
              wikiSummary('Richard David James, known professionally as Aphex Twin, is an Irish-born musician.')
            )
        }
      ]);

      const profile = await artistService.getArtistProfile('Aphex Twin');
      expect(profile.bioSource).toBe('wikipedia-en');
      expect(profile.bio).toContain('Aphex Twin');
    });

    it('marks a profile sparse when every source comes back empty', async () => {
      installFetchMock([], { fallback: () => httpErrorResponse(503) });

      const profile = await artistService.getArtistProfile('Не Существующий Артист');
      expect(profile.name).toBe('Не Существующий Артист');
      expect(profile.isSparse).toBe(true);
      expect(profile.topTracks).toEqual([]);
      expect(profile.albums).toEqual([]);
      expect(profile.bio).toBeUndefined();
    });

    it('degrades to a named profile instead of throwing when the network dies', async () => {
      installFetchMock([], {
        fallback: () => {
          throw new Error('ENOTFOUND music.youtube.com');
        }
      });

      // No rejection: a thrown fetch is a missing source, not a broken app.
      const profile = await artistService.getArtistProfile('Offline Artist');
      expect(profile.name).toBe('Offline Artist');
      expect(profile.isSparse).toBe(true);
    });

    it('survives a malformed InnerTube payload without throwing', async () => {
      installFetchMock([
        { match: '/youtubei/v1/search', respond: () => jsonResponse({ contents: null }) },
        { match: 'wikipedia.org', respond: () => httpErrorResponse(404) },
        { match: 'piped', respond: () => httpErrorResponse(502) },
        { match: 'invidious', respond: () => httpErrorResponse(502) }
      ], { fallback: () => httpErrorResponse(502) });

      const profile = await artistService.getArtistProfile('Garbage Payload');
      expect(profile.isSparse).toBe(true);
    });

    it('caches profiles in memory, case-insensitively', async () => {
      const mock = installFetchMock(pinkFloydRoutes());

      const first = await artistService.getArtistProfile('Pink Floyd');
      const callsAfterFirst = mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      const second = await artistService.getArtistProfile('Pink Floyd');
      expect(second).toBe(first);

      const third = await artistService.getArtistProfile('pink floyd');
      expect(third).toBe(first);
      expect(mock.calls.length).toBe(callsAfterFirst);
    });

    it('shares one round of requests between concurrent callers', async () => {
      const mock = installFetchMock(pinkFloydRoutes());

      const [a, b, c] = await Promise.all([
        artistService.getArtistProfile('Pink Floyd'),
        artistService.getArtistProfile('Pink Floyd'),
        artistService.getArtistProfile('PINK FLOYD')
      ]);

      expect(a).toBe(b);
      expect(b).toBe(c);
      // One search + one browse + one wiki: no request was made three times.
      expect(mock.calls.filter((u) => u.includes('/youtubei/v1/browse'))).toHaveLength(1);
    });

    it('clearCache drops entries so the next call refetches', async () => {
      const mock = installFetchMock(pinkFloydRoutes());

      await artistService.getArtistProfile('Pink Floyd');
      const before = mock.calls.length;

      artistService.clearCache();
      await artistService.getArtistProfile('Pink Floyd');

      expect(mock.calls.length).toBeGreaterThan(before);
    });

    it('handles non-Latin names and slashes in the query', async () => {
      const seen: string[] = [];
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: (_url, init) => {
            seen.push(String(JSON.parse(String(init?.body)).query));
            return jsonResponse(searchResponse([artistSearchRow({ browseId: 'UCz', name: 'Земфира' })]));
          }
        },
        {
          match: '/youtubei/v1/browse',
          respond: () =>
            jsonResponse(
              browseResponse({
                name: 'Земфира',
                sections: [songShelf('Песни', [songRow({ videoId: 'iskala12345', title: 'Искала' })])]
              })
            )
        },
        {
          match: 'ru.wikipedia.org',
          respond: (url) => {
            seen.push(url);
            return jsonResponse(wikiSummary('Земфира Талгатовна Рамазанова — российская рок-певица и композитор.'));
          }
        }
      ]);

      const profile = await artistService.getArtistProfile('Земфира');
      expect(profile.name).toBe('Земфира');
      expect(profile.topTracks[0].title).toBe('Искала');
      // The name goes into the JSON body verbatim and into the URL encoded.
      expect(seen).toContain('Земфира');
      expect(seen.some((s) => s.includes('%D0%97%D0%B5%D0%BC%D1%84%D0%B8%D1%80%D0%B0'))).toBe(true);
    });

    it('requests the Russian interface language from InnerTube', async () => {
      // Only the first search is ours; when it finds no channel the aggregator
      // makes its own InnerTube call, which asks for `en`.
      let body: Record<string, unknown> | null = null;
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: (_url, init) => {
            body = body ?? JSON.parse(String(init?.body));
            return jsonResponse(searchResponse([]));
          }
        },
        { match: 'wikipedia.org', respond: () => httpErrorResponse(404) }
      ], { fallback: () => httpErrorResponse(502) });

      await artistService.getArtistProfile('Anything');
      const context = (body as unknown as { context: { client: { hl: string; gl: string } } }).context;
      expect(context.client.hl).toBe('ru');
      expect(context.client.gl).toBe('RU');
    });

    it('keeps instances isolated', async () => {
      const custom = new ArtistService();
      installFetchMock(pinkFloydRoutes());

      const fromCustom = await custom.getArtistProfile('Pink Floyd');
      const fromShared = await artistService.getArtistProfile('Pink Floyd');

      expect(fromCustom.name).toBe('Pink Floyd');
      // Separate caches: the objects are equal in content but not identity.
      expect(fromCustom).not.toBe(fromShared);
    });

    it('falls back to the aggregator for top tracks and filters foreign artists', async () => {
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: () => jsonResponse(searchResponse([]))
        },
        {
          match: 'ru.wikipedia.org',
          respond: () => jsonResponse(wikiSummary('Сплин — российская рок-группа из Санкт-Петербурга.'))
        },
        {
          // Piped is the aggregator's first YouTube pool.
          match: 'pipedapi',
          respond: () =>
            jsonResponse({
              items: [
                { url: '/watch?v=splin1234567', title: 'Выхода нет', uploaderName: 'Сплин', duration: 240 },
                { url: '/watch?v=other1234567', title: 'Что-то ещё', uploaderName: 'Другая группа', duration: 200 }
              ]
            })
        }
      ], { fallback: () => httpErrorResponse(502) });

      const profile = await artistService.getArtistProfile('Сплин');
      expect(profile.bioSource).toBe('wikipedia-ru');
      // Only the track that actually credits Сплин survives.
      expect(profile.topTracks.every((t) => t.artist.toLowerCase().includes('сплин'))).toBe(true);
    });
  });

  /**
   * Альбомы на странице исполнителя были картинками и только: у карточки не
   * было ни обработчика, ни кнопки, ни клавиатурного пути, и в самом стиле
   * стоял `cursor: default`. Владелец сказал об этом прямо: «у исполнителей
   * нельзя открыть врубить альбом».
   */
  describe('Состав альбома', () => {
    /** Ответ на альбом приходит в другой раскладке, чем страница исполнителя. */
    const albumPayload = {
      contents: {
        twoColumnBrowseResultsRenderer: {
          secondaryContents: {
            sectionListRenderer: {
              contents: [
                {
                  musicShelfRenderer: {
                    contents: [
                      {
                        musicResponsiveListItemRenderer: {
                          playlistItemData: { videoId: 'aaa11111111' },
                          flexColumns: [
                            {
                              musicResponsiveListItemFlexColumnRenderer: {
                                text: { runs: [{ text: 'Speak to Me' }] }
                              }
                            },
                            {
                              musicResponsiveListItemFlexColumnRenderer: {
                                text: { runs: [{ text: 'Pink Floyd' }] }
                              }
                            }
                          ],
                          fixedColumns: [
                            {
                              musicResponsiveListItemFixedColumnRenderer: {
                                text: { runs: [{ text: '1:07' }] }
                              }
                            }
                          ]
                        }
                      },
                      {
                        musicResponsiveListItemRenderer: {
                          playlistItemData: { videoId: 'bbb22222222' },
                          flexColumns: [
                            {
                              musicResponsiveListItemFlexColumnRenderer: {
                                text: { runs: [{ text: 'Breathe' }] }
                              }
                            },
                            {
                              musicResponsiveListItemFlexColumnRenderer: {
                                text: { runs: [{ text: 'Pink Floyd' }] }
                              }
                            }
                          ],
                          fixedColumns: [
                            {
                              musicResponsiveListItemFixedColumnRenderer: {
                                text: { runs: [{ text: '2:43' }] }
                              }
                            }
                          ]
                        }
                      }
                    ]
                  }
                }
              ]
            }
          }
        }
      }
    };

    it('достаёт треки альбома, хотя лежат они в другой раскладке', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => albumPayload
      });
      vi.stubGlobal('fetch', fetchMock);

      const tracks = await artistService.getAlbumTracks('MPREb_test', 'Pink Floyd');

      expect(tracks).toHaveLength(2);
      expect(tracks[0].id).toBe('yt_aaa11111111');
      expect(tracks[0].title).toBe('Speak to Me');
      expect(tracks[0].artist).toBe('Pink Floyd');
      expect(tracks[0].duration).toBe(67);
      expect(tracks[1].title).toBe('Breathe');

      // Состав альбома не меняется, а нажимают на карточку не по одному разу.
      await artistService.getAlbumTracks('MPREb_test', 'Pink Floyd');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('пустой ответ — это пусто, а не выдуманный список', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ contents: {} }) })
      );
      expect(await artistService.getAlbumTracks('MPREb_empty', 'Кто-то')).toEqual([]);
    });

    it('отказ сети не роняет страницу', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      expect(await artistService.getAlbumTracks('MPREb_dead', 'Кто-то')).toEqual([]);
    });

    it('без browseId запрос не уходит вовсе', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      expect(await artistService.getAlbumTracks('', 'Кто-то')).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('ArtistHubView UI Rendering', () => {
    it('renders the hero, tracks, discography, similar artists and a credited bio', async () => {
      installFetchMock(pinkFloydRoutes());

      await act(async () => {
        render(React.createElement(ArtistHubView, { artistName: 'Pink Floyd' }));
      });

      await waitFor(() => {
        expect(screen.getByTestId('artist-name-heading')).toHaveTextContent('Pink Floyd');
      });

      expect(screen.getByTestId('artist-subscribers')).toHaveTextContent('4,5 млн подписчиков');
      expect(screen.getByTestId('artist-play-all-btn')).toHaveTextContent('Слушать');
      expect(screen.getByTestId('artist-radio-btn')).toHaveTextContent('Радио');
      expect(screen.getByTestId('artist-top-tracks-section')).toHaveTextContent('Популярные треки');
      expect(screen.getByTestId('artist-discography-section')).toHaveTextContent('Дискография');
      expect(screen.getByTestId('artist-similar-section')).toHaveTextContent('Похожие исполнители');
      expect(screen.getByTestId('artist-bio-source')).toHaveTextContent('Википедия');

      // Nothing tells us this artist is verified, so no badge is invented.
      expect(screen.queryByTestId('artist-verified-badge')).toBeNull();
      expect(screen.queryByTestId('artist-monthly-listeners')).toBeNull();
    });

    it('карточка альбома — кнопка, и она включает альбом', async () => {
      installFetchMock(pinkFloydRoutes());

      const tracks = [
        {
          id: 'yt_aaa11111111',
          source: 'youtube',
          originalId: 'aaa11111111',
          title: 'Speak to Me',
          artist: 'Pink Floyd',
          duration: 67
        }
      ];
      const getAlbumTracks = vi.spyOn(artistService, 'getAlbumTracks').mockResolvedValue(tracks as never);
      // Подмена ставится до отрисовки: экран берёт `playTrack` селектором, и
      // замена уже после первого прохода до обработчика не доезжает.
      const playTrack = vi.fn().mockResolvedValue(undefined);
      usePlayerStore.setState({ playTrack: playTrack as never });

      await act(async () => {
        render(React.createElement(ArtistHubView, { artistName: 'Pink Floyd' }));
      });

      await waitFor(() => {
        expect(screen.getByTestId('artist-album-MPREb_dsotm')).toBeInTheDocument();
      });

      const card = screen.getByTestId('artist-album-MPREb_dsotm');
      // Раньше это был `div` с `cursor: default` — нажать было не на что, и до
      // клавиатуры карточка не доходила вовсе.
      expect(card.tagName).toBe('BUTTON');
      expect(card.getAttribute('aria-label')).toContain('Включить альбом');

      await act(async () => {
        fireEvent.click(card);
      });

      await waitFor(() => {
        expect(getAlbumTracks).toHaveBeenCalledWith('MPREb_dsotm', 'Pink Floyd');
      });
      await waitFor(() => {
        expect(playTrack).toHaveBeenCalledWith(tracks[0], tracks, 0);
      });
    });

    it('shows a real year and a Russian track count on album cards', async () => {
      installFetchMock(pinkFloydRoutes());

      await act(async () => {
        render(React.createElement(ArtistHubView, { artistName: 'Pink Floyd' }));
      });

      await waitFor(() => {
        expect(screen.getByTestId('artist-album-MPREb_dsotm')).toBeInTheDocument();
      });

      const dsotm = screen.getByTestId('artist-album-MPREb_dsotm');
      expect(dsotm).toHaveTextContent('1973');
      // No count was reported for this album, so no count is shown.
      expect(dsotm).not.toHaveTextContent(/трек/);

      const wywh = screen.getByTestId('artist-album-album_wish_you_were_here');
      expect(wywh).toHaveTextContent('1975');
      expect(wywh).toHaveTextContent('5 треков');
    });

    it('omits the biography section entirely when no source has one', async () => {
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: () => jsonResponse(searchResponse([artistSearchRow({ browseId: 'UCnobio', name: 'No Bio' })]))
        },
        {
          match: '/youtubei/v1/browse',
          respond: () =>
            jsonResponse(
              browseResponse({
                name: 'No Bio',
                sections: [songShelf('Песни', [songRow({ videoId: 'nobio123456', title: 'Track' })])]
              })
            )
        },
        { match: 'wikipedia.org', respond: () => httpErrorResponse(404) }
      ]);

      await act(async () => {
        render(React.createElement(ArtistHubView, { artistName: 'No Bio' }));
      });

      await waitFor(() => {
        expect(screen.getByTestId('artist-name-heading')).toHaveTextContent('No Bio');
      });

      expect(screen.queryByTestId('artist-bio-section')).toBeNull();
    });

    it('clicking a similar artist opens that artist', async () => {
      installFetchMock(pinkFloydRoutes());

      await act(async () => {
        render(React.createElement(ArtistHubView, { artistName: 'Pink Floyd' }));
      });

      await waitFor(() => {
        expect(screen.getByTestId('similar-artist-card-0')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('similar-artist-card-0'));

      expect(useUIStore.getState().activeView).toBe('artist');
      expect(useUIStore.getState().selectedArtistName).toBe('Roger Waters');
    });

    it('toggles a long biography between excerpt and full text, in Russian', async () => {
      const longBio = 'Очень длинная биография для проверки раскрытия текста. '.repeat(10);
      installFetchMock([
        {
          match: '/youtubei/v1/search',
          respond: () => jsonResponse(searchResponse([artistSearchRow({ browseId: 'UClong', name: 'LongBio' })]))
        },
        { match: '/youtubei/v1/browse', respond: () => jsonResponse(browseResponse({ name: 'LongBio' })) },
        { match: 'ru.wikipedia.org', respond: () => jsonResponse(wikiSummary(longBio)) }
      ]);

      await act(async () => {
        render(React.createElement(ArtistHubView, { artistName: 'LongBio' }));
      });

      await waitFor(() => {
        expect(screen.getByTestId('artist-bio-toggle-btn')).toBeInTheDocument();
      });

      const toggle = screen.getByTestId('artist-bio-toggle-btn');
      expect(toggle).toHaveTextContent('Читать полностью');
      expect(screen.getByTestId('artist-bio-text').textContent).toContain('…');

      fireEvent.click(toggle);
      expect(toggle).toHaveTextContent('Свернуть');
      expect(screen.getByTestId('artist-bio-text').textContent).not.toContain('…');
    });

    it('shows a not-found state with a working retry when nothing resolves', async () => {
      const mock = installFetchMock([], { fallback: () => httpErrorResponse(503) });

      await act(async () => {
        render(React.createElement(ArtistHubView, { artistName: 'Никто' }));
      });

      await waitFor(() => {
        expect(screen.getByTestId('artist-hub-error')).toBeInTheDocument();
      });

      expect(screen.getByTestId('artist-hub-error')).toHaveTextContent('Исполнитель не найден');

      const before = mock.calls.length;
      await act(async () => {
        fireEvent.click(screen.getByTestId('artist-hub-retry-btn'));
      });

      // The retry clears the cache, so it actually goes back to the network
      // rather than re-reading the empty result we just stored.
      await waitFor(() => {
        expect(mock.calls.length).toBeGreaterThan(before);
      });
    });
  });

  describe('Universal Clickable Artist Navigation in other components', () => {
    it('TrackCard artist click opens Artist Hub', () => {
      const track = createMockTrack({ id: 'yt_tc_1', title: 'Song 1', artist: 'The Prodigy' });

      render(React.createElement(TrackCard, { track, layout: 'row' }));

      const artistSpan = screen.getByTestId('track-artist-yt_tc_1');
      fireEvent.click(artistSpan);

      expect(useUIStore.getState().activeView).toBe('artist');
      expect(useUIStore.getState().selectedArtistName).toBe('The Prodigy');
    });

    it('PlayerBar artist click opens Artist Hub', () => {
      const track = createMockTrack({ id: 'yt_pb_1', title: 'Song 1', artist: 'Chemical Brothers' });
      usePlayerStore.setState({ currentTrack: track });

      render(React.createElement(PlayerBar));

      const artistBtn = screen.getByTestId('player-track-artist');
      fireEvent.click(artistBtn);

      expect(useUIStore.getState().activeView).toBe('artist');
      expect(useUIStore.getState().selectedArtistName).toBe('Chemical Brothers');
    });

    it('FullscreenPlayer artist click opens Artist Hub', () => {
      const track = createMockTrack({ id: 'yt_fs_1', title: 'Song 1', artist: 'Justice' });
      usePlayerStore.setState({ currentTrack: track });
      useUIStore.setState({ isFullscreenPlayerOpen: true });

      render(React.createElement(FullscreenPlayer));

      const artistBtn = screen.getByTestId('fullscreen-track-artist');
      fireEvent.click(artistBtn);

      expect(useUIStore.getState().activeView).toBe('artist');
      expect(useUIStore.getState().selectedArtistName).toBe('Justice');
    });

    it('QueueDrawer artist click opens Artist Hub and closes queue', () => {
      const track = createMockTrack({ id: 'yt_qd_1', title: 'Song 1', artist: 'Massive Attack' });
      usePlayerStore.setState({ currentTrack: track, userQueue: [track] });
      useUIStore.setState({ isQueueOpen: true });

      render(React.createElement(QueueDrawer));

      const artistBtn = screen.getByTestId('queue-now-playing-artist');
      fireEvent.click(artistBtn);

      expect(useUIStore.getState().activeView).toBe('artist');
      expect(useUIStore.getState().selectedArtistName).toBe('Massive Attack');
      expect(useUIStore.getState().isQueueOpen).toBe(false);
    });
  });
});
