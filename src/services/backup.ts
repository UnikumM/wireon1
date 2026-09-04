/**
 * Library backup for Wireon.
 *
 * A real, offline replacement for the "cloud" the app used to pretend to have:
 * the whole library (favourites, playlists, history, settings) is exported as a
 * single JSON document the user owns, and imported back with defensive
 * validation so a hand-edited or foreign file can never corrupt IndexedDB.
 */

import { AudioSource, Playlist, UnifiedTrack } from '../types/music';
import * as dbService from './db';
import { UNKNOWN_ARTIST, UNKNOWN_TITLE, UNTITLED_PLAYLIST } from '../utils/placeholders';

export const BACKUP_VERSION = 1;

/** How many history entries a backup carries (the table is not capped). */
const HISTORY_SCAN_LIMIT = 10000;

/**
 * Sync-engine bookkeeping (see `cloudSync.ts`) is machine state, not library
 * content: it is neither exported nor restored.
 */
const INTERNAL_SETTING_KEYS = new Set(['pending_sync_mutations', 'parked_sync_mutations']);

const VALID_SOURCES: AudioSource[] = ['youtube', 'soundcloud'];

export interface LibraryBackup {
  version: 1;
  exportedAt: number;
  favorites: UnifiedTrack[];
  playlists: Playlist[];
  history: UnifiedTrack[];
  settings: Record<string, unknown>;
}

export type BackupErrorCode =
  | 'INVALID_JSON'
  | 'NOT_A_BACKUP'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_RECORD'
  | 'IMPORT_FAILED';

export class BackupError extends Error {
  public readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

export interface ImportSummary {
  favorites: number;
  playlists: number;
  history: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asArray(value: unknown, path: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BackupError('INVALID_RECORD', `${path}: ожидался список`);
  }
  return value;
}

/**
 * Normalizes an untrusted record into a `UnifiedTrack`. `id` and `source` are the
 * only fields that cannot be reconstructed, so a bad one is rejected instead of
 * guessed.
 */
function parseTrack(raw: unknown, path: string): UnifiedTrack {
  if (!isPlainObject(raw)) {
    throw new BackupError('INVALID_RECORD', `${path}: это не запись о треке`);
  }

  const id = asString(raw.id).trim();
  if (!id) {
    throw new BackupError('INVALID_RECORD', `${path}.id отсутствует или не строка`);
  }

  const source = raw.source as AudioSource;
  if (!VALID_SOURCES.includes(source)) {
    throw new BackupError('INVALID_RECORD', `${path}.source должен быть одним из: ${VALID_SOURCES.join(', ')}`);
  }

  const track: UnifiedTrack = {
    id,
    source,
    originalId: asString(raw.originalId, id.replace(/^(yt_|sc_)/, '')),
    title: asString(raw.title, UNKNOWN_TITLE),
    artist: asString(raw.artist, UNKNOWN_ARTIST),
    duration: Math.max(0, asNumber(raw.duration, 0)),
    artworkUrl: asString(raw.artworkUrl)
  };

  if (typeof raw.album === 'string') track.album = raw.album;
  if (typeof raw.sourceUrl === 'string') track.sourceUrl = raw.sourceUrl;
  if (typeof raw.durationFormatted === 'string') track.durationFormatted = raw.durationFormatted;
  if (typeof raw.addedAt === 'number' && Number.isFinite(raw.addedAt)) track.addedAt = raw.addedAt;

  return track;
}

/**
 * Normalizes an untrusted record into a `Playlist`. `isSynced` is always false:
 * an imported playlist has never been confirmed by a remote.
 */
function parsePlaylist(raw: unknown, path: string): Playlist {
  if (!isPlainObject(raw)) {
    throw new BackupError('INVALID_RECORD', `${path}: это не запись о плейлисте`);
  }

  const id = asString(raw.id).trim();
  if (!id) {
    throw new BackupError('INVALID_RECORD', `${path}.id is missing or not a string`);
  }

  const now = Date.now();
  const tracks = asArray(raw.tracks, `${path}.tracks`).map((track, index) =>
    parseTrack(track, `${path}.tracks[${index}]`)
  );

  return {
    id,
    title: asString(raw.title, UNTITLED_PLAYLIST),
    description: asString(raw.description),
    coverUrl: asString(raw.coverUrl),
    tracks,
    createdAt: asNumber(raw.createdAt, now),
    updatedAt: asNumber(raw.updatedAt, now),
    isSynced: false
  };
}

function parseBackup(json: string): LibraryBackup {
  if (typeof json !== 'string' || json.trim().length === 0) {
    throw new BackupError('INVALID_JSON', 'Файл резервной копии пуст');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new BackupError('INVALID_JSON', `Файл резервной копии — не JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isPlainObject(raw)) {
    throw new BackupError('NOT_A_BACKUP', 'В файле резервной копии должен быть JSON-объект');
  }

  // A file with no version at all is somebody else's JSON, not a backup from a
  // different release — saying "version undefined" would send the user hunting
  // for a migration that does not exist.
  if (typeof raw.version !== 'number' || !Number.isFinite(raw.version)) {
    throw new BackupError('NOT_A_BACKUP', 'В файле резервной копии нет поля version');
  }

  if (raw.version !== BACKUP_VERSION) {
    throw new BackupError(
      'UNSUPPORTED_VERSION',
      `Неподдерживаемая версия копии — ${raw.version}, нужна ${BACKUP_VERSION}`
    );
  }

  const settings = raw.settings === undefined || raw.settings === null ? {} : raw.settings;
  if (!isPlainObject(settings)) {
    throw new BackupError('INVALID_RECORD', 'settings должен быть объектом');
  }

  return {
    version: BACKUP_VERSION,
    exportedAt: asNumber(raw.exportedAt, Date.now()),
    favorites: asArray(raw.favorites, 'favorites').map((t, i) => parseTrack(t, `favorites[${i}]`)),
    playlists: asArray(raw.playlists, 'playlists').map((p, i) => parsePlaylist(p, `playlists[${i}]`)),
    history: asArray(raw.history, 'history').map((t, i) => parseTrack(t, `history[${i}]`)),
    settings
  };
}

/**
 * Reads the whole local library into a portable document.
 */
export async function exportLibrary(): Promise<LibraryBackup> {
  const [favorites, playlists, history, settings] = await Promise.all([
    dbService.getFavorites(),
    dbService.getPlaylists(),
    dbService.getHistoryTracks(HISTORY_SCAN_LIMIT),
    dbService.getAllSettings()
  ]);

  const exportableSettings = Object.entries(settings).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (!INTERNAL_SETTING_KEYS.has(key)) {
      acc[key] = value;
    }
    return acc;
  }, {});

  return {
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    favorites,
    playlists,
    history,
    settings: exportableSettings
  };
}

/**
 * Pretty-printed JSON blob, ready for a download link.
 */
export function backupToBlob(backup: LibraryBackup): Blob {
  return new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
}

/**
 * Restores a backup. `merge` keeps what is already there and skips duplicate
 * track/playlist ids (a stored playlist only loses to a strictly newer
 * `updatedAt`); `replace` wipes favourites, playlists and history first.
 * The whole document is validated before anything is written, so a malformed
 * file throws `BackupError` and leaves the database untouched.
 *
 * Returns how many records were written per section.
 */
export async function importLibrary(json: string, mode: 'merge' | 'replace'): Promise<ImportSummary> {
  if (mode !== 'merge' && mode !== 'replace') {
    throw new BackupError('IMPORT_FAILED', `Неизвестный режим импорта: ${String(mode)}`);
  }

  const backup = parseBackup(json);
  const summary: ImportSummary = { favorites: 0, playlists: 0, history: 0 };

  try {
    if (mode === 'replace') {
      await dbService.clearFavorites();
      await dbService.clearPlaylists();
      await dbService.clearHistory();
    }

    const existingFavoriteIds = new Set(
      mode === 'merge' ? (await dbService.getFavorites()).map((t) => t.id) : []
    );
    const existingPlaylists = new Map(
      mode === 'merge' ? (await dbService.getPlaylists()).map((p) => [p.id, p]) : []
    );
    const existingHistoryIds = new Set(
      mode === 'merge' ? (await dbService.getHistory(HISTORY_SCAN_LIMIT)).map((h) => h.id) : []
    );

    for (const track of backup.favorites) {
      if (existingFavoriteIds.has(track.id)) continue;
      await dbService.addFavorite(track);
      existingFavoriteIds.add(track.id);
      summary.favorites++;
    }

    for (const playlist of backup.playlists) {
      const stored = existingPlaylists.get(playlist.id);
      if (stored && stored.updatedAt >= playlist.updatedAt) continue;
      // savePlaylist keeps the backup's updatedAt, so LWW stays meaningful.
      await dbService.savePlaylist(playlist);
      existingPlaylists.set(playlist.id, playlist);
      summary.playlists++;
    }

    /*
     * History arrives newest-first; replay it oldest-first so `playedAt` keeps its order.
     *
     * Without individual play events, on purpose. A backup stores tracks, not
     * the moments they were played, so the replay stamps every one of them with
     * "now" — which is harmless for the all-time counter and would be a lie in
     * the weekly top: a hundred songs nobody played this week.
     */
    for (const track of [...backup.history].reverse()) {
      if (existingHistoryIds.has(track.id)) continue;
      await dbService.addToHistory(track, { skipEvent: true });
      existingHistoryIds.add(track.id);
      summary.history++;
    }

    for (const [key, value] of Object.entries(backup.settings)) {
      if (INTERNAL_SETTING_KEYS.has(key)) continue;
      await dbService.setSetting(key, value);
    }

    return summary;
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError(
      'IMPORT_FAILED',
      `Не удалось записать копию в локальную базу: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
