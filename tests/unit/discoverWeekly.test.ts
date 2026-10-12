import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  getDiscoverWeekly,
  weekKeyOf,
  resetDiscoverWeeklyForTests,
  DISCOVER_WEEKLY_KEY
} from '../../src/services/discoverWeekly';
import { recommendationEngine } from '../../src/services/recommendationEngine';
import * as dbService from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

const t = (id: string, artist = `Artist ${id}`): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title: `Title ${id}`,
  artist,
  duration: 200,
  artworkUrl: ''
});

describe('3.0: Открытия недели', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetDiscoverWeeklyForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it('неделя начинается с понедельника', () => {
    expect(weekKeyOf(new Date(2026, 9, 12, 10).getTime())).toBe('2026-10-12'); // понедельник
    expect(weekKeyOf(new Date(2026, 9, 18, 23).getTime())).toBe('2026-10-12'); // воскресенье
    expect(weekKeyOf(new Date(2026, 9, 19, 0, 5).getTime())).toBe('2026-10-19');
  });

  it('без истории не собирается и не ходит в сеть', async () => {
    const spy = vi.spyOn(recommendationEngine, 'getRecommendationsForWave');
    expect(await getDiscoverWeekly()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('собирает новое, отсеивает знакомое и держит список всю неделю', async () => {
    const known = Array.from({ length: 6 }, (_, i) => t(`known${i}`));
    for (const track of known) await dbService.db.history.put({ id: track.id, track, playCount: 2, playedAt: Date.now() });
    const fresh = Array.from({ length: 12 }, (_, i) => t(`new${i}`));
    // Знакомый трек с другим id (та же песня с другого источника) тоже отсеивается.
    const sameSong = { ...known[0], id: 'sc_dup', source: 'soundcloud' as const };
    const spy = vi.spyOn(recommendationEngine, 'getRecommendationsForWave').mockResolvedValue([sameSong, ...fresh, known[1]]);

    const now = new Date(2026, 9, 13, 12).getTime();
    const weekly = await getDiscoverWeekly(now);
    expect(weekly?.weekKey).toBe('2026-10-12');
    expect(weekly?.tracks.map((x) => x.id)).toEqual(fresh.map((x) => x.id));
    expect(spy.mock.calls[0][0]).toMatchObject({ seedKind: 'library', novelty: 0.95 });

    // В четверг — тот же список, без сети.
    const again = await getDiscoverWeekly(new Date(2026, 9, 15, 9).getTime());
    expect(again?.tracks).toEqual(weekly?.tracks);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await dbService.getSetting<{ weekKey: string }>(DISCOVER_WEEKLY_KEY, { weekKey: '' })).weekKey).toBe('2026-10-12');
  });

  it('скудный ответ не сохраняется как «открытия»', async () => {
    for (let i = 0; i < 6; i++) await dbService.db.history.put({ id: `k${i}`, track: t(`k${i}`), playCount: 1, playedAt: Date.now() });
    vi.spyOn(recommendationEngine, 'getRecommendationsForWave').mockResolvedValue([t('a'), t('b')]);
    expect(await getDiscoverWeekly()).toBeNull();
    expect(await dbService.getSetting(DISCOVER_WEEKLY_KEY, null)).toBeNull();
  });
});
