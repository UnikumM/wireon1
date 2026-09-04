import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useUIStore } from '../store/useUIStore';
import { usePlayerLayoutStore } from '../store/usePlayerLayoutStore';
import { useDominantColor } from './useDominantColor';
import type { MiniPlayerCommand, MiniPlayerState } from '../types/electron';

/** How often the snapshot is compared and, if changed, pushed to the mini window. */
const PUSH_INTERVAL_MS = 500;

function buildState(accent: string | null): MiniPlayerState {
  const player = usePlayerStore.getState();
  const track = player.currentTrack;
  return {
    title: track?.title ?? '',
    artist: track?.artist ?? '',
    artwork: track?.artworkUrl ?? null,
    isPlaying: player.isPlaying,
    // Whole seconds only: the mini player shows mm:ss, so sub-second churn would
    // push a snapshot 60 times a second for no visible change.
    currentTime: Math.floor(player.currentTime),
    duration: Math.floor(player.duration),
    volume: player.isMuted ? 0 : player.volume,
    isFavorite: track ? useLibraryStore.getState().isFavorite(track.id) : false,
    shuffle: player.isShuffled,
    repeat: player.repeatMode,
    accent,
    // Облик едет вместе с состоянием, а не отдельным каналом: снимок и так
    // сравнивается целиком перед отправкой, поэтому смена настройки в этом окне
    // сама доезжает до мини-окна ближайшим тиком, а нового провода не появляется.
    skin: usePlayerLayoutStore.getState().miniSkinId
  };
}

async function applyCommand(command: MiniPlayerCommand): Promise<void> {
  const player = usePlayerStore.getState();
  switch (command.type) {
    case 'play-pause':
      await player.togglePlayPause();
      break;
    case 'next':
      await player.nextTrack(true);
      break;
    case 'prev':
      await player.prevTrack();
      break;
    case 'seek':
      player.seekTo(command.value);
      break;
    case 'volume':
      player.setVolume(command.value);
      break;
    case 'toggle-favorite': {
      const track = player.currentTrack;
      if (track) await useLibraryStore.getState().toggleFavorite(track);
      break;
    }
    case 'shuffle':
      player.toggleShuffle();
      break;
    case 'repeat':
      player.cycleRepeatMode();
      break;
    default:
      // `request-state` and `focus-main` need no store work; the push loop and the
      // main process handle them respectively.
      break;
  }
}

/**
 * Main-window half of the mini player: it answers the mini window's commands and
 * keeps it fed with state snapshots.
 *
 * The mini window is a separate renderer with its own store instances, so nothing
 * is shared automatically — this hook is the only link, and it deliberately runs
 * even when the mini window is closed so that opening it never races a mount.
 */
export function useMiniPlayerHost(): void {
  const artworkUrl = usePlayerStore((s) => s.currentTrack?.artworkUrl ?? null);
  const accent = useDominantColor(artworkUrl);
  const accentRef = useRef(accent);
  accentRef.current = accent;

  // The command listener and the push loop are registered once; both read live
  // state through `getState()`, so neither needs to re-subscribe on every render.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api?.onMiniCommand || !api.sendMiniState) return;

    let lastSent = '';

    const push = (force = false) => {
      const state = buildState(accentRef.current);
      const serialized = JSON.stringify(state);
      if (!force && serialized === lastSent) return;
      lastSent = serialized;
      api.sendMiniState?.(state);
    };

    const unsubscribeCommand = api.onMiniCommand((command) => {
      // The push waits for the command to settle. Pushing straight after
      // dispatching would send the state from *before* the command — the mini
      // window would snap back to "paused" for half a second after every click.
      void applyCommand(command)
        .catch((err) => {
          console.warn('[useMiniPlayerHost] command failed:', command.type, err);
        })
        .finally(() => push(true));
    });

    const unsubscribeVisibility = api.onMiniWindowVisibility?.((open) => {
      useUIStore.setState({ isMiniPlayerOpen: open });
      if (open) push(true);
    });

    const timer = window.setInterval(() => push(), PUSH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      unsubscribeCommand();
      unsubscribeVisibility?.();
    };
  }, []);
}
