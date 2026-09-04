import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Heart,
  ListMusic,
  Maximize2,
  Mic,
  Moon,
  MoreHorizontal,
  Music2,
  PictureInPicture2,
  Radio,
  Scissors,
  Waves,
  X
} from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import {
  usePlayerLayoutStore,
  ARTWORK_RADIUS,
  DENSITY_METRICS,
  PROGRESS_STYLE_VARS
} from '../../store/usePlayerLayoutStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { playerSkinControls, playerSkinVars } from '../../styles/playerSkins';
import { useUIStore, refusedForAccount } from '../../store/useUIStore';
import { useDismissable } from '../../hooks';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { Button } from '../common/Button';
import { SourceBadge } from '../common/SourceBadge';
import { VolumeSlider } from '../common/VolumeSlider';
import { formatDuration } from '../../utils/time';
import { AudioVisualizer } from './AudioVisualizer';
import { MarqueeText } from './MarqueeText';
import { MiniProgressLine } from './MiniProgressLine';
import { PlayerProgress } from './PlayerProgress';
import { TransportControls } from './TransportControls';

import { TempoControl } from './TempoControl';
import { KaraokeView } from '../lyrics/KaraokeView';
import { focusMenuItem, useCountdown } from './playerHooks';
import { ICON } from '../../styles/icons';

const SLEEP_TIMER_OPTIONS = [15, 30, 45, 60, 90];

export interface PlayerBarProps {
  className?: string;
}

/**
 * The persistent transport bar: now-playing metadata, transport, timeline,
 * volume, queue/fullscreen toggles and the overflow menu.
 */
export const PlayerBar: React.FC<PlayerBarProps> = ({ className = '' }) => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  // Времени, длительности и буфера здесь нет намеренно: их читает
  // <PlayerProgress>. `timeupdate` приходит четыре раза в секунду, и подписка на
  // этом уровне перерисовывала бы всю полосу — вместе с транспортом, бегущей
  // строкой, меню и караоке — ради двух цифр в таймлайне.
  const volume = usePlayerStore((s) => s.volume);
  // Само воспроизведение полосе нужно только для облика «Винил»: он вращает
  // обложку, пока идёт звук. Подписка дешёвая — флаг меняется от нажатия
  // человека, а не по ходу трека, в отличие от времени выше.
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const error = usePlayerStore((s) => s.error);
  const errorDetail = usePlayerStore((s) => s.errorDetail);
  const isPreviewStream = usePlayerStore((s) => s.isPreviewStream);
  const userQueue = usePlayerStore((s) => s.userQueue);
  const visualizerEnabled = usePlayerStore((s) => s.visualizerEnabled);
  const visualizerPreset = usePlayerStore((s) => s.visualizerPreset);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const autoplayRadio = usePlayerStore((s) => s.autoplayRadio);

  const setVolume = usePlayerStore((s) => s.setVolume);

  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const setAutoplayRadio = usePlayerStore((s) => s.setAutoplayRadio);
  const setVisualizerEnabled = usePlayerStore((s) => s.setVisualizerEnabled);

  const isFavorite = useLibraryStore((s) => (currentTrack ? s.isFavorite(currentTrack.id) : false));
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);

  // Разметка полосы. `layoutHydrated` здесь не читается намеренно: это внутренний
  // флаг стора, и подписка на него добавила бы полосе лишний рендер сразу после
  // запуска — ровно в тот момент, когда на экране появляется первый трек.
  const density = usePlayerLayoutStore((s) => s.density);
  const artworkShape = usePlayerLayoutStore((s) => s.artworkShape);
  const artworkClickAction = usePlayerLayoutStore((s) => s.artworkClickAction);
  const progressStyle = usePlayerLayoutStore((s) => s.progressStyle);
  const skinId = usePlayerLayoutStore((s) => s.skinId);
  const modules = usePlayerLayoutStore((s) => s.modules);
  const hydratePlayerLayout = usePlayerLayoutStore((s) => s.hydratePlayerLayout);

  const metrics = DENSITY_METRICS[density];
  const artworkRadius = ARTWORK_RADIUS[artworkShape];

  /*
   * Тот же единственный порог, что у боковой панели и нижней навигации
   * (DESIGN_SYSTEM §15). Здесь он читается из JS, а не из таблицы стилей, и это
   * вынужденно: геометрию зон полоса задаёт инлайном, а инлайновый стиль
   * сильнее любого правила из `@media`. Прятать зоны правилом было бы нельзя —
   * поэтому на узком экране рисуется другая разметка, а не та же, ужатая.
   */
  const isNarrow = useMediaQuery('(max-width: 768px)');

  const isQueueOpen = useUIStore((s) => s.isQueueOpen);
  const toggleQueue = useUIStore((s) => s.toggleQueue);
  const isLyricsOpen = useUIStore((s) => s.isLyricsOpen);
  const toggleLyrics = useUIStore((s) => s.toggleLyrics);
  const isFullscreenPlayerOpen = useUIStore((s) => s.isFullscreenPlayerOpen);
  const toggleFullscreenPlayer = useUIStore((s) => s.toggleFullscreenPlayer);
  const toggleMiniPlayer = useUIStore((s) => s.toggleMiniPlayer);
  const openArtist = useUIStore((s) => s.openArtist);
  const showToast = useUIStore((s) => s.showToast);

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // The store owns `error` and has no clear action, so dismissal is local: the
  // banner hides until the message changes (loading a track resets it to null).
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  // Only the deadline is stored, so the chosen duration is remembered here to
  // keep the radio group in sync with what the user picked.
  const [sleepMinutes, setSleepMinutes] = useState<number | null>(null);

  const sleepRemaining = useCountdown(sleepTimerEndsAt);

  const { containerRef: menuRef, backdropProps } = useDismissable<HTMLDivElement>({
    isOpen: isMenuOpen,
    onDismiss: () => setIsMenuOpen(false),
    lockScroll: false
  });

  useEffect(() => {
    if (error === null) setDismissedError(null);
  }, [error]);

  // Разметку читает полоса, а не корень приложения: она монтируется вместе с
  // окном и живёт всё время, а стор сам защищён флагом «уже прочитано», так что
  // второй плеер (мини-режим) базу не перечитает.
  useEffect(() => {
    void hydratePlayerLayout();
  }, [hydratePlayerLayout]);

  useEffect(() => {
    if (sleepTimerEndsAt === null) setSleepMinutes(null);
  }, [sleepTimerEndsAt]);

  const showError = error !== null && error !== dismissedError;

  /*
   * Правый край собран в три группы, и каждая из них должна уметь не появляться
   * вовсе. Обёртка нулевой ширины — не безобидная: `gap` работает вокруг каждого
   * элемента строки, включая пустой, поэтому оставленный на месте пустой div
   * даёт двойную паузу между соседями. Отсюда флаги: сначала считаем, есть ли в
   * группе хоть что-то, и только потом рисуем обёртку.
   */
  const showSleepBadge = modules.sleepTimer && sleepTimerEndsAt !== null;
  // Без трека спектру нечего рисовать, и на полосе оставалась пустая рамка
  // 46×28 — по виду кнопка с потерянным значком. Она и была тем «съехавшим
  // значком» слева от громкости: не значок, а холст без звука.
  const showMiniVisualizer =
    modules.visualizer && visualizerEnabled && !isFullscreenPlayerOpen && Boolean(currentTrack);
  const showReadouts = showSleepBadge || showMiniVisualizer;
  const showTrackControls = modules.volume || modules.tempo || modules.lyrics || modules.queue;

  // Что делает нажатие на обложку. `none` — не «кнопка, которая ничего не
  // делает», а вообще не кнопка: иначе она осталась бы в обходе с клавиатуры и
  // обещала бы действие, которого нет.
  const artworkLabel =
    artworkClickAction === 'visualizer' ? 'Визуализация' : 'Открыть плеер на весь экран';
  const handleArtworkClick =
    artworkClickAction === 'visualizer' ? () => setVisualizerEnabled(!visualizerEnabled) : toggleFullscreenPlayer;

  const artworkBox: React.CSSProperties = {
    width: metrics.artworkSize,
    height: metrics.artworkSize,
    flexShrink: 0,
    padding: 0,
    overflow: 'hidden',
    borderRadius: artworkRadius
    // Фон, рамка и наведение — в `.artwork-press` (global.css §14):
    // подсвечивать фон под обложкой бессмысленно, она его закрывает.
  };

  const artworkContent = currentTrack ? (
    currentTrack.artworkUrl ? (
      <img
        src={currentTrack.artworkUrl}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        onError={(event) => {
          event.currentTarget.style.display = 'none';
        }}
      />
    ) : (
      <Music2 size={ICON.xl} aria-hidden="true" style={{ color: 'var(--text-faint)' }} />
    )
  ) : null;

  const handleFavoriteClick = async () => {
    if (!currentTrack) return;
    const wasFavorite = isFavorite;
    const ok = await toggleFavorite(currentTrack);
    if (!ok) {
      if (refusedForAccount()) return;
      showToast('Не удалось обновить избранное', 'error');
      return;
    }
    showToast(
      wasFavorite ? `«${currentTrack.title}» убрана из избранного` : `«${currentTrack.title}» добавлена в избранное`,
      'success'
    );
  };

  const handleArtistClick = () => {
    if (!currentTrack || !currentTrack.artist) return;
    openArtist(currentTrack.artist);
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const container = menuRef.current;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusMenuItem(container, 'next');
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusMenuItem(container, 'prev');
        break;
      case 'Home':
        event.preventDefault();
        focusMenuItem(container, 'first');
        break;
      case 'End':
        event.preventDefault();
        focusMenuItem(container, 'last');
        break;
      default:
        break;
    }
  };

  // Раскладка строки; начертание подписи — на классе `.section-label` внутри,
  // чтобы регистр не доставался значению справа («осталось 14:59»).
  const menuLabelStyle: React.CSSProperties = {
    padding: 'var(--space-2) var(--space-3) var(--space-1)',
    fontSize: 'var(--text-sm)',
    // Заголовки разделов меню — несущий текст, а `--text-faint` даёт на
    // подложке меню 3.25:1 против нужных 4.5:1. См. QueueDrawer: там та же
    // подпись и та же замена на `--text-muted` (5.34:1).
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-2)'
  };

  /*
   * Полоса ошибки. Переменной, потому что разметок у полосы две — обычная и
   * узкая, — а сообщение о том, что трек не заиграл, одинаково важно в обеих.
   * Две копии этого блока разошлись бы при первой же правке текста.
   */
  const errorBanner = showError ? (
      <div
        role="alert"
        style={{
          position: 'absolute',
          bottom: '100%',
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-5)',
          backgroundColor: 'var(--surface-2)',
          borderTop: '1px solid var(--border-subtle)',
          borderBottom: '1px solid var(--border-subtle)',
          borderLeft: '2px solid var(--danger)',
          color: 'var(--danger)',
          fontSize: 'var(--text-sm)'
        }}
        data-testid="player-error"
      >
        <AlertTriangle size={ICON.sm} aria-hidden="true" style={{ flexShrink: 0 }} />
        <span
          className="text-truncate"
          style={{ flex: 1, minWidth: 0 }}
          // The copy is a sentence; the thrown message is the tooltip, so the
          // transcoding, status code and video id stay one hover away.
          title={errorDetail ?? undefined}
          data-testid="player-error-message"
        >
          {error}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setDismissedError(error)}
          aria-label="Скрыть ошибку"
          title="Скрыть"
          style={{ width: 'var(--control-sm)', height: 'var(--control-sm)', color: 'var(--text-muted)' }}
          data-testid="player-error-dismiss"
        >
          <X size={ICON.sm} />
        </Button>
      </div>
  ) : null;

  /*
   * Разметка на телефоне: обложка, название и три кнопки транспорта.
   *
   * Это не «та же полоса, но уже». На 360 px в один ряд не помещаются восемь
   * органов управления с обложкой и таймлайном — они накладываются друг на
   * друга и на нижнюю навигацию, что и было видно. Поэтому здесь ровно то, что
   * нужно на ходу, а всё остальное — громкость, темп, текст, очередь, спектр,
   * перемотка — живёт в плеере на весь экран, и полоса в него открывается.
   *
   * Ничего не пропадает: каждый спрятанный орган в полноэкранном плеере уже
   * есть, иначе прятать было бы нельзя (DESIGN_SYSTEM §15).
   */
  if (isNarrow) {
    return (
      <div
        className={`panel wireon-player-bar ${className}`}
        style={
          {
            position: 'fixed',
            // Над навигацией и над полосой жеста. Навигация добавляет
            // `--safe-bottom` к своей высоте, поэтому здесь та же добавка —
            // без неё полоса легла бы на её верхний край.
            bottom: 'calc(var(--mobile-nav-height) + var(--safe-bottom))',
            left: 'var(--safe-left)',
            right: 'var(--safe-right)',
            height: 'var(--player-bar-space)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: '0 var(--space-3)',
            backgroundColor: 'var(--player-surface)',
            border: 'none',
            borderTop: '1px solid var(--border-subtle)',
            // Скруглений и отступов от краёв нет намеренно: облики полосы
            // придуманы для окна, где под полосой видно фон. Здесь под ней
            // сразу навигация, и парящая карточка превратилась бы в щель.
            borderRadius: 0,
            boxShadow: 'none',
            backdropFilter: 'var(--player-blur)',
            WebkitBackdropFilter: 'var(--player-blur)',
            zIndex: 'var(--z-header)',
            userSelect: 'none',
            ...playerSkinVars(skinId),
            // Высоту и геометрию облика перебиваем обратно: они заданы под
            // окно и на телефоне ломают ряд.
            ['--player-height' as string]: 'var(--player-bar-space)',
            ['--player-inset' as string]: '0px',
            ['--player-lift' as string]: '0px'
          } as React.CSSProperties
        }
        data-testid="player-bar"
        data-player-skin={skinId}
        data-playing={isPlaying ? 'true' : 'false'}
        data-narrow="true"
      >
        {errorBanner}
        <MiniProgressLine />

        {/*
          * Вся левая часть — одна кнопка. Попасть пальцем в обложку 44 px
          * труднее, чем в половину полосы, а действие у них одно и то же:
          * открыть плеер целиком.
          */}
        <button
          type="button"
          className="press"
          onClick={toggleFullscreenPlayer}
          aria-label="Открыть плеер на весь экран"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flex: '1 1 auto',
            minWidth: 0,
            height: '100%',
            padding: 0,
            // Фона здесь нет намеренно: `.press` красит его на наведении и
            // нажатии правилом из таблицы, а инлайновый фон старше правила —
            // с ним нажатие переставало отзываться вовсе (global.css §14).
            // Прозрачным кнопку и так делает сброс (`button { background: none }`).
            border: 'none',
            textAlign: 'left',
            cursor: 'pointer'
          }}
          data-testid="player-narrow-open-fullscreen"
        >
          <div
            className="panel-inset player-artwork"
            style={{
              width: '44px',
              height: '44px',
              flexShrink: 0,
              overflow: 'hidden',
              borderRadius: artworkRadius,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            data-testid="player-artwork"
          >
            {currentTrack ? (
              artworkContent
            ) : (
              <Music2 size={ICON.lg} aria-hidden="true" style={{ color: 'var(--text-faint)' }} />
            )}
          </div>

          <div style={{ minWidth: 0, flex: 1 }}>
            {currentTrack ? (
              <>
                <div
                  style={{
                    fontSize: 'var(--text-sm)',
                    lineHeight: 'var(--leading-sm)',
                    fontWeight: 'var(--weight-medium)',
                    color: 'var(--text-primary)',
                    minWidth: 0
                  }}
                >
                  <MarqueeText text={currentTrack.title} data-testid="player-track-title" />
                </div>
                <div
                  className="text-truncate"
                  style={{
                    fontSize: 'var(--text-xs)',
                    lineHeight: 'var(--leading-xs)',
                    color: 'var(--text-muted)'
                  }}
                  data-testid="player-track-artist"
                >
                  {currentTrack.artist}
                </div>
              </>
            ) : (
              <div
                style={{
                  fontSize: 'var(--text-sm)',
                  lineHeight: 'var(--leading-sm)',
                  color: 'var(--text-muted)'
                }}
              >
                Ничего не играет
              </div>
            )}
          </div>
        </button>

        {/*
          * Перемешивание и повтор сюда не идут: это настройки очереди, а не
          * то, чем управляют на ходу. Они остаются в плеере на весь экран.
          */}
        <TransportControls
          idPrefix="player"
          variant="tight"
          showShuffle={false}
          showRepeat={false}
          showRadio={false}
        />
      </div>
    );
  }

  return (
    <div
      className={`panel wireon-player-bar ${className}`}
      style={
        {
          position: 'fixed',
          // Не 0: на узком окне снизу стоит фиксированная навигация, и полоса
          // плеера легла бы прямо на неё. `--mobile-nav-height` на широком окне
          // равна нулю, так что здесь это по-прежнему низ экрана.
          // `--player-lift` поднимает облики, которые оторваны от края.
          bottom: 'calc(var(--mobile-nav-height) + var(--player-lift))',
          left: 'var(--player-inset)',
          right: 'var(--player-inset)',
          height: 'var(--player-height)',
          display: 'flex',
          alignItems: 'center',
          gap: metrics.barGap,
          padding: metrics.barPadding,
          // Всё, что делает облик, идёт через переменные: инлайновый стиль в этом
          // проекте сильнее таблицы, и `player.css` иначе не смог бы подменить ни
          // фон, ни радиус. Значения по умолчанию там же, в `:root`.
          backgroundColor: 'var(--player-surface)',
          border: 'none',
          borderTop: 'var(--player-border-top)',
          borderRadius: 'var(--player-radius)',
          boxShadow: 'var(--player-shadow)',
          backdropFilter: 'var(--player-blur)',
          WebkitBackdropFilter: 'var(--player-blur)',
          zIndex: 'var(--z-header)',
          userSelect: 'none',
          ...playerSkinVars(skinId),
          // Толщина дорожек — переопределением токенов темы, а не новым классом:
          // и таймлайн, и громкость читают их из наследуемых свойств.
          ...PROGRESS_STYLE_VARS[progressStyle]
        } as React.CSSProperties
      }
      data-testid="player-bar"
      data-player-skin={skinId}
      // Облик «Винил» вращает обложку, пока идёт звук, — состояние приходит
      // атрибутом, потому что менять анимацию из стиля значило бы дёргать
      // пластинку в исходное положение на каждой паузе.
      data-playing={isPlaying ? 'true' : 'false'}
    >
      {errorBanner}
      {/* Now playing */}
      <div
        className="player-zone player-zone-meta"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: metrics.metaGap,
          flex: '1 1 0',
          minWidth: 0,
          maxWidth: '320px'
        }}
      >
        {currentTrack ? (
          <>
            {artworkClickAction === 'none' ? (
              <div
                className="panel-inset player-artwork"
                style={{
                  ...artworkBox,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                data-testid="player-artwork"
              >
                {artworkContent}
              </div>
            ) : (
              <button
                className="artwork-press focus-ring player-artwork"
                onClick={handleArtworkClick}
                aria-label={artworkLabel}
                title={artworkLabel}
                aria-pressed={artworkClickAction === 'visualizer' ? visualizerEnabled : undefined}
                style={artworkBox}
                data-testid="player-artwork-btn"
              >
                {artworkContent}
              </button>
            )}

            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <button
                onClick={toggleFullscreenPlayer}
                className="focus-ring"
                title={currentTrack.title}
                style={{
                  display: 'flex',
                  minWidth: 0,
                  padding: 0,
                  justifyContent: 'flex-start',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 'var(--weight-semibold)',
                  color: 'var(--text-primary)',
                  textAlign: 'left'
                }}
              >
                <MarqueeText text={currentTrack.title} data-testid="player-track-title" />
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
                <button
                  onClick={handleArtistClick}
                  className="text-truncate focus-ring hover-underline"
                  title={`Перейти к артисту: ${currentTrack.artist}`}
                  style={{
                    display: 'block',
                    minWidth: 0,
                    padding: 0,
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-secondary)',
                    textAlign: 'left',
                    cursor: 'pointer'
                  }}
                  data-testid="player-track-artist"
                >
                  {currentTrack.artist}
                </button>
                <SourceBadge source={currentTrack.source} size="xs" />
                {isPreviewStream && (
                  // SoundCloud hands back a 30-second snippet for some uploads.
                  // Without this the track just stops dead a third of the way
                  // into a five-minute song and looks like a bug.
                  <span
                    className="badge"
                    title="Для этой загрузки доступен только 30-секундный отрывок"
                    style={{
                      color: 'var(--warning)',
                      borderColor: 'var(--border-subtle)',
                      backgroundColor: 'var(--warning-soft)',
                      flexShrink: 0
                    }}
                    data-testid="player-preview-badge"
                  >
                    <Scissors size={ICON.xs} aria-hidden="true" />
                    Отрывок
                  </span>
                )}
              </div>
            </div>

            {modules.favorite && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleFavoriteClick}
                title={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                aria-label={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                aria-pressed={isFavorite}
                style={{
                  width: 'var(--control-md)',
                  height: 'var(--control-md)',
                  flexShrink: 0,
                  color: isFavorite ? 'var(--accent)' : 'var(--text-muted)'
                }}
                data-testid="player-fav-btn"
              >
                <Heart size={ICON.md} fill={isFavorite ? 'currentColor' : 'none'} />
              </Button>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: metrics.metaGap, minWidth: 0 }}>
            <div
              className="panel-inset"
              style={{
                width: metrics.artworkSize,
                height: metrics.artworkSize,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: artworkRadius
              }}
            >
              <Music2 size={ICON.xl} aria-hidden="true" style={{ color: 'var(--text-faint)' }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Ничего не играет</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>Выберите трек, чтобы начать</div>
            </div>
          </div>
        )}
      </div>

      {/* Transport + timeline */}
      <div
        className="player-zone player-zone-center"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flex: '1 1 auto',
          maxWidth: '560px',
          minWidth: 0
        }}
      >
        {/*
          Ступень размеров транспорта задаёт облик, а не полоса.

          Облик вправе стать ниже отданной ему высоты («Парящая», «Линия»,
          «Карточка»), и тогда ряд кнопок обязан уложиться в то, что осталось:
          иначе кнопка и таймлайн выходят за скруглённый контур — сверху и снизу
          сразу, как это и было видно на «Парящей». Проп, а не переменная CSS,
          потому что размер глифа у lucide — число в JS.
        */}
        <TransportControls
          idPrefix="player"
          variant={playerSkinControls(skinId)}
          showShuffle={modules.shuffle}
          showRepeat={modules.repeat}
        />
        <PlayerProgress idPrefix="player" />
      </div>

      {/*
        Правый край. Зазор здесь — межгрупповой, а внутри каждой группы свой,
        поуже: до этого все восемь-девять органов управления стояли в один ряд с
        одинаковым шагом, и ряд читался стеной значков без начала и конца. Групп
        три, и делятся они по тому, на что действуют: показания (таймер и
        спектр), звук и содержимое (громкость, темп, текст, очередь), окно
        (мини-плеер, весь экран, остальное). Ни линий, ни рамок между ними —
        группировку держит только расстояние.
      */}
      <div
        className="player-zone player-zone-side"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: metrics.controlsGroupGap,
          flex: '1 1 0',
          minWidth: 0
        }}
      >
        {/*
          Первая группа — показания: и таймер, и спектр сообщают состояние, нажимать
          их необязательно. Условие на всю группу, а не только на её содержимое:
          обёртка нулевой ширины всё равно съедала бы межгрупповой зазор с двух
          сторон, и справа появлялась бы двойная пауза без причины.
        */}
        {showReadouts && (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: metrics.controlsGap }}
            data-testid="player-side-readouts"
          >
            {showSleepBadge && (
              <span
                className="badge"
                data-numeric
                title={`Воспроизведение остановится через ${formatDuration(sleepRemaining)}`}
                style={{ color: 'var(--accent)', borderColor: 'var(--border-accent)', flexShrink: 0 }}
                data-testid="player-sleep-remaining"
              >
                <Moon size={ICON.xs} aria-hidden="true" />
                {formatDuration(sleepRemaining)}
              </span>
            )}

            {/*
              Пока открыт плеер на весь экран, миниатюры здесь нет. Дело не в лишнем
              пикселе: оверлей непрозрачный и держит собственный визуализатор, так что
              этот холст всё равно никому не виден — а requestAnimationFrame у него
              продолжает идти, и два спектра считаются одновременно. Дешевле всего
              снять его с монтирования: эффект визуализатора сам отменит кадр в своей
              уборке.
            */}
            {showMiniVisualizer && (
              <button
                className="artwork-press focus-ring"
                onClick={toggleFullscreenPlayer}
                aria-label="Открыть визуализацию на весь экран"
                title="Открыть визуализацию на весь экран"
                style={{
                  width: '46px',
                  height: '28px',
                  flexShrink: 0,
                  padding: 0,
                  overflow: 'hidden',
                  borderRadius: 'var(--radius-xs)'
                  // Фон, рамка и ответ на наведение — в `.artwork-press`
                  // (global.css §14). Инлайновый фон стоял бы старше правила
                  // таблицы, и холст со спектром на наведение не отзывался бы —
                  // то есть не выглядел бы нажимаемым вообще.
                }}
                data-testid="player-mini-visualizer"
              >
                <AudioVisualizer preset={visualizerPreset} width={46} height={28} />
              </button>
            )}
          </div>
        )}

        {/*
          Вторая группа — то, что относится к самому звуку и к треку: громкость,
          темп, текст, очередь. Все четыре модуля выключаемы, поэтому группа тоже
          проверяется целиком.
        */}
        {showTrackControls && (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: metrics.controlsGap }}
            data-testid="player-side-track-controls"
          >
            {modules.volume && (
              <VolumeSlider volume={volume} isMuted={isMuted} onVolumeChange={setVolume} onToggleMute={toggleMute} />
            )}

            {modules.tempo && <TempoControl />}

            {modules.lyrics && (
              <Button
                variant="ghost"
                size="icon"
                isActive={isLyricsOpen}
                onClick={toggleLyrics}
                title="Текст песни / Караоке"
                aria-label="Текст песни"
                aria-pressed={isLyricsOpen}
                style={{ width: 'var(--control-md)', height: 'var(--control-md)' }}
                data-testid="player-lyrics-btn"
              >
                <Mic size={ICON.md} />
              </Button>
            )}

            {modules.queue && (
              <Button
                variant="ghost"
                size="icon"
                isActive={isQueueOpen}
                onClick={toggleQueue}
                title="Очередь"
                aria-label={userQueue.length > 0 ? `Очередь, далее ${userQueue.length}` : 'Очередь'}
                aria-expanded={isQueueOpen}
                aria-controls="queue-drawer"
                style={{
                  width: 'var(--control-md)',
                  height: 'var(--control-md)',
                  position: 'relative',
                  overflow: 'visible'
                }}
                data-testid="player-queue-btn"
              >
                <ListMusic size={ICON.md} />
                {userQueue.length > 0 && (
                  <span
                    data-numeric
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      top: '-3px',
                      right: '-3px',
                      minWidth: '17px',
                      height: '17px',
                      padding: '0 var(--space-1)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 'var(--radius-full)',
                      backgroundColor: 'var(--accent)',
                      color: 'var(--text-on-accent)',
                      fontSize: 'var(--text-xs)',
                      lineHeight: 1
                    }}
                  >
                    {userQueue.length}
                  </span>
                )}
              </Button>
            )}
          </div>
        )}

        {/*
          Третья группа — окно: куда переехать плеером. Здесь ничего не выключается,
          поэтому и условия нет: обёртка есть всегда, и правый край всегда кончается
          этой тройкой.
        */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: metrics.controlsGap }}
          data-testid="player-side-window"
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void toggleMiniPlayer()}
            title="Мини-плеер (Alt+M)"
            aria-label="Мини-плеер"
            style={{ width: 'var(--control-md)', height: 'var(--control-md)' }}
            data-testid="player-miniplayer-btn"
          >
            <PictureInPicture2 size={ICON.md} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={toggleFullscreenPlayer}
            title="Плеер на весь экран"
            aria-label="Плеер на весь экран"
            style={{ width: 'var(--control-md)', height: 'var(--control-md)' }}
            data-testid="player-fullscreen-btn"
          >
            <Maximize2 size={ICON.md} />
          </Button>

          <div style={{ position: 'relative', flexShrink: 0 }}>
            <Button
              variant="ghost"
              size="icon"
              isActive={isMenuOpen || sleepTimerEndsAt !== null || autoplayRadio}
              onClick={() => setIsMenuOpen((open) => !open)}
              title="Ещё"
              aria-label="Другие настройки плеера"
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              style={{ width: 'var(--control-md)', height: 'var(--control-md)' }}
              data-testid="player-overflow-btn"
            >
              <MoreHorizontal size={ICON.md} />
            </Button>

            {isMenuOpen && (
              <>
                {/* Invisible catcher: a press anywhere else closes the menu. */}
                <div {...backdropProps} style={{ position: 'fixed', inset: 0, zIndex: 1 }} />
                <div
                  ref={menuRef}
                  role="menu"
                  aria-label="Настройки плеера"
                  onKeyDown={handleMenuKeyDown}
                  className="panel-raised animate-pop-in scrollbar-thin"
                  style={
                    {
                      position: 'absolute',
                      right: 0,
                      bottom: 'calc(100% + var(--space-3))',
                      // Growth point at the corner nearest the button. The menu
                      // hangs above the bar, and growing from its own centre read
                      // as a flash mid-screen rather than a follow-on to the press.
                      transformOrigin: 'bottom right',
                      zIndex: 2,
                      width: '264px',
                      maxHeight: '60vh',
                      overflowY: 'auto',
                      padding: 'var(--space-2)',
                      '--ring-offset-color': 'var(--surface-3)'
                    } as React.CSSProperties
                  }
                  data-testid="player-overflow-menu"
                >
                  {modules.sleepTimer && (
                    <>
                      <div style={menuLabelStyle}>
                        <span className="section-label">Таймер сна</span>
                        {sleepTimerEndsAt !== null && (
                          <span data-numeric style={{ color: 'var(--accent)' }}>
                            осталось {formatDuration(sleepRemaining)}
                          </span>
                        )}
                      </div>

                      <div
                        role="group"
                        aria-label="Таймер сна"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, 1fr)',
                          gap: 'var(--space-1)',
                          padding: '0 var(--space-2) var(--space-2)'
                        }}
                      >
                        <button
                          role="menuitemradio"
                          aria-checked={sleepTimerEndsAt === null}
                          data-active={sleepTimerEndsAt === null}
                          className="chip"
                          onClick={() => setSleepTimer(null)}
                          style={{ justifyContent: 'center' }}
                          data-testid="sleep-timer-off"
                        >
                          Выкл
                        </button>
                        {SLEEP_TIMER_OPTIONS.map((minutes) => (
                          <button
                            key={minutes}
                            role="menuitemradio"
                            aria-checked={sleepTimerEndsAt !== null && sleepMinutes === minutes}
                            data-active={sleepTimerEndsAt !== null && sleepMinutes === minutes}
                            className="chip"
                            onClick={() => {
                              setSleepMinutes(minutes);
                              setSleepTimer(minutes);
                              setIsMenuOpen(false);
                            }}
                            style={{ justifyContent: 'center' }}
                            data-testid={`sleep-timer-${minutes}`}
                          >
                            <span data-numeric>{minutes}</span>
                            <span style={{ color: 'var(--text-faint)' }}>мин</span>
                          </button>
                        ))}
                      </div>

                      <div className="divider" role="separator" />
                    </>
                  )}

                  <button
                    role="menuitemcheckbox"
                    aria-checked={autoplayRadio}
                    className="menu-item-hover"
                    onClick={() => setAutoplayRadio(!autoplayRadio)}
                    style={{ alignItems: 'flex-start' }}
                    data-testid="autoplay-radio-toggle"
                  >
                    <Radio size={ICON.md} aria-hidden="true" style={{ marginTop: '2px', flexShrink: 0 }} />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
                      <span style={{ color: 'var(--text-primary)' }}>Автоплей радио</span>
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
                        Продолжать похожими треками, когда очередь закончится
                      </span>
                    </span>
                    <Check
                      size={ICON.md}
                      aria-hidden="true"
                      style={{
                        marginTop: '2px',
                        flexShrink: 0,
                        color: 'var(--accent)',
                        opacity: autoplayRadio ? 1 : 0
                      }}
                    />
                  </button>

                  <button
                    role="menuitemcheckbox"
                    aria-checked={visualizerEnabled}
                    className="menu-item-hover"
                    onClick={() => setVisualizerEnabled(!visualizerEnabled)}
                    data-testid="visualizer-toggle"
                  >
                    <Waves size={ICON.md} aria-hidden="true" style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)' }}>Визуализация</span>
                    <Check
                      size={ICON.md}
                      aria-hidden="true"
                      style={{ flexShrink: 0, color: 'var(--accent)', opacity: visualizerEnabled ? 1 : 0 }}
                    />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Панель с текстом — часть модуля «Текст песни»: без кнопки её нечем
          закрыть, так что убирать надо обе половины сразу. */}
      {modules.lyrics && <KaraokeView />}
    </div>
  );
};
