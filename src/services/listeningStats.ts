import { AudioSource, UnifiedTrack } from '../types/music';
import { HistoryRecord, PlayEventRecord } from './db';
import { normalizeArtist } from './recommendationEngine';

/**
 * Итоги прослушанного — из истории, без всякой телеметрии.
 *
 * Считать тут можно только то, что база действительно помнит, и помнит она это
 * в двух видах. В `history` на трек лежит одна запись со счётчиком включений —
 * по ней считается «за всё время», и она есть у всех, даже у тех, кто слушал
 * задолго до появления этого раздела. Отдельные включения со временем лежат в
 * `plays`, и только по ним можно отрезать окно: неделю или месяц.
 *
 * Отсюда и разделение окон ниже. Складывать одно с другим нельзя: счётчик в
 * `history` не знает, когда случилось каждое из включений, а события знают, но
 * начинаются с того дня, как их начали писать.
 */

export interface ArtistStat {
  /** Написание, которое чаще встречается в истории. */
  artist: string;
  plays: number;
  /** Разных треков этого артиста. */
  tracks: number;
}

export interface TrackStat {
  track: UnifiedTrack;
  plays: number;
  playedAt: number;
}

export interface SourceStat {
  source: AudioSource;
  plays: number;
  /** Доля от всех прослушиваний, 0..1. */
  share: number;
}

export interface ListeningStats {
  totalPlays: number;
  uniqueTracks: number;
  uniqueArtists: number;
  /**
   * Примерное время: длительность × число включений. Считает трек целиком,
   * даже если его выключили на середине, поэтому это «примерно» и никак иначе.
   */
  approxSeconds: number;
  /**
   * Дослушано до конца — только там, где движок успел это записать.
   *
   * Есть лишь за всё время: счётчик в записи трека не помнит, к какому дню
   * относится каждое дослушивание, поэтому в окне неделя/месяц здесь нули, а
   * не догадка.
   */
  completed: number;
  skipped: number;
  topArtists: ArtistStat[];
  topTracks: TrackStat[];
  sources: SourceStat[];
  /** Первое и последнее известное прослушивание. */
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  /** Треков, к которым возвращались за последние 30 дней. */
  activeLast30Days: number;
}

export const STATS_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Окно итогов.
 *
 * Неделя и месяц — скользящие: «последние 7 дней», а не «с понедельника».
 * Календарная неделя честнее выглядит только в отчётах; здесь она означала бы,
 * что в воскресенье вечером топ богатый, а в понедельник утром пустой.
 */
export type StatsPeriod = 'week' | 'month' | 'all';

export const STATS_PERIODS: readonly StatsPeriod[] = ['week', 'month', 'all'];

/** Длина окна. У «за всё время» границы нет — оно считается по счётчикам. */
export const STATS_PERIOD_MS: Record<Exclude<StatsPeriod, 'all'>, number> = {
  week: 7 * 24 * 60 * 60 * 1000,
  month: STATS_RECENT_WINDOW_MS
};

export const STATS_PERIOD_LABELS: Record<StatsPeriod, string> = {
  week: 'Неделя',
  month: 'Месяц',
  all: 'Всё время'
};

/** Самое длинное окно, которое считается по событиям, — сколько их и грузить. */
export const STATS_MAX_WINDOW_MS = STATS_PERIOD_MS.month;

/** Начало окна: с какого времени брать включения. Для «всё время» — 0. */
export function statsPeriodStart(period: StatsPeriod, now: number): number {
  if (period === 'all') return 0;
  return Math.max(0, now - STATS_PERIOD_MS[period]);
}

const EMPTY_STATS: ListeningStats = {
  totalPlays: 0,
  uniqueTracks: 0,
  uniqueArtists: 0,
  approxSeconds: 0,
  completed: 0,
  skipped: 0,
  topArtists: [],
  topTracks: [],
  sources: [],
  firstPlayedAt: null,
  lastPlayedAt: null,
  activeLast30Days: 0
};

/** Число, которому можно верить: не NaN, не бесконечность, не меньше нуля. */
function sane(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export interface ListeningStatsOptions {
  /** Момент «сейчас» — передаётся, чтобы тесты не зависели от часов. */
  now?: number;
  topLimit?: number;
}

export interface PeriodStatsInput extends ListeningStatsOptions {
  period: StatsPeriod;
  /** Записи истории — единственный источник для «за всё время». */
  records: HistoryRecord[];
  /**
   * Отдельные включения. Для окна неделя/месяц считается только по ним, и
   * ключи в них должны находиться среди `records`, иначе включение не в чем
   * показать — такое событие пропускается.
   */
  events?: PlayEventRecord[];
}

/**
 * Сводит включения в окне к тем же записям, которыми считается «всё время».
 *
 * Смысл в том, чтобы окно не заводило второй способ считать. Событие знает
 * ключ трека и время; песню к ключу даёт история. Дальше это обычные записи с
 * пересчитанным числом включений — и складывает их та же функция, что и всегда.
 *
 * Пропуски и дослушивания сюда не переносятся нарочно: их счётчик в истории не
 * знает, к какому дню относится, и приписать его окну было бы догадкой.
 */
function collapseEvents(
  events: PlayEventRecord[],
  records: HistoryRecord[],
  since: number,
  until: number
): HistoryRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const counted = new Map<string, { record: HistoryRecord; plays: number; playedAt: number }>();

  for (const event of events) {
    if (!event || !event.trackId) continue;
    const playedAt = event.playedAt;
    if (!Number.isFinite(playedAt) || playedAt < since || playedAt > until) continue;

    const source = byId.get(event.trackId);
    if (!source) continue;

    const entry = counted.get(event.trackId);
    if (entry) {
      entry.plays += 1;
      if (playedAt > entry.playedAt) entry.playedAt = playedAt;
    } else {
      counted.set(event.trackId, { record: source, plays: 1, playedAt });
    }
  }

  return [...counted.values()].map(({ record, plays, playedAt }) => ({
    id: record.id,
    track: record.track,
    playedAt,
    playCount: plays
  }));
}

/**
 * Итоги за окно: неделя, месяц или всё время.
 *
 * «Всё время» считается по счётчикам в истории — так оно работает и у тех, кто
 * слушал до появления отдельных событий. Более короткие окна считаются только
 * по событиям: счётчик не помнит дат, и отрезать по нему нечего.
 */
export function buildPeriodStats(input: PeriodStatsInput): ListeningStats {
  const now = input.now ?? Date.now();
  const options: ListeningStatsOptions = { now, topLimit: input.topLimit };

  if (input.period === 'all') return buildListeningStats(input.records, options);

  const since = statsPeriodStart(input.period, now);
  return buildListeningStats(
    collapseEvents(input.events ?? [], input.records ?? [], since, now),
    options
  );
}

export function buildListeningStats(
  history: HistoryRecord[],
  options: ListeningStatsOptions = {}
): ListeningStats {
  const now = options.now ?? Date.now();
  const topLimit = Math.max(1, options.topLimit ?? 5);

  const records = (history || []).filter((record) => record && record.track && record.track.id);
  if (records.length === 0) return { ...EMPTY_STATS };

  const artists = new Map<string, { plays: number; tracks: number; names: Map<string, number> }>();
  const sources = new Map<AudioSource, number>();
  const trackStats: TrackStat[] = [];

  let totalPlays = 0;
  let approxSeconds = 0;
  let completed = 0;
  let skipped = 0;
  let firstPlayedAt: number | null = null;
  let lastPlayedAt: number | null = null;
  let activeLast30Days = 0;

  for (const record of records) {
    // Запись без счётчика — это всё-таки одно прослушивание: её создало
    // именно оно.
    const plays = Math.max(1, Math.round(sane(record.playCount, 1)));
    const playedAt = sane(record.playedAt, 0);
    const track = record.track;

    totalPlays += plays;
    approxSeconds += sane(track.duration) * plays;
    completed += Math.round(sane(record.completedCount));
    skipped += Math.round(sane(record.skipCount));

    if (playedAt > 0) {
      if (firstPlayedAt === null || playedAt < firstPlayedAt) firstPlayedAt = playedAt;
      if (lastPlayedAt === null || playedAt > lastPlayedAt) lastPlayedAt = playedAt;
      if (now - playedAt <= STATS_RECENT_WINDOW_MS) activeLast30Days += 1;
    }

    const key = normalizeArtist(track.artist) || ' unknown';
    const entry = artists.get(key) ?? { plays: 0, tracks: 0, names: new Map<string, number>() };
    entry.plays += plays;
    entry.tracks += 1;
    const displayName = (track.artist || '').trim() || 'Неизвестный исполнитель';
    entry.names.set(displayName, (entry.names.get(displayName) ?? 0) + plays);
    artists.set(key, entry);

    sources.set(track.source, (sources.get(track.source) ?? 0) + plays);
    trackStats.push({ track, plays, playedAt });
  }

  const topArtists: ArtistStat[] = [...artists.values()]
    .map((entry) => ({
      artist: [...entry.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
      plays: entry.plays,
      tracks: entry.tracks
    }))
    // При равенстве сортируем по имени: иначе порядок «топа» пляшет при
    // каждом пересчёте, и кажется, что данные меняются сами.
    .sort((a, b) => b.plays - a.plays || b.tracks - a.tracks || a.artist.localeCompare(b.artist))
    .slice(0, topLimit);

  const topTracks = trackStats
    .sort(
      (a, b) =>
        b.plays - a.plays || b.playedAt - a.playedAt || a.track.title.localeCompare(b.track.title)
    )
    .slice(0, topLimit);

  const sourceStats: SourceStat[] = [...sources.entries()]
    .map(([source, plays]) => ({ source, plays, share: totalPlays > 0 ? plays / totalPlays : 0 }))
    .sort((a, b) => b.plays - a.plays || a.source.localeCompare(b.source));

  return {
    totalPlays,
    uniqueTracks: records.length,
    uniqueArtists: artists.size,
    approxSeconds: Math.round(approxSeconds),
    completed,
    skipped,
    topArtists,
    topTracks,
    sources: sourceStats,
    firstPlayedAt,
    lastPlayedAt,
    activeLast30Days
  };
}

/** «12 ч 30 мин» / «45 мин» / «меньше минуты» — для крупной цифры на карточке. */
export function formatListeningTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(sane(totalSeconds)));
  if (seconds < 60) return 'меньше минуты';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours === 0) return `${minutes} мин`;
  if (minutes === 0) return `${hours} ч`;
  return `${hours} ч ${minutes} мин`;
}
