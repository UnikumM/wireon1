/**
 * Подготовка ссылки по наведению (`src/hooks/useIntentPrefetch.ts`).
 *
 * Ссылка YouTube готовится секунды (замерено 3,2–3,8 с), а звук потом идёт
 * потоком — ждёт человек именно ссылку. Наведение курсора почти всегда
 * предшествует щелчку, и разбор, начатый в этот момент, к щелчку почти готов.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { render, fireEvent } from '@testing-library/react';
import '../setup';
import {
  INTENT_BUDGET,
  INTENT_DWELL_MS,
  INTENT_WINDOW_MS,
  resetIntentPrefetchForTests,
  useIntentPrefetch,
  warmTrack
} from '../../src/hooks/useIntentPrefetch';
import { streamResolver } from '../../src/services/streamResolver';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import type { UnifiedTrack } from '../../src/types/music';

const track = (id: string): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title: `Трек ${id}`,
  artist: 'Исполнитель',
  duration: 200,
  artworkUrl: ''
});

function Row({ item }: { item: UnifiedTrack }) {
  const { onIntentStart, onIntentEnd } = useIntentPrefetch(item);
  return (
    <div data-testid="row" onMouseEnter={onIntentStart} onMouseLeave={onIntentEnd}>
      {item.title}
    </div>
  );
}

describe('подготовка ссылки по наведению', () => {
  let prefetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetIntentPrefetchForTests();
    usePlayerStore.setState({ currentTrack: null });
    prefetch = vi.spyOn(streamResolver, 'prefetch').mockImplementation(() => {});
  });

  afterEach(() => {
    prefetch.mockRestore();
    vi.useRealTimers();
  });

  it('курсор задержался — ссылка начинает готовиться', () => {
    const { getByTestId } = render(<Row item={track('a1')} />);
    fireEvent.mouseEnter(getByTestId('row'));
    vi.advanceTimersByTime(INTENT_DWELL_MS + 10);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it('курсор пробежал мимо — ничего не запускается', () => {
    const { getByTestId } = render(<Row item={track('a2')} />);
    fireEvent.mouseEnter(getByTestId('row'));
    vi.advanceTimersByTime(INTENT_DWELL_MS / 2);
    fireEvent.mouseLeave(getByTestId('row'));
    vi.advanceTimersByTime(INTENT_DWELL_MS);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('не больше бюджета за окно, а потом снова можно', () => {
    const start = Date.now();
    for (let i = 0; i < INTENT_BUDGET + 3; i++) warmTrack(track(`b${i}`), start);
    expect(prefetch).toHaveBeenCalledTimes(INTENT_BUDGET);

    expect(warmTrack(track('late'), start + INTENT_WINDOW_MS + 1)).toBe(true);
  });

  it('играющий и уже подготовленный трек второй раз не готовится', () => {
    const playing = track('c1');
    usePlayerStore.setState({ currentTrack: playing });
    expect(warmTrack(playing)).toBe(false);

    const other = track('c2');
    expect(warmTrack(other)).toBe(true);
    expect(warmTrack(other)).toBe(false);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });
});
