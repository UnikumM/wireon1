import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import '../setup';

import { MiniWindow } from '../../src/components/player/mini/MiniWindow';
import { useMiniPlayerHost } from '../../src/hooks/useMiniPlayerHost';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import type { MiniPlayerCommand, MiniPlayerState } from '../../src/types/electron';
import { UnifiedTrack } from '../../src/types/music';

const track: UnifiedTrack = {
  id: 'yt_detached_01',
  source: 'youtube',
  originalId: 'detached_01',
  title: 'Ночная смена',
  artist: 'Гидропоника',
  album: 'Полночь',
  duration: 200,
  artworkUrl: 'https://example.com/night.jpg'
};

const nextTrack: UnifiedTrack = {
  id: 'yt_detached_02',
  source: 'youtube',
  originalId: 'detached_02',
  title: 'Утро',
  artist: 'Гидропоника',
  duration: 180,
  artworkUrl: 'https://example.com/morning.jpg'
};

function snapshot(overrides: Partial<MiniPlayerState> = {}): MiniPlayerState {
  return {
    title: 'Ночная смена',
    artist: 'Гидропоника',
    artwork: 'https://example.com/night.jpg',
    isPlaying: true,
    currentTime: 45,
    duration: 200,
    volume: 0.8,
    isFavorite: false,
    shuffle: false,
    repeat: 'off',
    accent: 'rgb(90, 120, 200)',
    ...overrides
  };
}

/**
 * Stands in for the main process: `sendMiniState` is delivered to `onMiniState`
 * listeners and `sendMiniCommand` to `onMiniCommand` listeners, exactly as
 * `electron/main.ts` forwards them between the two windows.
 *
 * In production the halves are separate renderers with separate stores; here they
 * share one, so these tests assert the wire contract (which command, which
 * snapshot) rather than pretending the isolation is reproduced.
 */
function installBridge() {
  const stateListeners = new Set<(state: MiniPlayerState) => void>();
  const commandListeners = new Set<(command: MiniPlayerCommand) => void>();
  const visibilityListeners = new Set<(open: boolean) => void>();
  const states: MiniPlayerState[] = [];
  const commands: MiniPlayerCommand[] = [];

  const api = {
    isMiniWindow: true,
    closeMiniWindow: vi.fn().mockResolvedValue(true),
    openMiniWindow: vi.fn().mockResolvedValue(true),
    isMiniWindowOpen: vi.fn().mockResolvedValue(true),
    onMiniState: (callback: (state: MiniPlayerState) => void) => {
      stateListeners.add(callback);
      return () => stateListeners.delete(callback);
    },
    onMiniCommand: (callback: (command: MiniPlayerCommand) => void) => {
      commandListeners.add(callback);
      return () => commandListeners.delete(callback);
    },
    onMiniWindowVisibility: (callback: (open: boolean) => void) => {
      visibilityListeners.add(callback);
      return () => visibilityListeners.delete(callback);
    },
    sendMiniState: (state: MiniPlayerState) => {
      states.push(state);
      stateListeners.forEach((listener) => listener(state));
    },
    sendMiniCommand: (command: MiniPlayerCommand) => {
      commands.push(command);
      commandListeners.forEach((listener) => listener(command));
    }
  };

  const previous = (window as unknown as { electronAPI?: unknown }).electronAPI;
  (window as unknown as { electronAPI?: unknown }).electronAPI = api;

  return {
    api,
    states,
    commands,
    /** Pushes a snapshot at the mini window, as the host would. */
    push: (state: MiniPlayerState) => act(() => api.sendMiniState(state)),
    /** Delivers a command to the host, as the mini window would. */
    dispatch: (command: MiniPlayerCommand) => act(() => api.sendMiniCommand(command)),
    emitVisibility: (open: boolean) => act(() => visibilityListeners.forEach((listener) => listener(open))),
    restore: () => {
      (window as unknown as { electronAPI?: unknown }).electronAPI = previous;
    }
  };
}

function Host() {
  useMiniPlayerHost();
  return <div data-testid="mini-host" />;
}

/** Lets queued microtasks (an awaited store action, then the forced push) land. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Отдельное окно мини-плеера', () => {
  let bridge: ReturnType<typeof installBridge>;

  beforeEach(() => {
    bridge = installBridge();
    usePlayerStore.setState({
      currentTrack: track,
      isPlaying: false,
      isLoading: false,
      currentTime: 45.7,
      duration: 200.4,
      volume: 0.8,
      isMuted: false,
      isShuffled: false,
      repeatMode: 'off',
      sourceQueue: [track, nextTrack],
      userQueue: [],
      currentIndex: 0
    });
    useLibraryStore.setState({ favorites: [] });
    useUIStore.setState({ isMiniPlayerOpen: false });
  });

  afterEach(() => {
    cleanup();
    bridge.restore();
    vi.useRealTimers();
  });

  describe('MiniWindow — пульт без собственного состояния', () => {
    it('до первого снимка показывает пустой экран и сам просит состояние', () => {
      render(<MiniWindow />);

      expect(screen.getByTestId('mini-window-title')).toHaveTextContent('Ничего не играет');
      expect(screen.getByTestId('mini-window-artist')).toHaveTextContent('Запустите трек в основном окне');
      expect(bridge.commands).toEqual([{ type: 'request-state' }]);
    });

    it('рисует пришедший снимок', async () => {
      render(<MiniWindow />);
      await bridge.push(snapshot());

      expect(screen.getByTestId('mini-window-title')).toHaveTextContent('Ночная смена');
      expect(screen.getByTestId('mini-window-artist')).toHaveTextContent('Гидропоника');
      expect(screen.getByTestId('mini-window-elapsed')).toHaveTextContent('0:45');
      expect(screen.getByText('3:20')).toBeInTheDocument();
      expect(screen.getByTestId('mini-window-play')).toHaveAttribute('aria-label', 'Пауза');
    });

    it('кнопки транспорта отправляют команды', async () => {
      render(<MiniWindow />);
      await bridge.push(snapshot());

      fireEvent.click(screen.getByTestId('mini-window-play'));
      fireEvent.click(screen.getByTestId('mini-window-next'));
      fireEvent.click(screen.getByTestId('mini-window-prev'));
      fireEvent.click(screen.getByTestId('mini-window-shuffle'));
      fireEvent.click(screen.getByTestId('mini-window-repeat'));
      fireEvent.click(screen.getByTestId('mini-window-favorite'));

      expect(bridge.commands).toEqual([
        { type: 'request-state' },
        { type: 'play-pause' },
        { type: 'next' },
        { type: 'prev' },
        { type: 'shuffle' },
        { type: 'repeat' },
        { type: 'toggle-favorite' }
      ]);
    });

    it('отражает избранное, перемешивание и режим повтора из снимка', async () => {
      render(<MiniWindow />);
      await bridge.push(snapshot({ isFavorite: true, shuffle: true, repeat: 'one' }));

      expect(screen.getByTestId('mini-window-favorite')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('mini-window-favorite')).toHaveAttribute('aria-label', 'Убрать из избранного');
      expect(screen.getByTestId('mini-window-shuffle')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('mini-window-repeat').getAttribute('title')).toBe('Повтор трека');

      await bridge.push(snapshot({ repeat: 'all' }));
      expect(screen.getByTestId('mini-window-repeat').getAttribute('title')).toBe('Повтор очереди');
    });

    it('без трека не даёт нажать избранное и перемотку', () => {
      render(<MiniWindow />);

      expect(screen.getByTestId('mini-window-favorite')).toBeDisabled();
      expect(screen.getByTestId('mini-window-seek')).toBeDisabled();
    });

    it('громкость: кнопка глушит и возвращает звук, слайдер отправляет значение', async () => {
      render(<MiniWindow />);
      await bridge.push(snapshot({ volume: 0.8 }));

      fireEvent.click(screen.getByTestId('mini-window-mute'));
      expect(bridge.commands.at(-1)).toEqual({ type: 'volume', value: 0 });

      await bridge.push(snapshot({ volume: 0 }));
      expect(screen.getByTestId('mini-window-mute')).toHaveAttribute('aria-label', 'Включить звук');
      fireEvent.click(screen.getByTestId('mini-window-mute'));
      expect(bridge.commands.at(-1)).toEqual({ type: 'volume', value: 1 });

      fireEvent.change(screen.getByTestId('mini-window-volume'), { target: { value: '0.35' } });
      expect(bridge.commands.at(-1)).toEqual({ type: 'volume', value: 0.35 });
    });

    it('перемотка отправляет команду только когда пользователь отпустил ползунок', async () => {
      render(<MiniWindow />);
      await bridge.push(snapshot());

      fireEvent.change(screen.getByTestId('mini-window-seek'), { target: { value: '150' } });
      expect(bridge.commands.some((command) => command.type === 'seek')).toBe(false);
      expect(screen.getByTestId('mini-window-elapsed')).toHaveTextContent('2:30');

      fireEvent.mouseUp(screen.getByTestId('mini-window-seek'));
      expect(bridge.commands.at(-1)).toEqual({ type: 'seek', value: 150 });
    });

    it('входящие снимки не дёргают ползунок во время перетаскивания', async () => {
      render(<MiniWindow />);
      await bridge.push(snapshot());

      fireEvent.change(screen.getByTestId('mini-window-seek'), { target: { value: '150' } });
      await bridge.push(snapshot({ currentTime: 46 }));
      expect(screen.getByTestId('mini-window-elapsed')).toHaveTextContent('2:30');

      fireEvent.mouseUp(screen.getByTestId('mini-window-seek'));
      await bridge.push(snapshot({ currentTime: 150 }));
      expect(screen.getByTestId('mini-window-elapsed')).toHaveTextContent('2:30');

      await bridge.push(snapshot({ currentTime: 151 }));
      expect(screen.getByTestId('mini-window-elapsed')).toHaveTextContent('2:31');
    });

    it('разворот просит показать основное окно, крестик закрывает мини-плеер', () => {
      render(<MiniWindow />);

      fireEvent.click(screen.getByTestId('mini-window-expand'));
      expect(bridge.commands.at(-1)).toEqual({ type: 'focus-main' });

      fireEvent.click(screen.getByTestId('mini-window-close'));
      expect(bridge.api.closeMiniWindow).toHaveBeenCalled();
    });
  });

  describe('useMiniPlayerHost — сторона основного окна', () => {
    it('по запросу отдаёт снимок с целыми секундами', async () => {
      render(<Host />);
      await bridge.dispatch({ type: 'request-state' });
      await flush();

      expect(bridge.states.at(-1)).toMatchObject({
        title: 'Ночная смена',
        artist: 'Гидропоника',
        artwork: 'https://example.com/night.jpg',
        currentTime: 45,
        duration: 200,
        volume: 0.8,
        isFavorite: false,
        repeat: 'off'
      });
    });

    it('в снимке приглушённый звук — это нулевая громкость', async () => {
      usePlayerStore.setState({ isMuted: true, volume: 0.8 });
      render(<Host />);
      await bridge.dispatch({ type: 'request-state' });
      await flush();

      expect(bridge.states.at(-1)?.volume).toBe(0);
    });

    it('не гоняет по проводу одинаковые снимки', async () => {
      vi.useFakeTimers();
      render(<Host />);
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      const afterIdle = bridge.states.length;

      usePlayerStore.setState({ currentTime: 61.2 });
      await act(async () => {
        vi.advanceTimersByTime(600);
      });

      expect(bridge.states.length).toBe(afterIdle + 1);
      expect(bridge.states.at(-1)?.currentTime).toBe(61);
    });

    it('переводит команды в действия плеера', async () => {
      const toggle = vi.spyOn(usePlayerStore.getState(), 'togglePlayPause').mockResolvedValue();
      const next = vi.spyOn(usePlayerStore.getState(), 'nextTrack').mockResolvedValue();
      const prev = vi.spyOn(usePlayerStore.getState(), 'prevTrack').mockResolvedValue();
      const seek = vi.spyOn(usePlayerStore.getState(), 'seekTo');
      const volume = vi.spyOn(usePlayerStore.getState(), 'setVolume');
      render(<Host />);

      await bridge.dispatch({ type: 'play-pause' });
      await bridge.dispatch({ type: 'next' });
      await bridge.dispatch({ type: 'prev' });
      await bridge.dispatch({ type: 'seek', value: 120 });
      await bridge.dispatch({ type: 'volume', value: 0.4 });
      await flush();

      expect(toggle).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(true);
      expect(prev).toHaveBeenCalledTimes(1);
      expect(seek).toHaveBeenCalledWith(120);
      expect(volume).toHaveBeenCalledWith(0.4);

      toggle.mockRestore();
      next.mockRestore();
      prev.mockRestore();
      seek.mockRestore();
      volume.mockRestore();
    });

    it('перемешивание и повтор идут через плеер, избранное — через библиотеку', async () => {
      const shuffle = vi.spyOn(usePlayerStore.getState(), 'toggleShuffle');
      const repeat = vi.spyOn(usePlayerStore.getState(), 'cycleRepeatMode');
      const favorite = vi.spyOn(useLibraryStore.getState(), 'toggleFavorite').mockResolvedValue(true);
      render(<Host />);

      await bridge.dispatch({ type: 'shuffle' });
      await bridge.dispatch({ type: 'repeat' });
      await bridge.dispatch({ type: 'toggle-favorite' });
      await flush();

      expect(shuffle).toHaveBeenCalledTimes(1);
      expect(repeat).toHaveBeenCalledTimes(1);
      expect(favorite).toHaveBeenCalledWith(track);

      shuffle.mockRestore();
      repeat.mockRestore();
      favorite.mockRestore();
    });

    it('без трека избранное не трогает библиотеку', async () => {
      usePlayerStore.setState({ currentTrack: null });
      const favorite = vi.spyOn(useLibraryStore.getState(), 'toggleFavorite').mockResolvedValue(true);
      render(<Host />);

      await bridge.dispatch({ type: 'toggle-favorite' });
      await flush();

      expect(favorite).not.toHaveBeenCalled();
      favorite.mockRestore();
    });

    it('снимок после команды отражает результат, а не состояние до неё', async () => {
      // Регрессия: пуш сразу после отправки команды уходил со старым состоянием,
      // и мини-плеер на полсекунды возвращался в «пауза» после каждого нажатия.
      const toggle = vi.spyOn(usePlayerStore.getState(), 'togglePlayPause').mockImplementation(async () => {
        await Promise.resolve();
        usePlayerStore.setState({ isPlaying: true });
      });
      render(<Host />);

      await bridge.dispatch({ type: 'play-pause' });
      await flush();

      expect(toggle).toHaveBeenCalled();
      expect(bridge.states.at(-1)?.isPlaying).toBe(true);
      toggle.mockRestore();
    });

    it('упавшая команда не рушит хост и всё равно отдаёт снимок', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const toggle = vi
        .spyOn(usePlayerStore.getState(), 'togglePlayPause')
        .mockRejectedValue(new Error('нет потока'));
      render(<Host />);

      await bridge.dispatch({ type: 'play-pause' });
      await flush();

      expect(warn).toHaveBeenCalled();
      expect(bridge.states.length).toBeGreaterThan(0);

      toggle.mockRestore();
      warn.mockRestore();
    });

    it('открытие и закрытие окна отражается в состоянии интерфейса', async () => {
      render(<Host />);

      await bridge.emitVisibility(true);
      expect(useUIStore.getState().isMiniPlayerOpen).toBe(true);
      expect(bridge.states.length).toBeGreaterThan(0);

      await bridge.emitVisibility(false);
      expect(useUIStore.getState().isMiniPlayerOpen).toBe(false);
    });

    it('в браузере без Electron ничего не делает и не падает', () => {
      bridge.restore();
      (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;

      expect(() => render(<Host />)).not.toThrow();
    });
  });

  describe('Круг: нажатие в мини-окне доходит до плеера', () => {
    it('кнопка «дальше» в мини-окне переключает трек в основном окне', async () => {
      const next = vi.spyOn(usePlayerStore.getState(), 'nextTrack').mockResolvedValue();
      render(
        <>
          <Host />
          <MiniWindow />
        </>
      );

      fireEvent.click(screen.getByTestId('mini-window-next'));
      await flush();

      expect(next).toHaveBeenCalledWith(true);
      next.mockRestore();
    });

    it('мини-окно получает снимок хоста без ручного запроса', async () => {
      render(
        <>
          <Host />
          <MiniWindow />
        </>
      );
      await flush();

      expect(screen.getByTestId('mini-window-title')).toHaveTextContent('Ночная смена');
      expect(screen.getByTestId('mini-window-elapsed')).toHaveTextContent('0:45');
    });
  });
});
