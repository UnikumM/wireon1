import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../setup';
import {
  db,
  WireonDB,
  addFavorite,
  removeFavorite,
  isFavorite,
  getFavorites,
  createPlaylist,
  getPlaylists,
  getPlaylistById,
  savePlaylist,
  renamePlaylist,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
  addToHistory,
  getHistory,
  getHistoryTracks,
  getHistoryRecords,
  clearHistory,
  getPlayEvents,
  getFirstPlayEventAt,
  prunePlayEvents,
  PLAY_EVENT_RETENTION_MS,
  clearFavorites,
  clearPlaylists,
  getSetting,
  setSetting,
  getAllSettings,
  clearAllData,
  addDislike,
  removeDislike,
  isDisliked,
  getDislikes,
  getDislikedTrackIds,
  clearDislikes,
  recordTrackSkip,
  recordTrackCompletion,
  dbService
} from '../../src/services/db';
import { UnifiedTrack, Playlist } from '../../src/types/music';

const mockTrack1: UnifiedTrack = {
  id: 'yt_test123',
  source: 'youtube',
  originalId: 'test123',
  title: 'Test Song 1',
  artist: 'Artist A',
  duration: 210,
  artworkUrl: 'https://example.com/art1.jpg'
};

const mockTrack2: UnifiedTrack = {
  id: 'sc_test456',
  source: 'soundcloud',
  originalId: 'test456',
  title: 'Test Song 2',
  artist: 'Artist B',
  duration: 180,
  artworkUrl: 'https://example.com/art2.jpg'
};

const mockTrack3: UnifiedTrack = {
  id: 'yt_test789',
  source: 'youtube',
  originalId: 'test789',
  title: 'Test Song 3',
  artist: 'Artist C',
  duration: 300,
  artworkUrl: 'https://example.com/art3.jpg'
};

describe('Database Service (Dexie.js WireonDB)', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  afterEach(async () => {
    await clearAllData();
  });

  it('instantiates WireonDB with required tables', () => {
    expect(db).toBeDefined();
    expect(db.name).toBe('WireonDB');
    expect(db.tracks).toBeDefined();
    expect(db.playlists).toBeDefined();

    const customDb = new WireonDB('CustomTestDB');
    expect(customDb.tracks).toBeDefined();
    expect(customDb.playlists).toBeDefined();
    expect(customDb.favorites).toBeDefined();
    expect(customDb.history).toBeDefined();
    expect(customDb.settings).toBeDefined();
    expect(customDb.dislikes).toBeDefined();
    expect(customDb.plays).toBeDefined();
  });

  describe('Favorites CRUD', () => {
    it('adds and retrieves favorite tracks sorted by addedAt descending', async () => {
      await addFavorite({ ...mockTrack1, addedAt: 1000 });
      await addFavorite({ ...mockTrack2, addedAt: 2000 });

      expect(await isFavorite('yt_test123')).toBe(true);
      expect(await isFavorite('sc_test456')).toBe(true);
      expect(await isFavorite('yt_nonexistent')).toBe(false);

      const favs = await getFavorites();
      expect(favs).toHaveLength(2);
      expect(favs[0].id).toBe('sc_test456'); // addedAt 2000 comes first
      expect(favs[1].id).toBe('yt_test123');
    });

    it('removes a track from favorites', async () => {
      await addFavorite(mockTrack1);
      expect(await isFavorite('yt_test123')).toBe(true);

      await removeFavorite('yt_test123');
      expect(await isFavorite('yt_test123')).toBe(false);
      const favs = await getFavorites();
      expect(favs).toHaveLength(0);
    });
  });

  describe('Playlists CRUD & Track Manipulation', () => {
    it('creates and fetches a playlist', async () => {
      const pl = await createPlaylist('Synthwave Vibes', 'Chill retro music');
      expect(pl.id).toBeDefined();
      expect(pl.title).toBe('Synthwave Vibes');
      expect(pl.description).toBe('Chill retro music');
      expect(pl.tracks).toEqual([]);

      const all = await getPlaylists();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(pl.id);

      const byId = await getPlaylistById(pl.id);
      expect(byId?.title).toBe('Synthwave Vibes');
    });

    it('renames and deletes a playlist, returning the stored record', async () => {
      const pl = await createPlaylist('Old Name');
      const renamed = await renamePlaylist(pl.id, 'New Name');

      expect(renamed.title).toBe('New Name');
      expect(renamed.updatedAt).toBeGreaterThanOrEqual(pl.updatedAt);

      const updated = await getPlaylistById(pl.id);
      expect(updated).toEqual(renamed);

      await deletePlaylist(pl.id);
      const afterDelete = await getPlaylistById(pl.id);
      expect(afterDelete).toBeUndefined();
    });

    it('adds, removes, and reorders tracks in a playlist', async () => {
      const pl = await createPlaylist('My Mix');
      await addTrackToPlaylist(pl.id, mockTrack1);
      await addTrackToPlaylist(pl.id, mockTrack2);
      const afterAdd = await addTrackToPlaylist(pl.id, mockTrack3);

      // Every mutator hands back exactly what it stored.
      expect(afterAdd.tracks).toHaveLength(3);
      expect(await getPlaylistById(pl.id)).toEqual(afterAdd);

      let fetched = await getPlaylistById(pl.id);
      expect(fetched?.tracks).toHaveLength(3);
      expect(fetched?.tracks[0].id).toBe('yt_test123');
      expect(fetched?.tracks[1].id).toBe('sc_test456');
      expect(fetched?.tracks[2].id).toBe('yt_test789');

      // Reorder track from index 2 to index 0
      const afterReorder = await reorderPlaylistTracks(pl.id, 2, 0);
      expect(afterReorder.tracks[0].id).toBe('yt_test789');
      fetched = await getPlaylistById(pl.id);
      expect(fetched?.tracks[0].id).toBe('yt_test789');
      expect(fetched?.tracks[1].id).toBe('yt_test123');
      expect(fetched?.tracks[2].id).toBe('sc_test456');

      // Remove track at index 1 (yt_test123)
      const afterRemove = await removeTrackFromPlaylist(pl.id, 1);
      expect(afterRemove.tracks).toHaveLength(2);
      fetched = await getPlaylistById(pl.id);
      expect(fetched?.tracks).toHaveLength(2);
      expect(fetched?.tracks[0].id).toBe('yt_test789');
      expect(fetched?.tracks[1].id).toBe('sc_test456');
    });

    it('throws error when modifying non-existent playlist or out of bounds', async () => {
      await expect(renamePlaylist('invalid_id', 'Test')).rejects.toThrow();
      await expect(addTrackToPlaylist('invalid_id', mockTrack1)).rejects.toThrow();

      const pl = await createPlaylist('Bounds Test');
      await expect(removeTrackFromPlaylist(pl.id, 5)).rejects.toThrow();
      await expect(reorderPlaylistTracks(pl.id, 0, 5)).rejects.toThrow();
    });

    it('saves a full playlist object and preserves the caller updatedAt', async () => {
      const pl: Playlist = {
        id: 'custom_pl_1',
        title: 'Custom',
        tracks: [mockTrack1],
        createdAt: 1000,
        updatedAt: 1000,
        isSynced: true
      };

      await savePlaylist(pl);
      const fetched = await getPlaylistById('custom_pl_1');
      expect(fetched?.title).toBe('Custom');
      expect(fetched?.tracks).toHaveLength(1);
      // Last-Write-Wins compares updatedAt: a replayed record must not look fresh.
      expect(fetched?.updatedAt).toBe(1000);

      await savePlaylist({ ...pl, title: 'Merged from elsewhere', updatedAt: 2500 });
      expect((await getPlaylistById('custom_pl_1'))?.updatedAt).toBe(2500);
    });

    it('defaults updatedAt only when the caller left it out', async () => {
      const before = Date.now();
      const withoutTimestamp = {
        id: 'custom_pl_2',
        title: 'No timestamp',
        tracks: [],
        createdAt: 500,
        isSynced: false
      } as unknown as Playlist;

      await savePlaylist(withoutTimestamp);
      const stored = await getPlaylistById('custom_pl_2');

      expect(stored?.updatedAt).toBeGreaterThanOrEqual(before);
      expect(stored?.updatedAt).toBeLessThanOrEqual(Date.now());
    });

    it('clears playlists and favorites for a replace-style import', async () => {
      await createPlaylist('Doomed');
      await addFavorite(mockTrack1);

      await clearPlaylists();
      await clearFavorites();

      expect(await getPlaylists()).toHaveLength(0);
      expect(await getFavorites()).toHaveLength(0);
    });
  });

  describe('Listening History', () => {
    it('records played tracks and increments play counts on repeated plays', async () => {
      await addToHistory(mockTrack1);
      await addToHistory(mockTrack2);
      await addToHistory(mockTrack1); // second play

      const history = await getHistory();
      expect(history).toHaveLength(2);

      const track1Record = history.find((h) => h.id === 'yt_test123');
      expect(track1Record?.playCount).toBe(2);

      const track2Record = history.find((h) => h.id === 'sc_test456');
      expect(track2Record?.playCount).toBe(1);

      const tracks = await getHistoryTracks(1);
      expect(tracks).toHaveLength(1);
      expect(tracks[0].id).toBe('yt_test123'); // most recent
    });

    it('clears history completely', async () => {
      await addToHistory(mockTrack1);
      await clearHistory();
      const history = await getHistory();
      expect(history).toHaveLength(0);
    });

    it('keeps the skip and completion counters a replay would otherwise wipe', async () => {
      // `put` replaces the whole row, so a play that rebuilt the record from
      // scratch erased everything the skip and completion writers had put there.
      await addToHistory(mockTrack1);
      await recordTrackSkip('yt_test123', 3);
      await recordTrackCompletion('yt_test123');

      await addToHistory(mockTrack1);

      const record = await db.history.get('yt_test123');
      expect(record?.playCount).toBe(2);
      expect(record?.skipCount).toBe(1);
      expect(record?.earlySkipCount).toBe(1);
      expect(record?.completedCount).toBe(1);
    });
  });

  /**
   * Individual plays, as opposed to the per-track counter next to them.
   *
   * The counter cannot answer "what did I listen to this week": it knows how
   * many plays there were and when the last one was, and nothing in between.
   * These rows are what a windowed top is actually computed from.
   */
  describe('Play events', () => {
    it('writes one event per play and reads a window back', async () => {
      await addToHistory(mockTrack1);
      await addToHistory(mockTrack1);
      await addToHistory(mockTrack2);

      const events = await getPlayEvents(0);
      expect(events).toHaveLength(3);
      expect(events.filter((e) => e.trackId === 'yt_test123')).toHaveLength(2);
      // Every event carries its own moment; the counter only kept the last one.
      expect(events.every((e) => e.playedAt > 0)).toBe(true);
    });

    it('reads only what falls inside the window', async () => {
      const now = Date.now();
      await db.plays.bulkAdd([
        { trackId: 'yt_test123', playedAt: now - 2 * 60 * 60 * 1000 },
        { trackId: 'yt_test123', playedAt: now - 40 * 24 * 60 * 60 * 1000 }
      ]);

      const recent = await getPlayEvents(now - 7 * 24 * 60 * 60 * 1000);
      expect(recent).toHaveLength(1);
      expect(await getPlayEvents(0)).toHaveLength(2);
    });

    it('reports the first known play, so a short window can say so', async () => {
      expect(await getFirstPlayEventAt()).toBeNull();

      const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
      await db.plays.bulkAdd([
        { trackId: 'yt_test123', playedAt: Date.now() },
        { trackId: 'sc_test456', playedAt: old }
      ]);

      expect(await getFirstPlayEventAt()).toBe(old);
    });

    it('clearing the history clears the events with it', async () => {
      await addToHistory(mockTrack1);
      expect(await getPlayEvents(0)).toHaveLength(1);

      await clearHistory();

      expect(await getPlayEvents(0)).toHaveLength(0);
    });

    it('drops events past the retention window and keeps the rest', async () => {
      const now = Date.now();
      await db.plays.bulkAdd([
        { trackId: 'yt_test123', playedAt: now - PLAY_EVENT_RETENTION_MS - 60_000 },
        { trackId: 'yt_test123', playedAt: now - 24 * 60 * 60 * 1000 }
      ]);

      // Nudged past the throttle: pruning runs at most once every few hours, and
      // an earlier play in this process may already have used up that window.
      // Six hours is nothing against a retention window of over a year.
      const deleted = await prunePlayEvents(now + 6 * 60 * 60 * 1000);

      expect(deleted).toBe(1);
      const left = await getPlayEvents(0);
      expect(left).toHaveLength(1);
      expect(left[0].playedAt).toBeGreaterThan(now - PLAY_EVENT_RETENTION_MS);
    });

    it('can count a play without dating it, for a restored backup', async () => {
      await addToHistory(mockTrack1, { skipEvent: true });

      // The counter has it; the week does not, because a backup does not say
      // when the track was played and "now" would be an invention.
      expect((await db.history.get('yt_test123'))?.playCount).toBe(1);
      expect(await getPlayEvents(0)).toHaveLength(0);
    });

    it('resolves history rows by id, for events outside the loaded page', async () => {
      await addToHistory(mockTrack1);
      await addToHistory(mockTrack2);

      const rows = await getHistoryRecords(['sc_test456', 'yt_missing', 'yt_test123']);

      expect(rows.map((r) => r.id).sort()).toEqual(['sc_test456', 'yt_test123']);
      expect(await getHistoryRecords([])).toEqual([]);
    });
  });

  describe('Settings Storage', () => {
    it('sets and retrieves settings with fallback to default values', async () => {
      expect(await getSetting('volume', 0.8)).toBe(0.8);

      await setSetting('volume', 0.5);
      expect(await getSetting('volume', 0.8)).toBe(0.5);

      await setSetting('theme', { mode: 'dark', glow: true });
      expect(await getSetting('theme')).toEqual({ mode: 'dark', glow: true });
    });

    it('returns a flat snapshot of every setting for library backups', async () => {
      expect(await getAllSettings()).toEqual({});

      await setSetting('volume', 0.42);
      await setSetting('theme', { mode: 'dark' });

      expect(await getAllSettings()).toEqual({ volume: 0.42, theme: { mode: 'dark' } });
    });
  });

  describe('Dislikes CRUD & Negative Signals', () => {
    it('adds and retrieves dislikes', async () => {
      expect(await isDisliked('yt_test123')).toBe(false);

      await addDislike(mockTrack1);
      expect(await isDisliked('yt_test123')).toBe(true);

      const dislikes = await getDislikes();
      expect(dislikes).toHaveLength(1);
      expect(dislikes[0].id).toBe('yt_test123');
      expect(dislikes[0].artist).toBe('Artist A');

      const idSet = await getDislikedTrackIds();
      expect(idSet.has('yt_test123')).toBe(true);
      expect(idSet.has('sc_test456')).toBe(false);
    });

    it('removes a dislike', async () => {
      await addDislike(mockTrack1);
      await addDislike(mockTrack2);
      expect(await isDisliked('yt_test123')).toBe(true);

      await removeDislike('yt_test123');
      expect(await isDisliked('yt_test123')).toBe(false);
      expect(await isDisliked('sc_test456')).toBe(true);

      const remaining = await getDislikes();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('sc_test456');
    });

    it('clears all dislikes', async () => {
      await addDislike(mockTrack1);
      await addDislike(mockTrack2);
      await clearDislikes();

      const dislikes = await getDislikes();
      expect(dislikes).toHaveLength(0);
      const idSet = await getDislikedTrackIds();
      expect(idSet.size).toBe(0);
    });
  });

  describe('Track Skip & Completion Tracking', () => {
    it('records skips and increments skipCount in history', async () => {
      await addToHistory(mockTrack1);
      await recordTrackSkip('yt_test123');
      await recordTrackSkip('yt_test123');

      const history = await getHistory();
      const track1 = history.find((h) => h.id === 'yt_test123');
      expect(track1?.skipCount).toBe(2);
      expect(track1?.lastSkippedAt).toBeGreaterThan(0);
    });

    it('records completions and increments completedCount in history', async () => {
      await addToHistory(mockTrack1);
      await recordTrackCompletion('yt_test123');

      const history = await getHistory();
      const track1 = history.find((h) => h.id === 'yt_test123');
      expect(track1?.completedCount).toBe(1);
      expect(track1?.lastCompletedAt).toBeGreaterThan(0);
    });

    it('handles recordTrackSkip and recordTrackCompletion on non-existent history safely', async () => {
      await expect(recordTrackSkip('non_existent_id')).resolves.not.toThrow();
      await expect(recordTrackCompletion('non_existent_id')).resolves.not.toThrow();
    });
  });

  describe('dbService Facade', () => {
    it('exposes all database methods matching interface contract', () => {
      expect(typeof dbService.addDislike).toBe('function');
      expect(typeof dbService.removeDislike).toBe('function');
      expect(typeof dbService.isDisliked).toBe('function');
      expect(typeof dbService.getDislikes).toBe('function');
      expect(typeof dbService.getDislikedTrackIds).toBe('function');
      expect(typeof dbService.getFavorites).toBe('function');
      expect(typeof dbService.getHistory).toBe('function');
      expect(typeof dbService.recordTrackSkip).toBe('function');
      expect(typeof dbService.recordTrackCompletion).toBe('function');
    });
  });
});
