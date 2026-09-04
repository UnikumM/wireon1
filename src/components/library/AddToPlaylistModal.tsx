import React, { useCallback, useMemo, useState } from 'react';
import { Check, ListMusic, Plus } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore, refusedForAccount } from '../../store/useUIStore';
import { UnifiedTrack } from '../../types/music';
import { PlaylistCover } from './PlaylistCover';
import { pluralize } from '../../utils/plural';
import { ICON } from '../../styles/icons';

export interface AddToPlaylistModalProps {
  /** The track being filed. `null` renders nothing. */
  track: UnifiedTrack | null;
  isOpen: boolean;
  onClose: () => void;
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  width: '100%',
  padding: 'var(--space-2)',
  borderRadius: 'var(--radius-sm)',
  textAlign: 'left'
};

/**
 * The "Add to playlist" picker. Every store call is checked: a failed write keeps
 * the dialog open and shows the reason the store recorded.
 */
export const AddToPlaylistModal: React.FC<AddToPlaylistModalProps> = ({
  track,
  isOpen,
  onClose
}) => {
  const playlists = useLibraryStore((s) => s.playlists);
  const addTrackToPlaylist = useLibraryStore((s) => s.addTrackToPlaylist);
  const createPlaylist = useLibraryStore((s) => s.createPlaylist);
  const showToast = useUIStore((s) => s.showToast);

  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const containsTrack = useMemo(() => {
    const map = new Map<string, boolean>();
    if (!track) return map;
    for (const playlist of playlists) {
      map.set(playlist.id, playlist.tracks.some((t) => t.id === track.id));
    }
    return map;
  }, [playlists, track]);

  const reset = useCallback(() => {
    setIsCreating(false);
    setNewTitle('');
    setBusyId(null);
    setError(null);
  }, []);

  const handleClose = () => {
    if (busyId) return;
    reset();
    onClose();
  };

  const fileInto = async (playlistId: string, playlistTitle: string) => {
    if (!track) return;
    setBusyId(playlistId);
    setError(null);

    const ok = await addTrackToPlaylist(playlistId, track);
    setBusyId(null);

    if (!ok) {
      if (refusedForAccount()) return;
      const reason = useLibraryStore.getState().error ?? 'Не удалось добавить трек.';
      setError(reason);
      showToast(reason, 'error');
      return;
    }

    showToast(`«${track.title}» добавлен в «${playlistTitle}»`, 'success');
    reset();
    onClose();
  };

  const handleCreateAndAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!track) return;

    const title = newTitle.trim();
    if (!title) {
      setError('Введите название нового плейлиста.');
      return;
    }

    setBusyId('__new__');
    setError(null);

    const created = await createPlaylist(title);
    if (!created) {
      const reason = useLibraryStore.getState().error ?? 'Не удалось создать плейлист.';
      setBusyId(null);
      setError(reason);
      showToast(reason, 'error');
      return;
    }

    const ok = await addTrackToPlaylist(created.id, track);
    setBusyId(null);

    if (!ok) {
      const reason = useLibraryStore.getState().error ?? 'Не удалось добавить трек.';
      setError(`Плейлист «${created.title}» создан, но трек в него не попал. ${reason}`);
      showToast(reason, 'error');
      return;
    }

    showToast(`«${track.title}» добавлен в «${created.title}»`, 'success');
    reset();
    onClose();
  };

  if (!track) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Добавить в плейлист"
      description={`${track.title} — ${track.artist}`}
      maxWidth="440px"
      data-testid="add-to-playlist-modal"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {error && (
          <p
            role="alert"
            style={{
              margin: 0,
              padding: 'var(--space-2) var(--space-3)',
              backgroundColor: 'var(--danger-soft)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--danger)',
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)'
            }}
            data-testid="add-to-playlist-error"
          >
            {error}
          </p>
        )}

        {playlists.length === 0 && !isCreating && (
          <EmptyState
            icon={<ListMusic size={ICON.display} />}
            title="Плейлистов пока нет"
            description="Создайте первый — трек сразу попадёт в него."
            data-testid="add-to-playlist-empty"
          />
        )}

        {playlists.length > 0 && (
          <ul
            className="scrollbar-thin"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
              maxHeight: '280px',
              overflowY: 'auto'
            }}
          >
            {playlists.map((playlist) => {
              const already = containsTrack.get(playlist.id) === true;
              return (
                <li key={playlist.id}>
                  <button
                    type="button"
                    className="menu-item-hover"
                    style={rowStyle}
                    disabled={already || busyId !== null}
                    onClick={() => void fileInto(playlist.id, playlist.title)}
                    data-testid={`add-to-playlist-${playlist.id}`}
                  >
                    <PlaylistCover tracks={playlist.tracks} size={36} radius="var(--radius-xs)" />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        className="text-truncate"
                        style={{
                          display: 'block',
                          fontSize: 'var(--text-sm)',
                          lineHeight: 'var(--leading-sm)',
                          fontWeight: 'var(--weight-medium)',
                          color: 'var(--text-primary)'
                        }}
                      >
                        {playlist.title}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 'var(--text-xs)',
                          lineHeight: 'var(--leading-xs)',
                          color: 'var(--text-muted)'
                        }}
                      >
                        {already
                          ? 'Уже в этом плейлисте'
                          : pluralize(playlist.tracks.length, 'трек', 'трека', 'треков')}
                      </span>
                    </span>
                    {already && (
                      <Check size={ICON.md} aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {isCreating ? (
          <form
            onSubmit={handleCreateAndAdd}
            style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
          >
            <input
              type="text"
              value={newTitle}
              onChange={(e) => {
                setNewTitle(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Название плейлиста"
              aria-label="Название нового плейлиста"
              autoFocus
              style={{ flex: 1, minWidth: 0 }}
              data-testid="add-to-playlist-new-input"
            />
            <Button
              variant="primary"
              type="submit"
              isLoading={busyId === '__new__'}
              data-testid="add-to-playlist-new-submit"
            >
              Создать
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setIsCreating(false);
                setNewTitle('');
              }}
              disabled={busyId !== null}
            >
              Отмена
            </Button>
          </form>
        ) : (
          <button
            type="button"
            className="menu-item-hover"
            style={{ ...rowStyle, color: 'var(--accent)' }}
            onClick={() => setIsCreating(true)}
            disabled={busyId !== null}
            data-testid="add-to-playlist-new-btn"
          >
            <span
              style={{
                width: '36px',
                height: '36px',
                borderRadius: 'var(--radius-xs)',
                backgroundColor: 'var(--accent-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <Plus size={ICON.md} aria-hidden="true" />
            </span>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)' }}>Новый плейлист…</span>
          </button>
        )}
      </div>
    </Modal>
  );
};

export interface AddToPlaylistController {
  /** Opens the picker for one track. */
  open: (track: UnifiedTrack) => void;
  close: () => void;
  isOpen: boolean;
  /** Render this node inside your component — it is the modal itself. */
  element: React.ReactNode;
}

/**
 * Entry point for anything with a track row (search results, the queue, a playlist).
 * The caller renders `element` and calls `open(track)`; no shell wiring is needed.
 */
export function useAddToPlaylist(): AddToPlaylistController {
  const [track, setTrack] = useState<UnifiedTrack | null>(null);

  const open = useCallback((next: UnifiedTrack) => setTrack(next), []);
  const close = useCallback(() => setTrack(null), []);

  const element = <AddToPlaylistModal track={track} isOpen={track !== null} onClose={close} />;

  return { open, close, isOpen: track !== null, element };
}
