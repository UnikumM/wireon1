import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Play,
  Shuffle,
  Trash2,
  Edit2,
  Check,
  X,
  Plus,
  ArrowUp,
  ArrowDown,
  Sparkles,
  Download,
  ListPlus,
  CheckSquare,
  Search,
  CopyX,
  Save,
  Pin,
  PinOff
} from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { usePlayerStore, isQueueOfTracks } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { Button } from '../common/Button';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { EmptyState } from '../common/EmptyState';
import { TrackCard } from '../search/TrackCard';
import { PlaylistCover } from './PlaylistCover';
import { PlaylistExportMenu } from './PlaylistExportMenu';
import { SelectionBar } from '../common/SelectionBar';
import { useAddToPlaylist } from './AddToPlaylistModal';
import { offlineMode } from '../../services/offlineMode';
import { SaveOfflineButton } from './SaveOfflineButton';
import { describeTrackTotals } from './trackSummary';
import { prepareCoverImage } from '../../services/playlistCover';
import { useVirtualRows, TRACK_ROW_PITCH } from '../../hooks/useVirtualRows';
import { ICON } from '../../styles/icons';
import {
  PLAYLIST_SORT_LABELS,
  PlaylistSortKey,
  countDuplicates,
  viewEntries
} from '../../services/playlistTools';
import { pluralize } from '../../utils/plural';
import { usePinnedStore, MAX_PINNED } from '../../store/usePinnedStore';

export interface PlaylistViewProps {
  playlistId?: string;
  className?: string;
}

const rowButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '28px',
  height: '28px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer'
};

export const PlaylistView: React.FC<PlaylistViewProps> = ({ playlistId: propPlaylistId, className = '' }) => {
  const activePlaylistId = useUIStore((s) => s.activePlaylistId);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const showToast = useUIStore((s) => s.showToast);

  const playlists = useLibraryStore((s) => s.playlists);
  const deletePlaylist = useLibraryStore((s) => s.deletePlaylist);
  const renamePlaylist = useLibraryStore((s) => s.renamePlaylist);
  const setPlaylistCover = useLibraryStore((s) => s.setPlaylistCover);
  const selectedTrackIds = useUIStore((s) => s.selectedTrackIds);
  const startSelection = useUIStore((s) => s.startSelection);
  const picker = useAddToPlaylist();
  const clearSelection = useUIStore((s) => s.clearSelection);
  const removeTrackFromPlaylist = useLibraryStore((s) => s.removeTrackFromPlaylist);
  const reorderPlaylistTracks = useLibraryStore((s) => s.reorderPlaylistTracks);
  const removeDuplicatesFromPlaylist = useLibraryStore((s) => s.removeDuplicatesFromPlaylist);
  const pinnedIds = usePinnedStore((s) => s.pinnedIds);
  const togglePin = usePinnedStore((s) => s.toggle);
  const setPlaylistTracks = useLibraryStore((s) => s.setPlaylistTracks);

  const playTrack = usePlayerStore((s) => s.playTrack);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const smartShuffle = usePlayerStore((s) => s.smartShuffle);
  const syncSourceQueue = usePlayerStore((s) => s.syncSourceQueue);

  const targetId = propPlaylistId || activePlaylistId;
  const playlist = playlists.find((p) => p.id === targetId);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<{ index: number; title: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const tracks = playlist?.tracks ?? [];
  const isPinned = playlist ? pinnedIds.includes(playlist.id) : false;
  const totals = useMemo(() => describeTrackTotals(tracks), [tracks]);

  /*
   * Поиск и сортировка внутри плейлиста — вид, а не правка (см. playlistTools).
   * Пока вид отличается от своего порядка, стрелки переноса спрятаны: «выше»
   * в отсортированном списке значило бы не то, что видно.
   */
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<PlaylistSortKey>('custom');
  const entries = useMemo(() => viewEntries(tracks, query, sortKey), [tracks, query, sortKey]);
  const viewTracks = useMemo(() => entries.map((entry) => entry.track), [entries]);
  const isCustomView = sortKey === 'custom' && query.trim() === '';
  const duplicates = useMemo(() => countDuplicates(tracks), [tracks]);

  // Импортированный плейлист легко бывает на тысячу треков — держим в DOM
  // только видимое.
  const virtual = useVirtualRows({
    itemCount: entries.length,
    rowPitch: TRACK_ROW_PITCH,
    containerRef: listRef
  });

  /**
   * Every library mutation resolves `false` instead of rejecting, so the result
   * is checked rather than caught, and the live queue is reconciled from the
   * store's copy of the playlist — not from the pre-edit array in this closure.
   */
  const afterMutation = useCallback(
    (playlistId: string) => {
      const updated = useLibraryStore.getState().playlists.find((p) => p.id === playlistId);
      // `tracks` здесь — состав до правки: с ним и сверяем, играет ли этот плейлист.
      if (updated && isQueueOfTracks(usePlayerStore.getState().sourceQueue, tracks)) {
        syncSourceQueue(updated.tracks);
      }
    },
    [syncSourceQueue, tracks]
  );

  const handleReorder = useCallback(
    async (from: number, to: number, focusTestId?: string) => {
      if (!playlist) return;
      if (to < 0 || to >= playlist.tracks.length || from === to) return;

      const ok = await reorderPlaylistTracks(playlist.id, from, to);
      if (!ok) {
        showToast('Не удалось изменить порядок треков', 'error');
        return;
      }
      afterMutation(playlist.id);

      // The moved row is re-keyed by index, so focus follows the track.
      if (focusTestId) {
        requestAnimationFrame(() => {
          listRef.current?.querySelector<HTMLButtonElement>(`[data-testid="${focusTestId}"]`)?.focus();
        });
      }
    },
    [afterMutation, playlist, reorderPlaylistTracks, showToast]
  );

  const [isMixing, setIsMixing] = useState(false);

  const handleSmartShuffle = useCallback(async () => {
    if (tracks.length === 0 || isMixing) return;
    setIsMixing(true);
    try {
      await smartShuffle(tracks);
      showToast('Перемешано и дополнено похожим', 'success');
    } finally {
      setIsMixing(false);
    }
  }, [isMixing, showToast, smartShuffle, tracks]);

  const selectedTracks = useMemo(
    () => (selectedTrackIds ? tracks.filter((t) => selectedTrackIds.includes(t.id)) : []),
    [selectedTrackIds, tracks]
  );

  const handleSaveSelected = useCallback(async () => {
    if (selectedTracks.length === 0) return;
    const added = await offlineMode.queueTracks(selectedTracks).catch(() => 0);
    showToast(
      added > 0 ? `${added} в очереди на сохранение` : 'Всё выбранное уже сохранено',
      added > 0 ? 'success' : 'info'
    );
    clearSelection();
  }, [clearSelection, selectedTracks, showToast]);

  /**
   * Убирает отмеченное. С конца: удаление сдвигает всё, что после него, и при
   * проходе сверху вниз второй же номер указывал бы уже не на тот трек.
   */
  const handleRemoveSelected = useCallback(async () => {
    if (!playlist || selectedTracks.length === 0) return;
    const doomed = tracks
      .map((track, i) => ({ track, i }))
      .filter(({ track }) => selectedTrackIds?.includes(track.id))
      .map(({ i }) => i)
      .reverse();

    let removed = 0;
    for (const i of doomed) {
      if (await removeTrackFromPlaylist(playlist.id, i)) removed += 1;
    }
    if (removed === 0) {
      showToast('Не удалось убрать треки', 'error');
      return;
    }
    // Очередь сверяется и здесь: без этого убранные треки продолжали играть
    // из уже запущенного плейлиста.
    afterMutation(playlist.id);
    showToast(`Убрано ${removed}`, 'success');
    clearSelection();
  }, [afterMutation, clearSelection, playlist, removeTrackFromPlaylist, selectedTrackIds, selectedTracks, showToast, tracks]);

  const handleRemoveDuplicates = useCallback(async () => {
    if (!playlist) return;
    const removed = await removeDuplicatesFromPlaylist(playlist.id);
    if (removed === null) {
      showToast('Не удалось убрать повторы', 'error');
      return;
    }
    afterMutation(playlist.id);
    showToast(removed > 0 ? `Убрано ${pluralize(removed, 'повтор', 'повтора', 'повторов')}` : 'Повторов нет', 'success');
  }, [afterMutation, playlist, removeDuplicatesFromPlaylist, showToast]);

  /** Отсортированный вид становится порядком плейлиста. */
  const handleKeepOrder = useCallback(async () => {
    if (!playlist || sortKey === 'custom' || query.trim() !== '') return;
    const ok = await setPlaylistTracks(playlist.id, viewTracks);
    if (!ok) {
      showToast('Не удалось сохранить порядок', 'error');
      return;
    }
    afterMutation(playlist.id);
    setSortKey('custom');
    showToast('Порядок сохранён', 'success');
  }, [afterMutation, playlist, query, setPlaylistTracks, showToast, sortKey, viewTracks]);

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
    const ok = await setPlaylistCover(playlist.id, null);
    if (ok) showToast('Вернулась мозаика из обложек треков', 'info');
  }, [playlist, setPlaylistCover, showToast]);

  const handleSaveRename = useCallback(async () => {
    if (!playlist) return;
    const trimmed = editedTitle.trim();
    if (!trimmed) {
      showToast('У плейлиста должно быть название', 'error');
      return;
    }
    const ok = await renamePlaylist(playlist.id, trimmed);
    if (!ok) {
      showToast('Не удалось переименовать плейлист', 'error');
      return;
    }
    setIsEditingTitle(false);
    showToast('Плейлист переименован', 'success');
  }, [editedTitle, playlist, renamePlaylist, showToast]);

  const handleConfirmDelete = useCallback(async () => {
    if (!playlist) return;
    const title = playlist.title;
    setIsConfirmingDelete(false);

    const ok = await deletePlaylist(playlist.id);
    if (!ok) {
      showToast('Не удалось удалить плейлист', 'error');
      return;
    }
    showToast(`Плейлист «${title}» удалён`, 'info');
    setActiveView('playlists');
  }, [deletePlaylist, playlist, setActiveView, showToast]);

  const handleConfirmRemoval = useCallback(async () => {
    if (!playlist || !pendingRemoval) return;
    const { index, title } = pendingRemoval;
    setPendingRemoval(null);

    const ok = await removeTrackFromPlaylist(playlist.id, index);
    if (!ok) {
      showToast('Не удалось убрать трек', 'error');
      return;
    }
    afterMutation(playlist.id);
    showToast(`«${title}» убран из плейлиста`, 'info');
  }, [afterMutation, pendingRemoval, playlist, removeTrackFromPlaylist, showToast]);

  // «Слушать» играет то, что видно: отсортированный по исполнителю плейлист —
  // по исполнителю, найденное — только найденное.
  const handlePlayAll = useCallback(() => {
    const list = isCustomView ? tracks : viewTracks;
    if (list.length === 0) return;
    if (usePlayerStore.getState().isShuffled) toggleShuffle();
    void playTrack(list[0], list, 0);
  }, [isCustomView, playTrack, toggleShuffle, tracks, viewTracks]);

  /** Shuffle is enabled first so the store builds its order once, then plays. */
  const handleShufflePlay = useCallback(() => {
    const list = isCustomView ? tracks : viewTracks;
    if (list.length === 0) return;
    if (!usePlayerStore.getState().isShuffled) toggleShuffle();
    const start = Math.floor(Math.random() * list.length);
    void playTrack(list[start], list, start);
  }, [isCustomView, playTrack, toggleShuffle, tracks, viewTracks]);

  /** Alt+↑/↓ moves the focused row — the keyboard equivalent of dragging it. */
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, index: number) => {
      if (!isCustomView) return;
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const to = event.key === 'ArrowUp' ? index - 1 : index + 1;
      if (to < 0 || to >= tracks.length) return;
      event.preventDefault();
      event.stopPropagation();
      void handleReorder(index, to);
    },
    [handleReorder, isCustomView, tracks.length]
  );

  if (!playlist) {
    /*
     * Подпись была такой: «Его удалили — или ссылка ведёт туда, где ничего никогда
     * не было». Красиво, но человеку в этот момент нужно знать, что делать, а не
     * читать оборот про несуществующее место. Причина названа коротко, дальше кнопка.
     */
    return (
      <EmptyState
        className="animate-view-in"
        art="playlists"
        title="Плейлист не найден"
        description="Скорее всего, он удалён."
        action={{ label: 'К плейлистам', onClick: () => setActiveView('playlists') }}
        data-testid="playlist-not-found"
      />
    );
  }

  return (
    <>
      <div
        className={`animate-view-in ${className} stack gap-5 w-full`}
        data-testid="playlist-view"
      >
        <header
          className="panel"
          style={{
            display: 'flex',
            alignItems: 'center',
            // Кнопок в шапке восемь: в одну строку с названием они не влезали
            // уже на 1280 px и сжимали название до «В…» (особенно в широких
            // гарнитурах «Бумаги» и «Дымки»). Теперь кнопки уходят вниз.
            flexWrap: 'wrap',
            gap: 'var(--space-5)',
            padding: 'var(--space-5)',
            borderRadius: 'var(--radius-lg)'
          }}
        >
          {/*
            * Обложка — она же кнопка выбора картинки.
            *
            * Отдельной кнопки рядом нет нарочно: нажимают на то, что меняют.
            * Ввод файла спрятан, но остаётся в разметке — только так системное
            * окно выбора открывается по нашему нажатию, а не по своему.
            */}
          <div className="relative shrink-0">
            <button
              type="button"
              className="cover-button focus-ring"
              onClick={() => coverInputRef.current?.click()}
              aria-label={playlist.coverUrl ? 'Сменить обложку плейлиста' : 'Поставить обложку плейлиста'}
              title={playlist.coverUrl ? 'Сменить обложку' : 'Поставить обложку'}
              data-testid="playlist-cover-btn"
            >
              <PlaylistCover
                tracks={tracks}
                coverUrl={playlist.coverUrl}
                size={112}
                radius="var(--radius-md)"
              />
            </button>

            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => void handleCoverPicked(event)}
              data-testid="playlist-cover-input"
            />

            {playlist.coverUrl && (
              <Button
                variant="ghost"
                size="icon"
                icon={<X size={ICON.sm} />}
                onClick={() => void handleClearCover()}
                aria-label="Убрать свою обложку"
                title="Вернуть мозаику из обложек треков"
                style={{ position: 'absolute', top: '-6px', right: '-6px' }}
                data-testid="playlist-cover-clear"
              />
            )}
          </div>

          <div className="min-0 stack gap-1" style={{ flex: '1 1 280px' }}>
            <span className="section-label">Плейлист</span>

            {isEditingTitle ? (
              <div className="row gap-2">
                <input
                  type="text"
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleSaveRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setIsEditingTitle(false);
                    }
                  }}
                  aria-label="Название плейлиста"
                  autoFocus
                  className="text-xl weight-semibold" style={{ maxWidth: '420px' }}
                  data-testid="playlist-rename-input"
                />
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Check size={ICON.sm} />}
                  onClick={() => void handleSaveRename()}
                  data-testid="playlist-rename-save-btn"
                >
                  Сохранить
                </Button>
                <Button variant="ghost" size="sm" icon={<X size={ICON.sm} />} onClick={() => setIsEditingTitle(false)}>
                  Отмена
                </Button>
              </div>
            ) : (
              <div className="row gap-2 min-0">
                <h1
                  className="text-truncate m-0 weight-semibold text-primary type-2xl"
                  data-testid="playlist-title"
                >
                  {playlist.title}
                </h1>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Переименовать плейлист"
                  aria-label="Переименовать плейлист"
                  onClick={() => {
                    setEditedTitle(playlist.title);
                    setIsEditingTitle(true);
                  }}
                  data-testid="playlist-rename-btn"
                >
                  <Edit2 size={ICON.sm} />
                </Button>
              </div>
            )}

            {playlist.description && (
              <p className="m-0 text-sm text-secondary">
                {playlist.description}
              </p>
            )}

            <p data-numeric className="m-0 text-xs text-muted">
              {totals}
            </p>
          </div>

          <div className="row wrap gap-2 min-0">
            {tracks.length > 0 && (
              <>
                <Button
                  variant="primary"
                  size="md"
                  icon={<Play size={ICON.md} />}
                  onClick={handlePlayAll}
                  data-testid="playlist-play-all-btn"
                >
                  Слушать
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  icon={<Shuffle size={ICON.md} />}
                  onClick={handleShufflePlay}
                  data-testid="playlist-shuffle-btn"
                >
                  Вперемешку
                </Button>
                {/*
                  * Перемешка с добавками. Отдельной кнопкой, а не заменой
                  * обычной: обычная — это «тот же список в другом порядке», и
                  * человек имеет право получить именно её, без чужой музыки.
                  */}
                <Button
                  variant="secondary"
                  size="md"
                  icon={<Sparkles size={ICON.md} />}
                  onClick={() => void handleSmartShuffle()}
                  disabled={isMixing}
                  title="Перемешать и подмешать похожее, чего в плейлисте нет"
                  data-testid="playlist-smart-shuffle-btn"
                >
                  {isMixing ? 'Подбираем…' : 'Перемешать и дополнить'}
                </Button>
                <SaveOfflineButton
                  tracks={tracks}
                  label="плейлист"
                  data-testid="playlist-save-offline-btn"
                />
                {/* Вход в режим выбора: в меню трека его не искали. */}
                <Button
                  variant={selectedTrackIds !== null ? 'secondary' : 'ghost'}
                  size="md"
                  icon={<CheckSquare size={ICON.md} />}
                  isActive={selectedTrackIds !== null}
                  onClick={() => (selectedTrackIds !== null ? clearSelection() : startSelection())}
                  data-testid="playlist-select-btn"
                >
                  {selectedTrackIds !== null ? 'Готово' : 'Выбрать'}
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              title={isPinned ? 'Открепить' : 'Закрепить наверху медиатеки'}
              aria-label={isPinned ? 'Открепить плейлист' : 'Закрепить плейлист наверху медиатеки'}
              aria-pressed={isPinned}
              onClick={() => {
                void usePinnedStore.getState().hydrate();
                if (!togglePin(playlist.id)) showToast(`Наверху помещается ${MAX_PINNED} плейлистов — открепите какой-нибудь`, 'info');
              }}
              data-testid="playlist-pin-btn"
            >
              {isPinned ? <PinOff size={ICON.md} /> : <Pin size={ICON.md} />}
            </Button>
            <PlaylistExportMenu playlist={playlist} />
            <Button
              variant="ghost"
              size="icon"
              title="Удалить плейлист"
              aria-label="Удалить плейлист"
              onClick={() => setIsConfirmingDelete(true)}
              data-testid="playlist-delete-btn"
            >
              <Trash2 size={ICON.md} />
            </Button>
          </div>
        </header>

        {picker.element}

        <SelectionBar
          total={tracks.length}
          allIds={tracks.map((track) => track.id)}
          testId="playlist-selection"
          actions={[
            {
              // Перенос выбранного: на телефоне это было, на компьютере — нет.
              icon: <ListPlus size={ICON.sm} />,
              label: 'В плейлист',
              onClick: () => picker.openMany(selectedTracks),
              testId: 'playlist-selection-move'
            },
            {
              icon: <Download size={ICON.sm} />,
              label: 'Скачать',
              onClick: () => void handleSaveSelected(),
              testId: 'playlist-selection-save'
            },
            {
              icon: <Trash2 size={ICON.sm} />,
              label: 'Убрать',
              danger: true,
              onClick: () => void handleRemoveSelected(),
              testId: 'playlist-selection-remove'
            }
          ]}
        />

        {tracks.length > 1 && (
          <div
            className="row gap-2 wrap"
            data-testid="playlist-toolbar"
          >
            <label
              className="relative row" style={{ flex: '1 1 220px', maxWidth: '360px' }}
            >
              <Search
                size={ICON.sm}
                aria-hidden="true"
                className="text-muted no-events" style={{ position: 'absolute', left: 'var(--space-3)' }}
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Найти в плейлисте"
                aria-label="Найти в плейлисте"
                className="w-full" style={{ paddingLeft: 'calc(var(--space-3) + 22px)' }}
                data-testid="playlist-filter-input"
              />
            </label>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as PlaylistSortKey)}
              aria-label="Сортировка"
              style={{ width: 'auto', flex: '0 0 auto' }}
              data-testid="playlist-sort-select"
            >
              {(Object.keys(PLAYLIST_SORT_LABELS) as PlaylistSortKey[]).map((key) => (
                <option key={key} value={key}>
                  {PLAYLIST_SORT_LABELS[key]}
                </option>
              ))}
            </select>
            {sortKey !== 'custom' && query.trim() === '' && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Save size={ICON.sm} />}
                onClick={() => void handleKeepOrder()}
                title="Записать этот порядок в сам плейлист"
                data-testid="playlist-keep-order-btn"
              >
                Сохранить порядок
              </Button>
            )}
            {duplicates > 0 && (
              <Button
                variant="ghost"
                size="sm"
                icon={<CopyX size={ICON.sm} />}
                onClick={() => void handleRemoveDuplicates()}
                title="Оставить каждый трек по одному разу"
                data-testid="playlist-dedupe-btn"
              >
                Убрать повторы ({duplicates})
              </Button>
            )}
            {query.trim() !== '' && (
              <span className="text-xs text-muted" data-testid="playlist-filter-count">
                Найдено: {entries.length}
              </span>
            )}
          </div>
        )}

        {tracks.length > 0 && entries.length === 0 && (
          <EmptyState
            art="search"
            title="Ничего не нашлось"
            description="В этом плейлисте нет треков с такими словами."
            action={{ label: 'Сбросить поиск', onClick: () => setQuery('') }}
            data-testid="playlist-filter-empty"
          />
        )}

        {tracks.length === 0 ? (
          <EmptyState
            art="playlists"
            title="В плейлисте пока пусто"
            description="Найдите трек и добавьте его сюда через меню."
            action={{ label: 'Найти треки', icon: <Plus size={ICON.sm} />, onClick: () => setActiveView('search') }}
            data-testid="playlist-empty"
          />
        ) : (
          <div
            ref={listRef}
            className="stack gap-1" style={{ paddingTop: virtual.paddingTop, paddingBottom: virtual.paddingBottom }}
          >
            {entries.slice(virtual.startIndex, virtual.endIndex).map(({ track, index: idx }, offset) => {
              const viewIdx = virtual.startIndex + offset;
              return (
              <div
                key={`${track.id}_${idx}`}
                onKeyDown={(e) => handleRowKeyDown(e, idx)}
                className="row gap-2"
                data-testid={`playlist-track-row-${idx}`}
              >
                <div className="grow">
                  <TrackCard
                    track={track}
                    index={isCustomView ? idx : viewIdx}
                    layout="row"
                    contextQueue={isCustomView ? tracks : viewTracks}
                    showIndex
                  />
                </div>

                <div className="row gap-px shrink-0">
                  {isCustomView && (
                  <>
                  <button
                    type="button"
                    onClick={() => void handleReorder(idx, idx - 1, `reorder-up-${idx - 1}`)}
                    disabled={idx === 0}
                    title="Выше (Alt+↑)"
                    aria-label={`Поднять «${track.title}» выше`}
                    style={{ ...rowButtonStyle, opacity: idx === 0 ? 0.35 : 1 }}
                    data-testid={`reorder-up-${idx}`}
                  >
                    <ArrowUp size={ICON.sm} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleReorder(idx, idx + 1, `reorder-down-${idx + 1}`)}
                    disabled={idx === tracks.length - 1}
                    title="Ниже (Alt+↓)"
                    aria-label={`Опустить «${track.title}» ниже`}
                    style={{ ...rowButtonStyle, opacity: idx === tracks.length - 1 ? 0.35 : 1 }}
                    data-testid={`reorder-down-${idx}`}
                  >
                    <ArrowDown size={ICON.sm} />
                  </button>
                  </>
                  )}
                  <button
                    type="button"
                    onClick={() => setPendingRemoval({ index: idx, title: track.title })}
                    title="Убрать из плейлиста"
                    aria-label={`Убрать «${track.title}» из плейлиста`}
                    style={{ ...rowButtonStyle, color: 'var(--danger)' }}
                    data-testid={`remove-track-${idx}`}
                  >
                    <Trash2 size={ICON.sm} />
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Диалоги — рядом с корнем, а не внутри него: это не содержимое плейлиста,
          а слой поверх окна. Причина, стоявшая здесь раньше (`animate-view-in`
          оставлял на корне преобразование, и `position: fixed` мерился по разделу),
          снята в самих кадрах — см. freshness.test.ts. */}
      <ConfirmDialog
        isOpen={isConfirmingDelete}
        title={`Удалить «${playlist.title}»?`}
        description="Плейлист исчезнет с этого устройства. Сами треки останутся на месте."
        confirmLabel="Удалить плейлист"
        danger
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setIsConfirmingDelete(false)}
      />

      <ConfirmDialog
        isOpen={pendingRemoval !== null}
        title="Убрать этот трек?"
        description={pendingRemoval ? `«${pendingRemoval.title}» исчезнет из плейлиста «${playlist.title}».` : undefined}
        confirmLabel="Убрать"
        danger
        onConfirm={() => void handleConfirmRemoval()}
        onCancel={() => setPendingRemoval(null)}
      />
    </>
  );
};

export default PlaylistView;
