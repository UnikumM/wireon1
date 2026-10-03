import { create } from 'zustand';
import * as db from '../services/db';

export type LayoutPlatform = 'desktop' | 'mobile';
export type PanelPosition = 'top' | 'bottom' | 'left' | 'right';
export const PANEL_POSITIONS: PanelPosition[] = ['top', 'bottom', 'left', 'right'];
export const TAB_IDS = ['home', 'search', 'wave', 'foryou', 'library'] as const;
export type LayoutTab = typeof TAB_IDS[number];
export const HOME_BLOCK_IDS = ['hero', 'recent', 'wave', 'stats', 'mixes', 'artists', 'releases', 'discover'] as const;
export type HomeBlockId = typeof HOME_BLOCK_IDS[number];
export const AVAILABLE_HOME_BLOCKS: Record<LayoutPlatform, HomeBlockId[]> = {
  desktop: ['hero', 'wave', 'mixes', 'releases', 'discover'],
  mobile: ['hero', 'recent', 'wave', 'stats', 'mixes', 'artists']
};
export const TAB_LABELS: Record<LayoutTab, string> = {
  home: 'Главная', search: 'Поиск', wave: 'Поток', foryou: 'Для вас', library: 'Медиатека'
};
export const HOME_BLOCK_LABELS: Record<HomeBlockId, string> = {
  hero: 'Продолжить слушать', recent: 'Недавние треки', wave: 'Поток', stats: 'Итоги прослушанного',
  mixes: 'Миксы дня', artists: 'Радио по артистам', releases: 'Новое у исполнителей', discover: 'Чарты и новинки'
};
export interface AppLayout {
  navigationPosition: PanelPosition;
  playerPosition: PanelPosition;
  tabs: LayoutTab[];
  hiddenTabs: LayoutTab[];
  homeBlocks: HomeBlockId[];
  hiddenHomeBlocks: HomeBlockId[];
  navigationWidth: number;
  playerWidth: number;
  homeColumns: 1 | 2;
}
export const APP_LAYOUT_KEY = 'appLayout';
export function defaultAppLayout(platform: LayoutPlatform): AppLayout {
  return { navigationPosition: platform === 'mobile' ? 'bottom' : 'top', playerPosition: 'bottom',
    tabs: [...TAB_IDS], hiddenTabs: platform === 'mobile' ? ['wave', 'foryou'] : [],
    homeBlocks: [...HOME_BLOCK_IDS], hiddenHomeBlocks: [], navigationWidth: 180, playerWidth: 240, homeColumns: 1 };
}
function order<T extends string>(value: unknown, keys: readonly T[]): T[] {
  const saved = Array.isArray(value) ? value.filter((item): item is T => keys.includes(item)) : [];
  return [...new Set([...saved, ...keys])];
}
function hidden<T extends string>(value: unknown, keys: readonly T[]): T[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is T => keys.includes(item)))] : [];
}
export function normalizeAppLayout(raw: unknown, platform: LayoutPlatform): AppLayout {
  const fallback = defaultAppLayout(platform);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const saved = raw as Partial<AppLayout>;
  const width = (value: unknown, min: number, max: number, backup: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : backup;
  return { ...fallback,
    navigationPosition: PANEL_POSITIONS.includes(saved.navigationPosition!) ? saved.navigationPosition! : fallback.navigationPosition,
    playerPosition: PANEL_POSITIONS.includes(saved.playerPosition!) ? saved.playerPosition! : fallback.playerPosition,
    tabs: order(saved.tabs, TAB_IDS), hiddenTabs: saved.hiddenTabs === undefined ? fallback.hiddenTabs : hidden(saved.hiddenTabs, TAB_IDS).filter((id) => id !== 'home'),
    homeBlocks: order(saved.homeBlocks, HOME_BLOCK_IDS), hiddenHomeBlocks: hidden(saved.hiddenHomeBlocks, HOME_BLOCK_IDS),
    navigationWidth: width(saved.navigationWidth, 64, 240, fallback.navigationWidth),
    playerWidth: width(saved.playerWidth, 160, 320, fallback.playerWidth), homeColumns: saved.homeColumns === 2 ? 2 : 1 };
}
interface AppLayoutStore {
  desktop: AppLayout;
  mobile: AppLayout;
  hydrated: boolean;
  editHome: boolean;
  update: (platform: LayoutPlatform, patch: Partial<AppLayout>) => void;
  move: (platform: LayoutPlatform, list: 'tabs' | 'homeBlocks', id: string, to: number) => void;
  toggle: (platform: LayoutPlatform, list: 'hiddenTabs' | 'hiddenHomeBlocks', id: string) => void;
  reset: (platform: LayoutPlatform) => void;
  setEditHome: (enabled: boolean) => void;
  hydrate: () => Promise<void>;
}
let revision = 0;
let hydration: Promise<void> | null = null;
let writing = Promise.resolve();
export const useAppLayoutStore = create<AppLayoutStore>((set, get) => {
  const persist = () => {
    const snapshot = { desktop: get().desktop, mobile: get().mobile };
    // Serialize writes so rapid drag/drop cannot persist an older layout last.
    writing = writing.then(() => db.setSetting(APP_LAYOUT_KEY, snapshot)).catch((error) => {
      console.warn('[AppLayout] Could not save layout', error);
    });
  };
  return {
    desktop: defaultAppLayout('desktop'), mobile: defaultAppLayout('mobile'), hydrated: false, editHome: false,
    update: (platform, patch) => {
      revision += 1;
      set({ [platform]: normalizeAppLayout({ ...get()[platform], ...patch }, platform) });
      persist();
    },
    move: (platform, list, id, to) => {
      const items = [...get()[platform][list]];
      const from = items.indexOf(id as never);
      if (from < 0 || to < 0 || to >= items.length) return;
      const [item] = items.splice(from, 1);
      items.splice(to, 0, item);
      get().update(platform, { [list]: items });
    },
    toggle: (platform, list, id) => {
      if (list === 'hiddenTabs' && id === 'home') return;
      const items = get()[platform][list];
      get().update(platform, { [list]: items.includes(id as never) ? items.filter((item) => item !== id) : [...items, id] });
    },
    reset: (platform) => get().update(platform, defaultAppLayout(platform)),
    setEditHome: (editHome) => set({ editHome }),
    hydrate: async () => {
      if (get().hydrated) return;
      if (hydration) return hydration;
      const startedAt = revision;
      hydration = (async () => {
        try {
          const saved = await db.getSetting<{ desktop?: unknown; mobile?: unknown } | null>(APP_LAYOUT_KEY, null);
          if (saved && startedAt === revision) set({ desktop: normalizeAppLayout(saved.desktop, 'desktop'), mobile: normalizeAppLayout(saved.mobile, 'mobile') });
        } catch (error) { console.warn('[AppLayout] Could not restore layout', error); }
        finally { set({ hydrated: true }); hydration = null; }
      })();
      return hydration;
    }
  };
});
