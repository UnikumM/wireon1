import React, { useEffect, useMemo, useState } from 'react';
import { Heart, ListMusic, Mic, Minimize2, Music2 } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import {
  usePlayerLayoutStore,
  FULLSCREEN_ARTWORK_RADIUS,
  PROGRESS_STYLE_VARS
} from '../../store/usePlayerLayoutStore';
import { useDismissable, useDominantColor, useSwipeDismiss } from '../../hooks';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { AudioVisualizer } from './AudioVisualizer';
import { MarqueeText } from './MarqueeText';
import { PlayerProgress } from './PlayerProgress';
import { TransportControls } from './TransportControls';
import { TempoControl } from './TempoControl';
import { SourceBadge } from '../common/SourceBadge';
import { VolumeSlider } from '../common/VolumeSlider';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { formatDuration } from '../../utils/time';
import { UnifiedTrack } from '../../types/music';
import { ICON } from '../../styles/icons';
import { AmbientLight, NowPlayingArtwork, useAudioEnergy, useFavoriteToggle } from './core';

const PEEK_LIMIT = 6;

export interface FullscreenPlayerProps {
  className?: string;
}

/**
 * The immersive surface. Two things carry it: a background mixed from the
 * artwork's own colour, and nothing else on screen that isn't the track.
 *
 * The visualizer style is no longer chosen here — it comes from
 * Settings → Внешний вид, so this view opens the way the listener left it.
 */
export const FullscreenPlayer: React.FC<FullscreenPlayerProps> = ({ className = '' }) => {
  const isFullscreenPlayerOpen = useUIStore((s) => s.isFullscreenPlayerOpen);
  const setFullscreenPlayerOpen = useUIStore((s) => s.setFullscreenPlayerOpen);
  const isLyricsOpen = useUIStore((s) => s.isLyricsOpen);
  const toggleLyrics = useUIStore((s) => s.toggleLyrics);
  const openArtist = useUIStore((s) => s.openArtist);

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  // Время читает <PlayerProgress>, а не этот компонент: иначе четыре тика в
  // секунду перерисовывали бы всё окно целиком — обложку, текст песни, очередь.
  /** Один хук на весь экран — тот же порог, что у полосы плеера. */
  const isNarrow = useMediaQuery('(max-width: 768px)');
  // Подпись «80%» у громкости занимает 40 px, которых в узком окне нет.
  const isCompactRow = useMediaQuery('(max-width: 900px)');

  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const userQueue = usePlayerStore((s) => s.userQueue);
  const sourceQueue = usePlayerStore((s) => s.sourceQueue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const shuffleOrder = usePlayerStore((s) => s.shuffleOrder);
  const visualizerEnabled = usePlayerStore((s) => s.visualizerEnabled);
  const visualizerPreset = usePlayerStore((s) => s.visualizerPreset);

  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const jumpToUserQueueTrack = usePlayerStore((s) => s.jumpToUserQueueTrack);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const favorite = useFavoriteToggle(currentTrack);

  // Разметка приходит из «Настройки → Плеер». Гидратацию запускает полоса плеера:
  // она в приложении всегда смонтирована, а этот оверлей — нет.
  const artworkShape = usePlayerLayoutStore((s) => s.artworkShape);
  const progressStyle = usePlayerLayoutStore((s) => s.progressStyle);
  const fullscreenModules = usePlayerLayoutStore((s) => s.fullscreenModules);

  // Hidden by default: the queue is the one thing here that is not the track.
  const [isQueueOpen, setQueueOpen] = useState(false);

  /*
   * Появление отыграно — класс снимается.
   *
   * `.animate-emerge` объявлен с `both`, а его последний кадр — `transform:
   * none`. Заполненная анимация в каскаде **сильнее инлайнового стиля**, то есть
   * сдвиг от жеста не применился бы вообще и никогда: не «пока идёт появление»,
   * а всё время, что окно открыто. Снятый класс оставляет ровно то же состояние
   * (непрозрачность 1, без размытия и сдвига) и заодно убирает постоянный буфер
   * композитора, о котором говорит комментарий у самих кадров.
   */
  const [hasEntered, setHasEntered] = useState(false);

  // Закрытие возвращает появление следующему открытию: компонент не
  // размонтируется, он только перестаёт рисовать.
  useEffect(() => {
    if (!isFullscreenPlayerOpen) setHasEntered(false);
  }, [isFullscreenPlayerOpen]);

  const { containerRef } = useDismissable<HTMLDivElement>({
    isOpen: isFullscreenPlayerOpen,
    onDismiss: () => setFullscreenPlayerOpen(false),
    closeOnOutsideClick: false
  });

  /*
   * Потягивание вниз — второй выход, и на телефоне единственный удобный:
   * кнопка «свернуть» стоит в левом верхнем углу, куда большой палец не
   * достаёт. На широком окне жеста нет — там есть Esc и мышь.
   */
  const swipe = useSwipeDismiss({
    enabled: isNarrow && isFullscreenPlayerOpen,
    onDismiss: () => setFullscreenPlayerOpen(false)
  });

  // Falls back to `var(--accent)` on its own for cross-origin or missing art.
  const ambientColor = useDominantColor(currentTrack?.artworkUrl);
  // Фон дышит в такт, только пока окно открыто и звук идёт: иначе кадровый цикл гонял бы вхолостую.
  const energy = useAudioEnergy(isFullscreenPlayerOpen && isPlaying);

  const upcomingFromSource = useMemo(() => {
    if (sourceQueue.length === 0) return [];

    const order =
      isShuffled && shuffleOrder.length > 0 ? shuffleOrder : sourceQueue.map((_, index) => index);
    const position = order.indexOf(currentIndex);
    const following = position === -1 ? order : order.slice(position + 1);

    return following
      .slice(0, PEEK_LIMIT)
      .map((index) => ({ index, track: sourceQueue[index] }))
      .filter((entry) => Boolean(entry.track));
  }, [sourceQueue, currentIndex, isShuffled, shuffleOrder]);

  if (!isFullscreenPlayerOpen) return null;

  const peekFromUser = userQueue.slice(0, PEEK_LIMIT);
  const peekRows: { key: string; track: UnifiedTrack; play: () => void }[] =
    peekFromUser.length > 0
      ? peekFromUser.map((track, index) => ({
          key: `user-${track.id}-${index}`,
          track,
          play: () => {
            void jumpToUserQueueTrack(index);
          }
        }))
      : upcomingFromSource.map(({ index, track }) => ({
          key: `source-${track.id}-${index}`,
          track,
          play: () => {
            void playTrack(track, sourceQueue, index);
          }
        }));

  // `color-mix` keeps this working for both a sampled `rgb(...)` and the
  // `var(--accent)` fallback, which cannot be turned into an rgba() by hand.
  const wash = (percent: number): string => `color-mix(in srgb, ${ambientColor} ${percent}%, transparent)`;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Полноэкранный плеер"
      /*
        Раскрытие, а не проявление.
        Раньше окно приходило простым `animate-fade-in`: слой на весь экран
        возникал целиком за 220 мс, и это читалось как подмена картинки. Теперь
        подложка собирается из размытия (`animate-emerge`), а содержимое въезжает
        чередой снизу — шапка, обложка, название с транспортом. Череду держит
        `--stagger`, тот же приём, что и в списках.
      */
      className={`player-dither ${hasEntered || swipe.offset > 0 ? '' : 'animate-emerge'} ${className}`}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === 'emerge') {
          setHasEntered(true);
        }
      }}
      {...swipe.handlers}
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: 'var(--z-overlay)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          backgroundColor: 'var(--bg-base)',
          '--ring-offset-color': 'var(--bg-base)',
          /*
           * Слой едет за пальцем один к одному. Перехода на время
           * протаскивания нет намеренно: он превратил бы движение в
           * запаздывание за рукой. Он включается только на возврат и на уход
           * за край, то есть там, где движение идёт само.
           */
          transform: swipe.offset > 0 ? `translate3d(0, ${swipe.offset}px, 0)` : undefined,
          transition: swipe.isDragging ? 'none' : 'transform var(--dur-slow) var(--ease-out)',
          // Скруглённый верх на время жеста — это и есть признак листа,
          // который можно сдвинуть.
          borderTopLeftRadius: swipe.offset > 0 ? 'var(--radius-lg)' : undefined,
          borderTopRightRadius: swipe.offset > 0 ? 'var(--radius-lg)' : undefined,
          // Палец ведёт слой, а не прокручивает страницу под ним.
          touchAction: swipe.isDragging ? 'none' : undefined,
          // Толщина дорожек — теми же токенами, что и в полосе плеера: иначе
          // таймлайн менял бы вид только внизу окна, а тут оставался прежним.
          ...PROGRESS_STYLE_VARS[progressStyle]
        } as React.CSSProperties
      }
      data-testid="fullscreen-player"
    >
      {/* Свет от обложки: два пятна её цвета дрейфуют, пока играет, и замирают на паузе. */}
      <AmbientLight
        color={ambientColor}
        playing={isPlaying}
        intensity="strong"
        artworkUrl={currentTrack?.artworkUrl}
        energy={energy}
        data-testid="fullscreen-ambient"
      />

      {/*
        * Полоска сверху — единственное, что говорит о жесте.
        *
        * Само потягивание вниз ниоткуда не следует: выход с экрана обозначен
        * значком 46×46 в левом верхнем углу, и человек, который его нашёл,
        * больше ничего не ищет. Полоска — тот же знак, что у листа в системных
        * приложениях, и стоит она ровно там, откуда лист тянут.
        */}
      {isNarrow && (
        <div
          aria-hidden="true"
          className="relative row-stretch justify-center pt-2"
          data-testid="fullscreen-grabber"
        >
          <span
            style={{
              width: '36px',
              height: '4px',
              borderRadius: 'var(--radius-pill)',
              backgroundColor: 'var(--text-faint)'
            }}
          />
        </div>
      )}

      <div
        className="animate-rise"
        style={
          {
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            padding: isNarrow ? 'var(--space-3) var(--space-4)' : 'var(--space-5) var(--space-6)',
            '--stagger': 0
          } as React.CSSProperties
        }
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setFullscreenPlayerOpen(false)}
          title="Свернуть (Esc)"
          aria-label="Свернуть полноэкранный плеер"
          className="control-lg"
          data-testid="fullscreen-close-btn"
        >
          <Minimize2 size={ICON.lg} />
        </Button>

        <div className="row gap-2">
          {fullscreenModules.lyrics && (
            <Button
              variant="ghost"
              size="icon"
              isActive={isLyricsOpen}
              onClick={toggleLyrics}
              title={isLyricsOpen ? 'Скрыть текст' : 'Текст песни'}
              aria-label="Текст песни"
              aria-pressed={isLyricsOpen}
              className="control-lg"
              data-testid="fullscreen-lyrics-btn"
            >
              <Mic size={ICON.lg} />
            </Button>
          )}

          {fullscreenModules.queue && (
            <Button
              variant="ghost"
              size="icon"
              isActive={isQueueOpen}
              onClick={() => setQueueOpen((open) => !open)}
              title={isQueueOpen ? 'Скрыть очередь' : 'Показать очередь'}
              aria-label="Очередь"
              aria-pressed={isQueueOpen}
              className="control-lg"
              data-testid="fullscreen-queue-toggle"
            >
              <ListMusic size={ICON.lg} />
            </Button>
          )}
        </div>
      </div>

      {currentTrack ? (
        <>
          <div
            className="relative flex-1 row justify-center gap-7 min-h-0" style={{ padding: isNarrow ? '0 var(--space-4)' : '0 var(--space-6)' }}
          >
            <div
              className="animate-rise"
              style={
                {
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: isNarrow ? 'var(--space-3)' : 'var(--space-5)',
                  minWidth: 0,
                  maxWidth: '560px',
                  width: '100%',
                  /*
                   * Высота — от области, а не от содержимого. Столбец считал
                   * себя по обложке со спектром, выходил выше отведённого места
                   * и центрировался в нём: на 360×800 он был 454 px в области
                   * 380 и вылезал по 37 px вверх и вниз — обложка заезжала под
                   * кнопку «свернуть», спектр под название.
                   */
                  height: '100%',
                  minHeight: 0,
                  // Второй шаг череды: обложка приезжает после шапки.
                  '--stagger': 1
                } as React.CSSProperties
              }
            >
              {fullscreenModules.artwork && (
                <div
                  className="fullscreen-artwork-frame"
                  style={{
                    borderRadius: FULLSCREEN_ARTWORK_RADIUS[artworkShape],
                    // Обложка стоит в собственном цвете, а не в чёрном.
                    boxShadow: `0 24px 60px -24px ${wash(55)}, var(--shadow-lg)`
                  }}
                  data-playing={isPlaying ? 'true' : 'false'}
                >
                  <NowPlayingArtwork
                    track={currentTrack}
                    className="w-full h-full"
                    style={{ borderRadius: FULLSCREEN_ARTWORK_RADIUS[artworkShape] }}
                    fallbackIcon={ICON.hero}
                    // Рамка обложки — до 460 px (player.css, .fullscreen-artwork-frame).
                    size={460}
                    alt={`Обложка «${currentTrack.title}»`}
                    data-testid="fullscreen-artwork"
                  />
                </div>
              )}

              {/* Bare canvas, no inset panel: a frame around the spectrum was the
                  single busiest thing on this screen. */}
              {/*
                * На телефоне спектра нет, и это следствие, а не решение по
                * вкусу: звук там идёт мимо Web Audio (ссылки `googlevideo` без
                * заголовков CORS элемент с `crossOrigin` отвергает целиком, а
                * без него `createMediaElementSource` отдаёт тишину — оба факта
                * замерены на устройстве). Анализатору браться неоткуда, и
                * полоска рисовала бы ровную пунктирную линию при играющей
                * музыке. Пустой прибор хуже отсутствующего: он читается как
                * поломка. Освободившееся место уходит обложке.
                */}
              {!isNarrow && fullscreenModules.visualizer && visualizerEnabled && (
                <div
                  style={{
                    width: '100%',
                    // На телефоне 84 px спектра — это 84 px, отнятые у обложки:
                    // они стоят в одном столбце и делят одну высоту.
                    height: isNarrow ? '56px' : '84px',
                    overflow: 'hidden',
                    flexShrink: 0,
                    opacity: 0.85
                  }}
                >
                  <AudioVisualizer preset={visualizerPreset} width="100%" height={isNarrow ? 56 : 84} />
                </div>
              )}
            </div>

            {fullscreenModules.queue && isQueueOpen && (
              <aside
                aria-labelledby="fullscreen-peek-label"
                className="animate-slide-left shrink-0 self-center stage-queue"
                style={{ width: '320px' }}
                // Очередь прокручивается своим содержимым: жест закрытия здесь
                // забирал бы движение у списка.
                data-swipe-ignore="true"
                data-testid="fullscreen-queue"
              >
                <div
                  id="fullscreen-peek-label"
                  className="section-label"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    padding: '0 var(--space-1) var(--space-2)',
                    // Как в QueueDrawer: подпись раздела — текст, а не декор,
                    // и `--text-faint` не дотягивает до 4.5:1.
                    color: 'var(--text-muted)'
                  }}
                >
                  <ListMusic size={ICON.sm} aria-hidden="true" />
                  {peekFromUser.length > 0 ? 'Далее в очереди' : 'Далее из списка'}
                </div>

                {peekRows.length === 0 ? (
                  <div
                    className="panel-inset p-4 text-xs text-muted text-center"
                    data-testid="fullscreen-peek-empty"
                  >
                    Очередь пуста
                  </div>
                ) : (
                  <ul className="m-0 p-0 list-none">
                    {peekRows.map(({ key, track, play }) => (
                      <li key={key}>
                        <button
                          className="menu-item-hover gap-3 py-2 px-2"
                          onClick={play}
                          title={`Включить «${track.title}»`}
                          aria-label={`Включить «${track.title}»`}
                        >
                          {/* Обложка в списке — без морфа: летает только обложка играющего. */}
                          <NowPlayingArtwork track={track} morph={false} className="stage-queue-art" fallbackIcon={ICON.sm} />
                          <span className="grow block min-0">
                            <span
                              className="text-truncate block text-sm text-primary"
                            >
                              {track.title}
                            </span>
                            <span
                              className="text-truncate block text-xs text-secondary"
                            >
                              {track.artist}
                            </span>
                          </span>
                          <span
                            data-numeric
                            className="text-xs text-muted shrink-0"
                          >
                            {formatDuration(track.duration)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>
            )}
          </div>

          <div
            className="animate-rise"
            style={
              {
                position: 'relative',
                width: '100%',
                maxWidth: '860px',
                margin: '0 auto',
                padding: 'var(--space-5) var(--space-6) var(--space-7)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-4)',
                // Последний шаг: название, таймлайн и транспорт — то, к чему рука
                // идёт сразу, поэтому ждать их дольше трёх кадров нельзя.
                '--stagger': 2
              } as React.CSSProperties
            }
          >
            <div className="row-end gap-4">
              <div className="grow">
                <h1
                  className="m-0 row-stretch min-0 weight-bold text-primary type-3xl font-sans"
                >
                  <MarqueeText text={currentTrack.title} data-testid="fullscreen-track-title" />
                </h1>
                <div
                  className="row gap-2 mt-1 min-0"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (currentTrack.artist) {
                        openArtist(currentTrack.artist);
                      }
                    }}
                    className="text-truncate focus-ring hover-underline type-lg text-secondary p-0 pointer text-left bg-none border-none"
                    title={`Открыть артиста ${currentTrack.artist}`}
                    data-testid="fullscreen-track-artist"
                  >
                    {currentTrack.artist}
                  </button>
                  <SourceBadge source={currentTrack.source} size="sm" />
                </div>
              </div>

              <Button
                variant="ghost"
                size="icon"
                onClick={() => void favorite.toggle()}
                title={favorite.label}
                aria-label={favorite.label}
                aria-pressed={favorite.isFavorite}
                className={`control-lg ${favorite.isFavorite ? 'text-accent' : 'text-muted'}`}
                data-testid="fullscreen-fav-btn"
              >
                <Heart size={ICON.lg} fill={favorite.isFavorite ? 'currentColor' : 'none'} />
              </Button>
            </div>

            <PlayerProgress variant="comfortable" idPrefix="fullscreen" />

            {isNarrow ? (
              /*
                * На телефоне ряд «темп 150 px — транспорт — громкость 150 px»
                * не помещается физически: только боковые колонки с зазорами
                * занимают 332 px из 375, а транспорт сам по себе шире двухсот.
                * Отсюда и вылезающая за рамки плашка темпа.
                *
                * Поэтому здесь два ряда, как в телефонных плеерах: сначала
                * транспорт по центру, под ним — то, что нажимают редко.
                * Громкости нет намеренно: на телефоне ею занимаются кнопки
                * самого телефона, и ползунок рядом с ними — второй орган для
                * одного и того же.
                */
              <div
                className="stack-center gap-4"
              >
                <TransportControls variant="comfortable" idPrefix="fullscreen" />
                <div className="row gap-3">
                  <TempoControl align="left" size="lg" />
                </div>
              </div>
            ) : (
              <div
                style={
                  {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--space-4)'
                  }
                }
              >
                {/*
                  * Боковые колонки делят поровну то, что осталось от транспорта
                  * (400 px). Раньше они были жёсткими 184 px, и ряд требовал
                  * 800 px при колонке в 712: громкость вылезала за край и в узком
                  * окне липла к кнопке «∞».
                  */}
                <div className="min-0 row" style={{ flex: '1 1 0' }}>
                  {/* Mirrors the volume slider on the right, so the transport stays centred. */}
                  <TempoControl align="left" size="lg" />
                </div>
                <TransportControls variant="comfortable" idPrefix="fullscreen" />
                <div className="min-0 row-stretch justify-end" style={{ flex: '1 1 0' }}>
                  <VolumeSlider
                    volume={volume}
                    isMuted={isMuted}
                    onVolumeChange={setVolume}
                    onToggleMute={toggleMute}
                    showPercentage={!isCompactRow}
                  />
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div
          className="relative flex-1 row justify-center p-6"
        >
          {/*
            * Подпись была «Включите трек — и полноэкранный режим оживёт»: обещание
            * вместо указания. Заголовок и так говорит, что показывать нечего, так что
            * от второй строки нужно ровно одно — что сделать, чтобы стало чего.
            */}
          <EmptyState
            icon={<Music2 size={ICON.display} />}
            title="Пока нечего показать"
            description="Включите любой трек."
            data-testid="fullscreen-empty"
          />
        </div>
      )}
    </div>
  );
};
