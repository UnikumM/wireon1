import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import '../setup';
import { SearchResults } from '../../src/components/search/SearchResults';
import { MobileSearchView } from '../../src/components/mobile/MobileSearchView';
import { searchAggregator, SearchAggregateResult } from '../../src/services/aggregator';
import { youtubeService } from '../../src/services/youtube';
import { soundCloudService } from '../../src/services/soundcloud';
import * as dbService from '../../src/services/db';
import { useUIStore } from '../../src/store/useUIStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { resetUIStore } from '../helpers/testUtils';
import type { UnifiedTrack } from '../../src/types/music';

vi.mock('../../src/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/db')>();
  return { ...actual, getSetting: vi.fn(async () => [] as unknown), setSetting: vi.fn(async () => undefined) };
});

const ID = 'dQw4w9WgXcQ';
const LINK = `https://www.youtube.com/watch?v=${ID}&t=5s`;

function makeTrack(id: string, overrides: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id.replace(/^\w+_/, ''),
    title: `Track ${id}`,
    artist: `Artist ${id}`,
    duration: 215,
    artworkUrl: '',
    ...overrides
  };
}

function aggregate(results: UnifiedTrack[]): SearchAggregateResult {
  return {
    results,
    sources: {
      youtube: results.filter((t) => t.source === 'youtube').length,
      soundcloud: results.filter((t) => t.source === 'soundcloud').length
    }
  };
}

const linked = makeTrack(`yt_${ID}`, { title: 'Never Gonna Give You Up', artist: 'Rick Astley' });

describe('ссылка на трек в поиске (ПК)', () => {
  beforeEach(() => {
    resetUIStore();
    usePlayerStore.setState({ playTrack: vi.fn(async () => undefined) as any });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('ссылка показывает трек первым, а под ним — поиск по его названию', async () => {
    const byId = vi.spyOn(youtubeService, 'getTrackById').mockResolvedValue(linked);
    const search = vi
      .spyOn(searchAggregator, 'search')
      .mockResolvedValue(aggregate([makeTrack('yt_other000001'), linked, makeTrack('sc_42', { source: 'soundcloud' })]));
    const setSetting = vi.spyOn(dbService, 'setSetting');

    await act(async () => {
      render(<SearchResults />);
    });
    act(() => useUIStore.getState().setSearchQuery(LINK));

    await waitFor(() => expect(screen.getByTestId('search-link-track')).toBeTruthy());
    expect(byId).toHaveBeenCalledWith(ID);
    expect(screen.getByTestId(`track-hero-yt_${ID}`)).toBeTruthy();
    expect(screen.getByLabelText(`Слушать: ${linked.title}`)).toBeTruthy();

    await waitFor(() => expect(screen.getByTestId('search-result-list')).toBeTruthy());
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('Rick Astley Never Gonna Give You Up', expect.objectContaining({ source: 'all' }));
    expect(screen.getByText('Другие версии')).toBeTruthy();
    // Копия трека по ссылке в «других версиях» не повторяется.
    expect(screen.getByTestId('search-result-list').querySelectorAll('[role="button"]').length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId(`track-hero-yt_${ID}`)).toHaveLength(1);
    expect(screen.queryByTestId('search-link-miss')).toBeNull();
    // Адрес не попадает в недавние запросы.
    expect(setSetting).not.toHaveBeenCalledWith('searchRecentQueries', expect.arrayContaining([LINK]));
    expect(useUIStore.getState().activeView).not.toBe('collection');
  });

  it('трек внутри плейлиста открывается треком, а не подборкой', async () => {
    const byId = vi.spyOn(youtubeService, 'getTrackById').mockResolvedValue(linked);
    vi.spyOn(searchAggregator, 'search').mockResolvedValue(aggregate([]));

    await act(async () => {
      render(<SearchResults />);
    });
    act(() => useUIStore.getState().setSearchQuery(`https://www.youtube.com/watch?v=${ID}&list=PLabcdefghijKLMN`));

    await waitFor(() => expect(screen.getByTestId('search-link-track')).toBeTruthy());
    expect(byId).toHaveBeenCalledWith(ID);
    expect(useUIStore.getState().activeView).not.toBe('collection');
    // Других версий нет — пустого состояния «ничего не нашлось» тоже нет.
    await waitFor(() => expect(screen.queryByTestId('search-skeletons')).toBeNull());
    expect(screen.queryByTestId('search-no-results')).toBeNull();
  });

  it('по ссылке ничего не нашли — обычный поиск по тексту и строка об этом', async () => {
    vi.spyOn(soundCloudService, 'resolveTrackUrl').mockResolvedValue(null);
    const search = vi.spyOn(searchAggregator, 'search').mockResolvedValue(aggregate([makeTrack('yt_fallback001')]));
    const url = 'https://soundcloud.com/nobody/nothing';

    await act(async () => {
      render(<SearchResults />);
    });
    act(() => useUIStore.getState().setSearchQuery(url));

    await waitFor(() => expect(screen.getByTestId('search-link-miss')).toBeTruthy());
    expect(screen.getByTestId('search-link-miss').textContent).toContain('По ссылке ничего не нашли');
    expect(search).toHaveBeenCalledWith(url, expect.anything());
    expect(screen.getByTestId('track-hero-yt_fallback001')).toBeTruthy();
    expect(screen.queryByTestId('search-link-track')).toBeNull();
  });

  it('пока трек по ссылке едет — скелетон', async () => {
    let release!: (track: UnifiedTrack | null) => void;
    vi.spyOn(youtubeService, 'getTrackById').mockReturnValue(new Promise((resolve) => (release = resolve)));
    vi.spyOn(searchAggregator, 'search').mockResolvedValue(aggregate([]));

    await act(async () => {
      render(<SearchResults />);
    });
    act(() => useUIStore.getState().setSearchQuery(LINK));

    expect(screen.getByTestId('search-skeletons')).toBeTruthy();
    await act(async () => release(linked));
    await waitFor(() => expect(screen.getByTestId('search-link-track')).toBeTruthy());
  });
});

describe('ссылка на трек в поиске (телефон)', () => {
  beforeEach(() => {
    resetUIStore();
    usePlayerStore.setState({ playTrack: vi.fn(async () => undefined) as any, currentTrack: null });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('карточка трека с кнопкой «Слушать», под ней другие версии', async () => {
    vi.spyOn(youtubeService, 'getTrackById').mockResolvedValue(linked);
    const search = vi
      .spyOn(searchAggregator, 'search')
      .mockResolvedValue(aggregate([linked, makeTrack('yt_other000001')]));
    useUIStore.getState().setSearchQuery(LINK);

    await act(async () => {
      render(<MobileSearchView />);
    });

    await waitFor(() => expect(screen.getByTestId('mobile-search-link-track')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('mobile-search-track-yt_other000001')).toBeTruthy());
    expect(search).toHaveBeenCalledWith('Rick Astley Never Gonna Give You Up', expect.anything());
    expect(screen.queryByTestId(`mobile-search-track-yt_${ID}`)).toBeNull();
    expect(screen.getByText('Другие версии')).toBeTruthy();

    fireEvent.click(screen.getByTestId('mobile-search-link-play'));
    const playTrack = usePlayerStore.getState().playTrack as unknown as ReturnType<typeof vi.fn>;
    expect(playTrack).toHaveBeenCalledWith(linked, [linked, expect.objectContaining({ id: 'yt_other000001' })], 0);
  });

  it('не нашли — скелетон сменяется обычной выдачей и строкой', async () => {
    let release!: (track: UnifiedTrack | null) => void;
    vi.spyOn(soundCloudService, 'resolveTrackUrl').mockReturnValue(new Promise((resolve) => (release = resolve)));
    vi.spyOn(searchAggregator, 'search').mockResolvedValue(aggregate([makeTrack('yt_fallback001')]));
    const url = 'https://on.soundcloud.com/abc12';
    useUIStore.getState().setSearchQuery(url);

    await act(async () => {
      render(<MobileSearchView />);
    });
    expect(screen.getByTestId('mobile-search-link-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('mobile-search-loading')).toBeNull();

    await act(async () => release(null));
    await waitFor(() => expect(screen.getByTestId('mobile-search-link-miss')).toBeTruthy());
    expect(screen.getByTestId('mobile-search-track-yt_fallback001')).toBeTruthy();
    expect(screen.queryByTestId('mobile-search-link-track')).toBeNull();
  });
});
