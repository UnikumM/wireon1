/**
 * Перемешивание с добавками (`src/services/smartShuffle.ts`).
 *
 * Главное, что здесь охраняется: добавки не должны вытеснять собранное руками.
 * Плейлист человек составил сам, и если подобранного станет больше одного на
 * четыре своих трека, список перестанет быть его списком.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_SUGGESTIONS,
  SUGGESTION_EVERY,
  mixSuggestions,
  pickSeeds,
  shuffled
} from '../../src/services/smartShuffle';
import { UnifiedTrack } from '../../src/types/music';

function track(id: string): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id,
    title: `Track ${id}`,
    artist: 'Someone',
    duration: 200,
    artworkUrl: ''
  };
}

const own = Array.from({ length: 12 }, (_, i) => track(`own_${i}`));
const fresh = Array.from({ length: 30 }, (_, i) => track(`new_${i}`));

/** Предсказуемая «случайность»: перемешка проверяется, а не угадывается. */
function seeded(): () => number {
  let value = 1;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

describe('перемешивание', () => {
  it('сохраняет состав, а не теряет и не дублирует', () => {
    const result = shuffled(own, seeded());

    expect(result).toHaveLength(own.length);
    expect(new Set(result.map((t) => t.id)).size).toBe(own.length);
  });
});

describe('смешивание с добавками', () => {
  it('первым идёт свой трек, добавки стоят между своими', () => {
    const { tracks, suggestedIds } = mixSuggestions(own, fresh, seeded());

    // Список обязан начинаться с того, что человек выбирал сам.
    expect(suggestedIds.has(tracks[0].id)).toBe(false);
    // Одна добавка на четыре своих — не больше.
    expect(suggestedIds.size).toBe(Math.ceil(own.length / SUGGESTION_EVERY));
    expect(tracks).toHaveLength(own.length + suggestedIds.size);
  });

  it('добавки не в конце, иначе их никто не дослушает', () => {
    const { tracks, suggestedIds } = mixSuggestions(own, fresh, seeded());
    const firstSuggestionAt = tracks.findIndex((t) => suggestedIds.has(t.id));

    expect(firstSuggestionAt).toBe(SUGGESTION_EVERY);
    expect(firstSuggestionAt).toBeLessThan(tracks.length - 1);
  });

  it('то, что уже есть в плейлисте, добавкой не становится', () => {
    // Радио по треку из плейлиста законно приносит соседей по тому же плейлисту.
    const { tracks, suggestedIds } = mixSuggestions(own, [...own, ...fresh], seeded());

    expect(suggestedIds.size).toBeGreaterThan(0);
    for (const id of suggestedIds) expect(id.startsWith('new_')).toBe(true);
    expect(new Set(tracks.map((t) => t.id)).size).toBe(tracks.length);
  });

  it('без подбора остаётся обычная перемешка', () => {
    // Отказ сети не должен превращать нажатие в «ничего не произошло».
    const { tracks, suggestedIds } = mixSuggestions(own, [], seeded());

    expect(suggestedIds.size).toBe(0);
    expect(tracks).toHaveLength(own.length);
  });

  it('короткий плейлист получает добавку, а не остаётся без неё', () => {
    const tiny = own.slice(0, 2);
    const { tracks, suggestedIds } = mixSuggestions(tiny, fresh, seeded());

    expect(suggestedIds.size).toBe(1);
    expect(tracks).toHaveLength(3);
  });

  it('у огромного плейлиста добавок не больше потолка', () => {
    const huge = Array.from({ length: 500 }, (_, i) => track(`big_${i}`));
    const { suggestedIds } = mixSuggestions(huge, fresh, seeded());

    expect(suggestedIds.size).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  });
});

describe('выбор семян', () => {
  it('берётся несколько треков, а не всегда первый', () => {
    // Иначе вторая перемешка того же списка дала бы те же самые добавки.
    const seeds = pickSeeds(own, 3, seeded());

    expect(seeds).toHaveLength(3);
    expect(new Set(seeds.map((t) => t.id)).size).toBe(3);
  });

  it('из одного трека семя всё равно есть', () => {
    expect(pickSeeds([track('solo')], 3, seeded())).toHaveLength(1);
  });
});
