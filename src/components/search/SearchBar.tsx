import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { searchAggregator } from '../../services/aggregator';
import { ICON } from '../../styles/icons';
import { useMediaQuery } from '../../hooks/useMediaQuery';

export interface SearchBarProps {
  query: string;
  isLoading?: boolean;
  onQueryChange: (query: string) => void;
  onSearchSubmit?: (query: string) => void;
  onClear?: () => void;
  className?: string;
}

/** The one debounce in the search path; the results effect never adds another. */
const QUERY_DEBOUNCE_MS = 300;
const SUGGEST_DEBOUNCE_MS = 180;
const MIN_SUGGEST_LENGTH = 2;
const LISTBOX_ID = 'search-suggestions';

/**
 * Подсказки на пустом поле. Подпись русская, а в поиск уходит `query` — каталоги
 * YouTube и SoundCloud размечены по-английски, и «синтвейв» находит заметно хуже.
 */
const QUICK_TAGS: { label: string; query: string }[] = [
  { label: 'Синтвейв', query: 'Synthwave' },
  { label: 'Киберпанк', query: 'Cyberpunk' },
  { label: 'Лоу-фай', query: 'Lo-Fi Chill' },
  { label: 'Танцевальное', query: 'EDM Festival' },
  { label: 'Русский рэп', query: 'русский рэп' },
  { label: 'Рок-классика', query: 'Rock Classics' },
  { label: 'Из аниме', query: 'Anime OST' }
];

export const SearchBar: React.FC<SearchBarProps> = ({
  query,
  isLoading = false,
  onQueryChange,
  onSearchSubmit,
  onClear,
  className = '',
}) => {
  /** Одна подписка на поле поиска: оно на экране одно, в отличие от строк списка. */
  const isNarrow = useMediaQuery('(max-width: 768px)');

  const [localQuery, setLocalQuery] = useState(query);
  const [isFocused, setIsFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestRequestRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalQuery(query);
  }, [query]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
      suggestRequestRef.current += 1;
    },
    []
  );

  // Dismiss the dropdown on an outside click.
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setHighlight(-1);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isOpen]);

  /** Latest-wins: a slow suggestion response never replaces a newer one. */
  const fetchSuggestions = useCallback((value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < MIN_SUGGEST_LENGTH) {
      suggestRequestRef.current += 1;
      setSuggestions([]);
      setIsOpen(false);
      setHighlight(-1);
      return;
    }

    const requestId = ++suggestRequestRef.current;
    void searchAggregator.getSuggestions(trimmed).then((list) => {
      if (requestId !== suggestRequestRef.current) return;
      const clean = list.filter((s) => typeof s === 'string' && s.trim()).slice(0, 8);
      setSuggestions(clean);
      setHighlight(-1);
      setIsOpen(clean.length > 0);
    });
  }, []);

  const commit = useCallback(
    (value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
      suggestRequestRef.current += 1;
      setLocalQuery(value);
      setIsOpen(false);
      setHighlight(-1);
      if (onSearchSubmit) onSearchSubmit(value);
      else onQueryChange(value);
    },
    [onQueryChange, onSearchSubmit]
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setLocalQuery(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onQueryChange(value), QUERY_DEBOUNCE_MS);

    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestTimerRef.current = setTimeout(() => fetchSuggestions(value), SUGGEST_DEBOUNCE_MS);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const open = isOpen && suggestions.length > 0;

    if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
      return;
    }
    if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
      return;
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setIsOpen(false);
        setHighlight(-1);
      }
      return;
    }
    if (e.key === 'Enter') {
      // Enter is only intercepted when an option is actually highlighted.
      if (open && highlight >= 0) {
        e.preventDefault();
        commit(suggestions[highlight]);
        return;
      }
      commit(localQuery);
    }
  };

  const handleClear = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestRequestRef.current += 1;
    setLocalQuery('');
    setSuggestions([]);
    setIsOpen(false);
    setHighlight(-1);
    if (onClear) onClear();
    else onQueryChange('');
    inputRef.current?.focus();
  };

  const showDropdown = isOpen && suggestions.length > 0;

  return (
    <div
      ref={containerRef}
      className={`wireon-search-bar-container ${className}`}
      style={{ position: 'relative', width: '100%', maxWidth: '780px' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-3) var(--space-4)',
          background: 'var(--surface-sunken)',
          border: `1px solid ${isFocused ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-md)',
          boxShadow: isFocused ? 'var(--ring-inset)' : 'none',
          transition: 'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
        }}
      >
        <Search size={ICON.lg} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden="true" />

        <input
          ref={inputRef}
          type="text"
          role="combobox"
          value={localQuery}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          /*
           * На телефоне подсказка обрезается на «…исполнителей на» — фраза
           * ломается посередине и читается как поломка, а не как подсказка.
           * Что искать, короткий вариант говорит ровно так же; где искать —
           * написано на переключателе источников прямо под полем.
           */
          placeholder={isNarrow ? 'Треки и исполнители' : 'Поиск треков и исполнителей на YouTube и SoundCloud'}
          aria-label="Поиск музыки"
          aria-expanded={showDropdown}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={highlight >= 0 ? `${LISTBOX_ID}-option-${highlight}` : undefined}
          autoComplete="off"
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            boxShadow: 'none',
            padding: 0,
            color: 'var(--text-primary)',
            fontSize: 'var(--text-base)',
            fontFamily: 'inherit',
          }}
          data-testid="search-input"
        />

        {isLoading && (
          <Loader2
            size={ICON.md}
            className="animate-spin"
            style={{ color: 'var(--accent)', flexShrink: 0 }}
            aria-hidden="true"
            data-testid="search-loading-spinner"
          />
        )}

        {localQuery && (
          <button
            type="button"
            className="press focus-ring"
            onClick={handleClear}
            aria-label="Очистить поиск"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 'var(--space-1)',
              borderRadius: 'var(--radius-full)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            data-testid="search-clear-btn"
          >
            <X size={ICON.md} />
          </button>
        )}
      </div>

      {showDropdown && (
        <ul
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Подсказки поиска"
          className="panel-raised scrollbar-thin animate-drop-in"
          style={{
            position: 'absolute',
            top: 'calc(100% + var(--space-1))',
            left: 0,
            right: 0,
            margin: 0,
            padding: 'var(--space-1)',
            listStyle: 'none',
            maxHeight: '280px',
            overflowY: 'auto',
            zIndex: 'var(--z-menu)',
          }}
          data-testid="search-suggestions"
        >
          {suggestions.map((s, i) => (
            <li
              key={`${s}_${i}`}
              id={`${LISTBOX_ID}-option-${i}`}
              role="option"
              aria-selected={i === highlight}
              // mousedown would blur the input before the click lands
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => commit(s)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--text-sm)',
                color: i === highlight ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: i === highlight ? 'var(--surface-hover)' : 'transparent',
                cursor: 'pointer',
              }}
              data-testid={`search-suggestion-${i}`}
            >
              <Search size={ICON.sm} style={{ color: 'var(--text-faint)', flexShrink: 0 }} aria-hidden="true" />
              <span className="text-truncate">{s}</span>
            </li>
          ))}
        </ul>
      )}

      {!localQuery && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-3)',
          }}
        >
          {QUICK_TAGS.map((tag) => (
            <button key={tag.query} type="button" className="chip" onClick={() => commit(tag.query)}>
              {tag.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
