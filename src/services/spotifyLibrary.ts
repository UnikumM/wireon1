/**
 * Чтение библиотеки Spotify через их API.
 *
 * Главное отличие от разбора публичной страницы (playlistImporter): здесь нет
 * потолка в сотню треков. API отдаёт списки страницами и сам говорит адрес
 * следующей — идём по ним до конца.
 *
 * Отсюда возвращаются только названия и исполнители. Звук со Spotify не берётся
 * и не может быть взят: он защищён, и обходить эту защиту мы не будем. Найти и
 * сыграть найденное — работа наших источников.
 */

import { ParsedPlaylistItem } from './playlistImporter';

const API = 'https://api.spotify.com/v1';

/** Крупнее Spotify не отдаёт, а мельче — лишние запросы. */
const PAGE_SIZE = 50;

/** Защита от бесконечного хождения по страницам, если API вернёт круг. */
const MAX_PAGES = 200;

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
  owner: string;
  coverUrl?: string;
}

interface SpotifyPage<T> {
  items?: T[];
  next?: string | null;
}

async function apiGet<T>(token: string, url: string): Promise<T> {
  const response = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (response.status === 401) throw new Error('Вход в Spotify устарел — войдите заново');
  if (response.status === 429) {
    // Spotify просит подождать; сколько именно — говорит заголовком.
    const retry = Number(response.headers.get('Retry-After') || '2');
    throw new Error(`Spotify просит подождать ${Math.max(1, retry)} с и повторить`);
  }
  if (!response.ok) {
    // Причина лежит в теле ответа, и без неё 403 не отличить от 403: «вас нет в
    // списке разрешённых», «не выданы права» и «приложению закрыли доступ»
    // выглядят одинаково, а чинятся по-разному.
    const detail = await response
      .json()
      .then((body: any) => String(body?.error?.message || body?.error || '').trim())
      .catch(() => '');

    if (response.status === 403) {
      throw new Error(
        detail
          ? `Spotify отказал (403): ${detail}`
          : 'Spotify отказал (403) без объяснения — обычно это режим разработки: аккаунт не добавлен в User Management'
      );
    }
    throw new Error(detail ? `Spotify ответил HTTP ${response.status}: ${detail}` : `Spotify ответил HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

/** Идёт по страницам до конца и собирает всё в один список. */
async function collect<T>(token: string, firstUrl: string): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = firstUrl;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const page: SpotifyPage<T> = await apiGet<SpotifyPage<T>>(token, url);
    if (Array.isArray(page.items)) all.push(...page.items);
    url = page.next || null;
    pages += 1;
  }

  return all;
}

/** Все плейлисты, к которым у человека есть доступ, — свои и подписки. */
export async function fetchPlaylists(token: string): Promise<SpotifyPlaylistSummary[]> {
  const raw = await collect<any>(token, `/me/playlists?limit=${PAGE_SIZE}`);
  return raw
    .filter((item) => item && item.id)
    .map((item) => ({
      id: String(item.id),
      name: typeof item.name === 'string' && item.name ? item.name : 'Плейлист без названия',
      // С марта 2026 поле называется `items`; `tracks` — прежнее имя.
      trackCount: Number(item?.items?.total ?? item?.tracks?.total) || 0,
      owner: typeof item?.owner?.display_name === 'string' ? item.owner.display_name : '',
      coverUrl: Array.isArray(item.images) && item.images[0]?.url ? String(item.images[0].url) : undefined
    }));
}

/** Приводит запись Spotify к тому виду, с которым работает импорт. */
function toItem(track: any): ParsedPlaylistItem | null {
  if (!track || typeof track !== 'object') return null;
  // В плейлистах попадаются подкасты: у них другая структура и искать их негде.
  if (track.type && track.type !== 'track') return null;

  const title = typeof track.name === 'string' ? track.name.trim() : '';
  if (!title) return null;

  const artist = Array.isArray(track.artists)
    ? track.artists.map((a: any) => (typeof a?.name === 'string' ? a.name : '')).filter(Boolean).join(', ')
    : '';

  return {
    title,
    artist,
    duration: typeof track.duration_ms === 'number' ? Math.round(track.duration_ms / 1000) : undefined,
    album: typeof track?.album?.name === 'string' ? track.album.name : undefined,
    artworkUrl: Array.isArray(track?.album?.images) && track.album.images[0]?.url ? String(track.album.images[0].url) : undefined,
    // Идентификатор Spotify кладём рядом с подтверждённой связью: ключом он не
    // служит, но по нему видно, откуда она взялась.
    sourceId: typeof track.id === 'string' ? track.id : undefined,
    sourcePlatform: 'spotify'
  };
}

/**
 * Все треки плейлиста — без ограничения на сотню.
 *
 * Адрес `/playlists/{id}/items`, а не `/tracks`. Spotify убрал прежний адрес
 * для приложений в режиме разработки 9 марта 2026 (миграция февраля 2026), и
 * с тех пор он отвечает 403 на любой плейлист — это и было «Spotify отказал
 * (403)» при каждой ссылке. В ответе `track` переименован в `item`; прежнее
 * имя читается тоже, на случай если ответ ещё старого вида.
 *
 * Фильтра `fields` нет нарочно: имена полей в нём поменялись вместе с
 * ответом, и ошибка в фильтре дала бы не отказ, а молча пустой список.
 *
 * И ещё одно ограничение той же миграции: содержимое отдаётся только для
 * плейлистов, которые человек создал сам или редактирует совместно. Чужой
 * плейлист отсюда не прочитать — вызывающий обязан уметь обойтись публичной
 * страницей.
 */
export async function fetchPlaylistItems(token: string, playlistId: string): Promise<ParsedPlaylistItem[]> {
  const raw = await collect<any>(token, `/playlists/${encodeURIComponent(playlistId)}/items?limit=${PAGE_SIZE}`);
  return raw
    .map((entry) => toItem(entry?.item ?? entry?.track))
    .filter((item): item is ParsedPlaylistItem => item !== null);
}

/** «Любимые треки» — то, что через публичную страницу не достать вовсе. */
export async function fetchLikedSongs(token: string): Promise<ParsedPlaylistItem[]> {
  const raw = await collect<any>(token, `/me/tracks?limit=${PAGE_SIZE}`);
  return raw.map((entry) => toItem(entry?.track)).filter((item): item is ParsedPlaylistItem => item !== null);
}
