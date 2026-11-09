import { describe, it, expect } from 'vitest';
import '../setup';
import {
  chooseBetterDuplicate,
  duplicateKey,
  findDuplicatePairs,
  DUPLICATE_DURATION_TOLERANCE_S
} from '../../src/services/trackMatching';
import { UnifiedTrack } from '../../src/types/music';

/**
 * Пары «та же песня с YouTube и с SoundCloud» в избранном (фича 11 плана 4.0).
 *
 * Отбор здесь строже, чем при импорте: пара предлагает удалить запись, и
 * ложное срабатывание стоит дороже пропуска.
 */

const track = (fields: Partial<UnifiedTrack> & Pick<UnifiedTrack, 'id' | 'source'>): UnifiedTrack => ({
  originalId: fields.id,
  title: 'Song',
  artist: 'Artist',
  duration: 200,
  artworkUrl: '',
  ...fields
});

describe('дубли из разных источников', () => {
  it('находит пару при совпадении названия и исполнителя и длительности в пределах ±3 с', () => {
    const yt = track({ id: 'yt_1', source: 'youtube', title: 'Creep (Official Video)', artist: 'Radiohead - Topic', duration: 238 });
    const sc = track({ id: 'sc_1', source: 'soundcloud', title: 'Creep', artist: 'Radiohead', duration: 238 + DUPLICATE_DURATION_TOLERANCE_S });
    const pairs = findDuplicatePairs([yt, sc]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].youtube.id).toBe('yt_1');
    expect(pairs[0].soundcloud.id).toBe('sc_1');
  });

  it('не находит пару при разных названиях или при разбросе длительности больше допуска', () => {
    const yt = track({ id: 'yt_1', source: 'youtube', title: 'Creep', duration: 238 });
    const other = track({ id: 'sc_2', source: 'soundcloud', title: 'Karma Police', duration: 238 });
    const tooLong = track({ id: 'sc_3', source: 'soundcloud', title: 'Creep', duration: 238 + DUPLICATE_DURATION_TOLERANCE_S + 1 });
    expect(findDuplicatePairs([yt, other, tooLong])).toEqual([]);
  });

  it('две записи одной площадки парой не считаются, без длительности — тоже', () => {
    const a = track({ id: 'yt_1', source: 'youtube' });
    const b = track({ id: 'yt_2', source: 'youtube' });
    const sc = track({ id: 'sc_1', source: 'soundcloud', duration: 0 });
    expect(findDuplicatePairs([a, b, sc])).toEqual([]);
  });

  it('каждая запись попадает только в одну пару — берётся ближайшая по длительности', () => {
    const yt = track({ id: 'yt_1', source: 'youtube', duration: 200 });
    const far = track({ id: 'sc_far', source: 'soundcloud', duration: 203 });
    const near = track({ id: 'sc_near', source: 'soundcloud', duration: 200 });
    const pairs = findDuplicatePairs([yt, far, near]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].soundcloud.id).toBe('sc_near');
  });

  it('ключ не различает ё/е, регистр и хвосты канала', () => {
    expect(duplicateKey({ title: 'Ёлка — Прованс', artist: 'ЁЛКА' })).toBe(
      duplicateKey({ title: 'елка — прованс', artist: 'Елка - Topic' })
    );
    expect(duplicateKey({ title: '   ', artist: 'x' })).toBeNull();
  });

  it('лучший — без пометки качества, при равенстве YouTube', () => {
    const pair = {
      youtube: track({ id: 'yt_1', source: 'youtube' }),
      soundcloud: track({ id: 'sc_1', source: 'soundcloud' })
    };
    const none = () => null;
    expect(chooseBetterDuplicate(pair, none).keep.id).toBe('yt_1');

    const ytLow = (id: string) => (id === 'yt_1' ? ('low' as const) : null);
    expect(chooseBetterDuplicate(pair, ytLow).keep.id).toBe('sc_1');
    expect(chooseBetterDuplicate(pair, ytLow).drop.id).toBe('yt_1');

    const scPreview = (id: string) => (id === 'sc_1' ? ('preview' as const) : null);
    expect(chooseBetterDuplicate(pair, scPreview).keep.id).toBe('yt_1');

    const bothBad = (id: string) => (id === 'sc_1' ? ('preview' as const) : ('low' as const));
    expect(chooseBetterDuplicate(pair, bothBad).keep.id).toBe('yt_1');
  });
});
