import React, { useEffect, useState } from 'react';
import { useUIStore } from '../../../store/useUIStore';
import { useMobileShell } from '../../../hooks/useMobileShell';
import { useIntentPrefetch, warmTrack } from '../../../hooks/useIntentPrefetch';
import { useAddToPlaylist } from '../../library/AddToPlaylistModal';
import { useTrackMenu } from './useTrackMenu';
import { useTrackActions } from './useTrackActions';
import { useTrackOffline } from './useTrackOffline';
import { TrackPlayOverlay } from './TrackPlayOverlay';
import { TrackContextMenu } from './TrackContextMenu';
import { TrackCardHero } from './TrackCardHero';
import { TrackCardGrid } from './TrackCardGrid';
import { TrackCardRow } from './TrackCardRow';
import type { TrackCardProps, TrackCardViewProps } from './types';

export type { TrackCardProps } from './types';

/**
 * Карточка трека — контейнер. Собирает состояние (сторы, меню, офлайн-отметку,
 * обложку) и раздаёт его трём видам: строка списка, карточка сетки и «лучшее
 * совпадение». Сама разметка живёт в `TrackCardRow`/`TrackCardGrid`/
 * `TrackCardHero`, меню — в `TrackContextMenu`.
 */
export const TrackCard: React.FC<TrackCardProps> = ({
  track,
  index,
  layout = 'row',
  heroStacked = false,
  contextQueue,
  onPlay,
  showIndex = true,
  className = '',
}) => {
  /*
   * Выбор плейлиста — отдельным окном, а не списком внутри меню.
   *
   * Раньше каждый плейлист был пунктом того же выпадающего меню, а меню
   * ограничено 320 px: пяти обычных действий и трёх плейлистов уже хватало,
   * чтобы началась прокрутка, — и до «Играть следующим» приходилось листать
   * обратно вверх. Жалоба звучала так: «на трёх точках зачем-то надо туда-сюда
   * листать». С ростом числа плейлистов меню становилось только хуже, а окно
   * выбора умеет и поиск, и создание нового прямо на месте.
   */
  const playlistPicker = useAddToPlaylist();

  // На телефоне вместо выпадающего меню — лист действий снизу (см. `TrackContextMenu`).
  const isMobileShell = useMobileShell();
  // Навёл курсор — ссылка начинает готовиться, к щелчку трек почти готов.
  const { onIntentStart, onIntentEnd } = useIntentPrefetch(track, !isMobileShell);

  // «Лучшее совпадение» — самый вероятный щелчок: его готовим сразу.
  useEffect(() => {
    if (layout === 'hero' && !isMobileShell) warmTrack(track);
  }, [layout, isMobileShell, track]);
  const openTrackActions = useUIStore((s) => s.openTrackActions);

  const [artworkFailed, setArtworkFailed] = useState(false);
  const isDownloaded = useTrackOffline(track?.id);

  const menu = useTrackMenu();
  const actions = useTrackActions({
    track,
    index,
    contextQueue,
    onPlay,
    closeMenu: menu.close,
    openPlaylistPicker: playlistPicker.open,
  });

  const contextMenu = (
    <TrackContextMenu
      track={track}
      menu={menu}
      actions={actions}
      isMobileShell={isMobileShell}
      onOpenMobileActions={openTrackActions}
      playlistPickerElement={playlistPicker.element}
    />
  );

  const playOverlay = (
    <TrackPlayOverlay
      track={track}
      isTrackPlaying={actions.isTrackPlaying}
      onActivate={actions.handleActivateClick}
    />
  );

  const viewProps: TrackCardViewProps = {
    track,
    className,
    isCurrent: actions.isCurrent,
    isTrackPlaying: actions.isTrackPlaying,
    isFavorite: actions.isFavorite,
    isDownloaded,
    artworkFailed,
    onArtworkFailed: () => setArtworkFailed(true),
    onIntentStart,
    onIntentEnd,
    actions,
    playOverlay,
    contextMenu,
  };

  // --- HERO LAYOUT (top search result) ---
  if (layout === 'hero') {
    return <TrackCardHero {...viewProps} heroStacked={heroStacked} />;
  }

  // --- CARD LAYOUT (grids) ---
  if (layout === 'card') {
    return <TrackCardGrid {...viewProps} />;
  }

  // --- ROW LAYOUT (default) ---
  return (
    <TrackCardRow
      {...viewProps}
      index={index}
      showIndex={showIndex}
      selectedTrackIds={actions.selectedTrackIds}
      isSelected={actions.isSelected}
    />
  );
};
