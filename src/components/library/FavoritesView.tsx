import React from 'react';
import { Heart, Play, Shuffle, Music2 } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { Skeleton } from '../common/Skeleton';
import { TrackCard } from '../search/TrackCard';
import { UnifiedTrack } from '../../types/music';
import { describeTrackTotals } from './trackSummary';
import { SaveOfflineButton } from './SaveOfflineButton';
import { useVirtualRows, TRACK_ROW_PITCH } from '../../hooks/useVirtualRows';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { ICON } from '../../styles/icons';

export interface FavoritesViewProps {
  /** The list to display — already filtered and sorted by the owner. */
  tracks: UnifiedTrack[];
  /** Size of the unfiltered collection, so a filtered view can say "3 of 12". */
  totalCount?: number;
  /** The active filter text, used only for the "nothing matched" message. */
  query?: string;
  isLoading?: boolean;
  /** Search / sort controls supplied by `LibraryView`. */
  toolbar?: React.ReactNode;
  className?: string;
}

/**
 * The body of the Favorites tab. Presentational on purpose: `LibraryView` owns the
 * store subscription, the filter and the sort, so there is exactly one list.
 */
export const FavoritesView: React.FC<FavoritesViewProps> = ({
  tracks,
  totalCount,
  query = '',
  isLoading = false,
  toolbar,
  className = ''
}) => {
  const playTrack = usePlayerStore((s) => s.playTrack);

  /*
   * Подписка здесь недорога: шапка одна на весь список, в отличие от `TrackCard`,
   * который рисуется на каждую строку и поэтому узость получает пропом.
   */
  const isNarrow = useMediaQuery('(max-width: 768px)');

  const virtual = useVirtualRows({ itemCount: tracks.length, rowPitch: TRACK_ROW_PITCH });

  const total = totalCount ?? tracks.length;
  const isFiltered = tracks.length !== total;

  const handlePlayAll = () => {
    if (tracks.length === 0) return;
    void playTrack(tracks[0], tracks, 0);
  };

  /** Shuffle is a player mode, so turn it on and let the store pick the order. */
  const handleShuffleAll = () => {
    if (tracks.length === 0) return;
    const player = usePlayerStore.getState();
    if (!player.isShuffled) player.toggleShuffle();
    void usePlayerStore.getState().playTrack(tracks[0], tracks, 0);
  };

  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', width: '100%' }}
      data-testid="favorites-view"
    >
      {/*
        * Ряд переносится, и это правило самой шапки, а не только группы кнопок.
        * Перенос стоял на группе — на 360 px кнопки складывались в столбик
        * шириной 160 px, шапка оставалась в одну строку, и заголовку с подписью
        * доставалось меньше пятидесяти пикселей: «8 тре / . / 31:5» под кнопками,
        * которые лежали поверх текста. Переносить надо там, где ряд не влезает.
        */}
      <div
        className="panel"
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 'var(--space-5)',
          padding: 'var(--space-5)'
        }}
      >
        {/*
          * Плитка с сердцем и заголовок «Избранное» — на телефоне это слово
          * стоит на экране ещё дважды: в шапке приложения и в закладке прямо
          * над панелью. Третье повторение вместе с плиткой съедало половину
          * ширины ряда и весь первый экран списка.
          */}
        {!isNarrow && (
          <span
            style={{
              width: '72px',
              height: '72px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--surface-3)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            <Heart size={ICON.display} aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
          </span>
        )}

        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          {!isNarrow && (
            <h2
              style={{
                margin: 0,
                fontSize: 'var(--text-xl)',
                lineHeight: 'var(--leading-xl)',
                letterSpacing: 'var(--tracking-xl)',
                color: 'var(--text-primary)'
              }}
            >
              Избранное
            </h2>
          )}
          <p
            style={{
              margin: 'var(--space-1) 0 0 0',
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              color: 'var(--text-secondary)'
            }}
            data-testid="favorites-summary"
          >
            {isFiltered
              ? `Показано ${tracks.length} из ${total} · ${describeTrackTotals(tracks)}`
              : describeTrackTotals(tracks)}
          </p>
        </div>

        {tracks.length > 0 && (
          <div style={{
              display: 'flex',
              alignItems: 'center',
              // Три подписанные кнопки в строку не влезают уже на 375 px, а
              // область содержимого режет по горизонтали — «В офлайн» просто
              // переставала существовать. На широком окне перенос ничего не
              // меняет: там они и так помещаются.
              flexWrap: 'wrap',
              gap: 'var(--space-3)'
            }}>
            {/*
              * Кегль поменьше на телефоне: в полный рост эти три кнопки не
              * помещались по две в ряд и вставали столбиком, а столбик из трёх
              * — это ещё триста пикселей до первого трека, ровно та беда, из-за
              * которой список начинался за краем экрана.
              */}
            <Button
              variant="primary"
              size={isNarrow ? 'sm' : 'md'}
              icon={<Play size={ICON.md} aria-hidden="true" />}
              onClick={handlePlayAll}
              data-testid="favorites-play-all-btn"
            >
              {isNarrow ? 'Слушать' : 'Слушать всё'}
            </Button>
            <Button
              variant="secondary"
              size={isNarrow ? 'sm' : 'md'}
              icon={<Shuffle size={ICON.md} aria-hidden="true" />}
              onClick={handleShuffleAll}
              data-testid="favorites-shuffle-btn"
            >
              Перемешать
            </Button>
            <SaveOfflineButton
              tracks={tracks}
              label="список"
              size={isNarrow ? 'sm' : 'md'}
              data-testid="favorites-save-offline-btn"
            />
          </div>
        )}
      </div>

      {toolbar}

      {isLoading ? (
        <Skeleton count={5} height={54} radius="var(--radius-sm)" />
      ) : total === 0 ? (
        <EmptyState
          icon={<Music2 size={ICON.display} />}
          title="В избранном пока пусто"
          description="Нажмите сердечко на любом треке — он появится здесь."
          data-testid="favorites-empty"
        />
      ) : tracks.length === 0 ? (
        <EmptyState
          icon={<Music2 size={ICON.display} />}
          title="Ничего не нашлось"
          description={query ? `Среди избранного нет ничего по запросу «${query}».` : 'Под фильтр не подошёл ни один трек.'}
          data-testid="favorites-no-matches"
        />
      ) : (
        <div
          ref={virtual.containerRef}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
            paddingTop: virtual.paddingTop,
            paddingBottom: virtual.paddingBottom
          }}
        >
          {tracks.slice(virtual.startIndex, virtual.endIndex).map((track, offset) => (
            <TrackCard
              key={track.id}
              track={track}
              index={virtual.startIndex + offset}
              layout="row"
              contextQueue={tracks}
              showIndex
            />
          ))}
        </div>
      )}
    </div>
  );
};
