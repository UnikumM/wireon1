import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Music2, RotateCcw, Shuffle, Play, X } from 'lucide-react';
import { AudioSource, SearchCollection, SearchKind, UnifiedTrack } from '../../types/music';
import { searchAggregator } from '../../services/aggregator';
import { youtubeService } from '../../services/youtube';
import * as dbService from '../../services/db';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { SearchBar } from './SearchBar';
import { TrackCard } from './TrackCard';
import { CoverCard } from '../common/CoverCard';
import { Disc3, ListMusic, User } from 'lucide-react';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { Skeleton } from '../common/Skeleton';
import { plural } from '../../utils/plural';
import { ICON } from '../../styles/icons';

export interface SearchResultsProps {
  className?: string;
}

type SourceFilter = 'all' | AudioSource;

const RECENT_SEARCHES_KEY = 'searchRecentQueries';
const MAX_RECENT_SEARCHES = 8;
const RESULT_LIMIT = 40;

const SOURCE_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
};

/**
 * Вкладки выдачи.
 *
 * Раньше поиск возвращал плоский список треков и только его: найти альбом,
 * профиль или чужой плейлист было нельзя вовсе, хотя источники их отдают.
 */
const KIND_TABS: { value: SearchKind; label: string }[] = [
  { value: 'tracks', label: 'Треки' },
  { value: 'albums', label: 'Альбомы' },
  { value: 'artists', label: 'Исполнители' },
  { value: 'playlists', label: 'Плейлисты' }
];

/** Значок на месте обложки, когда источник её не дал. */
const COLLECTION_ICON: Record<SearchCollection['kind'], React.ReactNode> = {
  album: <Disc3 size={ICON.display} />,
  artist: <User size={ICON.display} />,
  playlist: <ListMusic size={ICON.display} />
};

/** Какой вид подборки показывает вкладка. */
const TAB_KIND: Record<Exclude<SearchKind, 'tracks'>, SearchCollection['kind']> = {
  albums: 'album',
  artists: 'artist',
  playlists: 'playlist'
};

const FILTERS: { value: SourceFilter; label: string; testId: string }[] = [
  { value: 'all', label: 'Везде', testId: 'filter-all' },
  { value: 'youtube', label: 'YouTube', testId: 'filter-youtube' },
  { value: 'soundcloud', label: 'SoundCloud', testId: 'filter-soundcloud' },
];

/**
 * Newest first, capped. Drops the exact query and any earlier entry that is a
 * prefix of it, so typing "cyber" then "cyberpunk" leaves one entry rather than
 * filling the list with keystroke fragments.
 */
function mergeRecent(existing: string[], query: string): string[] {
  const needle = query.toLowerCase();
  const kept = existing.filter((q) => {
    const lower = q.toLowerCase();
    return lower !== needle && !needle.startsWith(lower);
  });
  return [query, ...kept].slice(0, MAX_RECENT_SEARCHES);
}

export const SearchResults: React.FC<SearchResultsProps> = ({ className = '' }) => {
  /** Один хук на весь экран: подписка в каждой строке списка обошлась бы дороже. */
  const isNarrow = useMediaQuery('(max-width: 768px)');

  const searchQuery = useUIStore((s) => s.searchQuery);
  const searchFilter = useUIStore((s) => s.searchFilter);
  const setSearchQuery = useUIStore((s) => s.setSearchQuery);
  const setSearchFilter = useUIStore((s) => s.setSearchFilter);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const openArtist = useUIStore((s) => s.openArtist);
  const openCollection = useUIStore((s) => s.openCollection);

  const [results, setResults] = useState<UnifiedTrack[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [searchNonce, setSearchNonce] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [kind, setKind] = useState<SearchKind>('tracks');
  const [collections, setCollections] = useState<SearchCollection[]>([]);
  const [isLoadingCollections, setIsLoadingCollections] = useState(false);

  /** Monotonic request id: only the newest search is allowed to commit state. */
  const requestIdRef = useRef(0);
  const recentRef = useRef<string[]>([]);

  const persistRecent = useCallback((next: string[]) => {
    recentRef.current = next;
    setRecentSearches(next);
    void dbService.setSetting(RECENT_SEARCHES_KEY, next).catch(() => {
      /* a failed write only costs history, never the search itself */
    });
  }, []);

  useEffect(() => {
    let active = true;
    void dbService.getSetting<string[]>(RECENT_SEARCHES_KEY, []).then((stored) => {
      if (!active) return;
      const clean = Array.isArray(stored) ? stored.filter((q) => typeof q === 'string' && q.trim()) : [];
      recentRef.current = clean;
      setRecentSearches(clean);
    });
    return () => {
      active = false;
    };
  }, []);

  /**
   * The only place a search is performed. Query/filter changes and explicit
   * submits/retries all funnel through here, so a keystroke can never fire two
   * searches, and a slow earlier response can never overwrite a newer one.
   */
  useEffect(() => {
    const trimmed = searchQuery.trim();
    const requestId = ++requestIdRef.current;
    let cancelled = false;

    if (!trimmed) {
      setResults([]);
      setError(null);
      setSourceErrors({});
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    const run = async () => {
      try {
        const res = await searchAggregator.search(trimmed, { source: searchFilter, limit: RESULT_LIMIT });
        if (cancelled || requestId !== requestIdRef.current) return;

        setResults(res.results);
        setSourceErrors(res.errors ?? {});
        setError(null);
        persistRecent(mergeRecent(recentRef.current, trimmed));
      } catch (err) {
        if (cancelled || requestId !== requestIdRef.current) return;
        console.error('[SearchResults] Search failed:', err);
        setResults([]);
        setSourceErrors({});
        setError(err instanceof Error ? err.message : 'Во время поиска произошла ошибка');
      } finally {
        if (!cancelled && requestId === requestIdRef.current) setIsLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [searchQuery, searchFilter, searchNonce, persistRecent]);

  /**
   * Подборки грузятся только когда их смотрят.
   *
   * Отдельным запросом и по требованию: на вкладке «Треки» они не нужны, а
   * тянуть их на каждую букву означало бы платить за то, чего человек чаще
   * всего не откроет.
   */
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (kind === 'tracks' || !trimmed) return;

    let cancelled = false;
    setIsLoadingCollections(true);

    void searchAggregator
      .searchCollections(trimmed, { source: searchFilter, limit: 24 })
      .then((found) => {
        if (!cancelled) setCollections(found);
      })
      .catch(() => {
        if (!cancelled) setCollections([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingCollections(false);
      });

    return () => {
      cancelled = true;
    };
  }, [searchQuery, searchFilter, searchNonce, kind]);

  /**
   * A3 blocklists a dead instance for the rest of the session after two
   * consecutive failures, and the aggregator caches the failed result for a
   * minute — both have to be cleared or a retry reproduces the outage.
   */
  const handleRetry = useCallback(() => {
    youtubeService.resetInstanceHealth();
    searchAggregator.clearCache();
    setSearchNonce((n) => n + 1);
  }, []);

  const handleClear = useCallback(() => {
    setSearchQuery('');
    setResults([]);
    setSourceErrors({});
    setError(null);
  }, [setSearchQuery]);

  const handleSubmit = useCallback(
    (query: string) => {
      setSearchQuery(query);
      // Batched with the query update, so this stays a single search — and it
      // still re-runs when the query is unchanged (Enter as a retry gesture).
      setSearchNonce((n) => n + 1);
    },
    [setSearchQuery]
  );

  const handleRemoveRecent = (query: string) => {
    persistRecent(recentRef.current.filter((q) => q !== query));
  };

  const handlePlayAll = (shuffle: boolean) => {
    if (results.length === 0) return;
    if (shuffle && !isShuffled) toggleShuffle();
    void playTrack(results[0], results, 0);
  };

  /** Arrow-key roving focus across result rows. Rows own Enter/Space. */
  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="button"]'));
    if (rows.length === 0) return;
    e.preventDefault();
    const from = rows.findIndex((row) => row === target || row.contains(target));
    const next =
      e.key === 'ArrowDown'
        ? from < 0
          ? 0
          : Math.min(from + 1, rows.length - 1)
        : from < 0
          ? rows.length - 1
          : Math.max(from - 1, 0);
    rows[next].focus();
  };

  /**
   * Открыть найденную подборку.
   *
   * Исполнитель уходит на свой экран, альбом и плейлист — на экран подборки.
   * Раньше карточка сразу включала первый трек: человек видел состав только
   * очередью, уже начав слушать не то, что хотел.
   */
  const handleOpenCollection = useCallback(
    (collection: SearchCollection) => {
      if (collection.kind === 'artist') {
        openArtist(collection.title);
        return;
      }
      openCollection(collection);
    },
    [openArtist, openCollection]
  );

  const hasQuery = searchQuery.trim() !== '';
  const shownCollections =
    kind === 'tracks' ? [] : collections.filter((item) => item.kind === TAB_KIND[kind]);
  const failedSources = Object.keys(sourceErrors);
  const topMatch = results.length > 0 ? results[0] : null;
  const restResults = results.slice(1);

  return (
    <div
      // Появление экрана — на корне и только здесь: ниже лежат области, которые
      // перерисовываются на каждую букву запроса, и анимация входа на любой из
      // них мигала бы при наборе.
      className={`wireon-search-view animate-view-in ${className}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', width: '100%' }}
      data-testid="search-view"
    >
      <SearchBar
        query={searchQuery}
        isLoading={isLoading}
        onQueryChange={setSearchQuery}
        onSearchSubmit={handleSubmit}
        onClear={handleClear}
      />

      {/* Вкладки выдачи: треки и три вида подборок. */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}
        role="tablist"
        aria-label="Что искать"
      >
        {KIND_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            className="chip"
            aria-selected={kind === tab.value}
            onClick={() => setKind(tab.value)}
            data-testid={`search-tab-${tab.value}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Source filter — re-queries through the same single search path. */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}
        role="group"
        aria-label="Фильтр по источнику"
      >
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className="chip"
            aria-pressed={searchFilter === f.value}
            onClick={() => setSearchFilter(f.value)}
            data-testid={f.testId}
          >
            {f.label}
            {kind === 'tracks' && hasQuery && !isLoading && results.length > 0 && (
              <span data-numeric style={{ color: 'var(--text-muted)' }}>
                {f.value === 'all'
                  ? results.length
                  : results.filter((t) => t.source === f.value).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Per-source outage — non-blocking, results from healthy sources stay. */}
      {failedSources.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {failedSources.map((source) => (
            <div
              key={source}
              className="card"
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                borderColor: 'var(--warning)',
                background: 'var(--warning-soft)',
              }}
              data-testid={`search-source-error-${source}`}
            >
              <AlertTriangle size={ICON.lg} style={{ color: 'var(--warning)', flexShrink: 0 }} aria-hidden="true" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 'var(--text-sm)',
                    fontWeight: 'var(--weight-medium)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {SOURCE_LABELS[source] ?? source} не отвечает
                </p>
                <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                  {sourceErrors[source]}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCcw size={ICON.sm} />}
                onClick={handleRetry}
                data-testid={`search-retry-${source}`}
              >
                Повторить
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Whole-search failure (the aggregator itself rejected). */}
      {!isLoading && error && (
        <div
          className="card"
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-4)',
            borderColor: 'var(--danger)',
            background: 'var(--danger-soft)',
          }}
          data-testid="search-error"
        >
          <AlertTriangle size={ICON.lg} style={{ color: 'var(--danger)', flexShrink: 0 }} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontSize: 'var(--text-base)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
              }}
            >
              Поиск не удался
            </p>
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{error}</p>
          </div>
          <Button variant="secondary" size="sm" icon={<RotateCcw size={ICON.sm} />} onClick={handleRetry}>
            Повторить
          </Button>
        </div>
      )}

      {/* Loading skeletons */}
      {((kind === 'tracks' && isLoading) || (kind !== 'tracks' && isLoadingCollections)) && (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
          aria-busy="true"
          aria-live="polite"
          data-testid="search-skeletons"
        >
          <Skeleton height={180} radius="var(--radius-lg)" />
          <Skeleton height={56} count={6} />
        </div>
      )}

      {/* Подборки: альбомы, исполнители, плейлисты. */}
      {kind !== 'tracks' && !isLoadingCollections && hasQuery && shownCollections.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            gap: 'var(--space-3)'
          }}
          data-testid="search-collection-grid"
        >
          {shownCollections.map((item) => (
            <CoverCard
              key={item.id}
              title={item.title}
              subtitle={item.subtitle}
              artworkUrl={item.artworkUrl}
              // У исполнителя обложка круглая: это человек, а не диск.
              round={item.kind === 'artist'}
              fallbackIcon={COLLECTION_ICON[item.kind]}
              testId={`collection-${item.id}`}
              onClick={() => handleOpenCollection(item)}
            />
          ))}
        </div>
      )}

      {kind !== 'tracks' && !isLoadingCollections && hasQuery && shownCollections.length === 0 && (
        <EmptyState
          data-testid="search-no-collections"
          icon={<Music2 size={ICON.display} />}
          title={`Ничего не нашлось по запросу «${searchQuery.trim()}»`}
          description="Источники ответили, но подборок такого вида у них нет. Попробуйте вкладку «Треки» или другое написание."
        />
      )}

      {/* Results */}
      {kind === 'tracks' && !isLoading && !error && hasQuery && results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: 'var(--text-xl)',
                lineHeight: 'var(--leading-xl)',
                letterSpacing: 'var(--tracking-xl)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
              }}
            >
              Найдено
            </h2>
            <span
              style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}
              data-testid="search-result-count"
            >
              <span data-numeric>{results.length}</span>{' '}
              {plural(results.length, 'трек', 'трека', 'треков')} по запросу «{searchQuery.trim()}»
            </span>

            <div style={{ display: 'flex', gap: 'var(--space-2)', marginLeft: 'auto' }}>
              <Button
                variant="primary"
                size="sm"
                icon={<Play size={ICON.md} />}
                onClick={() => handlePlayAll(false)}
                data-testid="search-play-all"
              >
                Слушать всё
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Shuffle size={ICON.md} />}
                onClick={() => handlePlayAll(true)}
                data-testid="search-shuffle-all"
              >
                Вперемешку
              </Button>
            </div>
          </div>

          {topMatch && (
            <TrackCard
              track={topMatch}
              index={0}
              layout="hero"
              heroStacked={isNarrow}
              contextQueue={results}
            />
          )}

          {restResults.length > 0 && (
            <div>
              <h3 className="section-label" style={{ marginBottom: 'var(--space-3)' }}>
                Остальное
              </h3>
              <div
                role="list"
                onKeyDown={handleListKeyDown}
                style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}
                data-testid="search-result-list"
              >
                {restResults.map((t, idx) => (
                  <TrackCard
                    key={`${t.id}_${idx}`}
                    track={t}
                    index={idx + 1}
                    layout="row"
                    contextQueue={results}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Genuinely no matches — deliberately different from an outage notice. */}
      {kind === 'tracks' &&
        !isLoading &&
        !error &&
        hasQuery &&
        results.length === 0 &&
        failedSources.length === 0 && (
        <EmptyState
          data-testid="search-no-results"
          icon={<Music2 size={ICON.display} />}
          title={`Ничего не нашлось по запросу «${searchQuery.trim()}»`}
          description="Все источники ответили, но такого трека у них нет. Проверьте написание, попробуйте одно имя исполнителя или снимите фильтр — искать везде."
          action={
            searchFilter !== 'all' ? (
              <Button variant="secondary" size="sm" onClick={() => setSearchFilter('all')}>
                Искать везде
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Nothing typed yet: recent searches + starting points. */}
      {!hasQuery && !isLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          {recentSearches.length > 0 && (
            <section data-testid="recent-searches">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  marginBottom: 'var(--space-3)',
                }}
              >
                <h3 className="section-label">Недавние запросы</h3>
                <button
                  type="button"
                  onClick={() => persistRecent([])}
                  style={{
                    marginLeft: 'auto',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: 'var(--space-1) var(--space-2)',
                  }}
                  data-testid="recent-clear-all"
                >
                  Очистить
                </button>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                {recentSearches.map((q) => (
                  <span key={q} className="chip" style={{ paddingRight: 'var(--space-1)' }}>
                    <button
                      type="button"
                      onClick={() => setSearchQuery(q)}
                      style={{ color: 'inherit', font: 'inherit', cursor: 'pointer' }}
                      data-testid={`recent-search-${q}`}
                    >
                      {q}
                    </button>
                    <button
                      type="button"
                      className="press"
                      onClick={() => handleRemoveRecent(q)}
                      aria-label={`Убрать «${q}» из недавних запросов`}
                      style={{
                        display: 'inline-flex',
                        padding: '3px',
                        borderRadius: 'var(--radius-full)',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      <X size={ICON.xs} />
                    </button>
                  </span>
                ))}
              </div>
            </section>
          )}

          {/*
            * Раздела «С чего начать» здесь больше нет.
            *
            * Четыре плитки с названием жанра и описанием предлагали ровно то же,
            * что чипы подсказок под самим полем ввода: тот же список, то же
            * действие — подставить запрос. Причём чипов семь, они компактны и
            * стоят там, куда человек и так смотрит после клика в поиск, а плитки
            * занимали вчетверо больше места ниже. Один и тот же выбор, поданный
            * дважды в двух разных формах, — это не помощь, а сетка карточек
            * ради сетки карточек. Список подсказок живёт в SearchBar.
            */}
        </div>
      )}
    </div>
  );
};
