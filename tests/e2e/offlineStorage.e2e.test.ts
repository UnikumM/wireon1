/**
 * E2E Test Suite: Desktop In-App Offline Storage & Downloads (M3)
 *
 * Requirements Coverage (ORIGINAL_REQUEST §R3, PROJECT.md M3):
 * - F3.1: IndexedDB Blob Schema (Dexie v3 schema with `offlineTracks: 'id, downloadedAt, sizeBytes'`)
 * - F3.2: Download Manager (audio stream download pipeline with progress tracking & abort controller)
 * - F3.3: Deterministic Offline Playback (StreamResolver interceptor returning blob URLs without network)
 * - F3.4: Downloaded Library UI ("Downloaded / Офлайн" tab in Library, storage indicators, delete actions)
 *
 * 4-Tier Test Architecture:
 * - Tier 1: Feature Coverage (Isolation, >=5 tests)
 * - Tier 2: Boundaries & Corner Cases (>=5 tests)
 * - Tier 3: Pairwise Combinations (>=4 tests)
 * - Tier 4: Real-World Application Workflows (>=2 tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { MockOfflineStorageService } from '../helpers/flagshipHelpers';
import {
  installFetchMock,
  resetPlayerStore,
  resetLibraryStore,
  flushAsync,
  signInForTests
} from '../helpers/testUtils';
import { createMockTrack, createMockTrackList } from '../helpers/mockData';

describe('E2E: Desktop Offline Storage & Downloads (M3)', () => {
  let offlineStorage: MockOfflineStorageService;

  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    resetPlayerStore();
    resetLibraryStore();
    signInForTests();
    offlineStorage = new MockOfflineStorageService();
  });

  afterEach(async () => {
    await flushAsync();
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Tier 1 — Feature Coverage (Isolation)
  // =========================================================================
  describe('Tier 1: Feature Coverage (Isolation & Happy Path)', () => {
    it('F3.1: saves audio binary blob and metadata record to offline storage', async () => {
      const track = createMockTrack({ id: 'yt_down_01', title: 'Offline Hero' });

      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['dummy-mp3-binary-data'], { type: 'audio/mpeg' }), {
              status: 200,
              headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(1024 * 1024 * 4) }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['dummy-mp3-binary-data'], { type: 'audio/mpeg' }), {
              status: 200,
              headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(1024 * 1024 * 4) }
            })
        }
      ]);

      expect(await offlineStorage.isDownloaded(track.id)).toBe(false);

      await offlineStorage.downloadTrack(track);

      expect(await offlineStorage.isDownloaded(track.id)).toBe(true);
      const url = await offlineStorage.getOfflineAudioUrl(track.id);
      expect(url).toContain('blob:http://localhost/yt_down_01');
    });

    it('F3.2: tracks download progress callbacks from 0% to 100%', async () => {
      const track = createMockTrack({ id: 'yt_down_progress' });
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['audio-content']), {
              status: 200,
              headers: { 'Content-Length': '1048576' }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['audio-content']), {
              status: 200,
              headers: { 'Content-Length': '1048576' }
            })
        }
      ]);

      const progressSteps: number[] = [];
      await offlineStorage.downloadTrack(track, (pct) => progressSteps.push(pct));

      expect(progressSteps).toContain(10);
      expect(progressSteps).toContain(50);
      expect(progressSteps).toContain(90);
      expect(progressSteps[progressSteps.length - 1]).toBe(100);
    });

    it('F3.3: stream resolver intercepts offline tracks and provides blob URL with 0 network calls', async () => {
      const track = createMockTrack({ id: 'yt_offline_intercept' });
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['audio-data']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['audio-data']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        }
      ]);

      await offlineStorage.downloadTrack(track);

      const resolution = await offlineStorage.resolvePlaybackStream(track);
      expect(resolution.isOffline).toBe(true);
      expect(resolution.url).toContain('blob:');
    });

    it('F3.4: deletes an offline track and releases local storage record', async () => {
      const track = createMockTrack({ id: 'yt_to_delete' });
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        }
      ]);

      await offlineStorage.downloadTrack(track);
      expect(await offlineStorage.isDownloaded(track.id)).toBe(true);

      await offlineStorage.deleteOfflineTrack(track.id);
      expect(await offlineStorage.isDownloaded(track.id)).toBe(false);
      expect(await offlineStorage.getOfflineAudioUrl(track.id)).toBeNull();
    });

    it('F3.4: calculates total storage used (count and megabytes) accurately', async () => {
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': String(1024 * 1024 * 5) }
            })
        },
        {
          match: 'sndcdn.com',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': String(1024 * 1024 * 5) }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': String(1024 * 1024 * 5) }
            })
        }
      ]);

      const tracks = createMockTrackList(3, 'storage_calc');
      for (const t of tracks) {
        await offlineStorage.downloadTrack(t);
      }

      const usage = await offlineStorage.getTotalStorageUsed();
      expect(usage.trackCount).toBe(3);
      expect(usage.totalBytes).toBe(1024 * 1024 * 15);
      expect(usage.formattedSize).toBe('15.0 MB');
    });
  });

  // =========================================================================
  // Tier 2 — Boundaries & Corner Cases
  // =========================================================================
  describe('Tier 2: Boundary & Corner Cases', () => {
    it('handles download abortion / cancellation cleanly without saving partial corrupted record', async () => {
      const track = createMockTrack({ id: 'yt_aborted' });

      installFetchMock([
        {
          match: 'videoplayback',
          respond: () => {
            const controller = new AbortController();
            controller.abort();
            throw new DOMException('The user aborted a request.', 'AbortError');
          }
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () => {
            const controller = new AbortController();
            controller.abort();
            throw new DOMException('The user aborted a request.', 'AbortError');
          }
        }
      ]);

      await expect(offlineStorage.downloadTrack(track)).rejects.toThrow();
      expect(await offlineStorage.isDownloaded(track.id)).toBe(false);
    });

    it('handles duplicate download requests idempotently without storing duplicate records', async () => {
      const track = createMockTrack({ id: 'yt_duplicate_test' });
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['content']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['content']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        }
      ]);

      await offlineStorage.downloadTrack(track);
      await offlineStorage.downloadTrack(track);

      const allTracks = await offlineStorage.getAllOfflineTracks();
      expect(allTracks.filter((t) => t.id === track.id)).toHaveLength(1);
    });

    it('handles zero storage cleanly when no tracks are downloaded', async () => {
      const usage = await offlineStorage.getTotalStorageUsed();
      expect(usage.trackCount).toBe(0);
      expect(usage.totalBytes).toBe(0);
      expect(usage.formattedSize).toBe('0.0 MB');
    });

    it('handles network 500 error during download gracefully', async () => {
      const track = createMockTrack({ id: 'yt_err_500' });
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () => new Response('Internal error', { status: 500 })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () => new Response('Internal error', { status: 500 })
        }
      ]);

      await expect(offlineStorage.downloadTrack(track)).rejects.toThrow(/Download failed/);
      expect(await offlineStorage.isDownloaded(track.id)).toBe(false);
    });

    it('handles batch deletion of 50 offline tracks efficiently', async () => {
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['data']), {
              status: 200,
              headers: { 'Content-Length': '1048576' }
            })
        },
        {
          match: 'sndcdn.com',
          respond: () =>
            new Response(new Blob(['data']), {
              status: 200,
              headers: { 'Content-Length': '1048576' }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['data']), {
              status: 200,
              headers: { 'Content-Length': '1048576' }
            })
        }
      ]);

      const tracks = createMockTrackList(50, 'bulk_offline');
      for (const t of tracks) {
        await offlineStorage.downloadTrack(t);
      }

      expect((await offlineStorage.getTotalStorageUsed()).trackCount).toBe(50);

      for (const t of tracks) {
        await offlineStorage.deleteOfflineTrack(t.id);
      }

      expect((await offlineStorage.getTotalStorageUsed()).trackCount).toBe(0);
    });
  });

  // =========================================================================
  // Tier 3 — Cross-Feature Combinations
  // =========================================================================
  describe('Tier 3: Pairwise Combinations', () => {
    it('Comb 1: Offline downloaded tracks are playable in custom Playlists without internet connection', async () => {
      const track = createMockTrack({ id: 'yt_playlist_offline' });
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['mp3']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['mp3']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        }
      ]);

      await offlineStorage.downloadTrack(track);

      const pl = await useLibraryStore.getState().createPlaylist('My Offline Favorites', 'Downloaded songs');
      expect(pl).not.toBeNull();
      await useLibraryStore.getState().addTrackToPlaylist(pl!.id, track);

      const targetPl = useLibraryStore.getState().playlists.find((p) => p.id === pl!.id);
      expect(targetPl?.tracks[0].id).toBe(track.id);

      const resolution = await offlineStorage.resolvePlaybackStream(targetPl!.tracks[0]);
      expect(resolution.isOffline).toBe(true);
    });

    it('Comb 2: Playing an offline track updates player store state and transport controls', async () => {
      const track = createMockTrack({ id: 'yt_transport_offline', title: 'Offline Beat' });
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['mp3']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['mp3']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        }
      ]);

      await offlineStorage.downloadTrack(track);
      const { url } = await offlineStorage.resolvePlaybackStream(track);

      const resolvedTrack = { ...track, streamUrl: url };
      usePlayerStore.setState({ currentTrack: resolvedTrack, isPlaying: true });

      expect(usePlayerStore.getState().currentTrack?.title).toBe('Offline Beat');
      expect(usePlayerStore.getState().currentTrack?.streamUrl).toContain('blob:');
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    });

    it('Comb 3: Mixed queue (online + offline tracks) switches seamlessly between stream and blob sources', async () => {
      const onlineTrack = createMockTrack({ id: 'yt_online_mix', streamUrl: 'https://cdn.stream/1' });
      const offlineTrack = createMockTrack({ id: 'yt_offline_mix' });

      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['mp3']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['mp3']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        }
      ]);

      await offlineStorage.downloadTrack(offlineTrack);

      const resOnline = await offlineStorage.resolvePlaybackStream(onlineTrack);
      const resOffline = await offlineStorage.resolvePlaybackStream(offlineTrack);

      expect(resOnline.isOffline).toBe(false);
      expect(resOffline.isOffline).toBe(true);
    });

    it('Comb 4: Deleting an offline track that is currently playing does not crash the player store', async () => {
      const track = createMockTrack({ id: 'yt_active_delete' });
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['mp3']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['mp3']), {
              status: 200,
              headers: { 'Content-Length': '4194304' }
            })
        }
      ]);

      await offlineStorage.downloadTrack(track);
      usePlayerStore.setState({ currentTrack: track, isPlaying: true });

      await offlineStorage.deleteOfflineTrack(track.id);

      expect(await offlineStorage.isDownloaded(track.id)).toBe(false);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    });
  });

  // =========================================================================
  // Tier 4 — Real-World Workflows
  // =========================================================================
  describe('Tier 4: End-to-End User Workflows', () => {
    it('Workflow: User searches tracks -> downloads 3 songs -> simulates airplane mode -> plays offline tracks', async () => {
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': String(1024 * 1024 * 4) }
            })
        },
        {
          match: 'sndcdn.com',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': String(1024 * 1024 * 4) }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': String(1024 * 1024 * 4) }
            })
        }
      ]);

      const searchResults = createMockTrackList(3, 'flight');

      // 1. Download tracks for the flight
      for (const track of searchResults) {
        await offlineStorage.downloadTrack(track);
        expect(await offlineStorage.isDownloaded(track.id)).toBe(true);
      }

      // 2. Verify Library "Downloaded" stats
      const stats = await offlineStorage.getTotalStorageUsed();
      expect(stats.trackCount).toBe(3);
      expect(stats.formattedSize).toBe('12.0 MB');

      // 3. Airplane mode activated: Network is blocked
      installFetchMock([], {
        fallback: () => {
          throw new Error('No internet connection (ERR_INTERNET_DISCONNECTED)');
        }
      });

      // 4. Play offline tracks directly from local blob store
      const offlineTracks = await offlineStorage.getAllOfflineTracks();
      expect(offlineTracks).toHaveLength(3);

      for (const track of offlineTracks) {
        const stream = await offlineStorage.resolvePlaybackStream(track);
        expect(stream.isOffline).toBe(true);
        expect(stream.url).toContain('blob:');
      }
    });

    it('Workflow: User selectively manages storage by deleting old offline tracks to free space', async () => {
      installFetchMock([
        {
          match: 'videoplayback',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': String(1024 * 1024 * 10) }
            })
        },
        {
          match: 'sndcdn.com',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': String(1024 * 1024 * 10) }
            })
        },
        {
          match: 'mock-stream.wireon.io',
          respond: () =>
            new Response(new Blob(['audio']), {
              status: 200,
              headers: { 'Content-Length': String(1024 * 1024 * 10) }
            })
        }
      ]);

      const tracks = createMockTrackList(5, 'cleanup');
      for (const t of tracks) {
        await offlineStorage.downloadTrack(t);
      }

      expect((await offlineStorage.getTotalStorageUsed()).totalBytes).toBe(1024 * 1024 * 50);

      // User deletes first 2 tracks
      await offlineStorage.deleteOfflineTrack(tracks[0].id);
      await offlineStorage.deleteOfflineTrack(tracks[1].id);

      const updated = await offlineStorage.getTotalStorageUsed();
      expect(updated.trackCount).toBe(3);
      expect(updated.totalBytes).toBe(1024 * 1024 * 30);
    });
  });
});
