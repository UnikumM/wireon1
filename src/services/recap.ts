/**
 * «Итоги» — своя версия Spotify Wrapped.
 *
 * Считается целиком на устройстве из отдельных включений (`plays`) и строк
 * истории. Ничего не отправляется: Wrapped у Spotify живёт на их серверах, а
 * здесь серверу о прослушанном знать незачем.
 *
 * Время — только то, что реально прозвучало (`seconds` у включения). У старых
 * включений, записанных до натурального подсчёта, секунд нет: они считаются
 * в прослушиваниях, но не в минутах — та же честность, что в «Для вас».
 */

import { UnifiedTrack } from '../types/music';
import { HistoryRecord, PlayEventRecord } from './db';
import { extractGenreTokens, normalizeArtistKey } from './tasteProfile';
import { DayPart, dayPartOf } from './autoMixes';

export type RecapPeriod = 'month' | 'year';

export interface RecapArtist {
  name: string;
  plays: number;
  minutes: number;
  artworkUrl: string;
}

export interface RecapTrack {
  track: UnifiedTrack;
  plays: number;
  minutes: number;
}

export interface RecapPersona {
  id: 'explorer' | 'loyal' | 'night-owl' | 'early-bird' | 'marathoner' | 'eclectic';
  title: string;
  description: string;
}

export interface Recap {
  period: RecapPeriod;
  /** «2026» или «Октябрь 2026». */
  label: string;
  from: number;
  to: number;
  totalPlays: number;
  totalMinutes: number;
  uniqueTracks: number;
  uniqueArtists: number;
  topArtists: RecapArtist[];
  topTracks: RecapTrack[];
  /** Самые частые стилевые слова — «жанр» по названиям. Может быть пустым. */
  topGenres: string[];
  /** Час (0–23), в который включали чаще всего. */
  peakHour: number | null;
  /** Доли прослушиваний по частям суток. */
  dayParts: Record<DayPart, number>;
  /** Самая длинная серия дней подряд с музыкой. */
  longestStreak: number;
  /** День, когда слушали больше всего, и сколько минут. */
  biggestDay: { date: number; minutes: number } | null;
  persona: RecapPersona;
}

export interface RecapInput {
  events: ReadonlyArray<PlayEventRecord>;
  history: ReadonlyArray<HistoryRecord>;
  period: RecapPeriod;
  now: number;
  topLimit?: number;
}

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];

/** Начало окна: первое число месяца или 1 января, по местному времени. */
export function recapRange(period: RecapPeriod, now: number): { from: number; to: number; label: string } {
  const date = new Date(now);
  if (period === 'month') {
    const from = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    return { from, to: now, label: `${MONTHS[date.getMonth()]} ${date.getFullYear()}` };
  }
  const from = new Date(date.getFullYear(), 0, 1).getTime();
  return { from, to: now, label: String(date.getFullYear()) };
}

function dayKey(timestamp: number): number {
  const d = new Date(timestamp);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Самая длинная цепочка подряд идущих дней. */
export function longestDayStreak(days: Iterable<number>): number {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const day of sorted) {
    // Сутки по местному времени бывают 23 и 25 часов (переход на летнее),
    // поэтому «следующий день» — это разница меньше полутора суток.
    if (prev !== null && day - prev < 36 * 3600 * 1000) run += 1;
    else run = 1;
    best = Math.max(best, run);
    prev = day;
  }
  return best;
}

const GENRE_LABELS: Record<string, string> = {
  hiphop: 'хип-хоп', rap: 'рэп', rnb: 'R&B', dnb: 'драм-н-бейс', lofi: 'лоу-фай', edm: 'EDM',
  kpop: 'K-pop', jpop: 'J-pop', postrock: 'пост-рок', boombap: 'бум-бэп', ost: 'саундтреки',
  soundtrack: 'саундтреки', score: 'саундтреки', classical: 'классика', rock: 'рок', metal: 'метал',
  pop: 'поп', jazz: 'джаз', blues: 'блюз', house: 'хаус', techno: 'техно', trance: 'транс',
  phonk: 'фонк', trap: 'трэп', indie: 'инди', folk: 'фолк', ambient: 'эмбиент', synthwave: 'синтвейв',
  punk: 'панк', electro: 'электро', dubstep: 'дабстеп', piano: 'фортепиано', soul: 'соул', funk: 'фанк'
};

export function genreLabel(token: string): string {
  return GENRE_LABELS[token] ?? token;
}

/**
 * Кто вы как слушатель. Порядок проверок — от самого яркого признака:
 * ночная жизнь и ранние подъёмы видны сразу, верность одному артисту — потом.
 */
export function pickPersona(stats: {
  totalPlays: number;
  uniqueArtists: number;
  topArtistShare: number;
  dayParts: Record<DayPart, number>;
  longestStreak: number;
}): RecapPersona {
  const { dayParts } = stats;
  if (stats.totalPlays >= 10 && dayParts.night >= 0.4) {
    return { id: 'night-owl', title: 'Ночная сова', description: 'Лучшая музыка у вас звучит, когда город спит.' };
  }
  if (stats.totalPlays >= 10 && dayParts.morning >= 0.4) {
    return { id: 'early-bird', title: 'Жаворонок', description: 'Вы начинаете день с музыки — и она задаёт ему тон.' };
  }
  if (stats.topArtistShare >= 0.3) {
    return { id: 'loyal', title: 'Верный фанат', description: 'У вас есть главный исполнитель, и вы не изменяете ему.' };
  }
  if (stats.longestStreak >= 14) {
    return { id: 'marathoner', title: 'Марафонец', description: 'Музыка с вами каждый день — без выходных.' };
  }
  if (stats.totalPlays > 0 && stats.uniqueArtists / stats.totalPlays >= 0.5) {
    return { id: 'explorer', title: 'Исследователь', description: 'Вы почти не повторяетесь — всё время ищете новое.' };
  }
  return { id: 'eclectic', title: 'Меломан без границ', description: 'Любимое и новое, утро и ночь — у вас есть всё.' };
}

export function buildRecap(input: RecapInput): Recap {
  const { from, to, label } = recapRange(input.period, input.now);
  const limit = input.topLimit ?? 5;
  const byId = new Map<string, HistoryRecord>();
  for (const record of input.history) if (record?.id && record.track) byId.set(record.id, record);

  const trackStats = new Map<string, { plays: number; seconds: number }>();
  const artistStats = new Map<string, { name: string; plays: number; seconds: number; artworkUrl: string }>();
  const genreCounts = new Map<string, number>();
  const hours = new Array<number>(24).fill(0);
  const parts: Record<DayPart, number> = { morning: 0, day: 0, evening: 0, night: 0 };
  const daySeconds = new Map<number, number>();
  let totalPlays = 0;
  let totalSeconds = 0;

  for (const event of input.events) {
    if (!event || event.playedAt < from || event.playedAt > to || event.skipped) continue;
    const record = byId.get(event.trackId);
    const track = record?.track;
    totalPlays += 1;
    const seconds = typeof event.seconds === 'number' && event.seconds > 0 ? event.seconds : 0;
    totalSeconds += seconds;

    const ts = trackStats.get(event.trackId) ?? { plays: 0, seconds: 0 };
    ts.plays += 1;
    ts.seconds += seconds;
    trackStats.set(event.trackId, ts);

    if (track) {
      const key = normalizeArtistKey(track.artist) || track.artist;
      const as = artistStats.get(key) ?? { name: track.artist, plays: 0, seconds: 0, artworkUrl: track.artworkUrl || '' };
      as.plays += 1;
      as.seconds += seconds;
      if (!as.artworkUrl && track.artworkUrl) as.artworkUrl = track.artworkUrl;
      artistStats.set(key, as);
      for (const token of extractGenreTokens(track)) genreCounts.set(token, (genreCounts.get(token) ?? 0) + 1);
    }

    hours[new Date(event.playedAt).getHours()] += 1;
    parts[dayPartOf(event.playedAt)] += 1;
    const day = dayKey(event.playedAt);
    daySeconds.set(day, (daySeconds.get(day) ?? 0) + seconds);
  }

  const topTracks: RecapTrack[] = [...trackStats.entries()]
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1].plays - a[1].plays || b[1].seconds - a[1].seconds)
    .slice(0, limit)
    .map(([id, s]) => ({ track: byId.get(id)!.track, plays: s.plays, minutes: Math.round(s.seconds / 60) }));

  const topArtists: RecapArtist[] = [...artistStats.values()]
    .sort((a, b) => b.plays - a.plays || b.seconds - a.seconds)
    .slice(0, limit)
    .map((a) => ({ name: a.name, plays: a.plays, minutes: Math.round(a.seconds / 60), artworkUrl: a.artworkUrl }));

  const topGenres = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([token]) => token);

  let peakHour: number | null = null;
  if (totalPlays > 0) {
    peakHour = hours.reduce((best, count, hour) => (count > hours[best] ? hour : best), 0);
  }

  const dayParts: Record<DayPart, number> = { morning: 0, day: 0, evening: 0, night: 0 };
  if (totalPlays > 0) {
    for (const key of Object.keys(parts) as DayPart[]) dayParts[key] = parts[key] / totalPlays;
  }

  let biggestDay: Recap['biggestDay'] = null;
  for (const [date, seconds] of daySeconds) {
    if (seconds > 0 && (!biggestDay || seconds / 60 > biggestDay.minutes)) {
      biggestDay = { date, minutes: Math.round(seconds / 60) };
    }
  }

  const longestStreak = longestDayStreak(daySeconds.keys());
  const persona = pickPersona({
    totalPlays,
    uniqueArtists: artistStats.size,
    topArtistShare: totalPlays > 0 && topArtists[0] ? topArtists[0].plays / totalPlays : 0,
    dayParts,
    longestStreak
  });

  return {
    period: input.period,
    label,
    from,
    to,
    totalPlays,
    totalMinutes: Math.round(totalSeconds / 60),
    uniqueTracks: trackStats.size,
    uniqueArtists: artistStats.size,
    topArtists,
    topTracks,
    topGenres,
    peakHour,
    dayParts,
    longestStreak,
    biggestDay,
    persona
  };
}

/** Итогам есть что показать: хотя бы пять прослушиваний. */
export function hasRecap(recap: Recap | null): recap is Recap {
  return Boolean(recap && recap.totalPlays >= 5 && recap.topTracks.length > 0);
}

/** «12 345» — с неразрывным пробелом между разрядами. */
export function formatBigNumber(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Наглядное сравнение для минут: сколько это суток или фильмов. */
export function minutesComparison(minutes: number): string {
  if (minutes >= 24 * 60 * 2) return `Это больше ${Math.floor(minutes / (24 * 60))} суток без перерыва`;
  if (minutes >= 24 * 60) return 'Это больше суток без перерыва';
  if (minutes >= 180) return `Это как ${Math.round(minutes / 120)} полнометражных фильмов подряд`;
  if (minutes >= 60) return `Это ${Math.round(minutes / 60)} ч. чистой музыки`;
  return 'Это только начало';
}

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}
