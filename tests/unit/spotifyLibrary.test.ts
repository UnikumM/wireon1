/**
 * Чтение библиотеки Spotify (`src/services/spotifyLibrary.ts`).
 *
 * Главное, что здесь проверяется, — обход страниц. Ради него всё и затевалось:
 * публичная страница плейлиста отдаёт первую сотню треков, и человек видел
 * «импортировалось не всё» без единой ошибки на экране.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchLikedSongs, fetchPlaylistItems, fetchPlaylists } from '../../src/services/spotifyLibrary';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body
  };
}

function trackEntry(name: string) {
  return {
    track: {
      type: 'track',
      name,
      duration_ms: 210_000,
      artists: [{ name: 'Daft Punk' }],
      album: { name: 'Discovery', images: [{ url: 'https://example.com/cover.jpg' }] }
    }
  };
}

describe('spotifyLibrary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('идёт по всем страницам, а не забирает первую', async () => {
    const first = { items: [trackEntry('One'), trackEntry('Two')], next: 'https://api.spotify.com/v1/next-page' };
    const second = { items: [trackEntry('Three')], next: null };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse(second));
    vi.stubGlobal('fetch', fetchMock);

    const items = await fetchPlaylistItems('token', 'playlist-1');

    expect(items.map((i) => i.title)).toEqual(['One', 'Two', 'Three']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Вторая страница берётся по адресу, который дал сам Spotify.
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.spotify.com/v1/next-page');
  });

  it('переносит длительность, исполнителя и альбом', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [trackEntry('One')], next: null })));

    const [item] = await fetchPlaylistItems('token', 'playlist-1');

    expect(item).toMatchObject({
      title: 'One',
      artist: 'Daft Punk',
      duration: 210,
      album: 'Discovery'
    });
  });

  it('пропускает подкасты и пустые строки', async () => {
    const body = {
      items: [
        trackEntry('Песня'),
        { track: { type: 'episode', name: 'Выпуск подкаста' } },
        { track: null },
        { track: { type: 'track', name: '   ' } }
      ],
      next: null
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));

    const items = await fetchPlaylistItems('token', 'playlist-1');
    expect(items.map((i) => i.title)).toEqual(['Песня']);
  });

  it('«Любимые» читаются тем же способом', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [trackEntry('Любимая')], next: null })));
    const items = await fetchLikedSongs('token');
    expect(items).toHaveLength(1);
  });

  it('список плейлистов приводится к короткому виду', async () => {
    const body = {
      items: [
        { id: 'p1', name: 'Дорога', tracks: { total: 240 }, owner: { display_name: 'Я' }, images: [{ url: 'u' }] },
        { id: 'p2', name: '', tracks: {}, owner: {} }
      ],
      next: null
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));

    const playlists = await fetchPlaylists('token');

    expect(playlists[0]).toEqual({ id: 'p1', name: 'Дорога', trackCount: 240, owner: 'Я', coverUrl: 'u' });
    expect(playlists[1].name).toBe('Плейлист без названия');
  });

  it('устаревший вход виден по-человечески, а не как «HTTP 401»', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    await expect(fetchPlaylists('token')).rejects.toThrow(/войдите заново/i);
  });
});
