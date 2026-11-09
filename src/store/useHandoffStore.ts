import { create } from 'zustand';
import type { RemotePlaying } from '../services/librarySignal';
import { usePlayerStore } from './usePlayerStore';

/**
 * «Продолжить на другом устройстве» (фича 27 плана 4.0).
 *
 * Другое устройство человека сообщило через брокер, что у него играет. Здесь
 * это хранится до тех пор, пока человек не продолжит отсюда, не отмахнётся или
 * пока оттуда не придёт «остановились». Своё воспроизведение сюда не попадает:
 * librarySignal отсекает собственный номер устройства.
 */
export interface HandoffStore {
  remote: RemotePlaying | null;
  /** Отмахнулись от этого именно сообщения: новое с другой позицией покажется снова. */
  dismissedAt: number | null;
  setRemote: (remote: RemotePlaying | null) => void;
  dismiss: () => void;
  /** Включить здесь то, что играло там, с той же секунды (досчитанной, если там играет). */
  takeOver: () => Promise<void>;
}

/** Где в треке сейчас другое устройство — по снимку и часам. */
export function remotePosition(remote: RemotePlaying, now: number = Date.now()): number {
  if (!remote.playing) return remote.position;
  const elapsed = Math.max(0, (now - remote.at) / 1000);
  const position = remote.position + elapsed;
  return remote.track.duration > 0 ? Math.min(position, remote.track.duration) : position;
}

export const useHandoffStore = create<HandoffStore>((set, get) => ({
  remote: null,
  dismissedAt: null,

  setRemote: (remote) => {
    const current = get();
    // То же самое сообщение не воскрешает отмахнутую плашку.
    if (remote && current.dismissedAt !== null && remote.at <= current.dismissedAt) return;
    set({ remote, dismissedAt: remote ? current.dismissedAt : null });
  },

  dismiss: () => {
    const remote = get().remote;
    set({ remote: null, dismissedAt: remote ? remote.at : Date.now() });
  },

  takeOver: async () => {
    const remote = get().remote;
    if (!remote) return;
    const position = remotePosition(remote);
    const player = usePlayerStore.getState();
    set({ remote: null, dismissedAt: remote.at });
    await player.playTrack(remote.track);
    // Перемотка после старта: до загрузки seekTo некуда применять.
    if (position > 1) usePlayerStore.getState().seekTo(position);
  }
}));
