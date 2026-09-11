/**
 * Перемешивание с добавками — то, что у Spotify называется Smart Shuffle.
 *
 * Обычная перемешка переставляет то же самое: после сотого прослушивания
 * плейлист остаётся тем же плейлистом, просто в другом порядке. Здесь в него
 * подмешивается музыка, которой в нём нет, — подобранная по его же составу.
 *
 * Правило одно и держится намеренно жёстко: **добавка не должна вытеснять
 * собранное руками**. Плейлист человек составил сам, и если предложений станет
 * больше одного на четыре своих трека, он перестанет быть его плейлистом.
 * Отсюда и место вставки, и потолок, и то, что предложения помечаются: их
 * должно быть видно и легко отличить.
 */

import { UnifiedTrack } from '../types/music';

/** На сколько своих треков приходится одно предложение. */
export const SUGGESTION_EVERY = 4;

/** Больше этого не добавляется, даже если плейлист огромен. */
export const MAX_SUGGESTIONS = 20;

export interface SmartShuffleResult {
  /** Готовая очередь: свои треки вперемешку, между ними предложения. */
  tracks: UnifiedTrack[];
  /** Что из них добавлено нами. Нужно, чтобы пометить их в очереди. */
  suggestedIds: Set<string>;
}

/**
 * Случайная перестановка. Своя, а не `sort(() => Math.random() - 0.5)`:
 * сравнение со случайным знаком даёт неравномерный порядок, и первые элементы
 * остаются первыми заметно чаще остальных.
 */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Смешивает свои треки с предложениями.
 *
 * Предложения встают **между** своими, а не в конец: в конец их никто не
 * дослушает, и вся затея сведётся к обычной перемешке. Первым идёт свой трек —
 * список должен начинаться с того, что человек выбирал сам.
 */
export function mixSuggestions(
  own: readonly UnifiedTrack[],
  suggestions: readonly UnifiedTrack[],
  random: () => number = Math.random
): SmartShuffleResult {
  const base = shuffled(own, random);
  const ownIds = new Set(base.map((track) => track.id));

  const fresh = suggestions
    .filter((track) => track?.id && !ownIds.has(track.id))
    .slice(0, Math.min(MAX_SUGGESTIONS, Math.max(0, Math.ceil(base.length / SUGGESTION_EVERY))));

  if (fresh.length === 0) return { tracks: base, suggestedIds: new Set() };

  const tracks: UnifiedTrack[] = [];
  const suggestedIds = new Set<string>();
  let next = 0;

  base.forEach((track, index) => {
    tracks.push(track);
    // После каждого четвёртого своего — одно предложение, пока они есть.
    if ((index + 1) % SUGGESTION_EVERY === 0 && next < fresh.length) {
      tracks.push(fresh[next]);
      suggestedIds.add(fresh[next].id);
      next += 1;
    }
  });

  // Остаток — в конец: короткий плейлист иначе не получит ни одной добавки.
  for (; next < fresh.length; next += 1) {
    tracks.push(fresh[next]);
    suggestedIds.add(fresh[next].id);
  }

  return { tracks, suggestedIds };
}

/**
 * С каких треков просить подбор.
 *
 * Не со всех: подбор ходит в сеть на каждое семя. Берутся несколько случайных —
 * так две перемешки одного плейлиста дадут разные добавки, а не один и тот же
 * список от первого трека.
 */
export function pickSeeds(
  tracks: readonly UnifiedTrack[],
  count: number = 3,
  random: () => number = Math.random
): UnifiedTrack[] {
  return shuffled(tracks, random).slice(0, Math.max(1, count));
}
