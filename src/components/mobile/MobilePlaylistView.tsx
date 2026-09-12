import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  CheckSquare,
  Download,
  ListPlus,
  MoreVertical,
  Pencil,
  Play,
  Share2,
  Shuffle,
  Trash2,
  X
} from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { refusedForAccount, useUIStore } from '../../store/useUIStore';
import { ICON } from '../../styles/icons';
import { pluralize } from '../../utils/plural';
import { exportPlaylist, EXPORT_FORMAT_LABELS, type ExportFormat } from '../../services/playlistTransfer';
import { saveTextFile } from '../../utils/download';
import { Sheet, SheetRow } from './Sheet';
import { TrackRow } from './TrackRow';
import { TrackSelectionBar } from './TrackSelectionBar';
import { offlineMode } from '../../services/offlineMode';
import { prepareCoverImage } from '../../services/playlistCover';
import { PlaylistCover } from '../library/PlaylistCover';

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
  /*
   * Выбор живёт в сторе, а не здесь: режим включается ещё и из меню самого
   * трека, а меню лежит отдельным слоем и до состояния экрана не дотягивается.
   */
  const selectedIds = useUIStore((s) => s.selectedTrackIds);
  const startSelection = useUIStore((s) => s.startSelection);
  const toggleSelected = useUIStore((s) => s.toggleSelected);
  const clearSelection = useUIStore((s) => s.clearSelection);

  const playlists = useLibraryStore((s) => s.playlists);
  const deletePlaylist = useLibraryStore((s) => s.deletePlaylist);
  const renamePlaylist = useLibraryStore((s) => s.renamePlaylist);
  const addTrackToPlaylist = useLibraryStore((s) => s.addTrackToPlaylist);
  const setPlaylistCover = useLibraryStore((s) => s.setPlaylistCover);
  const removeTrackFromPlaylist = useLibraryStore((s) => s.removeTrackFromPlaylist);

  const playTrack = usePlayerStore((s) => s.playTrack);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

  const [isMenuOpen, setMenuOpen] = useState(false);
  const [isRenaming, setRenaming] = useState(false);
  const [isExportOpen, setExportOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [isMoveOpen, setMoveOpen] = useState(false);

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

  const coverInputRef = useRef<HTMLInputElement>(null);

  const handleCoverPicked = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Ввод сбрасывается сразу: иначе повторный выбор того же файла не
      // поднимет событие вовсе, и человек решит, что кнопка сломалась.
      event.target.value = '';
      if (!file || !playlist) return;

      try {
        const dataUrl = await prepareCoverImage(file);
        const ok = await setPlaylistCover(playlist.id, dataUrl);
        showToast(ok ? 'Обложка обновлена' : 'Не удалось сменить обложку', ok ? 'success' : 'error');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Не удалось прочитать картинку', 'error');
      }
    },
    [playlist, setPlaylistCover, showToast]
  );

  const handleClearCover = useCallback(async () => {
    if (!playlist) return;
    if (await setPlaylistCover(playlist.id, null)) {
      showToast('Вернулась мозаика из обложек треков', 'info');
    }
  }, [playlist, setPlaylistCover, showToast]);

  const selected = useMemo(
    () => (selectedIds === null ? null : new Set(selectedIds)),
    [selectedIds]
  );

  const selectedTracks = useMemo(
    () => (selected ? tracks.filter((track) => selected.has(track.id)) : []),
    [selected, tracks]
  );

  const handleSaveSelected = useCallback(async () => {
    const list = selectedTracks;
    if (list.length === 0) return;
    const added = await offlineMode.queueTracks(list).catch(() => 0);
    showToast(
      added > 0
        ? `${pluralize(added, 'трек', 'трека', 'треков')} в очереди на сохранение`
        : 'Всё выбранное уже сохранено',
      added > 0 ? 'success' : 'info'
    );
    clearSelection();
  }, [selectedTracks, showToast]);

  /**
   * Убирает выбранное из плейлиста.
   *
   * Идём с конца: удаление сдвигает всё, что после него, и при проходе сверху
   * вниз второй же номер указывал бы уже не на тот трек.
   */
  const handleRemoveSelected = useCallback(async () => {
    if (!playlist || !selected || selected.size === 0) return;
    const doomed = tracks
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => selected.has(track.id))
      .map(({ index }) => index)
      .reverse();

    let removed = 0;
    for (const index of doomed) {
      if (await removeTrackFromPlaylist(playlist.id, index)) removed += 1;
    }

    if (removed === 0) {
      if (!refusedForAccount()) showToast('Не удалось убрать треки', 'error');
      return;
    }

    showToast(`Убрано ${pluralize(removed, 'трек', 'трека', 'треков')}`, 'success');
    clearSelection();
  }, [clearSelection, playlist, removeTrackFromPlaylist, selected, showToast, tracks]);

  const handleMoveSelected = useCallback(
    async (targetId: string) => {
      const list = selectedTracks;
      if (list.length === 0) return;

      /*
       * Считаем удачи, а не длину списка.
       *
       * `addTrackToPlaylist` возвращает `false`, когда пополнять плейлисты
       * нельзя — например, человек слушает без аккаунта. Отчёт по длине списка
       * означал бы «перенесено пять треков» ровно там, где не перенёсся ни
       * один, и искать их человек пошёл бы в другой плейлист.
       */
      let moved = 0;
      for (const track of list) {
        if (await addTrackToPlaylist(targetId, track)) moved += 1;
      }

      setMoveOpen(false);
      if (moved === 0) {
        // Причину уже назвал стор: без аккаунта на экране стоит приглашение
        // войти, и вторая красная надпись теми же секундами — это два разных
        // ответа на одно нажатие.
        if (!refusedForAccount()) showToast('Не удалось перенести треки', 'error');
        return;
      }

      const target = playlists.find((item) => item.id === targetId);
      showToast(
        `${pluralize(moved, 'трек', 'трека', 'треков')} в «${target?.title ?? 'плейлист'}»`,
        'success'
      );
      clearSelection();
    },
    [addTrackToPlaylist, clearSelection, playlists, selectedTracks, showToast]
  );

  const handleSavePlaylist = useCallback(async () => {
    if (tracks.length === 0) return;
    setMenuOpen(false);
    const added = await offlineMode.queueTracks(tracks).catch(() => 0);
    showToast(
      added > 0
        ? `${pluralize(added, 'трек', 'трека', 'треков')} в очереди на сохранение`
        : 'Плейлист уже сохранён целиком',
      added > 0 ? 'success' : 'info'
    );
  }, [showToast, tracks]);

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
        {/*
          * Обложка — она же кнопка выбора картинки, как на большом экране:
          * нажимают на то, что меняют. Отдельной кнопки рядом нет, на телефоне
          * ей и места бы не нашлось.
          */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            className="cover-button focus-ring"
            onClick={() => coverInputRef.current?.click()}
            aria-label={playlist.coverUrl ? 'Сменить обложку плейлиста' : 'Поставить обложку плейлиста'}
            data-testid="mobile-playlist-cover-btn"
          >
            <PlaylistCover
              tracks={tracks}
              coverUrl={playlist.coverUrl}
              size={96}
              radius="var(--radius-md)"
            />
          </button>

          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => void handleCoverPicked(event)}
            data-testid="mobile-playlist-cover-input"
          />

          {playlist.coverUrl && (
            <button
              type="button"
              className="cover-clear press focus-ring"
              onClick={() => void handleClearCover()}
              aria-label="Убрать свою обложку"
              data-testid="mobile-playlist-cover-clear"
            >
              <X size={ICON.sm} aria-hidden="true" />
            </button>
          )}
        </div>
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

      {tracks.length > 0 && selected === null && (
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

      {/* Панель выбора — общая для всех списков телефона. */}
      <TrackSelectionBar
        total={tracks.length}
        allIds={tracks.map((track) => track.id)}
        testId="mobile-playlist-selection"
        actions={[
          {
            icon: <ListPlus size={ICON.md} aria-hidden="true" />,
            label: 'В плейлист',
            onClick: () => setMoveOpen(true),
            testId: 'mobile-playlist-selection-move'
          },
          {
            icon: <Download size={ICON.md} aria-hidden="true" />,
            label: 'Скачать',
            onClick: () => void handleSaveSelected(),
            testId: 'mobile-playlist-selection-save'
          },
          {
            icon: <Trash2 size={ICON.md} aria-hidden="true" />,
            label: 'Убрать',
            onClick: () => void handleRemoveSelected(),
            testId: 'mobile-playlist-selection-remove'
          }
        ]}
      />

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
              isSelectable={selected !== null}
              isSelected={selected?.has(track.id) ?? false}
              onToggleSelect={() => toggleSelected(track.id)}
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
          icon={<CheckSquare size={ICON.lg} aria-hidden="true" />}
          label="Выбрать треки"
          hint="Чтобы перенести, скачать или убрать сразу несколько"
          onClick={() => {
            startSelection();
            setMenuOpen(false);
          }}
          data-testid="mobile-playlist-select-mode"
        />
        <SheetRow
          icon={<Download size={ICON.lg} aria-hidden="true" />}
          label="Скачать плейлист"
          hint="Слушать без сети"
          onClick={() => void handleSavePlaylist()}
          data-testid="mobile-playlist-save-offline"
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
        isOpen={isMoveOpen}
        onClose={() => setMoveOpen(false)}
        title={`В какой плейлист — ${selectedTracks.length}`}
        data-testid="mobile-playlist-move-sheet"
      >
        {playlists.filter((item) => item.id !== playlist.id).length === 0 ? (
          <p
            style={{
              margin: 0,
              padding: 'var(--space-4)',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)'
            }}
            data-testid="mobile-playlist-move-empty"
          >
            Других плейлистов пока нет. Создайте его в медиатеке.
          </p>
        ) : (
          playlists
            .filter((item) => item.id !== playlist.id)
            .map((item) => (
              <SheetRow
                key={item.id}
                icon={<ListPlus size={ICON.lg} aria-hidden="true" />}
                label={item.title}
                hint={pluralize(item.tracks.length, 'трек', 'трека', 'треков')}
                onClick={() => void handleMoveSelected(item.id)}
                data-testid={`mobile-playlist-move-${item.id}`}
              />
            ))
        )}
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
  /**
   * Значок над подписью вместо значка слева.
   *
   * Нужно там, где кнопок в строке три. Замерено на устройстве 360 px: при
   * значке слева каждой кнопке достаётся 95 px, из которых подписи остаётся
   * около сорока, и «В плейлист» (81 px) переносилось на вторую строку — ряд
   * получался рваным. Столбиком подпись получает всю ширину кнопки.
   */
  stacked?: boolean;
}> = ({ icon, label, onClick, testId, stacked = false }) => (
  <button
    type="button"
    className="press"
    onClick={onClick}
    style={{
      display: 'flex',
      flexDirection: stacked ? 'column' : 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: stacked ? '2px' : 'var(--space-2)',
      flex: 1,
      minWidth: 0,
      minHeight: '44px',
      padding: stacked ? 'var(--space-2) var(--space-1)' : undefined,
      borderRadius: stacked ? 'var(--radius-md)' : 'var(--radius-pill)',
      border: '1px solid var(--border)',
      color: 'var(--text-primary)',
      fontSize: 'var(--text-sm)',
      lineHeight: 'var(--leading-sm)',
      letterSpacing: 'var(--tracking-sm)',
      whiteSpace: 'nowrap',
      cursor: 'pointer'
    }}
    data-testid={testId}
  >
    {icon}
    {label}
  </button>
);
