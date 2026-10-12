import { describe, it, expect } from 'vitest';
import {
  buildRecap,
  recapRange,
  longestDayStreak,
  pickPersona,
  hasRecap,
  formatBigNumber,
  minutesComparison
} from '../../src/services/recap';
import { HistoryRecord, PlayEventRecord } from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

const NOW = new Date(2026, 9, 14, 12, 0).getTime();
const at = (month: number, day: number, hour: number) => new Date(2026, month, day, hour).getTime();

const track = (id: string, artist: string, title = id): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title,
  artist,
  duration: 180,
  artworkUrl: `https://img/${id}`
});

const record = (t: UnifiedTrack): HistoryRecord => ({ id: t.id, track: t, playCount: 1, playedAt: NOW });

describe('recap', () => {
  const tracks = [
    track('a', 'Кино', 'Группа крови'),
    track('b', 'Кино', 'Кукушка'),
    track('c', 'Земфира', 'Искала'),
    track('d', 'Daft Punk', 'One More Time (house)')
  ];
  const history = tracks.map(record);

  it('окно месяца и года', () => {
    expect(recapRange('month', NOW).label).toBe('Октябрь 2026');
    expect(recapRange('year', NOW).label).toBe('2026');
    expect(recapRange('year', NOW).from).toBe(new Date(2026, 0, 1).getTime());
  });

  it('считает минуты, топы, пиковый час и серию', () => {
    const events: PlayEventRecord[] = [
      { trackId: 'a', playedAt: at(9, 1, 23), seconds: 180 },
      { trackId: 'a', playedAt: at(9, 2, 23), seconds: 180 },
      { trackId: 'a', playedAt: at(9, 3, 23), seconds: 180 },
      { trackId: 'b', playedAt: at(9, 3, 22), seconds: 120 },
      { trackId: 'c', playedAt: at(9, 5, 9), seconds: 60 },
      { trackId: 'd', playedAt: at(9, 6, 23), seconds: 60 },
      { trackId: 'd', playedAt: at(9, 6, 23), skipped: true, seconds: 5 },
      { trackId: 'c', playedAt: at(8, 20, 9), seconds: 60 } // сентябрь — не в октябре
    ];
    const recap = buildRecap({ events, history, period: 'month', now: NOW });
    expect(recap.totalPlays).toBe(6);
    expect(recap.totalMinutes).toBe(13); // 780 с
    expect(recap.topTracks[0].track.id).toBe('a');
    expect(recap.topTracks[0].plays).toBe(3);
    expect(recap.topArtists[0].name).toBe('Кино');
    expect(recap.topArtists[0].plays).toBe(4);
    expect(recap.peakHour).toBe(23);
    expect(recap.longestStreak).toBe(3);
    expect(recap.biggestDay?.minutes).toBe(5);
    expect(recap.topGenres).toContain('house');
    expect(recap.uniqueArtists).toBe(3);
    // За год сентябрь тоже в счёт.
    expect(buildRecap({ events, history, period: 'year', now: NOW }).totalPlays).toBe(7);
  });

  it('серия переживает переход на летнее время', () => {
    const days = [new Date(2026, 2, 28).getTime(), new Date(2026, 2, 29).getTime(), new Date(2026, 2, 30).getTime()];
    expect(longestDayStreak(days)).toBe(3);
    expect(longestDayStreak([days[0], days[2]])).toBe(1);
    expect(longestDayStreak([])).toBe(0);
  });

  it('тип слушателя', () => {
    const parts = { morning: 0.1, day: 0.2, evening: 0.2, night: 0.5 };
    expect(pickPersona({ totalPlays: 50, uniqueArtists: 10, topArtistShare: 0.1, dayParts: parts, longestStreak: 1 }).id).toBe('night-owl');
    const even = { morning: 0.25, day: 0.25, evening: 0.25, night: 0.25 };
    expect(pickPersona({ totalPlays: 50, uniqueArtists: 5, topArtistShare: 0.5, dayParts: even, longestStreak: 1 }).id).toBe('loyal');
    expect(pickPersona({ totalPlays: 50, uniqueArtists: 40, topArtistShare: 0.05, dayParts: even, longestStreak: 2 }).id).toBe('explorer');
    expect(pickPersona({ totalPlays: 50, uniqueArtists: 10, topArtistShare: 0.1, dayParts: even, longestStreak: 20 }).id).toBe('marathoner');
  });

  it('пустые итоги не показываются', () => {
    const empty = buildRecap({ events: [], history: [], period: 'year', now: NOW });
    expect(empty.peakHour).toBeNull();
    expect(hasRecap(empty)).toBe(false);
  });

  it('форматирует числа и сравнения', () => {
    expect(formatBigNumber(12345)).toBe('12 345');
    expect(minutesComparison(3000)).toMatch(/суток/);
    expect(minutesComparison(400)).toMatch(/фильмов/);
  });
});
