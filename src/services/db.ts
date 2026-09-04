import Dexie, { type Table } from 'dexie';
import { UnifiedTrack, Playlist } from '../types/music';
import { UNTITLED_PLAYLIST } from '../utils/placeholders';
import { EARLY_SKIP_SECONDS } from './tasteProfile';

export interface SettingRecord {
  key: string;
  value: any;
  updatedAt: number;
}

export interface DislikeRecord {
  id: string; // track.id
  artist: string;
  dislikedAt: number;
}

export interface HistoryRecord {
  id: string; // track.id
  track: UnifiedTrack;
  playedAt: number;
  playCount: number;
  skipCount?: number;
  completedCount?: number;
  lastSkippedAt?: number;
  lastCompletedAt?: number;
  /**
   * Из них выключено в первые секунды. Ранний пропуск — самый сильный отказ,
   * какой можно снять без слов, и «Поток» взвешивает его отдельно от позднего:
   * выключить на восьмой секунде и выключить за двадцать секунд до конца —
   * разные вещи. Поле не индексируется: по нему не ищут, его только читают вместе
   * с записью.
   */
  earlySkipCount?: number;
  /** Сколько секунд трека реально прослушали в последний раз. */
  lastPlayedSeconds?: number;
}

/**
 * Одно включение — одна запись.
 *
 * В `history` на трек лежит одна строка со счётчиком, и по ней нельзя сказать,
 * когда именно случилось каждое включение: известно только последнее. Поэтому
 * «топ за неделю» из неё не считается — трек, который слушали сто раз зимой и
 * один раз вчера, попал бы в недельный топ первым местом. Здесь лежит сам факт
 * включения со временем, и уже по нему можно отрезать окно.
 *
 * Запись нарочно почти пустая: ключ трека и время. Всё остальное — название,
 * исполнитель, источник — берётся из `history` при подсчёте, чтобы одна и та же
 * песня не хранилась в базе по разу на каждое включение.
 */
export interface PlayEventRecord {
  /** Свой ключ, растущий сам: у события нет ничего, что было бы уникальным. */
  id?: number;
  trackId: string;
  playedAt: number;
}

export interface OfflineTrackRecord {
  id: string; // track.id
  track: UnifiedTrack;
  blob: Blob;
  sizeBytes: number;
  downloadedAt: number;
  /** Last time this copy was actually played, for least-recently-used eviction. */
  lastUsedAt?: number;
  /** Cached automatically by offline mode, as opposed to kept on purpose. */
  autoCached?: boolean;
}

/**
 * A lyrics lookup that already happened, kept so the same song never asks LRCLIB
 * twice — including the lookups that found nothing, which is what stops the app
 * from hammering the API for songs that simply have no transcription.
 */
export interface LyricsRecord {
  /** Normalised «исполнитель:::название», or a raw track id for a manual pick. */
  key: string;
  fetchedAt: number;
  /** `null` means "asked and there is nothing" — a real answer worth caching. */
  result: unknown | null;
  /** Set when the user chose this text by hand, which makes it permanent. */
  manual?: boolean;
  /** Seconds to shift the timings by, when the user has nudged them. */
  offsetSeconds?: number;
}

export class WireonDB extends Dexie {
  tracks!: Table<UnifiedTrack, string>;
  playlists!: Table<Playlist, string>;
  favorites!: Table<UnifiedTrack, string>;
  history!: Table<HistoryRecord, string>;
  settings!: Table<SettingRecord, string>;
  dislikes!: Table<DislikeRecord, string>;
  offlineTracks!: Table<OfflineTrackRecord, string>;
  lyrics!: Table<LyricsRecord, string>;
  plays!: Table<PlayEventRecord, number>;

  constructor(dbName = 'WireonDB') {
    super(dbName);
    this.version(1).stores({
      tracks: 'id, source, title, artist, addedAt',
      playlists: 'id, title, createdAt, updatedAt, isSynced',
      favorites: 'id, title, artist, addedAt',
      history: 'id, playedAt, playCount',
      settings: 'key'
    });
    this.version(2).stores({
      dislikes: 'id, artist, dislikedAt'
    });
    this.version(3).stores({
      offlineTracks: 'id, downloadedAt, sizeBytes'
    });
    // `manual` is deliberately not indexed: IndexedDB cannot use a boolean as a
    // key, so such an index would silently hold nothing.
    this.version(4).stores({
      lyrics: 'key, fetchedAt'
    });
    /*
     * `++id` — ключ, который база выдаёт сама: у включения нет естественного
     * уникального признака, а два включения одного трека в одну миллисекунду
     * возможны. Индекс по `playedAt` нужен для запроса окна («что было за
     * неделю») и для чистки старых записей — оба идут диапазоном по нему.
     *
     * Индекса по `trackId` нет нарочно: по одному треку события никто не
     * спрашивает, их всегда берут окном и уже потом раскладывают по трекам.
     */
    this.version(5).stores({
      plays: '++id, playedAt'
    });
  }
}

// Database singleton instance
export const db = new WireonDB();

/**
 * The Dexie database name used before the app was renamed from VireonMusic to
 * Wireon. Installations that predate the rename keep their whole library here.
 */
export const LEGACY_DB_NAME = 'VireonMusicDB';

/** Every table copied by {@link migrateLegacyDatabase}, in dependency-free order. */
const MIGRATED_TABLES = [
  'tracks',
  'playlists',
  'favorites',
  'history',
  'settings',
  'dislikes',
  'offlineTracks',
  'lyrics'
] as const;

/**
 * Moves a pre-rename library into the current database.
 *
 * The rename changed both the Electron `productName` (so the whole userData
 * folder moved) and this database's name. The main process copies the folder;
 * this copies the records inside it. Runs once: after a successful copy the old
 * database is deleted, so the next launch finds nothing to do.
 *
 * Deliberately conservative — it only touches an empty current database, so a
 * stale legacy copy can never overwrite real data.
 *
 * @returns the number of records moved, or 0 when there was nothing to migrate
 */
export async function migrateLegacyDatabase(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0;

  let legacy: Dexie | null = null;
  try {
    // Bail out before touching anything if this install already has a library.
    const existing = await db.tracks.count().catch(() => 0);
    const existingPlaylists = await db.playlists.count().catch(() => 0);
    const existingFavorites = await db.favorites.count().catch(() => 0);
    if (existing > 0 || existingPlaylists > 0 || existingFavorites > 0) return 0;

    if (!(await Dexie.exists(LEGACY_DB_NAME))) return 0;

    // Opening with the same schema keeps Dexie from running an upgrade on the
    // old database, which would rewrite data we are about to read.
    legacy = new WireonDB(LEGACY_DB_NAME);
    await legacy.open();

    let moved = 0;
    for (const table of MIGRATED_TABLES) {
      const source = (legacy as unknown as Record<string, Table<unknown, unknown> | undefined>)[table];
      const target = (db as unknown as Record<string, Table<unknown, unknown> | undefined>)[table];
      if (!source || !target) continue;
      try {
        const rows = await source.toArray();
        if (rows.length === 0) continue;
        // Blobs (offline audio) survive this: IndexedDB structured-clones them.
        await target.bulkPut(rows);
        moved += rows.length;
      } catch (tableErr) {
        // One unreadable table must not abort the rest of the library.
        console.warn(`[DB] Could not migrate legacy table "${table}":`, tableErr);
      }
    }

    legacy.close();
    legacy = null;
    if (moved > 0) {
      await Dexie.delete(LEGACY_DB_NAME);
      // Единственная запись в консоль на всё приложение — и по делу: если
      // пользователь скажет «медиатека пропала», это след того, что перенос
      // из базы Vireon действительно случился и сколько записей забрал.
      console.info(`[DB] Migrated ${moved} records from ${LEGACY_DB_NAME}`);
    }
    return moved;
  } catch (err) {
    console.warn('[DB] Legacy database migration failed:', err);
    return 0;
  } finally {
    try {
      legacy?.close();
    } catch {
      // Closing a database that never opened is not an error worth reporting.
    }
  }
}

// ============================================================================
// CRUD Helpers & Database Methods
// ============================================================================

// --- Favorites ---

export async function getFavorites(): Promise<UnifiedTrack[]> {
  try {
    return await db.favorites.orderBy('addedAt').reverse().toArray();
  } catch (err) {
    console.error('[DB] getFavorites error:', err);
    return [];
  }
}

export async function addFavorite(track: UnifiedTrack): Promise<void> {
  try {
    const entry: UnifiedTrack = {
      ...track,
      addedAt: track.addedAt || Date.now()
    };
    await db.favorites.put(entry);
  } catch (err) {
    console.error('[DB] addFavorite error:', err);
    throw err;
  }
}

export async function removeFavorite(trackId: string): Promise<void> {
  try {
    await db.favorites.delete(trackId);
  } catch (err) {
    console.error('[DB] removeFavorite error:', err);
    throw err;
  }
}

export async function isFavorite(trackId: string): Promise<boolean> {
  return !!(await getFavoriteById(trackId));
}

/**
 * Запись из избранного целиком, а не только «есть ли она».
 *
 * Нужна синхронизации: чтобы решить, применять ли чужое удаление, мало знать о
 * наличии записи — надо сравнить её `addedAt` с датой удаления. Иначе возврат
 * трека в избранное откатывался бы ближайшей сверкой.
 */
export async function getFavoriteById(trackId: string): Promise<UnifiedTrack | undefined> {
  try {
    return await db.favorites.get(trackId);
  } catch (err) {
    console.error('[DB] getFavoriteById error:', err);
    return undefined;
  }
}

export async function clearFavorites(): Promise<void> {
  try {
    await db.favorites.clear();
  } catch (err) {
    console.error('[DB] clearFavorites error:', err);
    throw err;
  }
}

// --- Playlists ---

export async function getPlaylists(): Promise<Playlist[]> {
  try {
    return await db.playlists.orderBy('updatedAt').reverse().toArray();
  } catch (err) {
    console.error('[DB] getPlaylists error:', err);
    return [];
  }
}

export async function getPlaylistById(id: string): Promise<Playlist | undefined> {
  try {
    return await db.playlists.get(id);
  } catch (err) {
    console.error('[DB] getPlaylistById error:', err);
    return undefined;
  }
}

/**
 * Writes a full playlist record. `updatedAt` belongs to the caller — it is the
 * field Last-Write-Wins compares, so a sync merge can replay a record without
 * making it look freshly edited. It is only defaulted when absent.
 */
export async function savePlaylist(playlist: Playlist): Promise<void> {
  try {
    const updatedAt =
      typeof playlist.updatedAt === 'number' && Number.isFinite(playlist.updatedAt)
        ? playlist.updatedAt
        : Date.now();

    await db.playlists.put({ ...playlist, updatedAt });
  } catch (err) {
    console.error('[DB] savePlaylist error:', err);
    throw err;
  }
}

export async function createPlaylist(title: string, description?: string): Promise<Playlist> {
  const newPlaylist: Playlist = {
    id: `pl_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    title: title.trim() || UNTITLED_PLAYLIST,
    description: description || '',
    coverUrl: '',
    tracks: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isSynced: false
  };

  try {
    await db.playlists.put(newPlaylist);
    return newPlaylist;
  } catch (err) {
    console.error('[DB] createPlaylist error:', err);
    throw err;
  }
}

/**
 * The four mutators below are genuine user edits: they bump `updatedAt` and
 * return the stored record so callers can mirror the database exactly.
 */
export async function renamePlaylist(id: string, newTitle: string): Promise<Playlist> {
  try {
    return await db.transaction('rw', db.playlists, async () => {
      const playlist = await db.playlists.get(id);
      if (!playlist) throw new Error(`Плейлист не найден: ${id}`);

      const updated: Playlist = {
        ...playlist,
        title: newTitle.trim() || UNTITLED_PLAYLIST,
        updatedAt: Date.now()
      };
      await db.playlists.put(updated);
      return updated;
    });
  } catch (err) {
    console.error('[DB] renamePlaylist error:', err);
    throw err;
  }
}

export async function deletePlaylist(id: string): Promise<void> {
  try {
    await db.playlists.delete(id);
  } catch (err) {
    console.error('[DB] deletePlaylist error:', err);
    throw err;
  }
}

export async function addTrackToPlaylist(playlistId: string, track: UnifiedTrack): Promise<Playlist> {
  try {
    return await db.transaction('rw', db.playlists, async () => {
      const playlist = await db.playlists.get(playlistId);
      if (!playlist) throw new Error(`Плейлист не найден: ${playlistId}`);

      const trackToAdd: UnifiedTrack = {
        ...track,
        addedAt: track.addedAt || Date.now()
      };

      const updated: Playlist = {
        ...playlist,
        tracks: [...playlist.tracks, trackToAdd],
        updatedAt: Date.now()
      };
      await db.playlists.put(updated);
      return updated;
    });
  } catch (err) {
    console.error('[DB] addTrackToPlaylist error:', err);
    throw err;
  }
}

export async function removeTrackFromPlaylist(playlistId: string, trackIndex: number): Promise<Playlist> {
  try {
    return await db.transaction('rw', db.playlists, async () => {
      const playlist = await db.playlists.get(playlistId);
      if (!playlist) throw new Error(`Плейлист не найден: ${playlistId}`);

      if (trackIndex < 0 || trackIndex >= playlist.tracks.length) {
        throw new Error(`Такого номера трека в плейлисте нет: ${trackIndex}`);
      }

      const updatedTracks = [...playlist.tracks];
      updatedTracks.splice(trackIndex, 1);

      const updated: Playlist = { ...playlist, tracks: updatedTracks, updatedAt: Date.now() };
      await db.playlists.put(updated);
      return updated;
    });
  } catch (err) {
    console.error('[DB] removeTrackFromPlaylist error:', err);
    throw err;
  }
}

export async function reorderPlaylistTracks(
  playlistId: string,
  fromIndex: number,
  toIndex: number
): Promise<Playlist> {
  try {
    return await db.transaction('rw', db.playlists, async () => {
      const playlist = await db.playlists.get(playlistId);
      if (!playlist) throw new Error(`Плейлист не найден: ${playlistId}`);

      const len = playlist.tracks.length;
      if (fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len) {
        throw new Error(`Неверные позиции для переноса: с ${fromIndex} на ${toIndex}, всего ${len}`);
      }

      const updatedTracks = [...playlist.tracks];
      const [moved] = updatedTracks.splice(fromIndex, 1);
      updatedTracks.splice(toIndex, 0, moved);

      const updated: Playlist = { ...playlist, tracks: updatedTracks, updatedAt: Date.now() };
      await db.playlists.put(updated);
      return updated;
    });
  } catch (err) {
    console.error('[DB] reorderPlaylistTracks error:', err);
    throw err;
  }
}

export async function clearPlaylists(): Promise<void> {
  try {
    await db.playlists.clear();
  } catch (err) {
    console.error('[DB] clearPlaylists error:', err);
    throw err;
  }
}

// --- Listening History ---

export async function getHistory(limit = 50): Promise<HistoryRecord[]> {
  try {
    return await db.history.orderBy('playedAt').reverse().limit(limit).toArray();
  } catch (err) {
    console.error('[DB] getHistory error:', err);
    return [];
  }
}

export async function getHistoryTracks(limit = 50): Promise<UnifiedTrack[]> {
  try {
    const historyList = await getHistory(limit);
    return historyList.map(h => h.track);
  } catch (err) {
    console.error('[DB] getHistoryTracks error:', err);
    return [];
  }
}

let lastHistoryTimestamp = 0;

function getMonotonicTimestamp(): number {
  const now = Date.now();
  if (now <= lastHistoryTimestamp) {
    lastHistoryTimestamp += 1;
  } else {
    lastHistoryTimestamp = now;
  }
  return lastHistoryTimestamp;
}

export interface AddToHistoryOptions {
  /**
   * Не писать отдельное включение — только счётчик.
   *
   * Нужно при восстановлении копии: в копии лежат треки без дат, и перенос
   * ставит каждому «сейчас». Счётчику это безразлично, а окно «за неделю»
   * заполнилось бы сотней песен, которых человек на этой неделе не включал.
   * Лучше пустая неделя, чем придуманная.
   */
  skipEvent?: boolean;
}

export async function addToHistory(
  track: UnifiedTrack,
  options: AddToHistoryOptions = {}
): Promise<void> {
  if (!track || !track.id) return;
  try {
    const existing = await db.history.get(track.id);
    const playCount = existing ? (existing.playCount || 1) + 1 : 1;
    const playedAt = getMonotonicTimestamp();

    const record: HistoryRecord = {
      // Остальные поля записи — пропуски, дослушивания, ранние отказы — пишут
      // `recordTrackSkip` и `recordTrackCompletion`. Собирать строку с нуля
      // значило бы стирать их при каждом включении: `put` заменяет запись
      // целиком, а не дописывает в неё.
      ...existing,
      id: track.id,
      track: { ...track },
      playedAt,
      playCount
    };

    await db.history.put(record);
    if (!options.skipEvent) {
      // Факт включения — отдельной записью, иначе окно («за неделю») посчитать
      // нечем: в строке выше от прошлых включений остаётся только их число.
      await db.plays.add({ trackId: track.id, playedAt });
      void prunePlayEvents(playedAt);
    }
  } catch (err) {
    console.error('[DB] addToHistory error:', err);
    throw err;
  }
}

export async function clearHistory(): Promise<void> {
  try {
    // События — та же история, только подробнее. Оставить их после «очистить
    // историю» значило бы, что она очищена не вся: топ за неделю продолжил бы
    // показывать то, что человек только что убрал.
    await Promise.all([db.history.clear(), db.plays.clear()]);
  } catch (err) {
    console.error('[DB] clearHistory error:', err);
    throw err;
  }
}

/**
 * Сколько храним отдельные включения.
 *
 * Самое длинное окно в итогах — месяц; год с лишним берётся с запасом на «за
 * всё время», которое считается по счётчикам в `history` и в событиях не
 * нуждается. Дальше запись становится весом без применения: одно включение —
 * это около 60 байт, но за годы их накопится столько, что чтение окна начнёт
 * задевать это всё.
 */
export const PLAY_EVENT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/** Чистим не чаще раза в шесть часов: на каждое включение это лишний обход. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * Убирает включения старше {@link PLAY_EVENT_RETENTION_MS}.
 *
 * Ошибку глотает нарочно: чистка — это уборка, и сорванная уборка не повод
 * терять само включение, которое к этому моменту уже записано.
 */
export async function prunePlayEvents(now = Date.now()): Promise<number> {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return 0;
  lastPruneAt = now;
  try {
    return await db.plays.where('playedAt').below(now - PLAY_EVENT_RETENTION_MS).delete();
  } catch (err) {
    console.warn('[DB] prunePlayEvents error:', err);
    return 0;
  }
}

/**
 * Включения за окно, от `since` и позже.
 *
 * Порядок — как в индексе, от старых к новым; итогам он безразличен, они всё
 * равно складывают. Предел стоит от греха: за месяц плотного слушания событий
 * тысячи, и незачем поднимать в память больше, чем нужно для подсчёта.
 */
export async function getPlayEvents(since: number, limit = 20_000): Promise<PlayEventRecord[]> {
  try {
    return await db.plays.where('playedAt').aboveOrEqual(since).limit(limit).toArray();
  } catch (err) {
    console.error('[DB] getPlayEvents error:', err);
    return [];
  }
}

/**
 * Время самого раннего известного включения, или `null`, если их ещё нет.
 *
 * Нужно, чтобы не врать в подписи: пока событий меньше, чем окно, «за месяц»
 * посчитано не за месяц, а с того дня, как в сборке появился этот счётчик.
 */
export async function getFirstPlayEventAt(): Promise<number | null> {
  try {
    const first = await db.plays.orderBy('playedAt').first();
    return first ? first.playedAt : null;
  } catch (err) {
    console.error('[DB] getFirstPlayEventAt error:', err);
    return null;
  }
}

/**
 * Записи истории по ключам — то, чем событие превращается в песню.
 *
 * Событие помнит только ключ трека, а название, исполнителя и источник хранит
 * `history`. Брать их из уже загруженной страницы истории нельзя: она обрезана
 * по числу записей, и у человека, слушающего много разного, трек с событием в
 * окне может в эту страницу не попасть. Поэтому спрашиваем прямо по ключам.
 *
 * Ключи, которых в базе нет, просто пропускаются.
 */
export async function getHistoryRecords(ids: string[]): Promise<HistoryRecord[]> {
  if (!ids || ids.length === 0) return [];
  try {
    const rows = await db.history.bulkGet(ids);
    return rows.filter((row): row is HistoryRecord => Boolean(row && row.track && row.track.id));
  } catch (err) {
    console.error('[DB] getHistoryRecords error:', err);
    return [];
  }
}

// --- Dislikes (Negative Feedback) ---

export async function addDislike(track: UnifiedTrack): Promise<void> {
  if (!track || !track.id) return;
  try {
    const record: DislikeRecord = {
      id: track.id,
      artist: track.artist || '',
      dislikedAt: Date.now()
    };
    await db.dislikes.put(record);
  } catch (err) {
    console.error('[DB] addDislike error:', err);
    throw err;
  }
}

export async function removeDislike(trackId: string): Promise<void> {
  if (!trackId) return;
  try {
    await db.dislikes.delete(trackId);
  } catch (err) {
    console.error('[DB] removeDislike error:', err);
    throw err;
  }
}

export async function isDisliked(trackId: string): Promise<boolean> {
  if (!trackId) return false;
  try {
    const item = await db.dislikes.get(trackId);
    return !!item;
  } catch (err) {
    console.error('[DB] isDisliked error:', err);
    return false;
  }
}

export async function getDislikes(): Promise<DislikeRecord[]> {
  try {
    return await db.dislikes.orderBy('dislikedAt').reverse().toArray();
  } catch (err) {
    console.error('[DB] getDislikes error:', err);
    return [];
  }
}

export async function getDislikedTrackIds(): Promise<Set<string>> {
  try {
    const records = await db.dislikes.toArray();
    return new Set(records.map((r) => r.id));
  } catch (err) {
    console.error('[DB] getDislikedTrackIds error:', err);
    return new Set();
  }
}

export async function clearDislikes(): Promise<void> {
  try {
    await db.dislikes.clear();
  } catch (err) {
    console.error('[DB] clearDislikes error:', err);
    throw err;
  }
}

// --- Skip & Completion Tracking ---

/**
 * Пишет пропуск. `playedSeconds` — сколько успели послушать до выключения;
 * без него пропуск считается поздним, потому что раньше эту величину никто не
 * передавал и старые записи не должны внезапно превратиться в ранние отказы.
 */
export async function recordTrackSkip(
  trackId: string,
  playedSeconds?: number
): Promise<void> {
  if (!trackId) return;
  try {
    const existing = await db.history.get(trackId);
    if (existing) {
      existing.skipCount = (existing.skipCount || 0) + 1;
      existing.lastSkippedAt = Date.now();
      if (typeof playedSeconds === 'number' && Number.isFinite(playedSeconds)) {
        existing.lastPlayedSeconds = Math.max(0, playedSeconds);
        if (playedSeconds < EARLY_SKIP_SECONDS) {
          existing.earlySkipCount = (existing.earlySkipCount || 0) + 1;
        }
      }
      await db.history.put(existing);
    }
  } catch (err) {
    console.error('[DB] recordTrackSkip error:', err);
    throw err;
  }
}

export async function recordTrackCompletion(trackId: string): Promise<void> {
  if (!trackId) return;
  try {
    const existing = await db.history.get(trackId);
    if (existing) {
      existing.completedCount = (existing.completedCount || 0) + 1;
      existing.lastCompletedAt = Date.now();
      await db.history.put(existing);
    }
  } catch (err) {
    console.error('[DB] recordTrackCompletion error:', err);
    throw err;
  }
}

// --- Settings Storage ---

export async function getSetting<T>(key: string, defaultValue?: T): Promise<T> {
  try {
    const record = await db.settings.get(key);
    if (record !== undefined && record.value !== undefined) {
      return record.value as T;
    }
    return defaultValue as T;
  } catch (err) {
    console.error(`[DB] getSetting error for key "${key}":`, err);
    return defaultValue as T;
  }
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  try {
    await db.settings.put({
      key,
      value,
      updatedAt: Date.now()
    });
  } catch (err) {
    console.error(`[DB] setSetting error for key "${key}":`, err);
    throw err;
  }
}

/** Flat snapshot of every persisted setting, used by library backups. */
export async function getAllSettings(): Promise<Record<string, unknown>> {
  try {
    const records = await db.settings.toArray();
    return records.reduce<Record<string, unknown>>((acc, record) => {
      if (record && typeof record.key === 'string') {
        acc[record.key] = record.value;
      }
      return acc;
    }, {});
  } catch (err) {
    console.error('[DB] getAllSettings error:', err);
    return {};
  }
}

// --- Offline Tracks ---

export async function getOfflineTracks(): Promise<OfflineTrackRecord[]> {
  try {
    return await db.offlineTracks.orderBy('downloadedAt').reverse().toArray();
  } catch (err) {
    console.error('[DB] getOfflineTracks error:', err);
    return [];
  }
}

export async function getOfflineTrack(trackId: string): Promise<OfflineTrackRecord | undefined> {
  try {
    return await db.offlineTracks.get(trackId);
  } catch (err) {
    console.error('[DB] getOfflineTrack error:', err);
    return undefined;
  }
}

export async function saveOfflineTrack(record: OfflineTrackRecord): Promise<void> {
  try {
    await db.offlineTracks.put(record);
  } catch (err) {
    console.error('[DB] saveOfflineTrack error:', err);
    throw err;
  }
}

export async function deleteOfflineTrack(trackId: string): Promise<void> {
  try {
    await db.offlineTracks.delete(trackId);
  } catch (err) {
    console.error('[DB] deleteOfflineTrack error:', err);
    throw err;
  }
}

export async function isOfflineTrack(trackId: string): Promise<boolean> {
  try {
    const item = await db.offlineTracks.get(trackId);
    return !!item;
  } catch (err) {
    console.error('[DB] isOfflineTrack error:', err);
    return false;
  }
}

export async function clearOfflineTracks(): Promise<void> {
  try {
    await db.offlineTracks.clear();
  } catch (err) {
    console.error('[DB] clearOfflineTracks error:', err);
    throw err;
  }
}

// --- Database Maintenance ---

export async function clearAllData(): Promise<void> {
  try {
    await Promise.all([
      db.tracks.clear(),
      db.playlists.clear(),
      db.favorites.clear(),
      db.history.clear(),
      db.plays.clear(),
      db.settings.clear(),
      db.dislikes.clear(),
      db.offlineTracks.clear(),
      db.lyrics.clear()
    ]);
  } catch (err) {
    console.error('[DB] clearAllData error:', err);
    throw err;
  }
}

// Unified dbService facade matching interface contracts
export const dbService = {
  db,
  addFavorite,
  removeFavorite,
  isFavorite,
  getFavoriteById,
  getFavorites,
  clearFavorites,
  getPlaylists,
  getPlaylistById,
  savePlaylist,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
  clearPlaylists,
  getHistory,
  getHistoryTracks,
  getHistoryRecords,
  addToHistory,
  clearHistory,
  getPlayEvents,
  getFirstPlayEventAt,
  prunePlayEvents,
  addDislike,
  removeDislike,
  isDisliked,
  getDislikes,
  getDislikedTrackIds,
  clearDislikes,
  recordTrackSkip,
  recordTrackCompletion,
  getSetting,
  setSetting,
  getAllSettings,
  getOfflineTracks,
  getOfflineTrack,
  saveOfflineTrack,
  deleteOfflineTrack,
  isOfflineTrack,
  clearOfflineTracks,
  clearAllData
};

