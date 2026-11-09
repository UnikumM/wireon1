import { create } from 'zustand';
import * as dbService from '../services/db';
import { Playlist } from '../types/music';

export const PLAYLIST_FOLDERS_KEY = 'playlistFolders';

/** Папка — имя и упорядоченный список плейлистов. Плейлист лежит не больше чем в одной. */
export interface PlaylistFolder {
  id: string;
  title: string;
  playlistIds: string[];
}

export interface FolderStore {
  folders: PlaylistFolder[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Возвращает id новой папки. Пустое имя не создаёт ничего и отдаёт `null`. */
  createFolder: (title: string) => string | null;
  renameFolder: (id: string, title: string) => void;
  /** Плейлисты остаются в медиатеке — они просто выходят из папки. */
  deleteFolder: (id: string) => void;
  /** `null` — «без папки». Из прежней папки плейлист убирается сам. */
  moveToFolder: (playlistId: string, folderId: string | null) => void;
  reorder: (folderId: string, playlistIds: string[]) => void;
}

function newFolderId(): string {
  return `fld_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * База хранит что угодно, а на экран должны попасть только папки нужной формы:
 * настройка могла быть записана старой сборкой или повреждена, и один кривой
 * элемент не должен ронять всю медиатеку.
 */
export function sanitizeFolders(raw: unknown): PlaylistFolder[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: PlaylistFolder[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, title, playlistIds } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof title !== 'string' || !Array.isArray(playlistIds)) continue;
    const ids: string[] = [];
    for (const pid of playlistIds) {
      // Плейлист — не больше чем в одной папке, даже если запись говорит иначе.
      if (typeof pid === 'string' && !seen.has(pid)) {
        seen.add(pid);
        ids.push(pid);
      }
    }
    result.push({ id, title, playlistIds: ids });
  }
  return result;
}

/*
 * Записи в базу идут по цепочке, а не вразнобой: два быстрых действия подряд
 * («в папку», тут же «переименовать») — это две асинхронные записи одной и той
 * же настройки, и без очереди вторая могла лечь раньше первой, оставив на диске
 * устаревшее состояние.
 */
let writeChain: Promise<void> = Promise.resolve();

function persist(folders: PlaylistFolder[]): void {
  writeChain = writeChain
    .then(() => dbService.setSetting(PLAYLIST_FOLDERS_KEY, folders))
    .catch(() => undefined);
}

/** Для тестов: дождаться, пока все начатые записи лягут в базу. */
export function flushFolderWrites(): Promise<void> {
  return writeChain;
}

/**
 * Папки плейлистов.
 *
 * Хранятся на устройстве, как и закреплённые (`usePinnedStore`): это не свойство
 * плейлиста, а то, как человек раскладывает медиатеку именно здесь. Отдельной
 * таблицы Dexie нет — одна настройка `playlistFolders` с массивом папок.
 *
 * Синхронизация папок между устройствами через сервер — отдельная работа (после
 * 4.0): сервер и протокол `cloudSync` про папки пока не знают, и здесь это
 * нарочно не предвосхищается.
 */
export const useFolderStore = create<FolderStore>((set, get) => ({
  folders: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const stored = await dbService.getSetting<unknown>(PLAYLIST_FOLDERS_KEY, []);
      const fromDb = sanitizeFolders(stored);
      // Что успели создать до чтения базы — не теряем: оно новее записи.
      const local = get().folders;
      const localIds = new Set(local.map((f) => f.id));
      set({ folders: [...local, ...fromDb.filter((f) => !localIds.has(f.id))], hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  createFolder: (title) => {
    const trimmed = title.trim();
    if (!trimmed) return null;
    const folder: PlaylistFolder = { id: newFolderId(), title: trimmed, playlistIds: [] };
    const next = [...get().folders, folder];
    set({ folders: next });
    persist(next);
    return folder.id;
  },

  renameFolder: (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const next = get().folders.map((f) => (f.id === id ? { ...f, title: trimmed } : f));
    set({ folders: next });
    persist(next);
  },

  deleteFolder: (id) => {
    const next = get().folders.filter((f) => f.id !== id);
    if (next.length === get().folders.length) return;
    set({ folders: next });
    persist(next);
  },

  moveToFolder: (playlistId, folderId) => {
    const next = get().folders.map((f) => {
      const without = f.playlistIds.filter((pid) => pid !== playlistId);
      if (f.id === folderId) return { ...f, playlistIds: [...without, playlistId] };
      return without.length === f.playlistIds.length ? f : { ...f, playlistIds: without };
    });
    set({ folders: next });
    persist(next);
  },

  reorder: (folderId, playlistIds) => {
    const next = get().folders.map((f) => {
      if (f.id !== folderId) return f;
      // Порядок задаёт вызывающий, но состав папки менять этим путём нельзя:
      // чужие id отбрасываются, забытые свои — дописываются в конец.
      const own = new Set(f.playlistIds);
      const ordered = playlistIds.filter((pid, i) => own.has(pid) && playlistIds.indexOf(pid) === i);
      const missing = f.playlistIds.filter((pid) => !ordered.includes(pid));
      return { ...f, playlistIds: [...ordered, ...missing] };
    });
    set({ folders: next });
    persist(next);
  }
}));

/** Папка, в которой лежит плейлист, или `null`. */
export function folderOfPlaylist(folders: ReadonlyArray<PlaylistFolder>, playlistId: string): PlaylistFolder | null {
  return folders.find((f) => f.playlistIds.includes(playlistId)) ?? null;
}

export interface FolderGroup<T> {
  folder: PlaylistFolder;
  /** Плейлисты папки в её порядке; удалённых из медиатеки здесь уже нет. */
  playlists: T[];
}

export interface GroupedPlaylists<T> {
  groups: FolderGroup<T>[];
  /** Плейлисты вне папок — в том порядке, в каком пришли. */
  loose: T[];
}

/**
 * Раскладывает плейлисты по папкам. Удалённый плейлист из записи папки не
 * вычищается (запись переживёт и восстановление из резервной копии), поэтому
 * сверка с живой медиатекой — здесь, при каждом показе.
 */
export function groupByFolders<T extends Pick<Playlist, 'id'>>(
  playlists: ReadonlyArray<T>,
  folders: ReadonlyArray<PlaylistFolder>
): GroupedPlaylists<T> {
  const byId = new Map(playlists.map((p) => [p.id, p]));
  const taken = new Set<string>();
  const groups = folders.map((folder) => {
    const own: T[] = [];
    for (const pid of folder.playlistIds) {
      const p = byId.get(pid);
      if (p && !taken.has(pid)) {
        taken.add(pid);
        own.push(p);
      }
    }
    return { folder, playlists: own };
  });
  return { groups, loose: playlists.filter((p) => !taken.has(p.id)) };
}
