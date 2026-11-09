import React from 'react';
import { MarqueeText } from '../MarqueeText';
import type { UnifiedTrack } from '../../../types/music';

export interface NowPlayingTitlesProps {
  track: UnifiedTrack;
  /** `bar` — строка в плашке и полосе; `stage` — крупно на сцене. */
  size?: 'bar' | 'stage';
  /** Артист как кнопка: открывает его страницу. Без обработчика — просто текст. */
  onArtistClick?: () => void;
  titleTestId?: string;
  artistTestId?: string;
  className?: string;
}

const TITLE_CLASS: Record<NonNullable<NowPlayingTitlesProps['size']>, string> = {
  bar: 'type-sm weight-semibold text-primary',
  stage: 'type-xl weight-bold text-primary'
};
const ARTIST_CLASS: Record<NonNullable<NowPlayingTitlesProps['size']>, string> = {
  bar: 'text-truncate type-xs text-muted',
  stage: 'text-truncate type-base text-muted'
};

/** Название и артист играющего трека: бегущая строка для первого, обрезка для второго. */
export const NowPlayingTitles: React.FC<NowPlayingTitlesProps> = ({
  track,
  size = 'bar',
  onArtistClick,
  titleTestId,
  artistTestId,
  className = ''
}) => (
  <div className={`stack grow ${size === 'bar' ? 'gap-px' : 'gap-1'} ${className}`}>
    <MarqueeText text={track.title} className={TITLE_CLASS[size]} data-testid={titleTestId} />
    {onArtistClick && track.artist ? (
      <button
        type="button"
        onClick={onArtistClick}
        className={`${ARTIST_CLASS[size]} focus-ring hover-underline block min-0 p-0 text-left pointer bg-none border-none`}
        title={`Перейти к артисту: ${track.artist}`}
        data-testid={artistTestId}
      >
        {track.artist}
      </button>
    ) : (
      <span className={ARTIST_CLASS[size]} data-testid={artistTestId}>
        {track.artist}
      </span>
    )}
  </div>
);
