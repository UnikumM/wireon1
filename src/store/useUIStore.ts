import { create } from 'zustand';
import { UIStore, UIStoreState, MiniPlayerLayout } from '../types/store';

/**
 * Отказ ли это из-за отсутствия аккаунта.
 *
 * Стор медиатеки на такой отказ не пишет ошибку — она бы означала поломку, а
 * поломки нет. Поэтому места, которые показывают красный ответ на неудачу,
 * спрашивают здесь: приглашение войти уже стоит на экране, и второе сообщение
 * теми же секундами — это два разных ответа на одно нажатие.
 */
export function refusedForAccount(): boolean {
  return useUIStore.getState().accountPrompt !== null;
}

export const useUIStore = create<UIStore>((set, get) => ({
  activeView: 'search',
  activeWaveMood: 'favorite',
  activeWaveGenre: null,
  activePlaylistId: null,
  selectedArtistName: null,
  isQueueOpen: false,
  isLyricsOpen: false,
  isFullscreenPlayerOpen: false,
  isCommandPaletteOpen: false,
  isMiniPlayerOpen: false,
  miniWindowActive: false,
  miniPlayerLayout: 'compact',
  miniPlayerAlwaysOnTop: true,
  miniPlayerOpacity: 0.95,
  miniPlayerShowVisualizer: true,
  miniPlayerShowProgress: true,
  miniPlayerShowControls: true,
  searchQuery: '',
  searchFilter: 'all',
  toastMessage: null,
  actionsTrack: null,
  accountPrompt: null,

  setActiveView: (view: UIStoreState['activeView']) => {
    set({ activeView: view });
  },

  setActiveWaveMood: (mood: UIStoreState['activeWaveMood']) => {
    set({ activeWaveMood: mood });
  },

  setActiveWaveGenre: (genre: string | null) => {
    set({ activeWaveGenre: genre });
  },

  setActivePlaylistId: (id: string | null) => {
    set({ activePlaylistId: id });
  },

  setSelectedArtistName: (name: string | null) => {
    set({ selectedArtistName: name });
  },

  openArtist: (artistName: string) => {
    const trimmed = (artistName || '').trim();
    if (!trimmed) return;
    set({
      activeView: 'artist',
      selectedArtistName: trimmed,
      isFullscreenPlayerOpen: false
    });
  },

  toggleQueue: () => {
    set((s) => ({ isQueueOpen: !s.isQueueOpen }));
  },

  setQueueOpen: (isOpen: boolean) => {
    set({ isQueueOpen: isOpen });
  },

  toggleLyrics: () => {
    set((s) => ({ isLyricsOpen: !s.isLyricsOpen }));
  },

  setLyricsOpen: (isOpen: boolean) => {
    set({ isLyricsOpen: isOpen });
  },

  toggleFullscreenPlayer: () => {
    set((s) => ({ isFullscreenPlayerOpen: !s.isFullscreenPlayerOpen }));
  },

  setFullscreenPlayerOpen: (isOpen: boolean) => {
    set({ isFullscreenPlayerOpen: isOpen });
  },

  toggleMiniPlayer: async () => {
    const next = !get().isMiniPlayerOpen;
    await get().setMiniPlayerOpen(next);
  },

  setMiniPlayerOpen: async (isOpen: boolean) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

    // Preferred path: a real always-on-top window that survives the main window
    // being minimised. `miniWindowActive` tells the shell not to swap its own
    // contents for the in-window fallback.
    if (api && typeof api.openMiniWindow === 'function' && typeof api.closeMiniWindow === 'function') {
      try {
        const ok = isOpen ? await api.openMiniWindow() : !(await api.closeMiniWindow());
        set({ isMiniPlayerOpen: isOpen && ok !== false, miniWindowActive: isOpen && ok !== false });
        return;
      } catch (err) {
        console.warn('[useUIStore] mini window IPC failed, falling back to in-window mode:', err);
      }
    }

    set({ isMiniPlayerOpen: isOpen, miniWindowActive: false });

    // Browser builds and older preloads only have the resize-in-place mode.
    if (api && typeof api.setMiniPlayerMode === 'function') {
      try {
        await api.setMiniPlayerMode(isOpen, get().miniPlayerLayout);
      } catch (err) {
        console.warn('[useUIStore] setMiniPlayerMode failed:', err);
      }
    }
  },

  setMiniPlayerLayout: async (layout: MiniPlayerLayout) => {
    set({ miniPlayerLayout: layout });
    if (get().miniWindowActive) return;
    if (get().isMiniPlayerOpen && typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.setMiniPlayerMode === 'function') {
      try {
        await window.electronAPI.setMiniPlayerMode(true, layout);
      } catch (err) {
        console.warn('[useUIStore] setMiniPlayerLayout failed:', err);
      }
    }
  },

  setMiniPlayerAlwaysOnTop: async (alwaysOnTop: boolean) => {
    set({ miniPlayerAlwaysOnTop: alwaysOnTop });
    if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.setAlwaysOnTop === 'function') {
      try {
        await window.electronAPI.setAlwaysOnTop(alwaysOnTop);
      } catch (err) {
        console.warn('[useUIStore] setAlwaysOnTop failed:', err);
      }
    }
  },

  setMiniPlayerOpacity: (opacity: number) => {
    set({ miniPlayerOpacity: Math.max(0.4, Math.min(1.0, opacity)) });
  },

  setMiniPlayerShowVisualizer: (show: boolean) => {
    set({ miniPlayerShowVisualizer: show });
  },

  setMiniPlayerShowProgress: (show: boolean) => {
    set({ miniPlayerShowProgress: show });
  },

  setMiniPlayerShowControls: (show: boolean) => {
    set({ miniPlayerShowControls: show });
  },

  toggleCommandPalette: () => {
    set((s) => ({ isCommandPaletteOpen: !s.isCommandPaletteOpen }));
  },

  setCommandPaletteOpen: (isOpen: boolean) => {
    set({ isCommandPaletteOpen: isOpen });
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  setSearchFilter: (filter: 'all' | 'youtube' | 'soundcloud') => {
    set({ searchFilter: filter });
  },

  showToast: (text: string, type: 'info' | 'success' | 'error' = 'info') => {
    set({
      toastMessage: {
        id: `toast_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        text,
        type
      }
    });
  },

  clearToast: () => {
    set({ toastMessage: null });
  },

  /*
   * Лист действий над треком живёт в сторе, а не внутри строки.
   *
   * Прежнее меню рождалось потомком той самой строки, по которой нажали, — и
   * потому обрезалось прокруткой списка, а в виртуализированных списках могло
   * исчезнуть вместе со строкой, уехавшей за край окна. Здесь строка только
   * называет трек, а рисует лист оболочка, у самого верха дерева.
   */
  openTrackActions: (track) => {
    set({ actionsTrack: track });
  },

  closeTrackActions: () => {
    set({ actionsTrack: null });
  },

  /**
   * Приглашение войти вместо молчаливого отказа.
   *
   * Хранится причина, а не просто «покажи окно»: человек нажал «в избранное»
   * или «новый плейлист», и окно обязано ответить именно на это действие, иначе
   * оно читается как случайная просьба зарегистрироваться.
   */
  requireAccount: (reason: string) => {
    set({ accountPrompt: reason });
  },

  closeAccountPrompt: () => {
    set({ accountPrompt: null });
  }
}));
