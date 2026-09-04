import { useEffect } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { MediaKeyAction } from '../types/electron';

/**
 * The renderer half of the desktop media keys: the main process already registers
 * `globalShortcut` accelerators, but nothing was listening to the IPC they emit.
 * No-ops in the web build, where `window.electronAPI` is absent.
 */
export function useMediaKeys(): void {
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api || typeof api.onMediaKey !== 'function') return;

    const unsubscribe = api.onMediaKey((action: MediaKeyAction) => {
      const player = usePlayerStore.getState();

      switch (action) {
        case 'play-pause':
          void player.togglePlayPause();
          break;
        case 'next':
          void player.nextTrack(true);
          break;
        case 'prev':
          void player.prevTrack();
          break;
        case 'stop':
          player.pause();
          player.seekTo(0);
          break;
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);
}
