import React, { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, MoreVertical, Music2, Pencil, Play, Share2, Shuffle, Trash2 } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { ICON } from '../../styles/icons';
import { pluralize } from '../../utils/plural';
import { exportPlaylist, EXPORT_FORMAT_LABELS, type ExportFormat } from '../../services/playlistTransfer';
import { saveTextFile } from '../../utils/download';
import { Sheet, SheetRow } from './Sheet';
import { TrackRow } from './TrackRow';

/**
 * Плейлист на телефоне.
 *
 * Настольный экран нёс переименование карандашом рядом с заголовком, удаление,
 * экспорт и по две кнопки-стрелки в каждой строке для перестановки треков.
 * Стрелки на телефоне — самый спорный из этих органов: чтобы поднять трек на
 * десять позиций, в них надо попасть десять раз подряд, а ширины они отнимают
 * столько же, сколько кнопка действий. Перестановка сюда вернётся жестом
 * перетаскивания, когда до него дойдут руки; пока строка отдаёт свою ширину
 * названию, а редкие действия над самим плейлистом собраны в лист.
 */
export const MobilePlaylistView: React.FC = () => {
  const activePlaylistId = useUIStore((s) => s.activePlaylistId);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActivePlaylistId = useUIStore((s) => s.setActivePlaylistId);
  const showToast = useUIStore((s) => s.showToast);
  const openTrackActions = useUIStore((s) => s.openTrackActions);

  const playlists = useLibraryStore((s) => s.playlists);
  const deletePlaylist = useLibraryStore((s) => s.deletePlaylist);
  const renamePlaylist = useLibraryStore((s) => s.renamePlaylist);

  const playTrack = usePlayerStore((s) => s.playTrack);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

  const [isMenuOpen, setMenuOpen] = useState(false);
  const [isRenaming, setRenaming] = useState(false);
  const [isExportOpen, setExportOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');

  const playlist = useMemo(
    () => playlists.find((item) => item.id === activePlaylistId) ?? null,
    [activePlaylistId, playlists]
  );
  const tracks = playlist?.tracks ?? [];

  const back = useCallback(() => {
    setActivePlaylistId(null);
    setActiveView('playlists');
  }, [setActiveView, setActivePlaylistId]);

  const handleRename = useCallback(async () => {
    if (!playlist) return;
    const trimmed = draftTitle.trim();
    if (!trimmed || trimmed === playlist.title) {
      setRenaming(false);
      return;
    }
    const ok = await renamePlaylist(playlist.id, trimmed);
    showToast(ok ? 'Название изменено' : 'Переименовать не удалось', ok ? 'success' : 'error');
    setRenaming(false);
  }, [draftTitle, playlist, renamePlaylist, showToast]);

  /*
   * Выгрузка плейлиста файлом. На ПК это было с самого начала, на телефоне —
   * нет: экран плейлиста показывал только воспроизведение. Форматы те же три,
   * что и на ПК, чтобы файл, вынесенный с телефона, открывался на компьютере.
   */
  const handleExport = useCallback(
    async (format: ExportFormat) => {
      if (!playlist) return;
      setExportOpen(false);
      if (playlist.tracks.length === 0) {
        showToast('В плейлисте нет треков — выносить нечего', 'info');
        return;
      }
      try {
        const file = exportPlaylist(playlist, format);
        const result = await saveTextFile(file.filename, file.mimeType, file.content);
        if (!result.ok) {
          showToast(result.detail || 'Сохранить файл не получилось', 'error');
          return;
        }
        // Сообщение зависит от того, что реально произошло: на телефоне файл
        // уходит в «Документы» и в лист «поделиться», а не в «Загрузки».
        showToast(
          result.where === 'shared'
            ? `${file.filename} готов к отправке`
            : `${file.filename} — в «Документах» устройства`,
          'success'
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Выгрузить не удалось', 'error');
      }
    },
    [playlist, showToast]
  );

  const handleDelete = useCallback(async () => {
    if (!playlist) return;
    const ok = await deletePlaylist(playlist.id);
    if (!ok) {
      showToast('Удалить не удалось', 'error');
      return;
    }
    showToast(`«${playlist.title}» удалён`, 'info');
    setMenuOpen(false);
    back();
  }, [back, deletePlaylist, playlist, showToast]);

  if (!playlist) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <BackRow onBack={back} />
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          Плейлист не найден — возможно, он был удалён.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }} data-testid="mobile-playlist">
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <BackRow onBack={back} />
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="press focus-ring"
          onClick={() => setMenuOpen(true)}
          aria-label={`Действия с плейлистом «${playlist.title}»`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '44px',
            height: '44px',
            flexShrink: 0,
            borderRadius: 'var(--radius-pill)',
            color: 'var(--text-secondary)',
            cursor: 'pointer'
          }}
          data-testid="mobile-playlist-menu"
        >
          <MoreVertical size={ICON.lg} aria-hidden="true" />
        </button>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '96px',
            height: '96px',
            flexShrink: 0,
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-sunken)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-faint)'
          }}
        >
          <Music2 size={ICON.display} aria-hidden="true" />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 'var(--space-1)' }}>
          <h1
            style={{
              margin: 0,
              fontSize: 'var(--text-xl)',
              lineHeight: 'var(--leading-xl)',
              letterSpacing: 'var(--tracking-xl)',
              fontWeight: 'var(--weight-bold)',
              color: 'var(--text-primary)',
              overflowWrap: 'break-word'
            }}
            data-testid="mobile-playlist-title"
          >
            {playlist.title}
          </h1>
          <span
            style={{
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              color: 'var(--text-muted)'
            }}
          >
            {pluralize(tracks.length, 'трек', 'трека', 'треков')}
          </span>
        </div>
      </div>

      {tracks.length > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <ActionButton
            icon={<Play size={ICON.md} fill="currentColor" aria-hidden="true" />}
            label="Слушать"
            onClick={() => void playTrack(tracks[0], tracks, 0)}
            testId="mobile-playlist-play"
          />
          <ActionButton
            icon={<Shuffle size={ICON.md} aria-hidden="true" />}
            label="Вперемешку"
            onClick={() => {
              toggleShuffle();
              void playTrack(tracks[0], tracks, 0);
            }}
            testId="mobile-playlist-shuffle"
          />
        </div>
      )}

      {tracks.length === 0 ? (
        <p
          style={{
            margin: 0,
            padding: 'var(--space-5) 0',
            fontSize: 'var(--text-sm)',
            lineHeight: 'var(--leading-sm)',
            color: 'var(--text-muted)'
          }}
          data-testid="mobile-playlist-empty"
        >
          Плейлист пуст. Треки добавляются из листа действий — нажмите на песню и подержите.
        </p>
      ) : (
        <div>
          {tracks.map((track, index) => (
            <TrackRow
              key={`${track.id}-${index}`}
              track={track}
              isCurrent={currentTrack?.id === track.id}
              onPlay={() => void playTrack(track, tracks, index)}
              onOpenActions={() => openTrackActions(track)}
              data-testid={`mobile-playlist-track-${track.id}`}
            />
          ))}
        </div>
      )}

      <Sheet
        isOpen={isMenuOpen && !isRenaming && !isExportOpen}
        onClose={() => setMenuOpen(false)}
        title={playlist.title}
        data-testid="mobile-playlist-sheet"
      >
        <SheetRow
          icon={<Pencil size={ICON.lg} aria-hidden="true" />}
          label="Переименовать"
          onClick={() => {
            setDraftTitle(playlist.title);
            setRenaming(true);
          }}
          data-testid="mobile-playlist-rename"
        />
        <SheetRow
          icon={<Share2 size={ICON.lg} aria-hidden="true" />}
          label="Выгрузить файлом"
          hint="Чтобы открыть на другом устройстве"
          onClick={() => setExportOpen(true)}
          data-testid="mobile-playlist-export"
        />
        <SheetRow
          icon={<Trash2 size={ICON.lg} aria-hidden="true" />}
          label="Удалить плейлист"
          hint="Треки останутся в медиатеке"
          danger
          onClick={() => void handleDelete()}
          data-testid="mobile-playlist-delete"
        />
      </Sheet>

      <Sheet
        isOpen={isExportOpen}
        onClose={() => setExportOpen(false)}
        title="В каком виде выгрузить"
        data-testid="mobile-playlist-export-sheet"
      >
        {(['wireon', 'm3u8', 'csv'] as ExportFormat[]).map((format) => (
          <SheetRow
            key={format}
            icon={<Share2 size={ICON.lg} aria-hidden="true" />}
            label={EXPORT_FORMAT_LABELS[format]}
            onClick={() => void handleExport(format)}
            data-testid={`mobile-playlist-export-${format}`}
          />
        ))}
      </Sheet>

      <Sheet
        isOpen={isRenaming}
        onClose={() => setRenaming(false)}
        title="Новое название"
        data-testid="mobile-playlist-rename-sheet"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: '0 var(--space-4)' }}>
          <input
            autoFocus
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleRename();
            }}
            aria-label="Название плейлиста"
            style={{
              minHeight: '48px',
              padding: '0 var(--space-3)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              fontSize: 'var(--text-base)'
            }}
            data-testid="mobile-playlist-rename-input"
          />
          <ActionButton
            icon={null}
            label="Сохранить"
            onClick={() => void handleRename()}
            testId="mobile-playlist-rename-save"
          />
        </div>
      </Sheet>
    </div>
  );
};

const BackRow: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <button
    type="button"
    className="press focus-ring"
    onClick={onBack}
    aria-label="Назад"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '44px',
      height: '44px',
      flexShrink: 0,
      marginLeft: 'calc(var(--space-3) * -1)',
      borderRadius: 'var(--radius-pill)',
      color: 'var(--text-secondary)',
      cursor: 'pointer'
    }}
    data-testid="mobile-playlist-back"
  >
    <ChevronLeft size={ICON.xl} aria-hidden="true" />
  </button>
);

const ActionButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  testId: string;
}> = ({ icon, label, onClick, testId }) => (
  <button
    type="button"
    className="press"
    onClick={onClick}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 'var(--space-2)',
      flex: 1,
      minHeight: '44px',
      borderRadius: 'var(--radius-pill)',
      border: '1px solid var(--border)',
      color: 'var(--text-primary)',
      fontSize: 'var(--text-sm)',
      lineHeight: 'var(--leading-sm)',
      letterSpacing: 'var(--tracking-sm)',
      cursor: 'pointer'
    }}
    data-testid={testId}
  >
    {icon}
    {label}
  </button>
);
