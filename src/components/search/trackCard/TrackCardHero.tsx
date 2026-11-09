import React from 'react';
import { Play, Pause, Heart, Plus } from 'lucide-react';
import { SourceBadge } from '../../common/SourceBadge';
import { Button } from '../../common/Button';
import { formatDuration } from '../../../utils/time';
import { ICON } from '../../../styles/icons';
import { TrackArtwork } from './TrackArtwork';
import { OfflineBadge, QualityBadge } from './TrackBadges';
import type { TrackCardViewProps } from './types';

export interface TrackCardHeroProps extends TrackCardViewProps {
  heroStacked: boolean;
}

/** «Лучшее совпадение» — большая карточка над результатами поиска. */
export const TrackCardHero: React.FC<TrackCardHeroProps> = ({
  track,
  className,
  heroStacked,
  isTrackPlaying,
  isFavorite,
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
    className={`card ${className}`}
    style={{
      display: 'flex',
      // В строку карточка отдаёт обложке 132 px плюс отступы, и на экране
      // 375 px тексту остаётся 115 — название обрезается на четвёртой
      // букве, а кнопка «Слушать» и длительность режутся пополам. В столбик
      // тому же тексту достаётся вся ширина карточки.
      flexDirection: heroStacked ? 'column' : 'row',
      gap: 'var(--space-5)',
      padding: 'var(--space-5)',
      borderRadius: 'var(--radius-lg)',
      alignItems: heroStacked ? 'stretch' : 'center',
    }}
    data-testid={`track-hero-${track.id}`}
    data-stacked={heroStacked ? 'true' : undefined}
    onMouseEnter={onIntentStart}
    onMouseLeave={onIntentEnd}
  >
    <TrackArtwork
      track={track}
      size={heroStacked ? 120 : 132}
      radius="var(--radius-md)"
      failed={artworkFailed}
      onFailed={onArtworkFailed}
    >
      {playOverlay}
    </TrackArtwork>

    <div className="grow stack gap-2">
      <div className="row gap-2">
        <span className="section-label">Лучшее совпадение</span>
        <SourceBadge source={track.source} size="xs" />
        {isDownloaded && <OfflineBadge trackId={track.id} variant="hero" />}
        <QualityBadge trackId={track.id} variant="hero" />
      </div>

      <h3
        className="text-truncate weight-semibold text-primary m-0 type-2xl"
        title={track.title}
      >
        {track.title}
      </h3>

      <p
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
          fontSize: 'var(--text-base)',
          // Цвет — в `.artist-link`: инлайновый погасил бы наведение.
          margin: 0,
          cursor: 'pointer',
          display: 'inline-block',
          // Без потолка `fit-content` отменяет многоточие — см. строку списка.
          maxWidth: '100%',
          width: 'fit-content'
        }}
        title={`Открыть артиста: ${track.artist}`}
        data-testid={`hero-artist-${track.id}`}
      >
        {track.artist}
      </p>

      <div
        className="row gap-3 mt-2"
      >
        <Button
          variant="primary"
          size="sm"
          icon={isTrackPlaying ? <Pause size={ICON.md} /> : <Play size={ICON.md} />}
          onClick={actions.handleActivateClick}
          data-testid="hero-play-btn"
        >
          {isTrackPlaying ? 'Пауза' : 'Слушать'}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="press"
          onClick={actions.handleFavoriteClick}
          title={isFavorite ? 'Убрать из избранного' : 'В избранное'}
          aria-label={isFavorite ? `Убрать «${track.title}» из избранного` : `Добавить «${track.title}» в избранное`}
          aria-pressed={isFavorite}
          style={{ color: isFavorite ? 'var(--danger)' : 'var(--text-secondary)' }}
          data-testid="hero-fav-btn"
        >
          <Heart size={ICON.lg} fill={isFavorite ? 'currentColor' : 'none'} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="press"
          onClick={actions.handleAddToQueue}
          title="В конец очереди"
          aria-label={`Добавить «${track.title}» в очередь`}
          data-testid="hero-queue-btn"
        >
          <Plus size={ICON.lg} />
        </Button>

        {contextMenu}

        <span
          data-numeric
          className="text-sm text-muted ml-auto"
        >
          {formatDuration(track.duration)}
        </span>
      </div>
    </div>
  </div>
);
