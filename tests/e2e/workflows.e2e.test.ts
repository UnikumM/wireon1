/**
 * E2E Test Suite: Real-World Multi-Feature Workflows (Tier 4)
 *
 * Requirements Coverage (ORIGINAL_REQUEST ## 2026-08-17T20:45:42Z, PROJECT.md):
 * Comprehensive end-to-end integration workflows exercising combinations of:
 * - (1) Time-Synced Lyrics & Karaoke View (M2)
 * - (2) DJ Crossfade & Audio Normalization (M1)
 * - (3) Desktop Offline Storage & Downloads (M3)
 * - (4) Discord Rich Presence (RPC) (M4)
 * - (5) 1-Click Multi-Platform Playlist Importer (M5)
 * - (6) Artist Hub Pages & Universal Navigation (M6)
 * - (7) Real-Time Group Listen Synchronization (M7)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';

import {
  installFetchMock,
  jsonResponse,
  resetPlayerStore,
  resetLibraryStore,
  resetUIStore,
  flushAsync,
  signInForTests
} from '../helpers/testUtils';
import { createMockTrack, createMockTrackList } from '../helpers/mockData';

// Import domain models from flagshipHelpers
import {
  MockLyricsService,
  findActiveLyricIndex,
  DualDeckEngineModel,
  MockOfflineStorageService,
  MockDiscordRpcManager,
  MockPlaylistImporterService,
  MockArtistService,
  MockGroupListenSession
} from '../helpers/flagshipHelpers';

describe('E2E: Real-World Multi-Feature Workflows (Tier 4)', () => {
  let lyricsService: MockLyricsService;
  let audioDsp: DualDeckEngineModel;
  let offlineStorage: MockOfflineStorageService;
  let rpcManager: MockDiscordRpcManager;
  let importer: MockPlaylistImporterService;
  let artistService: MockArtistService;
  let hostSession: MockGroupListenSession;
  let peerSession: MockGroupListenSession;

  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();

    resetPlayerStore();
    resetLibraryStore();
    signInForTests();
    resetUIStore();

    lyricsService = new MockLyricsService();
    audioDsp = new DualDeckEngineModel();
    offlineStorage = new MockOfflineStorageService();
    rpcManager = new MockDiscordRpcManager();
    rpcManager.connect();
    importer = new MockPlaylistImporterService();
    artistService = new MockArtistService();
    hostSession = new MockGroupListenSession('host_001', 'DjMaster');
    peerSession = new MockGroupListenSession('peer_002', 'Listener1');
  });

  afterEach(async () => {
    await flushAsync();
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Workflow 1: Spotify Import -> Batch Download -> Airplane Mode Playback
  // =========================================================================
  it('Workflow 1: Spotify Import -> Batch Offline Download -> Airplane Mode Offline Playback', async () => {
    const spotifyUrl = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';

    installFetchMock([
      {
        match: 'spotify.com/playlist',
        respond: () =>
          jsonResponse({
            title: 'Summer Drive 2026',
            items: [
              { title: 'Cruel Summer', artist: 'Taylor Swift', duration: 178 },
              { title: 'Levitating', artist: 'Dua Lipa', duration: 203 },
              { title: 'Watermelon Sugar', artist: 'Harry Styles', duration: 174 }
            ]
          })
      },
      {
        match: 'api.wireon.mock/search',
        respond: () => jsonResponse({ bitrate: 256, format: 'm4a' })
      },
      {
        match: 'videoplayback',
        respond: () =>
          new Response(new Blob(['dummy-audio']), {
            status: 200,
            headers: { 'Content-Length': String(1024 * 1024 * 3) }
          })
      },
      {
        match: 'mock-stream.wireon.io',
        respond: () =>
          new Response(new Blob(['dummy-audio']), {
            status: 200,
            headers: { 'Content-Length': String(1024 * 1024 * 3) }
          })
      }
    ]);

    // 1. User imports Spotify playlist
    const parsed = await importer.parsePlaylistUrl(spotifyUrl);
    expect(parsed.platform).toBe('spotify');
    expect(parsed.items).toHaveLength(3);

    const resolved = await importer.resolveImportedTracks(parsed.items);
    expect(resolved).toHaveLength(3);

    const playlistId = await importer.saveToLibrary(parsed.title, resolved);
    const savedPl = useLibraryStore.getState().playlists.find((p) => p.id === playlistId);
    expect(savedPl?.tracks).toHaveLength(3);

    // 2. User downloads all 3 tracks for offline flight
    for (const track of savedPl!.tracks) {
      await offlineStorage.downloadTrack(track);
      expect(await offlineStorage.isDownloaded(track.id)).toBe(true);
    }

    const storageUsage = await offlineStorage.getTotalStorageUsed();
    expect(storageUsage.trackCount).toBe(3);
    expect(storageUsage.formattedSize).toBe('9.0 MB');

    // 3. User goes on airplane mode (Network severed)
    installFetchMock([], {
      fallback: () => {
        throw new Error('ERR_INTERNET_DISCONNECTED');
      }
    });

    // 4. User opens Library "Downloaded" tab and plays track 1
    const offlineList = await offlineStorage.getAllOfflineTracks();
    expect(offlineList).toHaveLength(3);

    const firstTrackStream = await offlineStorage.resolvePlaybackStream(offlineList[0]);
    expect(firstTrackStream.isOffline).toBe(true);
    expect(firstTrackStream.url).toContain('blob:');

    // 5. Load into PlayerStore and verify playback without network
    usePlayerStore.setState({
      currentTrack: { ...offlineList[0], streamUrl: firstTrackStream.url },
      isPlaying: true
    });

    expect(usePlayerStore.getState().currentTrack?.title).toBe('Cruel Summer');
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  // =========================================================================
  // Workflow 2: Artist Discovery -> Top 10 Playback -> Synced Karaoke -> Click to Seek -> Discord RPC
  // =========================================================================
  it('Workflow 2: Artist Hub Discovery -> Top 10 -> Time-Synced Karaoke -> Click-to-Seek -> Discord RPC', async () => {
    const lrcLyrics = `[00:00.00]Instrumental Intro
[00:10.00]Look into my eyes, you will see
[00:25.00]What you mean to me
[00:40.00]Search your heart, search your soul
[00:55.00]And when you find me there you'll search no more`;

    const topTracks = Array.from({ length: 10 }, (_, i) =>
      createMockTrack({
        id: `yt_bryan_${i}`,
        title: i === 0 ? 'Everything I Do' : `Hit ${i + 1}`,
        artist: 'Bryan Adams',
        duration: 380,
        artworkUrl: 'https://cdn.art/bryan.jpg'
      })
    );

    installFetchMock([
      {
        match: 'api.wireon.mock/artist/Bryan%20Adams',
        respond: () =>
          jsonResponse({
            name: 'Bryan Adams',
            bio: 'Canadian rock singer and songwriter.',
            topTracks,
            albums: [{ id: 'waking_up', title: 'Waking Up the Neighbours', year: '1991' }],
            similarArtists: [{ name: 'Rod Stewart' }, { name: 'Bon Jovi' }]
          })
      },
      {
        match: 'lrclib.net/api/get',
        respond: () =>
          jsonResponse({
            syncedLyrics: lrcLyrics,
            name: 'Everything I Do',
            artistName: 'Bryan Adams'
          })
      }
    ]);

    // 1. User discovers artist in Artist Hub
    const profile = await artistService.getArtistProfile('Bryan Adams');
    expect(profile.name).toBe('Bryan Adams');
    expect(profile.topTracks).toHaveLength(10);

    // 2. User plays Top Track #1
    const activeTrack = profile.topTracks[0];
    usePlayerStore.setState({
      currentTrack: activeTrack,
      sourceQueue: profile.topTracks,
      currentIndex: 0,
      isPlaying: true,
      currentTime: 0
    });

    // 3. Discord RPC broadcasts active presence
    const rpcPayload = rpcManager.buildPayloadFromTrack(activeTrack, true, 0);
    rpcManager.setActivity(rpcPayload);
    expect(rpcManager.currentActivity?.details).toBe('Everything I Do');
    expect(rpcManager.currentActivity?.state).toBe('Bryan Adams');

    // 4. User opens Karaoke View (mic button)
    useUIStore.getState().setFullscreenPlayerOpen(true);
    expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);

    const lyrics = await lyricsService.fetchLyrics(activeTrack);
    expect(lyrics?.synced).toBe(true);
    expect(lyrics?.lines).toHaveLength(5);

    // 5. Track plays to 28s
    usePlayerStore.setState({ currentTime: 28.0 });
    let activeLineIdx = findActiveLyricIndex(lyrics!.lines, usePlayerStore.getState().currentTime);
    expect(activeLineIdx).toBe(2);
    expect(lyrics!.lines[activeLineIdx].text).toBe('What you mean to me');

    // 6. User clicks lyric line at 55.0s to jump forward
    const targetLine = lyrics!.lines[4];
    usePlayerStore.getState().seekTo(targetLine.time);

    expect(usePlayerStore.getState().currentTime).toBe(55.0);
    activeLineIdx = findActiveLyricIndex(lyrics!.lines, usePlayerStore.getState().currentTime);
    expect(activeLineIdx).toBe(4);
    expect(lyrics!.lines[activeLineIdx].text).toBe("And when you find me there you'll search no more");

    // 7. Discord RPC reflects updated timestamp
    const updatedRpc = rpcManager.buildPayloadFromTrack(activeTrack, true, 55.0);
    rpcManager.setActivity(updatedRpc);
    expect(updatedRpc?.startTimestamp).toBeDefined();
  });

  // =========================================================================
  // Workflow 3: Social Party: Host creates Room -> invites Peer -> Syncs Crossfade & Queue
  // =========================================================================
  it('Workflow 3: Social Party: Host creates Group Listen Room -> invites Peer -> Crossfaded Queue Sync', async () => {
    // 1. Host configures DJ Crossfade
    audioDsp.setCrossfade(true, 5.0);
    audioDsp.setLoudnessNormalization(true);

    // 2. Host creates Group Listen room
    const roomCode = await hostSession.createRoom();
    expect(roomCode).toHaveLength(6);

    // 3. Peer joins room
    await peerSession.joinRoom(roomCode);
    expect(peerSession.connected).toBe(true);

    const partyQueue = createMockTrackList(4, 'party');

    // 4. Host starts playing first track
    audioDsp.playTrack(partyQueue[0]);
    let syncMsg = hostSession.broadcastState({
      trackId: partyQueue[0].id,
      isPlaying: true,
      currentTime: 0,
      queue: partyQueue
    });

    peerSession.receiveMessage(syncMsg!);
    expect(peerSession.lastReceivedState?.trackId).toBe(partyQueue[0].id);
    expect(peerSession.lastReceivedState?.queue).toHaveLength(4);

    // 5. Near end of track 1, Host initiates DJ crossfade transition to track 2
    const transition = audioDsp.transitionToTrack(partyQueue[1]);
    expect(transition.transitionDuration).toBe(5.0);
    expect(audioDsp.activeDeck).toBe('deckB');

    // Host broadcasts track switch to room
    syncMsg = hostSession.broadcastState({
      trackId: partyQueue[1].id,
      isPlaying: true,
      currentTime: 0,
      queue: partyQueue
    });

    peerSession.receiveMessage(syncMsg!);
    expect(peerSession.lastReceivedState?.trackId).toBe(partyQueue[1].id);
  });

  // =========================================================================
  // Workflow 4: Full Ecosystem Loop & Error Recovery Resilience
  // =========================================================================
  it('Workflow 4: Complete Ecosystem Loop & Fault-Tolerant Resilience (LRCLIB fallback + Offline cache)', async () => {
    installFetchMock([
      {
        match: 'videoplayback',
        respond: () =>
          new Response(new Blob(['resilient-audio-data']), {
            status: 200,
            headers: { 'Content-Length': String(1024 * 1024 * 4) }
          })
      },
      {
        match: 'mock-stream.wireon.io',
        respond: () =>
          new Response(new Blob(['resilient-audio-data']), {
            status: 200,
            headers: { 'Content-Length': String(1024 * 1024 * 4) }
          })
      },
      {
        match: 'lrclib.net/api/get',
        respond: () => new Response('Internal Server Error', { status: 500 })
      }
    ]);

    const track = createMockTrack({
      id: 'yt_resilient_01',
      title: 'Resilient Cyber Track',
      artist: 'Synth Master'
    });

    // 1. Download track for offline insurance
    await offlineStorage.downloadTrack(track);
    expect(await offlineStorage.isDownloaded(track.id)).toBe(true);

    // 2. Play track with crossfade enabled
    audioDsp.setCrossfade(true, 4.0);
    audioDsp.playTrack(track);

    // 3. Attempt lyrics fetch -> fails gracefully without crashing player
    const lyrics = await lyricsService.fetchLyrics(track);
    expect(lyrics).toBeNull();

    // 4. Update Discord RPC
    const rpc = rpcManager.buildPayloadFromTrack(track, true, 10);
    rpcManager.setActivity(rpc);
    expect(rpcManager.currentActivity?.details).toBe('Resilient Cyber Track');

    // 5. Verify audio engine is still smoothly playing
    expect(audioDsp.deckA.isPlaying).toBe(true);
    expect(audioDsp.deckA.gain).toBe(1.0);
  });
});
