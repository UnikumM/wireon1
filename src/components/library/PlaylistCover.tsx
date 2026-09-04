import React, { useEffect, useState } from 'react';
import { ListMusic, Music2 } from 'lucide-react';
import { UnifiedTrack } from '../../types/music';
import { distinctArtwork } from './trackSummary';
import { ICON } from '../../styles/icons';

export interface PlaylistCoverProps {
  tracks: UnifiedTrack[];
  /** Any CSS length; the cover is always square. */
  size?: number | string;
  radius?: string;
  className?: string;
}

/**
 * A 2×2 mosaic of the first four distinct artworks in the playlist. Tiles that are
 * missing — or whose image 404s — fall back to a matte placeholder individually,
 * so one dead thumbnail cannot blank the whole cover.
 */
export const PlaylistCover: React.FC<PlaylistCoverProps> = ({
  tracks,
  size = 160,
  radius = 'var(--radius-md)',
  className = ''
}) => {
  const urls = distinctArtwork(tracks, 4);
  const [failed, setFailed] = useState<string[]>([]);

  useEffect(() => {
    setFailed([]);
  }, [urls.join('|')]);

  const usable = urls.filter((url) => !failed.includes(url));
  const dimension = typeof size === 'number' ? `${size}px` : size;

  const frame: React.CSSProperties = {
    width: dimension,
    height: dimension,
    borderRadius: radius,
    overflow: 'hidden',
    backgroundColor: 'var(--surface-3)',
    border: '1px solid var(--border-subtle)',
    flexShrink: 0
  };

  if (usable.length === 0) {
    return (
      <div
        className={className}
        style={{ ...frame, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        data-testid="playlist-cover"
        data-tiles="0"
      >
        <ListMusic size={ICON['2xl']} aria-hidden="true" style={{ color: 'var(--text-faint)' }} />
      </div>
    );
  }

  const tiles = Array.from({ length: 4 }, (_, i) => usable[i] ?? null);

  return (
    <div
      className={className}
      style={{
        ...frame,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: '1px'
      }}
      data-testid="playlist-cover"
      data-tiles={usable.length}
    >
      {tiles.map((url, index) =>
        url ? (
          <img
            key={url}
            src={url}
            alt=""
            loading="lazy"
            onError={() => setFailed((prev) => (prev.includes(url) ? prev : [...prev, url]))}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <span
            key={`placeholder-${index}`}
            style={{
              width: '100%',
              height: '100%',
              backgroundColor: 'var(--surface-2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Music2 size={ICON.sm} aria-hidden="true" style={{ color: 'var(--text-faint)' }} />
          </span>
        )
      )}
    </div>
  );
};
