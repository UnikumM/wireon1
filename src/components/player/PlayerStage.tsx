import React, { useCallback, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronDown,
  Gauge,
  Heart,
  ListMusic,
  Mic2,
  Moon,
  MoreVertical,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward
} from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { useSwipeDismiss } from '../../hooks/useSwipeDismiss';
import { useDismissable } from '../../hooks/useDismissable';
import { useDominantColor } from '../../hooks/useDominantColor';
import { swap } from '../../styles/motion';
import { ICON } from '../../styles/icons';
import { formatDuration } from '../../utils/time';
import type { UnifiedTrack } from '../../types/music';
import { Button } from '../common/Button';
import { Sheet } from '../mobile/Sheet';
import { KaraokeView } from '../lyrics/KaraokeView';
import { SeekBar } from './SeekBar';
import { formatRate, TempoPanel } from './TempoControl';
import { SleepTimerPanel, useSleepCountdown } from './SleepTimerPanel';
import {
  AmbientLight,
  LabelledButton,
  NowPlayingArtwork,
  NowPlayingTitles,
  RoundButton,
  useFavoriteToggle,
  usePlayerTimeline,
  usePlayerTransport,
  useSleepTimer
} from './core';

/**
 * Сцена: плеер на весь экран телефона.
 *
 * Второе тело плеера. Открывается из островка: сам экран проявляется
 * («сменить»), а обложка перелетает из плашки в центр («раскрыться») — один
 * предмет, который меняет форму, а не два экрана, подменяющие друг друга.
 * Закрывается кнопкой, Esc и потягиванием вниз; при жесте слой идёт за пальцем.
 *
 * Фон — свет от обложки: экран приобретает цвет того, что играет.
 */
export const PlayerStage: React.FC = () => {
  const isOpen = useUIStore((s) => s.isFullscreenPlayerOpen);
  const currentTrack = usePlayerTransport().currentTrack;
  return (
    <AnimatePresence>
      {isOpen && currentTrack ? <StageBody key="stage" track={currentTrack} /> : null}
    </AnimatePresence>
  );
};

const StageBody: React.FC<{ track: UnifiedTrack }> = ({ track }) => {
  const setOpen = useUIStore((s) => s.setFullscreenPlayerOpen);
  const toggleQueue = useUIStore((s) => s.toggleQueue);
  const isLyricsOpen = useUIStore((s) => s.isLyricsOpen);
  const setLyricsOpen = useUIStore((s) => s.setLyricsOpen);
  const openTrackActions = useUIStore((s) => s.openTrackActions);

  const {
    isPlaying,
    isShuffled,
    repeatMode,
    playbackRate,
    togglePlayPause,
    nextTrack,
    prevTrack,
    toggleShuffle,
    cycleRepeatMode
  } = usePlayerTransport();
  const { currentTime, duration, buffered, seekTo } = usePlayerTimeline();
  const { sleepTimerEndsAt, sleepAtTrackEnd } = useSleepTimer();
  const sleepRemaining = useSleepCountdown(sleepTimerEndsAt);
  const favorite = useFavoriteToggle(track);

  const [isTempoOpen, setTempoOpen] = useState(false);
  const [isSleepOpen, setSleepOpen] = useState(false);

  // Изменённая скорость видна прямо на кнопке: забытые 0.65× иначе остаются
  // загадкой — «почему песня звучит не так» без единой подсказки на экране.
  const isTempoModified = Math.abs(playbackRate - 1) > 0.001;

  const close = useCallback(() => setOpen(false), [setOpen]);
  const { containerRef } = useDismissable<HTMLDivElement>({ isOpen: true, onDismiss: close });
  const { offset, isDragging, handlers } = useSwipeDismiss({ enabled: true, onDismiss: close });
  const dominant = useDominantColor(track.artworkUrl);

  return (
    <motion.div className="player-stage-host" initial={false} animate={{ opacity: 1 }} exit={{ opacity: 1 }}>
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Плеер"
        className="player-stage"
        // Слой едет за пальцем один к одному; перехода на время жеста нет,
        // иначе движение превращается в запаздывание за рукой.
        style={offset > 0 ? { transform: `translate3d(0, ${offset}px, 0)` } : undefined}
        data-dragging={isDragging ? 'true' : undefined}
        data-testid="mobile-fullscreen-player"
      >
        {/*
          * Фон и ряды управления гаснут каждый сам («сменить»), а обложка — нет:
          * она один предмет с обложкой островка и при закрытии летит в него
          * («раскрыться» наоборот). Если бы гас весь слой, полёт был бы невидим.
          */}
        <motion.div className="player-stage-backdrop" {...swap()}>
          <AmbientLight color={dominant} playing={isPlaying} intensity="strong" artworkUrl={track.artworkUrl} />
        </motion.div>

        {/* Ухватка: сообщает, что экран смахивается, до того как это попробуют. */}
        <motion.div {...handlers} className="row-stretch justify-center shrink-0 py-2 player-stage-grab" {...swap()}>
          <div aria-hidden="true" className="player-stage-grabber" />
        </motion.div>

        <motion.header {...handlers} className="row gap-2 shrink-0 py-2 player-stage-grab" {...swap()}>
          <RoundButton label="Свернуть плеер" onClick={close} data-testid="mobile-fullscreen-close">
            <ChevronDown size={ICON.xl} aria-hidden="true" />
          </RoundButton>
          <span className="flex-1" />
          <RoundButton
            label={`Действия с «${track.title}»`}
            onClick={() => openTrackActions(track)}
            data-testid="mobile-fullscreen-actions"
          >
            <MoreVertical size={ICON.xl} aria-hidden="true" />
          </RoundButton>
        </motion.header>

        <div className="row justify-center py-4 player-stage-art-slot">
          <NowPlayingArtwork
            track={track}
            className="player-stage-artwork"
            fallbackIcon={ICON.hero}
            data-testid="mobile-fullscreen-artwork"
          />
        </div>

        <motion.div className="stack shrink-0" {...swap()}>
        <div className="row gap-3 shrink-0">
          <NowPlayingTitles track={track} size="stage" titleTestId="mobile-fullscreen-title" />
          <RoundButton
            label={favorite.label}
            onClick={() => void favorite.toggle()}
            active={favorite.isFavorite}
            data-testid="mobile-fullscreen-favorite"
          >
            <Heart
              size={ICON.xl}
              fill={favorite.isFavorite ? 'currentColor' : 'none'}
              className={favorite.isFavorite ? 'text-danger' : undefined}
              aria-hidden="true"
            />
          </RoundButton>
        </div>

        <div className="shrink-0 py-3">
          <SeekBar
            currentTime={currentTime}
            duration={duration}
            buffered={buffered}
            onSeek={seekTo}
            variant="comfortable"
            idPrefix="mobile-fullscreen"
          />
        </div>

        {/* Симметричный ряд: «играть» ровно по центру, по два спутника с каждой стороны. */}
        <div className="row justify-between shrink-0 py-2" data-testid="mobile-fullscreen-transport">
          <RoundButton
            label={isShuffled ? 'Выключить перемешивание' : 'Перемешать'}
            onClick={toggleShuffle}
            active={isShuffled}
            data-testid="mobile-fullscreen-shuffle"
          >
            <Shuffle size={ICON.lg} aria-hidden="true" />
          </RoundButton>
          <RoundButton label="Предыдущий трек" onClick={() => void prevTrack()} data-testid="mobile-fullscreen-prev">
            <SkipBack size={ICON.xl} fill="currentColor" aria-hidden="true" />
          </RoundButton>
          <Button
            variant="primary"
            onClick={() => void togglePlayPause()}
            aria-label={isPlaying ? 'Пауза' : 'Играть'}
            className="p-0 shrink-0 player-stage-play"
            data-testid="mobile-fullscreen-play"
          >
            {isPlaying ? (
              <Pause size={ICON['2xl']} fill="currentColor" aria-hidden="true" />
            ) : (
              <Play size={ICON['2xl']} fill="currentColor" aria-hidden="true" />
            )}
          </Button>
          <RoundButton label="Следующий трек" onClick={() => void nextTrack()} data-testid="mobile-fullscreen-next">
            <SkipForward size={ICON.xl} fill="currentColor" aria-hidden="true" />
          </RoundButton>
          <RoundButton
            label={
              repeatMode === 'one' ? 'Повтор одного трека' : repeatMode === 'all' ? 'Повтор очереди' : 'Включить повтор'
            }
            onClick={cycleRepeatMode}
            active={repeatMode !== 'off'}
            data-testid="mobile-fullscreen-repeat"
          >
            {repeatMode === 'one' ? <Repeat1 size={ICON.lg} aria-hidden="true" /> : <Repeat size={ICON.lg} aria-hidden="true" />}
          </RoundButton>
        </div>

        {/* Нижний ряд: текст, темп, сон, очередь — все с подписями внутри кнопки. */}
        <div className="row wrap shrink-0 gap-2 justify-around">
          <LabelledButton
            icon={<Mic2 size={ICON.md} aria-hidden="true" />}
            label="Текст"
            active={isLyricsOpen}
            onClick={() => setLyricsOpen(!isLyricsOpen)}
            data-testid="mobile-fullscreen-lyrics"
          />
          <LabelledButton
            icon={<Gauge size={ICON.md} aria-hidden="true" />}
            label={isTempoModified ? formatRate(playbackRate) : 'Темп'}
            active={isTempoOpen || isTempoModified}
            onClick={() => setTempoOpen(true)}
            data-testid="mobile-fullscreen-tempo"
          />
          <LabelledButton
            icon={<Moon size={ICON.md} aria-hidden="true" />}
            label={sleepAtTrackEnd ? 'Конец трека' : sleepRemaining !== null ? formatDuration(sleepRemaining) : 'Сон'}
            active={isSleepOpen || sleepAtTrackEnd || sleepRemaining !== null}
            onClick={() => setSleepOpen(true)}
            data-testid="mobile-fullscreen-sleep"
          />
          <LabelledButton
            icon={<ListMusic size={ICON.md} aria-hidden="true" />}
            label="Очередь"
            onClick={toggleQueue}
            data-testid="mobile-fullscreen-queue"
          />
        </div>
        </motion.div>

        {/* Темп и сон — листами снизу: панель у кнопки на 360 px уезжала за край. */}
        <Sheet isOpen={isTempoOpen} onClose={() => setTempoOpen(false)} title="Настроить песню" data-testid="mobile-tempo-sheet">
          <div className="player-stage-sheet-body">
            <TempoPanel columns={1} />
          </div>
        </Sheet>

        <Sheet isOpen={isSleepOpen} onClose={() => setSleepOpen(false)} title="Таймер сна" data-testid="mobile-sleep-sheet">
          <div className="player-stage-sheet-body">
            <SleepTimerPanel onPicked={() => setSleepOpen(false)} />
          </div>
        </Sheet>

        {isLyricsOpen && <KaraokeView onClose={() => setLyricsOpen(false)} />}
      </div>
    </motion.div>
  );
};
