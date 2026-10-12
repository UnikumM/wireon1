/**
 * Авто-подборки, которые ведут себя сами — как «On Repeat», «Repeat Rewind» и
 * «daylist» у Spotify.
 *
 * В отличие от миксов дня (`dailyMixes.ts`, подборка по исполнителям) эти
 * списки отвечают на вопросы о времени:
 *
 *  - **На повторе** — что вы крутите последние 30 дней;
 *  - **Машина времени** — что когда-то слушали помногу, а потом забыли;
 *  - **Под это время** — что вы обычно слушаете именно в эту часть суток
 *    (утро буднего дня звучит иначе, чем ночь пятницы);
 *  - **Свежее в медиатеке** — что вы недавно себе сложили.
 *
 * Всё считается на устройстве из истории и отдельных включений; ничего не
 * ходит в сеть, поэтому подборки работают и офлайн. Функции чистые: время
 * передаётся снаружи, и тесты не зависят от часов.
 */

import { UnifiedTrack } from '../types/music';
import { HistoryRecord, PlayEventRecord } from './db';

export type AutoMixKind = 'on-repeat' | 'time-machine' | 'daypart' | 'fresh';

export interface AutoMix {
  id: string;
  kind: AutoMixKind;
  title: string;
  subtitle: string;
  artworkUrl: string;
  tracks: UnifiedTrack[];
}

export interface AutoMixInput {
  /** Строки истории: по ним треки находятся по id и берутся счётчики. */
  history: ReadonlyArray<HistoryRecord>;
  /** Отдельные включения за последние месяцы (хватает 90 дней). */
  events: ReadonlyArray<PlayEventRecord>;
  favorites?: ReadonlyArray<UnifiedTrack>;
  /** Треки плейлистов — для «Свежего». */
  library?: ReadonlyArray<UnifiedTrack>;
  /** Треки, которые человек отверг: в подборки они не попадают. */
  dislikedIds?: ReadonlySet<string>;
  now: number;
  size?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const AUTO_MIX_SIZE = 30;
/** Меньше — не подборка, а случайность. */
export const AUTO_MIX_MIN_TRACKS = 5;

export const ON_REPEAT_WINDOW_MS = 30 * DAY_MS;
export const TIME_MACHINE_QUIET_MS = 60 * DAY_MS;
export const DAYPART_WINDOW_MS = 90 * DAY_MS;
export const FRESH_WINDOW_MS = 30 * DAY_MS;

export type DayPart = 'morning' | 'day' | 'evening' | 'night';

/** Утро 5–11, день 11–17, вечер 17–22, ночь 22–5 — по местному времени. */
export function dayPartOf(timestamp: number): DayPart {
  const hour = new Date(timestamp).getHours();
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'day';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

const DAYPART_LABELS: Record<DayPart, string> = {
  morning: 'Утро',
  day: 'День',
  evening: 'Вечер',
  night: 'Ночь'
};

const WEEKDAY_GENITIVE = ['воскресенья', 'понедельника', 'вторника', 'среды', 'четверга', 'пятницы', 'субботы'];

/**
 * «Утро понедельника», «Ночь пятницы». Ночь после полуночи относится к
 * предыдущему дню: в два часа ночи на субботу человек всё ещё в пятнице.
 */
export function dayPartTitle(now: number): string {
  const part = dayPartOf(now);
  const date = new Date(now);
  let weekday = date.getDay();
  if (part === 'night' && date.getHours() < 5) weekday = (weekday + 6) % 7;
  return `${DAYPART_LABELS[part]} ${WEEKDAY_GENITIVE[weekday]}`;
}

function isWeekend(timestamp: number): boolean {
  const day = new Date(timestamp).getDay();
  return day === 0 || day === 6;
}

function indexHistory(history: ReadonlyArray<HistoryRecord>): Map<string, HistoryRecord> {
  const map = new Map<string, HistoryRecord>();
  for (const record of history) {
    if (record?.id && record.track?.id) map.set(record.id, record);
  }
  return map;
}

/** Не больше `perArtist` треков одного исполнителя подряд в начале списка. */
function spreadArtists(tracks: UnifiedTrack[], perArtist: number, size: number): UnifiedTrack[] {
  const counts = new Map<string, number>();
  const picked: UnifiedTrack[] = [];
  const overflow: UnifiedTrack[] = [];
  for (const track of tracks) {
    const key = (track.artist || '').toLowerCase().trim();
    const n = counts.get(key) ?? 0;
    if (n < perArtist) {
      counts.set(key, n + 1);
      picked.push(track);
    } else {
      overflow.push(track);
    }
    if (picked.length >= size) break;
  }
  // Если разных исполнителей мало, лучше длиннее список, чем короче.
  for (const track of overflow) {
    if (picked.length >= size) break;
    picked.push(track);
  }
  return picked;
}

function makeMix(kind: AutoMixKind, title: string, subtitle: string, tracks: UnifiedTrack[], now: number): AutoMix {
  return {
    id: `auto_${kind}_${new Date(now).toDateString()}`,
    kind,
    title,
    subtitle,
    artworkUrl: tracks.find((t) => t.artworkUrl)?.artworkUrl ?? '',
    tracks
  };
}

function eligible(track: UnifiedTrack | undefined, disliked?: ReadonlySet<string>): track is UnifiedTrack {
  return Boolean(track && track.id && !(disliked && disliked.has(track.id)));
}

/** Самое прослушиваемое за 30 дней: не меньше двух засчитанных включений. */
export function buildOnRepeat(input: AutoMixInput): AutoMix | null {
  const size = input.size ?? AUTO_MIX_SIZE;
  const since = input.now - ON_REPEAT_WINDOW_MS;
  const byId = indexHistory(input.history);
  const plays = new Map<string, { count: number; last: number }>();
  for (const event of input.events) {
    if (!event || event.playedAt < since || event.skipped) continue;
    const entry = plays.get(event.trackId) ?? { count: 0, last: 0 };
    entry.count += 1;
    entry.last = Math.max(entry.last, event.playedAt);
    plays.set(event.trackId, entry);
  }
  const ranked = [...plays.entries()]
    .filter(([, p]) => p.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
    .map(([id]) => byId.get(id)?.track)
    .filter((track): track is UnifiedTrack => eligible(track, input.dislikedIds));
  const tracks = spreadArtists(ranked, 4, size);
  if (tracks.length < AUTO_MIX_MIN_TRACKS) return null;
  return makeMix('on-repeat', 'На повторе', 'Что вы крутите последние 30 дней', tracks, input.now);
}

/**
 * Любимое, но забытое: слушали не меньше трёх раз, а последние два месяца —
 * ни разу. Избранное, которое давно не играло, тоже сюда.
 */
export function buildTimeMachine(input: AutoMixInput): AutoMix | null {
  const size = input.size ?? AUTO_MIX_SIZE;
  const quietSince = input.now - TIME_MACHINE_QUIET_MS;
  const recentlyPlayed = new Set(
    input.events.filter((e) => e && e.playedAt >= quietSince).map((e) => e.trackId)
  );
  const scored: Array<{ track: UnifiedTrack; score: number }> = [];
  const seen = new Set<string>();
  for (const record of input.history) {
    if (!record?.track?.id || seen.has(record.id)) continue;
    if (record.playedAt >= quietSince || recentlyPlayed.has(record.id)) continue;
    const playCount = record.playCount || 0;
    if (playCount < 3) continue;
    // Сильный ранний отказ — не забытая любовь, а разлюбленное.
    const skips = record.earlySkipCount ?? 0;
    if (skips > playCount) continue;
    seen.add(record.id);
    scored.push({ track: record.track, score: playCount });
  }
  const byId = indexHistory(input.history);
  for (const favorite of input.favorites ?? []) {
    if (!favorite?.id || seen.has(favorite.id) || recentlyPlayed.has(favorite.id)) continue;
    const record = byId.get(favorite.id);
    // Положено в избранное давно и с тех пор не звучало.
    const lastHeard = record?.playedAt ?? favorite.addedAt ?? input.now;
    if (lastHeard >= quietSince) continue;
    seen.add(favorite.id);
    scored.push({ track: favorite, score: 2 + (record?.playCount ?? 0) });
  }
  const ranked = scored
    .sort((a, b) => b.score - a.score)
    .map((s) => s.track)
    .filter((track) => eligible(track, input.dislikedIds));
  const tracks = spreadArtists(ranked, 3, size);
  if (tracks.length < AUTO_MIX_MIN_TRACKS) return null;
  return makeMix('time-machine', 'Машина времени', 'Любимое, которое вы давно не включали', tracks, input.now);
}

/**
 * Что звучит у человека в эту часть суток. Включение в ту же часть суток даёт
 * очко, совпадение будни/выходные — ещё половину: утро понедельника и утро
 * субботы — разные утра.
 */
export function buildDayPart(input: AutoMixInput): AutoMix | null {
  const size = input.size ?? AUTO_MIX_SIZE;
  const since = input.now - DAYPART_WINDOW_MS;
  const part = dayPartOf(input.now);
  const weekend = isWeekend(input.now);
  const byId = indexHistory(input.history);
  const score = new Map<string, number>();
  for (const event of input.events) {
    if (!event || event.playedAt < since || event.skipped) continue;
    if (dayPartOf(event.playedAt) !== part) continue;
    const bonus = isWeekend(event.playedAt) === weekend ? 1.5 : 1;
    // Свежие включения весят больше: вкус сдвигается.
    const age = (input.now - event.playedAt) / DAYPART_WINDOW_MS;
    score.set(event.trackId, (score.get(event.trackId) ?? 0) + bonus * (1.25 - age * 0.5));
  }
  const ranked = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id)?.track)
    .filter((track): track is UnifiedTrack => eligible(track, input.dislikedIds));
  const tracks = spreadArtists(ranked, 3, size);
  if (tracks.length < AUTO_MIX_MIN_TRACKS) return null;
  return makeMix('daypart', dayPartTitle(input.now), 'То, что вы обычно слушаете в это время', tracks, input.now);
}

/** Сложенное за последний месяц: избранное и треки плейлистов, новые сверху. */
export function buildFresh(input: AutoMixInput): AutoMix | null {
  const size = input.size ?? AUTO_MIX_SIZE;
  const since = input.now - FRESH_WINDOW_MS;
  const byId = new Map<string, UnifiedTrack>();
  for (const track of [...(input.favorites ?? []), ...(input.library ?? [])]) {
    if (!eligible(track, input.dislikedIds) || !track.addedAt || track.addedAt < since) continue;
    const known = byId.get(track.id);
    if (!known || (known.addedAt ?? 0) < track.addedAt) byId.set(track.id, track);
  }
  const tracks = [...byId.values()].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)).slice(0, size);
  if (tracks.length < AUTO_MIX_MIN_TRACKS) return null;
  return makeMix('fresh', 'Свежее в медиатеке', 'Что вы сохранили за последний месяц', tracks, input.now);
}

/** Все подборки, которые набрались. Порядок — от самой «живой». */
export function buildAutoMixes(input: AutoMixInput): AutoMix[] {
  return [buildDayPart(input), buildOnRepeat(input), buildTimeMachine(input), buildFresh(input)].filter(
    (mix): mix is AutoMix => mix !== null
  );
}
