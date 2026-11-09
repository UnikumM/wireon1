import React, { useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { UnifiedTrack } from '../../../types/music';
import { ICON } from '../../../styles/icons';

export interface TrackPlayOverlayProps {
  track: UnifiedTrack;
  isTrackPlaying: boolean;
  onActivate: (e: React.MouseEvent) => void;
}

/**
 * Кнопка «Слушать»/«Пауза» поверх обложки в карточке и «лучшем совпадении».
 *
 * Видна при наведении, фокусе и пока трек играет. Состояние наведения своё,
 * а не из контейнера: оно никому, кроме этой кнопки, не нужно, и так карточка
 * не перерисовывается целиком от каждого движения курсора по обложке.
 */
export const TrackPlayOverlay: React.FC<TrackPlayOverlayProps> = ({ track, isTrackPlaying, onActivate }) => {
  const [overlayActive, setOverlayActive] = useState(false);

  return (
    <button
      type="button"
      className="focus-ring row justify-center pointer"
      onClick={onActivate}
      onMouseEnter={() => setOverlayActive(true)}
      onMouseLeave={() => setOverlayActive(false)}
      onFocus={() => setOverlayActive(true)}
      onBlur={() => setOverlayActive(false)}
      aria-label={isTrackPlaying ? `Пауза: ${track.title}` : `Слушать: ${track.title}`}
      style={{ position: 'absolute', inset: 0, background: 'var(--surface-active)', opacity: overlayActive || isTrackPlaying ? 1 : 0, transition: 'opacity var(--dur-fast) var(--ease-out)' }}
      data-testid={`track-artwork-play-${track.id}`}
    >
      <span
        className="control-lg radius-full row justify-center bg-accent" style={{ color: 'var(--text-on-accent)' }}
      >
        {isTrackPlaying ? <Pause size={ICON.lg} /> : <Play size={ICON.lg} className="ml-px" />}
      </span>
    </button>
  );
};
