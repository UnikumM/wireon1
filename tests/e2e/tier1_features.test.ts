/**
 * Tier 1 — Feature integration.
 *
 * One test per shipped capability, exercised through the real modules: the real
 * Zustand stores, the real aggregator, the real YouTube/SoundCloud parsers, the
 * real stream resolver, the real audio engine and real Dexie persistence. Only
 * `fetch` is replaced (with wire-shaped fixtures) and only `hls.js` is stubbed,
 * because jsdom has no Media Source Extensions.
 *
 * If a test here passes while the app is broken, the test is wrong.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { searchAggregator } from '../../src/services/aggregator';
import { streamResolver } from '../../src/services/streamResolver';
import { audioEngine } from '../../src/services/audioEngine';
import { cloudSyncEngine, NullRemoteAdapter } from '../../src/services/cloudSync';
import { exportLibrary, importLibrary, BACKUP_VERSION } from '../../src/services/backup';
import * as dbService from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

import {
  installFetchMock,
  flushPromises,
  resetPlayerStore,
  resetLibraryStore,
  resetAuthStore,
  resetUIStore,
  waitFor,
  flushAsync,
  signInForTests
} from '../helpers/testUtils';
import { healthySourceRoutes } from '../helpers/networkFixtures';

const player = () => usePlayerStore.getState();
const library = () => useLibraryStore.getState();

/** Runs a real unified search and returns the parsed tracks. */
async function searchForTracks(query: string = 'Queen'): Promise<UnifiedTrack[]> {
  const { results } = await searchAggregator.search(query, { source: 'all', limit: 10 });
  return results;
}

describe('Tier 1 — Features', () => {
  beforeEach(async () => {
    // `commitTrack` writes history fire-and-forget, so a previous test's write can
    // still be in flight. Drain it before the reset or it lands in this test.
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
    await flushAsync(); // let in-flight persistence settle while fetch is still stubbed
    vi.unstubAllGlobals();
    if (!dbService.db.isOpen()) await dbService.db.open();
    await dbService.clearAllData();
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  it('aggregates both sources from real wire payloads and interleaves them', async () => {
    const results = await searchForTracks();

    // Two YouTube songs + two SoundCloud tracks, interleaved yt/sc/yt/sc.
    expect(results.map((t) => t.source)).toEqual(['youtube', 'soundcloud', 'youtube', 'soundcloud']);

    // Parsed, not passed through: the "(Official Video)" suffix is stripped and
    // the artist is lifted out of the metadata runs.
    expect(results[0]).toMatchObject({
      id: 'yt_yt00000001',
      source: 'youtube',
      originalId: 'yt00000001',
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      duration: 355
    });

    // SoundCloud reports milliseconds; the parser converts and upgrades artwork.
    expect(results[1]).toMatchObject({
      id: 'sc_501',
      source: 'soundcloud',
      title: 'Midnight Drive',
      artist: 'Nightrunner',
      duration: 214
    });
    expect(results[1].artworkUrl).toContain('t500x500');
  });

  it('serves an identical repeat query from cache instead of the network', async () => {
    const { calls } = installFetchMock(healthySourceRoutes());

    await searchAggregator.search('Queen', { source: 'all', limit: 10 });
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await searchAggregator.search('Queen', { source: 'all', limit: 10 });
    expect(calls.length).toBe(afterFirst);
    expect(searchAggregator.getCacheSize()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  it('resolves a YouTube stream through the real chain and starts playback', async () => {
    const results = await searchForTracks();
    const track = results[0];
    expect(track.streamUrl).toBeUndefined(); // search never carries a stream URL

    await player().playTrack(track, results, 0);

    expect(player().currentTrack?.id).toBe(track.id);
    expect(player().playbackState).toBe('playing');
    expect(player().isPlaying).toBe(true);
    expect(player().isLoading).toBe(false);
    expect(player().error).toBeNull();
    expect(player().duration).toBe(355);

    // The resolver really ran and cached a googlevideo URL for this track.
    const resolved = await streamResolver.resolve(track);
    expect(resolved.cached).toBe(true);
    expect(resolved.streamUrl).toContain('googlevideo.com/videoplayback');
    expect(resolved.streamUrl).toContain(track.originalId);

    // And the OS-level metadata was published.
    expect((navigator as unknown as { mediaSession: { metadata: { title: string } | null } }).mediaSession.metadata?.title)
      .toBe('Bohemian Rhapsody');
  });

  it('resolves a SoundCloud progressive stream and records it in history', async () => {
    const results = await searchForTracks();
    const scTrack = results.find((t) => t.source === 'soundcloud')!;

    await player().playTrack(scTrack, results, results.indexOf(scTrack));

    expect(player().playbackState).toBe('playing');
    const resolved = await streamResolver.resolve(scTrack);
    expect(resolved.streamUrl).toContain('cf-media.sndcdn.com');
    expect(resolved.format).toBe('mp3');

    // History is written through the library store into Dexie, not just state.
    await waitFor(() => library().history.length > 0);
    expect(library().history[0]?.id).toBe(scTrack.id);
    const persisted = await dbService.getHistoryTracks(10);
    expect(persisted.map((t) => t.id)).toContain(scTrack.id);
  });

  it('surfaces a resolution failure as a player error rather than throwing', async () => {
    installFetchMock([
      ...healthySourceRoutes(),
      // Route order matters: this shadows the healthy player endpoint.
      { match: 'www.youtube.com/youtubei/v1/player', respond: () => { throw new Error('ETIMEDOUT'); } }
    ].reverse());

    const results = await searchForTracks();
    const ytTrack = results.find((t) => t.source === 'youtube')!;

    await expect(player().playTrack(ytTrack, results, 0)).resolves.toBeUndefined();

    expect(player().playbackState).toBe('error');
    expect(player().isPlaying).toBe(false);
    expect(player().isLoading).toBe(false);
    expect(player().error).toMatch(/не отдал аудио/i);
    expect(player().errorDetail).toMatch(/Unable to resolve audio stream/i);
  });

  // -------------------------------------------------------------------------
  // Two-tier queue
  // -------------------------------------------------------------------------

  it('drains the user queue before the source queue, then resumes the source queue', async () => {
    const results = await searchForTracks();
    const [first, second, third] = results;

    await player().playTrack(first, [first, second], 0);
    player().addToUserQueue(third);
    expect(player().userQueue.map((t) => t.id)).toEqual([third.id]);

    // Priority tier wins.
    await player().nextTrack(true);
    expect(player().currentTrack?.id).toBe(third.id);
    expect(player().userQueue).toHaveLength(0);
    // The source position is unchanged, so the album still resumes where it was.
    expect(player().currentIndex).toBe(0);

    await player().nextTrack(true);
    expect(player().currentTrack?.id).toBe(second.id);
    expect(player().currentIndex).toBe(1);
  });

  it('walks back through history with prevTrack without re-recording it', async () => {
    const results = await searchForTracks();
    const [first, second] = results;

    await player().playTrack(first, results, 0);
    await player().playTrack(second, results, 1);
    await flushPromises();

    const historyLength = player().history.length;
    await player().prevTrack();

    expect(player().currentTrack?.id).toBe(first.id);
    // Stepping back must not grow history, or prev/next becomes a loop.
    expect(player().history.length).toBeLessThanOrEqual(historyLength);
  });

  it('repeats one track and loops the queue with repeat-all', async () => {
    const results = await searchForTracks();
    const [first, second] = results;

    await player().playTrack(first, [first, second], 0);

    player().setRepeatMode('one');
    await player().nextTrack(false); // natural end
    expect(player().currentTrack?.id).toBe(first.id);

    player().setRepeatMode('all');
    await player().nextTrack(false);
    expect(player().currentTrack?.id).toBe(second.id);
    await player().nextTrack(false);
    expect(player().currentTrack?.id).toBe(first.id); // wrapped

    player().setRepeatMode('off');
    expect(player().repeatMode).toBe('off');
  });

  it('builds a shuffle order that covers the queue exactly once, current track first', async () => {
    const results = await searchForTracks();
    await player().playTrack(results[0], results, 0);

    player().toggleShuffle();

    expect(player().isShuffled).toBe(true);
    const order = player().shuffleOrder;
    expect(order[0]).toBe(0);
    expect([...order].sort((a, b) => a - b)).toEqual(results.map((_, i) => i));
  });

  // -------------------------------------------------------------------------
  // Volume, EQ, sleep timer
  // -------------------------------------------------------------------------

  it('mutes through the engine, keeps the slider position, and never unmutes to silence', async () => {
    player().setVolume(0.42);
    player().toggleMute();

    expect(player().isMuted).toBe(true);
    expect(audioEngine.isMuted()).toBe(true);
    // The slider does not jump to zero — silence is the engine's job, so the
    // pre-mute level is still visible in the UI.
    expect(player().volume).toBeCloseTo(0.42, 5);

    player().toggleMute();
    expect(player().isMuted).toBe(false);
    expect(audioEngine.isMuted()).toBe(false);
    expect(player().volume).toBeCloseTo(0.42, 5);

    // Dragging the slider to zero *is* muting, so one toggle brings the sound
    // back at the last audible level rather than leaving the app silent.
    player().setVolume(0);
    expect(player().isMuted).toBe(true);
    expect(audioEngine.isMuted()).toBe(true);

    player().toggleMute();
    expect(player().isMuted).toBe(false);
    expect(player().volume).toBeCloseTo(0.42, 5);
  });

  it('persists playback preferences and restores them on the next launch', async () => {
    player().setVolume(0.31);
    player().setRepeatMode('all');
    player().setEq({ bass: 6, treble: -3 });
    player().setAutoplayRadio(true);
    await flushPromises();

    // Simulate a fresh boot: state wiped, database intact.
    resetPlayerStore();
    expect(player().settingsHydrated).toBe(false);

    await player().hydrateSettings();

    expect(player().settingsHydrated).toBe(true);
    expect(player().volume).toBeCloseTo(0.31, 5);
    expect(player().repeatMode).toBe('all');
    expect(player().eq).toEqual({ bass: 6, mid: 0, treble: -3 });
    expect(player().autoplayRadio).toBe(true);
  });

  it('clamps EQ gains to the ±12 dB the filters actually support', () => {
    player().setEq({ bass: 99, mid: -99, treble: Number.NaN });
    expect(player().eq.bass).toBe(12);
    expect(player().eq.mid).toBe(-12);
    expect(player().eq.treble).toBe(0); // NaN falls back, never propagates
  });

  it('arms and disarms the sleep timer', () => {
    vi.useFakeTimers();
    try {
      player().setSleepTimer(30);
      const endsAt = player().sleepTimerEndsAt;
      expect(endsAt).not.toBeNull();
      expect(endsAt! - Date.now()).toBeGreaterThan(29 * 60_000);

      player().setSleepTimer(null);
      expect(player().sleepTimerEndsAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // Library
  // -------------------------------------------------------------------------

  it('favorites a searched track and reloads it from IndexedDB', async () => {
    const results = await searchForTracks();
    const track = results[0];

    expect(await library().toggleFavorite(track)).toBe(true);
    expect(library().isFavorite(track.id)).toBe(true);

    resetLibraryStore();
    expect(await library().loadInitialData()).toBe(true);
    expect(library().favorites.map((t) => t.id)).toEqual([track.id]);

    expect(await library().toggleFavorite(track)).toBe(true);
    expect(library().isFavorite(track.id)).toBe(false);
    expect(await dbService.getFavorites()).toHaveLength(0);
  });

  it('creates a playlist, fills it from search results and plays it as a queue', async () => {
    const results = await searchForTracks();

    const playlist = await library().createPlaylist('Road Trip', 'For the drive');
    expect(playlist).not.toBeNull();

    for (const track of results.slice(0, 3)) {
      expect(await library().addTrackToPlaylist(playlist!.id, track)).toBe(true);
    }

    const stored = library().playlists.find((p) => p.id === playlist!.id)!;
    expect(stored.title).toBe('Road Trip');
    expect(stored.tracks).toHaveLength(3);

    await player().playTrack(stored.tracks[0], stored.tracks, 0);
    expect(player().sourceQueue.map((t) => t.id)).toEqual(stored.tracks.map((t) => t.id));
    expect(player().currentIndex).toBe(0);

    // Reordering the playlist reconciles the live queue in place.
    expect(await library().reorderPlaylistTracks(playlist!.id, 0, 2)).toBe(true);
    const reordered = library().playlists.find((p) => p.id === playlist!.id)!;
    player().syncSourceQueue(reordered.tracks);

    expect(player().sourceQueue.map((t) => t.id)).toEqual(reordered.tracks.map((t) => t.id));
    // The playing track is still the playing track, at its new index.
    expect(player().sourceQueue[player().currentIndex].id).toBe(player().currentTrack?.id);
  });

  it('round-trips the whole library through a backup file', async () => {
    const results = await searchForTracks();
    await library().toggleFavorite(results[0]);
    const playlist = await library().createPlaylist('Backup Me');
    await library().addTrackToPlaylist(playlist!.id, results[1]);

    const backup = await exportLibrary();
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.favorites).toHaveLength(1);
    expect(backup.playlists).toHaveLength(1);

    const json = JSON.stringify(backup);
    await dbService.clearAllData();
    resetLibraryStore();
    await library().loadInitialData();
    expect(library().favorites).toHaveLength(0);

    const summary = await importLibrary(json, 'replace');
    expect(summary.favorites).toBe(1);
    expect(summary.playlists).toBe(1);

    await library().loadInitialData();
    expect(library().favorites.map((t) => t.id)).toEqual([results[0].id]);
    expect(library().playlists[0].title).toBe('Backup Me');
    expect(library().playlists[0].tracks.map((t) => t.id)).toEqual([results[1].id]);
  });

  it('clears listening history without touching favorites or playlists', async () => {
    const results = await searchForTracks();
    await library().addToHistory(results[0]);
    await library().toggleFavorite(results[1]);
    expect(library().history).toHaveLength(1);

    expect(await library().clearHistory()).toBe(true);

    expect(library().history).toHaveLength(0);
    expect(await dbService.getHistoryTracks(10)).toHaveLength(0);
    expect(library().favorites).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Sync (local-only by design)
  // -------------------------------------------------------------------------

  it('reports local-only reconciliation instead of claiming a cloud sync', async () => {
    const results = await searchForTracks();
    await library().toggleFavorite(results[0]);
    await library().createPlaylist('Local Only');

    useAuthStore.setState({ isAuthenticated: true, isGuest: false });
    const outcome = await cloudSyncEngine.syncAll();

    expect(outcome.success).toBe(true);
    expect(outcome.remoteConfigured).toBe(false);
    // Nothing was accepted by a remote, because there is no remote.
    expect(outcome.syncedPlaylists).toBe(0);
    expect(outcome.syncedFavorites).toBe(0);
    // What did happen is reported honestly.
    expect(outcome.localPlaylists).toBe(1);
    expect(outcome.localFavorites).toBe(1);
    expect(outcome.message).toMatch(/только на этом устройстве/i);
  });
});
