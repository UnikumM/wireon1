import { create } from 'zustand';
import * as dbService from '../services/db';

export const PREVIEW_ON_HOVER_KEY = 'previewOnHover';

export interface PreviewStore {
  /** Превью по наведению на обложку (только ПК/браузер; телефон хук не включает). */
  previewOnHover: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setPreviewOnHover: (enabled: boolean) => void;
}

/**
 * Настройка превью по наведению. Своим маленьким стором, как закреплённые
 * плейлисты: это свойство устройства (мышь есть или нет), а не плеера, и
 * тащить его в большой `usePlayerStore` незачем.
 */
export const usePreviewStore = create<PreviewStore>((set, get) => ({
  previewOnHover: true,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const stored = await dbService.getSetting<unknown>(PREVIEW_ON_HOVER_KEY, true);
      set({ previewOnHover: typeof stored === 'boolean' ? stored : true, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  setPreviewOnHover: (enabled) => {
    set({ previewOnHover: enabled });
    void dbService.setSetting(PREVIEW_ON_HOVER_KEY, enabled).catch(() => undefined);
  }
}));
