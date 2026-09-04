import { create } from 'zustand';
import { UnifiedTrack } from '../types/music';
import {
  GroupParticipant,
  GroupState,
  GroupListenMessage,
  GroupConnectionStatus,
  groupListenService
} from '../services/groupListenService';
import {
  BEACON_INTERVAL_MS,
  decideFollowerAction,
  publishReason,
  queueSignature,
  type FollowerAction,
  type HostSnapshot
} from '../services/groupSync';
import { usePlayerStore } from './usePlayerStore';
import { useAuthStore } from './useAuthStore';

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export interface GroupListenState {
  roomId: string | null;
  isHost: boolean;
  /** A room session is active. Whether anyone else can hear it: `connectionStatus`. */
  isConnected: boolean;
  connectionStatus: GroupConnectionStatus;
  connectionError: string | null;
  participants: GroupParticipant[];
  isSyncing: boolean;
  error: string | null;
  lastSyncTimestamp: number | null;
  currentGroupTrack: UnifiedTrack | null;
  isPlaying: boolean;
  currentTime: number;
  queue: UnifiedTrack[];
  chatMessages: ChatMessage[];
  isModalOpen: boolean;
  /** Who leads the room. `null` on a listener means nobody does right now. */
  hostId: string | null;
  /** Measured one-way delay to the host, ms. 0 until a probe is answered. */
  latencyMs: number;
  /** Measured round trip to the host, ms. */
  roundTripMs: number;
  /** Host clock minus local clock, ms. */
  clockOffsetMs: number;
  /** Signed: «+» — мы убежали вперёд, «−» — отстали. */
  lastDrift: number;
  /** What the last snapshot made this client do; drives the honest UI readout. */
  lastSyncAction: FollowerAction | null;
  /** Ready-to-show Russian notice about the session, e.g. the host leaving. */
  notice: string | null;
}

export interface GroupListenActions {
  createRoom: (customCode?: string) => Promise<string>;
  joinRoom: (code: string) => Promise<boolean>;
  leaveRoom: () => void;
  syncPlayback: (state?: Partial<GroupState>) => void;
  broadcastCurrentPlayback: () => void;
  sendChat: (text: string) => void;
  setModalOpen: (isOpen: boolean) => void;
  toggleModal: () => void;
  setSyncing: (isSyncing: boolean) => void;
  clearError: () => void;
  clearNotice: () => void;
  reset: () => void;
}

export type GroupListenStore = GroupListenState & GroupListenActions;

type SetState = (
  partial: Partial<GroupListenState> | ((state: GroupListenState) => Partial<GroupListenState>)
) => void;

let unsubscribeMessage: (() => void) | null = null;
let unsubscribeParticipants: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;
let unsubscribeConnection: (() => void) | null = null;
let unsubscribeHost: (() => void) | null = null;
let unsubscribeClock: (() => void) | null = null;
/** Host side: the player subscription and the beacon that back up its events. */
let unsubscribePlayer: (() => void) | null = null;
let beaconTimer: ReturnType<typeof setInterval> | null = null;
let lastHostSnapshot: HostSnapshot | null = null;
/** Host timestamp of the last snapshot this client obeyed; guards against reordering. */
let lastAppliedAt = 0;
let isApplyingRemoteState = false;

/** What the host is playing right now, for the service to answer joins with. */
function currentPlaybackState(): GroupState {
  const player = usePlayerStore.getState();
  return {
    track: player.currentTrack,
    trackId: player.currentTrack?.id,
    isPlaying: player.isPlaying,
    currentTime: player.currentTime,
    queue:
      player.sourceQueue.length > 0
        ? player.sourceQueue
        : player.currentTrack
          ? [player.currentTrack]
          : []
  };
}

export const useGroupListenStore = create<GroupListenStore>((set, get) => ({
  roomId: null,
  isHost: false,
  isConnected: false,
  connectionStatus: 'offline',
  connectionError: null,
  participants: [],
  isSyncing: false,
  error: null,
  lastSyncTimestamp: null,
  currentGroupTrack: null,
  isPlaying: false,
  currentTime: 0,
  queue: [],
  chatMessages: [],
  isModalOpen: false,
  hostId: null,
  latencyMs: 0,
  roundTripMs: 0,
  clockOffsetMs: 0,
  lastDrift: 0,
  lastSyncAction: null,
  notice: null,

  setModalOpen: (isOpen: boolean) => set({ isModalOpen: isOpen }),
  toggleModal: () => set((s) => ({ isModalOpen: !s.isModalOpen })),
  setSyncing: (isSyncing: boolean) => set({ isSyncing }),
  clearError: () => set({ error: null }),
  clearNotice: () => set({ notice: null }),

  reset: () => {
    groupListenService.leaveRoom();
    teardownSession();
    set(idleSessionState());
  },

  createRoom: async (customCode?: string) => {
    try {
      set({ error: null, isSyncing: true, notice: null });

      const authUser = useAuthStore.getState().user;
      if (authUser) {
        groupListenService.setUser(authUser.id, authUser.username, authUser.avatarUrl);
      }

      setupServiceListeners(set, get);
      // The host answers every join with its live playback, so a late joiner lands
      // on the current second instead of waiting for the next update.
      groupListenService.setStateProvider(currentPlaybackState);

      const roomId = await groupListenService.createRoom(customCode);
      const isHost = groupListenService.isRoomHost();
      const participants = groupListenService.getParticipants();

      set({
        roomId,
        isHost,
        isConnected: true,
        connectionStatus: groupListenService.getConnectionStatus(),
        participants,
        isSyncing: false,
        error: null
      });

      // Without this the room went silent after the first snapshot: nothing in the
      // app ever asked the host to publish again. This is the piece that was missing.
      attachHostBridge(set, get);
      publishHostSnapshot(set, get, { force: true });

      return roomId;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Не удалось создать комнату';
      set({ error: msg, isSyncing: false });
      throw err;
    }
  },

  joinRoom: async (code: string) => {
    try {
      set({ error: null, isSyncing: true, notice: null });

      const authUser = useAuthStore.getState().user;
      if (authUser) {
        groupListenService.setUser(authUser.id, authUser.username, authUser.avatarUrl);
      }

      setupServiceListeners(set, get);
      lastAppliedAt = 0;

      const success = await groupListenService.joinRoom(code);
      const roomId = groupListenService.getRoomId();
      const participants = groupListenService.getParticipants();

      set({
        roomId,
        isHost: false,
        isConnected: success,
        connectionStatus: groupListenService.getConnectionStatus(),
        participants,
        isSyncing: false,
        error: null
      });

      return success;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Не удалось войти в комнату';
      set({ error: msg, isSyncing: false });
      throw err;
    }
  },

  leaveRoom: () => {
    groupListenService.leaveRoom();
    groupListenService.setStateProvider(null);
    teardownSession();
    set(idleSessionState());
  },

  broadcastCurrentPlayback: () => {
    publishHostSnapshot(set, get, { force: true });
  },

  syncPlayback: (partialState?: Partial<GroupState>) => {
    const { isConnected, isHost } = get();
    if (!isConnected || !isHost) return;

    const live = currentPlaybackState();
    const state: GroupState = {
      track: partialState?.track ?? live.track,
      trackId: partialState?.trackId ?? live.trackId,
      isPlaying: partialState?.isPlaying ?? live.isPlaying,
      currentTime: partialState?.currentTime ?? live.currentTime,
      queue: partialState?.queue ?? live.queue
    };
    publishHostSnapshot(set, get, { force: true, state });
  },

  sendChat: (text: string) => {
    const { isConnected, roomId } = get();
    if (!isConnected || !roomId || !text.trim()) return;

    const authUser = useAuthStore.getState().user;
    const msg = groupListenService.sendChat(text);
    if (msg) {
      set((s) => ({
        chatMessages: [
          ...s.chatMessages,
          {
            id: msg.messageId || `${Date.now()}_${Math.random()}`,
            senderId: msg.senderId,
            senderName: msg.senderName || authUser?.username || 'You',
            text: text.trim(),
            timestamp: msg.hostTimestamp
          }
        ]
      }));
    }
  }
}));

/** Everything a finished session has to forget. */
function idleSessionState(): Partial<GroupListenState> {
  return {
    roomId: null,
    isHost: false,
    isConnected: false,
    connectionStatus: 'offline',
    connectionError: null,
    participants: [],
    isSyncing: false,
    error: null,
    lastSyncTimestamp: null,
    currentGroupTrack: null,
    isPlaying: false,
    currentTime: 0,
    queue: [],
    chatMessages: [],
    hostId: null,
    latencyMs: 0,
    roundTripMs: 0,
    clockOffsetMs: 0,
    lastDrift: 0,
    lastSyncAction: null,
    notice: null
  };
}

function teardownSession(): void {
  detachHostBridge();
  for (const off of [
    unsubscribeMessage,
    unsubscribeParticipants,
    unsubscribeStatus,
    unsubscribeConnection,
    unsubscribeHost,
    unsubscribeClock
  ]) {
    off?.();
  }
  unsubscribeMessage = null;
  unsubscribeParticipants = null;
  unsubscribeStatus = null;
  unsubscribeConnection = null;
  unsubscribeHost = null;
  unsubscribeClock = null;
  lastAppliedAt = 0;
  isApplyingRemoteState = false;
}

// ---------------------------------------------------------------------------
// Сторона ведущего
// ---------------------------------------------------------------------------

/**
 * Связывает плеер ведущего с комнатой.
 *
 * Это и было главной поломкой: `broadcastCurrentPlayback` существовал, но его
 * никто не вызывал, поэтому после первого снимка комната замолкала навсегда.
 * Подписка на плеер ловит нажатия, а таймер-маячок закрывает то, что подписка не
 * видит: накопившееся расхождение и человека, зашедшего между нажатиями.
 */
function attachHostBridge(set: SetState, get: () => GroupListenStore): void {
  detachHostBridge();
  lastHostSnapshot = null;

  unsubscribePlayer = usePlayerStore.subscribe(() => {
    publishHostSnapshot(set, get);
  });

  // Половина интервала маячка: срабатывание таймера ровно в 5000 мс не гарантировано,
  // а `publishReason` всё равно отсечёт лишние проверки без отправки.
  beaconTimer = setInterval(() => publishHostSnapshot(set, get), Math.max(1000, BEACON_INTERVAL_MS / 2));
}

function detachHostBridge(): void {
  unsubscribePlayer?.();
  unsubscribePlayer = null;
  if (beaconTimer) {
    clearInterval(beaconTimer);
    beaconTimer = null;
  }
  lastHostSnapshot = null;
}

/**
 * Отправляет снимок, если для этого есть повод.
 *
 * Плеер сообщает о позиции четыре раза в секунду. Отправлять всё это на брокер
 * нельзя — поэтому решение о поводе принимает `publishReason`, а не эта функция.
 */
function publishHostSnapshot(
  set: SetState,
  get: () => GroupListenStore,
  options: { force?: boolean; state?: GroupState } = {}
): void {
  const { isConnected, isHost, roomId } = get();
  if (!isConnected || !isHost || !roomId) return;
  // Пока применяется чужое состояние, свои события — это эхо чужой команды.
  if (isApplyingRemoteState) return;

  const live = options.state ?? currentPlaybackState();
  const snapshot: HostSnapshot = {
    trackId: live.trackId ?? live.track?.id,
    isPlaying: live.isPlaying,
    currentTime: live.currentTime,
    queueSignature: queueSignature(live.queue.map((t) => t.id)),
    at: Date.now()
  };

  const reason = options.force ? 'first' : publishReason(lastHostSnapshot, snapshot);
  if (!reason) return;

  const sent = groupListenService.broadcastState(live);
  lastHostSnapshot = snapshot;
  if (!sent) return;

  set({
    currentGroupTrack: live.track || null,
    isPlaying: live.isPlaying,
    currentTime: live.currentTime,
    queue: live.queue,
    lastSyncTimestamp: snapshot.at
  });
}

// ---------------------------------------------------------------------------
// Подписки на сервис
// ---------------------------------------------------------------------------

function setupServiceListeners(set: SetState, get: () => GroupListenStore) {
  if (!unsubscribeMessage) {
    unsubscribeMessage = groupListenService.onMessage((msg: GroupListenMessage) => {
      const state = get();
      if (!state.isConnected || msg.roomId !== state.roomId) return;

      if (msg.type === 'chat' && msg.chatText) {
        set((s) => ({
          chatMessages: [
            ...s.chatMessages,
            {
              id: msg.messageId || `${Date.now()}_${Math.random()}`,
              senderId: msg.senderId,
              senderName: msg.senderName || 'Peer',
              text: msg.chatText!,
              timestamp: msg.hostTimestamp
            }
          ]
        }));
        return;
      }

      if (msg.type === 'sync_state' && !state.isHost) {
        void handleRemoteSync(msg, set);
      }
    });
  }

  if (!unsubscribeParticipants) {
    unsubscribeParticipants = groupListenService.onParticipantsChange((participants) => {
      set({ participants });
    });
  }

  if (!unsubscribeStatus) {
    unsubscribeStatus = groupListenService.onStatusChange((connected, error) => {
      set({ isConnected: connected, error: error || null });
    });
  }

  if (!unsubscribeConnection) {
    unsubscribeConnection = groupListenService.onConnectionChange((connectionStatus, connectionError) => {
      set({ connectionStatus, connectionError });
    });
  }

  if (!unsubscribeHost) {
    unsubscribeHost = groupListenService.onHostChange((hostId) => {
      const previous = get().hostId;
      // Отметки нового ведущего идут по его часам, поэтому порядок, накопленный по
      // часам прежнего, больше ничего не значит.
      lastAppliedAt = 0;
      const hostLost = hostId === null && previous !== null && !get().isHost;
      set({
        hostId,
        lastSyncAction: hostLost ? null : get().lastSyncAction,
        notice: hostLost
          ? 'Ведущий покинул комнату. Синхронизация остановлена — музыка играет только у вас.'
          : null
      });
    });
  }

  if (!unsubscribeClock) {
    unsubscribeClock = groupListenService.onClockChange(({ offsetMs, rttMs }) => {
      set({
        clockOffsetMs: Math.round(offsetMs),
        roundTripMs: Math.round(rttMs),
        // Показываем дорогу в одну сторону: именно на неё сдвинута позиция.
        latencyMs: Math.round(rttMs / 2)
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Сторона слушателя
// ---------------------------------------------------------------------------

/**
 * Применяет снимок ведущего к местному плееру.
 *
 * Что именно делать, решает `decideFollowerAction` — чистая функция, которую можно
 * проверить без плеера и без сети. Здесь остаётся только исполнение решения.
 */
async function handleRemoteSync(msg: GroupListenMessage, set: SetState): Promise<void> {
  const player = usePlayerStore.getState();
  const remoteTrack = msg.state?.track || null;
  const remoteQueue = msg.state?.queue || [];

  const decision = decideFollowerAction({
    remote: {
      senderId: msg.senderId,
      hostTimestamp: msg.hostTimestamp,
      trackId: msg.state?.trackId || remoteTrack?.id,
      isPlaying: Boolean(msg.state?.isPlaying),
      currentTime: msg.state?.currentTime ?? 0
    },
    local: {
      trackId: player.currentTrack?.id,
      isPlaying: player.isPlaying,
      currentTime: player.currentTime
    },
    hostId: groupListenService.getHostId(),
    lastAppliedAt,
    clockOffsetMs: groupListenService.getClockOffsetMs(),
    nowMs: Date.now()
  });

  set({ lastDrift: decision.drift, lastSyncAction: decision.action });

  if (!decision.applied) return;

  lastAppliedAt = msg.hostTimestamp;
  set({
    currentGroupTrack: remoteTrack,
    isPlaying: Boolean(msg.state?.isPlaying),
    currentTime: decision.targetTime,
    queue: remoteQueue,
    lastSyncTimestamp: Date.now(),
    isSyncing: true
  });

  isApplyingRemoteState = true;

  try {
    if (decision.action === 'load' && remoteTrack) {
      await player.playTrack(remoteTrack, remoteQueue.length > 0 ? remoteQueue : [remoteTrack]);
      if (decision.seekNeeded) player.seekTo(decision.targetTime);
      if (!msg.state?.isPlaying) player.pause();
    } else if (decision.action === 'play') {
      if (decision.seekNeeded) player.seekTo(decision.targetTime);
      await player.play();
    } else if (decision.action === 'pause') {
      player.pause();
      if (decision.seekNeeded) player.seekTo(decision.targetTime);
    } else if (decision.action === 'seek') {
      player.seekTo(decision.targetTime);
    }

    // Очередь догоняем отдельно от позиции: её могли изменить, не трогая трек.
    if (
      decision.action !== 'load' &&
      remoteQueue.length > 0 &&
      remoteQueue.length !== player.sourceQueue.length
    ) {
      player.setSourceQueue(remoteQueue);
    }
  } catch (err) {
    console.error('[useGroupListenStore] Failed to sync playback state:', err);
  } finally {
    // Небольшая пауза: события плеера от только что применённой команды не должны
    // выглядеть как собственное действие пользователя.
    setTimeout(() => {
      isApplyingRemoteState = false;
      set({ isSyncing: false });
    }, 100);
  }
}
