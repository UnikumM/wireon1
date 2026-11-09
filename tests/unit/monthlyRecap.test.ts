import { describe, it, expect } from 'vitest';
import {
  buildMonthlyRecap,
  formatComparison,
  hasMonthlyRecap,
  monthKey,
  monthName,
  previousMonth,
  recapAvailable,
  withinHomeWindow,
  MONTHLY_RECAP_MIN_PLAYS
} from '../../src/services/monthlyRecap';
import { HistoryRecord, PlayEventRecord } from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

/**
 * Месячный рекап считается по ленте включений, а не по счётчикам истории:
 * история помнит по треку только последнее включение, и «сколько раз в
 * октябре» из неё не достать. Проверяется, что считается честно: топы по
 * событиям месяца, минуты только из записанных секунд, новые исполнители с
 * оглядкой на историю, а при малом числе включений рекапа нет.
 */

const OCTOBER = { year: 2026, month: 9 };
const at = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour).getTime();

const track = (id: string, artist: string, title = id): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title,
  artist,
  duration: 180,
  artworkUrl: ''
});

const kino1 = track('kino1', 'Кино', 'Группа крови');
const kino2 = track('kino2', 'Кино', 'Кукушка');
const zemfira = track('zem', 'Земфира', 'Искала');
const splin = track('splin', 'Сплин', 'Выхода нет');

function record(t: UnifiedTrack, playCount: number, playedAt: number): HistoryRecord {
  return { id: t.id, track: t, playCount, playedAt };
}

function plays(trackId: string, times: number[], seconds?: number): PlayEventRecord[] {
  return times.map((playedAt) => ({ trackId, playedAt, seconds }));
}

describe('monthlyRecap', () => {
  const history = [
    record(kino1, 6, at(9, 20)),
    record(kino2, 2, at(9, 15)),
    record(zemfira, 3, at(9, 10)),
    // Сплин слушали и раньше: счётчик больше, чем включений в октябре.
    record(splin, 5, at(9, 3))
  ];
  const events: PlayEventRecord[] = [
    ...plays(kino1.id, [at(9, 1), at(9, 2), at(9, 3), at(9, 20, 9), at(9, 20, 10), at(9, 20, 11)], 170),
    ...plays(kino2.id, [at(9, 2), at(9, 15)], 120),
    ...plays(zemfira.id, [at(9, 5), at(9, 6), at(9, 10)]),
    ...plays(splin.id, [at(9, 3)], 60),
    // Пропуск не считается ни в чём.
    { trackId: zemfira.id, playedAt: at(9, 7), skipped: true },
    // Сентябрь — для сравнения.
    ...plays(kino1.id, [at(8, 2), at(8, 3), at(8, 4), at(8, 5), at(8, 6), at(8, 7), at(8, 8), at(8, 9)]),
    // Ноябрь в октябрь не попадает.
    ...plays(kino1.id, [at(10, 1)])
  ];

  it('режет месяц по событиям и считает топы', () => {
    const recap = buildMonthlyRecap({ events, history }, OCTOBER);
    expect(recap.plays).toBe(12);
    expect(recap.topTracks.map((entry) => [entry.track.id, entry.plays])).toEqual([
      ['kino1', 6],
      ['zem', 3],
      ['kino2', 2]
    ]);
    expect(recap.topArtists.map((artist) => [artist.name, artist.plays])).toEqual([
      ['Кино', 8],
      ['Земфира', 3],
      ['Сплин', 1]
    ]);
  });

  it('минуты — только из записанных секунд, не из длительности', () => {
    const recap = buildMonthlyRecap({ events, history }, OCTOBER);
    // 6×170 + 2×120 + 60 = 1320 с; у Земфиры секунд нет — она в минуты не идёт.
    expect(recap.minutes).toBe(22);

    const noSeconds = buildMonthlyRecap({ events: plays(kino1.id, Array.from({ length: 12 }, (_, i) => at(9, i + 1))), history }, OCTOBER);
    expect(noSeconds.minutes).toBeNull();
  });

  it('новые исполнители — те, кого не было ни в ленте, ни в истории до месяца', () => {
    const recap = buildMonthlyRecap({ events, history }, OCTOBER);
    // Кино играло в сентябре (лента), Сплина история помнит пятью включениями
    // при одном октябрьском — оба не новые. Новая только Земфира.
    expect(recap.newArtists).toEqual(['Земфира']);

    // Событие до начала месяца тоже выдаёт старого знакомого.
    const withPast = [...events, { trackId: zemfira.id, playedAt: at(7, 1) }];
    expect(buildMonthlyRecap({ events: withPast, history }, OCTOBER).newArtists).toEqual([]);

    // Без свидетелей прошлого все трое — новые.
    const octoberOnly = events.filter((e) => e.playedAt >= at(9, 1) && e.playedAt < at(10, 1));
    const freshHistory = history.map((r) => ({ ...r, playCount: r.id === 'splin' ? 1 : r.playCount }));
    expect(buildMonthlyRecap({ events: octoberOnly, history: freshHistory }, OCTOBER).newArtists.sort()).toEqual([
      'Земфира', 'Кино', 'Сплин'
    ]);
  });

  it('самый громкий день и серия дней подряд', () => {
    const recap = buildMonthlyRecap({ events, history }, OCTOBER);
    expect(recap.busiestDay).toEqual({ date: new Date(2026, 9, 20).getTime(), plays: 3 });
    // 1, 2, 3 октября — три дня подряд; 5–6 — два; дальше одиночные.
    expect(recap.streakDays).toBe(3);
  });

  it('сравнивает с прошлым месяцем в процентах', () => {
    const recap = buildMonthlyRecap({ events, history }, OCTOBER);
    expect(recap.comparedToPrevious).toEqual({ plays: 8, playsDelta: 50 });
    expect(formatComparison(recap)).toBe('На 50% больше, чем в сентябре');

    const quiet = buildMonthlyRecap({ events: events.filter((e) => e.playedAt >= at(9, 1)), history }, OCTOBER);
    expect(quiet.comparedToPrevious.playsDelta).toBeNull();
    expect(formatComparison(quiet)).toBe('В сентябре ничего не слушали');

    const fewer = buildMonthlyRecap({ events, history }, { year: 2026, month: 8 });
    expect(fewer.comparedToPrevious.playsDelta).toBeNull();
  });

  it('недоступен, пока меньше десяти включений', () => {
    const few = plays(kino1.id, Array.from({ length: MONTHLY_RECAP_MIN_PLAYS - 1 }, (_, i) => at(9, i + 1)));
    expect(recapAvailable({ events: few, history }, OCTOBER)).toBe(false);
    expect(hasMonthlyRecap(buildMonthlyRecap({ events: few, history }, OCTOBER))).toBe(false);
    expect(recapAvailable({ events, history }, OCTOBER)).toBe(true);
    // Включения без записи в истории не дают показать ни одного трека — рекапа нет.
    expect(recapAvailable({ events, history: [] }, OCTOBER)).toBe(false);
  });

  it('прошлый месяц, ключ и окно главной', () => {
    expect(previousMonth(at(10, 9))).toEqual({ year: 2026, month: 9 });
    expect(previousMonth(new Date(2026, 0, 15).getTime())).toEqual({ year: 2025, month: 11 });
    expect(monthKey({ year: 2026, month: 9 })).toBe('2026-10');
    expect(monthName(OCTOBER)).toBe('Октябрь');
    expect(withinHomeWindow(at(10, 7))).toBe(true);
    expect(withinHomeWindow(at(10, 8))).toBe(false);
  });
});
