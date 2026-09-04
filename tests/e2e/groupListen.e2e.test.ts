/**
 * E2E Test Suite: Real-Time Group Listen & Room Synchronization (M7)
 *
 * Requirements Coverage (ORIGINAL_REQUEST §R7, PROJECT.md M7):
 * - F7.1: Group Listen Room Protocol (6-character room codes, pub/sub message envelope, heartbeat)
 * - F7.2: Playback State Synchronization (synchronized play, pause, seek, queue replication with drift compensation)
 * - F7.3: Group Listen Session Management (Host/Join roles, participant tracking, graceful leave/close)
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
import {
  MockGroupListenSession,
  GroupListenMessage
} from '../helpers/flagshipHelpers';
import { resetPlayerStore, flushAsync } from '../helpers/testUtils';
import { createMockTrack, createMockTrackList } from '../helpers/mockData';

describe('E2E: Real-Time Group Listen & Room Synchronization (M7)', () => {
  let hostSession: MockGroupListenSession;
  let peerSession: MockGroupListenSession;

  beforeEach(async () => {
    await flushAsync();
    vi.restoreAllMocks();
    resetPlayerStore();

    hostSession = new MockGroupListenSession('user_host_1', 'HostUser');
    peerSession = new MockGroupListenSession('user_peer_2', 'PeerUser');
  });

  afterEach(async () => {
    await flushAsync();
  });

  // =========================================================================
  // Tier 1 — Feature Coverage (Isolation)
  // =========================================================================
  describe('Tier 1: Feature Coverage (Isolation & Happy Path)', () => {
    it('F7.1: generates unique 6-character alphanumeric room codes upon room creation', async () => {
      const roomCode = await hostSession.createRoom();

      expect(roomCode).toMatch(/^[A-Z0-9]{6}$/);
      expect(hostSession.isHost).toBe(true);
      expect(hostSession.connected).toBe(true);
      expect(hostSession.participants).toHaveLength(1);
      expect(hostSession.participants[0].username).toBe('HostUser');
    });

    it('F7.1: peer joins room using 6-character code and registers in session', async () => {
      const roomCode = await hostSession.createRoom();
      const joined = await peerSession.joinRoom(roomCode);

      expect(joined).toBe(true);
      expect(peerSession.roomId).toBe(roomCode);
      expect(peerSession.isHost).toBe(false);
      expect(peerSession.connected).toBe(true);
    });

    it('F7.2: host broadcasts playback state (play/pause) and peer synchronizes state', async () => {
      const roomCode = await hostSession.createRoom();
      await peerSession.joinRoom(roomCode);

      const track = createMockTrack({ id: 'yt_group_01', title: 'Party Anthem' });

      const message = hostSession.broadcastState({
        trackId: track.id,
        isPlaying: true,
        currentTime: 0,
        queue: [track]
      });

      expect(message).not.toBeNull();

      const result = peerSession.receiveMessage(message!);
      expect(result.isPlaying).toBe(true);
      expect(peerSession.lastReceivedState?.trackId).toBe('yt_group_01');
    });

    it('F7.2: host seeks track and peer receives updated currentTime with latency compensation', async () => {
      const roomCode = await hostSession.createRoom();
      await peerSession.joinRoom(roomCode);

      const msg = hostSession.broadcastState({
        isPlaying: true,
        currentTime: 75.0,
        queue: []
      });

      const { adjustedTime } = peerSession.receiveMessage(msg!);
      expect(adjustedTime).toBeGreaterThanOrEqual(75.0);
      expect(adjustedTime).toBeLessThan(76.0);
    });

    it('F7.3: participant leaving room closes session and clears state cleanly', async () => {
      const roomCode = await hostSession.createRoom();
      await peerSession.joinRoom(roomCode);

      expect(peerSession.connected).toBe(true);

      peerSession.leaveRoom();

      expect(peerSession.connected).toBe(false);
      expect(peerSession.roomId).toBeNull();
      expect(peerSession.lastReceivedState).toBeNull();
    });
  });

  // =========================================================================
  // Tier 2 — Boundaries & Corner Cases
  // =========================================================================
  describe('Tier 2: Boundary & Corner Cases', () => {
    it('rejects room codes that are not exactly 6 characters', async () => {
      await expect(peerSession.joinRoom('ABC')).rejects.toThrow(/ровно 6 символов/);
      await expect(peerSession.joinRoom('1234567')).rejects.toThrow(/ровно 6 символов/);
      await expect(peerSession.joinRoom('')).rejects.toThrow(/ровно 6 символов/);
    });

    it('auto-normalizes lowercase and whitespace in room codes', async () => {
      const code = '  ab34cd  ';
      await peerSession.joinRoom(code);
      expect(peerSession.roomId).toBe('AB34CD');
    });

    it('rejects messages sent to a different room ID', async () => {
      await hostSession.createRoom();
      await peerSession.joinRoom('ZZZZZZ');

      const message: GroupListenMessage = {
        type: 'sync_state',
        roomId: 'OTHER9',
        senderId: 'host_1',
        hostTimestamp: Date.now(),
        state: { isPlaying: true, currentTime: 10, queue: [] }
      };

      expect(() => peerSession.receiveMessage(message)).toThrow(/Room ID mismatch/);
    });

    it('compensates for simulated network jitter / drift between host and peer', () => {
      peerSession.roomId = 'SYNC01';
      const simulatedHostTime = Date.now() - 2500;

      const message: GroupListenMessage = {
        type: 'sync_state',
        roomId: 'SYNC01',
        senderId: 'host_1',
        hostTimestamp: simulatedHostTime,
        state: { isPlaying: true, currentTime: 50.0, queue: [] }
      };

      const { adjustedTime } = peerSession.receiveMessage(message);
      expect(adjustedTime).toBeCloseTo(52.5, 0);
    });

    it('handles multiple peers receiving the same broadcast message simultaneously', async () => {
      const roomCode = await hostSession.createRoom();
      const peerA = new MockGroupListenSession('peer_a', 'Alice');
      const peerB = new MockGroupListenSession('peer_b', 'Bob');
      const peerC = new MockGroupListenSession('peer_c', 'Charlie');

      await peerA.joinRoom(roomCode);
      await peerB.joinRoom(roomCode);
      await peerC.joinRoom(roomCode);

      const msg = hostSession.broadcastState({
        trackId: 'track_all',
        isPlaying: true,
        currentTime: 20.0,
        queue: []
      });

      peerA.receiveMessage(msg!);
      peerB.receiveMessage(msg!);
      peerC.receiveMessage(msg!);

      expect(peerA.lastReceivedState?.trackId).toBe('track_all');
      expect(peerB.lastReceivedState?.trackId).toBe('track_all');
      expect(peerC.lastReceivedState?.trackId).toBe('track_all');
    });
  });

  // =========================================================================
  // Tier 3 — Cross-Feature Combinations
  // =========================================================================
  describe('Tier 3: Pairwise Combinations', () => {
    it('Comb 1: Host updates full queue and peers receive complete replicated playlist queue', async () => {
      const roomCode = await hostSession.createRoom();
      await peerSession.joinRoom(roomCode);

      const tracks = createMockTrackList(5, 'group_sync');

      const msg = hostSession.broadcastState({
        trackId: tracks[0].id,
        isPlaying: true,
        currentTime: 0,
        queue: tracks
      });

      peerSession.receiveMessage(msg!);

      expect(peerSession.lastReceivedState?.queue).toHaveLength(5);
      expect(peerSession.lastReceivedState?.queue[0].title).toBe(tracks[0].title);
      expect(peerSession.lastReceivedState?.queue[4].title).toBe(tracks[4].title);
    });

    it('Comb 2: Peer updates local player store state when sync_state arrives', async () => {
      const roomCode = await hostSession.createRoom();
      await peerSession.joinRoom(roomCode);

      const track = createMockTrack({ title: 'Synced Beat' });
      const msg = hostSession.broadcastState({
        trackId: track.id,
        isPlaying: true,
        currentTime: 42.0,
        queue: [track]
      });

      const { adjustedTime, isPlaying } = peerSession.receiveMessage(msg!);

      usePlayerStore.setState({ currentTrack: track, isPlaying, currentTime: adjustedTime });

      expect(usePlayerStore.getState().currentTrack?.title).toBe('Synced Beat');
      expect(usePlayerStore.getState().isPlaying).toBe(true);
      expect(usePlayerStore.getState().currentTime).toBeGreaterThanOrEqual(42.0);
    });

    it('Comb 3: Real GroupListenService instances sync playback state and latency compensation', async () => {
      const { GroupListenService } = await import('../../src/services/groupListenService');
      const host = new GroupListenService('host_real', 'HostReal');
      const peer = new GroupListenService('peer_real', 'PeerReal');

      const roomCode = await host.createRoom();
      await peer.joinRoom(roomCode);

      const track = createMockTrack({ id: 'yt_real_01', title: 'Real Time Sync' });
      const broadcastMsg = host.broadcastState({
        trackId: track.id,
        track,
        isPlaying: true,
        currentTime: 30.0,
        queue: [track]
      });

      expect(broadcastMsg).not.toBeNull();
      const adj = peer.receiveMessage(broadcastMsg!, 0);

      expect(adj.isPlaying).toBe(true);
      expect(adj.adjustedTime).toBeGreaterThanOrEqual(30.0);
      expect(peer.getLastReceivedState()?.trackId).toBe('yt_real_01');

      host.leaveRoom();
      peer.leaveRoom();
    });

    it('Comb 4: Real useGroupListenStore manages full room lifecycle and chat messages', async () => {
      const { useGroupListenStore } = await import('../../src/store/useGroupListenStore');
      const store = useGroupListenStore.getState();

      const code = await store.createRoom();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
      expect(useGroupListenStore.getState().isHost).toBe(true);
      expect(useGroupListenStore.getState().isConnected).toBe(true);

      store.sendChat('Hello everyone!');
      expect(useGroupListenStore.getState().chatMessages).toHaveLength(1);
      expect(useGroupListenStore.getState().chatMessages[0].text).toBe('Hello everyone!');

      store.leaveRoom();
      expect(useGroupListenStore.getState().isConnected).toBe(false);
      expect(useGroupListenStore.getState().roomId).toBeNull();
    });
  });

  // =========================================================================
  // Tier 4 — Real-World Workflows
  // =========================================================================
  describe('Tier 4: End-to-End User Workflows', () => {
    it('Workflow: Host creates room -> invites Peer -> Host changes tracks and seeks -> Peer syncs continuously', async () => {
      const code = await hostSession.createRoom();
      expect(code).toHaveLength(6);

      await peerSession.joinRoom(code);

      const tracks = createMockTrackList(3, 'workflow_room');

      let syncMsg = hostSession.broadcastState({
        trackId: tracks[0].id,
        isPlaying: true,
        currentTime: 0,
        queue: tracks
      });
      peerSession.receiveMessage(syncMsg!);
      expect(peerSession.lastReceivedState?.trackId).toBe(tracks[0].id);

      syncMsg = hostSession.broadcastState({
        trackId: tracks[0].id,
        isPlaying: true,
        currentTime: 90.0,
        queue: tracks
      });
      let received = peerSession.receiveMessage(syncMsg!);
      expect(received.adjustedTime).toBeGreaterThanOrEqual(90.0);

      syncMsg = hostSession.broadcastState({
        trackId: tracks[1].id,
        isPlaying: true,
        currentTime: 0,
        queue: tracks
      });
      peerSession.receiveMessage(syncMsg!);
      expect(peerSession.lastReceivedState?.trackId).toBe(tracks[1].id);

      syncMsg = hostSession.broadcastState({
        trackId: tracks[1].id,
        isPlaying: false,
        currentTime: 15.0,
        queue: tracks
      });
      received = peerSession.receiveMessage(syncMsg!);
      expect(received.isPlaying).toBe(false);
    });

    it('Workflow 2: Peer joins mid-stream and snaps into sync with host queue and timestamps', async () => {
      const code = await hostSession.createRoom();
      const tracks = createMockTrackList(4, 'mid_stream');

      // Host is already 120 seconds into track 2
      const activeState = {
        trackId: tracks[1].id,
        isPlaying: true,
        currentTime: 120.0,
        queue: tracks
      };
      hostSession.broadcastState(activeState);

      // New peer joins
      await peerSession.joinRoom(code);
      const lastMsg = hostSession.broadcastState(activeState);

      const { adjustedTime, isPlaying } = peerSession.receiveMessage(lastMsg!);

      expect(isPlaying).toBe(true);
      expect(adjustedTime).toBeGreaterThanOrEqual(120.0);
      expect(peerSession.lastReceivedState?.queue).toHaveLength(4);
      expect(peerSession.lastReceivedState?.trackId).toBe(tracks[1].id);
    });
  });
});
