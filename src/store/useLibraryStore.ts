import { create } from 'zustand';
import { UnifiedTrack, Playlist } from '../types/music';
import * as dbService from '../services/db';
import { cloudSyncEngine } from '../services/cloudSync';
import { useAuthStore } from './useAuthStore';
import { useUIStore } from './useUIStore';

/**
 * Canonical library store shape.
 *
 * Error policy (M6): every action the UI triggers from an event handler catches
 * its own failures, records a human-readable `error` in the store, leaves the
 * rest of the state untouched and resolves with `false` (or `null` for
 * `createPlaylist`). Nothing rejects, so no caller needs a `catch`.
 */
export interface LibraryStoreState {
  favorites: UnifiedTrack[];
  playlists: Playlist[];
  history: UnifiedTrack[];
  isLoading: boolean;
  error: string | null;
}

export interface LibraryStoreActions {
  loadInitialData: () => Promise<boolean>;
  toggleFavorite: (track: UnifiedTrack) => Promise<boolean>;
  isFavorite: (trackId: string) => boolean;
  createPlaylist: (title: string, description?: string) => Promise<Playlist | null>;
  deletePlaylist: (playlistId: string) => Promise<boolean>;
  renamePlaylist: (playlistId: string, newTitle: string) => Promise<boolean>;
  addTrackToPlaylist: (playlistId: string, track: UnifiedTrack) => Promise<boolean>;
  removeTrackFromPlaylist: (playlistId: string, trackIndex: number) => Promise<boolean>;
  reorderPlaylistTracks: (playlistId: string, fromIndex: number, toIndex: number) => Promise<boolean>;
  addToHistory: (track: UnifiedTrack) => Promise<boolean>;
  clearHistory: () => Promise<boolean>;
  clearError: () => void;
}

export type LibraryStore = LibraryStoreState & LibraryStoreActions;

/**
 * Пускать ли к записи в медиатеку.
 *
 * Медиатека принадлежит аккаунту Discord — сервер по нему и узнаёт, чей это
 * шкаф. У гостя аккаунта нет, значит нет и второй половины: собранное на
 * телефоне на компьютере не появится, и наоборот. Раньше приложение этого не
 * говорило — оно послушно сохраняло в местную базу, и человек узнавал правду
 * только тогда, когда открывал второе устройство и не находил там ничего.
 *
 * Отсюда развилка: новое в медиатеку — со входом, а всё, что уже лежит на
 * устройстве, гость по-прежнему может убрать, переименовать и удалить. Запирать
 * человека внутри его же данных было бы наказанием, а не правилом.
 */
function requiresAccount(reason: string): boolean {
  if (useAuthStore.getState().isAuthenticated) return false;
  useUIStore.getState().requireAccount(reason);
  return true;
}

export const useLibraryStore = create<LibraryStore>((set, get) => {
  const fail = (summary: string, err: unknown): false => {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[useLibraryStore] ${summary}:`, err);
    set({ error: `${summary}: ${detail}` });
    return false;
  };

  /** Replaces a playlist with the record the database just stored. */
  const commitPlaylist = (updated: Playlist) => {
    set((s) => ({
      playlists: s.playlists.map((p) => (p.id === updated.id ? updated : p)),
      error: null
    }));
  };

  return {
    favorites: [],
    playlists: [],
    history: [],
    isLoading: false,
    error: null,

    clearError: () => {
      set({ error: null });
    },

    loadInitialData: async () => {
      set({ isLoading: true });
      try {
        const [favorites, playlists, history] = await Promise.all([
          dbService.getFavorites(),
          dbService.getPlaylists(),
          dbService.getHistoryTracks()
        ]);

        set({ favorites, playlists, history, isLoading: false, error: null });
        return true;
      } catch (err) {
        set({ isLoading: false });
        return fail('Не удалось загрузить медиатеку', err);
      }
    },

    toggleFavorite: async (track: UnifiedTrack) => {
      if (!track || !track.id) {
        return fail('Не удалось обновить избранное', new Error('У трека нет id'));
      }

      const isFav = get().favorites.some((t) => t.id === track.id);

      // Убрать из избранного гостю можно: это его записи, лежащие здесь же.
      if (!isFav && requiresAccount('добавлять треки в избранное')) return false;

      try {
        if (isFav) {
          await dbService.removeFavorite(track.id);
          set((s) => ({
            favorites: s.favorites.filter((t) => t.id !== track.id),
            error: null
          }));
          // Пополнение уезжает на сервер само: подписка на этот стор отправляет
          // медиатеку целиком. С удалением так нельзя — отправить «этого больше
          // нет» отправкой того, что осталось, невозможно, и сервер честно
          // возвращал запись обратно ближайшей сверкой. Отсюда отдельный вызов.
          void cloudSyncEngine.rememberDeletion('favorite', track.id);
        } else {
          /*
           * Отметка ставится заново, а не берётся с объекта.
           *
           * `addedAt` — это «когда положили в медиатеку», и при повторном
           * добавлении она обязана быть новой. Объект трека переживает
           * удаление: он лежит в очереди, в результатах поиска, в плеере — и
           * приносит с собой прошлогоднюю дату. По ней сервер сравнивает
           * запись с надгробием и, увидев, что «новое» старше удаления,
           * отказывался её принимать. Со стороны это выглядело хуже всего:
           * сердечко вернули, а следующая сверка снимала его снова.
           */
          const item: UnifiedTrack = { ...track, addedAt: Date.now() };
          await dbService.addFavorite(item);
          set((s) => ({
            favorites: [item, ...s.favorites.filter((t) => t.id !== track.id)],
            error: null
          }));
        }
        return true;
      } catch (err) {
        return fail(`Не удалось ${isFav ? 'убрать из избранного' : 'добавить в избранное'} «${track.title}»`, err);
      }
    },

    isFavorite: (trackId: string) => {
      if (!trackId) return false;
      return get().favorites.some((t) => t.id === trackId);
    },

    createPlaylist: async (title: string, description?: string) => {
      if (requiresAccount('создавать плейлисты')) return null;

      try {
        const newPlaylist = await dbService.createPlaylist(title, description);
        set((s) => ({
          playlists: [newPlaylist, ...s.playlists],
          error: null
        }));
        return newPlaylist;
      } catch (err) {
        fail('Не удалось создать плейлист', err);
        return null;
      }
    },

    deletePlaylist: async (playlistId: string) => {
      try {
        await dbService.deletePlaylist(playlistId);
        set((s) => ({
          playlists: s.playlists.filter((p) => p.id !== playlistId),
          error: null
        }));
        void cloudSyncEngine.rememberDeletion('playlist', playlistId);
        return true;
      } catch (err) {
        return fail('Не удалось удалить плейлист', err);
      }
    },

    renamePlaylist: async (playlistId: string, newTitle: string) => {
      try {
        commitPlaylist(await dbService.renamePlaylist(playlistId, newTitle));
        return true;
      } catch (err) {
        return fail('Не удалось переименовать плейлист', err);
      }
    },

    addTrackToPlaylist: async (playlistId: string, track: UnifiedTrack) => {
      if (requiresAccount('пополнять плейлисты')) return false;

      try {
        commitPlaylist(await dbService.addTrackToPlaylist(playlistId, track));
        return true;
      } catch (err) {
        return fail(`Не удалось добавить «${track?.title || 'трек'}» в плейлист`, err);
      }
    },

    removeTrackFromPlaylist: async (playlistId: string, trackIndex: number) => {
      try {
        commitPlaylist(await dbService.removeTrackFromPlaylist(playlistId, trackIndex));
        return true;
      } catch (err) {
        return fail('Не удалось убрать трек из плейлиста', err);
      }
    },

    reorderPlaylistTracks: async (playlistId: string, fromIndex: number, toIndex: number) => {
      try {
        commitPlaylist(await dbService.reorderPlaylistTracks(playlistId, fromIndex, toIndex));
        return true;
      } catch (err) {
        return fail('Не удалось изменить порядок треков', err);
      }
    },

    addToHistory: async (track: UnifiedTrack) => {
      if (!track || !track.id) return false;
      try {
        await dbService.addToHistory(track);
        set((s) => ({
          history: [track, ...s.history.filter((t) => t.id !== track.id)].slice(0, 100),
          error: null
        }));
        return true;
      } catch (err) {
        return fail('Не удалось обновить историю прослушиваний', err);
      }
    },

    clearHistory: async () => {
      try {
        await dbService.clearHistory();
        set({ history: [], error: null });
        return true;
      } catch (err) {
        return fail('Не удалось очистить историю прослушиваний', err);
      }
    }
  };
});
