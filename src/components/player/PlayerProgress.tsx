import React from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { SeekBar } from './SeekBar';
import { useTrackWaveform } from './core/useTrackWaveform';

export interface PlayerProgressProps {
  /** `compact` — полоса плеера, `comfortable` — плеер на весь экран. */
  variant?: 'compact' | 'comfortable';
  idPrefix?: string;
  className?: string;
}

/**
 * Таймлайн, который сам подписан на время воспроизведения.
 *
 * Зачем эта прослойка. `timeupdate` у <audio> приходит примерно четыре раза в
 * секунду, и раньше время читали полоса плеера и полноэкранный плеер — то есть
 * самые большие деревья приложения. Каждый тик перерисовывал их целиком: кнопки
 * транспорта, бегущую строку с названием, меню, обложку. Менялись при этом две
 * цифры и ширина одной заливки.
 *
 * Подписка живёт здесь, поэтому родитель на тик не реагирует вовсе, а
 * перерисовывается только сам таймлайн. Никаких `memo` для этого не нужно: в
 * Zustand компонент будит именно тот срез состояния, который он читает.
 */
export const PlayerProgress: React.FC<PlayerProgressProps> = ({
  variant = 'compact',
  idPrefix = 'player',
  className = ''
}) => {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const buffered = usePlayerStore((s) => s.buffered);
  const seekTo = usePlayerStore((s) => s.seekTo);

  // Волна нужна только просторному варианту; компактный трек не читает вовсе,
  // чтобы полоса плеера не просыпалась на смену трека ради ничего.
  const currentTrack = usePlayerStore((s) => (variant === 'comfortable' ? s.currentTrack : null));
  const waveform = useTrackWaveform(currentTrack);

  return (
    <SeekBar
      currentTime={currentTime}
      duration={duration}
      buffered={buffered}
      onSeek={seekTo}
      variant={variant}
      idPrefix={idPrefix}
      className={className}
      waveform={waveform}
    />
  );
};
