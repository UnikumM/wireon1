import React from 'react';
import { ArrowLeft, Folder, Pencil, Trash2 } from 'lucide-react';
import type { Playlist } from '../../types/music';
import type { FolderGroup, PlaylistFolder } from '../../store/useFolderStore';
import { Button } from '../common/Button';
import { PlaylistCover } from './PlaylistCover';
import { pluralize } from '../../utils/plural';
import { ICON } from '../../styles/icons';

export interface FolderShelfProps {
  groups: FolderGroup<Playlist>[];
  /** Открытая папка. Состояние держит родитель — ему же решать, что показывать в сетке. */
  openFolderId: string | null;
  onOpen: (folderId: string) => void;
  onBack: () => void;
  onRename: (folder: PlaylistFolder) => void;
  onDelete: (folder: PlaylistFolder) => void;
  /**
   * Телефон: карточки в один ряд с прокруткой вбок, а не сеткой. Сетка из
   * карточек по 160 px на 360 px даёт две в ряд и второй этаж до первого
   * плейлиста — а полка прокручивается и занимает один.
   */
  compact?: boolean;
}

/**
 * Ряд папок над плейлистами — или шапка открытой папки, когда одна выбрана.
 *
 * Один компонент на обе оболочки: логика «ряд ↔ открытая папка» общая, разница
 * только в раскладке карточек, и её закрывает `compact`.
 */
export const FolderShelf: React.FC<FolderShelfProps> = ({
  groups,
  openFolderId,
  onOpen,
  onBack,
  onRename,
  onDelete,
  compact = false
}) => {
  const open = openFolderId ? groups.find((g) => g.folder.id === openFolderId) ?? null : null;

  if (openFolderId && open) {
    return (
      <div className="row wrap gap-2" data-testid="folder-header">
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft size={ICON.md} aria-hidden="true" />}
          onClick={onBack}
          data-testid="folder-back-btn"
        >
          Все плейлисты
        </Button>
        <h2 className="m-0 grow text-truncate text-primary type-xl" data-testid="folder-title">
          {open.folder.title}
        </h2>
        <div className="row gap-1 shrink-0">
          <Button
            variant="icon"
            size="icon"
            onClick={() => onRename(open.folder)}
            aria-label="Переименовать папку"
            title="Переименовать папку"
            data-testid="folder-rename-btn"
          >
            <Pencil size={ICON.md} />
          </Button>
          <Button
            variant="icon"
            size="icon"
            onClick={() => onDelete(open.folder)}
            aria-label="Удалить папку"
            title="Удалить папку"
            data-testid="folder-delete-btn"
          >
            <Trash2 size={ICON.md} />
          </Button>
        </div>
      </div>
    );
  }

  if (groups.length === 0) return null;

  return (
    <div
      className={compact ? 'folder-shelf-compact scroll-x-quiet' : 'folder-shelf'}
      data-testid="folder-shelf"
    >
      {groups.map(({ folder, playlists }) => (
        <FolderCard key={folder.id} folder={folder} playlists={playlists} onOpen={() => onOpen(folder.id)} />
      ))}
    </div>
  );
};

const FolderCard: React.FC<{ folder: PlaylistFolder; playlists: Playlist[]; onOpen: () => void }> = ({
  folder,
  playlists,
  onOpen
}) => {
  // Четыре ячейки всегда: папка из одного плейлиста выглядит так же, как из
  // десяти, — иначе ряд из карточек разной формы читается как разные вещи.
  const slots = Array.from({ length: 4 }, (_, i) => playlists[i] ?? null);
  return (
    <button
      type="button"
      className="folder-card card-interactive card-reset focus-ring"
      onClick={onOpen}
      aria-label={`Папка «${folder.title}» — ${pluralize(playlists.length, 'плейлист', 'плейлиста', 'плейлистов')}`}
      data-testid={`folder-card-${folder.id}`}
    >
      <span className="folder-card-art" aria-hidden="true">
        {slots.map((playlist, i) =>
          playlist ? (
            <PlaylistCover
              key={playlist.id}
              tracks={playlist.tracks}
              coverUrl={playlist.coverUrl}
              size="100%"
              radius="var(--radius-sm)"
            />
          ) : (
            <span key={`empty-${i}`} className="folder-card-slot row justify-center">
              {i === 0 && <Folder size={ICON.lg} className="text-faint" />}
            </span>
          )
        )}
      </span>
      <span className="folder-card-title text-truncate">{folder.title}</span>
      <span className="folder-card-count text-truncate">
        {pluralize(playlists.length, 'плейлист', 'плейлиста', 'плейлистов')}
      </span>
    </button>
  );
};
