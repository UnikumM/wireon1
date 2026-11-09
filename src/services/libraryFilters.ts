/**
 * Живые фильтры медиатеки: чипы над «Недавними» и «Избранным».
 *
 * Поиск по строке отвечает на «я помню, как называется», а чипы — на «хочу
 * что-нибудь короткое с SoundCloud, что давно не включал». Фильтры складываются
 * по «И», считаются на месте по тому, что уже лежит на устройстве, и переводятся
 * один в один в правила умного плейлиста — поэтому набор чипов можно сохранить и
 * дальше он будет собираться сам.
 *
 * Года здесь нет нарочно: в `UnifiedTrack` такого поля не существует, и чип без
 * данных показывал бы пустой список.
 */

import type { AudioSource, UnifiedTrack } from '../types/music';
import type { SmartRule } from './smartPlaylists';

export type DurationBucket = 'short' | 'medium' | 'long';

export interface LibraryFilters {
  source: AudioSource | null;
  duration: DurationBucket | null;
  /** Нет прослушивания {@link STALE_DAYS} дней — включая ни разу не игравшие. */
  stale: boolean;
  /** Файл лежит на устройстве. */
  offline: boolean;
}

export const EMPTY_FILTERS: LibraryFilters = { source: null, duration: null, stale: false, offline: false };

/** «Давно не слушал» — три месяца: месяц слишком часто ловит просто отпуск. */
export const STALE_DAYS = 90;

/** Границы корзин длительности в минутах: до 3 / 3–6 / дольше 6. */
export const DURATION_BUCKETS: Record<DurationBucket, { label: string; minMinutes: number | null; maxMinutes: number | null }> = {
  short: { label: 'До 3 мин', minMinutes: null, maxMinutes: 3 },
  medium: { label: '3–6 мин', minMinutes: 3, maxMinutes: 6 },
  long: { label: 'Дольше 6 мин', minMinutes: 6, maxMinutes: null }
};

export interface FilterContext {
  /** Последнее включение по id трека — из истории (`playedAt`). */
  lastPlayedById: ReadonlyMap<string, number>;
  offlineIds: ReadonlySet<string>;
  now: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function countActiveFilters(filters: LibraryFilters): number {
  return (filters.source ? 1 : 0) + (filters.duration ? 1 : 0) + (filters.stale ? 1 : 0) + (filters.offline ? 1 : 0);
}

export function hasActiveFilters(filters: LibraryFilters): boolean {
  return countActiveFilters(filters) > 0;
}

function inBucket(duration: number | undefined, bucket: DurationBucket): boolean {
  // Неизвестная длительность не попадает ни в одну корзину — как и в умных плейлистах.
  if (!duration || !Number.isFinite(duration) || duration <= 0) return false;
  const minutes = duration / 60;
  const { minMinutes, maxMinutes } = DURATION_BUCKETS[bucket];
  if (minMinutes !== null && minutes < minMinutes) return false;
  // Верхняя граница не включается, чтобы ровно 3:00 не попадало в две корзины.
  if (maxMinutes !== null && minutes >= maxMinutes) return false;
  return true;
}

export function matchesFilters(track: UnifiedTrack, filters: LibraryFilters, ctx: FilterContext): boolean {
  if (filters.source && track.source !== filters.source) return false;
  if (filters.duration && !inBucket(track.duration, filters.duration)) return false;
  if (filters.offline && !ctx.offlineIds.has(track.id)) return false;
  if (filters.stale) {
    const last = ctx.lastPlayedById.get(track.id);
    if (last !== undefined && last >= ctx.now - STALE_DAYS * DAY_MS) return false;
  }
  return true;
}

export function applyFilters(tracks: ReadonlyArray<UnifiedTrack>, filters: LibraryFilters, ctx: FilterContext): UnifiedTrack[] {
  if (!hasActiveFilters(filters)) return [...tracks];
  return tracks.filter((track) => matchesFilters(track, filters, ctx));
}

/** Чипы — правилами умного плейлиста. Порядок устойчивый, чтобы подпись читалась одинаково. */
export function filtersToSmartRules(filters: LibraryFilters): SmartRule[] {
  const rules: SmartRule[] = [];
  if (filters.source) rules.push({ field: 'source', op: 'is', value: filters.source });
  if (filters.duration) {
    const { minMinutes, maxMinutes } = DURATION_BUCKETS[filters.duration];
    if (minMinutes !== null) rules.push({ field: 'duration', op: 'gte', value: minMinutes });
    if (maxMinutes !== null) rules.push({ field: 'duration', op: 'lte', value: maxMinutes });
  }
  if (filters.stale) rules.push({ field: 'lastPlayed', op: 'not_within_days', value: STALE_DAYS });
  if (filters.offline) rules.push({ field: 'offline', op: 'is', value: true });
  return rules;
}

/** Название для сохранённого набора: «YouTube · до 3 мин · давно не слушал». */
export function describeFilters(filters: LibraryFilters): string {
  const parts: string[] = [];
  if (filters.source) parts.push(filters.source === 'youtube' ? 'YouTube' : 'SoundCloud');
  if (filters.duration) parts.push(DURATION_BUCKETS[filters.duration].label.toLowerCase());
  if (filters.stale) parts.push('давно не слушал');
  if (filters.offline) parts.push('офлайн');
  return parts.join(' · ');
}
