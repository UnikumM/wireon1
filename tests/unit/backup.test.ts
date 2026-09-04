import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  BACKUP_VERSION,
  BackupError,
  LibraryBackup,
  backupToBlob,
  exportLibrary,
  importLibrary
} from '../../src/services/backup';
import * as dbService from '../../src/services/db';
import { Playlist, UnifiedTrack } from '../../src/types/music';

const trackA: UnifiedTrack = {
  id: 'yt_backup_a',
  source: 'youtube',
  originalId: 'backup_a',
  title: 'Backup Track A',
  artist: 'Artist A',
  duration: 120,
  artworkUrl: 'https://example.com/a.jpg',
  addedAt: 1000
};

const trackB: UnifiedTrack = {
  id: 'sc_backup_b',
  source: 'soundcloud',
  originalId: 'backup_b',
  title: 'Backup Track B',
  artist: 'Artist B',
  duration: 240,
  artworkUrl: 'https://example.com/b.jpg',
  addedAt: 2000
};

const playlistA: Playlist = {
  id: 'pl_backup_a',
  title: 'Backup Mix',
  description: 'Exported',
  coverUrl: '',
  tracks: [trackA],
  createdAt: 1000,
  updatedAt: 1000,
  isSynced: false
};

function backupOf(overrides: Partial<LibraryBackup> = {}): LibraryBackup {
  return {
    version: BACKUP_VERSION,
    exportedAt: 1700000000000,
    favorites: [],
    playlists: [],
    history: [],
    settings: {},
    ...overrides
  };
}

/** jsdom's Blob has no `text()`, so fall back to FileReader. */
function readBlob(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('Library Backup (src/services/backup.ts)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await dbService.clearAllData();
  });

  afterEach(async () => {
    await dbService.clearAllData();
  });

  // ==========================================================================
  // 1. Export
  // ==========================================================================
  describe('exportLibrary', () => {
    it('captures favorites, playlists, history and user settings', async () => {
      await dbService.addFavorite(trackA);
      await dbService.savePlaylist(playlistA);
      await dbService.addToHistory(trackB);
      await dbService.setSetting('volume', 0.42);
      // Sync bookkeeping is machine state, not library content.
      await dbService.setSetting('pending_sync_mutations', [{ id: 'mut_1' }]);

      const backup = await exportLibrary();

      expect(backup.version).toBe(1);
      expect(backup.exportedAt).toBeLessThanOrEqual(Date.now());
      expect(backup.favorites.map((t) => t.id)).toEqual([trackA.id]);
      expect(backup.playlists.map((p) => p.id)).toEqual([playlistA.id]);
      expect(backup.history.map((t) => t.id)).toEqual([trackB.id]);
      expect(backup.settings).toEqual({ volume: 0.42 });
    });

    it('serializes to a pretty-printed JSON blob', async () => {
      await dbService.addFavorite(trackA);
      const backup = await exportLibrary();
      const blob = backupToBlob(backup);

      expect(blob.type).toBe('application/json');

      const text = await readBlob(blob);
      expect(text).toContain('\n  "version": 1');
      expect(JSON.parse(text).favorites[0].id).toBe(trackA.id);
    });

    it('round-trips through importLibrary', async () => {
      await dbService.addFavorite(trackA);
      await dbService.savePlaylist(playlistA);
      await dbService.addToHistory(trackB);

      const json = await readBlob(backupToBlob(await exportLibrary()));
      await dbService.clearAllData();

      const summary = await importLibrary(json, 'replace');

      expect(summary).toEqual({ favorites: 1, playlists: 1, history: 1 });
      expect((await dbService.getFavorites()).map((t) => t.id)).toEqual([trackA.id]);
      expect((await dbService.getPlaylists()).map((p) => p.id)).toEqual([playlistA.id]);
      expect((await dbService.getHistoryTracks()).map((t) => t.id)).toEqual([trackB.id]);
    });
  });

  // ==========================================================================
  // 2. Defensive validation
  // ==========================================================================
  describe('importLibrary validation', () => {
    it('rejects malformed JSON without touching the database', async () => {
      await dbService.addFavorite(trackA);

      await expect(importLibrary('{"version": 1, ', 'merge')).rejects.toBeInstanceOf(BackupError);
      await expect(importLibrary('not json at all', 'merge')).rejects.toMatchObject({ code: 'INVALID_JSON' });
      await expect(importLibrary('', 'merge')).rejects.toMatchObject({ code: 'INVALID_JSON' });

      expect(await dbService.getFavorites()).toHaveLength(1);
    });

    it('rejects JSON that is not a backup document', async () => {
      await expect(importLibrary('[1,2,3]', 'merge')).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });
      await expect(importLibrary('"just a string"', 'merge')).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });
      // No version field at all means somebody else's JSON, not an older
      // Wireon release — reporting "version undefined" would be misleading.
      await expect(importLibrary(JSON.stringify({ favorites: [] }), 'merge')).rejects.toMatchObject({
        code: 'NOT_A_BACKUP'
      });
      await expect(importLibrary(JSON.stringify(backupOf({ version: 2 as 1 })), 'merge')).rejects.toMatchObject({
        code: 'UNSUPPORTED_VERSION'
      });
    });

    it('rejects records that cannot be reconstructed and writes nothing', async () => {
      const badTrack = JSON.stringify(
        backupOf({ favorites: [{ ...trackA, id: '' } as UnifiedTrack, trackB] })
      );
      await expect(importLibrary(badTrack, 'merge')).rejects.toMatchObject({ code: 'INVALID_RECORD' });

      const badSource = JSON.stringify(
        backupOf({ favorites: [{ ...trackA, source: 'napster' } as unknown as UnifiedTrack] })
      );
      await expect(importLibrary(badSource, 'merge')).rejects.toMatchObject({ code: 'INVALID_RECORD' });

      const badShape = JSON.stringify(backupOf({ playlists: 'nope' as unknown as Playlist[] }));
      await expect(importLibrary(badShape, 'merge')).rejects.toMatchObject({ code: 'INVALID_RECORD' });

      // Nothing from the partially valid document reached the database.
      expect(await dbService.getFavorites()).toHaveLength(0);
    });

    it('rejects an unknown import mode', async () => {
      await expect(
        importLibrary(JSON.stringify(backupOf()), 'overwrite' as 'merge')
      ).rejects.toMatchObject({ code: 'IMPORT_FAILED' });
    });

    it('normalizes sparse records instead of failing', async () => {
      const sparse = JSON.stringify(
        backupOf({
          favorites: [{ id: 'yt_sparse', source: 'youtube' } as UnifiedTrack],
          playlists: [{ id: 'pl_sparse', isSynced: true } as unknown as Playlist]
        })
      );

      const summary = await importLibrary(sparse, 'merge');

      expect(summary.favorites).toBe(1);
      const [favorite] = await dbService.getFavorites();
      expect(favorite.title).toBe('Без названия');
      expect(favorite.artist).toBe('Неизвестный исполнитель');
      expect(favorite.duration).toBe(0);

      const stored = await dbService.getPlaylistById('pl_sparse');
      expect(stored?.title).toBe('Плейлист без названия');
      expect(stored?.tracks).toEqual([]);
      // An imported playlist has never been confirmed by a remote.
      expect(stored?.isSynced).toBe(false);
    });
  });

  // ==========================================================================
  // 3. Merge vs replace
  // ==========================================================================
  describe('import modes', () => {
    it('merges without creating duplicates', async () => {
      await dbService.addFavorite(trackA);
      await dbService.savePlaylist(playlistA);
      await dbService.addToHistory(trackA);

      const json = JSON.stringify(
        backupOf({
          favorites: [trackA, trackB],
          playlists: [playlistA],
          history: [trackA, trackB]
        })
      );

      const summary = await importLibrary(json, 'merge');

      expect(summary).toEqual({ favorites: 1, playlists: 0, history: 1 });

      const favorites = await dbService.getFavorites();
      expect(favorites).toHaveLength(2);
      expect(new Set(favorites.map((t) => t.id)).size).toBe(2);

      const playlists = await dbService.getPlaylists();
      expect(playlists).toHaveLength(1);

      const history = await dbService.getHistory();
      expect(history).toHaveLength(2);
      expect(new Set(history.map((h) => h.id)).size).toBe(2);
    });

    it('merge keeps the newer playlist and never rewinds a local edit', async () => {
      await dbService.savePlaylist({ ...playlistA, title: 'Local newer', updatedAt: 9000 });

      const json = JSON.stringify(
        backupOf({ playlists: [{ ...playlistA, title: 'Backup older', updatedAt: 1000 }] })
      );
      expect((await importLibrary(json, 'merge')).playlists).toBe(0);
      expect((await dbService.getPlaylistById(playlistA.id))?.title).toBe('Local newer');

      const newerJson = JSON.stringify(
        backupOf({ playlists: [{ ...playlistA, title: 'Backup newer', updatedAt: 12000 }] })
      );
      expect((await importLibrary(newerJson, 'merge')).playlists).toBe(1);

      const stored = await dbService.getPlaylistById(playlistA.id);
      expect(stored?.title).toBe('Backup newer');
      // savePlaylist preserved the backup timestamp, so LWW stays comparable.
      expect(stored?.updatedAt).toBe(12000);
    });

    it('replace wipes favorites, playlists and history first', async () => {
      await dbService.addFavorite(trackA);
      await dbService.savePlaylist(playlistA);
      await dbService.addToHistory(trackA);

      const json = JSON.stringify(backupOf({ favorites: [trackB], history: [trackB] }));
      const summary = await importLibrary(json, 'replace');

      expect(summary).toEqual({ favorites: 1, playlists: 0, history: 1 });
      expect((await dbService.getFavorites()).map((t) => t.id)).toEqual([trackB.id]);
      expect(await dbService.getPlaylists()).toHaveLength(0);
      expect((await dbService.getHistoryTracks()).map((t) => t.id)).toEqual([trackB.id]);
    });

    it('restores user settings but never the sync queues', async () => {
      const json = JSON.stringify(
        backupOf({
          settings: { volume: 0.11, repeatMode: 'all', pending_sync_mutations: [{ id: 'mut_x' }] }
        })
      );

      await importLibrary(json, 'merge');

      expect(await dbService.getSetting('volume')).toBe(0.11);
      expect(await dbService.getSetting('repeatMode')).toBe('all');
      expect(await dbService.getSetting('pending_sync_mutations', null)).toBeNull();
    });

    it('replays history oldest-first so the most recent play stays first', async () => {
      const json = JSON.stringify(backupOf({ history: [trackB, trackA] }));

      await importLibrary(json, 'replace');

      expect((await dbService.getHistoryTracks()).map((t) => t.id)).toEqual([trackB.id, trackA.id]);
    });
  });
});
