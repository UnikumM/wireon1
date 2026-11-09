import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ListMusic, Music2 } from 'lucide-react';
import { UnifiedTrack } from '../../types/music';
import { distinctArtwork } from './trackSummary';
import { ICON } from '../../styles/icons';

export interface PlaylistCoverProps {
  tracks: UnifiedTrack[];
  /** Своя обложка. Есть — показывается она, нет — мозаика из состава. */
  coverUrl?: string;
  /** Any CSS length; the cover is always square. */
  size?: number | string;
  radius?: string;
  className?: string;
}

/**
 * Своя обложка, если её поставили; иначе мозаика 2×2 из первых четырёх разных
 * обложек состава. Плитка, картинка которой не загрузилась, гаснет по
 * отдельности — одна мёртвая ссылка не должна обнулять всю обложку.
 */
export const PlaylistCover: React.FC<PlaylistCoverProps> = ({
  tracks,
  coverUrl,
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
    /*
     * Высота — от ширины, а не тем же значением.
     *
     * С `height: '100%'` обложка схлопывалась в полоску: сто процентов
     * считаются от родителя, а у него своей высоты нет. Замерено на шапке
     * плейлиста телефона: ширина 328 px, высота ноль. Обложка квадратная по
     * определению, поэтому пропорция надёжнее второго размера.
     */
    aspectRatio: '1',
    borderRadius: radius,
    overflow: 'hidden',
    backgroundColor: 'var(--surface-3)',
    border: '1px solid var(--border-subtle)',
    flexShrink: 0
  };

  if (coverUrl) {
    return (
      <img
        className={className}
        src={coverUrl}
        alt=""
        style={{ ...frame, objectFit: 'cover', display: 'block' }}
        data-testid="playlist-cover"
        data-tiles="custom"
      />
    );
  }

  if (usable.length === 0) {
    return (
      <div
        className={clsx('row justify-center', className)}
        style={frame}
        data-testid="playlist-cover"
        data-tiles="0"
      >
        <ListMusic size={ICON['2xl']} aria-hidden="true" className="text-faint" />
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
            className="fill-cover block"
          />
        ) : (
          <span
            key={`placeholder-${index}`}
            className="w-full h-full row justify-center bg-surface-2"
          >
            <Music2 size={ICON.sm} aria-hidden="true" className="text-faint" />
          </span>
        )
      )}
    </div>
  );
};
