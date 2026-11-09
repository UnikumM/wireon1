import type React from 'react';
import type { UnifiedTrack } from '../../../types/music';
import type { TrackActions } from './useTrackActions';
import type { HoverPreviewHandle } from '../../../hooks/useHoverPreview';

export interface TrackCardProps {
  track: UnifiedTrack;
  /** Position of `track` inside `contextQueue`. Rendered as `index + 1`. */
  index?: number;
  layout?: 'row' | 'card' | 'hero';
  /**
   * Узкий экран: карточка «лучшее совпадение» встаёт в столбик.
   *
   * Пропом, а не своим `useMediaQuery`, потому что `TrackCard` рисуется на
   * каждую строку списка — подписка на медиазапрос в каждой из сотни строк
   * стоила бы дороже, чем то, что она решает. Хозяин один, и он же знает, что
   * рисует: `SearchResults`.
   */
  heroStacked?: boolean;
  contextQueue?: UnifiedTrack[];
  onPlay?: (track: UnifiedTrack, queue?: UnifiedTrack[], index?: number) => void;
  showIndex?: boolean;
  className?: string;
}

/**
 * Что контейнер отдаёт каждому из трёх видов карточки.
 *
 * Виды (`TrackCardHero`, `TrackCardGrid`, `TrackCardRow`) — чистая разметка:
 * всё состояние и все обработчики считаются один раз в `TrackCard` и приходят
 * сюда готовыми. Меню и оверлей передаются уже собранными элементами, потому
 * что они одинаковы для всех видов и отличаются только местом в разметке.
 */
export interface TrackCardViewProps {
  track: UnifiedTrack;
  className: string;
  isCurrent: boolean;
  isTrackPlaying: boolean;
  isFavorite: boolean;
  isDownloaded: boolean;
  artworkFailed: boolean;
  onArtworkFailed: () => void;
  /** Наведение готовит ссылку заранее — см. `useIntentPrefetch`. */
  onIntentStart: () => void;
  onIntentEnd: () => void;
  /** Превью по наведению на обложку — см. `useHoverPreview`; вид отдаёт его `TrackArtwork`. */
  preview: HoverPreviewHandle;
  actions: TrackActions;
  /** Кнопка «Слушать» поверх обложки (`TrackPlayOverlay`). */
  playOverlay: React.ReactNode;
  /** Кнопка «ещё» вместе с выпадающим меню (`TrackContextMenu`). */
  contextMenu: React.ReactNode;
}
