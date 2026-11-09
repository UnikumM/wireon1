import React from 'react';
import { Sparkles, X } from 'lucide-react';
import { Button } from '../common/Button';
import { useSmartPlaylistStore } from '../../store/useSmartPlaylistStore';
import { useUIStore } from '../../store/useUIStore';
import {
  DURATION_BUCKETS,
  DurationBucket,
  describeFilters,
  filtersToSmartRules,
  hasActiveFilters,
  LibraryFilters
} from '../../services/libraryFilters';
import type { SmartRule } from '../../services/smartPlaylists';
import type { AudioSource } from '../../types/music';
import { ICON } from '../../styles/icons';
import { pluralize } from '../../utils/plural';

export interface LibraryFilterChipsProps {
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  /** Сколько треков прошло через фильтры — подпись в конце ряда. */
  count: number;
  /**
   * Откуда список: добавляется правилом в сохранённый умный плейлист, иначе
   * тот собирал бы всю медиатеку, а не то, что человек видел перед собой.
   */
  scope: 'favorites' | 'recent';
  /** «Давно не слушал» есть только там, где это осмысленно — не на «Недавних». */
  showStale?: boolean;
  className?: string;
}

const SOURCES: Array<{ value: AudioSource; label: string }> = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'soundcloud', label: 'SoundCloud' }
];

const DURATIONS = Object.keys(DURATION_BUCKETS) as DurationBucket[];

/**
 * Ряд чипов-фильтров над списком треков.
 *
 * Чип — переключатель: состояние в `aria-pressed`, и подсветку он получает от
 * `.chip[aria-pressed='true']` в global.css, как закладки и жанры Потока. Чипы
 * одной группы (источник, длительность) взаимоисключающие: второе нажатие по
 * выбранному снимает его, нажатие по соседу — переставляет.
 */
export const LibraryFilterChips: React.FC<LibraryFilterChipsProps> = ({
  filters,
  onChange,
  count,
  scope,
  showStale = true,
  className = ''
}) => {
  const createSmart = useSmartPlaylistStore((s) => s.create);
  const showToast = useUIStore((s) => s.showToast);
  const active = hasActiveFilters(filters);

  const setSource = (value: AudioSource) => onChange({ ...filters, source: filters.source === value ? null : value });
  const setDuration = (value: DurationBucket) =>
    onChange({ ...filters, duration: filters.duration === value ? null : value });

  const handleSave = () => {
    const rules: SmartRule[] = [
      // Сначала откуда, потом чем отфильтровано — так читается подпись карточки.
      scope === 'favorites'
        ? { field: 'favorite', op: 'is', value: true }
        : { field: 'plays', op: 'gte', value: 1 },
      ...filtersToSmartRules(filters)
    ];
    const title = describeFilters(filters) || 'Из медиатеки';
    const created = createSmart({ title, match: 'all', rules, sort: 'added', limit: 0 });
    showToast(`Умный плейлист «${created.title}» сохранён — он в «Плейлистах»`, 'success');
  };

  return (
    <div className={`row wrap gap-2 ${className}`.trim()} role="group" aria-label="Фильтры списка" data-testid="library-filters">
      {SOURCES.map((item) => (
        <button
          key={item.value}
          type="button"
          className="chip"
          aria-pressed={filters.source === item.value}
          onClick={() => setSource(item.value)}
          data-testid={`library-filter-source-${item.value}`}
        >
          {item.label}
        </button>
      ))}
      <span className="library-filter-divider" aria-hidden="true" />
      {DURATIONS.map((bucket) => (
        <button
          key={bucket}
          type="button"
          className="chip"
          aria-pressed={filters.duration === bucket}
          onClick={() => setDuration(bucket)}
          data-testid={`library-filter-duration-${bucket}`}
        >
          {DURATION_BUCKETS[bucket].label}
        </button>
      ))}
      <span className="library-filter-divider" aria-hidden="true" />
      {showStale && (
        <button
          type="button"
          className="chip"
          aria-pressed={filters.stale}
          onClick={() => onChange({ ...filters, stale: !filters.stale })}
          title="Не включали три месяца или ни разу"
          data-testid="library-filter-stale"
        >
          Давно не слушал
        </button>
      )}
      <button
        type="button"
        className="chip"
        aria-pressed={filters.offline}
        onClick={() => onChange({ ...filters, offline: !filters.offline })}
        data-testid="library-filter-offline"
      >
        Только офлайн
      </button>

      {active && (
        <>
          <span className="text-sm text-secondary ml-auto" data-numeric data-testid="library-filter-count">
            {pluralize(count, 'трек', 'трека', 'треков')}
          </span>
          <Button
            variant="secondary"
            size="sm"
            icon={<Sparkles size={ICON.sm} aria-hidden="true" />}
            onClick={handleSave}
            data-testid="library-filter-save-smart"
          >
            Сохранить как умный плейлист
          </Button>
          <Button
            variant="ghost"
            size="icon"
            icon={<X size={ICON.sm} aria-hidden="true" />}
            onClick={() => onChange({ source: null, duration: null, stale: false, offline: false })}
            aria-label="Сбросить фильтры"
            title="Сбросить фильтры"
            data-testid="library-filter-reset"
          />
        </>
      )}
    </div>
  );
};
