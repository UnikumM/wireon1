import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Wand2 } from 'lucide-react';
import { Button } from '../common/Button';
import { PlaylistCover } from '../library/PlaylistCover';
import { useSmartPlaylistStore } from '../../store/useSmartPlaylistStore';
import { useUIStore } from '../../store/useUIStore';
import { useTrackFacts } from '../../hooks/useSmartPlaylistTracks';
import { describeRules, evaluateSmartPlaylist } from '../../services/smartPlaylists';
import { pluralize } from '../../utils/plural';
import { ICON } from '../../styles/icons';
import { SmartPlaylistEditor } from './SmartPlaylistEditor';

/**
 * Полка умных плейлистов во вкладке «Плейлисты» — и на компьютере, и на телефоне.
 */
export const SmartPlaylistsShelf: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const playlists = useSmartPlaylistStore((s) => s.playlists);
  const openSmartPlaylist = useUIStore((s) => s.openSmartPlaylist);
  const facts = useTrackFacts();
  const [isEditorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    void useSmartPlaylistStore.getState().hydrate();
  }, []);

  const computed = useMemo(
    () =>
      playlists.map((playlist) => ({
        playlist,
        tracks: facts ? evaluateSmartPlaylist(playlist, facts, Date.now()) : []
      })),
    [facts, playlists]
  );

  return (
    <section className="stack gap-3" data-testid="smart-shelf">
      <div className="row justify-between gap-3 wrap">
        <h2
          className="m-0 row gap-2 text-primary" style={{ fontSize: compact ? 'var(--text-base)' : 'var(--text-xl)', lineHeight: compact ? 'var(--leading-base)' : 'var(--leading-xl)' }}
        >
          <Wand2 size={compact ? ICON.md : ICON.lg} aria-hidden="true" className="text-accent" />
          Умные плейлисты
        </h2>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={ICON.md} aria-hidden="true" />}
          onClick={() => setEditorOpen(true)}
          data-testid="smart-create-btn"
        >
          {compact ? 'Создать' : 'Создать по правилам'}
        </Button>
      </div>

      {playlists.length === 0 ? (
        <p className="m-0 text-sm text-muted" data-testid="smart-shelf-empty">
          Опишите, какие треки нужны — «из избранного и не звучало месяц», «топ-50», «до трёх минут», — и
          список будет собираться сам.
        </p>
      ) : (
        <div
          className="grid gap-3" style={{ gridTemplateColumns: compact ? 'repeat(auto-fill, minmax(140px, 1fr))' : 'repeat(auto-fill, minmax(200px, 1fr))' }}
        >
          {computed.map(({ playlist, tracks }) => (
            <button
              key={playlist.id}
              type="button"
              className="card hover-sheen focus-ring stack gap-2 p-3 text-left pointer"
              onClick={() => openSmartPlaylist(playlist.id)}
              data-testid={`smart-card-${playlist.id}`}
            >
              <PlaylistCover tracks={tracks} size="100%" radius="var(--radius-md)" />
              <span className="text-truncate weight-semibold text-primary">
                {playlist.title}
              </span>
              <span
                className="text-truncate text-xs text-muted"
                title={describeRules(playlist)}
              >
                {facts ? pluralize(tracks.length, 'трек', 'трека', 'треков') : '…'} · {describeRules(playlist)}
              </span>
            </button>
          ))}
        </div>
      )}

      <SmartPlaylistEditor isOpen={isEditorOpen} onClose={() => setEditorOpen(false)} />
    </section>
  );
};
