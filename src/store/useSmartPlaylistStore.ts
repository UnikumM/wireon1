import { create } from 'zustand';
import * as dbService from '../services/db';
import {
  SmartPlaylist,
  newSmartPlaylistId,
  sanitizeSmartPlaylists
} from '../services/smartPlaylists';

/** Ключ в настройках. Умные плейлисты живут на устройстве — у них нет треков, только правила. */
export const SMART_PLAYLISTS_KEY = 'smartPlaylists';

export interface SmartPlaylistStore {
  playlists: SmartPlaylist[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  create: (draft: Omit<SmartPlaylist, 'id' | 'createdAt' | 'updatedAt'>) => SmartPlaylist;
  update: (id: string, patch: Partial<Omit<SmartPlaylist, 'id' | 'createdAt'>>) => void;
  remove: (id: string) => void;
}

function persist(playlists: SmartPlaylist[]): void {
  void dbService.setSetting(SMART_PLAYLISTS_KEY, playlists).catch((err: unknown) => {
    console.warn('[useSmartPlaylistStore] не удалось сохранить:', err);
  });
}

export const useSmartPlaylistStore = create<SmartPlaylistStore>((set, get) => ({
  playlists: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const stored = await dbService.getSetting<unknown>(SMART_PLAYLISTS_KEY, []);
      // Пока читали, человек мог уже создать плейлист: прочитанное не должно его стереть.
      const fresh = sanitizeSmartPlaylists(stored);
      const local = get().playlists.filter((p) => !fresh.some((f) => f.id === p.id));
      set({ playlists: [...local, ...fresh], hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  create: (draft) => {
    const now = Date.now();
    const playlist: SmartPlaylist = { ...draft, id: newSmartPlaylistId(), createdAt: now, updatedAt: now };
    const playlists = [playlist, ...get().playlists];
    set({ playlists });
    persist(playlists);
    return playlist;
  },

  update: (id, patch) => {
    const playlists = get().playlists.map((p) => (p.id === id ? { ...p, ...patch, id, updatedAt: Date.now() } : p));
    set({ playlists });
    persist(playlists);
  },

  remove: (id) => {
    const playlists = get().playlists.filter((p) => p.id !== id);
    set({ playlists });
    persist(playlists);
  }
}));
