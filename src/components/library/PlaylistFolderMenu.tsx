import React from 'react';
import { createPortal } from 'react-dom';
import { Check, Folder, FolderMinus, MoreHorizontal } from 'lucide-react';
import type { PlaylistFolder } from '../../store/useFolderStore';
import { useTrackMenu } from '../search/trackCard/useTrackMenu';
import { ICON } from '../../styles/icons';

export interface PlaylistFolderMenuProps {
  playlistId: string;
  playlistTitle: string;
  folders: PlaylistFolder[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
}

/**
 * Кнопка «…» на карточке плейлиста и меню «В папку…».
 *
 * Тот же приём, что у меню трека: панель в портале, место считается от кнопки,
 * закрытие по клику мимо, Escape и прокрутке — всё это уже умеет `useTrackMenu`,
 * и второй экземпляр той же логики здесь был бы лишним.
 */
export const PlaylistFolderMenu: React.FC<PlaylistFolderMenuProps> = ({
  playlistId,
  playlistTitle,
  folders,
  currentFolderId,
  onMove
}) => {
  const menu = useTrackMenu();

  const choose = (folderId: string | null) => {
    menu.close();
    if (folderId !== currentFolderId) onMove(folderId);
  };

  return (
    <div className="relative" ref={menu.rootRef}>
      <button
        type="button"
        ref={menu.triggerRef}
        className="press focus-ring p-1 text-secondary pointer radius-sm"
        onClick={(e) => {
          e.stopPropagation();
          menu.toggle();
        }}
        aria-label={`Папка для «${playlistTitle}»`}
        title="В папку…"
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        data-testid={`playlist-folder-btn-${playlistId}`}
      >
        <MoreHorizontal size={ICON.sm} />
      </button>

      {menu.isOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menu.panelRef}
            className="panel-raised animate-drop-in scrollbar-thin folder-menu"
            role="menu"
            aria-label={`В какую папку положить «${playlistTitle}»`}
            onKeyDown={menu.onKeyDown}
            onClick={(e) => e.stopPropagation()}
            style={
              {
                // Положение — из замера кнопки, ему нет места в таблице стилей.
                '--pop-origin': menu.position?.origin ?? 'top right',
                top: menu.position ? `${menu.position.top}px` : 0,
                left: menu.position ? `${menu.position.left}px` : 0,
                visibility: menu.position ? 'visible' : 'hidden'
              } as React.CSSProperties
            }
            data-testid={`playlist-folder-menu-${playlistId}`}
          >
            <p className="m-0 px-3 py-1 text-xs text-muted leading-xs">В папку…</p>
            {folders.map((folder, index) => (
              <button
                key={folder.id}
                type="button"
                role="menuitem"
                autoFocus={index === 0}
                className="menu-item-hover"
                data-active={folder.id === currentFolderId || undefined}
                onClick={() => choose(folder.id)}
                data-testid={`playlist-folder-option-${folder.id}`}
              >
                <Folder size={ICON.md} aria-hidden="true" />
                <span className="text-truncate grow">{folder.title}</span>
                {folder.id === currentFolderId && <Check size={ICON.md} aria-hidden="true" className="text-accent" />}
              </button>
            ))}
            <hr className="divider mt-1 mb-1" />
            <button
              type="button"
              role="menuitem"
              className="menu-item-hover"
              data-active={currentFolderId === null || undefined}
              onClick={() => choose(null)}
              data-testid={`playlist-folder-option-none`}
            >
              <FolderMinus size={ICON.md} aria-hidden="true" />
              <span className="text-truncate grow">Без папки</span>
              {currentFolderId === null && <Check size={ICON.md} aria-hidden="true" className="text-accent" />}
            </button>
          </div>,
          document.body
        )}
    </div>
  );
};
