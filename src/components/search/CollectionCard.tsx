import React from 'react';
import { Disc3, ListMusic, User, type LucideIcon } from 'lucide-react';
import { CollectionKind, SearchCollection } from '../../types/music';
import { ICON } from '../../styles/icons';

/**
 * Карточка альбома, исполнителя или плейлиста в выдаче поиска.
 *
 * Одна карточка на три вида нарочно: различаются они значком-заглушкой и
 * формой обложки — у исполнителя круг, у остального квадрат, — а всё
 * остальное совпадает. Три компонента здесь означали бы три копии одной сетки.
 */
export interface CollectionCardProps {
  collection: SearchCollection;
  onOpen: (collection: SearchCollection) => void;
}

const FALLBACK_ICON: Record<CollectionKind, LucideIcon> = {
  album: Disc3,
  artist: User,
  playlist: ListMusic
};

export const CollectionCard: React.FC<CollectionCardProps> = ({ collection, onOpen }) => {
  const Icon = FALLBACK_ICON[collection.kind];
  const isArtist = collection.kind === 'artist';

  return (
    <div
      role="button"
      tabIndex={0}
      className="card-interactive press focus-ring animate-settle hover-sheen"
      onClick={() => onOpen(collection)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(collection);
        }
      }}
      data-testid={`collection-${collection.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
        cursor: 'pointer',
        minWidth: 0
      }}
    >
      <div
        style={{
          position: 'relative',
          aspectRatio: '1 / 1',
          borderRadius: isArtist ? 'var(--radius-full)' : 'var(--radius-md)',
          overflow: 'hidden',
          background: 'var(--surface-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {collection.artworkUrl ? (
          <img
            src={collection.artworkUrl}
            alt=""
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Icon size={ICON.display} />
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <p
          className="text-truncate"
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--weight-semibold)',
            color: 'var(--text-primary)'
          }}
        >
          {collection.title}
        </p>
        {collection.subtitle && (
          <p
            className="text-truncate"
            style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
          >
            {collection.subtitle}
          </p>
        )}
      </div>
    </div>
  );
};
