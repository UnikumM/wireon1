/**
 * Tier 3 — Combinations.
 *
 * Every feature here already works on its own (Tier 1 proves that). What breaks
 * in real use is the overlap: shuffle *and* a user queue *and* repeat-all; a
 * playlist edited *while* it is playing; settings restored *into* a live queue;
 * an offline write that has to survive a restart *and* a reconnect.
 *
 * Real stores, real aggregator, real Dexie, real sync engine. Only `fetch` is
 * replaced, and the sync remote — the one collaborator this app genuinely does
 * not ship — is supplied by `testUtils`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { searchAggregator } from '../../src/services/aggregator';
import { streamResolver } from '../../src/services/streamResolver';
import {
  LocalFirstSyncEngine,
  NullRemoteAdapter,
  cloudSyncEngine,
  PENDING_MUTATIONS_SETTING,
  PARKED_MUTATIONS_SETTING
} from '../../src/services/cloudSync';
import { exportLibrary, importLibrary } from '../../src/services/backup';
import * as dbService from '../../src/services/db';
import { Playlist, UnifiedTrack } from '../../src/types/music';
import { RemoteSyncAdapter, SyncStatus } from '../../src/types/auth';

import {
  installFetchMock,
  jsonResponse,
  resetPlayerStore,
  resetLibraryStore,
  resetAuthStore,
  resetUIStore,
  createAcceptingRemote,
  createFailingRemote,
  SpyRemoteAdapter,
  flushAsync,
  waitFor,
  signInForTests
} from '../helpers/testUtils';
import { healthySourceRoutes, soundcloudSearchPayload } from '../helpers/networkFixtures';

const player = () => usePlayerStore.getState();
const library = () => useLibraryStore.getState();

/**
 * Every engine built here registers `online`/`offline` window listeners it never
 * removes, so a later reconnect would make an earlier test's engine flush its
 * queue over the shared journal. Tracking them lets `afterEach` disarm them.
 */
const engines: LocalFirstSyncEngine[] = [];

function makeEngine(
  remote: RemoteSyncAdapter,
  config: Partial<ConstructorParameters<typeof LocalFirstSyncEngine>[0]> = {}
): LocalFirstSyncEngine {
  const engine = new LocalFirstSyncEngine({ enableAutoSync: false, ...config }, remote);
  engines.push(engine);
  return engine;
}

async function searchTracks(query: string = 'Queen'): Promise<UnifiedTrack[]> {
  const { results } = await searchAggregator.search(query, { source: 'all', limit: 10 });
  return results;
}

/** Playable local tracks: no resolver round trip, so queue logic stays the subject. */
function localTracks(count: number, prefix: string): UnifiedTrack[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i}`,
    source: 'youtube' as const,
    originalId: `${prefix}${i}`,
    title: `${prefix} ${i}`,
    artist: 'Combination Test',
    duration: 180,
    artworkUrl: '',
    streamUrl: `https://example.com/${prefix}-${i}.mp3`
  }));
}

describe('Tier 3 — Combinations', () => {
  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    installFetchMock(healthySourceRoutes());

    resetPlayerStore();
    resetLibraryStore();
    resetAuthStore();
    signInForTests();
    resetUIStore();

    searchAggregator.clearCache();
    streamResolver.clearCache();
    cloudSyncEngine.setRemoteAdapter(new NullRemoteAdapter());
    cloudSyncEngine.pendingLocalMutations = [];
    cloudSyncEngine.parkedMutations = [];

    await dbService.clearAllData();
  });

  afterEach(async () => {
    player().setSleepTimer(null);
    // Disarm this test's engines before the next one dispatches a network event.
    engines.forEach((engine) => {
      engine.stopPeriodicSync();
      engine.pendingLocalMutations = [];
      engine.parkedMutations = [];
      engine.setRemoteAdapter(new NullRemoteAdapter());
    });
    engines.length = 0;

    await flushAsync();
    vi.unstubAllGlobals();
    if (!dbService.db.isOpen()) await dbService.db.open();
    await dbService.clearAllData();
  });

  // -------------------------------------------------------------------------
  // Queue: shuffle × user queue × repeat
  // -------------------------------------------------------------------------

  it('drains the user queue first, then follows the shuffled order, then reshuffles under repeat-all', async () => {
    const tracks = localTracks(5, 'shuf');
    const interruption = localTracks(1, 'jump')[0];

    await player().playTrack(tracks[0], tracks, 0);
    player().toggleShuffle();
    player().setRepeatMode('all');

    const firstOrder = [...player().shuffleOrder];
    expect(firstOrder[0]).toBe(0); // the playing track leads its own shuffle

    // A user pick outranks the shuffle without consuming a shuffle position.
    player().addToUserQueue(interruption);
    await player().nextTrack(true);
    expect(player().currentTrack?.id).toBe(interruption.id);
    expect(player().currentIndex).toBe(0);
    expect(player().shuffleOrder).toEqual(firstOrder);

    // Back to the shuffle, resuming from where the shuffle actually was.
    const visited: number[] = [player().currentIndex];
    for (let i = 1; i < firstOrder.length; i++) {
      await player().nextTrack(false);
      visited.push(player().currentIndex);
    }
    expect(visited).toEqual(firstOrder);

    // The order is exhausted; repeat-all must produce a *new* order rather than
    // replaying the old one, and must not hand back the track just played.
    await player().nextTrack(false);
    expect(player().isPlaying).toBe(true);
    expect(player().currentIndex).not.toBe(firstOrder[firstOrder.length - 1]);
    const secondOrder = player().shuffleOrder;
    expect([...secondOrder].sort((a, b) => a - b)).toEqual(tracks.map((_, i) => i));
  });

  it('returns to linear order at the current track when shuffle is switched off mid-queue', async () => {
    const tracks = localTracks(4, 'linear');
    await player().playTrack(tracks[0], tracks, 0);

    player().toggleShuffle();
    await player().nextTrack(false);
    const landedOn = player().currentIndex;
    const landedTrack = player().currentTrack?.id;

    player().toggleShuffle();
    expect(player().isShuffled).toBe(false);
    expect(player().shuffleOrder).toEqual([]);
    // Switching shuffle off keeps the music playing where it is …
    expect(player().currentTrack?.id).toBe(landedTrack);
    expect(player().currentIndex).toBe(landedOn);

    // … and the next track is simply the one after it in the album order.
    if (landedOn + 1 < tracks.length) {
      await player().nextTrack(false);
      expect(player().currentIndex).toBe(landedOn + 1);
      expect(player().currentTrack?.id).toBe(tracks[landedOn + 1].id);
    }
  });

  // -------------------------------------------------------------------------
  // Queue end × autoplay radio
  // -------------------------------------------------------------------------

  it('extends an exhausted queue with radio and keeps the finished track in history', async () => {
    // Twelve radio-friendly candidates: enough that the aggregator does not need
    // its artist-search fallback, so this test really covers the related endpoint.
    const related = Array.from({ length: 12 }, (_, i) => ({
      id: 700 + i,
      title: `Radio Pick ${i}`,
      username: 'Nightrunner',
      durationMs: 200_000
    }));
    installFetchMock(
      healthySourceRoutes({
        extra: [
          {
            match: /api-v2\.soundcloud\.com\/tracks\/[^/]+\/related/,
            respond: () => jsonResponse(soundcloudSearchPayload(related))
          }
        ]
      })
    );

    const results = await searchTracks();
    const seed = results.find((t) => t.source === 'soundcloud')!;

    player().setAutoplayRadio(true);
    await player().playTrack(seed, [seed], 0);
    await player().nextTrack(false); // natural end of a one-track queue

    expect(player().sourceQueue.length).toBeGreaterThan(1);
    expect(player().currentIndex).toBe(1);
    expect(player().currentTrack?.id).not.toBe(seed.id);
    expect(player().currentTrack?.id).toMatch(/^sc_7\d\d$/);
    expect(player().isPlaying).toBe(true);
    // The seed is behind us now, so `prevTrack` can still get back to it.
    expect(player().history.map((t) => t.id)).toContain(seed.id);
  });

  it('stops cleanly at the end of the queue when radio has nothing to add', async () => {
    // Related is empty and the artist fallback finds only what is already queued.
    installFetchMock(
      healthySourceRoutes({
        extra: [
          {
            match: /api-v2\.soundcloud\.com\/tracks\/[^/]+\/related/,
            respond: () => jsonResponse({ collection: [] })
          }
        ]
      })
    );

    const results = await searchTracks();
    const scTracks = results.filter((t) => t.source === 'soundcloud');

    player().setAutoplayRadio(true);
    await player().playTrack(scTracks[0], scTracks, 0);
    await player().nextTrack(false);
    const queueLength = player().sourceQueue.length;
    await player().nextTrack(false);

    // No radio, no crash, no error banner: playback just pauses where it ended.
    expect(player().sourceQueue).toHaveLength(queueLength);
    expect(player().isPlaying).toBe(false);
    expect(player().playbackState).toBe('paused');
    expect(player().error).toBeNull();
    expect(player().currentTrack).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Settings × live playback state
  // -------------------------------------------------------------------------

  it('restores every preference once and reshuffles the live queue it lands in', async () => {
    player().setVolume(0.27);
    player().setRepeatMode('all');
    player().setEq({ bass: 5, mid: -2, treble: 4 });
    player().setAutoplayRadio(true);
    player().toggleShuffle(); // persists isShuffled with an empty queue
    await flushAsync();

    // Fresh boot, but this time something is already playing when the settings
    // arrive — hydration must adopt them without disturbing the queue.
    resetPlayerStore();
    const tracks = localTracks(6, 'hydr');
    await player().playTrack(tracks[3], tracks, 3);

    await Promise.all([player().hydrateSettings(), player().hydrateSettings()]);

    expect(player().settingsHydrated).toBe(true);
    expect(player().volume).toBeCloseTo(0.27, 5);
    expect(player().repeatMode).toBe('all');
    expect(player().eq).toEqual({ bass: 5, mid: -2, treble: 4 });
    expect(player().autoplayRadio).toBe(true);
    expect(player().isShuffled).toBe(true);

    // The queue is untouched and the restored shuffle covers it exactly once,
    // starting from the track that is actually playing.
    expect(player().sourceQueue.map((t) => t.id)).toEqual(tracks.map((t) => t.id));
    expect(player().currentTrack?.id).toBe(tracks[3].id);
    expect(player().shuffleOrder[0]).toBe(3);
    expect([...player().shuffleOrder].sort((a, b) => a - b)).toEqual(tracks.map((_, i) => i));

    // A second hydration is a no-op, so a later launch cannot re-apply stale values.
    player().setVolume(0.9);
    await player().hydrateSettings();
    expect(player().volume).toBeCloseTo(0.9, 5);
  });

  it('keeps the sleep timer armed across track changes', async () => {
    const tracks = localTracks(3, 'sleep');
    await player().playTrack(tracks[0], tracks, 0);

    player().setSleepTimer(45);
    const endsAt = player().sleepTimerEndsAt;
    expect(endsAt).not.toBeNull();

    await player().nextTrack(false);
    await player().nextTrack(false);

    // The timer is wall-clock, not per-track: skipping must not silently cancel it.
    expect(player().currentTrack?.id).toBe(tracks[2].id);
    expect(player().sleepTimerEndsAt).toBe(endsAt);
  });

  // -------------------------------------------------------------------------
  // Library edits × the live queue
  // -------------------------------------------------------------------------

  it('keeps playing when the playing track is removed from the playlist it came from', async () => {
    const tracks = localTracks(4, 'pledit');
    const playlist = await library().createPlaylist('Editable');
    for (const track of tracks) {
      await library().addTrackToPlaylist(playlist!.id, track);
    }

    const stored = library().playlists[0];
    await player().playTrack(stored.tracks[1], stored.tracks, 1);
    const playingId = player().currentTrack?.id;

    // The user removes the track that is currently playing.
    expect(await library().removeTrackFromPlaylist(playlist!.id, 1)).toBe(true);
    player().syncSourceQueue(library().playlists[0].tracks);

    // Playback survives: the audio keeps going, the queue is the new list, and
    // the index still addresses a real element.
    expect(player().currentTrack?.id).toBe(playingId);
    expect(player().sourceQueue).toHaveLength(3);
    expect(player().currentIndex).toBeGreaterThanOrEqual(0);
    expect(player().currentIndex).toBeLessThan(3);

    // And "next" still moves forward inside the edited queue.
    await player().nextTrack(false);
    expect(player().sourceQueue.map((t) => t.id)).toContain(player().currentTrack?.id);
  });

  it('survives the playlist being deleted underneath the player', async () => {
    const tracks = localTracks(3, 'pldel');
    const playlist = await library().createPlaylist('Doomed');
    for (const track of tracks) {
      await library().addTrackToPlaylist(playlist!.id, track);
    }

    await player().playTrack(tracks[0], library().playlists[0].tracks, 0);
    expect(await library().deletePlaylist(playlist!.id)).toBe(true);
    player().syncSourceQueue([]);

    // Nothing to advance to, but the current track is still loaded and the app
    // does not enter an error state over it.
    expect(player().sourceQueue).toEqual([]);
    expect(player().currentIndex).toBe(-1);
    expect(player().currentTrack?.id).toBe(tracks[0].id);

    await player().nextTrack(false);
    expect(player().playbackState).toBe('paused');
    expect(player().error).toBeNull();
    expect(await dbService.getPlaylists()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Backup × an already-populated library × settings
  // -------------------------------------------------------------------------

  it('merges a backup into a populated library without clobbering newer local edits', async () => {
    const results = await searchTracks();
    await library().toggleFavorite(results[0]);
    const created = await library().createPlaylist('Shared Playlist');
    await library().addTrackToPlaylist(created!.id, results[1]);
    await library().addToHistory(results[2]);
    player().setVolume(0.25);
    await flushAsync();

    const backup = await exportLibrary();
    const json = JSON.stringify(backup);
    const exportedPlaylist = backup.playlists[0];

    // A backup is a library, not a device: another machine's sync journal must
    // never travel inside one.
    expect(Object.keys(backup.settings)).not.toContain(PENDING_MUTATIONS_SETTING);
    expect(Object.keys(backup.settings)).not.toContain(PARKED_MUTATIONS_SETTING);
    expect(backup.settings.volume).toBeCloseTo(0.25, 5);

    // Rebuild a *different* library: one unrelated favourite, plus a newer local
    // edit of the same playlist the backup carries.
    await dbService.clearAllData();
    resetLibraryStore();
    await library().toggleFavorite(results[3]);
    const locallyEdited: Playlist = {
      ...exportedPlaylist,
      title: 'Renamed Locally',
      updatedAt: exportedPlaylist.updatedAt + 5000
    };
    await dbService.savePlaylist(locallyEdited);

    const mergeSummary = await importLibrary(json, 'merge');

    expect(mergeSummary.favorites).toBe(1); // the backup's favourite, added
    expect(mergeSummary.playlists).toBe(0); // the local copy is newer, so it wins
    await library().loadInitialData();
    expect(library().favorites.map((t) => t.id).sort()).toEqual([results[0].id, results[3].id].sort());
    expect(library().playlists[0].title).toBe('Renamed Locally');

    // Replace is the destructive twin: afterwards only the backup exists.
    const replaceSummary = await importLibrary(json, 'replace');
    expect(replaceSummary.favorites).toBe(1);
    expect(replaceSummary.playlists).toBe(1);
    await library().loadInitialData();
    expect(library().favorites.map((t) => t.id)).toEqual([results[0].id]);
    expect(library().playlists[0].title).toBe('Shared Playlist');
  });

  // -------------------------------------------------------------------------
  // Offline writes × journal × reconnect
  // -------------------------------------------------------------------------

  it('commits locally while offline, journals the push, and flushes it on reconnect', async () => {
    const remote = createAcceptingRemote();
    const engine = makeEngine(remote);
    const statuses: SyncStatus[] = [];
    engine.onStatusChange((status) => statuses.push(status));

    engine.setOnlineStatus(false);
    const [track] = localTracks(1, 'offline');

    const commit = await engine.pushFavorite(track);

    // The local write always succeeds; the remote is simply not attempted.
    expect(commit.success).toBe(true);
    expect(commit.remoteAccepted).toBe(false);
    expect(commit.queuedForRemote).toBe(true);
    expect(remote.pushFavorites).not.toHaveBeenCalled();
    expect(await dbService.getFavorites()).toHaveLength(1);
    expect(engine.pendingLocalMutations).toHaveLength(1);
    expect(statuses).toContain('offline');

    // Offline flushes are refused rather than burning retries.
    expect(await engine.syncPending()).toBe(0);
    expect(remote.pushFavorites).not.toHaveBeenCalled();

    // The real reconnect path: the window event, not a hand-called method.
    window.dispatchEvent(new Event('online'));
    await waitFor(() => engine.pendingLocalMutations.length === 0 && engine.syncStatus === 'synced');

    expect(remote.pushFavorites).toHaveBeenCalledTimes(1);
    expect(remote.pushFavorites.mock.calls[0][0][0].id).toBe(track.id);
    expect(engine.syncStatus).toBe('synced');
    // The journal in the database was emptied too, not just the in-memory copy.
    expect(await dbService.getSetting(PENDING_MUTATIONS_SETTING, [])).toEqual([]);
  });

  // Each of the next two tests builds a single engine on purpose. The journal is
  // device-wide, so a second engine in the same test would load the first one's
  // queue out of Dexie and both would then flush the same mutations.

  it('defers a failed push until its backoff has elapsed', async () => {
    const [track] = localTracks(1, 'retry');
    const remote = createFailingRemote('502 from remote');
    const engine = makeEngine(remote, { maxRetries: 5, retryBaseDelayMs: 60_000 });

    await engine.pushFavorite(track);
    expect(remote.pushFavorites).toHaveBeenCalledTimes(1);
    expect(engine.pendingLocalMutations).toHaveLength(1);

    expect(await engine.syncPending()).toBe(0);
    expect(remote.pushFavorites).toHaveBeenCalledTimes(2);
    expect(engine.pendingLocalMutations[0].retryCount).toBe(1);
    expect(engine.pendingLocalMutations[0].lastError).toContain('502 from remote');

    // A minute of backoff is a minute: the next flush leaves the remote alone.
    expect(await engine.syncPending()).toBe(0);
    expect(remote.pushFavorites).toHaveBeenCalledTimes(2);
    expect(engine.pendingLocalMutations).toHaveLength(1);
    expect(engine.parkedMutations).toHaveLength(0);
  });

  it('parks a push once its retry budget is spent, without losing the local write', async () => {
    const [track] = localTracks(1, 'park');
    const remote = createFailingRemote('remote is gone');
    const engine = makeEngine(remote, { maxRetries: 2, retryBaseDelayMs: 0 });

    await engine.pushFavorite(track);
    await engine.syncPending(); // retry 1 of 2
    await engine.syncPending(); // budget spent

    expect(engine.pendingLocalMutations).toHaveLength(0);
    expect(engine.parkedMutations).toHaveLength(1);
    expect(engine.parkedMutations[0].retryCount).toBeGreaterThanOrEqual(2);
    expect(engine.parkedMutations[0].type).toBe('add_favorite');
    expect(engine.syncStatus).toBe('error');
    // Parking loses nothing: the favourite is in the local database either way.
    expect((await dbService.getFavorites()).map((t) => t.id)).toContain(track.id);

    await engine.clearParkedMutations();
    expect(engine.parkedMutations).toEqual([]);
    expect(await dbService.getSetting(PARKED_MUTATIONS_SETTING, [])).toEqual([]);
    expect((await dbService.getFavorites()).map((t) => t.id)).toContain(track.id);
  });

  it('recovers a journal written by a previous run of the app', async () => {
    const [track] = localTracks(1, 'restart');

    const first = makeEngine(createAcceptingRemote());
    first.setOnlineStatus(false);
    await first.pushFavorite(track);
    const journalled = first.pendingLocalMutations[0];
    expect(journalled).toBeDefined();

    // The app is closed and reopened: a brand-new engine, same database.
    const remote = createAcceptingRemote();
    const second = makeEngine(remote);
    await waitFor(() => second.pendingLocalMutations.length > 0);

    expect(second.pendingLocalMutations.map((m) => m.id)).toContain(journalled.id);
    expect(second.pendingLocalMutations[0].type).toBe('add_favorite');

    expect(await second.syncPending()).toBe(1);
    expect(remote.pushFavorites).toHaveBeenCalledTimes(1);
    expect(second.pendingLocalMutations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Library × a configured remote
  // -------------------------------------------------------------------------

  it('pushes a real library to a configured remote and records what was accepted', async () => {
    const results = await searchTracks();
    await library().toggleFavorite(results[0]);
    const playlist = await library().createPlaylist('Syncable');
    await library().addTrackToPlaylist(playlist!.id, results[1]);

    const remote: SpyRemoteAdapter = createAcceptingRemote();
    const engine = makeEngine(remote);
    useAuthStore.setState({ isAuthenticated: true, isGuest: false });

    const outcome = await engine.syncAll();

    expect(outcome.success).toBe(true);
    expect(outcome.remoteConfigured).toBe(true);
    expect(outcome.syncedPlaylists).toBe(1);
    expect(outcome.syncedFavorites).toBe(1);
    expect(engine.syncStatus).toBe('synced');

    // The remote received the playlist with its tracks, not a stub.
    const pushed = remote.pushPlaylists.mock.calls[0][0][0] as Playlist;
    expect(pushed.title).toBe('Syncable');
    expect(pushed.tracks.map((t) => t.id)).toEqual([results[1].id]);

    // And the acceptance is written back, so the UI can stop showing "pending".
    const storedPlaylists = await dbService.getPlaylists();
    expect(storedPlaylists[0].isSynced).toBe(true);
  });

  it('refuses to let a stale edit clobber a newer stored playlist', async () => {
    const results = await searchTracks();
    const created = await library().createPlaylist('Conflict');
    await library().addTrackToPlaylist(created!.id, results[0]);

    const stored = (await dbService.getPlaylists())[0];
    const newer: Playlist = { ...stored, title: 'Newer On This Device', updatedAt: stored.updatedAt + 10_000 };
    await dbService.savePlaylist(newer);

    const remote = createAcceptingRemote();
    const engine = makeEngine(remote);

    // A second device pushes an edit made *before* the local one.
    const stale: Playlist = { ...stored, title: 'Older From Elsewhere', updatedAt: stored.updatedAt - 10_000 };
    const commit = await engine.pushPlaylist(stale);

    expect(commit.success).toBe(true);
    expect(commit.isConflict).toBe(true);
    // Last write wins by timestamp, not by arrival order.
    expect(commit.resolved.title).toBe('Newer On This Device');
    expect((await dbService.getPlaylistById(stored.id))?.title).toBe('Newer On This Device');
    expect((remote.pushPlaylists.mock.calls[0][0][0] as Playlist).title).toBe('Newer On This Device');
  });
});
