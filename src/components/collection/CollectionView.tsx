import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Disc3, ListMusic, ListPlus, Play, Shuffle, User } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { refusedForAccount } from '../../store/useUIStore';
import { useVirtualRows, TRACK_ROW_PITCH } from '../../hooks/useVirtualRows';
import { UnifiedTrack } from '../../types/music';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { collectionDetails, collectionTracks, LINK_COLLECTION_TITLE } from '../../services/collections';
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
  // Счётчик попыток: «Попробовать снова» на пустом составе перезапускает загрузку.
  const [attempt, setAttempt] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  /** Настоящее название подборки, открытой по ссылке. */
  const [loadedTitle, setLoadedTitle] = useState<string | null>(null);
  const title = loadedTitle || collection?.title || '';
  const createPlaylistWithTracks = useLibraryStore((s) => s.createPlaylistWithTracks);
  // Плейлисты YouTube бывают на сотни треков: в DOM — только видимое.
  const virtual = useVirtualRows({ itemCount: tracks.length, rowPitch: TRACK_ROW_PITCH });

  /*
   * «В медиатеку» — как «Сохранить» у альбома в Spotify: найденный альбом или
   * чужой плейлист становится своим плейлистом и едет на другие устройства.
   */
  const handleSave = useCallback(async () => {
    if (!collection || tracks.length === 0 || isSaving) return;
    setIsSaving(true);
    const created = await createPlaylistWithTracks(title || collection.title, tracks);
    setIsSaving(false);
    const ui = useUIStore.getState();
    if (!created) {
      if (!refusedForAccount()) ui.showToast(useLibraryStore.getState().error ?? 'Не удалось сохранить', 'error');
      return;
    }
    ui.showToast(`«${created.title}» теперь в ваших плейлистах`, 'success');
  }, [collection, createPlaylistWithTracks, isSaving, title, tracks]);

  useEffect(() => {
    if (!collection) return;
    let cancelled = false;
    setIsLoading(true);
    setTracks([]);
    setLoadedTitle(null);

    // Название ждём только у открытого по ссылке; остальное уже подписано поиском.
    const request =
      collection.title === LINK_COLLECTION_TITLE
        ? collectionDetails(collection)
        : collectionTracks(collection).then((list) => ({ title: null as string | null, tracks: list }));
    void request
      .then((found) => {
        if (cancelled) return;
        setTracks(found.tracks);
        if (found.title) setLoadedTitle(found.title);
      })
      .catch(() => {
        if (!cancelled) useUIStore.getState().showToast('Не удалось загрузить подборку. Попробуйте ещё раз.', 'error');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [collection, attempt]);

  const handlePlay = useCallback(
    (shuffle: boolean) => {
      if (tracks.length === 0) return;
      if (shuffle !== isShuffled) toggleShuffle();
      void playTrack(tracks[0], tracks, 0);
    },
    [tracks, isShuffled, toggleShuffle, playTrack]
  );

  if (!collection) {
    return (
      <EmptyState
        art="library"
        title="Подборка не выбрана"
        description="Найдите альбом или плейлист в поиске и откройте его."
        action={{ label: 'К поиску', onClick: () => setActiveView('search') }}
      />
    );
  }

  const Icon = collection.kind === 'album' ? Disc3 : collection.kind === 'artist' ? User : ListMusic;

  return (
    <div
      className="animate-view-in stack gap-6 w-full"
      data-testid="collection-view"
    >
      <div>
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft size={ICON.md} />}
          onClick={() => useUIStore.getState().goBack()}
          data-testid="collection-back"
        >
          Назад
        </Button>
      </div>

      <div className="row-stretch gap-5 wrap">
        <div
          className="shrink-0 radius-lg overflow-hidden row justify-center bg-surface-2" style={{ width: 'min(200px, 100%)', aspectRatio: '1' }}
        >
          {collection.artworkUrl ? (
            <img
              src={collection.artworkUrl}
              alt=""
              className="fill-cover"
            />
          ) : (
            <Icon size={ICON.display} />
          )}
        </div>

        <div className="stack gap-3 min-0">
          <h1
            className="m-0 weight-semibold text-primary type-2xl" style={{ overflowWrap: 'anywhere' }}
            data-testid="collection-title"
          >
            {title}
          </h1>

          {collection.subtitle && (
            <p className="m-0 text-sm text-secondary">
              {collection.subtitle}
            </p>
          )}

          {!isLoading && tracks.length > 0 && (
            <p className="m-0 text-sm text-muted">
              <span data-numeric>{tracks.length}</span>{' '}
              {plural(tracks.length, 'трек', 'трека', 'треков')}
            </p>
          )}

          <div className="row-stretch gap-2 wrap">
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
            <Button
              variant="ghost"
              size="md"
              icon={<ListPlus size={ICON.md} />}
              onClick={() => void handleSave()}
              disabled={tracks.length === 0 || isSaving}
              title="Сохранить подборку своим плейлистом"
              data-testid="collection-save"
            >
              В медиатеку
            </Button>
          </div>
        </div>
      </div>

      {isLoading && <Skeleton height={56} count={8} />}

      {!isLoading && tracks.length === 0 && (
        <EmptyState
          data-testid="collection-empty"
          art="network"
          title="Состав не приехал"
          description="Источник не отдал список треков. Попробуйте ещё раз чуть позже."
          action={{ label: 'Попробовать снова', onClick: () => setAttempt((n) => n + 1) }}
        />
      )}

      {!isLoading && tracks.length > 0 && (
        <div
          ref={virtual.containerRef}
          role="list"
          className="stack gap-px" style={{ paddingTop: virtual.paddingTop, paddingBottom: virtual.paddingBottom }}
          data-testid="collection-track-list"
        >
          {tracks.slice(virtual.startIndex, virtual.endIndex).map((track, offset) => {
            const index = virtual.startIndex + offset;
            return (
              <TrackCard
                key={`${track.id}_${index}`}
                track={track}
                index={index}
                layout="row"
                contextQueue={tracks}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};
