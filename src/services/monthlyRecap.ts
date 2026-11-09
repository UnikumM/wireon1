/**
 * Месячный рекап — короткий итог прошедшего месяца (идея 28 плана 4.0, усечённо).
 *
 * Сравнения с друзьями здесь нет и не будет в этом виде: на сервере нет
 * аккаунтов, и сравнивать не с кем. Считается только своё, только на устройстве.
 *
 * Откуда числа. В `history` на трек лежит одна строка с последним `playedAt` и
 * общим `playCount` — по ней не скажешь, сколько раз трек играл именно в октябре.
 * Поэтому месяц режется по ленте включений (`plays`): одно включение — одна
 * запись со временем. `history` нужна, чтобы по ключу трека достать название,
 * обложку и исполнителя, и ещё как свидетель прошлого для «новых исполнителей».
 *
 * Что считается честно и что выброшено:
 *   • прослушивания, топы, самый громкий день, серия дней — по событиям месяца;
 *   • минуты — только из `seconds` событий, то есть из того, что реально
 *     прозвучало. Умножать длительность трека на счётчик нельзя: именно так
 *     прежний подсчёт врал (см. `HistoryRecord.totalSeconds`). Если ни у одного
 *     включения месяца секунд нет, минут нет вовсе (`null`), а не ноль;
 *   • сравнение с прошлым месяцем — в процентах по прослушиваниям; когда в
 *     прошлом месяце не было ничего, проценты не считаются (`null`).
 *
 * Пропущенные включения (`skipped`) не считаются нигде: это не прослушивание.
 */

import { UnifiedTrack } from '../types/music';
import { HistoryRecord, PlayEventRecord } from './db';
import { longestDayStreak } from './recap';
import { normalizeArtistKey } from './tasteProfile';
import { startOfDay } from './listeningCalendar';

/** Месяц как в `Date`: `month` от 0 (январь) до 11 (декабрь). */
export interface MonthRef {
  year: number;
  month: number;
}

export interface MonthlyRecapInput {
  /** Лента включений — любая глубина; месяц и его предшественник вырезаются сами. */
  events: ReadonlyArray<PlayEventRecord>;
  /** Записи истории — источник треков и свидетель более ранних прослушиваний. */
  history: ReadonlyArray<HistoryRecord>;
}

export interface MonthlyTopTrack {
  track: UnifiedTrack;
  plays: number;
}

export interface MonthlyTopArtist {
  name: string;
  plays: number;
  artworkUrl: string;
}

export interface MonthlyRecap {
  year: number;
  month: number;
  /** Начало и конец месяца по местному времени (конец — исключительно). */
  from: number;
  to: number;
  plays: number;
  /** Минуты, что реально прозвучали; `null`, когда секунд не записано ни у одного включения. */
  minutes: number | null;
  topTracks: MonthlyTopTrack[];
  topArtists: MonthlyTopArtist[];
  /** Исполнители, которых в этом месяце включили впервые. */
  newArtists: string[];
  /** День с наибольшим числом прослушиваний: полночь дня и сколько раз включали. */
  busiestDay: { date: number; plays: number } | null;
  /** Самая длинная цепочка дней подряд с музыкой внутри месяца. */
  streakDays: number;
  comparedToPrevious: {
    /** Сколько прослушиваний было в прошлом месяце. */
    plays: number;
    /** Разница с прошлым месяцем в процентах; `null`, если сравнивать не с чем. */
    playsDelta: number | null;
  };
}

/** Меньше десяти включений — не месяц, а случайность; рекапа нет. */
export const MONTHLY_RECAP_MIN_PLAYS = 10;

/** Сколько дней в начале месяца рекап стоит на главной. */
export const MONTHLY_RECAP_HOME_DAYS = 7;

/** Ключ настройки с закрытым на главной рекапом: хранит `monthKey` того месяца. */
export const MONTHLY_RECAP_DISMISSED_KEY = 'recap.monthly.dismissed';

const TOP_LIMIT = 3;

const MONTHS_NOMINATIVE = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];

const MONTHS_PREPOSITIONAL = [
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'
];

/** «Октябрь» — именительный, для заголовка. */
export function monthName(ref: MonthRef): string {
  return MONTHS_NOMINATIVE[ref.month] ?? '';
}

/** «в октябре» — предложный, для сравнения. */
export function monthInName(ref: MonthRef): string {
  return `в ${MONTHS_PREPOSITIONAL[ref.month] ?? ''}`.trim();
}

/** `2026-10` — ключ месяца для настроек; номер месяца от единицы, как пишут люди. */
export function monthKey(ref: MonthRef): string {
  return `${ref.year}-${String(ref.month + 1).padStart(2, '0')}`;
}

/** Месяц, предшествующий тому, в котором стоит `now`. */
export function previousMonth(now: number): MonthRef {
  const date = new Date(now);
  const shifted = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return { year: shifted.getFullYear(), month: shifted.getMonth() };
}

/** Месяц, в который попадает `now`. */
export function monthOf(now: number): MonthRef {
  const date = new Date(now);
  return { year: date.getFullYear(), month: date.getMonth() };
}

/** Границы месяца по местному времени: `[from, to)`. */
export function monthRange(ref: MonthRef): { from: number; to: number } {
  return {
    from: new Date(ref.year, ref.month, 1).getTime(),
    to: new Date(ref.year, ref.month + 1, 1).getTime()
  };
}

/**
 * Первые дни месяца — время показать итог прошлого на главной.
 * Дальше он живёт только в «Для вас»: напоминание не должно висеть месяц.
 */
export function withinHomeWindow(now: number): boolean {
  return new Date(now).getDate() <= MONTHLY_RECAP_HOME_DAYS;
}

function artistKeyOf(track: UnifiedTrack): string {
  return normalizeArtistKey(track.artist) || track.artist.trim().toLowerCase();
}

function countPlays(events: ReadonlyArray<PlayEventRecord>, from: number, to: number): number {
  let total = 0;
  for (const event of events) {
    if (event && !event.skipped && event.playedAt >= from && event.playedAt < to) total += 1;
  }
  return total;
}

export function buildMonthlyRecap(input: MonthlyRecapInput, ref: MonthRef): MonthlyRecap {
  const { from, to } = monthRange(ref);
  const previous = monthRange(previousMonth(from));

  const byId = new Map<string, HistoryRecord>();
  for (const record of input.history) if (record?.id && record.track) byId.set(record.id, record);

  const trackPlays = new Map<string, number>();
  const artistPlays = new Map<string, MonthlyTopArtist>();
  const dayPlays = new Map<number, number>();
  /** Исполнители, у которых есть включение до начала месяца, — они точно не новые. */
  const heardBefore = new Set<string>();
  /** Сколько раз в месяце включали треки каждого исполнителя — для сверки со счётчиком. */
  const artistMonthPlays = new Map<string, number>();
  let plays = 0;
  let seconds = 0;
  let secondsKnown = false;

  for (const event of input.events) {
    if (!event || event.skipped) continue;
    const record = byId.get(event.trackId);
    if (event.playedAt < from) {
      if (record) heardBefore.add(artistKeyOf(record.track));
      continue;
    }
    if (event.playedAt >= to) continue;

    plays += 1;
    if (typeof event.seconds === 'number' && event.seconds > 0) {
      seconds += event.seconds;
      secondsKnown = true;
    }
    trackPlays.set(event.trackId, (trackPlays.get(event.trackId) ?? 0) + 1);
    const day = startOfDay(event.playedAt);
    dayPlays.set(day, (dayPlays.get(day) ?? 0) + 1);

    if (!record) continue;
    const key = artistKeyOf(record.track);
    const artist = artistPlays.get(key) ?? { name: record.track.artist, plays: 0, artworkUrl: record.track.artworkUrl || '' };
    artist.plays += 1;
    if (!artist.artworkUrl && record.track.artworkUrl) artist.artworkUrl = record.track.artworkUrl;
    artistPlays.set(key, artist);
    artistMonthPlays.set(key, (artistMonthPlays.get(key) ?? 0) + 1);
  }

  /*
   * «Новый» — тот, о ком до этого месяца не знала ни лента, ни история.
   * Лента чистится на четырёхстах днях, поэтому одной её мало: исполнителя,
   * слушанного два года назад, она уже не помнит. История помнит: если её
   * счётчик по трекам исполнителя больше, чем включений в этом месяце, или
   * последнее включение какого-то его трека было раньше начала месяца —
   * слушали и до того.
   */
  const artistTotalCount = new Map<string, number>();
  for (const record of byId.values()) {
    const key = artistKeyOf(record.track);
    if (!artistPlays.has(key)) continue;
    artistTotalCount.set(key, (artistTotalCount.get(key) ?? 0) + Math.max(0, record.playCount ?? 0));
    if (record.playedAt && record.playedAt < from && (record.playCount ?? 0) > 0) heardBefore.add(key);
  }
  const newArtists: string[] = [];
  for (const [key, artist] of artistPlays) {
    if (heardBefore.has(key)) continue;
    if ((artistTotalCount.get(key) ?? 0) > (artistMonthPlays.get(key) ?? 0)) continue;
    newArtists.push(artist.name);
  }

  const topTracks: MonthlyTopTrack[] = [...trackPlays.entries()]
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_LIMIT)
    .map(([id, count]) => ({ track: byId.get(id)!.track, plays: count }));

  const topArtists = [...artistPlays.values()]
    .sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name))
    .slice(0, TOP_LIMIT);

  let busiestDay: MonthlyRecap['busiestDay'] = null;
  for (const [date, count] of dayPlays) {
    if (!busiestDay || count > busiestDay.plays || (count === busiestDay.plays && date < busiestDay.date)) {
      busiestDay = { date, plays: count };
    }
  }

  const previousPlays = countPlays(input.events, previous.from, previous.to);
  const playsDelta = previousPlays > 0 ? Math.round(((plays - previousPlays) / previousPlays) * 100) : null;

  return {
    year: ref.year,
    month: ref.month,
    from,
    to,
    plays,
    minutes: secondsKnown ? Math.round(seconds / 60) : null,
    topTracks,
    topArtists,
    newArtists,
    busiestDay,
    streakDays: longestDayStreak(dayPlays.keys()),
    comparedToPrevious: { plays: previousPlays, playsDelta }
  };
}

/** Рекапу есть что сказать: не меньше десяти включений и хотя бы один известный трек. */
export function hasMonthlyRecap(recap: MonthlyRecap | null | undefined): recap is MonthlyRecap {
  return Boolean(recap && recap.plays >= MONTHLY_RECAP_MIN_PLAYS && recap.topTracks.length > 0);
}

/** То же, но от сырых данных: собрать и проверить. */
export function recapAvailable(input: MonthlyRecapInput, ref: MonthRef): boolean {
  return hasMonthlyRecap(buildMonthlyRecap(input, ref));
}

/**
 * Строка сравнения: «на 23% больше, чем в сентябре».
 * Без прошлого месяца — честное «в сентябре ничего не слушали», а не «на 100% больше».
 */
export function formatComparison(recap: MonthlyRecap): string {
  const prev = previousMonth(recap.from);
  const delta = recap.comparedToPrevious.playsDelta;
  if (delta === null) return `${monthInName(prev).replace(/^в/, 'В')} ничего не слушали`;
  if (delta === 0) return `Столько же, сколько ${monthInName(prev)}`;
  const word = delta > 0 ? 'больше' : 'меньше';
  return `На ${Math.abs(delta)}% ${word}, чем ${monthInName(prev)}`;
}
