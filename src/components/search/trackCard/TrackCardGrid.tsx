import React from 'react';
import { SourceBadge } from '../../common/SourceBadge';
import { formatDuration } from '../../../utils/time';
import { TrackArtwork } from './TrackArtwork';
import { OfflineBadge } from './TrackBadges';
import type { TrackCardViewProps } from './types';

/** Карточка для сеток (`layout="card"`): обложка сверху, текст и меню под ней. */
export const TrackCardGrid: React.FC<TrackCardViewProps> = ({
  track,
  className,
  isCurrent,
  isDownloaded,
  artworkFailed,
  onArtworkFailed,
  onIntentStart,
  onIntentEnd,
  actions,
  playOverlay,
  contextMenu,
}) => (
  <div
    className={`card-interactive ${className} stack gap-3 p-3`}
    aria-selected={isCurrent}
    style={{ cursor: 'default' }}
    data-testid={`track-card-${track.id}`}
    onMouseEnter={onIntentStart}
    onMouseLeave={onIntentEnd}
  >
    <TrackArtwork
      track={track}
      size={160}
      radius="var(--radius-sm)"
      failed={artworkFailed}
      onFailed={onArtworkFailed}
    >
      {playOverlay}
    </TrackArtwork>

    <div className="stack gap-px min-0">
      <span
        className="text-truncate text-lg weight-semibold tracking-lg"
        style={{ color: isCurrent ? 'var(--accent-hover)' : 'var(--text-primary)' }}
        title={track.title}
      >
        {track.title}
      </span>
      <span
        className="text-truncate artist-link"
        onClick={actions.handleArtistClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            actions.handleArtistClick(e as unknown as React.MouseEvent);
          }
        }}
        style={{
          fontSize: 'var(--text-sm)',
          // Цвета здесь нет нарочно: он живёт в `.artist-link` вместе с
          // наведением, а инлайновое объявление старше правила таблицы и
          // погасило бы отклик целиком.
          cursor: 'pointer',
          display: 'inline-block',
          // Без потолка `fit-content` отменяет многоточие — см. строку списка.
          maxWidth: '100%',
          width: 'fit-content'
        }}
        title={`Открыть артиста: ${track.artist}`}
        data-testid={`card-artist-${track.id}`}
      >
        {track.artist}
      </span>
    </div>

    <div className="row gap-2">
      <SourceBadge source={track.source} size="xs" />
      {isDownloaded && <OfflineBadge trackId={track.id} variant="card" />}
      <span data-numeric className="text-xs text-muted">
        {formatDuration(track.duration)}
      </span>
      <span className="ml-auto">{contextMenu}</span>
    </div>
  </div>
);
