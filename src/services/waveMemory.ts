/**
 * Память «Потока»: что уже отдавали и на что человек только что отреагировал.
 *
 * Без этого файла «Поток» терял два разных вида памяти. Первый — короткий:
 * список выданных треков жил в состоянии стора, поэтому после перезапуска
 * приложение с чистой совестью выдавало ту же самую подборку. Второй — быстрый:
 * лайк, дизлайк и «больше такого» лежали в базе, но на вес артиста влияли только
 * через историю прослушиваний, то есть не влияли вовсе, пока трек не доиграет.
 *
 * Поправки затухают за считанные дни, а не за полтора месяца, как вкус:
 * «сейчас хочется вот такого» — это про сегодняшний вечер, и через неделю оно не
 * должно определять подборку.
 */

import { getSetting, setSetting } from './db';
import { normalizeArtistKey } from './tasteProfile';

/** Ключ в таблице настроек. Версия в имени: формат ещё будет меняться. */
export const WAVE_MEMORY_KEY = 'wave_memory_v1';

/**
 * Сколько выданных треков помним.
 *
 * Двести — это примерно десять часов музыки: достаточно, чтобы за вечер ничего не
 * повторилось, и мало, чтобы не выесть весь запас кандидатов у человека с
 * небольшой библиотекой. Список кольцевой: старое вытесняется, а не копится.
 */
export const SERVED_HISTORY_LIMIT = 200;

/** Полураспад поправки — трое суток. */
export const BOOST_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

/** Поправка слабее этого не влияет ни на что и выбрасывается. */
export const BOOST_EPSILON = 0.05;

/** Насколько каждое действие сдвигает вес артиста. */
export const FEEDBACK_DELTA = {
  /** «Больше такого» — самая громкая просьба, какая есть в интерфейсе. */
  more_like_this: 5,
  like: 3,
  /** Ранний пропуск: выключили в первые секунды. */
  early_skip: -2.5,
  skip: -1,
  dislike: -4,
  /** Убрали трек из подборки руками. */
  remove: -1.5
} as const;

export type WaveFeedbackKind = keyof typeof FEEDBACK_DELTA;

export interface ArtistBoost {
  /** Величина поправки на момент `at`. */
  weight: number;
  at: number;
}

export interface WaveMemoryState {
  /** Идентификаторы выданных треков, свежие в конце. */
  servedIds: string[];
  /** Поправки по нормализованным именам артистов. */
  artistBoosts: Record<string, ArtistBoost>;
  /**
   * Сеялка перемешивания. Меняется при каждом запуске подборки, поэтому две
   * волны на одном профиле звучат по-разному, оставаясь воспроизводимыми в тестах.
   */
  seed: number;
  updatedAt: number;
}

export function emptyWaveMemory(now: number = Date.now()): WaveMemoryState {
  return { servedIds: [], artistBoosts: {}, seed: 1, updatedAt: now };
}

/** Приводит что угодно из базы к рабочему состоянию. Сбойные данные — не повод падать. */
export function normalizeWaveMemory(raw: unknown, now: number = Date.now()): WaveMemoryState {
  const base = emptyWaveMemory(now);
  if (!raw || typeof raw !== 'object') return base;
  const input = raw as Partial<WaveMemoryState>;

  if (Array.isArray(input.servedIds)) {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of input.servedIds) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    base.servedIds = ids.slice(-SERVED_HISTORY_LIMIT);
  }

  if (input.artistBoosts && typeof input.artistBoosts === 'object') {
    for (const [key, value] of Object.entries(input.artistBoosts)) {
      const normalized = normalizeArtistKey(key);
      if (!normalized) continue;
      const weight = Number((value as ArtistBoost)?.weight);
      const at = Number((value as ArtistBoost)?.at);
      if (!Number.isFinite(weight) || weight === 0) continue;
      base.artistBoosts[normalized] = {
        weight,
        at: Number.isFinite(at) && at > 0 ? at : now
      };
    }
  }

  if (Number.isFinite(input.seed)) base.seed = Math.trunc(input.seed as number);
  if (Number.isFinite(input.updatedAt)) base.updatedAt = input.updatedAt as number;
  return base;
}

/** Добавляет выданные треки в кольцевой список. Чистая функция. */
export function rememberServed(
  state: WaveMemoryState,
  ids: readonly string[],
  now: number = Date.now()
): WaveMemoryState {
  const fresh = ids.filter((id) => typeof id === 'string' && id.length > 0);
  if (fresh.length === 0) return state;

  // Повторно выданный трек переезжает в конец: важен последний раз, а не первый.
  const incoming = new Set(fresh);
  const kept = state.servedIds.filter((id) => !incoming.has(id));
  const merged = [...kept, ...fresh].slice(-SERVED_HISTORY_LIMIT);

  return { ...state, servedIds: merged, updatedAt: now };
}

/** Множество выданного — в таком виде им пользуется ранжирование. */
export function servedIdSet(state: WaveMemoryState): Set<string> {
  return new Set(state.servedIds);
}

/**
 * Учитывает действие человека по конкретному треку.
 *
 * Поправки одного артиста складываются, но упираются в потолок: десять лайков
 * подряд не должны превратить «Поток» в дискографию одного исполнителя.
 */
export function applyArtistFeedback(
  state: WaveMemoryState,
  artist: string | null | undefined,
  kind: WaveFeedbackKind,
  now: number = Date.now()
): WaveMemoryState {
  const key = normalizeArtistKey(artist);
  if (!key) return state;
  const delta = FEEDBACK_DELTA[kind];
  if (!delta) return state;

  const decayed = decayedBoost(state.artistBoosts[key], now);
  const limit = Math.abs(FEEDBACK_DELTA.more_like_this) * 2;
  const next = Math.max(-limit, Math.min(limit, decayed + delta));

  const artistBoosts = { ...state.artistBoosts };
  if (Math.abs(next) < BOOST_EPSILON) delete artistBoosts[key];
  else artistBoosts[key] = { weight: next, at: now };

  return { ...state, artistBoosts, updatedAt: now };
}

/** Величина поправки с поправкой на давность. */
export function decayedBoost(boost: ArtistBoost | undefined, now: number): number {
  if (!boost || !Number.isFinite(boost.weight)) return 0;
  const ageMs = Math.max(0, now - (boost.at || now));
  const factor = Math.pow(0.5, ageMs / BOOST_HALF_LIFE_MS);
  const value = boost.weight * factor;
  return Math.abs(value) < BOOST_EPSILON ? 0 : value;
}

/** Все живые поправки — в том виде, в каком их ждёт `buildTasteProfile`. */
export function activeBoosts(state: WaveMemoryState, now: number = Date.now()): Map<string, number> {
  const result = new Map<string, number>();
  for (const [key, boost] of Object.entries(state.artistBoosts)) {
    const value = decayedBoost(boost, now);
    if (value !== 0) result.set(key, value);
  }
  return result;
}

/** Выбрасывает выдохшиеся поправки, чтобы запись в базе не разрасталась. */
export function pruneWaveMemory(state: WaveMemoryState, now: number = Date.now()): WaveMemoryState {
  const artistBoosts: Record<string, ArtistBoost> = {};
  for (const [key, boost] of Object.entries(state.artistBoosts)) {
    if (decayedBoost(boost, now) !== 0) artistBoosts[key] = boost;
  }
  return { ...state, artistBoosts, updatedAt: now };
}

/** Следующая сеялка. Инкремент, а не случайность: воспроизводимо и достаточно. */
export function nextSeed(state: WaveMemoryState): WaveMemoryState {
  const seed = (state.seed + 1) | 0;
  return { ...state, seed: seed === 0 ? 1 : seed };
}

// --- Обёртка над базой -------------------------------------------------------

let cache: WaveMemoryState | null = null;
let inFlight: Promise<WaveMemoryState> | null = null;

/**
 * Сбрасывает кэш модуля. Нужен тестам: реестр модулей между тестами одного файла
 * не пересоздаётся, и без сброса второй тест видел бы память первого.
 */
export function resetWaveMemoryCache(): void {
  cache = null;
  inFlight = null;
}

/** Читает память из базы. Один поход на всё приложение, дальше из кэша. */
export async function loadWaveMemory(now: number = Date.now()): Promise<WaveMemoryState> {
  if (cache) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const raw = await getSetting<unknown>(WAVE_MEMORY_KEY, null);
      cache = normalizeWaveMemory(raw, now);
    } catch (err) {
      // Недоступная база не должна ломать подбор: без памяти «Поток» хуже, но жив.
      console.error('[WaveMemory] load error:', err);
      cache = emptyWaveMemory(now);
    } finally {
      inFlight = null;
    }
    return cache;
  })();
  return inFlight;
}

/** Кладёт память в кэш и в базу. */
export async function saveWaveMemory(state: WaveMemoryState): Promise<void> {
  cache = state;
  try {
    await setSetting(WAVE_MEMORY_KEY, state);
  } catch (err) {
    console.error('[WaveMemory] save error:', err);
  }
}

/** Меняет память одной чистой функцией и сохраняет результат. */
export async function updateWaveMemory(
  mutate: (state: WaveMemoryState) => WaveMemoryState,
  now: number = Date.now()
): Promise<WaveMemoryState> {
  const current = await loadWaveMemory(now);
  const next = pruneWaveMemory(mutate(current), now);
  await saveWaveMemory(next);
  return next;
}

/** Синхронный снимок для мест, где ждать базу нельзя. `null` — ещё не читали. */
export function peekWaveMemory(): WaveMemoryState | null {
  return cache;
}
