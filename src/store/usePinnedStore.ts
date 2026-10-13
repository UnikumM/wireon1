import { create } from 'zustand';
import * as dbService from '../services/db';
import { Playlist } from '../types/music';

export const PINNED_PLAYLISTS_KEY = 'pinnedPlaylists';
/** Как у Spotify: закреплённых немного, иначе это уже не «наверху», а весь список. */
export const MAX_PINNED = 6;

export interface PinnedStore {
  pinnedIds: string[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Возвращает `false`, когда места наверху больше нет. */
  toggle: (id: string) => boolean;
}

/**
 * Закреплённые плейлисты — всегда первыми в медиатеке.
 *
 * Хранятся на устройстве: это не свойство плейлиста, а то, как человек
 * раскладывает медиатеку именно здесь (на телефоне наверху может быть другое).
 */
export const usePinnedStore = create<PinnedStore>((set, get) => ({
  pinnedIds: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const stored = await dbService.getSetting<unknown>(PINNED_PLAYLISTS_KEY, []);
      const ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
      const local = get().pinnedIds;
      set({ pinnedIds: [...local, ...ids.filter((id) => !local.includes(id))].slice(0, MAX_PINNED), hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  toggle: (id) => {
    const current = get().pinnedIds;
    let next: string[];
    if (current.includes(id)) {
      next = current.filter((x) => x !== id);
    } else {
      if (current.length >= MAX_PINNED) return false;
      next = [id, ...current];
    }
    set({ pinnedIds: next });
    void dbService.setSetting(PINNED_PLAYLISTS_KEY, next).catch(() => undefined);
    return true;
  }
}));

/** Закреплённые — первыми, в порядке закрепления; остальные — как были. */
export function orderPinned<T extends Pick<Playlist, 'id'>>(playlists: ReadonlyArray<T>, pinnedIds: ReadonlyArray<string>): T[] {
  if (pinnedIds.length === 0) return [...playlists];
  const rank = new Map(pinnedIds.map((id, i) => [id, i]));
  const pinned = playlists.filter((p) => rank.has(p.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const rest = playlists.filter((p) => !rank.has(p.id));
  return [...pinned, ...rest];
}
