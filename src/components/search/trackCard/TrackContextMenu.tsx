import React from 'react';
import { createPortal } from 'react-dom';
import { Heart, Plus, MoreHorizontal, ListPlus, ExternalLink, Share2, Radio, CheckSquare, Tag } from 'lucide-react';
import { UnifiedTrack } from '../../../types/music';
import { ICON } from '../../../styles/icons';
import type { TrackMenu } from './useTrackMenu';
import type { TrackActions } from './useTrackActions';

export interface TrackContextMenuProps {
  track: UnifiedTrack;
  menu: TrackMenu;
  actions: TrackActions;
  /**
   * На телефоне действия открываются листом снизу, а не этим меню.
   *
   * Ветвление здесь временное и умрёт вместе с переездом списков на
   * `mobile/TrackRow`. Пока же оно чинит главную жалобу сразу во всех семи
   * списках, которые монтируют эту карточку: выпадающий блок жил
   * `position: absolute` внутри прокручиваемого `<main>` и обрезался им,
   * всегда открывался вниз и висел у правого края.
   */
  isMobileShell: boolean;
  onOpenMobileActions: (track: UnifiedTrack) => void;
  /** Окно выбора плейлиста (`useAddToPlaylist().element`). */
  playlistPickerElement: React.ReactNode;
}

/**
 * Кнопка «ещё» и выпадающее меню трека. Разметка без состояния: что открыто,
 * где стоит и что делает каждый пункт — приходит из `useTrackMenu` и
 * `useTrackActions`.
 */
export const TrackContextMenu: React.FC<TrackContextMenuProps> = ({
  track,
  menu,
  actions,
  isMobileShell,
  onOpenMobileActions,
  playlistPickerElement,
}) => (
  <div className="relative" ref={menu.rootRef}>
    <button
      type="button"
      ref={menu.triggerRef}
      className="press focus-ring p-2 text-secondary pointer"
      onClick={(e) => {
        e.stopPropagation();
        if (isMobileShell) {
          onOpenMobileActions(track);
          return;
        }
        menu.toggle();
      }}
      aria-label={`Другие действия с «${track.title}»`}
      aria-haspopup="menu"
      aria-expanded={menu.isOpen}
      data-testid={`track-more-btn-${track.id}`}
    >
      <MoreHorizontal size={ICON.md} />
    </button>

    {menu.isOpen && !isMobileShell && typeof document !== 'undefined' && createPortal(
      <div
        ref={menu.panelRef}
        className="panel-raised animate-drop-in scrollbar-thin"
        role="menu"
        aria-label={`Действия с «${track.title}»`}
        onKeyDown={menu.onKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={
          {
            // Растёт из угла у кнопки: рост от середины отвязывает меню от
            // того, что нажали.
            '--pop-origin': menu.position?.origin ?? 'top right',
            position: 'fixed',
            top: menu.position ? `${menu.position.top}px` : 0,
            left: menu.position ? `${menu.position.left}px` : 0,
            // Пока место не посчитано (первый кадр), меню не видно — иначе оно
            // мелькнуло бы в углу окна.
            visibility: menu.position ? 'visible' : 'hidden',
            padding: 'var(--space-1)',
            minWidth: '210px',
            maxHeight: '320px',
            overflowY: 'auto',
            zIndex: 'var(--z-menu)',
          } as React.CSSProperties
        }
        data-testid="track-context-menu"
      >
        <button
          type="button"
          role="menuitem"
          autoFocus
          className="menu-item-hover"
          onClick={actions.handlePlayNext}
          data-testid={`menu-play-next-${track.id}`}
        >
          <ListPlus size={ICON.md} aria-hidden="true" />
          <span className="text-truncate">Играть следующим</span>
        </button>

        <button
          type="button"
          role="menuitem"
          className="menu-item-hover"
          onClick={actions.handleStartTrackRadio}
          data-testid={`menu-track-radio-${track.id}`}
        >
          <Radio size={ICON.md} aria-hidden="true" />
          <span className="text-truncate">Запустить радио по треку</span>
        </button>

        <button type="button" role="menuitem" className="menu-item-hover" onClick={actions.handleAddToQueueFromMenu}>
          <Plus size={ICON.md} aria-hidden="true" />
          <span className="text-truncate">В конец очереди</span>
        </button>

        <button
          type="button"
          role="menuitem"
          className="menu-item-hover"
          onClick={actions.handleFavoriteFromMenu}
          data-testid={`menu-favorite-${track.id}`}
        >
          <Heart
            size={ICON.md}
            aria-hidden="true"
            fill={actions.isFavorite ? 'currentColor' : 'none'}
            style={{ color: actions.isFavorite ? 'var(--danger)' : undefined }}
          />
          <span className="text-truncate">{actions.isFavorite ? 'Убрать из избранного' : 'В избранное'}</span>
        </button>

        <button
          type="button"
          role="menuitem"
          className="menu-item-hover"
          onClick={(e) => void actions.handleShare(e)}
          data-testid={`menu-share-${track.id}`}
        >
          <Share2 size={ICON.md} aria-hidden="true" />
          <span className="text-truncate">Поделиться</span>
        </button>

        {track.sourceUrl && (
          <button type="button" role="menuitem" className="menu-item-hover" onClick={actions.handleOpenSource}>
            <ExternalLink size={ICON.md} aria-hidden="true" />
            <span className="text-truncate">Открыть в {actions.sourceLabel}</span>
          </button>
        )}

        <hr className="divider" style={{ margin: 'var(--space-1) 0' }} />
        <button
          type="button"
          role="menuitem"
          className="menu-item-hover"
          onClick={actions.handleOpenPlaylistPicker}
          data-testid={`menu-add-to-playlist-${track.id}`}
        >
          <Plus size={ICON.md} aria-hidden="true" />
          <span className="text-truncate">Добавить в плейлист…</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="menu-item-hover"
          onClick={actions.handleOpenNotes}
          data-testid={`menu-notes-${track.id}`}
        >
          <Tag size={ICON.md} aria-hidden="true" />
          <span className="text-truncate">Теги и заметка…</span>
        </button>
        {/*
          * Вход в выбор пачкой отсюда же: найдя нужный трек, человек не
          * должен закрывать его меню и искать этот же трек заново уже в
          * режиме выбора. Отмечается сразу тот, из которого позвали.
          */}
        <button
          type="button"
          role="menuitem"
          className="menu-item-hover"
          onClick={actions.handleStartSelection}
          data-testid={`menu-select-${track.id}`}
        >
          <CheckSquare size={ICON.md} aria-hidden="true" />
          <span className="text-truncate">Выбрать несколько</span>
        </button>
      </div>,
      document.body
    )}

    {/* Окно выбора плейлиста. Живёт рядом с меню, потому что открывается
        только отсюда, а само рисуется поверх всего. */}
    {playlistPickerElement}
  </div>
);
