/**
 * Сортировка, поиск и повторы внутри плейлиста.
 *
 * Как у Spotify и Apple Music: длинный плейлист можно отсортировать по
 * названию, исполнителю, дате добавления или длительности и найти в нём трек
 * по слову — не листая тысячу строк. Сортировка здесь — вид, а не правка:
 * сам плейлист не меняется, пока человек не попросит «сохранить этот порядок».
 *
 * Функции чистые и работают с парами «трек + его номер в плейлисте»: номер
 * нужен, чтобы удаление и перенос из отсортированного вида попадали в тот
 * трек, который видит человек, а не в тот, что стоит на этом месте в оригинале.
 */

import { UnifiedTrack } from '../types/music';

export type PlaylistSortKey = 'custom' | 'title' | 'artist' | 'added' | 'duration';

export const PLAYLIST_SORT_LABELS: Record<PlaylistSortKey, string> = {
  custom: 'Свой порядок',
  title: 'Название',
  artist: 'Исполнитель',
  added: 'Недавно добавленные',
  duration: 'Длительность'
};

export interface PlaylistEntry {
  track: UnifiedTrack;
  /** Номер в самом плейлисте. */
  index: number;
}

const collator =
  typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
    ? new Intl.Collator(['ru', 'en'], { sensitivity: 'base', numeric: true })
    : null;

function compareText(a: string, b: string): number {
  return collator ? collator.compare(a || '', b || '') : (a || '').localeCompare(b || '');
}

/** Ё и е, регистр и лишние пробелы не мешают найти трек. */
export function normalizeSearchText(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toEntries(tracks: ReadonlyArray<UnifiedTrack>): PlaylistEntry[] {
  return tracks.map((track, index) => ({ track, index }));
}

/** Все слова запроса должны найтись в названии, исполнителе или альбоме. */
export function filterEntries(entries: ReadonlyArray<PlaylistEntry>, query: string): PlaylistEntry[] {
  const words = normalizeSearchText(query).split(' ').filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter(({ track }) => {
    const haystack = normalizeSearchText(`${track.title} ${track.artist} ${track.album ?? ''}`);
    return words.every((word) => haystack.includes(word));
  });
}

/** Устойчивая сортировка: равные остаются в порядке плейлиста. */
export function sortEntries(entries: ReadonlyArray<PlaylistEntry>, key: PlaylistSortKey): PlaylistEntry[] {
  const list = [...entries];
  if (key === 'custom') return list.sort((a, b) => a.index - b.index);
  const byIndex = (a: PlaylistEntry, b: PlaylistEntry) => a.index - b.index;
  switch (key) {
    case 'title':
      return list.sort((a, b) => compareText(a.track.title, b.track.title) || byIndex(a, b));
    case 'artist':
      return list.sort(
        (a, b) =>
          compareText(a.track.artist, b.track.artist) || compareText(a.track.title, b.track.title) || byIndex(a, b)
      );
    case 'added':
      // Новые сверху. Без даты — в конец, в порядке плейлиста.
      return list.sort((a, b) => (b.track.addedAt ?? -1) - (a.track.addedAt ?? -1) || byIndex(a, b));
    case 'duration':
      return list.sort((a, b) => (a.track.duration || 0) - (b.track.duration || 0) || byIndex(a, b));
    default:
      return list;
  }
}

export function viewEntries(
  tracks: ReadonlyArray<UnifiedTrack>,
  query: string,
  key: PlaylistSortKey
): PlaylistEntry[] {
  return sortEntries(filterEntries(toEntries(tracks), query), key);
}

/** Сколько лишних вхождений: трек, лежащий трижды, даёт два. */
export function countDuplicates(tracks: ReadonlyArray<UnifiedTrack>): number {
  const seen = new Set<string>();
  let dupes = 0;
  for (const track of tracks) {
    if (!track?.id) continue;
    if (seen.has(track.id)) dupes += 1;
    else seen.add(track.id);
  }
  return dupes;
}
