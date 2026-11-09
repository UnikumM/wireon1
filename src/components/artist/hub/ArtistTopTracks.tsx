import React from 'react';
import { TrendingUp } from 'lucide-react';
import { UnifiedTrack } from '../../../types/music';
import { useUIStore } from '../../../store/useUIStore';
import { TrackCard } from '../../search/TrackCard';
import { EmptyState } from '../../common/EmptyState';
import { pluralize } from '../../../utils/plural';
import { ICON } from '../../../styles/icons';

interface ArtistTopTracksProps {
  artistName: string;
  tracks: UnifiedTrack[];
}

/** Десятка популярных треков; строки рисует `TrackCard`, очередь — весь список. */
export const ArtistTopTracks: React.FC<ArtistTopTracksProps> = ({ artistName, tracks }) => {
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setSearchQuery = useUIStore((s) => s.setSearchQuery);
  // Пустая десятка ведёт в обычный поиск по имени: там источников больше.
  const searchArtist = () => {
    setSearchQuery(artistName);
    setActiveView('search');
  };

  return (
  <section aria-labelledby="artist-top-tracks-heading" data-testid="artist-top-tracks-section">
    {/*
      * `space-between` без зазора и без запрета на сжатие — это не ряд, а
      * два слоя друг на друге. Счётчик ужимался до нулевой ширины, его
      * текст вылезал наружу, заголовок переносился на вторую строку, и на
      * 360 px «Популярные треки» лежало прямо поверх «10 треков».
      * Зазор разводит их, `flexShrink: 0` не даёт счётчику исчезнуть, а
      * `minWidth: 0` разрешает переноситься заголовку — он длиннее.
      */}
    <div
      className="row justify-between gap-3 mb-4"
    >
      <h2
        id="artist-top-tracks-heading"
        className="m-0 min-0 text-xl weight-semibold text-primary row gap-2"
      >
        {/* Про популярность, а не про волшебство: значок и должен быть про рост. */}
        <TrendingUp size={ICON.lg} className="text-secondary shrink-0" aria-hidden="true" />
        Популярные треки
      </h2>
      <span
        className="text-xs text-muted shrink-0 nowrap"
      >
        {pluralize(tracks.length, 'трек', 'трека', 'треков')}
      </span>
    </div>

    {tracks.length === 0 ? (
      <EmptyState
        art="search"
        title="Треки не найдены"
        description={`Доступных треков для «${artistName}» найти не удалось.`}
        action={{ label: 'Поискать по имени', onClick: searchArtist }}
        style={{ padding: 'var(--space-6)' }}
      />
    ) : (
      <div
        className="stack gap-1 p-2 radius-md bg-surface-1 border-subtle"
      >
        {tracks.map((track, index) => (
          <TrackCard
            key={track.id}
            track={track}
            index={index}
            showIndex={true}
            contextQueue={tracks}
            layout="row"
          />
        ))}
      </div>
    )}
  </section>
  );
};
