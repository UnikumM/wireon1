import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Disc3, ListMusic, Play, Shuffle, User } from 'lucide-react';
import { UnifiedTrack } from '../../types/music';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { collectionTracks } from '../../services/collections';
import { TrackCard } from '../search/TrackCard';
import { Button } from '../common/Button';
import { Skeleton } from '../common/Skeleton';
import { EmptyState } from '../common/EmptyState';
import { ICON } from '../../styles/icons';
import { plural } from '../../utils/plural';

/**
 * Экран альбома, чужого плейлиста и сетов человека с SoundCloud.
 *
 * До этого альбом можно было только включить с карточки исполнителя: увидеть
 * состав, выбрать из него одну песню или поставить вперемешку было нельзя
 * нигде. Один экран на три вида — у них совпадает всё, кроме подписи под
 * названием, а три почти одинаковых экрана расходятся на второй же правке.
 */
export const CollectionView: React.FC = () => {
  const collection = useUIStore((s) => s.activeCollection);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

  const [tracks, setTracks] = useState<UnifiedTrack[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!collection) return;
    let cancelled = false;
    setIsLoading(true);
    setTracks([]);

    void collectionTracks(collection)
      .then((found) => {
        if (!cancelled) setTracks(found);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [collection]);

  const handlePlay = useCallback(
    (shuffle: boolean) => {
      if (tracks.length === 0) return;
      if (shuffle && !isShuffled) toggleShuffle();
      void playTrack(tracks[0], tracks, 0);
    },
    [tracks, isShuffled, toggleShuffle, playTrack]
  );

  if (!collection) {
    return (
      <EmptyState
        icon={<ListMusic size={ICON.display} />}
        title="Подборка не выбрана"
        description="Найдите альбом или плейлист в поиске и откройте его."
      />
    );
  }

  const Icon = collection.kind === 'album' ? Disc3 : collection.kind === 'artist' ? User : ListMusic;

  return (
    <div
      className="animate-view-in"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', width: '100%' }}
      data-testid="collection-view"
    >
      <div>
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft size={ICON.md} />}
          onClick={() => setActiveView('search')}
          data-testid="collection-back"
        >
          Назад
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap' }}>
        <div
          style={{
            width: '200px',
            height: '200px',
            flexShrink: 0,
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            background: 'var(--surface-2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {collection.artworkUrl ? (
            <img
              src={collection.artworkUrl}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <Icon size={ICON.display} />
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minWidth: 0 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 'var(--text-2xl)',
              lineHeight: 'var(--leading-2xl)',
              letterSpacing: 'var(--tracking-2xl)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)'
            }}
            data-testid="collection-title"
          >
            {collection.title}
          </h1>

          {collection.subtitle && (
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              {collection.subtitle}
            </p>
          )}

          {!isLoading && tracks.length > 0 && (
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              <span data-numeric>{tracks.length}</span>{' '}
              {plural(tracks.length, 'трек', 'трека', 'треков')}
            </p>
          )}

          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button
              variant="primary"
              size="md"
              icon={<Play size={ICON.lg} />}
              onClick={() => handlePlay(false)}
              disabled={tracks.length === 0}
              data-testid="collection-play"
            >
              Слушать
            </Button>
            <Button
              variant="secondary"
              size="md"
              icon={<Shuffle size={ICON.md} />}
              onClick={() => handlePlay(true)}
              disabled={tracks.length === 0}
              data-testid="collection-shuffle"
            >
              Вперемешку
            </Button>
          </div>
        </div>
      </div>

      {isLoading && <Skeleton height={56} count={8} />}

      {!isLoading && tracks.length === 0 && (
        <EmptyState
          data-testid="collection-empty"
          icon={<ListMusic size={ICON.display} />}
          title="Состав не приехал"
          description="Источник не отдал список треков. Попробуйте открыть подборку ещё раз чуть позже."
        />
      )}

      {!isLoading && tracks.length > 0 && (
        <div
          role="list"
          style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}
          data-testid="collection-track-list"
        >
          {tracks.map((track, index) => (
            <TrackCard
              key={`${track.id}_${index}`}
              track={track}
              index={index}
              layout="row"
              contextQueue={tracks}
            />
          ))}
        </div>
      )}
    </div>
  );
};
