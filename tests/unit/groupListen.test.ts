import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup';

import {
  GroupListenService,
  GroupListenMessage
} from '../../src/services/groupListenService';
import { useGroupListenStore } from '../../src/store/useGroupListenStore';
import { GroupListenModal } from '../../src/components/modals/GroupListenModal';
import { Header } from '../../src/components/layout/Header';
import { createMockTrack } from '../helpers/mockData';
import { resetPlayerStore, flushAsync } from '../helpers/testUtils';

describe('Unit: GroupListenService (M7 Protocol & Engine)', () => {
  let service: GroupListenService;

  beforeEach(() => {
    service = new GroupListenService('test_user_1', 'Alice');
  });

  afterEach(() => {
    service.leaveRoom();
    vi.restoreAllMocks();
  });

  describe('1. Room Code Generation & Validation', () => {
    it('generates 6-character uppercase alphanumeric room codes', () => {
      const code = GroupListenService.generateRoomCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
    });

    it('generates unique codes across multiple calls', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        codes.add(GroupListenService.generateRoomCode());
      }
      expect(codes.size).toBe(50);
    });

    it('sanitizes valid room codes with lowercase and whitespace', () => {
      expect(GroupListenService.sanitizeRoomCode('  vr7k9x  ')).toBe('VR7K9X');
      expect(GroupListenService.sanitizeRoomCode('ab12cd')).toBe('AB12CD');
    });

    it('rejects invalid room codes not matching length or characters', () => {
      expect(() => GroupListenService.sanitizeRoomCode('')).toThrow('Код комнаты — ровно 6 символов');
      expect(() => GroupListenService.sanitizeRoomCode('ABC')).toThrow('Код комнаты — ровно 6 символов');
      expect(() => GroupListenService.sanitizeRoomCode('ABCDEFG')).toThrow('Код комнаты — ровно 6 символов');
      expect(() => GroupListenService.sanitizeRoomCode('ABC!@#')).toThrow('В коде комнаты только латинские буквы и цифры');
    });
  });

  describe('2. Room Lifecycle (Create, Join, Leave)', () => {
    it('creates a room with Host role and registers host participant', async () => {
      const code = await service.createRoom();

      expect(code).toHaveLength(6);
      expect(service.getRoomId()).toBe(code);
      expect(service.isRoomHost()).toBe(true);
      expect(service.isConnected()).toBe(true);

      const participants = service.getParticipants();
      expect(participants).toHaveLength(1);
      expect(participants[0].id).toBe('test_user_1');
      expect(participants[0].username).toBe('Alice');
      expect(participants[0].isHost).toBe(true);
    });

    it('joins a room with Member role', async () => {
      const success = await service.joinRoom('VR7K9X');

      expect(success).toBe(true);
      expect(service.getRoomId()).toBe('VR7K9X');
      expect(service.isRoomHost()).toBe(false);
      expect(service.isConnected()).toBe(true);

      const participants = service.getParticipants();
      expect(participants).toHaveLength(1);
      expect(participants[0].isHost).toBe(false);
    });

    it('cleans up all session state on leaveRoom', async () => {
      await service.createRoom();
      expect(service.isConnected()).toBe(true);

      service.leaveRoom();

      expect(service.getRoomId()).toBeNull();
      expect(service.isConnected()).toBe(false);
      expect(service.isRoomHost()).toBe(false);
      expect(service.getParticipants()).toHaveLength(0);
      expect(service.getLastReceivedState()).toBeNull();
    });
  });

  describe('3. State Broadcasting & Drift Compensation', () => {
    it('broadcasts state with host timestamp and track metadata', async () => {
      const roomId = await service.createRoom();
      const track = createMockTrack({ id: 'yt_123', title: 'Groove Track' });

      const msg = service.broadcastState({
        trackId: track.id,
        track,
        isPlaying: true,
        currentTime: 45.0,
        queue: [track]
      });

      expect(msg).not.toBeNull();
      expect(msg?.type).toBe('sync_state');
      expect(msg?.roomId).toBe(roomId);
      expect(msg?.senderId).toBe('test_user_1');
      expect(msg?.state.trackId).toBe('yt_123');
      expect(msg?.state.isPlaying).toBe(true);
      expect(msg?.state.currentTime).toBe(45.0);
    });

    it('calculates latency and compensates currentTime when receiving message', async () => {
      await service.joinRoom('SYNC01');

      const message: GroupListenMessage = {
        type: 'sync_state',
        roomId: 'SYNC01',
        senderId: 'host_99',
        senderName: 'DJ Host',
        hostTimestamp: Date.now() - 500, // 500ms in flight
        state: {
          isPlaying: true,
          currentTime: 100.0,
          queue: []
        }
      };

      const result = service.receiveMessage(message, 100.0);

      expect(result.isPlaying).toBe(true);
      expect(result.adjustedTime).toBeGreaterThanOrEqual(100.4);
      expect(result.adjustedTime).toBeLessThanOrEqual(101.0);
      expect(result.shouldSeek).toBe(true); // drift > 350ms
    });

    it('flags shouldSeek as false when drift is within 350ms threshold', async () => {
      await service.joinRoom('SYNC02');

      const message: GroupListenMessage = {
        type: 'sync_state',
        roomId: 'SYNC02',
        senderId: 'host_99',
        senderName: 'DJ Host',
        hostTimestamp: Date.now() - 50, // 50ms in flight
        state: {
          isPlaying: true,
          currentTime: 50.0,
          queue: []
        }
      };

      const result = service.receiveMessage(message, 50.0);
      expect(result.drift).toBeLessThanOrEqual(0.35);
      expect(result.shouldSeek).toBe(false);
    });

    it('rejects message from mismatched roomId', async () => {
      await service.joinRoom('ROOMAA');

      const message: GroupListenMessage = {
        type: 'sync_state',
        roomId: 'ROOMBB',
        senderId: 'other_user',
        hostTimestamp: Date.now(),
        state: { isPlaying: false, currentTime: 0, queue: [] }
      };

      expect(() => service.receiveMessage(message)).toThrow('Room ID mismatch');
    });

    it('tracks participants and sends chat messages', async () => {
      await service.createRoom();

      const chat = service.sendChat('Hello group listeners!');
      expect(chat).not.toBeNull();
      expect(chat?.type).toBe('chat');
      expect(chat?.chatText).toBe('Hello group listeners!');

      const peerMsg: GroupListenMessage = {
        type: 'sync_state',
        roomId: service.getRoomId()!,
        senderId: 'peer_user_42',
        senderName: 'Bob',
        hostTimestamp: Date.now(),
        state: { isPlaying: false, currentTime: 0, queue: [] }
      };

      service.receiveMessage(peerMsg);
      const participants = service.getParticipants();
      expect(participants.some((p) => p.id === 'peer_user_42' && p.username === 'Bob')).toBe(true);
    });
  });
});

describe('Unit: useGroupListenStore (Zustand Store)', () => {
  beforeEach(async () => {
    await flushAsync();
    useGroupListenStore.getState().reset();
    resetPlayerStore();
  });

  afterEach(async () => {
    useGroupListenStore.getState().leaveRoom();
    await flushAsync();
  });

  it('initializes with default clean state', () => {
    const state = useGroupListenStore.getState();
    expect(state.roomId).toBeNull();
    expect(state.isHost).toBe(false);
    expect(state.isConnected).toBe(false);
    expect(state.participants).toEqual([]);
    expect(state.isSyncing).toBe(false);
    expect(state.error).toBeNull();
  });

  it('creates room and updates store state', async () => {
    const roomId = await useGroupListenStore.getState().createRoom();

    const state = useGroupListenStore.getState();
    expect(state.roomId).toBe(roomId);
    expect(state.isHost).toBe(true);
    expect(state.isConnected).toBe(true);
    expect(state.participants.length).toBeGreaterThanOrEqual(1);
    expect(state.error).toBeNull();
  });

  it('joins room by code and sets isHost to false', async () => {
    const joined = await useGroupListenStore.getState().joinRoom('VR7K9X');

    const state = useGroupListenStore.getState();
    expect(joined).toBe(true);
    expect(state.roomId).toBe('VR7K9X');
    expect(state.isHost).toBe(false);
    expect(state.isConnected).toBe(true);
  });

  it('leaves room and resets store state', async () => {
    await useGroupListenStore.getState().createRoom();
    expect(useGroupListenStore.getState().isConnected).toBe(true);

    useGroupListenStore.getState().leaveRoom();

    const state = useGroupListenStore.getState();
    expect(state.roomId).toBeNull();
    expect(state.isConnected).toBe(false);
    expect(state.isHost).toBe(false);
    expect(state.participants).toEqual([]);
  });

  it('sends chat message and updates chatMessages array', async () => {
    await useGroupListenStore.getState().createRoom();
    useGroupListenStore.getState().sendChat('Awesome tune!');

    const state = useGroupListenStore.getState();
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0].text).toBe('Awesome tune!');
  });
});

describe('Unit: GroupListenModal & Header Component UI', () => {
  beforeEach(async () => {
    await flushAsync();
    act(() => {
      useGroupListenStore.getState().reset();
    });
    resetPlayerStore();
  });

  // Wrapped in `act`: the mounted Header and modal are subscribed to this store,
  // so tearing the room down re-renders them, and React only counts that as
  // intentional inside `act`.
  afterEach(async () => {
    await act(async () => {
      useGroupListenStore.getState().leaveRoom();
      await flushAsync();
    });
  });

  it('renders GroupListenModal with Host and Join tabs when open', () => {
    render(React.createElement(GroupListenModal, { isOpen: true, onClose: vi.fn() }));

    expect(screen.getByTestId('group-listen-modal')).toBeInTheDocument();
    expect(screen.getByTestId('group-listen-host-tab')).toBeInTheDocument();
    expect(screen.getByTestId('group-listen-join-tab')).toBeInTheDocument();
    expect(screen.getByTestId('group-listen-create-btn')).toBeInTheDocument();
  });

  it('switches between Host and Join tabs and accepts 6-character room code input', async () => {
    render(React.createElement(GroupListenModal, { isOpen: true, onClose: vi.fn() }));

    const joinTab = screen.getByTestId('group-listen-join-tab');
    fireEvent.click(joinTab);

    const input = screen.getByTestId('group-listen-code-input') as HTMLInputElement;
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'vr7k9x' } });
    expect(input.value).toBe('VR7K9X');

    const joinBtn = screen.getByTestId('group-listen-join-btn');
    expect(joinBtn).not.toBeDisabled();
  });

  it('renders active room state with room code, participant list, and leave button', async () => {
    act(() => {
      useGroupListenStore.setState({
        roomId: 'VR7K9X',
        isHost: true,
        isConnected: true,
        participants: [
          { id: 'u1', username: 'HostUser', isHost: true, joinedAt: Date.now() },
          { id: 'u2', username: 'ListenerBob', isHost: false, joinedAt: Date.now() }
        ]
      });
    });

    render(React.createElement(GroupListenModal, { isOpen: true, onClose: vi.fn() }));

    expect(screen.getByTestId('group-listen-room-code')).toHaveTextContent('VR7K9X');
    expect(screen.getByTestId('group-listen-copy-btn')).toBeInTheDocument();
    expect(screen.getByTestId('group-listen-participant-list')).toBeInTheDocument();
    expect(screen.getByText('HostUser')).toBeInTheDocument();
    expect(screen.getByText('ListenerBob')).toBeInTheDocument();
    expect(screen.getByTestId('group-listen-leave-btn')).toBeInTheDocument();
  });

  it('renders Header with Group Listen button and pulsing indicator when room is active', () => {
    const { rerender } = render(React.createElement(Header));

    const groupBtn = screen.getByTestId('header-group-listen-btn');
    expect(groupBtn).toBeInTheDocument();
    expect(screen.queryByTestId('header-group-listen-pulse')).not.toBeInTheDocument();

    // Now set active room in store
    act(() => {
      useGroupListenStore.setState({ isConnected: true, roomId: 'ACTIVE1' });
    });
    rerender(React.createElement(Header));

    expect(screen.getByTestId('header-group-listen-pulse')).toBeInTheDocument();
  });

  /**
   * The room existing and the room being audible to anyone else are two different
   * facts. The old modal showed a green "Live" badge for the first one, which is
   * why group listening looked fine while nothing crossed the network.
   */
  describe('Честный статус соединения в модалке', () => {
    const enterRoom = (status: 'online' | 'connecting' | 'local', connectionError: string | null = null) => {
      act(() => {
        useGroupListenStore.setState({
          roomId: 'VR7K9X',
          isHost: true,
          isConnected: true,
          connectionStatus: status,
          connectionError
        });
      });
      render(React.createElement(GroupListenModal, { isOpen: true, onClose: vi.fn() }));
    };

    it('говорит «синхронизация активна», только когда брокер действительно подключён', () => {
      enterRoom('online');

      const strip = screen.getByTestId('group-listen-connection');
      expect(strip).toHaveAttribute('data-status', 'online');
      expect(strip).toHaveTextContent('Синхронизация активна');
      expect(screen.getByTestId('group-listen-badge')).toHaveTextContent('В эфире');
    });

    it('показывает «подключение», пока брокер ещё не ответил', () => {
      enterRoom('connecting');

      expect(screen.getByTestId('group-listen-connection')).toHaveAttribute('data-status', 'connecting');
      expect(screen.getByTestId('group-listen-connection')).toHaveTextContent('Подключаемся к серверу синхронизации');
      expect(screen.getByTestId('group-listen-badge')).toHaveTextContent('Подключение');
      expect(screen.getByTestId('group-listen-connection')).not.toHaveTextContent('Синхронизация активна');
    });

    it('признаётся, что комната только на этом устройстве, и называет причину', () => {
      enterRoom('local', 'Брокер не ответил');

      const strip = screen.getByTestId('group-listen-connection');
      expect(strip).toHaveAttribute('data-status', 'local');
      expect(strip).toHaveTextContent('Только это устройство');
      expect(screen.getByTestId('group-listen-connection-error')).toHaveTextContent('Брокер не ответил');
      expect(screen.getByTestId('group-listen-badge')).toHaveTextContent('Только здесь');
      expect(strip).not.toHaveTextContent('Синхронизация активна');
    });
  });
});
