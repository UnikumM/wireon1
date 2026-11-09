import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import '../setup';
import { SearchResults } from '../../src/components/search/SearchResults';
import { MobileSearchView } from '../../src/components/mobile/MobileSearchView';
import { searchAggregator, SearchAggregateResult } from '../../src/services/aggregator';
import { youtubeService } from '../../src/services/youtube';
import { db } from '../../src/services/db';
import { useUIStore } from '../../src/store/useUIStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { installFetchMock, jsonResponse, resetLibraryStore, resetUIStore } from '../helpers/testUtils';
import { createMockTrack } from '../helpers/mockData';

vi.mock('../../src/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/db')>();
  return { ...actual, getSetting: vi.fn(async () => [] as unknown), setSetting: vi.fn(async () => undefined) };
});

const LINE = 'а свет в окне не гаснет';
const TEXT = 'Ночь. Дорога домой,\nА свет в окне не гаснет — ждут меня.';

function aggregate(results = [] as ReturnType<typeof createMockTrack>[]): SearchAggregateResult {
  return { results, sources: { youtube: results.length, soundcloud: 0 } };
}

const inLibrary = createMockTrack({ id: 'yt_lib1', title: 'Дорога домой', artist: 'Кино' });
const online = createMockTrack({ id: 'yt_online1', title: 'Окно', artist: 'Сплин' });

async function seed(lrclib: unknown[] = []) {
  await db.lyrics.clear();
  await db.lyrics.put({
    key: 'кино:::дорога домой',
    fetchedAt: Date.now(),
    result: { synced: false, lines: [], plainLyrics: TEXT, trackName: 'Дорога домой', artistName: 'Кино' }
  });
  useLibraryStore.setState({ favorites: [inLibrary] });
  installFetchMock([{ match: 'lrclib.net/api/search', respond: () => jsonResponse(lrclib) }]);
  vi.spyOn(searchAggregator, 'search').mockResolvedValue(aggregate([createMockTrack({ id: 'yt_plain1' })]));
  vi.spyOn(youtubeService, 'search').mockResolvedValue([online]);
}

describe('поиск по строчке из песни', () => {
  beforeEach(() => {
    resetUIStore();
    resetLibraryStore();
    usePlayerStore.setState({ playTrack: vi.fn(async () => undefined) as any });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ПК: строчка показывает блок с треком и подсвеченной цитатой над выдачей', async () => {
    await seed([{ id: 7, trackName: 'Окно', artistName: 'Сплин', plainLyrics: 'а свет в окне не гаснет никогда' }]);

    await act(async () => {
      render(<SearchResults />);
    });
    act(() => useUIStore.getState().setSearchQuery(LINE));

    await waitFor(() => expect(screen.getByTestId('search-lyric-hits')).toBeTruthy());
    expect(screen.getByText('По строчке из песни')).toBeTruthy();
    expect(screen.getByTestId('search-lyric-hit-yt_lib1')).toBeTruthy();
    expect(screen.getByTestId('search-lyric-hit-yt_online1')).toBeTruthy();
    expect(screen.getByText('Нашли по тексту на lrclib')).toBeTruthy();

    const marks = screen.getByTestId('search-lyric-hits').querySelectorAll('mark.lyric-hit');
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(['А свет в окне не гаснет', 'а свет в окне не гаснет']);
    // Локальная находка — первой, цитата из своего текста, без подписи про LRCLIB.
    const local = screen.getByTestId('search-lyric-hit-yt_lib1');
    expect(local.textContent).toContain('ждут меня.');
    expect(local.textContent).not.toContain('lrclib');

    // Обычная выдача под блоком на месте.
    await waitFor(() => expect(screen.getByTestId('track-hero-yt_plain1')).toBeTruthy());
  });

  it('ПК: обычный запрос блок не показывает и в LRCLIB не ходит', async () => {
    await seed();
    const fetchMock = vi.mocked(globalThis.fetch);

    await act(async () => {
      render(<SearchResults />);
    });
    act(() => useUIStore.getState().setSearchQuery('дорога домой'));

    await waitFor(() => expect(screen.getByTestId('track-hero-yt_plain1')).toBeTruthy());
    expect(screen.queryByTestId('search-lyric-hits')).toBeNull();
    expect(screen.queryByText('По строчке из песни')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ПК: строчка, которой нигде нет, — пустого заголовка нет', async () => {
    await seed();

    await act(async () => {
      render(<SearchResults />);
    });
    act(() => useUIStore.getState().setSearchQuery('этих слов нет ни в одной песне'));

    await waitFor(() => expect(screen.getByTestId('track-hero-yt_plain1')).toBeTruthy());
    expect(screen.queryByTestId('search-lyric-hits')).toBeNull();
  });

  it('телефон: тот же блок с карточкой и цитатой', async () => {
    await seed();

    await act(async () => {
      render(<MobileSearchView />);
    });
    act(() => useUIStore.getState().setSearchQuery(LINE));

    await waitFor(() => expect(screen.getByTestId('mobile-search-lyric-hits')).toBeTruthy());
    expect(screen.getByText('По строчке из песни')).toBeTruthy();
    expect(screen.getByTestId('mobile-search-lyric-yt_lib1')).toBeTruthy();
    expect(screen.getByTestId('mobile-search-lyric-hits').querySelector('mark.lyric-hit')?.textContent).toBe('А свет в окне не гаснет');
    expect(screen.queryByText('Нашли по тексту на lrclib')).toBeNull();
  });

  it('телефон: обычный запрос — без блока', async () => {
    await seed();

    await act(async () => {
      render(<MobileSearchView />);
    });
    act(() => useUIStore.getState().setSearchQuery('дорога домой'));

    await waitFor(() => expect(screen.getByTestId('mobile-search-track-yt_plain1')).toBeTruthy());
    expect(screen.queryByTestId('mobile-search-lyric-hits')).toBeNull();
  });
});
