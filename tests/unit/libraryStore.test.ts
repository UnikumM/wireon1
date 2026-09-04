import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { clearAllData, db, getPlaylistById, savePlaylist } from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';
import { resetAuthStore, signInForTests } from '../helpers/testUtils';
import { useUIStore } from '../../src/store/useUIStore';

const mockTrack1: UnifiedTrack = {
  id: 'yt_lib_1',
  source: 'youtube',
  originalId: 'lib_1',
  title: 'Library Track 1',
  artist: 'Artist One',
  duration: 150,
  artworkUrl: 'https://example.com/art1.png'
};

const mockTrack2: UnifiedTrack = {
  id: 'sc_lib_2',
  source: 'soundcloud',
  originalId: 'lib_2',
  title: 'Library Track 2',
  artist: 'Artist Two',
  duration: 210,
  artworkUrl: 'https://example.com/art2.png'
};

const mockTrack3: UnifiedTrack = {
  id: 'yt_lib_3',
  source: 'youtube',
  originalId: 'lib_3',
  title: 'Library Track 3',
  artist: 'Artist Three',
  duration: 180,
  artworkUrl: 'https://example.com/art3.png'
};

const store = () => useLibraryStore.getState();

describe('Library Store (useLibraryStore & IndexedDB Persistence)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearAllData();
    useLibraryStore.setState({
      favorites: [],
      playlists: [],
      history: [],
      isLoading: false,
      error: null
    });
    // Медиатека принадлежит аккаунту: у гостя она пополняться не может, и
    // проверки её механики начинались бы с приглашения войти.
    signInForTests();
  });

  afterEach(async () => {
    if (!db.isOpen()) await db.open();
    await clearAllData();
  });

  it('manages favorites with instant state update and database synchronization', async () => {
    expect(store().isFavorite('yt_lib_1')).toBe(false);

    expect(await store().toggleFavorite(mockTrack1)).toBe(true);
    expect(store().isFavorite('yt_lib_1')).toBe(true);
    expect(store().favorites).toHaveLength(1);
    expect(store().error).toBeNull();

    expect(await store().toggleFavorite(mockTrack1)).toBe(true);
    expect(store().isFavorite('yt_lib_1')).toBe(false);
    expect(store().favorites).toHaveLength(0);
  });

  it('creates, renames, and deletes playlists', async () => {
    const pl = await store().createPlaylist('Cyber Beats', 'High bpm');
    expect(pl).not.toBeNull();
    expect(pl?.title).toBe('Cyber Beats');
    expect(store().playlists).toHaveLength(1);

    expect(await store().renamePlaylist(pl!.id, 'Obsidian Beats')).toBe(true);
    expect(store().playlists[0].title).toBe('Obsidian Beats');
    // The store mirrors the stored record, timestamp included.
    expect(store().playlists[0]).toEqual(await getPlaylistById(pl!.id));

    expect(await store().deletePlaylist(pl!.id)).toBe(true);
    expect(store().playlists).toHaveLength(0);
    expect(store().error).toBeNull();
  });

  it('adds, removes, and reorders tracks inside a playlist', async () => {
    const pl = await store().createPlaylist('Mix Playlist');
    expect(pl).not.toBeNull();
    const playlistId = pl!.id;

    expect(await store().addTrackToPlaylist(playlistId, mockTrack1)).toBe(true);
    await store().addTrackToPlaylist(playlistId, mockTrack2);
    await store().addTrackToPlaylist(playlistId, mockTrack3);

    let currentPl = store().playlists.find((p) => p.id === playlistId);
    expect(currentPl?.tracks).toHaveLength(3);
    expect(currentPl?.tracks.map((t) => t.id)).toEqual(['yt_lib_1', 'sc_lib_2', 'yt_lib_3']);

    // Reorder: Move track 2 (yt_lib_3) to position 0
    expect(await store().reorderPlaylistTracks(playlistId, 2, 0)).toBe(true);
    currentPl = store().playlists.find((p) => p.id === playlistId);
    expect(currentPl?.tracks.map((t) => t.id)).toEqual(['yt_lib_3', 'yt_lib_1', 'sc_lib_2']);

    // Remove track at index 1 (yt_lib_1)
    expect(await store().removeTrackFromPlaylist(playlistId, 1)).toBe(true);
    currentPl = store().playlists.find((p) => p.id === playlistId);
    expect(currentPl?.tracks.map((t) => t.id)).toEqual(['yt_lib_3', 'sc_lib_2']);
    expect(currentPl).toEqual(await getPlaylistById(playlistId));
  });

  it('manages history and loads initial data from IndexedDB', async () => {
    expect(await store().addToHistory(mockTrack1)).toBe(true);
    await store().addToHistory(mockTrack2);

    expect(store().history).toHaveLength(2);
    expect(store().history[0].id).toBe('sc_lib_2'); // latest

    // Clear state in memory and reload from IndexedDB
    useLibraryStore.setState({ favorites: [], playlists: [], history: [] });
    expect(await store().loadInitialData()).toBe(true);

    expect(store().history).toHaveLength(2);
    expect(store().isLoading).toBe(false);

    expect(await store().clearHistory()).toBe(true);
    expect(store().history).toHaveLength(0);
  });

  // ==========================================================================
  // Error policy: catch, record `error`, return false — never reject
  // ==========================================================================
  describe('Error policy', () => {
    it('returns false and records an error instead of rejecting', async () => {
      const errors: Array<string | null> = [];
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(store().renamePlaylist('missing_playlist', 'Nope')).resolves.toBe(false);
      errors.push(store().error);
      expect(store().error).toContain('Не удалось переименовать плейлист');

      store().clearError();
      expect(store().error).toBeNull();

      await expect(store().addTrackToPlaylist('missing_playlist', mockTrack1)).resolves.toBe(false);
      errors.push(store().error);

      const pl = await store().createPlaylist('Bounds');
      await expect(store().removeTrackFromPlaylist(pl!.id, 42)).resolves.toBe(false);
      errors.push(store().error);
      await expect(store().reorderPlaylistTracks(pl!.id, 0, 42)).resolves.toBe(false);
      errors.push(store().error);

      expect(errors.every((message) => typeof message === 'string' && message.length > 0)).toBe(true);
    });

    it('keeps the state consistent when a playlist edit fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const pl = await store().createPlaylist('Untouched');
      await store().addTrackToPlaylist(pl!.id, mockTrack1);
      const before = store().playlists;

      expect(await store().removeTrackFromPlaylist(pl!.id, 99)).toBe(false);

      expect(store().playlists).toEqual(before);
      expect(store().playlists[0].tracks).toHaveLength(1);
      expect(store().playlists[0]).toEqual(await getPlaylistById(pl!.id));
    });

    it('rejects a track without an id without touching the database', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const invalid = { ...mockTrack1, id: '' };

      expect(await store().toggleFavorite(invalid)).toBe(false);
      expect(store().favorites).toHaveLength(0);
      expect(store().error).toContain('Не удалось обновить избранное');

      expect(await store().addToHistory(invalid)).toBe(false);
      expect(store().history).toHaveLength(0);
    });

    it('createPlaylist resolves to null when the database is unavailable', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      db.close();

      const created = await store().createPlaylist('Doomed');

      expect(created).toBeNull();
      expect(store().playlists).toHaveLength(0);
      expect(store().error).toContain('Не удалось создать плейлист');

      await db.open();
      expect(await store().createPlaylist('Recovered')).not.toBeNull();
      expect(store().error).toBeNull();
    });

    it('mirrors an externally merged playlist after loadInitialData', async () => {
      // A sync merge writes straight to the database with its own updatedAt.
      await savePlaylist({
        id: 'pl_merged',
        title: 'Merged elsewhere',
        tracks: [mockTrack2],
        createdAt: 500,
        updatedAt: 4242,
        isSynced: false
      });

      await store().loadInitialData();

      const merged = store().playlists.find((p) => p.id === 'pl_merged');
      expect(merged?.updatedAt).toBe(4242);
    });
  });
  /**
   * Медиатека принадлежит аккаунту Discord — по нему сервер и узнаёт, чья она.
   * До этого приложение послушно складывало плейлисты гостя в местную базу, и
   * человек узнавал правду только тогда, когда открывал второе устройство и не
   * находил там ничего.
   */
  describe('Медиатека без аккаунта', () => {
    beforeEach(() => {
      resetAuthStore();
      useUIStore.setState({ accountPrompt: null });
    });

    it('не даёт добавить трек в избранное и объясняет, чего не хватает', async () => {
      expect(await store().toggleFavorite(mockTrack1)).toBe(false);
      expect(store().favorites).toHaveLength(0);
      expect(useUIStore.getState().accountPrompt).toBe('добавлять треки в избранное');
      // Это не поломка: об отказе говорит приглашение, а не строка ошибки.
      expect(store().error).toBeNull();
    });

    it('не даёт завести плейлист и пополнить его', async () => {
      expect(await store().createPlaylist('Гостевой')).toBeNull();
      expect(store().playlists).toHaveLength(0);
      expect(useUIStore.getState().accountPrompt).toBe('создавать плейлисты');

      signInForTests();
      const created = await store().createPlaylist('Свой');
      expect(created).not.toBeNull();

      resetAuthStore();
      useUIStore.setState({ accountPrompt: null });
      expect(await store().addTrackToPlaylist(created!.id, mockTrack1)).toBe(false);
      expect(useUIStore.getState().accountPrompt).toBe('пополнять плейлисты');
    });

    it('оставляет гостю право убрать то, что уже лежит на устройстве', async () => {
      // Заводим избранное со входом, потом выходим: записи никуда не делись, и
      // запирать человека внутри его же данных было бы наказанием, а не
      // правилом.
      signInForTests();
      expect(await store().toggleFavorite(mockTrack1)).toBe(true);

      resetAuthStore();
      useUIStore.setState({ accountPrompt: null });
      expect(await store().toggleFavorite(mockTrack1)).toBe(true);
      expect(store().favorites).toHaveLength(0);
      expect(useUIStore.getState().accountPrompt).toBeNull();
    });
  });
});
