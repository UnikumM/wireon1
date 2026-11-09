import { usePlayerStore } from '../store/usePlayerStore';
import { publishNowPlaying } from './librarySignal';
import type { UnifiedTrack } from '../types/music';

/**
 * Публикация «что играет здесь» для других устройств (фича 27 плана 4.0).
 *
 * Шлём при смене трека и паузе/продолжении сразу, а пока играет — раз в
 * полминуты, чтобы позиция на другом устройстве не уезжала больше чем на
 * столько. Ссылка на поток и прочее сиюминутное из трека вырезается: другому
 * устройству нужна запись, а не наш временный адрес звука.
 */
const HEARTBEAT_MS = 30_000;

function publicTrack(track: UnifiedTrack): UnifiedTrack {
  const { streamUrl: _url, streamExpiry: _exp, bitrate: _b, format: _f, ...rest } = track;
  return rest;
}

let stop: (() => void) | null = null;

export function startHandoffPublisher(): () => void {
  stop?.();
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastTrackId: string | null = null;
  let lastPlaying: boolean | null = null;

  const publish = () => {
    const state = usePlayerStore.getState();
    if (!state.currentTrack) {
      publishNowPlaying(null);
      return;
    }
    publishNowPlaying({
      track: publicTrack(state.currentTrack),
      position: state.currentTime,
      playing: state.isPlaying
    });
  };

  const unsubscribe = usePlayerStore.subscribe((state) => {
    const trackId = state.currentTrack?.id ?? null;
    if (trackId === lastTrackId && state.isPlaying === lastPlaying) return;
    lastTrackId = trackId;
    lastPlaying = state.isPlaying;
    publish();
    if (timer) clearInterval(timer);
    timer = state.isPlaying ? setInterval(publish, HEARTBEAT_MS) : null;
  });

  stop = () => {
    unsubscribe();
    if (timer) clearInterval(timer);
    timer = null;
    stop = null;
  };
  return stop;
}

export function stopHandoffPublisher(): void {
  stop?.();
}
