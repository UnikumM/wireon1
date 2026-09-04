import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ListMusic, Play, Shuffle, Trash2, Edit2, Check, X, Music2, Plus, ArrowUp, ArrowDown } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { Button } from '../common/Button';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { EmptyState } from '../common/EmptyState';
import { TrackCard } from '../search/TrackCard';
import { PlaylistCover } from './PlaylistCover';
import { PlaylistExportMenu } from './PlaylistExportMenu';
import { SaveOfflineButton } from './SaveOfflineButton';
import { describeTrackTotals } from './trackSummary';
import { useVirtualRows, TRACK_ROW_PITCH } from '../../hooks/useVirtualRows';
import { ICON } from '../../styles/icons';

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
  const removeTrackFromPlaylist = useLibraryStore((s) => s.removeTrackFromPlaylist);
  const reorderPlaylistTracks = useLibraryStore((s) => s.reorderPlaylistTracks);

  const playTrack = usePlayerStore((s) => s.playTrack);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const syncSourceQueue = usePlayerStore((s) => s.syncSourceQueue);

  const targetId = propPlaylistId || activePlaylistId;
  const playlist = playlists.find((p) => p.id === targetId);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<{ index: number; title: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const tracks = playlist?.tracks ?? [];
  const totals = useMemo(() => describeTrackTotals(tracks), [tracks]);

  // Импортированный плейлист легко бывает на тысячу треков — держим в DOM
  // только видимое.
  const virtual = useVirtualRows({
    itemCount: tracks.length,
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
      if (updated) syncSourceQueue(updated.tracks);
    },
    [syncSourceQueue]
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

  const handlePlayAll = useCallback(() => {
    if (tracks.length === 0) return;
    void playTrack(tracks[0], tracks, 0);
  }, [playTrack, tracks]);

  /** Shuffle is enabled first so the store builds its order once, then plays. */
  const handleShufflePlay = useCallback(() => {
    if (tracks.length === 0) return;
    if (!usePlayerStore.getState().isShuffled) toggleShuffle();
    const start = Math.floor(Math.random() * tracks.length);
    void playTrack(tracks[start], tracks, start);
  }, [playTrack, toggleShuffle, tracks]);

  /** Alt+↑/↓ moves the focused row — the keyboard equivalent of dragging it. */
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, index: number) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const to = event.key === 'ArrowUp' ? index - 1 : index + 1;
      if (to < 0 || to >= tracks.length) return;
      event.preventDefault();
      event.stopPropagation();
      void handleReorder(index, to);
    },
    [handleReorder, tracks.length]
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
        icon={<ListMusic size={ICON.display} />}
        title="Плейлист не найден"
        description="Скорее всего, он удалён."
        action={
          <Button variant="secondary" size="sm" onClick={() => setActiveView('playlists')}>
            К плейлистам
          </Button>
        }
        data-testid="playlist-not-found"
      />
    );
  }

  return (
    <>
      <div
        className={`animate-view-in ${className}`}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', width: '100%' }}
        data-testid="playlist-view"
      >
        <header
          className="panel"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-5)',
            padding: 'var(--space-5)',
            borderRadius: 'var(--radius-lg)'
          }}
        >
          <PlaylistCover tracks={tracks} size={112} radius="var(--radius-md)" />

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <span className="section-label">Плейлист</span>

            {isEditingTitle ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
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
                  style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-semibold)', maxWidth: '420px' }}
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
                <h1
                  className="text-truncate"
                  style={{
                    margin: 0,
                    fontSize: 'var(--text-2xl)',
                    lineHeight: 'var(--leading-2xl)',
                    letterSpacing: 'var(--tracking-2xl)',
                    fontWeight: 'var(--weight-semibold)',
                    color: 'var(--text-primary)'
                  }}
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
              <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                {playlist.description}
              </p>
            )}

            <p data-numeric style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {totals}
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
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
                <SaveOfflineButton
                  tracks={tracks}
                  label="плейлист"
                  data-testid="playlist-save-offline-btn"
                />
              </>
            )}
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

        {tracks.length === 0 ? (
          <EmptyState
            icon={<Music2 size={ICON.display} />}
            title="В плейлисте пока пусто"
            description="Найдите что-нибудь в поиске и добавьте сюда через меню трека."
            action={
              <Button variant="secondary" size="sm" icon={<Plus size={ICON.sm} />} onClick={() => setActiveView('search')}>
                Найти треки
              </Button>
            }
            data-testid="playlist-empty"
          />
        ) : (
          <div
            ref={listRef}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
              paddingTop: virtual.paddingTop,
              paddingBottom: virtual.paddingBottom
            }}
          >
            {tracks.slice(virtual.startIndex, virtual.endIndex).map((track, offset) => {
              const idx = virtual.startIndex + offset;
              return (
              <div
                key={`${track.id}_${idx}`}
                onKeyDown={(e) => handleRowKeyDown(e, idx)}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                data-testid={`playlist-track-row-${idx}`}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TrackCard track={track} index={idx} layout="row" contextQueue={tracks} showIndex />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
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
