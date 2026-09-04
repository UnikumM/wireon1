import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  LocalFirstSyncEngine,
  NullRemoteAdapter,
  PARKED_MUTATIONS_SETTING,
  PENDING_MUTATIONS_SETTING,
  cloudSyncEngine
} from '../../src/services/cloudSync';
import * as dbService from '../../src/services/db';
import { RemoteSyncAdapter, SyncMutation, SyncStatus } from '../../src/types/auth';
import { Playlist, UnifiedTrack } from '../../src/types/music';

const sampleTrackA: UnifiedTrack = {
  id: 'yt_track_a',
  source: 'youtube',
  originalId: 'track_a',
  title: 'Cyber Skyline',
  artist: 'Neon Artist',
  duration: 200,
  artworkUrl: 'https://example.com/art_a.jpg',
  addedAt: 1000
};

const sampleTrackB: UnifiedTrack = {
  id: 'sc_track_b',
  source: 'soundcloud',
  originalId: 'track_b',
  title: 'Obsidian Midnight',
  artist: 'Glasswave Producer',
  duration: 180,
  artworkUrl: 'https://example.com/art_b.jpg',
  addedAt: 1200
};

const samplePlaylist1: Playlist = {
  id: 'pl_sync_1',
  title: 'Synthwave Odyssey',
  description: 'Cyberpunk beats for coding',
  tracks: [sampleTrackA],
  createdAt: 1000,
  updatedAt: 1000,
  isSynced: false
};

/** A remote that accepts everything, standing in for a real backend. */
function createAcceptingRemote() {
  return {
    id: 'accepting',
    isConfigured: () => true,
    pushPlaylists: vi.fn(async (playlists: Playlist[]) => playlists.length),
    pullPlaylists: vi.fn(async (): Promise<Playlist[]> => []),
    pushFavorites: vi.fn(async (tracks: UnifiedTrack[]) => tracks.length),
    pullFavorites: vi.fn(async (): Promise<UnifiedTrack[]> => []),
    deletePlaylist: vi.fn(async () => true),
    deleteFavorite: vi.fn(async () => true)
  };
}

/** A configured but broken remote, to exercise the retry/backoff path. */
function createFailingRemote(message = 'remote unreachable') {
  return {
    id: 'failing',
    isConfigured: () => true,
    pushPlaylists: vi.fn(async (_playlists: Playlist[]): Promise<number> => {
      throw new Error(message);
    }),
    pullPlaylists: vi.fn(async (): Promise<Playlist[]> => []),
    pushFavorites: vi.fn(async (_tracks: UnifiedTrack[]): Promise<number> => {
      throw new Error(message);
    }),
    pullFavorites: vi.fn(async (): Promise<UnifiedTrack[]> => []),
    deletePlaylist: vi.fn(async () => false),
    deleteFavorite: vi.fn(async () => false)
  };
}

describe('Local-First Sync Engine (src/services/cloudSync.ts)', () => {
  let engine: LocalFirstSyncEngine;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await dbService.clearAllData();
    engine = new LocalFirstSyncEngine();
    engine.setOnlineStatus(true);
  });

  afterEach(async () => {
    engine.stopPeriodicSync();
    vi.useRealTimers();
    await dbService.clearAllData();
  });

  /**
   * «Синхронизация не работает, пока не нажмёшь Проверить».
   *
   * Жалоба владельца от 2026-09-01, и она была верной наполовину. Самосверка
   * раз в минуту к тому моменту уже работала и в базу писала — но `useLibraryStore`
   * держит свою копию содержимого и про эти записи не знал. До перезапуска
   * приложения экран показывал прежнее, то есть добавленное на ПК на телефоне
   * не появлялось. Молчание движка и было второй половиной беды.
   */
  describe('Приехавшее с сервера объявляется', () => {
    it('говорит, когда местная база пополнилась чужим', async () => {
      const remote = createAcceptingRemote();
      remote.pullPlaylists.mockResolvedValue([samplePlaylist1]);
      remote.pullFavorites.mockResolvedValue([sampleTrackB]);
      engine.setRemoteAdapter(remote);

      const heard = vi.fn();
      engine.onRemoteChange(heard);

      await engine.syncAll();

      expect(heard).toHaveBeenCalledTimes(1);
    });

    it('молчит, когда сверка ничего не изменила', async () => {
      // Иначе экран перечитывал бы медиатеку каждую минуту на пустом месте.
      const remote = createAcceptingRemote();
      engine.setRemoteAdapter(remote);

      const heard = vi.fn();
      engine.onRemoteChange(heard);

      await engine.syncAll();

      expect(heard).not.toHaveBeenCalled();
    });

    it('от подписки можно отказаться', async () => {
      const remote = createAcceptingRemote();
      remote.pullFavorites.mockResolvedValue([sampleTrackB]);
      engine.setRemoteAdapter(remote);

      const heard = vi.fn();
      engine.onRemoteChange(heard)();

      await engine.syncAll();

      expect(heard).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 1. Local-Only Defaults (no backend exists)
  // ==========================================================================
  describe('Local-Only Defaults', () => {
    it('keeps the cloudSyncEngine export and defaults to the null adapter', () => {
      expect(cloudSyncEngine).toBeInstanceOf(LocalFirstSyncEngine);
      expect(engine.getRemoteAdapter()).toBeInstanceOf(NullRemoteAdapter);
      expect(engine.isRemoteConfigured()).toBe(false);
      expect(engine.getUserId()).toBeNull();

      engine.setUserId('discord_user_999');
      expect(engine.getUserId()).toBe('discord_user_999');
    });

    it('reports no in-memory pseudo-cloud on the engine', () => {
      const surface = engine as unknown as Record<string, unknown>;
      expect(surface.cloudDatabase).toBeUndefined();
      expect(surface.cloudFavorites).toBeUndefined();
    });

    it('settles on "local-only" instead of claiming "synced"', () => {
      const statuses: SyncStatus[] = [];
      const unsubscribe = engine.onStatusChange((status) => statuses.push(status));

      expect(statuses[0]).toBe('idle');

      engine.setOnlineStatus(false);
      expect(engine.syncStatus).toBe('offline');

      engine.setOnlineStatus(true);
      expect(engine.syncStatus).toBe('local-only');

      expect(statuses).toContain('offline');
      expect(statuses).toContain('local-only');
      expect(statuses).not.toContain('synced');

      unsubscribe();
    });

    it('never queues remote mutations while no remote is configured', async () => {
      const queued = await engine.queueMutation({ type: 'update_playlist', entityId: 'pl_x', data: samplePlaylist1 });

      expect(queued).toBeNull();
      expect(engine.pendingLocalMutations).toHaveLength(0);
      expect(await dbService.getSetting<SyncMutation[]>(PENDING_MUTATIONS_SETTING, [])).toEqual([]);
    });

    it('drops the pending upload queue when the journal owner changes', async () => {
      engine.setRemoteAdapter(createAcceptingRemote());
      engine.setUserId('discord_user_a');

      const queued = await engine.queueMutation({ type: 'update_playlist', entityId: 'pl_x', data: samplePlaylist1 });
      expect(queued).not.toBeNull();
      expect(engine.pendingLocalMutations).toHaveLength(1);

      // Same owner: nothing to reassign, the queue survives.
      engine.setUserId('discord_user_a');
      expect(engine.pendingLocalMutations).toHaveLength(1);

      // Different owner: those writes belong to the previous account.
      engine.setUserId('discord_user_b');
      expect(engine.getUserId()).toBe('discord_user_b');
      expect(engine.pendingLocalMutations).toHaveLength(0);
      await vi.waitFor(async () => {
        expect(await dbService.getSetting<SyncMutation[]>(PENDING_MUTATIONS_SETTING, [])).toEqual([]);
      });

      // Signing out is the same reassignment: the queue must not follow to a guest.
      await engine.queueMutation({ type: 'update_playlist', entityId: 'pl_y', data: samplePlaylist1 });
      expect(engine.pendingLocalMutations).toHaveLength(1);
      engine.setUserId(null);
      expect(engine.pendingLocalMutations).toHaveLength(0);
    });

    it('refuses to start periodic sync with nothing to sync to', () => {
      expect(engine.startPeriodicSync(5000)).toBe(false);

      const remote = createAcceptingRemote();
      engine.setRemoteAdapter(remote);
      expect(engine.startPeriodicSync(5000)).toBe(true);
      engine.stopPeriodicSync();
    });
  });

  // ==========================================================================
  // 2. Honest Reporting (nothing claims an upload that did not happen)
  // ==========================================================================
  describe('Honest Reporting', () => {
    it('commits locally, reports remoteAccepted=false and leaves isSynced false', async () => {
      const result = await engine.pushPlaylist(samplePlaylist1);

      expect(result.success).toBe(true);
      expect(result.remoteAccepted).toBe(false);
      expect(result.queuedForRemote).toBe(false);
      expect(result.resolved.isSynced).toBe(false);

      const localPl = await dbService.getPlaylistById(samplePlaylist1.id);
      expect(localPl?.title).toBe('Synthwave Odyssey');
      expect(localPl?.isSynced).toBe(false);
      expect(engine.syncStatus).toBe('local-only');
    });

    it('syncAll counts local records only and explains that nothing left the device', async () => {
      await engine.pushPlaylist(samplePlaylist1);
      await engine.pushFavorite(sampleTrackA);

      const logs: string[] = [];
      const collect = (...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(' '));
      };
      vi.spyOn(console, 'log').mockImplementation(collect);
      vi.spyOn(console, 'info').mockImplementation(collect);

      const result = await engine.syncAll();

      expect(result.success).toBe(true);
      expect(result.remoteConfigured).toBe(false);
      expect(result.syncedPlaylists).toBe(0);
      expect(result.syncedFavorites).toBe(0);
      expect(result.localPlaylists).toBe(1);
      expect(result.localFavorites).toBe(1);
      expect(result.message).toMatch(/только на этом устройстве/i);
      expect(engine.syncStatus).toBe('local-only');
      expect(logs.join('\n')).not.toMatch(/upload|sent to the cloud/i);
    });

    it('returns an offline error from syncAll without touching the database', async () => {
      engine.setOnlineStatus(false);

      const res = await engine.syncAll();

      expect(res.success).toBe(false);
      expect(res.error).toContain('Нет подключения');
      expect(res.syncedPlaylists).toBe(0);
      expect(engine.syncStatus).toBe('offline');
    });

    it('deletes locally and admits the remote never confirmed it', async () => {
      await engine.pushPlaylist(samplePlaylist1);
      await engine.pushFavorite(sampleTrackA);

      const delPlaylist = await engine.deletePlaylist(samplePlaylist1.id);
      expect(delPlaylist).toEqual({ success: true, remoteAccepted: false, queuedForRemote: false });
      expect(await dbService.getPlaylistById(samplePlaylist1.id)).toBeUndefined();

      const delFavorite = await engine.deleteFavorite(sampleTrackA.id);
      expect(delFavorite.success).toBe(true);
      expect(delFavorite.remoteAccepted).toBe(false);
      expect((await dbService.getFavorites()).some((t) => t.id === sampleTrackA.id)).toBe(false);
    });
  });

  // ==========================================================================
  // 3. Last-Write-Wins Conflict Resolution
  // ==========================================================================
  describe('Last-Write-Wins Conflict Resolution', () => {
    it('lets the newest updatedAt win and flags the stale write as a conflict', async () => {
      await engine.pushPlaylist({ ...samplePlaylist1, updatedAt: 1000 });

      const resA = await engine.pushPlaylist({ ...samplePlaylist1, title: 'Updated by Device A', updatedAt: 3000 });
      expect(resA.resolved.title).toBe('Updated by Device A');
      expect(resA.isConflict).toBe(false);

      const resB = await engine.pushPlaylist({ ...samplePlaylist1, title: 'Stale update from Device B', updatedAt: 2000 });
      expect(resB.resolved.title).toBe('Updated by Device A');
      expect(resB.isConflict).toBe(true);

      const stored = await dbService.getPlaylistById(samplePlaylist1.id);
      expect(stored?.title).toBe('Updated by Device A');
      expect(stored?.updatedAt).toBe(3000);
    });

    it('resolveConflict gives ties to its first argument', () => {
      const mine: Playlist = { ...samplePlaylist1, title: 'Mine', updatedAt: 5000 };
      const theirs: Playlist = { ...samplePlaylist1, title: 'Theirs', updatedAt: 5000 };

      expect(engine.resolveConflict(mine, theirs).title).toBe('Mine');
      expect(engine.resolveConflict(theirs, mine).title).toBe('Theirs');
      expect(engine.resolveConflict(mine, { ...theirs, updatedAt: 6000 }).title).toBe('Theirs');
    });

    it('a sync-merge write keeps the winner updatedAt so LWW stays comparable', async () => {
      // A merge replays a record; if the write bumped updatedAt to "now", every
      // later comparison would treat it as the newest edit.
      const mergedRecord: Playlist = { ...samplePlaylist1, title: 'From remote', updatedAt: 4242 };
      await dbService.savePlaylist(mergedRecord);

      const stored = await dbService.getPlaylistById(samplePlaylist1.id);
      expect(stored?.updatedAt).toBe(4242);

      const stale = await engine.pushPlaylist({ ...samplePlaylist1, title: 'Older edit', updatedAt: 4000 });
      expect(stale.isConflict).toBe(true);
      expect(stale.resolved.title).toBe('From remote');
    });
  });

  // ==========================================================================
  // 4. Configured Remote Adapter
  // ==========================================================================
  describe('Configured Remote Adapter', () => {
    it('marks records synced only after the remote accepts them', async () => {
      const remote = createAcceptingRemote();
      engine.setRemoteAdapter(remote);
      expect(engine.isRemoteConfigured()).toBe(true);

      const res = await engine.pushPlaylist(samplePlaylist1);
      expect(remote.pushPlaylists).toHaveBeenCalledTimes(1);
      expect(res.remoteAccepted).toBe(true);
      expect(res.resolved.isSynced).toBe(true);
      expect((await dbService.getPlaylistById(samplePlaylist1.id))?.isSynced).toBe(true);
      expect(engine.syncStatus).toBe('synced');

      const favRes = await engine.pushFavorite(sampleTrackA);
      expect(favRes.remoteAccepted).toBe(true);
      expect((await dbService.getFavorites()).some((t) => t.id === sampleTrackA.id)).toBe(true);
    });

    it('queues while offline and flushes on reconnect', async () => {
      const remote = createAcceptingRemote();
      engine.setRemoteAdapter(remote);
      engine.setOnlineStatus(false);

      const offlinePl: Playlist = {
        id: 'pl_offline_1',
        title: 'Offline Jam',
        tracks: [sampleTrackB],
        createdAt: 2000,
        updatedAt: 2000,
        isSynced: false
      };

      const pushRes = await engine.pushPlaylist(offlinePl);
      expect(pushRes.success).toBe(true); // The local commit succeeded...
      expect(pushRes.remoteAccepted).toBe(false); // ...the remote write did not.
      expect(pushRes.queuedForRemote).toBe(true);
      expect(engine.pendingLocalMutations).toHaveLength(1);

      await engine.pushFavorite(sampleTrackB);
      expect(engine.pendingLocalMutations).toHaveLength(2);
      expect(await dbService.getSetting<SyncMutation[]>(PENDING_MUTATIONS_SETTING, [])).toHaveLength(2);

      engine.setOnlineStatus(true);
      const processed = await engine.syncPending();

      expect(processed).toBe(2);
      expect(engine.pendingLocalMutations).toHaveLength(0);
      expect(remote.pushPlaylists).toHaveBeenCalledTimes(1);
      expect(remote.pushFavorites).toHaveBeenCalledTimes(1);
      expect(engine.syncStatus).toBe('synced');
    });

    it('restores the queue from IndexedDB after a restart', async () => {
      const remote = createFailingRemote();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      engine.setRemoteAdapter(remote);
      await engine.pushPlaylist(samplePlaylist1);
      expect(engine.pendingLocalMutations).toHaveLength(1);

      const restarted = new LocalFirstSyncEngine(undefined, remote);
      for (let i = 0; i < 20; i++) {
        if (restarted.pendingLocalMutations.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(restarted.pendingLocalMutations).toHaveLength(1);
      expect(restarted.pendingLocalMutations[0].type).toBe('update_playlist');
      restarted.stopPeriodicSync();
    });

    it('merges pulled playlists and favorites into the local database', async () => {
      const remote = createAcceptingRemote();
      const remotePlaylist: Playlist = {
        id: 'pl_remote_only',
        title: 'Remote Cloud Mix',
        tracks: [sampleTrackB],
        createdAt: 1100,
        updatedAt: 1100,
        isSynced: true
      };
      remote.pullPlaylists.mockResolvedValue([remotePlaylist]);
      remote.pullFavorites.mockResolvedValue([sampleTrackB]);
      engine.setRemoteAdapter(remote);

      await dbService.savePlaylist({ ...samplePlaylist1, id: 'pl_local_only', title: 'Local Only' });

      const result = await engine.syncAll();

      expect(result.success).toBe(true);
      expect(result.remoteConfigured).toBe(true);
      expect(result.syncedPlaylists).toBe(2);
      expect(result.syncedFavorites).toBe(1);

      const localPlaylists = await dbService.getPlaylists();
      expect(localPlaylists.map((p) => p.id).sort()).toEqual(['pl_local_only', 'pl_remote_only']);
      expect((await dbService.getFavorites()).some((f) => f.id === sampleTrackB.id)).toBe(true);
    });
  });

  // ==========================================================================
  // 5. Retry Limit & Exponential Backoff
  // ==========================================================================
  describe('Retry Limit & Exponential Backoff', () => {
    it('backs off exponentially and parks the mutation after maxRetries', async () => {
      const remote = createFailingRemote('boom');
      const retryEngine = new LocalFirstSyncEngine(
        { maxRetries: 3, retryBaseDelayMs: 1000, retryMaxDelayMs: 8000 },
        remote
      );
      retryEngine.setOnlineStatus(true);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const pushRes = await retryEngine.pushPlaylist(samplePlaylist1);
      expect(pushRes.remoteAccepted).toBe(false);
      expect(pushRes.queuedForRemote).toBe(true);
      // The failed push is still committed locally.
      expect(await dbService.getPlaylistById(samplePlaylist1.id)).toBeDefined();

      vi.useFakeTimers({ toFake: ['Date'] });
      const t0 = Date.now();

      // Attempt 1 fails: retryCount 1, next attempt one base delay later.
      expect(await retryEngine.syncPending()).toBe(0);
      expect(retryEngine.pendingLocalMutations).toHaveLength(1);
      expect(retryEngine.pendingLocalMutations[0].retryCount).toBe(1);
      expect(retryEngine.pendingLocalMutations[0].nextAttemptAt).toBe(t0 + 1000);
      expect(remote.pushPlaylists).toHaveBeenCalledTimes(2); // initial push + retry

      // Nothing is retried before the backoff deadline.
      await retryEngine.syncPending();
      expect(remote.pushPlaylists).toHaveBeenCalledTimes(2);
      expect(retryEngine.pendingLocalMutations[0].retryCount).toBe(1);

      // Attempt 2 fails: the delay doubles.
      vi.setSystemTime(t0 + 1000);
      await retryEngine.syncPending();
      expect(remote.pushPlaylists).toHaveBeenCalledTimes(3);
      expect(retryEngine.pendingLocalMutations[0].retryCount).toBe(2);
      expect(retryEngine.pendingLocalMutations[0].nextAttemptAt).toBe(t0 + 1000 + 2000);

      // Attempt 3 hits maxRetries: parked instead of retried forever.
      vi.setSystemTime(t0 + 4000);
      await retryEngine.syncPending();
      expect(remote.pushPlaylists).toHaveBeenCalledTimes(4);
      expect(retryEngine.pendingLocalMutations).toHaveLength(0);
      expect(retryEngine.parkedMutations).toHaveLength(1);
      expect(retryEngine.parkedMutations[0].retryCount).toBe(3);
      expect(retryEngine.parkedMutations[0].lastError).toContain('boom');
      expect(warn.mock.calls.some((call) => String(call[0]).includes('Parking mutation'))).toBe(true);

      // A parked mutation stays parked, not silently retried.
      vi.setSystemTime(t0 + 1000000);
      expect(await retryEngine.syncPending()).toBe(0);
      expect(remote.pushPlaylists).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
      expect(await dbService.getSetting<SyncMutation[]>(PARKED_MUTATIONS_SETTING, [])).toHaveLength(1);

      await retryEngine.clearParkedMutations();
      expect(retryEngine.parkedMutations).toHaveLength(0);
      expect(await dbService.getSetting<SyncMutation[]>(PARKED_MUTATIONS_SETTING, [])).toEqual([]);
      retryEngine.stopPeriodicSync();
    });

    it('caps the backoff at retryMaxDelayMs', async () => {
      const remote = createFailingRemote();
      const cappedEngine = new LocalFirstSyncEngine(
        { maxRetries: 10, retryBaseDelayMs: 1000, retryMaxDelayMs: 3000 },
        remote
      );
      cappedEngine.setOnlineStatus(true);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await cappedEngine.pushPlaylist(samplePlaylist1);

      vi.useFakeTimers({ toFake: ['Date'] });
      let now = Date.now();
      const delays: number[] = [];

      for (let i = 0; i < 5; i++) {
        await cappedEngine.syncPending();
        const pending = cappedEngine.pendingLocalMutations[0];
        delays.push((pending.nextAttemptAt || 0) - now);
        now = pending.nextAttemptAt || now;
        vi.setSystemTime(now);
      }

      expect(delays).toEqual([1000, 2000, 3000, 3000, 3000]);
      vi.useRealTimers();
      cappedEngine.stopPeriodicSync();
    });

    it('does not retry while offline or without a remote', async () => {
      const remote = createAcceptingRemote();
      engine.setRemoteAdapter(remote);
      engine.setOnlineStatus(false);
      await engine.pushPlaylist(samplePlaylist1);
      expect(engine.pendingLocalMutations).toHaveLength(1);

      expect(await engine.syncPending()).toBe(0);
      expect(remote.pushPlaylists).not.toHaveBeenCalled();

      engine.setOnlineStatus(true);
      engine.setRemoteAdapter(new NullRemoteAdapter());
      expect(await engine.syncPending()).toBe(0);
    });
  });

  // ==========================================================================
  // 6. Null Adapter Contract
  // ==========================================================================
  describe('Null Adapter Contract', () => {
    it('accepts nothing and returns nothing', async () => {
      const adapter: RemoteSyncAdapter = new NullRemoteAdapter();

      expect(adapter.id).toBe('null');
      expect(adapter.isConfigured()).toBe(false);
      expect(await adapter.pushPlaylists([samplePlaylist1])).toBe(0);
      expect(await adapter.pushFavorites([sampleTrackA])).toBe(0);
      expect(await adapter.pullPlaylists()).toEqual([]);
      expect(await adapter.pullFavorites()).toEqual([]);
      expect(await adapter.deletePlaylist('pl_sync_1')).toBe(false);
      expect(await adapter.deleteFavorite('yt_track_a')).toBe(false);
    });
  });
  describe('Удаления, приехавшие с других устройств', () => {
    /**
     * Самая заметная беда синхронизации: удалил плейлист на телефоне, а он
     * вернулся. Причина в порядке действий движка — он сливает пришедшее в
     * местное и отправляет местное целиком, — поэтому запись, которую второе
     * устройство ещё не забыло, приезжает обратно. Причину забыть даёт
     * `pullDeletions`.
     */
    function remoteWithDeletions(deletions: { playlists: string[]; favorites: string[] }) {
      return {
        ...createAcceptingRemote(),
        pullDeletions: vi.fn(async () => deletions)
      };
    }

    it('стирает локально то, что удалили на другом устройстве', async () => {
      await dbService.savePlaylist(samplePlaylist1);
      await dbService.addFavorite(sampleTrackA);

      engine.setRemoteAdapter(
        remoteWithDeletions({ playlists: [samplePlaylist1.id], favorites: [sampleTrackA.id] })
      );
      await engine.syncAll();

      expect(await dbService.getPlaylistById(samplePlaylist1.id)).toBeUndefined();
      expect(await dbService.isFavorite(sampleTrackA.id)).toBe(false);
    });

    it('не отправляет обратно то, что только что стёрло', async () => {
      // Иначе удаление отменяется нашей же отправкой в том же заходе.
      await dbService.savePlaylist(samplePlaylist1);
      const remote = remoteWithDeletions({ playlists: [samplePlaylist1.id], favorites: [] });
      engine.setRemoteAdapter(remote);

      await engine.syncAll();

      const pushed = remote.pushPlaylists.mock.calls.flatMap((call) => call[0] as Playlist[]);
      expect(pushed.some((playlist) => playlist.id === samplePlaylist1.id)).toBe(false);
    });

    it('адаптер без памяти об удалениях работает как раньше', async () => {
      // `pullDeletions` необязателен: заглушке и старым адаптерам сказать нечего.
      await dbService.savePlaylist(samplePlaylist1);
      engine.setRemoteAdapter(createAcceptingRemote());

      const result = await engine.syncAll();

      expect(result.success).toBe(true);
      expect(await dbService.getPlaylistById(samplePlaylist1.id)).toBeDefined();
    });

    it('отказ чтения удалений не роняет весь заход', async () => {
      // Не узнать про чужое удаление — это рассинхрон до следующего раза.
      // Уронить из-за него синхронизацию — это потерять правки, готовые уехать.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await dbService.savePlaylist(samplePlaylist1);
      engine.setRemoteAdapter({
        ...createAcceptingRemote(),
        pullDeletions: vi.fn(async () => {
          throw new Error('сеть пропала');
        })
      });

      const result = await engine.syncAll();
      expect(result.success).toBe(true);
      expect(await dbService.getPlaylistById(samplePlaylist1.id)).toBeDefined();
    });

    it('пустой список удалений не заставляет перечитывать базу', async () => {
      await dbService.savePlaylist(samplePlaylist1);
      const spy = vi.spyOn(dbService, 'getPlaylists');
      engine.setRemoteAdapter(remoteWithDeletions({ playlists: [], favorites: [] }));

      await engine.syncAll();

      // Один раз до слияния — и всё. Второе чтение нужно только если что-то стёрли.
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
