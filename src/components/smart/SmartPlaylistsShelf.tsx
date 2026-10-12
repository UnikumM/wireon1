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
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }} data-testid="smart-shelf">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <h2
          style={{
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontSize: compact ? 'var(--text-base)' : 'var(--text-xl)',
            lineHeight: compact ? 'var(--leading-base)' : 'var(--leading-xl)',
            color: 'var(--text-primary)'
          }}
        >
          <Wand2 size={compact ? ICON.md : ICON.lg} aria-hidden="true" style={{ color: 'var(--accent)' }} />
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
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }} data-testid="smart-shelf-empty">
          Опишите, какие треки нужны — «из избранного и не звучало месяц», «топ-50», «до трёх минут», — и
          список будет собираться сам.
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: compact ? 'repeat(auto-fill, minmax(140px, 1fr))' : 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 'var(--space-3)'
          }}
        >
          {computed.map(({ playlist, tracks }) => (
            <button
              key={playlist.id}
              type="button"
              className="card hover-sheen focus-ring"
              onClick={() => openSmartPlaylist(playlist.id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                padding: 'var(--space-3)',
                textAlign: 'left',
                cursor: 'pointer'
              }}
              data-testid={`smart-card-${playlist.id}`}
            >
              <PlaylistCover tracks={tracks} size="100%" radius="var(--radius-md)" />
              <span className="text-truncate" style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                {playlist.title}
              </span>
              <span
                className="text-truncate"
                style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}
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
