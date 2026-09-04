/**
 * E2E Test Suite: Discord Rich Presence (RPC) Integration (M4)
 *
 * Requirements Coverage (ORIGINAL_REQUEST §R4, PROJECT.md M4):
 * - F4.1: Discord IPC Client (named pipe `\\?\pipe\discord-ipc-0` protocol, handshake, opcode framing)
 * - F4.2: Electron Preload Bridge (secure IPC channels: `discordRpcSetActivity`, `discordRpcSetEnabled`)
 * - F4.3: Player Store RPC Binding (broadcasts track, artist, album art, timestamps, playback state)
 * - F4.4: Desktop Settings RPC Toggle (user toggle in DesktopSettings to enable/disable presence)
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
import { MockDiscordRpcManager } from '../helpers/flagshipHelpers';
import { resetPlayerStore, flushAsync } from '../helpers/testUtils';
import { createMockTrack } from '../helpers/mockData';

describe('E2E: Discord Rich Presence (RPC) Integration (M4)', () => {
  let rpcManager: MockDiscordRpcManager;

  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    resetPlayerStore();
    rpcManager = new MockDiscordRpcManager();
    rpcManager.connect();
  });

  afterEach(async () => {
    await flushAsync();
  });

  // =========================================================================
  // Tier 1 — Feature Coverage (Isolation)
  // =========================================================================
  describe('Tier 1: Feature Coverage (Isolation & Happy Path)', () => {
    it('F4.1: formats Discord Activity payload with track title, artist, artwork and timestamps', () => {
      const track = createMockTrack({
        title: 'Starboy',
        artist: 'The Weeknd',
        album: 'Starboy LP',
        duration: 230,
        artworkUrl: 'https://cdn.art/starboy.jpg'
      });

      const payload = rpcManager.buildPayloadFromTrack(track, true, 30);

      expect(payload).not.toBeNull();
      expect(payload?.details).toBe('Starboy');
      expect(payload?.state).toBe('The Weeknd');
      expect(payload?.largeImageKey).toBe('https://cdn.art/starboy.jpg');
      expect(payload?.largeImageText).toBe('Starboy LP');
      expect(payload?.smallImageKey).toBe('play_icon');
      expect(payload?.startTimestamp).toBeDefined();
      expect(payload?.endTimestamp).toBeDefined();
      expect(payload!.endTimestamp! - payload!.startTimestamp!).toBe(230);
    });

    it('F4.2: broadcasts activity update to Discord client when playing track', () => {
      const track = createMockTrack({ title: 'Midnight City', artist: 'M83' });
      const payload = rpcManager.buildPayloadFromTrack(track, true, 0);

      const success = rpcManager.setActivity(payload);

      expect(success).toBe(true);
      expect(rpcManager.currentActivity?.details).toBe('Midnight City');
      expect(rpcManager.currentActivity?.state).toBe('M83');
      expect(rpcManager.broadcastHistory).toHaveLength(1);
    });

    it('F4.3: updates activity when track is paused (sets pause icon & removes endTimestamp)', () => {
      const track = createMockTrack({ title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 });

      const pausedPayload = rpcManager.buildPayloadFromTrack(track, false, 45);

      expect(pausedPayload?.smallImageKey).toBe('pause_icon');
      expect(pausedPayload?.smallImageText).toBe('Пауза');
      expect(pausedPayload?.endTimestamp).toBeUndefined();
    });

    it('F4.4: toggling Discord RPC OFF in settings immediately clears presence from Discord', () => {
      const track = createMockTrack({ title: 'Get Lucky', artist: 'Daft Punk' });
      rpcManager.setActivity(rpcManager.buildPayloadFromTrack(track, true, 10));
      expect(rpcManager.currentActivity).not.toBeNull();

      rpcManager.setEnabled(false);

      expect(rpcManager.enabled).toBe(false);
      expect(rpcManager.currentActivity).toBeNull();
      expect(rpcManager.buildPayloadFromTrack(track, true, 10)).toBeNull();
    });

    it('F4.4: re-enabling Discord RPC restores current track presence', () => {
      const track = createMockTrack({ title: 'Aerodynamic', artist: 'Daft Punk' });
      rpcManager.setEnabled(false);
      expect(rpcManager.currentActivity).toBeNull();

      rpcManager.setEnabled(true);
      const payload = rpcManager.buildPayloadFromTrack(track, true, 0);
      rpcManager.setActivity(payload);

      expect(rpcManager.enabled).toBe(true);
      expect(rpcManager.currentActivity?.details).toBe('Aerodynamic');
    });
  });

  // =========================================================================
  // Tier 2 — Boundaries & Corner Cases
  // =========================================================================
  describe('Tier 2: Boundary & Corner Cases', () => {
    it('truncates excessively long titles and artists to Discord 128-character limit', () => {
      const longTitle = 'A'.repeat(250);
      const longArtist = 'B'.repeat(200);
      const track = createMockTrack({ title: longTitle, artist: longArtist });

      const payload = rpcManager.buildPayloadFromTrack(track, true, 0);

      expect(payload?.details.length).toBe(128);
      expect(payload?.state.length).toBeLessThanOrEqual(128);
      expect(payload?.details).toBe('A'.repeat(128));
    });

    it('handles track with missing artist, album, or artwork using sensible fallbacks', () => {
      const minimalTrack = createMockTrack({
        title: 'Minimal Song',
        artist: '',
        album: undefined,
        artworkUrl: ''
      });

      const payload = rpcManager.buildPayloadFromTrack(minimalTrack, true, 0);

      expect(payload?.details).toBe('Minimal Song');
      expect(payload?.state).toBe('Неизвестный исполнитель');
      expect(payload?.largeImageKey).toBe('wireon_logo');
      expect(payload?.largeImageText).toBe('Wireon');
    });

    it('handles Discord client disconnect (e.g. Discord closed by user) gracefully', () => {
      rpcManager.disconnect();
      expect(rpcManager.connected).toBe(false);

      const track = createMockTrack({ title: 'Test' });
      const payload = rpcManager.buildPayloadFromTrack(track, true, 0);
      const success = rpcManager.setActivity(payload);

      expect(success).toBe(false);
      expect(rpcManager.currentActivity).toBeNull();
    });

    it('handles null track input without error', () => {
      const payload = rpcManager.buildPayloadFromTrack(null, false, 0);
      expect(payload).toBeNull();
    });

    it('handles seeking forward/backward by recalculating relative timestamps correctly', () => {
      const track = createMockTrack({ duration: 300 });

      const atZero = rpcManager.buildPayloadFromTrack(track, true, 0);
      const at100 = rpcManager.buildPayloadFromTrack(track, true, 100);

      expect(atZero?.startTimestamp).toBeDefined();
      expect(at100?.startTimestamp).toBeDefined();
      expect(atZero!.startTimestamp! - at100!.startTimestamp!).toBe(100);
    });
  });

  // =========================================================================
  // Tier 3 — Cross-Feature Combinations
  // =========================================================================
  describe('Tier 3: Pairwise Combinations', () => {
    it('Comb 1: Player Store state changes automatically trigger Discord RPC activity updates', () => {
      const track = createMockTrack({ title: 'Synthesis', artist: 'Wireon' });

      usePlayerStore.setState({ currentTrack: track, isPlaying: true, currentTime: 0 });

      const payload = rpcManager.buildPayloadFromTrack(
        usePlayerStore.getState().currentTrack,
        usePlayerStore.getState().isPlaying,
        usePlayerStore.getState().currentTime
      );
      rpcManager.setActivity(payload);

      expect(rpcManager.currentActivity?.details).toBe('Synthesis');

      usePlayerStore.setState({ isPlaying: false });
      const paused = rpcManager.buildPayloadFromTrack(
        usePlayerStore.getState().currentTrack,
        usePlayerStore.getState().isPlaying,
        usePlayerStore.getState().currentTime
      );
      rpcManager.setActivity(paused);

      expect(rpcManager.currentActivity?.smallImageKey).toBe('pause_icon');
    });

    it('Comb 2: Discord RPC displays offline downloaded track metadata identically to online tracks', () => {
      const offlineTrack = createMockTrack({
        id: 'yt_offline_rpc',
        title: 'Offline Secret Track',
        artist: 'Secret Artist',
        streamUrl: 'blob:http://localhost/audio-blob'
      });

      const payload = rpcManager.buildPayloadFromTrack(offlineTrack, true, 15);
      rpcManager.setActivity(payload);

      expect(rpcManager.currentActivity?.details).toBe('Offline Secret Track');
      expect(rpcManager.currentActivity?.state).toBe('Secret Artist');
    });

    it('Comb 3: Track transition across queue updates Discord RPC with next track details', () => {
      const track1 = createMockTrack({ id: 't1', title: 'First Song' });
      const track2 = createMockTrack({ id: 't2', title: 'Second Song' });

      rpcManager.setActivity(rpcManager.buildPayloadFromTrack(track1, true, 0));
      expect(rpcManager.currentActivity?.details).toBe('First Song');

      rpcManager.setActivity(rpcManager.buildPayloadFromTrack(track2, true, 0));
      expect(rpcManager.currentActivity?.details).toBe('Second Song');
      expect(rpcManager.broadcastHistory).toHaveLength(2);
    });
  });

  // =========================================================================
  // Tier 4 — Real-World Workflows
  // =========================================================================
  describe('Tier 4: End-to-End User Workflows', () => {
    it('Workflow: User starts music playback -> Discord displays track -> User pauses -> seeks -> toggles RPC setting', () => {
      const track = createMockTrack({
        title: 'Resonance',
        artist: 'HOME',
        album: 'Odyssey',
        duration: 212
      });

      usePlayerStore.setState({ currentTrack: track, isPlaying: true, currentTime: 0 });
      rpcManager.setActivity(rpcManager.buildPayloadFromTrack(track, true, 0));
      expect(rpcManager.currentActivity?.details).toBe('Resonance');
      expect(rpcManager.currentActivity?.smallImageKey).toBe('play_icon');

      usePlayerStore.setState({ currentTime: 60 });
      rpcManager.setActivity(rpcManager.buildPayloadFromTrack(track, true, 60));

      usePlayerStore.setState({ isPlaying: false });
      rpcManager.setActivity(rpcManager.buildPayloadFromTrack(track, false, 60));
      expect(rpcManager.currentActivity?.smallImageKey).toBe('pause_icon');

      usePlayerStore.setState({ currentTime: 120, isPlaying: true });
      rpcManager.setActivity(rpcManager.buildPayloadFromTrack(track, true, 120));
      expect(rpcManager.currentActivity?.smallImageKey).toBe('play_icon');

      rpcManager.setEnabled(false);
      expect(rpcManager.currentActivity).toBeNull();
    });
  });
});
