import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { ICON } from '../../styles/icons';
import { SeekBar } from './SeekBar';
import { VolumeSlider } from '../common/VolumeSlider';
import { NowPlayingArtwork, NowPlayingTitles, RoundButton, usePlayerTimeline, usePlayerTransport } from './core';

/** Порог, за которым в плашке появляются перемотка, соседние треки и громкость. */
export const ROOMY_ISLAND_WIDTH_PX = 480;

/**
 * Островок: плашка играющего трека на телефоне.
 *
 * Это первое из трёх тел плеера (островок → сцена; на ПК — полоса). Обложка в
 * нём несёт общий `layoutId`, и когда сцена раскрывается, та же обложка
 * перелетает в центр экрана, а не появляется заново: человек видит, куда
 * делся предмет, который он только что нажал.
 *
 * Решения, унаследованные от прежней полосы и проверенные тестами:
 *
 * - **Плавающая плашка, а не приклеенная полоса**: отступ и скругление
 *   отделяют её от нижней панели.
 * - **Одна кнопка вместо трёх** на телефонной ширине: перемотка и соседи
 *   живут на сцене. В узком окне ПК, где есть мышь, они возвращаются — решает
 *   место, а не устройство: плашка смотрит на собственную ширину.
 * - **Прогресс — волосяная линия по низу**, пока места нет.
 */
export const PlayerIsland: React.FC = () => {
  const { currentTrack, isPlaying, togglePlayPause, nextTrack, prevTrack, volume, isMuted, setVolume, toggleMute } =
    usePlayerTransport();
  const { currentTime, duration, buffered, seekTo } = usePlayerTimeline();
  const setFullscreenPlayerOpen = useUIStore((s) => s.setFullscreenPlayerOpen);

  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    // Замер сразу: `ResizeObserver` сообщает об изменении, и первое сообщение в
    // фоновой вкладке приходит не всегда — ширина оставалась бы нулём навсегда.
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
    // Пока играть нечего, плашки в разметке нет, и наблюдатель, запущенный без
    // зависимости от трека, не нашёл бы элемента и больше не повторялся.
  }, [currentTrack]);

  const hasRoom = width >= ROOMY_ISLAND_WIDTH_PX;

  // Пустая плашка не рисуется вовсе: место, отвечающее на незаданный вопрос.
  if (!currentTrack) return null;

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div ref={rootRef} className="player-island" data-testid="mobile-player-bar">
      <div className="row player-island-row">
        <button
          type="button"
          className="press row gap-3 grow player-island-open"
          onClick={() => setFullscreenPlayerOpen(true)}
          aria-label={`Открыть плеер: ${currentTrack.title}`}
          data-testid="mobile-player-open-fullscreen"
        >
          <NowPlayingArtwork track={currentTrack} className="player-island-artwork" fallbackIcon={ICON.md} />
          <NowPlayingTitles track={currentTrack} size="bar" />
        </button>

        {hasRoom && (
          <RoundButton label="Предыдущий трек" size="md" onClick={() => void prevTrack()} data-testid="mobile-player-prev">
            <SkipBack size={ICON.lg} fill="currentColor" aria-hidden="true" />
          </RoundButton>
        )}

        <button
          type="button"
          className="press focus-ring row justify-center shrink-0 mr-1 pointer player-island-play"
          onClick={() => void togglePlayPause()}
          aria-label={isPlaying ? 'Пауза' : 'Играть'}
          data-testid="mobile-player-play-pause"
        >
          {isPlaying ? (
            <Pause size={ICON.xl} fill="currentColor" aria-hidden="true" />
          ) : (
            <Play size={ICON.xl} fill="currentColor" aria-hidden="true" />
          )}
        </button>

        {hasRoom && (
          <>
            <RoundButton label="Следующий трек" size="md" onClick={() => void nextTrack()} data-testid="mobile-player-next">
              <SkipForward size={ICON.lg} fill="currentColor" aria-hidden="true" />
            </RoundButton>
            <VolumeSlider
              volume={volume}
              isMuted={isMuted}
              onVolumeChange={setVolume}
              onToggleMute={toggleMute}
              width="88px"
              className="shrink-0 mr-2"
            />
          </>
        )}
      </div>

      {hasRoom ? (
        <div className="player-island-seek">
          <SeekBar
            currentTime={currentTime}
            duration={duration}
            buffered={buffered}
            onSeek={seekTo}
            variant="compact"
            idPrefix="mobile-player"
          />
        </div>
      ) : (
        <div className="player-island-hairline" aria-hidden="true">
          <span style={{ width: `${progress}%` }} data-testid="mobile-player-progress" />
        </div>
      )}
    </div>
  );
};
