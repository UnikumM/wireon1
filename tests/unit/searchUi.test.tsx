import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { TrackCard } from '../../src/components/search/TrackCard';
import { SearchResults } from '../../src/components/search/SearchResults';
import * as dbService from '../../src/services/db';
import { searchAggregator, SearchAggregateResult } from '../../src/services/aggregator';
import { youtubeService, ALL_BACKENDS_UNAVAILABLE_MESSAGE } from '../../src/services/youtube';
import { offlineStorage } from '../../src/services/offlineStorage';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { UnifiedTrack } from '../../src/types/music';

// Recent-search persistence must not touch IndexedDB from a component test.
vi.mock('../../src/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/db')>();
  return {
    ...actual,
    getSetting: vi.fn(async () => [] as unknown),
    setSetting: vi.fn(async () => undefined)
  };
});

function makeTrack(id: string, overrides: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id.replace(/^\w+_/, ''),
    title: `Track ${id}`,
    artist: `Artist ${id}`,
    duration: 215,
    artworkUrl: `https://example.test/${id}.jpg`,
    sourceUrl: `https://example.test/watch/${id}`,
    ...overrides
  };
}

function aggregate(
  results: UnifiedTrack[],
  errors?: Record<string, string>
): SearchAggregateResult {
  return {
    results,
    sources: {
      youtube: results.filter((t) => t.source === 'youtube').length,
      soundcloud: results.filter((t) => t.source === 'soundcloud').length
    },
    ...(errors ? { errors } : {})
  };
}

const realPlayTrack = usePlayerStore.getState().playTrack;

/** SearchResults loads recent searches on mount; flush that inside act(). */
async function renderSearchResults(): Promise<void> {
  await act(async () => {
    render(<SearchResults />);
  });
}

describe('search UI', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      playTrack: realPlayTrack,
      currentTrack: null,
      isPlaying: false,
      isShuffled: false,
      userQueue: [],
      sourceQueue: [],
      currentIndex: -1
    });
    useLibraryStore.setState({ favorites: [], playlists: [], history: [], error: null });
    useUIStore.setState({ searchQuery: '', searchFilter: 'all', toastMessage: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ==========================================
  // C1 — play resolution order
  // ==========================================
  describe('TrackCard play resolution', () => {
    it('prefers contextQueue over onPlay so the whole result set becomes the queue', () => {
      const playTrack = vi.fn(async () => undefined);
      usePlayerStore.setState({ playTrack });

      const queue = [makeTrack('yt_a'), makeTrack('yt_b'), makeTrack('yt_c')];
      const onPlay = vi.fn();

      render(<TrackCard track={queue[1]} index={1} layout="row" contextQueue={queue} onPlay={onPlay} />);
      fireEvent.click(screen.getByTestId('track-row-yt_b'));

      expect(playTrack).toHaveBeenCalledTimes(1);
      expect(playTrack).toHaveBeenCalledWith(queue[1], queue, 1);
      expect(onPlay).not.toHaveBeenCalled();
    });

    it('falls back to onPlay when there is no contextQueue', () => {
      const playTrack = vi.fn(async () => undefined);
      usePlayerStore.setState({ playTrack });

      const track = makeTrack('yt_solo');
      const onPlay = vi.fn();

      render(<TrackCard track={track} index={0} layout="row" onPlay={onPlay} />);
      fireEvent.click(screen.getByTestId('track-row-yt_solo'));

      expect(onPlay).toHaveBeenCalledTimes(1);
      expect(onPlay).toHaveBeenCalledWith(track);
      expect(playTrack).not.toHaveBeenCalled();
    });

    it('falls back to a bare playTrack when neither is supplied', () => {
      const playTrack = vi.fn(async () => undefined);
      usePlayerStore.setState({ playTrack });

      const track = makeTrack('yt_bare');
      render(<TrackCard track={track} index={0} layout="row" />);
      fireEvent.click(screen.getByTestId('track-row-yt_bare'));

      expect(playTrack).toHaveBeenCalledTimes(1);
      expect(playTrack).toHaveBeenCalledWith(track);
    });

    it('activates the row from the keyboard without swallowing inner buttons', () => {
      const playTrack = vi.fn(async () => undefined);
      usePlayerStore.setState({ playTrack });

      const queue = [makeTrack('yt_k1')];
      render(<TrackCard track={queue[0]} index={0} layout="row" contextQueue={queue} />);

      const row = screen.getByTestId('track-row-yt_k1');
      fireEvent.keyDown(row, { key: 'Enter' });
      expect(playTrack).toHaveBeenCalledWith(queue[0], queue, 0);

      // A keydown that originated in a child button must not re-trigger the row.
      playTrack.mockClear();
      fireEvent.keyDown(screen.getByTestId('track-queue-btn-yt_k1'), { key: 'Enter' });
      expect(playTrack).not.toHaveBeenCalled();
    });

    it('подсказка на «плюсе» обещает ровно то, что кнопка делает', () => {
      // Кнопка вызывает addToQueueEnd, а подсказка обещала «Поставить следующим»
      // — отдельное действие, которое живёт в контекстном меню. Человек, которому
      // нужен следующий трек, нажимал сюда и ждал всю очередь.
      const queue = [makeTrack('yt_tip'), makeTrack('yt_second')];
      usePlayerStore.setState({ userQueue: [] });

      render(<TrackCard track={queue[0]} index={0} layout="row" contextQueue={queue} />);
      const plus = screen.getByTestId('track-queue-btn-yt_tip');

      expect(plus).toHaveAttribute('title', 'В конец очереди');
      fireEvent.click(plus);
      expect(usePlayerStore.getState().userQueue.map((t) => t.id)).toEqual(['yt_tip']);
    });

    it('длинное название можно прочитать целиком — оно обрезано, но есть подсказка', () => {
      const long = makeTrack('yt_long', {
        title: 'Neon Horizon (Extended Club Mix) [Official Audio] — очень длинное название'
      });

      render(<TrackCard track={long} index={0} layout="row" />);

      expect(screen.getByTitle(long.title)).toBeInTheDocument();
    });

    it('в русском интерфейсе плашка офлайна подписана по-русски', async () => {
      const offline = makeTrack('yt_off');
      vi.spyOn(offlineStorage, 'isDownloaded').mockResolvedValue(true);

      render(<TrackCard track={offline} index={0} layout="hero" />);

      await waitFor(() => {
        expect(screen.getByTestId(`hero-offline-badge-${offline.id}`)).toHaveTextContent('Офлайн');
      });
    });
  });

  // ==========================================
  // Backend outage vs. genuinely empty results
  // ==========================================
  describe('SearchResults source errors', () => {
    it('shows a YouTube outage notice while still listing SoundCloud results', async () => {
      const soundcloud = makeTrack('sc_1', { source: 'soundcloud' });
      vi.spyOn(searchAggregator, 'search').mockResolvedValue(
        aggregate([soundcloud], { youtube: ALL_BACKENDS_UNAVAILABLE_MESSAGE })
      );
      vi.spyOn(searchAggregator, 'getSuggestions').mockResolvedValue([]);

      act(() => {
        useUIStore.setState({ searchQuery: 'neon nights' });
      });
      await renderSearchResults();

      await waitFor(() => {
        expect(screen.getByTestId('search-source-error-youtube')).toBeTruthy();
      });
      expect(screen.getByText(ALL_BACKENDS_UNAVAILABLE_MESSAGE)).toBeTruthy();

      // The surviving source still renders (top match => hero layout).
      expect(screen.getByTestId('track-hero-sc_1')).toBeTruthy();

      // An outage is not "no matches".
      expect(screen.queryByTestId('search-no-results')).toBeNull();
      expect(screen.queryByTestId('search-error')).toBeNull();
    });

    it('clears blocklisted instances and the result cache before retrying', async () => {
      vi.spyOn(searchAggregator, 'search').mockResolvedValue(
        aggregate([], { youtube: ALL_BACKENDS_UNAVAILABLE_MESSAGE })
      );
      vi.spyOn(searchAggregator, 'getSuggestions').mockResolvedValue([]);
      const resetHealth = vi.spyOn(youtubeService, 'resetInstanceHealth').mockImplementation(() => undefined);
      const clearCache = vi.spyOn(searchAggregator, 'clearCache').mockImplementation(() => undefined);

      act(() => {
        useUIStore.setState({ searchQuery: 'neon nights' });
      });
      await renderSearchResults();

      const retry = await waitFor(() => screen.getByTestId('search-retry-youtube'));
      fireEvent.click(retry);

      expect(resetHealth).toHaveBeenCalledTimes(1);
      expect(clearCache).toHaveBeenCalledTimes(1);

      // Let the retried search settle so it cannot leak into the next test.
      await waitFor(() => {
        expect(searchAggregator.search).toHaveBeenCalledTimes(2);
      });
      await act(async () => {
        await Promise.resolve();
      });
    });
  });

  // ==========================================
  // M1 — stale response race
  // ==========================================
  describe('SearchResults stale response guard', () => {
    it('keeps the newest results when an older search resolves last', async () => {
      const stale = makeTrack('yt_stale');
      const fresh = makeTrack('yt_fresh');

      let releaseStale: (() => void) | null = null;
      const stalePending = new Promise<SearchAggregateResult>((resolve) => {
        releaseStale = () => resolve(aggregate([stale]));
      });

      vi.spyOn(searchAggregator, 'search')
        .mockImplementationOnce(() => stalePending)
        .mockImplementation(() => Promise.resolve(aggregate([fresh])));
      vi.spyOn(searchAggregator, 'getSuggestions').mockResolvedValue([]);

      act(() => {
        useUIStore.setState({ searchQuery: 'first query' });
      });
      await renderSearchResults();

      // Supersede the in-flight search before it ever resolves.
      act(() => {
        useUIStore.setState({ searchQuery: 'second query' });
      });

      await waitFor(() => {
        expect(screen.getByTestId('track-hero-yt_fresh')).toBeTruthy();
      });

      // Now let the older request land.
      await act(async () => {
        releaseStale?.();
        await stalePending;
      });

      expect(screen.getByTestId('track-hero-yt_fresh')).toBeTruthy();
      expect(screen.queryByTestId('track-hero-yt_stale')).toBeNull();
      expect(screen.queryByTestId('track-row-yt_stale')).toBeNull();
    });
  });

  // ==========================================
  // One search per gesture
  // ==========================================
  describe('SearchResults search path', () => {
    // Раньше этот тест жал на плитку жанра. Плиток нет: они дублировали чипы
    // подсказок под полем ввода. Класс регрессий, который тест охраняет —
    // «один жест поднял два запроса», — от плиток не зависел, поэтому жест
    // просто перенесён на чип недавнего запроса: он тоже подставляет строку
    // в поиск через тот же setSearchQuery.
    it('fires exactly one search when a recent query is clicked', async () => {
      vi.spyOn(dbService, 'getSetting').mockResolvedValue(['Synthwave']);
      const searchSpy = vi
        .spyOn(searchAggregator, 'search')
        .mockResolvedValue(aggregate([makeTrack('yt_cat')]));
      vi.spyOn(searchAggregator, 'getSuggestions').mockResolvedValue([]);

      await renderSearchResults();
      expect(searchSpy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('recent-search-Synthwave'));

      await waitFor(() => {
        expect(screen.getByTestId('track-hero-yt_cat')).toBeTruthy();
      });
      expect(searchSpy).toHaveBeenCalledTimes(1);
      expect(searchSpy).toHaveBeenCalledWith('Synthwave', expect.objectContaining({ source: 'all' }));
    });
  });
});
