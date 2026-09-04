import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, Loader2, Search as SearchIcon, X } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { searchAggregator } from '../../services/aggregator';
import { youtubeService } from '../../services/youtube';
import * as dbService from '../../services/db';
import { ICON } from '../../styles/icons';
import type { UnifiedTrack } from '../../types/music';
import { TrackRow } from './TrackRow';

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
  const playTrack = usePlayerStore((s) => s.playTrack);
  const currentTrack = usePlayerStore((s) => s.currentTrack);

  const [draft, setDraft] = useState(searchQuery);
  const [results, setResults] = useState<UnifiedTrack[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

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
      return;
    }

    setLoading(true);
    void (async () => {
      try {
        const res = await searchAggregator.search(trimmed, { source: searchFilter, limit: RESULT_LIMIT });
        if (cancelled || id !== requestId.current) return;
        setResults(res.results);
        setError(null);
        persistRecent(mergeRecent(recentRef.current, trimmed));
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

  const handleRetry = useCallback(() => {
    // Мёртвое зеркало блокируется на сессию, а неудачный ответ кэшируется на
    // минуту — без сброса обоих повтор воспроизвёл бы ту же неудачу.
    youtubeService.resetInstanceHealth();
    searchAggregator.clearCache();
    setSearchQuery('');
    setTimeout(() => setSearchQuery(draft), 0);
  }, [draft, setSearchQuery]);

  const hasQuery = searchQuery.trim().length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }} data-testid="mobile-search">
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <SearchIcon
          size={ICON.lg}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 'var(--space-3)',
            color: 'var(--text-faint)',
            pointerEvents: 'none'
          }}
        />
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit(draft);
          }}
          placeholder="Треки и исполнители"
          aria-label="Поиск музыки"
          style={{
            width: '100%',
            minHeight: '48px',
            padding: '0 var(--space-7) 0 calc(var(--space-3) * 2 + 20px)',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
            fontSize: 'var(--text-base)'
          }}
          data-testid="mobile-search-input"
        />
        {draft && (
          <button
            type="button"
            className="press focus-ring"
            onClick={() => {
              setDraft('');
              setSearchQuery('');
            }}
            aria-label="Очистить поиск"
            style={{
              position: 'absolute',
              right: 'var(--space-1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '44px',
              height: '44px',
              borderRadius: 'var(--radius-pill)',
              color: 'var(--text-muted)',
              cursor: 'pointer'
            }}
            data-testid="mobile-search-clear"
          >
            <X size={ICON.md} aria-hidden="true" />
          </button>
        )}
      </div>

      {!hasQuery && (
        <>
          {recent.length > 0 && (
            <section data-testid="mobile-search-recent">
              <SectionTitle>Недавние запросы</SectionTitle>
              {recent.map((query) => (
                <div key={query} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <button
                    type="button"
                    className="press"
                    onClick={() => submit(query)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                      flex: 1,
                      minWidth: 0,
                      minHeight: '48px',
                      textAlign: 'left',
                      color: 'var(--text-primary)',
                      cursor: 'pointer'
                    }}
                    data-testid={`mobile-search-recent-${query}`}
                  >
                    <Clock size={ICON.md} style={{ flexShrink: 0, color: 'var(--text-faint)' }} aria-hidden="true" />
                    <span
                      className="text-truncate"
                      style={{
                        fontSize: 'var(--text-base)',
                        lineHeight: 'var(--leading-base)',
                        letterSpacing: 'var(--tracking-base)'
                      }}
                    >
                      {query}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="press focus-ring"
                    onClick={() => persistRecent(recentRef.current.filter((q) => q !== query))}
                    aria-label={`Убрать «${query}» из недавних`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '44px',
                      height: '44px',
                      flexShrink: 0,
                      borderRadius: 'var(--radius-pill)',
                      color: 'var(--text-faint)',
                      cursor: 'pointer'
                    }}
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
              className="scroll-x-quiet"
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                overflowX: 'auto',
                margin: '0 calc(var(--space-4) * -1)',
                padding: '0 var(--space-4)'
              }}
            >
              {QUICK_TAGS.map((tag) => (
                <button
                  key={tag.label}
                  type="button"
                  className="chip press"
                  onClick={() => submit(tag.query)}
                  style={{
                    flexShrink: 0,
                    minHeight: '38px',
                    padding: '0 var(--space-4)',
                    borderRadius: 'var(--radius-pill)',
                    cursor: 'pointer'
                  }}
                  data-testid={`mobile-search-tag-${tag.label}`}
                >
                  {tag.label}
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-6) 0',
            color: 'var(--text-muted)'
          }}
          data-testid="mobile-search-loading"
        >
          <Loader2 size={ICON.lg} className="animate-spin" aria-hidden="true" />
          Ищем…
        </div>
      )}

      {error && !isLoading && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
            padding: 'var(--space-4)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--danger-soft)',
            color: 'var(--text-primary)'
          }}
          data-testid="mobile-search-error"
        >
          <span style={{ fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-sm)' }}>{error}</span>
          <button
            type="button"
            className="press"
            onClick={handleRetry}
            style={{
              alignSelf: 'flex-start',
              minHeight: '40px',
              padding: '0 var(--space-4)',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              cursor: 'pointer'
            }}
          >
            Попробовать снова
          </button>
        </div>
      )}

      {!isLoading && !error && hasQuery && results.length === 0 && (
        <p
          style={{
            margin: 0,
            padding: 'var(--space-5) 0',
            fontSize: 'var(--text-sm)',
            lineHeight: 'var(--leading-sm)',
            color: 'var(--text-muted)'
          }}
          data-testid="mobile-search-empty"
        >
          Ничего не нашлось. Попробуйте другие слова.
        </p>
      )}

      {results.length > 0 && (
        <div>
          {results.map((track, index) => (
            <TrackRow
              key={track.id}
              track={track}
              isCurrent={currentTrack?.id === track.id}
              onPlay={() => void playTrack(track, results, index)}
              onOpenActions={() => openTrackActions(track)}
              data-testid={`mobile-search-track-${track.id}`}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h2
    style={{
      margin: '0 0 var(--space-2)',
      fontSize: 'var(--text-lg)',
      lineHeight: 'var(--leading-lg)',
      letterSpacing: 'var(--tracking-lg)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-primary)'
    }}
  >
    {children}
  </h2>
);
