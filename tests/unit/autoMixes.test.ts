import { describe, it, expect } from 'vitest';
import {
  buildOnRepeat,
  buildTimeMachine,
  buildDayPart,
  buildFresh,
  buildAutoMixes,
  dayPartOf,
  dayPartTitle,
  AutoMixInput
} from '../../src/services/autoMixes';
import { HistoryRecord, PlayEventRecord } from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

const DAY = 24 * 60 * 60 * 1000;
// Среда, 14 октября 2026, 08:30 местного времени.
const NOW = new Date(2026, 9, 14, 8, 30).getTime();

const track = (n: number, artist = `Artist ${n}`): UnifiedTrack => ({
  id: `t${n}`,
  source: 'youtube',
  originalId: String(n),
  title: `Song ${n}`,
  artist,
  duration: 200,
  artworkUrl: `https://img/${n}.jpg`
});

const record = (n: number, playCount: number, playedAt: number, extra: Partial<HistoryRecord> = {}): HistoryRecord => ({
  id: `t${n}`,
  track: track(n),
  playCount,
  playedAt,
  ...extra
});

const event = (n: number, playedAt: number, extra: Partial<PlayEventRecord> = {}): PlayEventRecord => ({
  trackId: `t${n}`,
  playedAt,
  ...extra
});

const base = (patch: Partial<AutoMixInput>): AutoMixInput => ({ history: [], events: [], now: NOW, ...patch });

describe('autoMixes: части суток', () => {
  it('делит сутки на четыре части', () => {
    expect(dayPartOf(new Date(2026, 0, 1, 6).getTime())).toBe('morning');
    expect(dayPartOf(new Date(2026, 0, 1, 12).getTime())).toBe('day');
    expect(dayPartOf(new Date(2026, 0, 1, 19).getTime())).toBe('evening');
    expect(dayPartOf(new Date(2026, 0, 1, 23).getTime())).toBe('night');
    expect(dayPartOf(new Date(2026, 0, 1, 3).getTime())).toBe('night');
  });

  it('ночь после полуночи принадлежит вчерашнему дню', () => {
    expect(dayPartTitle(NOW)).toBe('Утро среды');
    // Суббота, 02:00 — это ещё ночь пятницы.
    expect(dayPartTitle(new Date(2026, 9, 17, 2).getTime())).toBe('Ночь пятницы');
    expect(dayPartTitle(new Date(2026, 9, 16, 23).getTime())).toBe('Ночь пятницы');
  });
});

describe('autoMixes: На повторе', () => {
  it('берёт треки с двумя и больше включениями за 30 дней, по убыванию', () => {
    const history = [1, 2, 3, 4, 5, 6, 7].map((n) => record(n, 10, NOW - DAY));
    const events: PlayEventRecord[] = [];
    for (let n = 1; n <= 6; n++) for (let k = 0; k < n + 1; k++) events.push(event(n, NOW - (k + 1) * DAY));
    events.push(event(7, NOW - DAY)); // одно включение — не «на повторе»
    events.push(event(7, NOW - 40 * DAY)); // за окном
    const mix = buildOnRepeat(base({ history, events }));
    expect(mix?.tracks.map((t) => t.id)).toEqual(['t6', 't5', 't4', 't3', 't2', 't1']);
    expect(mix?.title).toBe('На повторе');
  });

  it('пропуски не считаются, отвергнутое не попадает', () => {
    const history = [1, 2, 3, 4, 5, 6].map((n) => record(n, 5, NOW));
    const events = [1, 2, 3, 4, 5, 6].flatMap((n) => [event(n, NOW - DAY), event(n, NOW - 2 * DAY)]);
    events.push(event(1, NOW - DAY, { skipped: true }));
    const mix = buildOnRepeat(base({ history, events, dislikedIds: new Set(['t2']) }));
    expect(mix?.tracks.some((t) => t.id === 't2')).toBe(false);
    expect(mix?.tracks).toHaveLength(5);
  });

  it('мало данных — подборки нет', () => {
    expect(buildOnRepeat(base({ history: [record(1, 3, NOW)], events: [event(1, NOW), event(1, NOW)] }))).toBeNull();
  });
});

describe('autoMixes: Машина времени', () => {
  it('любимое и давно не звучавшее', () => {
    const old = NOW - 100 * DAY;
    const history = [
      record(1, 12, old),
      record(2, 8, old),
      record(3, 5, old),
      record(4, 4, old),
      record(5, 3, old),
      record(6, 2, old), // мало включений
      record(7, 20, NOW - DAY), // звучало недавно
      record(8, 4, old, { earlySkipCount: 9 }) // разлюбленное
    ];
    const mix = buildTimeMachine(base({ history }));
    expect(mix?.tracks.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('забытое избранное тоже в счёт', () => {
    const old = NOW - 100 * DAY;
    const history = [1, 2, 3, 4].map((n) => record(n, 5, old));
    const favorites = [{ ...track(9), addedAt: old }];
    const mix = buildTimeMachine(base({ history, favorites }));
    expect(mix?.tracks.map((t) => t.id)).toContain('t9');
  });
});

describe('autoMixes: Под это время', () => {
  it('выбирает треки, звучавшие в это же время суток', () => {
    const history = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => record(n, 3, NOW));
    const morning = (daysAgo: number) => new Date(2026, 9, 14 - daysAgo, 8, 0).getTime();
    const evening = (daysAgo: number) => new Date(2026, 9, 14 - daysAgo, 20, 0).getTime();
    const events = [
      ...[1, 2, 3, 4, 5].map((n) => event(n, morning(n))),
      event(1, morning(8)),
      ...[6, 7, 8].map((n) => event(n, evening(n)))
    ];
    const mix = buildDayPart(base({ history, events }));
    expect(mix?.title).toBe('Утро среды');
    expect(mix?.tracks[0].id).toBe('t1');
    expect(mix?.tracks.map((t) => t.id).sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });
});

describe('autoMixes: Свежее', () => {
  it('новое за месяц, новые сверху, без повторов', () => {
    const favorites = [1, 2, 3].map((n) => ({ ...track(n), addedAt: NOW - n * DAY }));
    const library = [
      { ...track(4), addedAt: NOW - 4 * DAY },
      { ...track(5), addedAt: NOW - 5 * DAY },
      { ...track(1), addedAt: NOW - 10 * DAY },
      { ...track(6), addedAt: NOW - 50 * DAY }
    ];
    const mix = buildFresh(base({ favorites, library }));
    expect(mix?.tracks.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });
});

describe('autoMixes: всё вместе', () => {
  it('пустая история — ни одной подборки', () => {
    expect(buildAutoMixes(base({}))).toEqual([]);
  });

  it('не больше четырёх треков одного исполнителя, пока есть другие', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ ...record(i, 5, NOW), track: track(i, i < 8 ? 'Same' : `Other ${i}`) }));
    const events = history.flatMap((r) => [event(Number(r.id.slice(1)), NOW - DAY), event(Number(r.id.slice(1)), NOW - 2 * DAY)]);
    const mix = buildOnRepeat(base({ history, events, size: 6 }));
    const same = mix!.tracks.filter((t) => t.artist === 'Same').length;
    expect(same).toBe(4);
    expect(mix!.tracks).toHaveLength(6);
  });
});
