import React, { useMemo, useRef, useState } from 'react';
import { GripVertical, ListMusic, Music2, Play, Shuffle, Trash2, X } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useDismissable } from '../../hooks';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { SourceBadge } from '../common/SourceBadge';
import { formatDuration } from '../../utils/time';
import { pluralize } from '../../utils/plural';
import { UnifiedTrack } from '../../types/music';
import { useVirtualRows } from '../../hooks/useVirtualRows';
import { ICON } from '../../styles/icons';

/**
 * Шаг строки очереди: обложка 36px + отбивки 2×4px + рамка сверху 1px.
 * Строки здесь плотнее, чем в списках треков, поэтому шаг свой.
 */
const QUEUE_ROW_PITCH = 45;

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0
};

/*
 * Раскладка строки-заголовка. Начертание подписи задаёт класс `.section-label`
 * на вложенном тексте: капс отсюда убран, потому что второй элемент строки —
 * кнопка, и регистр с родителя доставался ей заодно.
 */
const SECTION_LABEL: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-2)',
  padding: '0 var(--space-1) var(--space-2)',
  fontSize: 'var(--text-sm)',
  // `--text-faint` в theme.css помечен «decoration only», и не зря: на
  // `--surface-2` это 3.25:1 — ниже требования 4.5:1 к тексту. А здесь текст
  // несущий: «Далее», «Из очереди» — единственное, что объясняет, почему список
  // разбит на части. `--text-muted` (5.34:1) — минимум, при котором читается.
  color: 'var(--text-muted)'
};

const ROW_ARTWORK: React.CSSProperties = {
  width: '36px',
  height: '36px',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  borderRadius: 'var(--radius-xs)',
  border: '1px solid var(--border-subtle)',
  backgroundColor: 'var(--surface-2)'
};

const RowArtwork: React.FC<{ track: UnifiedTrack }> = ({ track }) => (
  <span style={ROW_ARTWORK}>
    {track.artworkUrl ? (
      <img
        src={track.artworkUrl}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        onError={(event) => {
          event.currentTarget.style.display = 'none';
        }}
      />
    ) : (
      <Music2 size={ICON.md} aria-hidden="true" style={{ color: 'var(--text-faint)' }} />
    )}
  </span>
);

export interface QueueDrawerProps {
  className?: string;
}

/**
 * The queue is two lists, not one: tracks the user explicitly queued, then
 * whatever the playing context (playlist, album, search) would come to next.
 * They are never merged, because only the first is reorderable.
 */
export const QueueDrawer: React.FC<QueueDrawerProps> = ({ className = '' }) => {
  const isQueueOpen = useUIStore((s) => s.isQueueOpen);
  const setQueueOpen = useUIStore((s) => s.setQueueOpen);
  const openArtist = useUIStore((s) => s.openArtist);

  const handleArtistClick = (e: React.MouseEvent, artistName: string) => {
    e.stopPropagation();
    if (!artistName) return;
    setQueueOpen(false);
    openArtist(artistName);
  };

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const userQueue = usePlayerStore((s) => s.userQueue);
  const sourceQueue = usePlayerStore((s) => s.sourceQueue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const shuffleOrder = usePlayerStore((s) => s.shuffleOrder);

  const removeFromUserQueue = usePlayerStore((s) => s.removeFromUserQueue);
  const reorderUserQueue = usePlayerStore((s) => s.reorderUserQueue);
  const clearUserQueue = usePlayerStore((s) => s.clearUserQueue);
  const jumpToUserQueueTrack = usePlayerStore((s) => s.jumpToUserQueueTrack);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLUListElement>(null);

  const { containerRef, backdropProps } = useDismissable<HTMLDivElement>({
    isOpen: isQueueOpen,
    onDismiss: () => setQueueOpen(false)
  });

  /** What the source queue plays after the current track, in playback order. */
  const upcomingFromSource = useMemo(() => {
    if (sourceQueue.length === 0) return [];

    const order =
      isShuffled && shuffleOrder.length > 0
        ? shuffleOrder
        : sourceQueue.map((_, index) => index);

    const position = order.indexOf(currentIndex);
    const following = position === -1 ? order : order.slice(position + 1);

    // Раньше показывались только первые 30 — теперь список виртуализирован,
    // и обрезать его незачем: счётчик в заголовке наконец не врёт.
    return following
      .map((index) => ({ index, track: sourceQueue[index] }))
      .filter((entry) => Boolean(entry.track));
  }, [sourceQueue, currentIndex, isShuffled, shuffleOrder]);

  const sourceVirtual = useVirtualRows<HTMLUListElement>({
    itemCount: upcomingFromSource.length,
    rowPitch: QUEUE_ROW_PITCH
  });

  if (!isQueueOpen) return null;

  const focusQueueRow = (index: number) => {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-queue-index="${index}"] button`)?.focus();
    });
  };

  const moveTrack = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= userQueue.length) return;

    const moved = userQueue[index];
    reorderUserQueue(index, target);
    setAnnouncement(`«${moved.title}» на позиции ${target + 1} из ${userQueue.length}`);
    focusQueueRow(target);
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLLIElement>, index: number) => {
    if (!event.altKey) return;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveTrack(index, -1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveTrack(index, 1);
    }
  };

  const handleDragStart = (event: React.DragEvent, index: number) => {
    event.dataTransfer.setData('text/plain', String(index));
    event.dataTransfer.effectAllowed = 'move';
    setDraggedIndex(index);
  };

  const handleDragOver = (event: React.DragEvent, index: number) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetIndex(index);
  };

  const handleDrop = (event: React.DragEvent, targetIndex: number) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('text/plain');
    const fromIndex = Number.parseInt(raw, 10);

    setDraggedIndex(null);
    setDropTargetIndex(null);

    if (!Number.isFinite(fromIndex) || fromIndex === targetIndex) return;
    if (fromIndex < 0 || fromIndex >= userQueue.length) return;

    const moved = userQueue[fromIndex];
    reorderUserQueue(fromIndex, targetIndex);
    setAnnouncement(`«${moved.title}» на позиции ${targetIndex + 1} из ${userQueue.length}`);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDropTargetIndex(null);
  };

  const handleClearUpNext = () => {
    const count = userQueue.length;
    clearUserQueue();
    setAnnouncement(`Из очереди убрано ${pluralize(count, 'трек', 'трека', 'треков')}`);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-drawer)' }}>
      <div
        {...backdropProps}
        className="animate-fade-in"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'var(--surface-sunken)',
          opacity: 0.72
        }}
        data-testid="queue-drawer-backdrop"
      />

      <aside
        ref={containerRef}
        id="queue-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="queue-drawer-title"
        className={`animate-slide-left ${className}`}
        style={
          {
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: '100%',
            maxWidth: 'var(--queue-drawer-width)',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: 'var(--surface-3)',
            borderLeft: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
            '--ring-offset-color': 'var(--surface-3)'
          } as React.CSSProperties
        }
        data-testid="queue-drawer"
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-4) var(--space-3)',
            borderBottom: '1px solid var(--border-subtle)'
          }}
        >
          <h2
            id="queue-drawer-title"
            style={{
              margin: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              fontSize: 'var(--text-lg)',
              letterSpacing: 'var(--tracking-lg)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)'
            }}
          >
            <ListMusic size={ICON.lg} aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
            Очередь
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setQueueOpen(false)}
            title="Закрыть очередь"
            aria-label="Закрыть очередь"
            style={{ width: 'var(--control-md)', height: 'var(--control-md)' }}
            data-testid="queue-drawer-close"
          >
            <X size={ICON.md} />
          </Button>
        </header>

        <div aria-live="polite" style={VISUALLY_HIDDEN} data-testid="queue-live-region">
          {announcement}
        </div>

        <div
          className="scrollbar-thin"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 'var(--space-4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-5)'
          }}
        >
          <section aria-labelledby="queue-now-playing-label">
            <div style={SECTION_LABEL} id="queue-now-playing-label">
              <span className="section-label">Сейчас играет</span>
            </div>

            {currentTrack ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-2) var(--space-3)',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'var(--accent-soft)',
                  border: '1px solid var(--border-accent)'
                }}
                data-testid="queue-now-playing"
              >
                <RowArtwork track={currentTrack} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="text-truncate"
                    style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--accent)' }}
                  >
                    {currentTrack.title}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => handleArtistClick(e, currentTrack.artist)}
                    className="text-truncate focus-ring hover-underline"
                    style={{
                      display: 'inline-block',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-secondary)',
                      padding: 0,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left'
                    }}
                    title={`Открыть исполнителя ${currentTrack.artist}`}
                    data-testid="queue-now-playing-artist"
                  >
                    {currentTrack.artist}
                  </button>
                </div>
                {isPlaying && (
                  <span className="eq-bars" role="img" aria-label="Играет">
                    <span className="eq-bar" />
                    <span className="eq-bar" />
                    <span className="eq-bar" />
                  </span>
                )}
                <SourceBadge source={currentTrack.source} size="xs" />
              </div>
            ) : (
              <EmptyState
                icon={<Music2 size={ICON.xl} />}
                title="Ничего не играет"
                description="Включите трек — он появится здесь."
                style={{ padding: 'var(--space-5) var(--space-4)', gap: 'var(--space-2)' }}
                data-testid="queue-now-playing-empty"
              />
            )}
          </section>

          <section aria-labelledby="queue-up-next-label">
            <div style={SECTION_LABEL} id="queue-up-next-label">
              <span className="section-label">
                Вы поставили в очередь{userQueue.length > 0 && <span data-numeric> ({userQueue.length})</span>}
              </span>
              {userQueue.length > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleClearUpNext}
                  title="Убрать всё, что вы поставили в очередь"
                  style={{ color: 'var(--danger)' }}
                  data-testid="clear-user-queue-btn"
                >
                  Очистить
                </Button>
              )}
            </div>

            {userQueue.length === 0 ? (
              <EmptyState
                icon={<ListMusic size={ICON.xl} />}
                title="Очередь пуста"
                description="«В очередь» в меню любого трека поставит его сюда — он заиграет раньше остального."
                style={{ padding: 'var(--space-5) var(--space-4)', gap: 'var(--space-2)' }}
                data-testid="queue-up-next-empty"
              />
            ) : (
              <ul
                ref={listRef}
                style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}
              >
                {userQueue.map((track, index) => (
                  <li
                    key={`${track.id}_${index}`}
                    data-queue-index={index}
                    draggable
                    onDragStart={(event) => handleDragStart(event, index)}
                    onDragOver={(event) => handleDragOver(event, index)}
                    onDrop={(event) => handleDrop(event, index)}
                    onDragEnd={handleDragEnd}
                    onKeyDown={(event) => handleRowKeyDown(event, index)}
                    className="menu-item-hover"
                    style={{
                      gap: 'var(--space-2)',
                      padding: 'var(--space-1) var(--space-2)',
                      opacity: draggedIndex === index ? 0.5 : 1,
                      borderTop: `1px solid ${
                        dropTargetIndex === index && draggedIndex !== index ? 'var(--accent)' : 'transparent'
                      }`
                    }}
                    data-testid={`user-queue-item-${index}`}
                  >
                    <span
                      aria-hidden="true"
                      title="Перетащите, чтобы поменять порядок"
                      style={{ display: 'inline-flex', cursor: 'grab', color: 'var(--text-faint)', flexShrink: 0 }}
                    >
                      <GripVertical size={ICON.md} />
                    </span>

                    <button
                      onClick={() => jumpToUserQueueTrack(index)}
                      title={`Включить «${track.title}»`}
                      aria-label={`Включить «${track.title}». Alt со стрелками меняет порядок.`}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        padding: 0,
                        justifyContent: 'flex-start',
                        textAlign: 'left'
                      }}
                      data-testid={`play-queue-item-${index}`}
                    >
                      <RowArtwork track={track} />
                      <span style={{ flex: 1, minWidth: 0, display: 'block' }}>
                        <span
                          className="text-truncate"
                          style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}
                        >
                          {track.title}
                        </span>
                        <span
                          className="text-truncate hover-underline"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => handleArtistClick(e, track.artist)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              e.preventDefault();
                              handleArtistClick(e as unknown as React.MouseEvent, track.artist);
                            }
                          }}
                          style={{
                            display: 'block',
                            fontSize: 'var(--text-xs)',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            width: 'fit-content'
                          }}
                          title={`Открыть исполнителя ${track.artist}`}
                          data-testid={`user-queue-artist-${index}`}
                        >
                          {track.artist}
                        </span>
                      </span>
                    </button>

                    <span data-numeric style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>
                      {formatDuration(track.duration)}
                    </span>

                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        removeFromUserQueue(index);
                        setAnnouncement(`«${track.title}» убран из очереди`);
                      }}
                      title="Убрать из очереди"
                      aria-label={`Убрать «${track.title}» из очереди`}
                      style={{ width: 'var(--control-sm)', height: 'var(--control-sm)', color: 'var(--text-muted)' }}
                      data-testid={`remove-queue-item-${index}`}
                    >
                      <Trash2 size={ICON.sm} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="queue-source-label">
            <div style={SECTION_LABEL} id="queue-source-label">
              <span className="section-label">
                Дальше по списку
                {upcomingFromSource.length > 0 && <span data-numeric> ({upcomingFromSource.length})</span>}
              </span>
              {isShuffled && (
                <span className="badge" style={{ color: 'var(--accent)', borderColor: 'var(--border-accent)' }}>
                  <Shuffle size={ICON.xs} aria-hidden="true" />
                  Вперемешку
                </span>
              )}
            </div>

            {upcomingFromSource.length === 0 ? (
              <EmptyState
                icon={<Play size={ICON.xl} />}
                title="Список пуст"
                description="Включите плейлист, альбом или результаты поиска — остальные треки выстроятся здесь."
                style={{ padding: 'var(--space-5) var(--space-4)', gap: 'var(--space-2)' }}
                data-testid="queue-source-empty"
              />
            ) : (
              <ul
                ref={sourceVirtual.containerRef}
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  paddingTop: sourceVirtual.paddingTop,
                  paddingBottom: sourceVirtual.paddingBottom
                }}
              >
                {upcomingFromSource
                  .slice(sourceVirtual.startIndex, sourceVirtual.endIndex)
                  .map(({ index, track }) => (
                  <li key={`${track.id}_${index}`} data-testid={`source-queue-item-${index}`}>
                    <button
                      onClick={() => playTrack(track, sourceQueue, index)}
                      title={`Включить «${track.title}»`}
                      aria-label={`Включить «${track.title}»`}
                      className="menu-item-hover"
                      style={{ gap: 'var(--space-2)', padding: 'var(--space-1) var(--space-2)' }}
                    >
                      <RowArtwork track={track} />
                      <span style={{ flex: 1, minWidth: 0, display: 'block' }}>
                        <span
                          className="text-truncate"
                          style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}
                        >
                          {track.title}
                        </span>
                        <span
                          className="text-truncate hover-underline"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => handleArtistClick(e, track.artist)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              e.preventDefault();
                              handleArtistClick(e as unknown as React.MouseEvent, track.artist);
                            }
                          }}
                          style={{
                            display: 'block',
                            fontSize: 'var(--text-xs)',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            width: 'fit-content'
                          }}
                          title={`Открыть исполнителя ${track.artist}`}
                          data-testid={`source-queue-artist-${index}`}
                        >
                          {track.artist}
                        </span>
                      </span>
                      <span data-numeric style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>
                        {formatDuration(track.duration)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
};
