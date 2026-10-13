/**
 * «Открытия недели» — свой Discover Weekly.
 *
 * Раз в неделю (с понедельника) собирается тридцать треков, которых человек
 * ещё не слышал, — радио от его же любимого с регулятором «незнакомое» до
 * упора. Список фиксируется на неделю и хранится локально: возвращаться к
 * нему можно хоть каждый день, он не перетасуется и не потребует сети.
 */

import { UnifiedTrack } from '../types/music';
import * as dbService from './db';
import { dedupeKey, recommendationEngine } from './recommendationEngine';

export const DISCOVER_WEEKLY_KEY = 'discoverWeekly';
export const DISCOVER_WEEKLY_SIZE = 30;
/** Меньше — это не открытия, а случайность; лучше не показывать. */
export const DISCOVER_WEEKLY_MIN = 8;

export interface DiscoverWeekly {
  weekKey: string;
  builtAt: number;
  tracks: UnifiedTrack[];
}

/** Понедельник недели по местному времени: `2026-10-12`. */
export function weekKeyOf(now: number): string {
  const date = new Date(now);
  const day = (date.getDay() + 6) % 7; // 0 — понедельник
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - day);
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const d = String(monday.getDate()).padStart(2, '0');
  return `${monday.getFullYear()}-${m}-${d}`;
}

/** Всё, что человек уже знает: по id и по «исполнитель + название». */
async function knownTracks(): Promise<{ ids: Set<string>; keys: Set<string>; size: number }> {
  const [history, favorites] = await Promise.all([
    dbService.getAllHistory().catch(() => []),
    dbService.getFavorites().catch(() => [] as UnifiedTrack[])
  ]);
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const record of history) {
    if (!record?.track?.id) continue;
    ids.add(record.track.id);
    keys.add(dedupeKey(record.track));
  }
  for (const track of favorites) {
    if (!track?.id) continue;
    ids.add(track.id);
    keys.add(dedupeKey(track));
  }
  return { ids, keys, size: history.length + favorites.length };
}

let building: Promise<DiscoverWeekly | null> | null = null;

/**
 * Список этой недели: из кэша, а если его нет — собирает. `null` — собирать
 * не из чего (пустая медиатека) или сеть не ответила; через неделю попробуем
 * снова, а до тех пор — при следующем открытии экрана.
 */
export function getDiscoverWeekly(now: number = Date.now()): Promise<DiscoverWeekly | null> {
  if (building) return building;
  building = (async () => {
    const weekKey = weekKeyOf(now);
    const cached = await dbService.getSetting<DiscoverWeekly | null>(DISCOVER_WEEKLY_KEY, null).catch(() => null);
    if (cached && cached.weekKey === weekKey && Array.isArray(cached.tracks) && cached.tracks.length > 0) {
      return cached;
    }

    const known = await knownTracks();
    // Без истории нет и вкуса: открывать «новое для вас» не для кого.
    if (known.size < 5) return null;

    const found = await recommendationEngine
      .getRecommendationsForWave(
        { mood: 'discovery', seedKind: 'library', novelty: 0.95, energy: 0.5 },
        DISCOVER_WEEKLY_SIZE + 15,
        known.ids
      )
      .catch(() => [] as UnifiedTrack[]);

    const seen = new Set<string>();
    const tracks = found
      .filter((track) => {
        if (!track?.id || known.ids.has(track.id)) return false;
        const key = dedupeKey(track);
        if (known.keys.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, DISCOVER_WEEKLY_SIZE)
      .map(({ streamUrl: _u, streamExpiry: _e, ...rest }) => rest);

    if (tracks.length < DISCOVER_WEEKLY_MIN) return null;
    const result: DiscoverWeekly = { weekKey, builtAt: now, tracks };
    await dbService.setSetting(DISCOVER_WEEKLY_KEY, result).catch(() => undefined);
    return result;
  })().finally(() => {
    building = null;
  });
  return building;
}

/** Только для тестов. */
export function resetDiscoverWeeklyForTests(): void {
  building = null;
}
