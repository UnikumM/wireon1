import { usePlayerStore } from '../../../store/usePlayerStore';

/**
 * Состояние и действия транспорта — одним хуком для всех тел плеера.
 *
 * До 4.0 полоса, сцена, мобильная плашка и мини-окно каждый переписывали по
 * пятнадцать селекторов на одни и те же поля. Здесь они собраны один раз.
 * Селекторы остаются отдельными: zustand сравнивает каждое поле само, и
 * компонент перерисовывается ровно тогда, когда менялось бы и раньше.
 *
 * Времени, длительности и буфера здесь нет намеренно: `timeupdate` приходит
 * четыре раза в секунду, и тело плеера не должно перерисовываться из-за двух
 * цифр в таймлайне. Их читает `usePlayerTimeline` там, где они нужны.
 */
export function usePlayerTransport() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const playbackRate = usePlayerStore((s) => s.playbackRate);

  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);

  return {
    currentTrack,
    isPlaying,
    isLoading,
    isShuffled,
    repeatMode,
    volume,
    isMuted,
    playbackRate,
    togglePlayPause,
    nextTrack,
    prevTrack,
    toggleShuffle,
    cycleRepeatMode,
    setVolume,
    toggleMute
  };
}

/** Время трека — отдельно, чтобы подписываться на него только там, где оно рисуется. */
export function usePlayerTimeline() {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const buffered = usePlayerStore((s) => s.buffered);
  const seekTo = usePlayerStore((s) => s.seekTo);
  return { currentTime, duration, buffered, seekTo };
}

/** Таймер сна: состояние и действия. */
export function useSleepTimer() {
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtTrackEnd = usePlayerStore((s) => s.sleepAtTrackEnd);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const setSleepAtTrackEnd = usePlayerStore((s) => s.setSleepAtTrackEnd);
  return { sleepTimerEndsAt, sleepAtTrackEnd, setSleepTimer, setSleepAtTrackEnd };
}
