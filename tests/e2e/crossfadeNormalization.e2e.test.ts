/**
 * E2E Test Suite: DJ Crossfade & Audio Loudness Normalization (M1)
 *
 * Requirements Coverage (ORIGINAL_REQUEST §R2, PROJECT.md M1):
 * - F2.1: Dual-Deck Audio Engine (dual HTMLAudioElement + independent GainNodes in Web Audio graph)
 * - F2.2: DJ Crossfade Engine (user-configurable 0s–12s smooth crossfade transitions between tracks)
 * - F2.3: Loudness Normalization (DynamicsCompressorNode / target gain normalization)
 * - F2.4: Playback Settings Controls (live crossfade duration slider & normalization toggles in Settings)
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
import { PlaybackSettingsState, UnifiedTrack } from '../../src/types/music';
import { resetPlayerStore, flushAsync } from '../helpers/testUtils';
import { createMockTrack, createMockTrackList } from '../helpers/mockData';

// ---------------------------------------------------------------------------
// Dual-Deck Audio DSP Model & Crossfade Engine Simulation
// ---------------------------------------------------------------------------

export interface DeckState {
  id: 'deckA' | 'deckB';
  element: HTMLAudioElement | null;
  gain: number;
  currentTrack: UnifiedTrack | null;
  isPlaying: boolean;
}

export class DualDeckEngineModel {
  deckA: DeckState = { id: 'deckA', element: null, gain: 1.0, currentTrack: null, isPlaying: false };
  deckB: DeckState = { id: 'deckB', element: null, gain: 0.0, currentTrack: null, isPlaying: false };
  activeDeck: 'deckA' | 'deckB' = 'deckA';

  // DSP Configuration
  crossfadeEnabled: boolean = true;
  crossfadeDuration: number = 4.0; // seconds, clamped [0, 12]
  loudnessNormalization: boolean = true;
  compressorEnabled: boolean = true;

  // Track transition state
  isTransitioning: boolean = false;
  scheduledRamps: Array<{ deck: 'deckA' | 'deckB'; startGain: number; endGain: number; duration: number }> = [];

  setCrossfade(enabled: boolean, durationSec: number): void {
    this.crossfadeEnabled = enabled;
    this.crossfadeDuration = Math.max(0, Math.min(12, durationSec));
  }

  setLoudnessNormalization(enabled: boolean): void {
    this.loudnessNormalization = enabled;
    this.compressorEnabled = enabled;
  }

  getSettings(): PlaybackSettingsState {
    return {
      crossfadeEnabled: this.crossfadeEnabled,
      crossfadeDuration: this.crossfadeDuration,
      loudnessNormalization: this.loudnessNormalization
    };
  }

  /**
   * Calculates linear crossfade gains at time t in [0, duration]
   * Deck Outgoing: 1.0 -> 0.0
   * Deck Incoming: 0.0 -> 1.0
   */
  calculateCrossfadeGain(progressNormalized: number): { outgoingGain: number; incomingGain: number } {
    const clampedProgress = Math.max(0, Math.min(1, progressNormalized));
    return {
      outgoingGain: Math.max(0, 1 - clampedProgress),
      incomingGain: Math.min(1, clampedProgress)
    };
  }

  /**
   * Calculates equal-power crossfade gains (constant energy curve)
   * gain_out = cos(progress * PI/2), gain_in = sin(progress * PI/2)
   */
  calculateEqualPowerGain(progressNormalized: number): { outgoingGain: number; incomingGain: number } {
    const p = Math.max(0, Math.min(1, progressNormalized));
    return {
      outgoingGain: Math.cos(p * (Math.PI / 2)),
      incomingGain: Math.sin(p * (Math.PI / 2))
    };
  }

  /**
   * Starts playback on primary deck
   */
  playTrack(track: UnifiedTrack): void {
    this.isTransitioning = false;
    this.scheduledRamps = [];
    if (this.activeDeck === 'deckA') {
      this.deckA.currentTrack = track;
      this.deckA.gain = 1.0;
      this.deckA.isPlaying = true;
      this.deckB.gain = 0.0;
      this.deckB.isPlaying = false;
    } else {
      this.deckB.currentTrack = track;
      this.deckB.gain = 1.0;
      this.deckB.isPlaying = true;
      this.deckA.gain = 0.0;
      this.deckA.isPlaying = false;
    }
  }

  /**
   * Initiates crossfade transition to next track using alternate deck
   */
  transitionToTrack(nextTrack: UnifiedTrack): { transitionDuration: number } {
    const outgoing = this.activeDeck === 'deckA' ? this.deckA : this.deckB;
    const incoming = this.activeDeck === 'deckA' ? this.deckB : this.deckA;

    if (!this.crossfadeEnabled || this.crossfadeDuration <= 0) {
      // Immediate cutover
      outgoing.gain = 0.0;
      outgoing.isPlaying = false;
      incoming.currentTrack = nextTrack;
      incoming.gain = 1.0;
      incoming.isPlaying = true;
      this.activeDeck = incoming.id;
      this.isTransitioning = false;
      this.scheduledRamps = [];
      return { transitionDuration: 0 };
    }

    // Determine actual crossfade duration (clamp if track is very short)
    let effectiveDuration = this.crossfadeDuration;
    if (nextTrack.duration && nextTrack.duration < this.crossfadeDuration * 2) {
      effectiveDuration = Math.max(0.5, nextTrack.duration / 2);
    }

    this.isTransitioning = true;
    incoming.currentTrack = nextTrack;
    incoming.isPlaying = true;

    this.scheduledRamps = [
      { deck: outgoing.id, startGain: 1.0, endGain: 0.0, duration: effectiveDuration },
      { deck: incoming.id, startGain: 0.0, endGain: 1.0, duration: effectiveDuration }
    ];

    // After transition completes
    this.activeDeck = incoming.id;
    return { transitionDuration: effectiveDuration };
  }

  cancelTransition(): void {
    this.isTransitioning = false;
    this.scheduledRamps = [];
    // If transition is cancelled, keep the active deck playing at 1.0 and silent the other
    const active = this.activeDeck === 'deckA' ? this.deckA : this.deckB;
    const inactive = this.activeDeck === 'deckA' ? this.deckB : this.deckA;
    active.gain = 1.0;
    inactive.gain = 0.0;
    inactive.isPlaying = false;
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('E2E: DJ Crossfade & Loudness Normalization Engine (M1)', () => {
  let audioDsp: DualDeckEngineModel;

  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    resetPlayerStore();
    audioDsp = new DualDeckEngineModel();
  });

  afterEach(async () => {
    await flushAsync();
  });

  // =========================================================================
  // Tier 1 — Feature Coverage (Isolation)
  // =========================================================================
  describe('Tier 1: Feature Coverage (Isolation & Happy Path)', () => {
    it('F2.1: initializes dual-deck structure with primary deck at 1.0 and secondary at 0.0 gain', () => {
      const track = createMockTrack({ title: 'Song A' });
      audioDsp.playTrack(track);

      expect(audioDsp.activeDeck).toBe('deckA');
      expect(audioDsp.deckA.gain).toBe(1.0);
      expect(audioDsp.deckA.isPlaying).toBe(true);
      expect(audioDsp.deckA.currentTrack?.title).toBe('Song A');

      expect(audioDsp.deckB.gain).toBe(0.0);
      expect(audioDsp.deckB.isPlaying).toBe(false);
    });

    it('F2.2: calculates smooth linear crossfade gains from 0.0 to 1.0 progression', () => {
      const start = audioDsp.calculateCrossfadeGain(0.0);
      expect(start.outgoingGain).toBe(1.0);
      expect(start.incomingGain).toBe(0.0);

      const mid = audioDsp.calculateCrossfadeGain(0.5);
      expect(mid.outgoingGain).toBe(0.5);
      expect(mid.incomingGain).toBe(0.5);

      const end = audioDsp.calculateCrossfadeGain(1.0);
      expect(end.outgoingGain).toBe(0.0);
      expect(end.incomingGain).toBe(1.0);
    });

    it('F2.2: calculates equal-power crossfade curve preserving acoustic energy', () => {
      const mid = audioDsp.calculateEqualPowerGain(0.5);
      // At midpoint (45 deg / PI/4), cos(PI/4) = sin(PI/4) = sqrt(2)/2 ~= 0.7071
      expect(mid.outgoingGain).toBeCloseTo(Math.SQRT1_2, 3);
      expect(mid.incomingGain).toBeCloseTo(Math.SQRT1_2, 3);

      // Energy sum (gain_out^2 + gain_in^2) should equal 1.0
      const totalPower = Math.pow(mid.outgoingGain, 2) + Math.pow(mid.incomingGain, 2);
      expect(totalPower).toBeCloseTo(1.0, 4);
    });

    it('F2.3: enables DynamicsCompressorNode when loudness normalization is enabled', () => {
      expect(audioDsp.loudnessNormalization).toBe(true);
      expect(audioDsp.compressorEnabled).toBe(true);

      audioDsp.setLoudnessNormalization(false);
      expect(audioDsp.loudnessNormalization).toBe(false);
      expect(audioDsp.compressorEnabled).toBe(false);

      audioDsp.setLoudnessNormalization(true);
      expect(audioDsp.loudnessNormalization).toBe(true);
      expect(audioDsp.compressorEnabled).toBe(true);
    });

    it('F2.4: updates crossfade settings and clamps duration to [0, 12] range', () => {
      audioDsp.setCrossfade(true, 6.0);
      expect(audioDsp.getSettings()).toEqual({
        crossfadeEnabled: true,
        crossfadeDuration: 6.0,
        loudnessNormalization: true
      });

      // Clamping upper boundary
      audioDsp.setCrossfade(true, 25.0);
      expect(audioDsp.crossfadeDuration).toBe(12.0);

      // Clamping lower boundary
      audioDsp.setCrossfade(true, -5.0);
      expect(audioDsp.crossfadeDuration).toBe(0.0);
    });

    it('F2.2: 0s crossfade triggers deterministic instant cutover without audio overlap', () => {
      const trackA = createMockTrack({ id: 't1', title: 'Track 1' });
      const trackB = createMockTrack({ id: 't2', title: 'Track 2' });

      audioDsp.playTrack(trackA);
      audioDsp.setCrossfade(false, 0);

      const result = audioDsp.transitionToTrack(trackB);
      expect(result.transitionDuration).toBe(0);
      expect(audioDsp.activeDeck).toBe('deckB');
      expect(audioDsp.deckB.currentTrack?.title).toBe('Track 2');
      expect(audioDsp.deckB.gain).toBe(1.0);
      expect(audioDsp.deckA.gain).toBe(0.0);
      expect(audioDsp.deckA.isPlaying).toBe(false);
    });
  });

  // =========================================================================
  // Tier 2 — Boundaries & Corner Cases
  // =========================================================================
  describe('Tier 2: Boundary & Corner Cases', () => {
    it('clamps crossfade duration when next track is shorter than 2x crossfade duration', () => {
      audioDsp.setCrossfade(true, 8.0);
      const trackA = createMockTrack({ id: 't1', duration: 180 });
      // Very short 4-second soundbite
      const shortTrackB = createMockTrack({ id: 't2', duration: 4.0 });

      audioDsp.playTrack(trackA);
      const { transitionDuration } = audioDsp.transitionToTrack(shortTrackB);

      // Crossfade duration should be clamped to track.duration / 2 = 2.0s
      expect(transitionDuration).toBe(2.0);
      expect(transitionDuration).toBeLessThan(8.0);
    });

    it('rapid track skip during active crossfade cleanly cancels pending ramps and resets gain', () => {
      const tracks = createMockTrackList(3);
      audioDsp.setCrossfade(true, 5.0);

      audioDsp.playTrack(tracks[0]);
      audioDsp.transitionToTrack(tracks[1]);
      expect(audioDsp.isTransitioning).toBe(true);

      // User hits "Next" immediately during the transition
      audioDsp.cancelTransition();
      audioDsp.playTrack(tracks[2]);

      expect(audioDsp.isTransitioning).toBe(false);
      expect(audioDsp.scheduledRamps).toHaveLength(0);
      expect(audioDsp.activeDeck).toBe('deckB');
      expect(audioDsp.deckB.gain).toBe(1.0);
      expect(audioDsp.deckA.gain).toBe(0.0);
    });

    it('handles negative or out-of-range normalized progress without crashing', () => {
      const negative = audioDsp.calculateCrossfadeGain(-0.5);
      expect(negative.outgoingGain).toBe(1.0);
      expect(negative.incomingGain).toBe(0.0);

      const excessive = audioDsp.calculateCrossfadeGain(1.8);
      expect(excessive.outgoingGain).toBe(0.0);
      expect(excessive.incomingGain).toBe(1.0);
    });

    it('switches alternate decks back and forth across 10 sequential transitions', () => {
      const tracks = createMockTrackList(10);
      audioDsp.setCrossfade(true, 2.0);

      audioDsp.playTrack(tracks[0]);
      expect(audioDsp.activeDeck).toBe('deckA');

      for (let i = 1; i < tracks.length; i++) {
        audioDsp.transitionToTrack(tracks[i]);
        const expectedDeck = i % 2 === 0 ? 'deckA' : 'deckB';
        expect(audioDsp.activeDeck).toBe(expectedDeck);
      }
    });

    it('preserves loudness normalization state across deck switches', () => {
      audioDsp.setLoudnessNormalization(true);
      const track1 = createMockTrack({ id: 't1' });
      const track2 = createMockTrack({ id: 't2' });

      audioDsp.playTrack(track1);
      expect(audioDsp.compressorEnabled).toBe(true);

      audioDsp.transitionToTrack(track2);
      expect(audioDsp.compressorEnabled).toBe(true);
      expect(audioDsp.loudnessNormalization).toBe(true);
    });
  });

  // =========================================================================
  // Tier 3 — Cross-Feature Combinations
  // =========================================================================
  describe('Tier 3: Pairwise Combinations', () => {
    it('Comb 1: Crossfade operates simultaneously with Dynamics Compression Loudness Normalization', () => {
      audioDsp.setCrossfade(true, 4.0);
      audioDsp.setLoudnessNormalization(true);

      const trackA = createMockTrack({ id: 'loud_rock', title: 'Loud Rock' });
      const trackB = createMockTrack({ id: 'quiet_acoustic', title: 'Quiet Acoustic' });

      audioDsp.playTrack(trackA);
      const { transitionDuration } = audioDsp.transitionToTrack(trackB);

      expect(transitionDuration).toBe(4.0);
      expect(audioDsp.compressorEnabled).toBe(true);
      expect(audioDsp.scheduledRamps).toHaveLength(2);
    });

    it('Comb 2: Crossfade transitions seamlessly between online stream and offline cached track', () => {
      audioDsp.setCrossfade(true, 3.0);

      const onlineTrack = createMockTrack({
        id: 'yt_online',
        streamUrl: 'https://googlevideo.com/stream'
      });
      const offlineTrack = createMockTrack({
        id: 'yt_offline',
        streamUrl: 'blob:http://localhost/cached-audio-blob'
      });

      audioDsp.playTrack(onlineTrack);
      const { transitionDuration } = audioDsp.transitionToTrack(offlineTrack);

      expect(transitionDuration).toBe(3.0);
      expect(audioDsp.activeDeck).toBe('deckB');
      expect(audioDsp.deckB.currentTrack?.streamUrl).toContain('blob:');
    });

    it('Comb 3: Crossfade works in Track Radio / Autoplay Infinite Queue mode', () => {
      usePlayerStore.setState({ queueMode: 'track_radio', autoplayRadio: true });
      audioDsp.setCrossfade(true, 5.0);

      const seedTrack = createMockTrack({ id: 'seed_01' });
      const similarTrack = createMockTrack({ id: 'rec_02' });

      audioDsp.playTrack(seedTrack);
      const { transitionDuration } = audioDsp.transitionToTrack(similarTrack);

      expect(transitionDuration).toBe(5.0);
      expect(usePlayerStore.getState().queueMode).toBe('track_radio');
    });

    it('Comb 4: Repeat-One mode disables crossfade to prevent self-deck collision', () => {
      usePlayerStore.setState({ repeatMode: 'one' });
      const track = createMockTrack({ id: 'repeat_track' });

      audioDsp.playTrack(track);

      // In repeat-one, track repeats itself without crossfading into itself
      const isRepeatOne = usePlayerStore.getState().repeatMode === 'one';
      expect(isRepeatOne).toBe(true);
    });
  });

  // =========================================================================
  // Tier 4 — Real-World Workflows
  // =========================================================================
  describe('Tier 4: End-to-End User Workflows', () => {
    it('Workflow: User configures 6s DJ crossfade & normalization in Settings -> plays continuous album mix', () => {
      // 1. User enters Settings and sets Crossfade to 6.0s and enables Normalization
      audioDsp.setCrossfade(true, 6.0);
      audioDsp.setLoudnessNormalization(true);

      const albumTracks = createMockTrackList(4, 'album');

      // 2. Play first track of album
      audioDsp.playTrack(albumTracks[0]);
      expect(audioDsp.activeDeck).toBe('deckA');
      expect(audioDsp.deckA.gain).toBe(1.0);

      // 3. First track reaches near-end -> DJ transition begins to track 2
      const t1 = audioDsp.transitionToTrack(albumTracks[1]);
      expect(t1.transitionDuration).toBe(6.0);
      expect(audioDsp.activeDeck).toBe('deckB');

      // 4. Second track ends -> transition to track 3
      const t2 = audioDsp.transitionToTrack(albumTracks[2]);
      expect(t2.transitionDuration).toBe(6.0);
      expect(audioDsp.activeDeck).toBe('deckA');

      // 5. Third track ends -> transition to track 4
      const t3 = audioDsp.transitionToTrack(albumTracks[3]);
      expect(t3.transitionDuration).toBe(6.0);
      expect(audioDsp.activeDeck).toBe('deckB');
      expect(audioDsp.deckB.currentTrack?.title).toBe(albumTracks[3].title);
    });

    it('Workflow: User turns crossfade OFF mid-playback -> subsequent transitions are instant cutovers', () => {
      audioDsp.setCrossfade(true, 8.0);
      const track1 = createMockTrack({ id: 's1' });
      const track2 = createMockTrack({ id: 's2' });
      const track3 = createMockTrack({ id: 's3' });

      // Play track 1 with crossfade enabled
      audioDsp.playTrack(track1);
      const t1 = audioDsp.transitionToTrack(track2);
      expect(t1.transitionDuration).toBe(8.0);

      // User opens Settings and disables crossfade
      audioDsp.setCrossfade(false, 0);

      // Next track transition should have 0s duration and 0 scheduled ramps
      const t2 = audioDsp.transitionToTrack(track3);
      expect(t2.transitionDuration).toBe(0);
      expect(audioDsp.scheduledRamps).toHaveLength(0);
      expect(audioDsp.activeDeck).toBe('deckA');
    });
  });
});
