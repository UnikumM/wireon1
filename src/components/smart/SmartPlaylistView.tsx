import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Edit2, Play, Shuffle, Trash2, Wand2 } from 'lucide-react';
import { Button } from '../common/Button';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { EmptyState } from '../common/EmptyState';
import { Skeleton } from '../common/Skeleton';
import { TrackCard } from '../search/TrackCard';
import { PlaylistCover } from '../library/PlaylistCover';
import { useSmartPlaylistStore } from '../../store/useSmartPlaylistStore';
import { useUIStore, refusedForAccount } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useSmartPlaylistTracks } from '../../hooks/useSmartPlaylistTracks';
import { useVirtualRows, TRACK_ROW_PITCH } from '../../hooks/useVirtualRows';
import { describeRules } from '../../services/smartPlaylists';
import { describeTrackTotals } from '../library/trackSummary';
import { ICON } from '../../styles/icons';
import { SmartPlaylistEditor } from './SmartPlaylistEditor';

/** Экран умного плейлиста: правила, живой состав, «слушать» и «сохранить копией». */
export const SmartPlaylistView: React.FC = () => {
  const id = useUIStore((s) => s.activeSmartPlaylistId);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const showToast = useUIStore((s) => s.showToast);
  const playlist = useSmartPlaylistStore((s) => s.playlists.find((p) => p.id === id) ?? null);
  const hydrated = useSmartPlaylistStore((s) => s.hydrated);
  const remove = useSmartPlaylistStore((s) => s.remove);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const createPlaylistWithTracks = useLibraryStore((s) => s.createPlaylistWithTracks);
  const tracks = useSmartPlaylistTracks(playlist);
  const [isEditing, setEditing] = useState(false);
  const [isDeleting, setDeleting] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void useSmartPlaylistStore.getState().hydrate();
  }, []);

  const list = tracks ?? [];
  const virtual = useVirtualRows({ itemCount: list.length, rowPitch: TRACK_ROW_PITCH, containerRef: listRef });

  const play = useCallback(
    (shuffle: boolean) => {
      if (list.length === 0) return;
      const shuffled = usePlayerStore.getState().isShuffled;
      if (shuffle !== shuffled) toggleShuffle();
      const start = shuffle ? Math.floor(Math.random() * list.length) : 0;
      void playTrack(list[start], list, start);
    },
    [list, playTrack, toggleShuffle]
  );

  const saveCopy = useCallback(async () => {
    if (!playlist || list.length === 0) return;
    const created = await createPlaylistWithTracks(playlist.title, list);
    if (!created) {
      if (!refusedForAccount()) showToast(useLibraryStore.getState().error ?? 'Не удалось сохранить', 'error');
      return;
    }
    showToast(`Сохранено обычным плейлистом «${created.title}»`, 'success');
  }, [createPlaylistWithTracks, list, playlist, showToast]);

  if (!playlist) {
    if (!hydrated) return <Skeleton height={160} radius="var(--radius-lg)" />;
    return (
      <EmptyState
        className="animate-view-in"
        icon={<Wand2 size={ICON.display} />}
        title="Умный плейлист не найден"
        description="Скорее всего, его удалили."
        action={
          <Button variant="secondary" size="sm" onClick={() => setActiveView('playlists')}>
            К плейлистам
          </Button>
        }
        data-testid="smart-not-found"
      />
    );
  }

  return (
    <div className="animate-view-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }} data-testid="smart-view">
      <header
        className="panel"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-5)',
          padding: 'var(--space-5)',
          borderRadius: 'var(--radius-lg)',
          flexWrap: 'wrap'
        }}
      >
        <PlaylistCover tracks={list} size={112} radius="var(--radius-md)" />
        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span className="section-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            <Wand2 size={ICON.xs} aria-hidden="true" /> Умный плейлист
          </span>
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
            data-testid="smart-title"
          >
            {playlist.title}
          </h1>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }} data-testid="smart-rules-summary">
            {describeRules(playlist)}
          </p>
          <p data-numeric style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {tracks ? describeTrackTotals(list) : 'Считаем…'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button variant="primary" size="md" icon={<Play size={ICON.md} />} onClick={() => play(false)} disabled={list.length === 0} data-testid="smart-play">
            Слушать
          </Button>
          <Button variant="secondary" size="md" icon={<Shuffle size={ICON.md} />} onClick={() => play(true)} disabled={list.length === 0} data-testid="smart-shuffle">
            Вперемешку
          </Button>
          <Button variant="ghost" size="md" icon={<Edit2 size={ICON.md} />} onClick={() => setEditing(true)} data-testid="smart-edit">
            Правила
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Сохранить копией как обычный плейлист"
            aria-label="Сохранить копией как обычный плейлист"
            onClick={() => void saveCopy()}
            disabled={list.length === 0}
            data-testid="smart-save-copy"
          >
            <Copy size={ICON.md} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Удалить умный плейлист"
            aria-label="Удалить умный плейлист"
            onClick={() => setDeleting(true)}
            data-testid="smart-delete"
          >
            <Trash2 size={ICON.md} />
          </Button>
        </div>
      </header>

      {tracks === null ? (
        <Skeleton height={56} count={6} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Wand2 size={ICON.display} />}
          title="Под эти правила пока ничего не подходит"
          description="Ослабьте условия или послушайте ещё — список пересоберётся сам."
          action={
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Изменить правила
            </Button>
          }
          data-testid="smart-empty"
        />
      ) : (
        <div
          ref={listRef}
          role="list"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
            paddingTop: virtual.paddingTop,
            paddingBottom: virtual.paddingBottom
          }}
          data-testid="smart-track-list"
        >
          {list.slice(virtual.startIndex, virtual.endIndex).map((track, offset) => {
            const index = virtual.startIndex + offset;
            return <TrackCard key={`${track.id}_${index}`} track={track} index={index} layout="row" contextQueue={list} showIndex />;
          })}
        </div>
      )}

      <SmartPlaylistEditor isOpen={isEditing} onClose={() => setEditing(false)} playlist={playlist} />
      <ConfirmDialog
        isOpen={isDeleting}
        title={`Удалить «${playlist.title}»?`}
        description="Исчезнут только правила — треки останутся в медиатеке."
        confirmLabel="Удалить"
        danger
        onConfirm={() => {
          setDeleting(false);
          remove(playlist.id);
          showToast('Умный плейлист удалён', 'info');
          setActiveView('playlists');
        }}
        onCancel={() => setDeleting(false)}
      />
    </div>
  );
};
