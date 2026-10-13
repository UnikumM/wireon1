import { describe, it, expect } from 'vitest';
import {
  viewEntries,
  filterEntries,
  sortEntries,
  toEntries,
  countDuplicates,
  normalizeSearchText
} from '../../src/services/playlistTools';
import { UnifiedTrack } from '../../src/types/music';

const t = (id: string, title: string, artist: string, duration: number, addedAt?: number): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title,
  artist,
  duration,
  artworkUrl: '',
  addedAt
});

const list = [
  t('a', 'Ёлка', 'Би-2', 200, 10),
  t('b', 'Alpha', 'Zed', 100, 30),
  t('c', 'beta', 'Ария', 300),
  t('d', 'Gamma', 'Zed', 100, 20)
];

describe('playlistTools', () => {
  it('ищет по всем словам, без учёта регистра и ё', () => {
    expect(filterEntries(toEntries(list), 'елка').map((e) => e.track.id)).toEqual(['a']);
    expect(filterEntries(toEntries(list), 'zed gam').map((e) => e.track.id)).toEqual(['d']);
    expect(filterEntries(toEntries(list), '  ').length).toBe(4);
    expect(normalizeSearchText('  Ёж   Ёлки ')).toBe('еж елки');
  });

  it('сортирует и сохраняет номер в плейлисте', () => {
    // Русская раскладка сравнения: кириллица идёт раньше латиницы.
    expect(sortEntries(toEntries(list), 'title').map((e) => e.track.id)).toEqual(['a', 'b', 'c', 'd']);
    const byArtist = sortEntries(toEntries(list), 'artist');
    expect(byArtist.map((e) => e.track.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(byArtist[0].index).toBe(2);
  });

  it('недавно добавленные сверху, без даты — в конце', () => {
    expect(sortEntries(toEntries(list), 'added').map((e) => e.track.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('равная длительность — в порядке плейлиста', () => {
    expect(sortEntries(toEntries(list), 'duration').map((e) => e.track.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('свой порядок после поиска — исходный', () => {
    expect(viewEntries(list, 'zed', 'custom').map((e) => e.index)).toEqual([1, 3]);
  });

  it('считает лишние вхождения', () => {
    expect(countDuplicates([list[0], list[1], list[0], list[0]])).toBe(2);
    expect(countDuplicates(list)).toBe(0);
  });
});
