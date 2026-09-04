import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, Heart, Plus, MoreHorizontal, ListPlus, ExternalLink, Music2, Radio, CheckCircle2 } from 'lucide-react';
import { UnifiedTrack } from '../../types/music';
import { SourceBadge } from '../common/SourceBadge';
import { Button } from '../common/Button';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore, refusedForAccount } from '../../store/useUIStore';
import { offlineStorage } from '../../services/offlineStorage';
import { formatDuration } from '../../utils/time';
import { ICON } from '../../styles/icons';
import { useMobileShell } from '../../hooks/useMobileShell';
import { useAddToPlaylist } from '../library/AddToPlaylistModal';

export interface TrackCardProps {
  track: UnifiedTrack;
  /** Position of `track` inside `contextQueue`. Rendered as `index + 1`. */
  index?: number;
  layout?: 'row' | 'card' | 'hero';
  /**
   * Узкий экран: карточка «лучшее совпадение» встаёт в столбик.
   *
   * Пропом, а не своим `useMediaQuery`, потому что `TrackCard` рисуется на
   * каждую строку списка — подписка на медиазапрос в каждой из сотни строк
   * стоила бы дороже, чем то, что она решает. Хозяин один, и он же знает, что
   * рисует: `SearchResults`.
   */
  heroStacked?: boolean;
  contextQueue?: UnifiedTrack[];
  onPlay?: (track: UnifiedTrack, queue?: UnifiedTrack[], index?: number) => void;
  showIndex?: boolean;
  className?: string;
}

const SOURCE_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
};

/** Opens a source page in the system browser, falling back to the web build. */
function openSourceUrl(url: string): void {
  const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (bridge && typeof bridge.openExternal === 'function') {
    void Promise.resolve(bridge.openExternal(url)).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

interface ArtworkProps {
  track: UnifiedTrack;
  size: number;
  radius: string;
  failed: boolean;
  onFailed: () => void;
  children?: React.ReactNode;
}

/**
 * Square artwork with a matte fallback tile. A broken image renders an icon
 * rather than swapping in a data-URI so no colour is hardcoded here.
 */
const TrackArtwork: React.FC<ArtworkProps> = ({ track, size, radius, failed, onFailed, children }) => (
  <div
    style={{
      position: 'relative',
      width: size,
      height: size,
      flexShrink: 0,
      borderRadius: radius,
      overflow: 'hidden',
      background: 'var(--surface-sunken)',
      border: '1px solid var(--border-subtle)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    {failed || !track.artworkUrl ? (
      // Размер по шкале, а не 40% от плитки.
      //
      // `Math.round(size * 0.4)` давал 16, 53 и 64 px на трёх вызовах — три
      // размера вне шкалы ICON, а значит и вне рампы `stroke-width` в global.css
      // §7: у 53 и 64 штрих истончался до декоративного волоска, тогда как в
      // строке рядом иконки нормальной толщины. Плиток ровно два вида — строка
      // (40) и карточка (132/160), поэтому и размеров хватает двух.
      <Music2
        size={size >= 96 ? ICON.hero : ICON.md}
        style={{ color: 'var(--text-faint)' }}
        aria-hidden="true"
      />
    ) : (
      <img
        src={track.artworkUrl}
        alt=""
        loading="lazy"
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        onError={onFailed}
      />
    )}
    {children}
  </div>
);

export const TrackCard: React.FC<TrackCardProps> = ({
  track,
  index,
  layout = 'row',
  heroStacked = false,
  contextQueue,
  onPlay,
  showIndex = true,
  className = '',
}) => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const addToQueueEnd = usePlayerStore((s) => s.addToQueueEnd);
  const addToQueueNext = usePlayerStore((s) => s.addToQueueNext);

  const isFavorite = useLibraryStore((s) => s.isFavorite(track.id));
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  /*
   * Выбор плейлиста — отдельным окном, а не списком внутри меню.
   *
   * Раньше каждый плейлист был пунктом того же выпадающего меню, а меню
   * ограничено 320 px: пяти обычных действий и трёх плейлистов уже хватало,
   * чтобы началась прокрутка, — и до «Играть следующим» приходилось листать
   * обратно вверх. Жалоба звучала так: «на трёх точках зачем-то надо туда-сюда
   * листать». С ростом числа плейлистов меню становилось только хуже, а окно
   * выбора умеет и поиск, и создание нового прямо на месте.
   */
  const playlistPicker = useAddToPlaylist();

  /*
   * На телефоне действия открываются листом снизу, а не этим меню.
   *
   * Ветвление здесь временное и умрёт вместе с переездом списков на
   * `mobile/TrackRow`. Пока же оно чинит главную жалобу сразу во всех семи
   * списках, которые монтируют эту карточку: выпадающий блок жил
   * `position: absolute` внутри прокручиваемого `<main>` и обрезался им,
   * всегда открывался вниз и висел у правого края.
   */
  const isMobileShell = useMobileShell();
  const openTrackActions = useUIStore((s) => s.openTrackActions);
  const showToast = useUIStore((s) => s.showToast);
  const openArtist = useUIStore((s) => s.openArtist);

  const handleArtistClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (track.artist) {
      openArtist(track.artist);
    }
  };

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [artworkFailed, setArtworkFailed] = useState(false);
  const [overlayActive, setOverlayActive] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  // Offline mode caches what gets played, so the card only reports the fact —
  // there is no per-track download to drive from here any more.
  const checkOffline = useCallback(async () => {
    if (!track?.id) return;
    try {
      setIsDownloaded(await offlineStorage.isDownloaded(track.id));
    } catch {
      // ignore
    }
  }, [track?.id]);

  useEffect(() => {
    void checkOffline();
    const unsubscribe = offlineStorage.subscribe(() => {
      void checkOffline();
    });
    return () => {
      unsubscribe();
    };
  }, [checkOffline]);

  const isCurrent = currentTrack?.id === track.id;
  const isTrackPlaying = isCurrent && isPlaying;
  const sourceLabel = SOURCE_LABELS[track.source] ?? track.source;

  const closeMenu = useCallback((restoreFocus = true) => {
    setIsMenuOpen(false);
    if (restoreFocus) menuTriggerRef.current?.focus();
  }, []);

  // Dismiss the context menu on outside click / Escape, and move focus back to
  // the trigger so keyboard users are not stranded.
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen, closeMenu]);

  /**
   * Play resolution order, fixed by `.agents/CONTRACT.md`:
   * 1. `contextQueue` -> the whole list becomes the queue
   * 2. `onPlay` -> caller decides
   * 3. bare `playTrack`
   */
  const startPlayback = useCallback(() => {
    if (contextQueue) {
      void playTrack(track, contextQueue, index);
      return;
    }
    if (onPlay) {
      onPlay(track);
      return;
    }
    void playTrack(track);
  }, [contextQueue, index, onPlay, playTrack, track]);

  const activate = useCallback(() => {
    if (isCurrent) {
      void togglePlayPause();
      return;
    }
    startPlayback();
  }, [isCurrent, startPlayback, togglePlayPause]);

  const handleActivateClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    activate();
  };

  /** Enter/Space on the row itself; inner buttons keep their own behaviour. */
  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      activate();
    }
  };

  const handleFavoriteClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const wasFavorite = isFavorite;
    const ok = await toggleFavorite(track);
    if (!ok) {
      // Приглашение войти уже на экране — красной строкой поверх него незачем.
      if (refusedForAccount()) return;
      showToast(useLibraryStore.getState().error || 'Не удалось обновить избранное', 'error');
      return;
    }
    showToast(
      wasFavorite ? `«${track.title}» убран из избранного` : `«${track.title}» в избранном`,
      'success'
    );
  };

  const handleAddToQueue = (e: React.MouseEvent) => {
    e.stopPropagation();
    addToQueueEnd(track);
    showToast(`«${track.title}» добавлен в очередь`, 'info');
  };

  const handlePlayNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    addToQueueNext(track);
    showToast(`«${track.title}» прозвучит следующим`, 'info');
  };

  const handleStartTrackRadio = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    void usePlayerStore.getState().startTrackRadio(track);
    showToast(`Запущено радио по треку "${track.title}"`, 'success');
  };

  const handleAddToQueueFromMenu = (e: React.MouseEvent) => {
    closeMenu();
    handleAddToQueue(e);
  };

  const handleFavoriteFromMenu = async (e: React.MouseEvent) => {
    closeMenu();
    await handleFavoriteClick(e);
  };

  const handleOpenPlaylistPicker = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    playlistPicker.open(track);
  };

  const handleOpenSource = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    if (track.sourceUrl) openSourceUrl(track.sourceUrl);
  };

  /** Roving focus inside the context menu. */
  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      // Space has to activate the item here; the global play/pause shortcut
      // would otherwise swallow it before the button ever fires.
      const item = (e.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]');
      if (!item) return;
      e.preventDefault();
      item.click();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []
    );
    if (items.length === 0) return;
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    const from = items.findIndex((item) => item === active);
    let next = 0;
    if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = from < 0 ? 0 : (from + 1) % items.length;
    else if (e.key === 'ArrowUp') next = from < 0 ? items.length - 1 : (from - 1 + items.length) % items.length;
    items[next].focus();
  };

  const contextMenu = (
    <div style={{ position: 'relative' }} ref={menuRef}>
      <button
        type="button"
        ref={menuTriggerRef}
        className="press focus-ring"
        onClick={(e) => {
          e.stopPropagation();
          if (isMobileShell) {
            openTrackActions(track);
            return;
          }
          setIsMenuOpen((open) => !open);
        }}
        aria-label={`Другие действия с «${track.title}»`}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        style={{ padding: 'var(--space-2)', color: 'var(--text-secondary)', cursor: 'pointer' }}
        data-testid={`track-more-btn-${track.id}`}
      >
        <MoreHorizontal size={ICON.md} />
      </button>

      {isMenuOpen && !isMobileShell && (
        <div
          className="panel-raised animate-drop-in scrollbar-thin"
          role="menu"
          aria-label={`Действия с «${track.title}»`}
          onKeyDown={handleMenuKeyDown}
          style={
            {
              // Меню приколото к правому краю кнопки, поэтому и расти обязано
              // оттуда: рост от середины отвязывает его от того, что нажали.
              '--pop-origin': 'top right',
              position: 'absolute',
              right: 0,
              top: '100%',
              marginTop: 'var(--space-1)',
              padding: 'var(--space-1)',
              minWidth: '210px',
              maxHeight: '320px',
              overflowY: 'auto',
              zIndex: 'var(--z-menu)',
            } as React.CSSProperties
          }
          data-testid="track-context-menu"
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            className="menu-item-hover"
            onClick={handlePlayNext}
            data-testid={`menu-play-next-${track.id}`}
          >
            <ListPlus size={ICON.md} aria-hidden="true" />
            <span className="text-truncate">Играть следующим</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="menu-item-hover"
            onClick={handleStartTrackRadio}
            data-testid={`menu-track-radio-${track.id}`}
          >
            <Radio size={ICON.md} aria-hidden="true" />
            <span className="text-truncate">Запустить радио по треку</span>
          </button>

          <button type="button" role="menuitem" className="menu-item-hover" onClick={handleAddToQueueFromMenu}>
            <Plus size={ICON.md} aria-hidden="true" />
            <span className="text-truncate">В конец очереди</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="menu-item-hover"
            onClick={handleFavoriteFromMenu}
            data-testid={`menu-favorite-${track.id}`}
          >
            <Heart
              size={ICON.md}
              aria-hidden="true"
              fill={isFavorite ? 'currentColor' : 'none'}
              style={{ color: isFavorite ? 'var(--danger)' : undefined }}
            />
            <span className="text-truncate">{isFavorite ? 'Убрать из избранного' : 'В избранное'}</span>
          </button>

          {track.sourceUrl && (
            <button type="button" role="menuitem" className="menu-item-hover" onClick={handleOpenSource}>
              <ExternalLink size={ICON.md} aria-hidden="true" />
              <span className="text-truncate">Открыть в {sourceLabel}</span>
            </button>
          )}

          <hr className="divider" style={{ margin: 'var(--space-1) 0' }} />
          <button
            type="button"
            role="menuitem"
            className="menu-item-hover"
            onClick={handleOpenPlaylistPicker}
            data-testid={`menu-add-to-playlist-${track.id}`}
          >
            <Plus size={ICON.md} aria-hidden="true" />
            <span className="text-truncate">Добавить в плейлист…</span>
          </button>
        </div>
      )}

      {/* Окно выбора плейлиста. Живёт рядом с меню, потому что открывается
          только отсюда, а само рисуется поверх всего. */}
      {playlistPicker.element}
    </div>
  );

  const playOverlay = (
    <button
      type="button"
      className="focus-ring"
      onClick={handleActivateClick}
      onMouseEnter={() => setOverlayActive(true)}
      onMouseLeave={() => setOverlayActive(false)}
      onFocus={() => setOverlayActive(true)}
      onBlur={() => setOverlayActive(false)}
      aria-label={isTrackPlaying ? `Пауза: ${track.title}` : `Слушать: ${track.title}`}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--surface-active)',
        opacity: overlayActive || isTrackPlaying ? 1 : 0,
        transition: 'opacity var(--dur-fast) var(--ease-out)',
        cursor: 'pointer',
      }}
      data-testid={`track-artwork-play-${track.id}`}
    >
      <span
        style={{
          width: 'var(--control-lg)',
          height: 'var(--control-lg)',
          borderRadius: 'var(--radius-full)',
          background: 'var(--accent)',
          color: 'var(--text-on-accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isTrackPlaying ? <Pause size={ICON.lg} /> : <Play size={ICON.lg} style={{ marginLeft: '2px' }} />}
      </span>
    </button>
  );

  // --- HERO LAYOUT (top search result) ---
  if (layout === 'hero') {
    return (
      <div
        className={`card ${className}`}
        style={{
          display: 'flex',
          // В строку карточка отдаёт обложке 132 px плюс отступы, и на экране
          // 375 px тексту остаётся 115 — название обрезается на четвёртой
          // букве, а кнопка «Слушать» и длительность режутся пополам. В столбик
          // тому же тексту достаётся вся ширина карточки.
          flexDirection: heroStacked ? 'column' : 'row',
          gap: 'var(--space-5)',
          padding: 'var(--space-5)',
          borderRadius: 'var(--radius-lg)',
          alignItems: heroStacked ? 'stretch' : 'center',
        }}
        data-testid={`track-hero-${track.id}`}
        data-stacked={heroStacked ? 'true' : undefined}
      >
        <TrackArtwork
          track={track}
          size={heroStacked ? 120 : 132}
          radius="var(--radius-md)"
          failed={artworkFailed}
          onFailed={() => setArtworkFailed(true)}
        >
          {playOverlay}
        </TrackArtwork>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span className="section-label">Лучшее совпадение</span>
            <SourceBadge source={track.source} size="xs" />
            {isDownloaded && (
              <span
                title="Доступно офлайн"
                aria-label="Доступно офлайн"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-1)',
                  padding: '2px 6px',
                  borderRadius: 'var(--radius-xs)',
                  backgroundColor: 'var(--surface-active)',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 'var(--weight-semibold)'
                }}
                data-testid={`hero-offline-badge-${track.id}`}
              >
                <CheckCircle2 size={ICON.xs} aria-hidden="true" />
                <span>Офлайн</span>
              </span>
            )}
          </div>

          <h3
            className="text-truncate"
            style={{
              fontSize: 'var(--text-2xl)',
              lineHeight: 'var(--leading-2xl)',
              letterSpacing: 'var(--tracking-2xl)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)',
              margin: 0,
            }}
            title={track.title}
          >
            {track.title}
          </h3>

          <p
            className="text-truncate"
            onClick={handleArtistClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                handleArtistClick(e as unknown as React.MouseEvent);
              }
            }}
            style={{
              fontSize: 'var(--text-base)',
              color: 'var(--text-secondary)',
              margin: 0,
              cursor: 'pointer',
              display: 'inline-block',
              width: 'fit-content'
            }}
            title={`Открыть артиста: ${track.artist}`}
            data-testid={`hero-artist-${track.id}`}
          >
            {track.artist}
          </p>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              marginTop: 'var(--space-2)',
            }}
          >
            <Button
              variant="primary"
              size="sm"
              icon={isTrackPlaying ? <Pause size={ICON.md} /> : <Play size={ICON.md} />}
              onClick={handleActivateClick}
              data-testid="hero-play-btn"
            >
              {isTrackPlaying ? 'Пауза' : 'Слушать'}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="press"
              onClick={handleFavoriteClick}
              title={isFavorite ? 'Убрать из избранного' : 'В избранное'}
              aria-label={isFavorite ? `Убрать «${track.title}» из избранного` : `Добавить «${track.title}» в избранное`}
              aria-pressed={isFavorite}
              style={{ color: isFavorite ? 'var(--danger)' : 'var(--text-secondary)' }}
              data-testid="hero-fav-btn"
            >
              <Heart size={ICON.lg} fill={isFavorite ? 'currentColor' : 'none'} />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="press"
              onClick={handleAddToQueue}
              title="В конец очереди"
              aria-label={`Добавить «${track.title}» в очередь`}
              data-testid="hero-queue-btn"
            >
              <Plus size={ICON.lg} />
            </Button>

            {contextMenu}

            <span
              data-numeric
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-muted)',
                marginLeft: 'auto',
              }}
            >
              {formatDuration(track.duration)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // --- CARD LAYOUT (grids) ---
  if (layout === 'card') {
    return (
      <div
        className={`card-interactive ${className}`}
        aria-selected={isCurrent}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          padding: 'var(--space-3)',
          cursor: 'default',
        }}
        data-testid={`track-card-${track.id}`}
      >
        <TrackArtwork
          track={track}
          size={160}
          radius="var(--radius-sm)"
          failed={artworkFailed}
          onFailed={() => setArtworkFailed(true)}
        >
          {playOverlay}
        </TrackArtwork>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
          <span
            className="text-truncate"
            style={{
              fontSize: 'var(--text-lg)',
              letterSpacing: 'var(--tracking-lg)',
              fontWeight: 'var(--weight-semibold)',
              color: isCurrent ? 'var(--accent-hover)' : 'var(--text-primary)',
            }}
            title={track.title}
          >
            {track.title}
          </span>
          <span
            className="text-truncate"
            onClick={handleArtistClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                handleArtistClick(e as unknown as React.MouseEvent);
              }
            }}
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'inline-block',
              width: 'fit-content'
            }}
            title={`Открыть артиста: ${track.artist}`}
            data-testid={`card-artist-${track.id}`}
          >
            {track.artist}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <SourceBadge source={track.source} size="xs" />
          {isDownloaded && (
            <span
              title="Доступно офлайн"
              aria-label="Доступно офлайн"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                color: 'var(--text-secondary)'
              }}
              data-testid={`card-offline-badge-${track.id}`}
            >
              <CheckCircle2 size={ICON.sm} aria-hidden="true" />
            </span>
          )}
          <span data-numeric style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {formatDuration(track.duration)}
          </span>
          <span style={{ marginLeft: 'auto' }}>{contextMenu}</span>
        </div>
      </div>
    );
  }

  // --- ROW LAYOUT (default) ---
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      aria-label={`Слушать «${track.title}» — ${track.artist}`}
      aria-current={isCurrent ? 'true' : undefined}
      onClick={activate}
      onKeyDown={handleRowKeyDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        background: isCurrent ? 'var(--accent-soft)' : isHovered ? 'var(--surface-hover)' : 'transparent',
        border: `1px solid ${isCurrent ? 'var(--border-accent)' : isHovered ? 'var(--border-strong)' : 'transparent'}`,
        transition: 'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
      }}
      data-testid={`track-row-${track.id}`}
    >
      {showIndex && (
        <div
          aria-hidden="true"
          className="track-row-index hide-on-mobile"
          style={{
            fontSize: 'var(--text-sm)',
            color: isCurrent ? 'var(--accent)' : 'var(--text-muted)',
          }}
        >
          {isTrackPlaying ? (
            <span className="eq-bars">
              <span className="eq-bar" />
              <span className="eq-bar" />
              <span className="eq-bar" />
            </span>
          ) : isHovered ? (
            <Play size={ICON.sm} style={{ color: 'var(--accent)' }} />
          ) : (
            <span data-numeric>{index !== undefined ? index + 1 : ''}</span>
          )}
        </div>
      )}

      <TrackArtwork
        track={track}
        size={40}
        radius="var(--radius-xs)"
        failed={artworkFailed}
        onFailed={() => setArtworkFailed(true)}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span
          className="text-truncate"
          style={{
            fontSize: 'var(--text-base)',
            fontWeight: isCurrent ? 'var(--weight-semibold)' : 'var(--weight-medium)',
            color: isCurrent ? 'var(--accent-hover)' : 'var(--text-primary)',
          }}
          title={track.title}
        >
          {track.title}
        </span>
        <span
          className="text-truncate"
          onClick={handleArtistClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              e.preventDefault();
              handleArtistClick(e as unknown as React.MouseEvent);
            }
          }}
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            display: 'inline-block',
            /*
              * `width: fit-content` без потолка отменял обрезку: коробка росла
              * под текст, `overflow: hidden` резать было нечего, и длинное имя
              * артиста уезжало за строку — «The Midnight Cassette Orchestra»
              * лежало поверх кнопки «ещё». Ширина по тексту нужна, чтобы нажатие
              * попадало в имя, а не в пустоту справа от него; потолок в 100%
              * возвращает многоточие.
              */
            maxWidth: '100%',
            width: 'fit-content'
          }}
          title={`Открыть артиста: ${track.artist}`}
          data-testid={`track-artist-${track.id}`}
        >
          {track.artist}
        </span>
      </div>

      {/*
        * На телефоне из строки уходит всё, что спорит с названием.
        *
        * Строка — самый частый элемент приложения, и в ней соревновались шесть
        * вещей: значок источника, отметка офлайн, длительность, сердце, очередь
        * и «ещё». На 375 px после обложки и кнопок названию оставалось меньше
        * половины ширины. В телефонных плеерах в строке ровно три вещи —
        * обложка, две строки текста и одна кнопка, — и это не мода, а
        * единственное, что туда помещается.
        *
        * Ничего не теряется: «В избранное» и «В конец очереди» уже есть в меню
        * «ещё», а источник и длительность видны в самом плеере.
        */}
      <div className="track-row-meta hide-on-mobile">
        <SourceBadge source={track.source} size="xs" />
        {isDownloaded && (
          <span
            title="Доступно офлайн"
            aria-label="Доступно офлайн"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              color: 'var(--text-secondary)',
              padding: '0 var(--space-1)'
            }}
            data-testid={`track-offline-badge-${track.id}`}
          >
            <CheckCircle2 size={ICON.sm} aria-hidden="true" />
          </span>
        )}
      </div>

      <span
        data-numeric
        className="hide-on-mobile"
        style={{
          fontSize: 'var(--text-sm)',
          color: 'var(--text-muted)',
          width: '48px',
          textAlign: 'right',
          flexShrink: 0,
        }}
      >
        {formatDuration(track.duration)}
      </span>

      <div
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexShrink: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="press focus-ring tap-target hide-on-mobile"
          onClick={handleFavoriteClick}
          title={isFavorite ? 'Убрать из избранного' : 'В избранное'}
          aria-label={isFavorite ? `Убрать «${track.title}» из избранного` : `Добавить «${track.title}» в избранное`}
          aria-pressed={isFavorite}
          style={{
            padding: 'var(--space-2)',
            color: isFavorite ? 'var(--danger)' : 'var(--text-secondary)',
            cursor: 'pointer',
          }}
          data-testid={`track-fav-btn-${track.id}`}
        >
          <Heart size={ICON.md} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>

        <button
          type="button"
          className="press focus-ring tap-target hide-on-mobile"
          onClick={handleAddToQueue}
          title="В конец очереди"
          aria-label={`Добавить «${track.title}» в очередь`}
          style={{ padding: 'var(--space-2)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          data-testid={`track-queue-btn-${track.id}`}
        >
          <Plus size={ICON.md} />
        </button>

        {contextMenu}
      </div>
    </div>
  );
};
