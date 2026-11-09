import type { Playlist, UnifiedTrack } from '../../../types/music';

/**
 * Поиск по медиатеке для палитры команд: чистые функции без сторов, чтобы
 * их можно было проверить на массивах. Здесь не нечёткое совпадение, как у
 * команд, а подстрока: команд два десятка, а треков — тысячи, и «прмш» по
 * подпоследовательности нашёл бы половину медиатеки.
 */

export const TRACK_LIMIT = 8;
export const PLAYLIST_LIMIT = 5;
export const ARTIST_LIMIT = 5;

/** Регистр и «ё/е» не важны: каталоги спорят о букве ё, а человек — нет. */
export function normalizeQuery(value: string | undefined | null): string {
  if (!value) return '';
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** Строка похожа на адрес: такое не ищут по медиатеке, а открывают. */
export function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/|www\.)\S+$/i.test(value.trim());
}

/** Каждое слово запроса встречается в строке — порядок слов не важен. */
function matchesWords(haystack: string, words: string[]): boolean {
  return words.every((word) => haystack.includes(word));
}

export interface TrackMatch {
  track: UnifiedTrack;
  score: number;
}

/**
 * Треки из избранного, истории и плейлистов, без дублей по id: первым
 * считается избранное — там у трека самая свежая обложка и название.
 */
export function collectLibraryTracks(
  favorites: UnifiedTrack[],
  history: UnifiedTrack[],
  playlists: Playlist[]
): UnifiedTrack[] {
  const seen = new Set<string>();
  const result: UnifiedTrack[] = [];
  const push = (track: UnifiedTrack | undefined) => {
    if (!track || !track.id || seen.has(track.id)) return;
    seen.add(track.id);
    result.push(track);
  };
  favorites.forEach(push);
  history.forEach(push);
  for (const playlist of playlists) playlist.tracks.forEach(push);
  return result;
}

/**
 * Совпадения по названию и артисту. Начало названия — выше, чем середина,
 * а середина названия — выше совпадения только по артисту.
 */
export function searchTracks(tracks: UnifiedTrack[], query: string, limit: number = TRACK_LIMIT): UnifiedTrack[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const words = needle.split(' ');

  const matches: TrackMatch[] = [];
  for (const track of tracks) {
    const title = normalizeQuery(track.title);
    const artist = normalizeQuery(track.artist);
    let score = 0;
    if (title.startsWith(needle)) score = 4;
    else if (title.includes(needle)) score = 3;
    else if (artist.includes(needle)) score = 2;
    else if (matchesWords(`${title} ${artist}`, words)) score = 1;
    if (score > 0) matches.push({ track, score });
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.track);
}

export function searchPlaylists(playlists: Playlist[], query: string, limit: number = PLAYLIST_LIMIT): Playlist[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const words = needle.split(' ');
  return playlists.filter((playlist) => matchesWords(normalizeQuery(playlist.title), words)).slice(0, limit);
}

/**
 * Уникальные артисты из истории и избранного — по нормализованному имени,
 * чтобы «Кино» и «КИНО» не стали двумя строками. Показывается то написание,
 * которое встретилось первым.
 */
export function searchArtists(tracks: UnifiedTrack[], query: string, limit: number = ARTIST_LIMIT): string[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const words = needle.split(' ');

  const seen = new Set<string>();
  const result: string[] = [];
  for (const track of tracks) {
    const name = (track.artist || '').trim();
    const key = normalizeQuery(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (matchesWords(key, words)) {
      result.push(name);
      if (result.length >= limit) break;
    }
  }
  return result;
}

/** Ключ для id строки: без пробелов, чтобы годился в `id` и `data-testid`. */
export function artistKey(name: string): string {
  return normalizeQuery(name).replace(/\s+/g, '-');
}
