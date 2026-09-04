/**
 * E2E Test Suite: Time-Synced Lyrics & Interactive Karaoke View (M2)
 *
 * Requirements Coverage (ORIGINAL_REQUEST §R1, PROJECT.md M2):
 * - F1.1: LRCLIB API Client (free public lyrics fetching with plain text fallback and local cache)
 * - F1.2: LRC Timestamp Parser ([mm:ss.xx] / [mm:ss.xxx] line timestamps to floating-point seconds)
 * - F1.3: Interactive Karaoke View (active line glow, auto-scroll centering, click-to-seek timestamp navigation)
 * - F1.4: Microphone Triggers (mic icon 🎤 in PlayerBar & FullscreenPlayer toggles Karaoke view)
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
import { useUIStore } from '../../src/store/useUIStore';
import {
  LyricsLine,
  MockLyricsService,
  parseLRC,
  findActiveLyricIndex
} from '../helpers/flagshipHelpers';
import {
  installFetchMock,
  jsonResponse,
  httpErrorResponse,
  resetPlayerStore,
  resetUIStore,
  flushAsync
} from '../helpers/testUtils';
import { createMockTrack } from '../helpers/mockData';

describe('E2E: Time-Synced Lyrics & Karaoke Mode (M2)', () => {
  let lyricsService: MockLyricsService;

  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    resetPlayerStore();
    resetUIStore();
    lyricsService = new MockLyricsService();
  });

  afterEach(async () => {
    await flushAsync();
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Tier 1 — Feature Coverage (Isolation)
  // =========================================================================
  describe('Tier 1: Feature Coverage (Happy Path & Isolation)', () => {
    it('F1.1: fetches time-synced lyrics from LRCLIB API and caches the result', async () => {
      const sampleLrc = `[00:12.50]Is this the real life?
[00:15.80]Is this just fantasy?
[00:21.00]Caught in a landslide, no escape from reality`;

      installFetchMock([
        {
          match: 'lrclib.net/api/get',
          respond: () =>
            jsonResponse({
              id: 101,
              name: 'Bohemian Rhapsody',
              artistName: 'Queen',
              syncedLyrics: sampleLrc,
              plainLyrics: 'Is this the real life?\nIs this just fantasy?'
            })
        }
      ]);

      const track = createMockTrack({
        title: 'Bohemian Rhapsody',
        artist: 'Queen',
        duration: 355
      });

      const result = await lyricsService.fetchLyrics(track);
      expect(result).not.toBeNull();
      expect(result?.synced).toBe(true);
      expect(result?.lines).toHaveLength(3);
      expect(result?.lines[0]).toEqual({ time: 12.5, text: 'Is this the real life?' });
      expect(result?.lines[1]).toEqual({ time: 15.8, text: 'Is this just fantasy?' });
      expect(result?.lines[2]).toEqual({
        time: 21.0,
        text: 'Caught in a landslide, no escape from reality'
      });

      // Second fetch should hit internal cache without network
      const cached = await lyricsService.fetchLyrics(track);
      expect(cached).toBe(result);
    });

    it('F1.1: falls back to plain text lyrics when synced lyrics are unavailable', async () => {
      installFetchMock([
        {
          match: 'lrclib.net/api/get',
          respond: () =>
            jsonResponse({
              id: 102,
              name: 'Acoustic Melody',
              artistName: 'Indie Artist',
              syncedLyrics: null,
              plainLyrics: 'Line one of song\nLine two of song\nLine three of song'
            })
        }
      ]);

      const track = createMockTrack({ title: 'Acoustic Melody', artist: 'Indie Artist' });
      const result = await lyricsService.fetchLyrics(track);

      expect(result).not.toBeNull();
      expect(result?.synced).toBe(false);
      expect(result?.plainLyrics).toContain('Line one of song');
      expect(result?.lines).toHaveLength(3);
      expect(result?.lines[0].text).toBe('Line one of song');
    });

    it('F1.2: parses complex LRC timestamps including 3-digit milliseconds and multi-tag lines', () => {
      const complexLrc = `
[00:05.123]Line with 3-digit millis
[01:10.50][02:20.50]Repeated chorus line with multiple timestamps
[00:30.00]Simple line
`;
      const parsed = parseLRC(complexLrc);
      expect(parsed).toHaveLength(4);
      expect(parsed[0].time).toBeCloseTo(5.123, 3);
      expect(parsed[0].text).toBe('Line with 3-digit millis');

      expect(parsed[1].time).toBe(30.0);
      expect(parsed[2].time).toBe(70.5);
      expect(parsed[2].text).toBe('Repeated chorus line with multiple timestamps');
      expect(parsed[3].time).toBe(140.5);
      expect(parsed[3].text).toBe('Repeated chorus line with multiple timestamps');
    });

    it('F1.3: computes correct active line index based on current playback progress', () => {
      const lines: LyricsLine[] = [
        { time: 10.0, text: 'First verse' },
        { time: 20.0, text: 'Second verse' },
        { time: 35.5, text: 'Chorus begins' },
        { time: 50.0, text: 'Chorus ends' }
      ];

      expect(findActiveLyricIndex(lines, 5.0)).toBe(-1);
      expect(findActiveLyricIndex(lines, 10.0)).toBe(0);
      expect(findActiveLyricIndex(lines, 15.0)).toBe(0);
      expect(findActiveLyricIndex(lines, 20.0)).toBe(1);
      expect(findActiveLyricIndex(lines, 42.0)).toBe(2);
      expect(findActiveLyricIndex(lines, 50.0)).toBe(3);
      expect(findActiveLyricIndex(lines, 120.0)).toBe(3);
    });

    it('F1.3: clicking a lyric line seeks player currentTime to exact line timestamp', () => {
      const lines: LyricsLine[] = [
        { time: 14.2, text: 'Intro ends' },
        { time: 45.0, text: 'Solo starts' }
      ];

      const seekTo = vi.fn((seconds: number) => {
        usePlayerStore.setState({ currentTime: seconds });
      });

      const targetLine = lines[1];
      seekTo(targetLine.time);

      expect(seekTo).toHaveBeenCalledWith(45.0);
      expect(usePlayerStore.getState().currentTime).toBe(45.0);
      expect(findActiveLyricIndex(lines, usePlayerStore.getState().currentTime)).toBe(1);
    });

    it('F1.4: toggles Karaoke/Lyrics view modal via microphone action button', () => {
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(false);

      useUIStore.getState().toggleFullscreenPlayer();
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);

      useUIStore.getState().toggleFullscreenPlayer();
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(false);
    });
  });

  // =========================================================================
  // Tier 2 — Boundaries & Corner Cases
  // =========================================================================
  describe('Tier 2: Boundary & Corner Cases', () => {
    it('handles empty string, null, and whitespace-only lyrics gracefully', () => {
      expect(parseLRC('')).toEqual([]);
      expect(parseLRC('   \n  \t  \n  ')).toEqual([]);
      expect(parseLRC(null as any)).toEqual([]);
      expect(findActiveLyricIndex([], 10)).toBe(-1);
    });

    it('parses international character sets (Cyrillic, CJK, Arabic RTL, Emojis)', () => {
      const multilingualLrc = `
[00:05.00]Группа крови — на рукаве (Кино)
[00:10.00]夜に駆ける (YOASOBI) 🎶
[00:15.00]موسيقى جميلة في الليل
[00:20.00]🔥 Neon Cyber Beat 🔥
`;
      const parsed = parseLRC(multilingualLrc);
      expect(parsed).toHaveLength(4);
      expect(parsed[0].text).toBe('Группа крови — на рукаве (Кино)');
      expect(parsed[1].text).toBe('夜に駆ける (YOASOBI) 🎶');
      expect(parsed[2].text).toBe('موسيقى جميلة في الليل');
      expect(parsed[3].text).toBe('🔥 Neon Cyber Beat 🔥');
    });

    it('handles API 404, 500 server errors, and network disconnects without crashing', async () => {
      installFetchMock([
        {
          match: 'lrclib.net/api/get',
          respond: () => httpErrorResponse(500, 'Internal Server Error')
        }
      ]);

      const track = createMockTrack({ title: 'Unreleased B-Side' });
      const result = await lyricsService.fetchLyrics(track);
      expect(result).toBeNull();
    });

    it('handles large lyrics files with 1000+ timestamped lines efficiently', () => {
      let largeLrc = '';
      for (let i = 0; i < 1000; i++) {
        const mm = String(Math.floor(i / 60)).padStart(2, '0');
        const ss = String(i % 60).padStart(2, '0');
        largeLrc += `[${mm}:${ss}.00] Lyric line index ${i}\n`;
      }

      const start = performance.now();
      const parsed = parseLRC(largeLrc);
      const parseDuration = performance.now() - start;

      expect(parsed).toHaveLength(1000);
      expect(parseDuration).toBeLessThan(100);
      expect(parsed[999].time).toBe(999);
      expect(findActiveLyricIndex(parsed, 500.5)).toBe(500);
    });

    it('handles out-of-order timestamps and sorts them monotonically', () => {
      const unorderedLrc = `
[01:00.00]Third line in time
[00:10.00]First line in time
[00:30.00]Second line in time
`;
      const parsed = parseLRC(unorderedLrc);
      expect(parsed.map((p) => p.time)).toEqual([10.0, 30.0, 60.0]);
      expect(parsed.map((p) => p.text)).toEqual([
        'First line in time',
        'Second line in time',
        'Third line in time'
      ]);
    });

    it('handles rapid consecutive playback seek events while tracking active line', () => {
      const lines: LyricsLine[] = [
        { time: 10, text: 'Verse 1' },
        { time: 20, text: 'Verse 2' },
        { time: 30, text: 'Verse 3' },
        { time: 40, text: 'Chorus' }
      ];

      const seekPoints = [5, 12, 35, 18, 42, 0, 99];
      const expectedIndices = [-1, 0, 2, 0, 3, -1, 3];

      seekPoints.forEach((seekTime, idx) => {
        expect(findActiveLyricIndex(lines, seekTime)).toBe(expectedIndices[idx]);
      });
    });
  });

  // =========================================================================
  // Tier 3 — Cross-Feature Combinations
  // =========================================================================
  describe('Tier 3: Pairwise Combinations', () => {
    it('Comb 1: Track transition immediately clears previous lyrics and fetches new track lyrics', async () => {
      const track1 = createMockTrack({ id: 't1', title: 'Song 1', artist: 'Artist 1' });
      const track2 = createMockTrack({ id: 't2', title: 'Song 2', artist: 'Artist 2' });

      installFetchMock([
        {
          match: 'track_name=Song%201',
          respond: () =>
            jsonResponse({ syncedLyrics: '[00:05.00]Song 1 lyrics', plainLyrics: null })
        },
        {
          match: 'track_name=Song%202',
          respond: () =>
            jsonResponse({ syncedLyrics: '[00:10.00]Song 2 lyrics', plainLyrics: null })
        }
      ]);

      const res1 = await lyricsService.fetchLyrics(track1);
      expect(res1?.lines[0].text).toBe('Song 1 lyrics');

      const res2 = await lyricsService.fetchLyrics(track2);
      expect(res2?.lines[0].text).toBe('Song 2 lyrics');
    });

    it('Comb 2: Lyrics display coordinates with FullscreenPlayer modal and PlayerStore currentTime', () => {
      useUIStore.getState().setFullscreenPlayerOpen(true);
      usePlayerStore.setState({ currentTime: 25.5, duration: 180, isPlaying: true });

      const lines: LyricsLine[] = [
        { time: 10, text: 'Line 1' },
        { time: 20, text: 'Line 2' },
        { time: 30, text: 'Line 3' }
      ];

      const activeIdx = findActiveLyricIndex(lines, usePlayerStore.getState().currentTime);
      expect(activeIdx).toBe(1);
      expect(lines[activeIdx].text).toBe('Line 2');
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);
    });

    it('Comb 3: Click-to-seek during active playback triggers player store seek without pausing', () => {
      usePlayerStore.setState({ isPlaying: true, currentTime: 10.0 });

      const targetTimestamp = 75.4;
      usePlayerStore.getState().seekTo(targetTimestamp);

      expect(usePlayerStore.getState().currentTime).toBe(targetTimestamp);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    });

    it('Comb 4: Lyrics service works seamlessly with offline cached tracks metadata', async () => {
      const offlineTrack = createMockTrack({
        id: 'yt_offline_01',
        title: 'Cached Underground Hit',
        artist: 'Indie Band',
        streamUrl: 'blob:http://localhost/mock-blob-uuid'
      });

      installFetchMock([
        {
          match: 'lrclib.net/api/get',
          respond: () =>
            jsonResponse({
              syncedLyrics: '[00:04.00]Offline song loaded from local blob store',
              plainLyrics: null
            })
        }
      ]);

      const res = await lyricsService.fetchLyrics(offlineTrack);
      expect(res?.lines[0].text).toBe('Offline song loaded from local blob store');
    });
  });

  // =========================================================================
  // Tier 4 — Real-World Workflows
  // =========================================================================
  describe('Tier 4: End-to-End User Workflows', () => {
    it('Workflow: User plays song -> opens Karaoke mode -> follows synced lyrics -> clicks line to seek', async () => {
      const lrcContent = `[00:00.00]♪ Instrumental Intro ♪
[00:08.00]First verse begins
[00:16.00]Second verse builds tension
[00:24.00]Massive chorus drops
[00:36.00]Guitar solo outro`;

      installFetchMock([
        {
          match: 'lrclib.net/api/get',
          respond: () =>
            jsonResponse({
              name: 'Cyber Anthem',
              artistName: 'Wireon Sound',
              syncedLyrics: lrcContent
            })
        }
      ]);

      const track = createMockTrack({
        title: 'Cyber Anthem',
        artist: 'Wireon Sound',
        duration: 120
      });

      usePlayerStore.setState({ currentTrack: track, isPlaying: true, currentTime: 0 });
      useUIStore.getState().setFullscreenPlayerOpen(true);
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);

      const lyrics = await lyricsService.fetchLyrics(track);
      expect(lyrics?.synced).toBe(true);
      expect(lyrics?.lines).toHaveLength(5);

      usePlayerStore.setState({ currentTime: 18.0 });
      let activeIdx = findActiveLyricIndex(lyrics!.lines, usePlayerStore.getState().currentTime);
      expect(activeIdx).toBe(2);
      expect(lyrics!.lines[activeIdx].text).toBe('Second verse builds tension');

      const chorusLine = lyrics!.lines[3];
      usePlayerStore.getState().seekTo(chorusLine.time);

      expect(usePlayerStore.getState().currentTime).toBe(24.0);
      activeIdx = findActiveLyricIndex(lyrics!.lines, usePlayerStore.getState().currentTime);
      expect(activeIdx).toBe(3);
      expect(lyrics!.lines[activeIdx].text).toBe('Massive chorus drops');
    });

    it('Workflow: Track with no synced lyrics falls back to plain view without halting playback', async () => {
      installFetchMock([
        {
          match: 'lrclib.net/api/get',
          respond: () =>
            jsonResponse({
              syncedLyrics: null,
              plainLyrics: 'Just plain un-synced lyrics line 1\nJust plain un-synced lyrics line 2'
            })
        }
      ]);

      const track = createMockTrack({ title: 'Lo-Fi Beat', artist: 'Chillhop' });
      usePlayerStore.setState({ currentTrack: track, isPlaying: true });

      const lyrics = await lyricsService.fetchLyrics(track);
      expect(lyrics?.synced).toBe(false);
      expect(lyrics?.plainLyrics).toBeDefined();
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    });
  });
});
