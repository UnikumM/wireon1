import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseCollectionLink } from '../../services/collections';
import { parseTrackLink, resolveTrackLink, trackSearchQuery } from '../../services/trackLinks';
import { looksLikeLyricLine, searchByLyricLine, type LyricTrackHit } from '../../services/lyricSearch';
import { Clock, Loader2, Play, Search as SearchIcon, X } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { searchAggregator } from '../../services/aggregator';
import { Button } from '../common/Button';
import { CoverCard } from '../common/CoverCard';
import { Skeleton } from '../common/Skeleton';
import { youtubeService } from '../../services/youtube';
import * as dbService from '../../services/db';
import { ICON } from '../../styles/icons';
import type { CollectionKind, SearchCollection, SearchKind, UnifiedTrack } from '../../types/music';
import { TrackRow } from './TrackRow';
import { LyricQuote } from '../search/LyricQuote';

/**
 * Поиск на телефоне.
 *
 * Прежний экран открывался как стартовый и показывал поле, семь жанровых плашек
 * в три рваных ряда, ещё три плашки источника — и **пятьсот пикселей пустоты**
 * под ними. Теперь стартовый экран другой (Главная), и поиску незачем
 * притворяться витриной: до запроса он показывает то, что человек уже искал,
 * а плашки жанров сжаты в один прокручиваемый ряд.
 *
 * Фильтр источника («Везде / YouTube / SoundCloud») убран с глаз: на телефоне
 * он третий ряд плашек ради настройки, которую меняют раз в жизни. Значение
 * из настроек по-прежнему действует — просто переключается не здесь.
 */

const RESULT_LIMIT = 40;
const RECENT_SEARCHES_KEY = 'searchRecentQueries';
const MAX_RECENT = 8;
const QUERY_DEBOUNCE_MS = 300;

/** Подпись по-русски, запрос по-английски: так находится больше. */
const QUICK_TAGS: Array<{ label: string; query: string }> = [
  { label: 'Синтвейв', query: 'Synthwave' },
  { label: 'Лоу-фай', query: 'Lo-Fi Chill' },
  { label: 'Русский рэп', query: 'русский рэп' },
  { label: 'Рок', query: 'Rock Classics' },
  { label: 'Танцевальное', query: 'EDM Festival' },
  { label: 'Из аниме', query: 'Anime OST' }
];

function mergeRecent(existing: string[], query: string): string[] {
  const needle = query.toLowerCase();
  const kept = existing.filter((q) => {
    const lower = q.toLowerCase();
    return lower !== needle && !needle.startsWith(lower);
  });
  return [query, ...kept].slice(0, MAX_RECENT);
}

export const MobileSearchView: React.FC = () => {
  const searchQuery = useUIStore((s) => s.searchQuery);
  const searchFilter = useUIStore((s) => s.searchFilter);
  const setSearchQuery = useUIStore((s) => s.setSearchQuery);
  const openTrackActions = useUIStore((s) => s.openTrackActions);
  const openArtist = useUIStore((s) => s.openArtist);
  const openCollection = useUIStore((s) => s.openCollection);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const currentTrack = usePlayerStore((s) => s.currentTrack);

  const [draft, setDraft] = useState(searchQuery);
  const [results, setResults] = useState<UnifiedTrack[]>([]);
  /*
   * Вкладки выдачи. На телефоне их не было вовсе: альбом, исполнителя и чужой
   * плейлист найти было нельзя, хотя источники их отдают и большой экран их
   * уже показывает.
   */
  const [kind, setKind] = useState<SearchKind>('tracks');
  const [collections, setCollections] = useState<SearchCollection[]>([]);
  const [isLoadingCollections, setLoadingCollections] = useState(false);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  /** Трек, открытый по ссылке, и признак, что по ссылке ничего не нашли. */
  const [linkTrack, setLinkTrack] = useState<UnifiedTrack | null>(null);
  const [linkMissed, setLinkMissed] = useState(false);
  /** Треки, найденные по строчке из песни: локальные тексты, затем LRCLIB. */
  const [lyricHits, setLyricHits] = useState<LyricTrackHit[]>([]);

  /** Растущий номер запроса: ответ на устаревший ввод не должен перебить свежий. */
  const requestId = useRef(0);
  const recentRef = useRef<string[]>([]);

  useEffect(() => {
    let alive = true;
    void dbService.getSetting<string[]>(RECENT_SEARCHES_KEY, []).then((stored) => {
      if (!alive) return;
      const clean = Array.isArray(stored) ? stored.filter((q) => typeof q === 'string' && q.trim()) : [];
      recentRef.current = clean;
      setRecent(clean);
    });
    return () => {
      alive = false;
    };
  }, []);

  const persistRecent = useCallback((next: string[]) => {
    recentRef.current = next;
    setRecent(next);
    // Неудачная запись стоит только истории, но не самого поиска.
    void dbService.setSetting(RECENT_SEARCHES_KEY, next).catch(() => {});
  }, []);

  // Ввод отстаивается: иначе каждая буква уходила бы отдельным запросом в сеть.
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(draft), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, setSearchQuery]);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    const id = ++requestId.current;
    let cancelled = false;

    if (!trimmed) {
      setResults([]);
      setError(null);
      setLoading(false);
      setLinkTrack(null);
      setLinkMissed(false);
      setLyricHits([]);
      return;
    }

    // Ссылка на трек — сначала сам трек, под ним поиск по его названию.
    const trackLink = parseTrackLink(trimmed);

    // Ссылка на чужой плейлист открывается сразу — слушать и сохранять.
    const link = trackLink ? null : parseCollectionLink(trimmed);
    if (link) {
      setLoading(false);
      setDraft('');
      setSearchQuery('');
      useUIStore.getState().openCollection(link);
      return;
    }

    setLoading(true);
    setLinkTrack(null);
    setLinkMissed(false);
    setLyricHits([]);

    // Длинная фраза без ссылки — возможно, строчка из песни: ищем в текстах
    // параллельно с обычным поиском, показываем над выдачей.
    if (!trackLink && looksLikeLyricLine(trimmed)) {
      void searchByLyricLine(trimmed)
        .then((found) => {
          if (cancelled || id !== requestId.current) return;
          setLyricHits([...found.local, ...found.online]);
        })
        .catch(() => {
          /* строчка — подсказка поверх поиска, её неудача не ломает выдачу */
        });
    }
    void (async () => {
      try {
        let query = trimmed;
        if (trackLink) {
          const found = await resolveTrackLink(trackLink);
          if (cancelled || id !== requestId.current) return;
          if (found) {
            setLinkTrack(found);
            query = trackSearchQuery(found) || trimmed;
          } else {
            setLinkMissed(true);
          }
        }
        const res = await searchAggregator.search(query, { source: searchFilter, limit: RESULT_LIMIT });
        if (cancelled || id !== requestId.current) return;
        setResults(res.results);
        setError(null);
        // Адрес в недавних бесполезен: повторить его можно только вставкой.
        if (!trackLink) persistRecent(mergeRecent(recentRef.current, trimmed));
      } catch (err) {
        if (cancelled || id !== requestId.current) return;
        console.error('[MobileSearchView] поиск не удался:', err);
        setResults([]);
        setError(err instanceof Error ? err.message : 'Во время поиска произошла ошибка');
      } finally {
        if (!cancelled && id === requestId.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [persistRecent, searchFilter, searchQuery]);

  const submit = useCallback(
    (query: string) => {
      setDraft(query);
      setSearchQuery(query);
    },
    [setSearchQuery]
  );

  /**
   * Подборки грузятся только когда открывают их вкладку.
   *
   * На вкладке «Треки» они не нужны, а ходить за ними на каждую букву значило
   * бы платить трафиком за то, чего человек чаще всего не откроет.
   */
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (kind === 'tracks' || !trimmed) return;

    let cancelled = false;
    setLoadingCollections(true);
    void searchAggregator
      .searchCollections(trimmed, { source: searchFilter, limit: 24 })
      .then((found) => {
        if (!cancelled) setCollections(found);
      })
      .catch(() => {
        if (!cancelled) setCollections([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCollections(false);
      });

    return () => {
      cancelled = true;
    };
  }, [kind, searchFilter, searchQuery]);

  const handleOpenCollection = useCallback(
    (collection: SearchCollection) => {
      if (collection.kind === 'artist') openArtist(collection.title);
      else openCollection(collection);
    },
    [openArtist, openCollection]
  );

  const shownCollections = useMemo(
    () => (kind === 'tracks' ? [] : collections.filter((item) => item.kind === TAB_KIND[kind])),
    [collections, kind]
  );

  const handleRetry = useCallback(() => {
    // Мёртвое зеркало блокируется на сессию, а неудачный ответ кэшируется на
    // минуту — без сброса обоих повтор воспроизвёл бы ту же неудачу.
    youtubeService.resetInstanceHealth();
    searchAggregator.clearCache();
    setSearchQuery('');
    setTimeout(() => setSearchQuery(draft), 0);
  }, [draft, setSearchQuery]);

  const hasQuery = searchQuery.trim().length > 0;
  const isLinkQuery = useMemo(() => parseTrackLink(searchQuery) !== null, [searchQuery]);
  /** Трек по ссылке стоит первым, его копия из обычной выдачи убирается. */
  const otherResults = useMemo(
    () => (linkTrack ? results.filter((t) => t.id !== linkTrack.id) : results),
    [linkTrack, results]
  );
  const queue = useMemo(() => (linkTrack ? [linkTrack, ...otherResults] : results), [linkTrack, otherResults, results]);
  /** Очередь находок по строчке: сыграл одну — дальше остальные находки. */
  const lyricQueue = useMemo(() => lyricHits.map((hit) => hit.track), [lyricHits]);

  return (
    <div className="stack gap-4" data-testid="mobile-search">
      <div className="relative row">
        <SearchIcon
          size={ICON.lg}
          aria-hidden="true"
          className="text-faint no-events" style={{ position: 'absolute', left: 'var(--space-3)' }}
        />
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit(draft);
          }}
          placeholder="Треки и исполнители"
          aria-label="Поиск музыки"
          className="w-full text-primary text-base bg-surface-2 border-line" style={{ minHeight: '48px', padding: '0 var(--space-7) 0 calc(var(--space-3) * 2 + 20px)', borderRadius: 'var(--radius-pill)' }}
          data-testid="mobile-search-input"
        />
        {draft && (
          <button
            type="button"
            className="press focus-ring row justify-center text-muted pointer"
            onClick={() => {
              setDraft('');
              setSearchQuery('');
            }}
            aria-label="Очистить поиск"
            style={{ position: 'absolute', right: 'var(--space-1)', width: '44px', height: '44px', borderRadius: 'var(--radius-pill)' }}
            data-testid="mobile-search-clear"
          >
            <X size={ICON.md} aria-hidden="true" />
          </button>
        )}
      </div>

      {hasQuery && (
        <div
          className="row-stretch gap-2" style={{ overflowX: 'auto', scrollbarWidth: 'none' }}
          role="tablist"
          aria-label="Что искать"
        >
          {KIND_TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              className="chip press shrink-0 pointer py-0 px-4"
              aria-selected={kind === item.value}
              onClick={() => setKind(item.value)}
              style={{ minHeight: '38px', borderRadius: 'var(--radius-pill)' }}
              data-testid={`mobile-search-tab-${item.value}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {!hasQuery && (
        <>
          {recent.length > 0 && (
            <section data-testid="mobile-search-recent">
              <SectionTitle>Недавние запросы</SectionTitle>
              {recent.map((query) => (
                <div key={query} className="row gap-2">
                  <button
                    type="button"
                    className="press row gap-3 grow text-left text-primary pointer"
                    onClick={() => submit(query)}
                    style={{ minHeight: '48px' }}
                    data-testid={`mobile-search-recent-${query}`}
                  >
                    <Clock size={ICON.md} className="shrink-0 text-faint" aria-hidden="true" />
                    <span
                      className="text-truncate text-base leading-base tracking-base"
                    >
                      {query}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="press focus-ring row justify-center shrink-0 text-faint pointer"
                    onClick={() => persistRecent(recentRef.current.filter((q) => q !== query))}
                    aria-label={`Убрать «${query}» из недавних`}
                    style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-pill)' }}
                  >
                    <X size={ICON.sm} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </section>
          )}

          <section>
            <SectionTitle>Попробуйте</SectionTitle>
            {/*
              * Один прокручиваемый ряд вместо трёх рваных. Семь плашек не
              * помещались в 328 px и переносились ступенькой, съедая треть
              * экрана ради подсказок.
              */}
            <div
              className="scroll-x-quiet row-stretch gap-2 py-0 px-4"
              style={{ overflowX: 'auto', margin: '0 calc(var(--mobile-content-pad, var(--space-4)) * -1)' }}
            >
              {QUICK_TAGS.map((tag) => (
                <button
                  key={tag.label}
                  type="button"
                  className="chip press shrink-0 pointer py-0 px-4"
                  onClick={() => submit(tag.query)}
                  style={{ minHeight: '38px', borderRadius: 'var(--radius-pill)' }}
                  data-testid={`mobile-search-tag-${tag.label}`}
                >
                  {tag.label}
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      {/* По строчке из песни: сначала свои тексты, потом найденное на LRCLIB. */}
      {kind === 'tracks' && lyricHits.length > 0 && (
        <section className="card stack gap-3 p-3" data-testid="mobile-search-lyric-hits">
          <SectionTitle>По строчке из песни</SectionTitle>
          {lyricHits.map((hit, index) => (
            <div key={hit.track.id} className="stack gap-2">
              <TrackRow
                track={hit.track}
                isCurrent={currentTrack?.id === hit.track.id}
                onPlay={() => void playTrack(hit.track, lyricQueue, index)}
                onOpenActions={() => openTrackActions(hit.track)}
                data-testid={`mobile-search-lyric-${hit.track.id}`}
              />
              <LyricQuote hit={hit} />
            </div>
          ))}
        </section>
      )}

      {/* Трек по ссылке: карточка сразу, остальное доезжает под ней. */}
      {kind === 'tracks' && linkTrack && (
        <section className="card stack gap-3 p-3" data-testid="mobile-search-link-track">
          <SectionTitle>Трек по ссылке</SectionTitle>
          <TrackRow
            track={linkTrack}
            isCurrent={currentTrack?.id === linkTrack.id}
            onPlay={() => void playTrack(linkTrack, queue, 0)}
            onOpenActions={() => openTrackActions(linkTrack)}
            data-testid="mobile-search-link-row"
          />
          <Button
            variant="primary"
            size="md"
            icon={<Play size={ICON.md} />}
            onClick={() => void playTrack(linkTrack, queue, 0)}
            data-testid="mobile-search-link-play"
          >
            Слушать
          </Button>
        </section>
      )}

      {kind === 'tracks' && linkMissed && !isLoading && hasQuery && (
        <p className="m-0 text-sm text-muted leading-sm" role="status" data-testid="mobile-search-link-miss">
          По ссылке ничего не нашли — показываем обычный поиск.
        </p>
      )}

      {/* Пока трек по ссылке не приехал — скелетон на его месте, а не вертушка. */}
      {isLoading && isLinkQuery && !linkTrack && (
        <div className="stack gap-3" aria-busy="true" aria-live="polite" data-testid="mobile-search-link-skeleton">
          <Skeleton height={132} radius="var(--radius-lg)" />
          <Skeleton height={72} count={4} />
        </div>
      )}

      {isLoading && !(isLinkQuery && !linkTrack) && (
        <div
          className="row justify-center gap-2 text-muted py-6 px-0"
          data-testid="mobile-search-loading"
        >
          <Loader2 size={ICON.lg} className="animate-spin" aria-hidden="true" />
          Ищем…
        </div>
      )}

      {error && !isLoading && (
        <div
          className="stack gap-3 p-4 radius-lg text-primary bg-danger-soft"
          data-testid="mobile-search-error"
        >
          <span className="text-sm leading-sm">{error}</span>
          <button
            type="button"
            className="press self-start text-primary pointer py-0 px-4 border-line"
            onClick={handleRetry}
            style={{ minHeight: '40px', borderRadius: 'var(--radius-pill)' }}
          >
            Попробовать снова
          </button>
        </div>
      )}

      {kind === 'tracks' && !isLoading && !error && hasQuery && !linkTrack && results.length === 0 && (
        <p
          className="m-0 text-sm text-muted py-5 px-0 leading-sm"
          data-testid="mobile-search-empty"
        >
          Ничего не нашлось. Попробуйте другие слова.
        </p>
      )}

      {kind === 'tracks' && otherResults.length > 0 && (
        <div>
          {linkTrack && <SectionTitle>Другие версии</SectionTitle>}
          {otherResults.map((track, index) => (
            <TrackRow
              key={track.id}
              track={track}
              isCurrent={currentTrack?.id === track.id}
              onPlay={() => void playTrack(track, queue, linkTrack ? index + 1 : index)}
              onOpenActions={() => openTrackActions(track)}
              data-testid={`mobile-search-track-${track.id}`}
            />
          ))}
        </div>
      )}

      {kind !== 'tracks' && isLoadingCollections && (
        <div
          className="row justify-center gap-2 text-muted py-6 px-0"
          data-testid="mobile-search-collections-loading"
        >
          <Loader2 size={ICON.lg} className="animate-spin" aria-hidden="true" />
          Ищем…
        </div>
      )}

      {kind !== 'tracks' && !isLoadingCollections && hasQuery && (
        shownCollections.length === 0 ? (
          <p
            className="m-0 text-sm text-muted py-5 px-0 leading-sm"
            data-testid="mobile-search-collections-empty"
          >
            Подборок такого вида не нашлось. Попробуйте вкладку «Треки».
          </p>
        ) : (
          <div
            className="grid gap-4" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
            data-testid="mobile-search-collections"
          >
            {shownCollections.map((item) => (
              <CoverCard
                key={item.id}
                title={item.title}
                subtitle={item.subtitle}
                artworkUrl={item.artworkUrl}
                // У исполнителя обложка круглая: это человек, а не диск.
                round={item.kind === 'artist'}
                testId={`mobile-search-collection-${item.id}`}
                onClick={() => handleOpenCollection(item)}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
};

/** Вкладки выдачи и вид подборки, который показывает каждая. */
const KIND_TABS: { value: SearchKind; label: string }[] = [
  { value: 'tracks', label: 'Треки' },
  { value: 'albums', label: 'Альбомы' },
  { value: 'artists', label: 'Исполнители' },
  { value: 'playlists', label: 'Плейлисты' }
];

const TAB_KIND: Record<Exclude<SearchKind, 'tracks'>, CollectionKind> = {
  albums: 'album',
  artists: 'artist',
  playlists: 'playlist'
};

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h2
    className="text-lg weight-semibold text-primary leading-lg tracking-lg" style={{ margin: '0 0 var(--space-2)' }}
  >
    {children}
  </h2>
);
