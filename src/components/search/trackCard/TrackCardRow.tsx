import React, { useState } from 'react';
import { Play, Heart, Plus, CheckCircle2 } from 'lucide-react';
import { SourceBadge } from '../../common/SourceBadge';
import { formatDuration } from '../../../utils/time';
import { ICON } from '../../../styles/icons';
import { TrackArtwork } from './TrackArtwork';
import { OfflineBadge, QualityBadge } from './TrackBadges';
import type { TrackCardViewProps } from './types';

export interface TrackCardRowProps extends TrackCardViewProps {
  index?: number;
  showIndex: boolean;
  /** `null` — обычный режим; массив — идёт выбор пачкой. */
  selectedTrackIds: string[] | null;
  isSelected: boolean;
}

/**
 * Строка списка (`layout="row"`, по умолчанию) — самый частый элемент
 * приложения. Наведение хранится здесь, а не в контейнере: от него зависят
 * только фон строки и значок на месте номера.
 */
export const TrackCardRow: React.FC<TrackCardRowProps> = ({
  track,
  className,
  index,
  showIndex,
  selectedTrackIds,
  isSelected,
  isCurrent,
  isTrackPlaying,
  isFavorite,
  isDownloaded,
  artworkFailed,
  onArtworkFailed,
  onIntentStart,
  onIntentEnd,
  preview,
  actions,
  contextMenu,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      aria-label={
        selectedTrackIds !== null
          ? `Выбрать «${track.title}» — ${track.artist}`
          : `Слушать «${track.title}» — ${track.artist}`
      }
      aria-current={isCurrent ? 'true' : undefined}
      aria-pressed={selectedTrackIds !== null ? isSelected : undefined}
      onClick={actions.activate}
      onKeyDown={actions.handleRowKeyDown}
      onMouseEnter={() => {
        setIsHovered(true);
        onIntentStart();
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        onIntentEnd();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        background: isCurrent ? 'var(--accent-soft)' : isHovered ? 'var(--surface-hover)' : 'transparent',
        border: `1px solid ${isCurrent ? 'var(--border-accent)' : isHovered ? 'var(--border-strong)' : 'transparent'}`,
        transition: 'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
      }}
      data-testid={`track-row-${track.id}`}
    >
      {/* Отметка вместо номера: номер в режиме выбора ничего не решает. */}
      {selectedTrackIds !== null && (
        <span
          aria-hidden="true"
          className="row-check"
          data-checked={isSelected}
          data-testid={`track-check-${track.id}`}
        >
          {isSelected && <CheckCircle2 size={ICON.sm} aria-hidden="true" />}
        </span>
      )}

      {showIndex && selectedTrackIds === null && (
        <div
          aria-hidden="true"
          className="track-row-index hide-on-mobile text-sm"
          style={{ color: isCurrent ? 'var(--accent)' : 'var(--text-muted)' }}
        >
          {isTrackPlaying ? (
            <span className="eq-bars">
              <span className="eq-bar" />
              <span className="eq-bar" />
              <span className="eq-bar" />
            </span>
          ) : isHovered ? (
            <Play size={ICON.sm} className="text-accent" />
          ) : (
            <span data-numeric>{index !== undefined ? index + 1 : ''}</span>
          )}
        </div>
      )}

      <TrackArtwork
        track={track}
        size={40}
        radius="var(--radius-xs)"
        failed={artworkFailed}
        onFailed={onArtworkFailed}
        preview={preview}
      />

      <div className="grow stack gap-px">
        <span
          className="text-truncate text-base"
          style={{ fontWeight: isCurrent ? 'var(--weight-semibold)' : 'var(--weight-medium)', color: isCurrent ? 'var(--accent-hover)' : 'var(--text-primary)' }}
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
            // Цвет — в `.artist-link`: инлайновый погасил бы наведение.
            display: 'inline-block',
            /*
              * `width: fit-content` без потолка отменял обрезку: коробка росла
              * под текст, `overflow: hidden` резать было нечего, и длинное имя
              * артиста уезжало за строку — «The Midnight Cassette Orchestra»
              * лежало поверх кнопки «ещё». Ширина по тексту нужна, чтобы нажатие
              * попадало в имя, а не в пустоту справа от него; потолок в 100%
              * возвращает многоточие.
              */
            maxWidth: '100%',
            width: 'fit-content'
          }}
          title={`Открыть артиста: ${track.artist}`}
          data-testid={`track-artist-${track.id}`}
        >
          {track.artist}
        </span>
      </div>

      {/*
        * На телефоне из строки уходит всё, что спорит с названием.
        *
        * Строка — самый частый элемент приложения, и в ней соревновались шесть
        * вещей: значок источника, отметка офлайн, длительность, сердце, очередь
        * и «ещё». На 375 px после обложки и кнопок названию оставалось меньше
        * половины ширины. В телефонных плеерах в строке ровно три вещи —
        * обложка, две строки текста и одна кнопка, — и это не мода, а
        * единственное, что туда помещается.
        *
        * Ничего не теряется: «В избранное» и «В конец очереди» уже есть в меню
        * «ещё», а источник и длительность видны в самом плеере.
        */}
      <div className="track-row-meta hide-on-mobile">
        <SourceBadge source={track.source} size="xs" />
        {isDownloaded && <OfflineBadge trackId={track.id} variant="row" />}
        <QualityBadge trackId={track.id} variant="row" />
      </div>

      <span
        data-numeric
        className="hide-on-mobile text-sm text-muted text-right shrink-0"
        style={{ width: '48px' }}
      >
        {formatDuration(track.duration)}
      </span>

      <div
        className="row gap-1 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="press focus-ring tap-target hide-on-mobile p-2 pointer"
          onClick={actions.handleFavoriteClick}
          title={isFavorite ? 'Убрать из избранного' : 'В избранное'}
          aria-label={isFavorite ? `Убрать «${track.title}» из избранного` : `Добавить «${track.title}» в избранное`}
          aria-pressed={isFavorite}
          style={{ color: isFavorite ? 'var(--danger)' : 'var(--text-secondary)' }}
          data-testid={`track-fav-btn-${track.id}`}
        >
          <Heart size={ICON.md} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>

        <button
          type="button"
          className="press focus-ring tap-target hide-on-mobile p-2 text-secondary pointer"
          onClick={actions.handleAddToQueue}
          title="В конец очереди"
          aria-label={`Добавить «${track.title}» в очередь`}
          data-testid={`track-queue-btn-${track.id}`}
        >
          <Plus size={ICON.md} />
        </button>

        {contextMenu}
      </div>
    </div>
  );
};
