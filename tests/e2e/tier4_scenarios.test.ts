/**
 * Tier 4 — Scenarios.
 *
 * Whole journeys, in the order a person actually performs them: a first launch,
 * a commute, a day when YouTube's main endpoint is down, a track that will not
 * play, a move to a new machine, and a sign-in that is later undone.
 *
 * These are the tests that would have caught the release-blocking bugs, because
 * they cross every seam at once: stores, services, parsers, resolver, audio
 * engine, IndexedDB, backup files and the auth session. Only `fetch` is stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useUIStore } from '../../src/store/useUIStore';
import { SearchAggregator, searchAggregator } from '../../src/services/aggregator';
import { YouTubeService } from '../../src/services/youtube';
import { SoundCloudService } from '../../src/services/soundcloud';
import { StreamResolver, streamResolver } from '../../src/services/streamResolver';
import { cloudSyncEngine, NullRemoteAdapter } from '../../src/services/cloudSync';
import { exportLibrary, importLibrary } from '../../src/services/backup';
import { DISCORD_API_BASE } from '../../src/services/discordAuth';
import * as dbService from '../../src/services/db';
import { UserProfile } from '../../src/types/music';

import {
  installFetchMock,
  jsonResponse,
  httpErrorResponse,
  resetPlayerStore,
  resetLibraryStore,
  resetAuthStore,
  resetUIStore,
  clearAuthStorage,
  hasNoStoredSession,
  flushAsync,
  waitFor,
  signInForTests
} from '../helpers/testUtils';
import { healthySourceRoutes, pipedSearchPayload, youtubePlayerPayload } from '../helpers/networkFixtures';

const player = () => usePlayerStore.getState();
const library = () => useLibraryStore.getState();
const auth = () => useAuthStore.getState();
const ui = () => useUIStore.getState();

/** Everything a cold start does, in the order `App.tsx` does it. */
async function coldStart(): Promise<void> {
  resetPlayerStore();
  resetLibraryStore();
  resetUIStore();
  await Promise.all([player().hydrateSettings(), library().loadInitialData()]);
}

describe('Tier 4 — Scenarios', () => {
  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    installFetchMock(healthySourceRoutes());

    resetPlayerStore();
    resetLibraryStore();
    resetAuthStore();
    signInForTests();
    resetUIStore();
    clearAuthStorage();

    searchAggregator.clearCache();
    streamResolver.clearCache();
    cloudSyncEngine.setRemoteAdapter(new NullRemoteAdapter());
    cloudSyncEngine.pendingLocalMutations = [];
    cloudSyncEngine.parkedMutations = [];

    await dbService.clearAllData();
  });

  afterEach(async () => {
    player().setSleepTimer(null);
    await flushAsync();
    vi.unstubAllGlobals();
    clearAuthStorage();
    if (!dbService.db.isOpen()) await dbService.db.open();
    await dbService.clearAllData();
  });

  // -------------------------------------------------------------------------

  it('a new user opens the app, listens, builds a library, and finds it again next launch', async () => {
    // 1. First launch: no session on disk, no settings in the database.
    await auth().restoreSession();
    expect(auth().isGuest).toBe(true);
    expect(auth().isAuthenticated).toBe(false);
    expect(hasNoStoredSession()).toBe(true);

    await player().hydrateSettings();
    expect(player().settingsHydrated).toBe(true);
    expect(player().volume).toBeCloseTo(0.8, 5); // shipped default, not a leftover

    // 2. Searches for something and plays the first hit.
    const { results } = await searchAggregator.search('Queen', { source: 'all', limit: 10 });
    expect(results.length).toBeGreaterThan(2);

    await player().playTrack(results[0], results, 0);
    expect(player().playbackState).toBe('playing');

    // 3. Likes it — и упирается в аккаунт, потому что медиатека принадлежит ему.
    expect(await library().toggleFavorite(results[0])).toBe(false);
    expect(ui().accountPrompt).toBe('добавлять треки в избранное');
    ui().closeAccountPrompt();

    // Входит — и дальше всё как раньше.
    signInForTests();
    expect(await library().toggleFavorite(results[0])).toBe(true);
    player().setVolume(0.35);
    const playlist = await library().createPlaylist('First Playlist', 'Songs I found today');
    await library().addTrackToPlaylist(playlist!.id, results[0]);
    await library().addTrackToPlaylist(playlist!.id, results[1]);

    // 4. Listens to one more, then quits.
    await player().nextTrack(true);
    await waitFor(() => library().history.length >= 2);
    await flushAsync();

    // 5. Next launch: everything is where they left it.
    await coldStart();

    expect(player().volume).toBeCloseTo(0.35, 5);
    expect(library().favorites.map((t) => t.id)).toEqual([results[0].id]);
    expect(library().playlists).toHaveLength(1);
    expect(library().playlists[0].title).toBe('First Playlist');
    expect(library().playlists[0].tracks.map((t) => t.id)).toEqual([results[0].id, results[1].id]);
    // History survives too, newest first.
    expect(library().history.map((t) => t.id).slice(0, 2)).toEqual([results[1].id, results[0].id]);
    // And nothing pretended to be a signed-in session.
    expect(hasNoStoredSession()).toBe(true);
  });

  // -------------------------------------------------------------------------

  it('a commuter queues, reorders and skips through a listening session', async () => {
    const { results } = await searchAggregator.search('Queen', { source: 'all', limit: 10 });
    const [albumA, albumB, extraA, extraB] = results;

    // Starts an album …
    await player().playTrack(albumA, [albumA, albumB], 0);
    expect(player().currentTrack?.id).toBe(albumA.id);

    // … then hears two songs they want next, in a deliberate order.
    player().addToQueueEnd(extraA);
    player().addToQueueNext(extraB);
    expect(player().userQueue.map((t) => t.id)).toEqual([extraB.id, extraA.id]);

    // Changes their mind and reorders Up Next.
    player().reorderUserQueue(0, 1);
    expect(player().userQueue.map((t) => t.id)).toEqual([extraA.id, extraB.id]);

    // Skips: Up Next is served first, and the album keeps its place.
    await player().nextTrack(true);
    expect(player().currentTrack?.id).toBe(extraA.id);
    expect(player().currentIndex).toBe(0);

    await player().nextTrack(true);
    expect(player().currentTrack?.id).toBe(extraB.id);
    expect(player().userQueue).toHaveLength(0);

    // With Up Next empty the album resumes from where it paused.
    await player().nextTrack(true);
    expect(player().currentTrack?.id).toBe(albumB.id);
    expect(player().currentIndex).toBe(1);

    // Going back walks the same path in reverse without re-recording plays.
    await waitFor(() => library().history.length >= 4);
    const historyBefore = library().history.length;
    await player().prevTrack();
    expect(player().currentTrack?.id).toBe(extraB.id);
    await flushAsync();
    expect(library().history.length).toBe(historyBefore);

    // The database agrees with the session: four distinct plays, newest first.
    const persisted = await dbService.getHistoryTracks(10);
    expect(persisted.map((t) => t.id)).toEqual([albumB.id, extraB.id, extraA.id, albumA.id]);
  });

  // -------------------------------------------------------------------------

  it('a day when the main YouTube endpoint is down still plays music', async () => {
    installFetchMock([
      // InnerTube is refusing connections outright …
      { match: 'music.youtube.com/youtubei/v1/search', respond: () => { throw new Error('ECONNREFUSED'); } },
      // … so the Piped pool answers instead.
      {
        match: '/search?q=',
        respond: () => jsonResponse(pipedSearchPayload([
          { videoId: 'piped00001', title: 'Queen - Under Pressure', uploaderName: 'Queen', duration: 248 },
          { videoId: 'piped00002', title: 'Queen - Somebody To Love', uploaderName: 'Queen', duration: 297 }
        ]))
      },
      { match: '/api/v1/search', respond: () => httpErrorResponse(502, 'invidious down') },
      // Stream resolution is a different endpoint and is unaffected.
      ...healthySourceRoutes().filter((route) => route.match !== 'music.youtube.com/youtubei/v1/search'
        && route.match !== '/search?q=' && route.match !== '/api/v1/search')
    ]);

    // A fresh service graph: the singletons remember which mirrors are dead.
    const aggregator = new SearchAggregator(new YouTubeService(), new SoundCloudService(), new StreamResolver());
    const { results, sources, errors } = await aggregator.search('Queen', { source: 'all', limit: 10 });

    // The user cannot tell: both sources still produced results.
    expect(sources.youtube).toBe(2);
    expect(sources.soundcloud).toBeGreaterThan(0);
    expect(errors?.youtube).toBeUndefined();

    const fromPiped = results.find((t) => t.originalId.startsWith('piped'))!;
    expect(fromPiped.title).toBe('Under Pressure'); // parsed, not the raw upload title
    expect(fromPiped.artist).toBe('Queen');
    expect(fromPiped.duration).toBe(248);

    // And it plays: the mirror only served metadata, the stream comes from the
    // player endpoint, which is still up.
    await player().playTrack(fromPiped, results, results.indexOf(fromPiped));
    expect(player().playbackState).toBe('playing');
    expect(player().error).toBeNull();
  });

  // -------------------------------------------------------------------------

  it('one unplayable track does not end the session', async () => {
    const brokenId = 'yt00000002';

    installFetchMock([
      {
        match: 'www.youtube.com/youtubei/v1/player',
        respond: (_url, init) => {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
          // Exactly one video is unresolvable; everything else is healthy.
          if (body?.videoId === brokenId) throw new Error('ETIMEDOUT');
          return jsonResponse(youtubePlayerPayload(String(body?.videoId ?? 'unknown')));
        }
      },
      ...healthySourceRoutes()
    ]);

    const { results } = await searchAggregator.search('Queen', { source: 'all', limit: 10 });
    const good = results.find((t) => t.originalId === 'yt00000001')!;
    const broken = results.find((t) => t.originalId === brokenId)!;
    const recovery = results.find((t) => t.source === 'soundcloud')!;

    // The good track plays and is recorded.
    await player().playTrack(good, results, results.indexOf(good));
    expect(player().playbackState).toBe('playing');
    await waitFor(() => library().history.some((t) => t.id === good.id));

    // The broken one reports an error instead of throwing or hanging.
    await player().playTrack(broken, results, results.indexOf(broken));
    expect(player().playbackState).toBe('error');
    expect(player().isPlaying).toBe(false);
    expect(player().error).toMatch(/не отдал аудио/i);
    expect(player().errorDetail).toMatch(/Unable to resolve audio stream/i);
    // A track that never played is not a track the user listened to.
    await flushAsync();
    expect(library().history.map((t) => t.id)).not.toContain(broken.id);

    // Skipping past it recovers completely: no sticky error, playback resumes.
    await player().playTrack(recovery, results, results.indexOf(recovery));
    expect(player().playbackState).toBe('playing');
    expect(player().error).toBeNull();
    await waitFor(() => library().history.some((t) => t.id === recovery.id));
    expect((await dbService.getHistoryTracks(10)).map((t) => t.id)).not.toContain(broken.id);
  });

  // -------------------------------------------------------------------------

  it('a user moves to a new machine and restores from a backup file', async () => {
    // --- The old machine ---
    const { results } = await searchAggregator.search('Queen', { source: 'all', limit: 10 });
    await library().toggleFavorite(results[0]);
    await library().toggleFavorite(results[1]);
    const playlist = await library().createPlaylist('Carried Over');
    await library().addTrackToPlaylist(playlist!.id, results[2]);
    await library().addToHistory(results[3]);
    player().setVolume(0.4);
    player().setEq({ bass: 4, mid: 0, treble: -2 });
    player().setRepeatMode('all');
    await flushAsync();

    const json = JSON.stringify(await exportLibrary());

    // --- The new machine: empty database, factory-fresh player ---
    await dbService.clearAllData();
    await coldStart();
    expect(library().favorites).toHaveLength(0);
    expect(player().volume).toBeCloseTo(0.8, 5);

    const summary = await importLibrary(json, 'replace');
    expect(summary).toMatchObject({ favorites: 2, playlists: 1, history: 1 });

    // The next launch on the new machine looks like the old one.
    await coldStart();

    expect(library().favorites.map((t) => t.id).sort()).toEqual([results[0].id, results[1].id].sort());
    expect(library().playlists[0].title).toBe('Carried Over');
    expect(library().playlists[0].tracks.map((t) => t.id)).toEqual([results[2].id]);
    expect(library().history.map((t) => t.id)).toEqual([results[3].id]);
    // Preferences travel with the library, so the app sounds the same too.
    expect(player().volume).toBeCloseTo(0.4, 5);
    expect(player().eq).toEqual({ bass: 4, mid: 0, treble: -2 });
    expect(player().repeatMode).toBe('all');

    // And the restored library is immediately usable, not just stored.
    await player().playTrack(library().playlists[0].tracks[0], library().playlists[0].tracks, 0);
    expect(player().playbackState).toBe('playing');
  });

  // -------------------------------------------------------------------------

  it('signs in, restarts, and signs out again without losing a single track', async () => {
    const profile: UserProfile = {
      id: '4242',
      username: 'wireon-listener',
      avatarUrl: 'https://cdn.discordapp.com/avatars/4242/abc.png',
      provider: 'discord',
      status: 'online'
    };

    installFetchMock([
      {
        match: `${DISCORD_API_BASE}/users/@me`,
        respond: () => jsonResponse({ id: '4242', username: 'wireon-listener', global_name: 'Wireon Listener', discriminator: '0', avatar: 'abc' })
      },
      ...healthySourceRoutes()
    ]);

    // A library exists before signing in — this app is local-first.
    const { results } = await searchAggregator.search('Queen', { source: 'all', limit: 10 });
    await library().toggleFavorite(results[0]);
    await library().createPlaylist('Mine');

    auth().login(profile, 'discord-access-token', 3600);
    expect(auth().isAuthenticated).toBe(true);
    expect(hasNoStoredSession()).toBe(false);

    // Restart: the session is restored from disk and refreshed against Discord.
    resetAuthStore();
    await auth().restoreSession();
    expect(auth().isAuthenticated).toBe(true);
    expect(auth().authStatus).toBe('authenticated');
    expect(auth().user?.username).toBe('Wireon Listener'); // refreshed, not the cached name

    // Вход сам по себе облака не заводит: удалённая сторона появляется только
    // в сборке, которой задан адрес сервера (`VITE_WIREON_SERVER_URL`). В
    // прогоне он пуст нарочно — см. `vitest.config.ts`, — поэтому здесь
    // проверяется именно честный местный режим, а не «синхронизация сломана».
    const outcome = await cloudSyncEngine.syncAll();
    expect(outcome.success).toBe(true);
    expect(outcome.remoteConfigured).toBe(false);
    expect(outcome.syncedFavorites).toBe(0);
    expect(outcome.localFavorites).toBe(1);
    expect(outcome.message).toMatch(/только на этом устройстве/i);

    // Signing out clears the session and nothing else.
    auth().logout();
    expect(auth().isAuthenticated).toBe(false);
    expect(auth().isGuest).toBe(true);
    expect(hasNoStoredSession()).toBe(true);

    await coldStart();
    expect(library().favorites.map((t) => t.id)).toEqual([results[0].id]);
    expect(library().playlists[0].title).toBe('Mine');
  });
});
