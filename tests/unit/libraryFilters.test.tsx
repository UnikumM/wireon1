import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup';
import { LibraryView } from '../../src/components/library/LibraryView';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { useSmartPlaylistStore } from '../../src/store/useSmartPlaylistStore';
import { db, HistoryRecord } from '../../src/services/db';
import * as dbService from '../../src/services/db';
import { offlineStorage } from '../../src/services/offlineStorage';
import {
  EMPTY_FILTERS,
  STALE_DAYS,
  applyFilters,
  describeFilters,
  filtersToSmartRules
} from '../../src/services/libraryFilters';
import { collectTrackFacts, matchesRule, sanitizeSmartPlaylists } from '../../src/services/smartPlaylists';
import { resetAuthStore, resetLibraryStore, resetPlayerStore, resetUIStore, signInForTests } from '../helpers/testUtils';
import { UnifiedTrack } from '../../src/types/music';

/**
 * Живые фильтры медиатеки (фича 10 плана 4.0): чипы над «Недавними» и
 * «Избранным», складываются по «И», счётчик следует за ними, набор сохраняется
 * умным плейлистом.
 */

const DAY = 86400000;

const t = (id: string, fields: Partial<UnifiedTrack> = {}): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title: `Song ${id}`,
  artist: 'Artist',
  duration: 200,
  artworkUrl: '',
  ...fields
});

const favorites: UnifiedTrack[] = [
  t('yt_short', { duration: 120 }),
  t('yt_long', { duration: 420 }),
  t('sc_short', { source: 'soundcloud', duration: 150 }),
  t('sc_mid', { source: 'soundcloud', duration: 240 })
];

const history = (id: string, playedAt: number): HistoryRecord => ({
  id,
  track: favorites.find((f) => f.id === id) ?? t(id),
  playedAt,
  playCount: 1
});

describe('сервис фильтров', () => {
  const ctx = { lastPlayedById: new Map<string, number>(), offlineIds: new Set<string>(), now: Date.now() };

  it('пустой набор ничего не трогает, фильтры складываются по «И»', () => {
    expect(applyFilters(favorites, EMPTY_FILTERS, ctx)).toHaveLength(4);
    const scShort = applyFilters(favorites, { ...EMPTY_FILTERS, source: 'soundcloud', duration: 'short' }, ctx);
    expect(scShort.map((x) => x.id)).toEqual(['sc_short']);
  });

  it('корзины длительности не пересекаются: ровно 3:00 — уже «3–6»', () => {
    const edge = [t('a', { duration: 180 }), t('b', { duration: 179 }), t('c', { duration: 360 }), t('d', { duration: 0 })];
    expect(applyFilters(edge, { ...EMPTY_FILTERS, duration: 'short' }, ctx).map((x) => x.id)).toEqual(['b']);
    expect(applyFilters(edge, { ...EMPTY_FILTERS, duration: 'medium' }, ctx).map((x) => x.id)).toEqual(['a']);
    expect(applyFilters(edge, { ...EMPTY_FILTERS, duration: 'long' }, ctx).map((x) => x.id)).toEqual(['c']);
  });

  it('«давно не слушал» — нет включения 90 дней, никогда не игравшие тоже', () => {
    const now = Date.now();
    const played = new Map([
      ['yt_short', now - 2 * DAY],
      ['yt_long', now - (STALE_DAYS + 1) * DAY]
    ]);
    const stale = applyFilters(favorites, { ...EMPTY_FILTERS, stale: true }, { ...ctx, lastPlayedById: played, now });
    expect(stale.map((x) => x.id)).toEqual(['yt_long', 'sc_short', 'sc_mid']);
  });

  it('«только офлайн» смотрит в хранилище, а не в поля трека', () => {
    const offline = applyFilters(favorites, { ...EMPTY_FILTERS, offline: true }, { ...ctx, offlineIds: new Set(['sc_mid']) });
    expect(offline.map((x) => x.id)).toEqual(['sc_mid']);
  });

  it('чипы переводятся в правила умного плейлиста один в один', () => {
    const rules = filtersToSmartRules({ source: 'soundcloud', duration: 'medium', stale: true, offline: true });
    expect(rules).toEqual([
      { field: 'source', op: 'is', value: 'soundcloud' },
      { field: 'duration', op: 'gte', value: 3 },
      { field: 'duration', op: 'lte', value: 6 },
      { field: 'lastPlayed', op: 'not_within_days', value: STALE_DAYS },
      { field: 'offline', op: 'is', value: true }
    ]);
    expect(describeFilters({ source: 'youtube', duration: 'short', stale: true, offline: false })).toBe(
      'YouTube · до 3 мин · давно не слушал'
    );
  });

  it('правило «сохранён офлайн» живёт в умных плейлистах и переживает чтение из настроек', () => {
    const facts = collectTrackFacts({ favorites, playlistTracks: [], history: [], offlineIds: new Set(['yt_long']) });
    const byId = new Map(facts.map((f) => [f.track.id, f]));
    expect(matchesRule(byId.get('yt_long')!, { field: 'offline', op: 'is', value: true }, Date.now())).toBe(true);
    expect(matchesRule(byId.get('yt_short')!, { field: 'offline', op: 'is', value: true }, Date.now())).toBe(false);
    const read = sanitizeSmartPlaylists([
      { id: 's', title: 'x', match: 'all', rules: [{ field: 'offline', op: 'is', value: true }], sort: 'added', limit: 0 }
    ]);
    expect(read[0].rules).toHaveLength(1);
  });
});

describe('чипы в медиатеке', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetLibraryStore();
    resetUIStore();
    resetPlayerStore();
    resetAuthStore();
    signInForTests();
    useSmartPlaylistStore.setState({ playlists: [], hydrated: true });
    useLibraryStore.setState({ favorites });
    useUIStore.setState({ activeView: 'favorites' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('комбинация фильтров меняет список и счётчик, активные чипы — aria-pressed', async () => {
    render(<LibraryView />);
    expect(screen.getByTestId('favorites-summary')).toHaveTextContent('4 трека');
    expect(screen.queryByTestId('library-filter-count')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('library-filter-source-soundcloud'));
    expect(screen.getByTestId('library-filter-source-soundcloud')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('library-filter-source-youtube')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('library-filter-count')).toHaveTextContent('2 трека');
    expect(screen.getByTestId('favorites-summary')).toHaveTextContent('Показано 2 из 4');

    fireEvent.click(screen.getByTestId('library-filter-duration-short'));
    expect(screen.getByTestId('library-filter-count')).toHaveTextContent('1 трек');
    expect(screen.getByText('Song sc_short')).toBeInTheDocument();
    expect(screen.queryByText('Song sc_mid')).not.toBeInTheDocument();

    // Второе нажатие по выбранному чипу снимает его.
    fireEvent.click(screen.getByTestId('library-filter-source-soundcloud'));
    expect(screen.getByTestId('library-filter-source-soundcloud')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('library-filter-count')).toHaveTextContent('2 трека');

    fireEvent.click(screen.getByTestId('library-filter-reset'));
    expect(screen.queryByTestId('library-filter-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('favorites-summary')).toHaveTextContent('4 трека');
  });

  it('«давно не слушал» читает даты из истории в базе', async () => {
    const now = Date.now();
    await db.history.bulkPut([
      history('yt_short', now - DAY),
      history('yt_long', now - (STALE_DAYS + 5) * DAY)
    ]);

    render(<LibraryView />);
    fireEvent.click(screen.getByTestId('library-filter-stale'));
    await waitFor(() => expect(screen.getByTestId('library-filter-count')).toHaveTextContent('3 трека'));
    expect(screen.queryByText('Song yt_short')).not.toBeInTheDocument();
    expect(screen.getByText('Song yt_long')).toBeInTheDocument();
  });

  it('«только офлайн» берёт список из хранилища', async () => {
    vi.spyOn(offlineStorage, 'getOfflineTracks').mockResolvedValue([
      { id: 'sc_mid', track: favorites[3], downloadedAt: Date.now(), sizeBytes: 1 } as never
    ]);

    render(<LibraryView />);
    fireEvent.click(screen.getByTestId('library-filter-offline'));
    await waitFor(() => expect(screen.getByTestId('library-filter-count')).toHaveTextContent('1 трек'));
    expect(screen.getByText('Song sc_mid')).toBeInTheDocument();
  });

  it('кнопка «сохранить» появляется с первым фильтром и создаёт умный плейлист из него', () => {
    render(<LibraryView />);
    expect(screen.queryByTestId('library-filter-save-smart')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('library-filter-source-youtube'));
    fireEvent.click(screen.getByTestId('library-filter-duration-long'));
    fireEvent.click(screen.getByTestId('library-filter-save-smart'));

    const created = useSmartPlaylistStore.getState().playlists[0];
    expect(created.title).toBe('YouTube · дольше 6 мин');
    expect(created.match).toBe('all');
    expect(created.rules).toEqual([
      { field: 'favorite', op: 'is', value: true },
      { field: 'source', op: 'is', value: 'youtube' },
      { field: 'duration', op: 'gte', value: 6 }
    ]);
    expect(useUIStore.getState().toastMessage?.text).toContain('Умный плейлист');
  });

  it('на «Недавних» нет чипа давности, набор переживает смену закладки', () => {
    useLibraryStore.setState({ history: [favorites[0], favorites[2]] });
    render(<LibraryView />);
    fireEvent.click(screen.getByTestId('library-filter-source-soundcloud'));

    fireEvent.click(screen.getByTestId('tab-library'));
    expect(screen.queryByTestId('library-filter-stale')).not.toBeInTheDocument();
    expect(screen.getByTestId('library-filter-source-soundcloud')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('library-filter-count')).toHaveTextContent('1 трек');
    expect(screen.getByText('Song sc_short')).toBeInTheDocument();
    expect(screen.queryByText('Song yt_short')).not.toBeInTheDocument();
  });
});

describe('дубли в избранном', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetLibraryStore();
    resetUIStore();
    resetPlayerStore();
    resetAuthStore();
    signInForTests();
    useUIStore.setState({ activeView: 'favorites' });
  });

  it('плашки нет без пар; с парой — показывает обе записи и убирает выбранную', async () => {
    useLibraryStore.setState({ favorites: [t('yt_a', { title: 'Creep' }), t('sc_b', { source: 'soundcloud', title: 'Other' })] });
    const { unmount } = render(<LibraryView />);
    expect(screen.queryByTestId('duplicates-banner')).not.toBeInTheDocument();
    unmount();

    const pairFavorites = [
      t('yt_a', { title: 'Creep (Official Video)', artist: 'Radiohead - Topic', duration: 238 }),
      t('sc_a', { source: 'soundcloud', title: 'Creep', artist: 'Radiohead', duration: 240 })
    ];
    useLibraryStore.setState({ favorites: pairFavorites });
    const toggleFavorite = vi.fn(async (track: UnifiedTrack) => {
      useLibraryStore.setState({ favorites: useLibraryStore.getState().favorites.filter((f) => f.id !== track.id) });
      return true;
    });
    useLibraryStore.setState({ toggleFavorite, isFavorite: (id) => pairFavorites.some((f) => f.id === id) });

    render(<LibraryView />);
    expect(screen.getByTestId('duplicates-summary')).toHaveTextContent('Нашли 1 пару одинаковых треков с YouTube и SoundCloud');
    expect(screen.queryByTestId('duplicates-list')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('duplicates-toggle'));
    expect(screen.getByTestId('duplicate-side-yt_a')).toBeInTheDocument();
    expect(screen.getByTestId('duplicate-side-sc_a')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('duplicate-keep-soundcloud-sc_a'));
    await waitFor(() => expect(toggleFavorite).toHaveBeenCalledTimes(1));
    expect(toggleFavorite.mock.calls[0][0].id).toBe('yt_a');
    await waitFor(() => expect(screen.queryByTestId('duplicates-banner')).not.toBeInTheDocument());
  });

  it('«Объединить всё» оставляет запись без пометки качества, иначе YouTube; плашка закрывается', async () => {
    const { markPreview, resetTrackQualityForTests } = await import('../../src/services/trackQuality');
    resetTrackQualityForTests();
    const pairFavorites = [
      t('yt_1', { title: 'One', duration: 200 }),
      t('sc_1', { source: 'soundcloud', title: 'One', duration: 201 }),
      t('yt_2', { title: 'Two', duration: 300 }),
      t('sc_2', { source: 'soundcloud', title: 'Two', duration: 300 })
    ];
    // У первой пары SoundCloud отдаёт отрывок — уходит он; у второй пометок нет — уходит SoundCloud.
    markPreview('sc_1');
    useLibraryStore.setState({ favorites: pairFavorites });
    const dropped: string[] = [];
    useLibraryStore.setState({
      toggleFavorite: vi.fn(async (track: UnifiedTrack) => {
        dropped.push(track.id);
        return true;
      }),
      isFavorite: () => true
    });

    render(<LibraryView />);
    fireEvent.click(screen.getByTestId('duplicates-toggle'));
    fireEvent.click(screen.getByTestId('duplicates-merge-all'));
    await waitFor(() => expect(dropped).toEqual(['sc_1', 'sc_2']));

    fireEvent.click(screen.getByTestId('duplicates-dismiss'));
    expect(screen.queryByTestId('duplicates-banner')).not.toBeInTheDocument();
    resetTrackQualityForTests();
  });
});
