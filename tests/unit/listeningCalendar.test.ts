import { describe, it, expect } from 'vitest';
import {
  bucketByDay,
  calendarWindowStart,
  dateKey,
  formatDayLabel,
  formatTrackCount,
  intensity,
  monthLabels,
  startOfWeek,
  weeksGrid,
  CALENDAR_WEEKS,
  DAY_MS
} from '../../src/services/listeningCalendar';
import type { HistoryRecord, PlayEventRecord } from '../../src/services/db';
import type { UnifiedTrack } from '../../src/types/music';

/**
 * Календарь прослушиваний: раскладка по дням и сетка недель.
 *
 * Главное, что проверяется — дни считаются по местному времени и по ленте
 * включений, а не по одному `playedAt` записи; и что падение на `playedAt`
 * случается только у треков, у которых событий в окне нет вовсе.
 */

function track(id: string): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id,
    title: `Трек ${id}`,
    artist: 'Кто-то',
    duration: 200,
    artworkUrl: ''
  };
}

function record(id: string, playedAt: number, playCount = 1): HistoryRecord {
  return { id, track: track(id), playedAt, playCount };
}

function event(trackId: string, playedAt: number, extra: Partial<PlayEventRecord> = {}): PlayEventRecord {
  return { trackId, playedAt, ...extra };
}

/** Полдень местного времени такого-то дня назад: далеко от полуночи и перевода часов. */
function noonDaysAgo(now: number, days: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
}

// Понедельник 9 ноября 2026, 15:30 по местному времени.
const NOW = new Date(2026, 10, 9, 15, 30).getTime();

describe('listeningCalendar: ключи и сетка', () => {
  it('ключ дня считается по местному времени, а не по UTC', () => {
    const lateEvening = new Date(2026, 10, 9, 23, 50).getTime();
    expect(dateKey(lateEvening)).toBe('2026-11-09');
    expect(dateKey(new Date(2026, 0, 1, 0, 5).getTime())).toBe('2026-01-01');
  });

  it('неделя начинается с понедельника', () => {
    const sunday = new Date(2026, 10, 15, 12).getTime();
    expect(dateKey(startOfWeek(sunday))).toBe('2026-11-09');
    expect(dateKey(startOfWeek(NOW))).toBe('2026-11-09');
  });

  it('сетка — двенадцать недель по семь дней, последняя содержит сегодня', () => {
    const grid = weeksGrid(NOW);
    expect(grid).toHaveLength(CALENDAR_WEEKS);
    expect(grid.every((week) => week.length === 7)).toBe(true);

    const last = grid[grid.length - 1];
    expect(last[0].key).toBe('2026-11-09');
    expect(last[0].future).toBe(false);
    // Вторник и дальше ещё не наступили.
    expect(last[1].future).toBe(true);
    expect(last[6].key).toBe('2026-11-15');

    // Первый день сетки — понедельник одиннадцатью неделями раньше.
    expect(new Date(grid[0][0].start).getDay()).toBe(1);
    expect(grid[0][0].start).toBe(calendarWindowStart(NOW));
    expect(Math.round((last[0].start - grid[0][0].start) / DAY_MS)).toBe(77);
  });

  it('дни идут подряд, без дыр и повторов', () => {
    const keys = weeksGrid(NOW).flat().map((cell) => cell.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
  });

  it('месяц подписывается над неделей с его первым числом, первая неделя — всегда', () => {
    const labels = monthLabels(weeksGrid(NOW));
    expect(labels[0].column).toBe(0);
    // 1 ноября 2026 — воскресенье недели, которая начинается 26 октября.
    const november = labels.find((label) => label.label === 'ноя');
    expect(november).toBeDefined();
    const column = november!.column;
    expect(weeksGrid(NOW)[column].some((cell) => cell.key === '2026-11-01')).toBe(true);
    // Подписей не больше, чем столбцов, и столбцы не повторяются.
    expect(new Set(labels.map((label) => label.column)).size).toBe(labels.length);
  });
});

describe('listeningCalendar: раскладка по дням', () => {
  it('день берётся из события, а не из последнего прослушивания записи', () => {
    const records = [record('a', noonDaysAgo(NOW, 1), 3)];
    const events = [
      event('a', noonDaysAgo(NOW, 1)),
      event('a', noonDaysAgo(NOW, 5)),
      event('a', noonDaysAgo(NOW, 20))
    ];

    const days = bucketByDay({ records, events, now: NOW });

    expect(days.size).toBe(3);
    expect(days.get(dateKey(noonDaysAgo(NOW, 5)))?.map((t) => t.id)).toEqual(['a']);
    expect(days.get(dateKey(noonDaysAgo(NOW, 20)))?.map((t) => t.id)).toEqual(['a']);
  });

  it('внутри дня трек один раз, порядок — по первому включению', () => {
    const base = noonDaysAgo(NOW, 2);
    const records = [record('late', base), record('early', base)];
    const events = [
      event('late', base + 60_000),
      event('early', base),
      event('late', base + 120_000),
      event('early', base + 3_600_000)
    ];

    const days = bucketByDay({ records, events, now: NOW });
    const day = days.get(dateKey(base));

    expect(day?.map((t) => t.id)).toEqual(['early', 'late']);
  });

  it('пропущенные включения и события без записи не попадают в день', () => {
    const base = noonDaysAgo(NOW, 3);
    const records = [record('a', base)];
    const events = [event('a', base, { skipped: true }), event('ghost', base)];

    expect(bucketByDay({ records, events, now: NOW }).size).toBe(0);
  });

  it('события вне окна не считаются, будущее — тоже', () => {
    const records = [record('a', NOW)];
    const events = [event('a', noonDaysAgo(NOW, 200)), event('a', NOW + 2 * DAY_MS)];

    expect(bucketByDay({ records, events, now: NOW }).size).toBe(0);
  });

  it('трек без событий в окне встаёт на день своего последнего прослушивания', () => {
    const playedAt = noonDaysAgo(NOW, 10);
    const records = [record('old', playedAt), record('fresh', noonDaysAgo(NOW, 1))];
    const events = [event('fresh', noonDaysAgo(NOW, 1))];

    const days = bucketByDay({ records, events, now: NOW });

    expect(days.get(dateKey(playedAt))?.map((t) => t.id)).toEqual(['old']);
    expect(days.get(dateKey(noonDaysAgo(NOW, 1)))?.map((t) => t.id)).toEqual(['fresh']);
  });

  it('если у трека есть события в окне, его playedAt отдельно не добавляется', () => {
    // Запись говорит «вчера», событие в окне — пять дней назад: день из
    // playedAt без события — это и есть повтор, которого быть не должно.
    const records = [record('a', noonDaysAgo(NOW, 1))];
    const events = [event('a', noonDaysAgo(NOW, 5))];

    const days = bucketByDay({ records, events, now: NOW });

    expect([...days.keys()]).toEqual([dateKey(noonDaysAgo(NOW, 5))]);
  });

  it('запись без прослушиваний день не создаёт', () => {
    const records = [record('a', noonDaysAgo(NOW, 1), 0)];
    expect(bucketByDay({ records, events: [], now: NOW }).size).toBe(0);
  });
});

describe('listeningCalendar: насыщенность и подписи', () => {
  it('пустой день — ноль, максимум — единица, между ними растёт', () => {
    expect(intensity(0, 10)).toBe(0);
    expect(intensity(3, 0)).toBe(0);
    expect(intensity(10, 10)).toBe(1);
    expect(intensity(15, 10)).toBe(1);

    const one = intensity(1, 10);
    const five = intensity(5, 10);
    expect(one).toBeGreaterThan(0);
    expect(five).toBeGreaterThan(one);
    expect(five).toBeLessThan(1);
  });

  it('один трек на фоне большого дня всё равно виден', () => {
    expect(intensity(1, 100)).toBeGreaterThanOrEqual(0.25);
  });

  it('подписи — число с месяцем в родительном падеже и счётчик треков', () => {
    expect(formatDayLabel('2026-11-12')).toBe('12 ноября');
    expect(formatDayLabel('2026-03-01')).toBe('1 марта');
    expect(formatTrackCount(0)).toBe('ничего не играло');
    expect(formatTrackCount(1)).toBe('1 трек');
    expect(formatTrackCount(7)).toBe('7 треков');
    expect(formatTrackCount(22)).toBe('22 трека');
  });
});
