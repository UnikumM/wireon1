import { describe, it, expect } from 'vitest';
import '../setup';
import {
  buildListeningStats,
  buildPeriodStats,
  formatListeningTime,
  statsPeriodStart,
  STATS_PERIOD_MS,
  STATS_PERIODS,
  STATS_RECENT_WINDOW_MS
} from '../../src/services/listeningStats';
import {
  DAILY_MIX_MIN_TRACKS,
  buildDailyMixes,
  dailyMixDateKey
} from '../../src/services/dailyMixes';
import { HistoryRecord, PlayEventRecord } from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

/**
 * Статистика и миксы дня считаются из истории и медиатеки — без сети и без
 * телеметрии. Оба места легко начинают врать (двойной учёт прослушиваний,
 * микс, который тасуется на каждой перерисовке), поэтому проверяем именно это.
 */

const NOW = 1_770_000_000_000; // фиксированное «сейчас», часы тут не при делах

function track(id: string, artist: string, title: string, extra: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return {
    id,
    source: id.startsWith('sc_') ? 'soundcloud' : 'youtube',
    originalId: id.replace(/^(yt_|sc_)/, ''),
    title,
    artist,
    duration: 180,
    artworkUrl: `https://example.test/${id}.jpg`,
    ...extra
  };
}

function played(
  t: UnifiedTrack,
  playCount: number,
  playedAt = NOW - 1000,
  extra: Partial<HistoryRecord> = {}
): HistoryRecord {
  return { id: t.id, track: t, playedAt, playCount, ...extra };
}

const DAY = 24 * 60 * 60 * 1000;

/** `n` включений одного трека, каждое на `daysAgo` дней назад. */
function events(trackId: string, daysAgo: number[], base = NOW): PlayEventRecord[] {
  return daysAgo.map((days, i) => ({ id: i + 1, trackId, playedAt: base - days * DAY }));
}

describe('Статистика прослушанного', () => {
  it('на пустой истории возвращает нули, а не NaN', () => {
    const stats = buildListeningStats([], { now: NOW });

    expect(stats.totalPlays).toBe(0);
    expect(stats.approxSeconds).toBe(0);
    expect(stats.topArtists).toEqual([]);
    expect(stats.sources).toEqual([]);
    expect(stats.firstPlayedAt).toBeNull();
    expect(Number.isNaN(stats.approxSeconds)).toBe(false);
  });

  it('считает прослушивания, треки и примерное время', () => {
    const stats = buildListeningStats(
      [
        played(track('yt_1', 'Аквариум', 'Город золотой'), 3),
        played(track('yt_2', 'Аквариум', 'Пепел'), 1),
        played(track('sc_3', 'Мумий Тролль', 'Владивосток'), 2)
      ],
      { now: NOW }
    );

    expect(stats.totalPlays).toBe(6);
    expect(stats.uniqueTracks).toBe(3);
    expect(stats.uniqueArtists).toBe(2);
    // 6 включений по 3 минуты.
    expect(stats.approxSeconds).toBe(6 * 180);
    expect(formatListeningTime(stats.approxSeconds)).toBe('18 мин');
  });

  it('топ артистов считает по прослушиваниям, а не по числу треков', () => {
    const stats = buildListeningStats(
      [
        played(track('yt_1', 'Один трек', 'Хит'), 20),
        played(track('yt_2', 'Много треков', 'A'), 1),
        played(track('yt_3', 'Много треков', 'B'), 1),
        played(track('yt_4', 'Много треков', 'C'), 1)
      ],
      { now: NOW }
    );

    expect(stats.topArtists[0]).toEqual({ artist: 'Один трек', plays: 20, tracks: 1 });
    expect(stats.topArtists[1]).toEqual({ artist: 'Много треков', plays: 3, tracks: 3 });
  });

  it('склеивает одного артиста, записанного по-разному', () => {
    const stats = buildListeningStats(
      [
        played(track('yt_1', 'Кино', 'Звезда'), 5),
        played(track('yt_2', 'КИНО!', 'Пачка сигарет'), 3),
        played(track('yt_3', 'кино', 'Группа крови'), 1)
      ],
      { now: NOW }
    );

    expect(stats.uniqueArtists).toBe(1);
    expect(stats.topArtists).toHaveLength(1);
    expect(stats.topArtists[0].plays).toBe(9);
    expect(stats.topArtists[0].tracks).toBe(3);
    // Показываем то написание, которое встречается чаще всего.
    expect(stats.topArtists[0].artist).toBe('Кино');
  });

  it('разбивает прослушивания по сервисам и считает доли', () => {
    const stats = buildListeningStats(
      [played(track('yt_1', 'A', 'a'), 3), played(track('sc_2', 'B', 'b'), 1)],
      { now: NOW }
    );

    expect(stats.sources).toEqual([
      { source: 'youtube', plays: 3, share: 0.75 },
      { source: 'soundcloud', plays: 1, share: 0.25 }
    ]);
  });

  it('«за последние 30 дней» — это только те треки, к которым правда возвращались', () => {
    const stats = buildListeningStats(
      [
        played(track('yt_new', 'A', 'свежий'), 1, NOW - 1000),
        played(track('yt_edge', 'B', 'на границе'), 1, NOW - STATS_RECENT_WINDOW_MS + 1000),
        played(track('yt_old', 'C', 'давний'), 1, NOW - STATS_RECENT_WINDOW_MS - 1000)
      ],
      { now: NOW }
    );

    expect(stats.activeLast30Days).toBe(2);
    expect(stats.uniqueTracks).toBe(3);
    expect(stats.firstPlayedAt).toBe(NOW - STATS_RECENT_WINDOW_MS - 1000);
    expect(stats.lastPlayedAt).toBe(NOW - 1000);
  });

  it('суммирует дослушанное и пропущенное', () => {
    const stats = buildListeningStats(
      [
        played(track('yt_1', 'A', 'a'), 4, NOW, { completedCount: 3, skipCount: 1 }),
        played(track('yt_2', 'B', 'b'), 2, NOW, { skipCount: 2 })
      ],
      { now: NOW }
    );

    expect(stats.completed).toBe(3);
    expect(stats.skipped).toBe(3);
  });

  it('битую запись не превращает в мусорные числа', () => {
    const stats = buildListeningStats(
      [
        played(track('yt_1', 'A', 'a', { duration: Number.NaN }), Number.NaN),
        played(track('yt_2', '', 'без артиста'), 0, -5),
        { id: 'yt_3', track: undefined as unknown as UnifiedTrack, playedAt: NOW, playCount: 2 }
      ],
      { now: NOW }
    );

    // Битый трек выкинут, а запись без счётчика — это всё-таки одно включение.
    expect(stats.uniqueTracks).toBe(2);
    expect(stats.totalPlays).toBe(2);
    expect(Number.isFinite(stats.approxSeconds)).toBe(true);
    expect(stats.topArtists.map((a) => a.artist)).toContain('Неизвестный исполнитель');
  });

  it('ограничивает топ и показывает время по-русски', () => {
    const history = Array.from({ length: 12 }, (_, i) =>
      played(track(`yt_${i}`, `Артист ${i}`, `Трек ${i}`), 12 - i)
    );

    const stats = buildListeningStats(history, { now: NOW, topLimit: 3 });

    expect(stats.topArtists).toHaveLength(3);
    expect(stats.topTracks).toHaveLength(3);
    expect(stats.topTracks[0].plays).toBe(12);

    expect(formatListeningTime(0)).toBe('меньше минуты');
    expect(formatListeningTime(59)).toBe('меньше минуты');
    expect(formatListeningTime(3600)).toBe('1 ч');
    expect(formatListeningTime(3600 + 1800)).toBe('1 ч 30 мин');
    expect(formatListeningTime(Number.NaN)).toBe('меньше минуты');
  });
});

/**
 * Окна итогов.
 *
 * Главное, что здесь проверяется: неделя и месяц считаются по отдельным
 * включениям, а не по счётчику из истории. Счётчик знает только своё число и
 * дату последнего включения — если бы окно считалось по нему, трек, который
 * слушали сто раз в прошлом году и один раз вчера, встал бы в недельный топ
 * первым местом. Ровно этот случай и стоит первым тестом.
 */
describe('Итоги за окно', () => {
  const old = track('yt_old', 'Прошлогодний', 'Сто раз зимой');
  const fresh = track('yt_fresh', 'Свежий', 'Три раза за неделю');

  // Сто включений, из которых в окно попадает одно — вчерашнее.
  const history = [
    played(old, 100, NOW - 1 * DAY),
    played(fresh, 3, NOW - 1 * DAY)
  ];

  const allEvents = [
    ...events('yt_old', [1]),
    ...events('yt_fresh', [1, 3, 6])
  ];

  it('за всё время считает по счётчикам, а не по событиям', () => {
    const stats = buildPeriodStats({ period: 'all', records: history, events: allEvents, now: NOW });

    expect(stats.totalPlays).toBe(103);
    expect(stats.topTracks[0].track.id).toBe('yt_old');
    expect(stats.topTracks[0].plays).toBe(100);
  });

  it('за неделю считает по событиям, и старый счётчик топ не занимает', () => {
    const stats = buildPeriodStats({ period: 'week', records: history, events: allEvents, now: NOW });

    // 3 включения свежего + 1 старого, а не 103.
    expect(stats.totalPlays).toBe(4);
    expect(stats.topTracks[0].track.id).toBe('yt_fresh');
    expect(stats.topTracks[0].plays).toBe(3);
    expect(stats.topTracks[1].plays).toBe(1);
    expect(stats.topArtists[0]).toEqual({ artist: 'Свежий', plays: 3, tracks: 1 });
    // Время окна — тоже из событий: 4 включения по 3 минуты.
    expect(stats.approxSeconds).toBe(4 * 180);
  });

  it('месяц берёт то, что неделя отрезала', () => {
    const withOlder = [...allEvents, ...events('yt_fresh', [20, 25])];

    const week = buildPeriodStats({ period: 'week', records: history, events: withOlder, now: NOW });
    const month = buildPeriodStats({ period: 'month', records: history, events: withOlder, now: NOW });

    expect(week.totalPlays).toBe(4);
    expect(month.totalPlays).toBe(6);
  });

  it('включение на самой границе окна остаётся в нём', () => {
    const edge: PlayEventRecord[] = [
      { id: 1, trackId: 'yt_fresh', playedAt: NOW - STATS_PERIOD_MS.week },
      { id: 2, trackId: 'yt_fresh', playedAt: NOW - STATS_PERIOD_MS.week - 1 }
    ];

    const stats = buildPeriodStats({ period: 'week', records: history, events: edge, now: NOW });

    expect(stats.totalPlays).toBe(1);
    expect(statsPeriodStart('week', NOW)).toBe(NOW - STATS_PERIOD_MS.week);
    expect(statsPeriodStart('all', NOW)).toBe(0);
  });

  it('в окне не показывает дослушивания и пропуски: их счётчик не знает дат', () => {
    const counted = [played(fresh, 3, NOW - DAY, { completedCount: 3, skipCount: 2 })];

    const all = buildPeriodStats({ period: 'all', records: counted, events: allEvents, now: NOW });
    const week = buildPeriodStats({ period: 'week', records: counted, events: allEvents, now: NOW });

    expect(all.completed).toBe(3);
    expect(all.skipped).toBe(2);
    expect(week.completed).toBe(0);
    expect(week.skipped).toBe(0);
  });

  it('событие без записи в истории пропускается, а не роняет подсчёт', () => {
    const orphan: PlayEventRecord[] = [
      { id: 1, trackId: 'yt_fresh', playedAt: NOW - DAY },
      { id: 2, trackId: 'yt_удалённый', playedAt: NOW - DAY },
      { id: 3, trackId: '', playedAt: NOW - DAY },
      { id: 4, trackId: 'yt_fresh', playedAt: Number.NaN }
    ];

    const stats = buildPeriodStats({ period: 'week', records: history, events: orphan, now: NOW });

    expect(stats.totalPlays).toBe(1);
    expect(stats.uniqueTracks).toBe(1);
    expect(Number.isFinite(stats.approxSeconds)).toBe(true);
  });

  it('пустое окно — это нули, а не прошлые числа', () => {
    const stats = buildPeriodStats({ period: 'week', records: history, events: [], now: NOW });

    expect(stats.totalPlays).toBe(0);
    expect(stats.topTracks).toEqual([]);
    expect(stats.sources).toEqual([]);
    // А за всё время при тех же данных история на месте.
    expect(buildPeriodStats({ period: 'all', records: history, now: NOW }).totalPlays).toBe(103);
  });

  it('окон ровно три, и месяц совпадает с окном «за 30 дней»', () => {
    expect(STATS_PERIODS).toEqual(['week', 'month', 'all']);
    expect(STATS_PERIOD_MS.month).toBe(STATS_RECENT_WINDOW_MS);
    expect(STATS_PERIOD_MS.week).toBeLessThan(STATS_PERIOD_MS.month);
  });
});

describe('Миксы дня', () => {
  const library: UnifiedTrack[] = [
    ...Array.from({ length: 6 }, (_, i) => track(`yt_a${i}`, 'Первый', `A${i}`)),
    ...Array.from({ length: 6 }, (_, i) => track(`yt_b${i}`, 'Второй', `B${i}`)),
    ...Array.from({ length: 6 }, (_, i) => track(`yt_c${i}`, 'Третий', `C${i}`)),
    ...Array.from({ length: 6 }, (_, i) => track(`yt_d${i}`, 'Четвёртый', `D${i}`))
  ];

  it('ключ даты берёт местные сутки', () => {
    // Полдень 18 августа по местному времени — дата не должна съезжать на сутки.
    const noon = new Date(2026, 7, 18, 12, 0, 0).getTime();
    expect(dailyMixDateKey(noon)).toBe('2026-08-18');
  });

  it('не выдумывает миксы, когда слушать нечего', () => {
    expect(buildDailyMixes({ dateKey: '2026-08-18' })).toEqual([]);
    expect(
      buildDailyMixes({ dateKey: '2026-08-18', library: library.slice(0, DAILY_MIX_MIN_TRACKS - 1) })
    ).toEqual([]);
    // Треков хватает, а артист один — это плейлист артиста, а не микс.
    expect(
      buildDailyMixes({
        dateKey: '2026-08-18',
        library: Array.from({ length: 20 }, (_, i) => track(`yt_solo${i}`, 'Единственный', `S${i}`))
      })
    ).toEqual([]);
  });

  it('собирает подборки из медиатеки и перемешивает исполнителей внутри', () => {
    const mixes = buildDailyMixes({ dateKey: '2026-08-18', library, count: 2, size: 8 });

    expect(mixes).toHaveLength(2);
    for (const mix of mixes) {
      expect(mix.tracks.length).toBe(8);
      expect(mix.title).toMatch(/^Микс дня · /);
      expect(mix.artworkUrl).toBeTruthy();

      // Внутри микса не должно быть одного артиста подряд весь список.
      const artists = new Set(mix.tracks.map((t) => t.artist));
      expect(artists.size).toBeGreaterThan(1);

      // И повторов трека тоже.
      expect(new Set(mix.tracks.map((t) => t.id)).size).toBe(mix.tracks.length);
    }

    // Разные миксы — разные наборы артистов.
    const first = new Set(mixes[0].tracks.map((t) => t.artist));
    const second = new Set(mixes[1].tracks.map((t) => t.artist));
    expect([...first].some((artist) => second.has(artist))).toBe(false);
  });

  it('внутри суток состав не пляшет, а на другую дату меняется', () => {
    const today = buildDailyMixes({ dateKey: '2026-08-18', library, count: 2, size: 8 });
    const again = buildDailyMixes({ dateKey: '2026-08-18', library, count: 2, size: 8 });
    const tomorrow = buildDailyMixes({ dateKey: '2026-08-19', library, count: 2, size: 8 });

    expect(again.map((m) => m.tracks.map((t) => t.id))).toEqual(today.map((m) => m.tracks.map((t) => t.id)));
    expect(again.map((m) => m.id)).toEqual(today.map((m) => m.id));

    expect(tomorrow[0].id).toBe('mix_2026-08-19_1');
    expect(tomorrow.map((m) => m.tracks.map((t) => t.id))).not.toEqual(
      today.map((m) => m.tracks.map((t) => t.id))
    );
  });

  it('ставит вперёд то, что человек слушает чаще', () => {
    const history = [played(track('yt_c0', 'Третий', 'C0'), 40)];

    const mixes = buildDailyMixes({ dateKey: '2026-08-18', library, history, count: 4, size: 8 });

    expect(mixes[0].title).toBe('Микс дня · Третий');
  });

  it('один и тот же трек с двух сервисов кладёт один раз', () => {
    const duplicated: UnifiedTrack[] = [
      ...library,
      track('sc_dup', 'Первый', 'A0'), // тот же трек, другой сервис
      track('yt_a0', 'Первый', 'A0')
    ];

    const mixes = buildDailyMixes({ dateKey: '2026-08-18', library: duplicated, count: 1, size: 24 });
    const titles = mixes[0].tracks.map((t) => `${t.artist}::${t.title}`);

    expect(new Set(titles).size).toBe(titles.length);
  });

  it('часовые записи в микс не попадают', () => {
    const withLongForm: UnifiedTrack[] = [
      ...library,
      track('yt_long', 'Первый', 'Полный концерт', { duration: 7200 })
    ];

    const mixes = buildDailyMixes({ dateKey: '2026-08-18', library: withLongForm, count: 1, size: 24 });

    expect(mixes[0].tracks.some((t) => t.id === 'yt_long')).toBe(false);
  });

  it('добирает состав из истории и избранного, а не только из медиатеки', () => {
    const history = Array.from({ length: 5 }, (_, i) => played(track(`yt_h${i}`, 'Из истории', `H${i}`), 2));
    const favorites = Array.from({ length: 5 }, (_, i) => track(`yt_f${i}`, 'Из избранного', `F${i}`));

    const mixes = buildDailyMixes({ dateKey: '2026-08-18', history, favorites, count: 1, size: 10 });

    expect(mixes).toHaveLength(1);
    expect(mixes[0].tracks).toHaveLength(10);
    const artists = new Set(mixes[0].tracks.map((t) => t.artist));
    expect(artists).toEqual(new Set(['Из истории', 'Из избранного']));
  });

  it('короткий микс лучше не показывать вообще', () => {
    // Двое артистов по три трека: на полноценный микс не хватает.
    const thin = [
      ...Array.from({ length: 4 }, (_, i) => track(`yt_x${i}`, 'Икс', `X${i}`)),
      ...Array.from({ length: 4 }, (_, i) => track(`yt_y${i}`, 'Игрек', `Y${i}`))
    ];

    const mixes = buildDailyMixes({ dateKey: '2026-08-18', library: thin, count: 3, size: 20 });

    // Один микс из восьми треков — ровно на границе, больше не набралось.
    expect(mixes).toHaveLength(1);
    expect(mixes[0].tracks).toHaveLength(8);
    expect(mixes[0].tracks.length).toBeGreaterThanOrEqual(DAILY_MIX_MIN_TRACKS);
  });
});
