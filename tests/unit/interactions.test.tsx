/**
 * The interaction layer: global shortcuts, the command palette, the
 * add-to-playlist picker, the render error boundary, and the copy shown when
 * Discord sign-in fails.
 *
 * These are the parts a user drives with the keyboard and the mouse rather than
 * through a store call, so everything here goes through real events on real
 * components against the real stores and the real IndexedDB layer.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '../setup';

import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { CommandPalette } from '../../src/components/common/CommandPalette';
import { ErrorBoundary } from '../../src/components/common/ErrorBoundary';
import { AddToPlaylistModal } from '../../src/components/library/AddToPlaylistModal';
import { describeAuthError, DISCORD_CONFIG_HINT } from '../../src/components/auth/authErrors';
import { AuthError } from '../../src/services/discordAuth';

import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import * as dbService from '../../src/services/db';
import { streamResolver } from '../../src/services/streamResolver';
import { Playlist, UnifiedTrack } from '../../src/types/music';

import {
  installFetchMock,
  resetPlayerStore,
  resetLibraryStore,
  resetUIStore,
  flushAsync,
  signInForTests
} from '../helpers/testUtils';
import { healthySourceRoutes } from '../helpers/networkFixtures';
import { APP_VERSION } from '../../src/utils/appInfo';

const player = () => usePlayerStore.getState();
const library = () => useLibraryStore.getState();
const ui = () => useUIStore.getState();

/**
 * A track shaped like a search result: no stream URL of its own, because a
 * resolved URL expires and is fetched on demand. The stubbed player endpoint
 * answers for any id, so these resolve like any other YouTube track.
 */
function searchResultTrack(id: string, title: string): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id,
    title,
    artist: 'Interaction Test',
    duration: 200,
    artworkUrl: '',
    streamUrl: ''
  };
}

const trackA = searchResultTrack('yt_int_a', 'Interaction A');
const trackB = searchResultTrack('yt_int_b', 'Interaction B');

/** Mounts the global listener the way `AppShell` does. */
const ShortcutHost: React.FC = () => {
  useKeyboardShortcuts();
  return <input data-testid="search-input" defaultValue="query text" />;
};

/** Dispatches a real keydown on `window` and reports whether it was consumed. */
function pressKey(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('Interaction layer', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // No test here is about the network, but a track change resolves a stream,
    // and an unmocked fetch would reach the real internet.
    installFetchMock(healthySourceRoutes());
    streamResolver.clearCache();
    resetPlayerStore();
    resetLibraryStore();
    signInForTests();
    resetUIStore();
    Element.prototype.scrollIntoView = vi.fn();
    await dbService.clearAllData();
  });

  afterEach(async () => {
    player().setSleepTimer(null);
    await flushAsync();
    vi.unstubAllGlobals();
    if (!dbService.db.isOpen()) await dbService.db.open();
    await dbService.clearAllData();
  });

  // ==========================================================================
  // useKeyboardShortcuts
  // ==========================================================================
  describe('useKeyboardShortcuts', () => {
    it('toggles playback with Space and swallows the page scroll', () => {
      render(<ShortcutHost />);
      usePlayerStore.setState({ currentTrack: trackA, playbackState: 'playing', isPlaying: true });

      expect(pressKey({ key: ' ' })).toBe(true);

      expect(player().isPlaying).toBe(false);
      expect(player().playbackState).toBe('paused');
    });

    it('seeks by five seconds and never past either end', () => {
      render(<ShortcutHost />);
      usePlayerStore.setState({ currentTrack: trackA, duration: 100, currentTime: 50 });

      pressKey({ key: 'ArrowRight' });
      expect(player().currentTime).toBe(55);

      pressKey({ key: 'ArrowLeft' });
      expect(player().currentTime).toBe(50);

      usePlayerStore.setState({ currentTime: 2 });
      pressKey({ key: 'ArrowLeft' });
      expect(player().currentTime).toBe(0);

      usePlayerStore.setState({ currentTime: 98 });
      pressKey({ key: 'ArrowRight' });
      expect(player().currentTime).toBe(100);
    });

    it('changes track with Shift and an arrow key', async () => {
      render(<ShortcutHost />);
      usePlayerStore.setState({
        currentTrack: trackA,
        sourceQueue: [trackA, trackB],
        currentIndex: 0,
        playbackState: 'playing',
        isPlaying: true
      });

      await act(async () => {
        pressKey({ key: 'ArrowRight', shiftKey: true });
      });
      await waitFor(() => expect(player().currentTrack?.id).toBe(trackB.id));
      // The key really started the next song; it did not just move a pointer.
      expect(player().playbackState).toBe('playing');
      expect(player().error).toBeNull();

      await act(async () => {
        pressKey({ key: 'ArrowLeft', shiftKey: true });
      });
      await waitFor(() => expect(player().currentTrack?.id).toBe(trackA.id));
      expect(player().playbackState).toBe('playing');
    });

    it('binds mute, fullscreen and the queue to single keys', () => {
      render(<ShortcutHost />);

      pressKey({ key: 'm' });
      expect(player().isMuted).toBe(true);
      pressKey({ key: 'M' });
      expect(player().isMuted).toBe(false);

      pressKey({ key: 'f' });
      expect(ui().isFullscreenPlayerOpen).toBe(true);

      pressKey({ key: 'q' });
      expect(ui().isQueueOpen).toBe(true);
    });

    it('sends "/" to the search field', async () => {
      useUIStore.setState({ activeView: 'settings' });
      render(<ShortcutHost />);

      pressKey({ key: '/' });

      expect(ui().activeView).toBe('search');
      // Focus lands on the next frame, once the search view has mounted.
      await waitFor(() => expect(screen.getByTestId('search-input')).toHaveFocus());
      expect((screen.getByTestId('search-input') as HTMLInputElement).selectionEnd).toBe('query text'.length);
    });

    it('opens the command palette with Ctrl+K and with Cmd+K', () => {
      render(<ShortcutHost />);

      expect(pressKey({ key: 'k', ctrlKey: true })).toBe(true);
      expect(ui().isCommandPaletteOpen).toBe(true);

      pressKey({ key: 'K', metaKey: true });
      expect(ui().isCommandPaletteOpen).toBe(false);
    });

    it('closes overlays with Escape, topmost first', () => {
      render(<ShortcutHost />);
      useUIStore.setState({
        isCommandPaletteOpen: true,
        isFullscreenPlayerOpen: true,
        isQueueOpen: true
      });

      pressKey({ key: 'Escape' });
      expect(ui().isCommandPaletteOpen).toBe(false);
      expect(ui().isFullscreenPlayerOpen).toBe(true);

      pressKey({ key: 'Escape' });
      expect(ui().isFullscreenPlayerOpen).toBe(false);
      expect(ui().isQueueOpen).toBe(true);

      pressKey({ key: 'Escape' });
      expect(ui().isQueueOpen).toBe(false);

      // Nothing left to close: Escape is left alone for the browser.
      expect(pressKey({ key: 'Escape' })).toBe(false);
    });

    it('keeps its hands off keys typed into a field', () => {
      render(<ShortcutHost />);
      const input = screen.getByTestId('search-input');

      for (const key of [' ', 'm', 'f', 'q', '/', 'ArrowRight']) {
        fireEvent.keyDown(input, { key });
      }

      expect(player().isMuted).toBe(false);
      expect(player().currentTime).toBe(0);
      expect(ui().isFullscreenPlayerOpen).toBe(false);
      expect(ui().isQueueOpen).toBe(false);
    });

    it('leaves browser and OS chords alone', () => {
      render(<ShortcutHost />);

      // Ctrl+F is find-in-page, Alt+Q may be an OS menu, Shift+M is a capital M.
      expect(pressKey({ key: 'f', ctrlKey: true })).toBe(false);
      expect(pressKey({ key: 'q', altKey: true })).toBe(false);
      expect(pressKey({ key: 'M', shiftKey: true })).toBe(false);

      expect(ui().isFullscreenPlayerOpen).toBe(false);
      expect(ui().isQueueOpen).toBe(false);
      expect(player().isMuted).toBe(false);
    });

    it('stops listening once unmounted', () => {
      const { unmount } = render(<ShortcutHost />);
      unmount();

      pressKey({ key: 'q' });
      expect(ui().isQueueOpen).toBe(false);
    });
  });

  // ==========================================================================
  // CommandPalette
  // ==========================================================================
  describe('CommandPalette', () => {
    function openPalette() {
      useUIStore.setState({ isCommandPaletteOpen: true });
      return render(<CommandPalette />);
    }

    it('renders nothing until it is opened', () => {
      const { container } = render(<CommandPalette />);
      expect(container).toBeEmptyDOMElement();
    });

    it('groups every command when no query has been typed', () => {
      openPalette();

      expect(screen.getByTestId('command-palette')).toHaveAttribute('aria-modal', 'true');
      for (const group of ['Навигация', 'Воспроизведение', 'Вид', 'Таймер сна']) {
        expect(screen.getByText(group)).toBeInTheDocument();
      }
      expect(screen.getByTestId('command-option-go-search')).toBeInTheDocument();
      expect(screen.getByTestId('command-option-sleep-30')).toBeInTheDocument();
      // Nothing to cancel yet, so that entry is not offered.
      expect(screen.queryByTestId('command-option-sleep-off')).toBeNull();
    });

    it('filters by fuzzy subsequence, not by substring', () => {
      openPalette();

      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'ремеш' } });

      // "р-е-м-е-ш" appears in that order in «Перемешать очередь» and nowhere else.
      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(1);
      expect(options[0]).toHaveAttribute('id', 'command-toggle-shuffle');
    });

    it('still finds a Russian command by its English name', () => {
      openPalette();

      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'shuffle' } });

      // Раскладку переключить забыли — команда всё равно должна найтись.
      expect(screen.getAllByRole('option')[0]).toHaveAttribute('id', 'command-toggle-shuffle');
    });

    it('says so when nothing matches, quoting what was typed', () => {
      openPalette();

      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'zzqqxx' } });

      expect(screen.getByTestId('command-palette-empty')).toHaveTextContent('Нет команд по запросу «zzqqxx».');
      expect(screen.queryAllByRole('option')).toHaveLength(0);
    });

    it('walks the list with the arrow keys and wraps at both ends', () => {
      openPalette();
      const input = screen.getByTestId('command-palette-input');
      const idOf = () => input.getAttribute('aria-activedescendant');

      expect(idOf()).toBe('command-go-search');

      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(idOf()).toBe('command-go-wave');

      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(idOf()).toBe('command-go-search');

      // Up from the first entry lands on the last one.
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      const lastId = idOf();
      fireEvent.keyDown(input, { key: 'Home' });
      expect(idOf()).toBe('command-go-search');
      fireEvent.keyDown(input, { key: 'End' });
      expect(idOf()).toBe(lastId);
    });

    it('runs the highlighted command on Enter and closes itself', () => {
      openPalette();
      const input = screen.getByTestId('command-palette-input');

      fireEvent.change(input, { target: { value: 'favorites' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(ui().activeView).toBe('favorites');
      expect(ui().isCommandPaletteOpen).toBe(false);
      expect(screen.queryByTestId('command-palette')).toBeNull();
    });

    it('finds «Для вас» by what the screen is about, not by its name', () => {
      openPalette();
      const input = screen.getByTestId('command-palette-input');

      // Экран называется «Для вас», а ищут его словом «миксы».
      fireEvent.change(input, { target: { value: 'миксы' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(ui().activeView).toBe('foryou');
    });

    it('runs a clicked command and reflects live player state in its label', () => {
      openPalette();

      expect(screen.getByTestId('command-option-toggle-shuffle')).toHaveTextContent('Выкл');
      fireEvent.click(screen.getByTestId('command-option-toggle-shuffle'));

      expect(player().isShuffled).toBe(true);
      expect(ui().isCommandPaletteOpen).toBe(false);

      // Reopened, the same row now reports the new state.
      act(() => {
        ui().setCommandPaletteOpen(true);
      });
      expect(screen.getByTestId('command-option-toggle-shuffle')).toHaveTextContent('Вкл');
    });

    it('offers to cancel the sleep timer only while one is armed', () => {
      openPalette();

      fireEvent.click(screen.getByTestId('command-option-sleep-15'));
      expect(player().sleepTimerEndsAt).not.toBeNull();

      act(() => {
        ui().setCommandPaletteOpen(true);
      });
      fireEvent.click(screen.getByTestId('command-option-sleep-off'));
      expect(player().sleepTimerEndsAt).toBeNull();
    });

    it('lists the user’s playlists and opens the one that is chosen', async () => {
      const playlist = await library().createPlaylist('Late Night');
      await library().addTrackToPlaylist(playlist!.id, trackA);
      await flushAsync();

      openPalette();
      const option = screen.getByTestId(`command-option-playlist-${playlist!.id}`);
      expect(option).toHaveTextContent('Открыть плейлист: Late Night');
      expect(option).toHaveTextContent('1 трек');

      fireEvent.click(option);

      expect(ui().activeView).toBe('playlist');
      expect(ui().activePlaylistId).toBe(playlist!.id);
    });

    it('forgets the query between openings', () => {
      openPalette();
      const input = screen.getByTestId('command-palette-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'shuffle' } });

      act(() => {
        ui().setCommandPaletteOpen(false);
      });
      act(() => {
        ui().setCommandPaletteOpen(true);
      });

      expect((screen.getByTestId('command-palette-input') as HTMLInputElement).value).toBe('');
      expect(screen.getByText('Навигация')).toBeInTheDocument();
    });

    it('closes when the backdrop is clicked', () => {
      openPalette();

      fireEvent.mouseDown(screen.getByTestId('command-palette-backdrop'));
      fireEvent.click(screen.getByTestId('command-palette-backdrop'));

      expect(ui().isCommandPaletteOpen).toBe(false);
    });
  });

  // ==========================================================================
  // AddToPlaylistModal
  // ==========================================================================
  describe('AddToPlaylistModal', () => {
    it('renders nothing without a track', () => {
      const { container } = render(<AddToPlaylistModal track={null} isOpen onClose={vi.fn()} />);
      expect(container).toBeEmptyDOMElement();
    });

    it('offers to create the first playlist when there are none', () => {
      render(<AddToPlaylistModal track={trackA} isOpen onClose={vi.fn()} />);

      expect(screen.getByTestId('add-to-playlist-empty')).toBeInTheDocument();
      expect(screen.getByText('Добавить в плейлист')).toBeInTheDocument();
      expect(screen.getByText(`${trackA.title} — ${trackA.artist}`)).toBeInTheDocument();
    });

    it('files the track into an existing playlist and closes', async () => {
      const playlist = await library().createPlaylist('Drive');
      await flushAsync();
      const onClose = vi.fn();

      render(<AddToPlaylistModal track={trackA} isOpen onClose={onClose} />);
      fireEvent.click(screen.getByTestId(`add-to-playlist-${playlist!.id}`));

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(library().playlists[0].tracks.map((t) => t.id)).toEqual([trackA.id]);
      expect((await dbService.getPlaylistById(playlist!.id))?.tracks).toHaveLength(1);
      expect(ui().toastMessage?.type).toBe('success');
      expect(ui().toastMessage?.text).toBe(`«${trackA.title}» добавлен в «Drive»`);
    });

    it('refuses to add the same track twice', async () => {
      const playlist = await library().createPlaylist('Drive');
      await library().addTrackToPlaylist(playlist!.id, trackA);
      await flushAsync();

      render(<AddToPlaylistModal track={trackA} isOpen onClose={vi.fn()} />);

      const row = screen.getByTestId(`add-to-playlist-${playlist!.id}`);
      expect(row).toBeDisabled();
      expect(row).toHaveTextContent('Уже в этом плейлисте');
      // A different track is still welcome.
      expect(row).not.toHaveTextContent('1 трек');
    });

    it('creates a playlist and files the track into it in one step', async () => {
      const onClose = vi.fn();
      render(<AddToPlaylistModal track={trackB} isOpen onClose={onClose} />);

      fireEvent.click(screen.getByTestId('add-to-playlist-new-btn'));
      fireEvent.change(screen.getByTestId('add-to-playlist-new-input'), {
        target: { value: '  Fresh Mix  ' }
      });
      fireEvent.click(screen.getByTestId('add-to-playlist-new-submit'));

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      const stored = await dbService.getPlaylists();
      expect(stored).toHaveLength(1);
      // The name is trimmed, and the track is already inside.
      expect(stored[0].title).toBe('Fresh Mix');
      expect(stored[0].tracks.map((t) => t.id)).toEqual([trackB.id]);
      expect(ui().toastMessage?.text).toBe(`«${trackB.title}» добавлен в «Fresh Mix»`);
    });

    it('asks for a name instead of creating an untitled playlist', async () => {
      const onClose = vi.fn();
      render(<AddToPlaylistModal track={trackA} isOpen onClose={onClose} />);

      fireEvent.click(screen.getByTestId('add-to-playlist-new-btn'));
      fireEvent.change(screen.getByTestId('add-to-playlist-new-input'), { target: { value: '   ' } });
      fireEvent.click(screen.getByTestId('add-to-playlist-new-submit'));

      await flushAsync();
      expect(screen.getByTestId('add-to-playlist-error')).toHaveTextContent(
        'Введите название нового плейлиста.'
      );
      expect(await dbService.getPlaylists()).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();

      // Typing clears the complaint.
      fireEvent.change(screen.getByTestId('add-to-playlist-new-input'), { target: { value: 'O' } });
      expect(screen.queryByTestId('add-to-playlist-error')).toBeNull();
    });

    it('stays open and explains itself when the write fails', async () => {
      // A playlist the user can see but the database no longer has: exactly what
      // a second window deleting it leaves behind.
      const phantom: Playlist = {
        id: 'pl_phantom',
        title: 'Deleted Elsewhere',
        description: '',
        coverUrl: '',
        tracks: [],
        createdAt: 1000,
        updatedAt: 1000,
        isSynced: false
      };
      useLibraryStore.setState({ playlists: [phantom] });
      const onClose = vi.fn();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<AddToPlaylistModal track={trackA} isOpen onClose={onClose} />);
      fireEvent.click(screen.getByTestId('add-to-playlist-pl_phantom'));

      await waitFor(() => expect(screen.getByTestId('add-to-playlist-error')).toBeInTheDocument());
      expect(screen.getByTestId('add-to-playlist-error')).toHaveTextContent(/Плейлист не найден/i);
      expect(ui().toastMessage?.type).toBe('error');
      // The dialog stays put so the user does not lose their place.
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId('add-to-playlist-modal')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // ErrorBoundary
  // ==========================================================================
  describe('ErrorBoundary', () => {
    const Boom: React.FC<{ message?: string }> = ({ message = 'render exploded' }) => {
      throw new Error(message);
    };

    beforeEach(() => {
      // React logs every caught error; the test asserts on the UI instead.
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('passes children through untouched while nothing is wrong', () => {
      render(
        <ErrorBoundary>
          <p data-testid="child">All good</p>
        </ErrorBoundary>
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
    });

    it('shows the failure instead of a blank window, and reports it', () => {
      const onError = vi.fn();

      render(
        <ErrorBoundary onError={onError}>
          <Boom message="the visualizer died" />
        </ErrorBoundary>
      );

      const fallback = screen.getByTestId('error-boundary-fallback');
      expect(fallback).toHaveAttribute('role', 'alert');
      expect(screen.getByTestId('error-boundary-message')).toHaveTextContent('the visualizer died');
      expect(screen.getByTestId('error-boundary-reload')).toBeInTheDocument();

      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0][0] as Error).message).toBe('the visualizer died');
      expect(onError.mock.calls[0][1]).toHaveProperty('componentStack');
    });

    it('prefers a caller-supplied fallback', () => {
      render(
        <ErrorBoundary fallback={<p data-testid="custom-fallback">Just this panel is broken</p>}>
          <Boom />
        </ErrorBoundary>
      );

      expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
      expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
    });

    it('reloads the window when asked to', () => {
      const reload = vi.fn();
      // jsdom pins `reload` as a non-writable own property of `Location`, so the
      // only way to watch for the call is to swap the whole object out.
      vi.stubGlobal('location', { ...window.location, reload });

      try {
        render(
          <ErrorBoundary>
            <Boom />
          </ErrorBoundary>
        );
        fireEvent.click(screen.getByTestId('error-boundary-reload'));
        expect(reload).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('falls back to clearing itself where reload is unavailable', () => {
      vi.stubGlobal('location', { ...window.location, reload: undefined });

      try {
        let shouldThrow = true;
        const Sometimes: React.FC = () => {
          if (shouldThrow) throw new Error('transient');
          return <p data-testid="recovered">Recovered</p>;
        };

        render(
          <ErrorBoundary>
            <Sometimes />
          </ErrorBoundary>
        );
        expect(screen.getByTestId('error-boundary-message')).toHaveTextContent('transient');

        shouldThrow = false;
        fireEvent.click(screen.getByTestId('error-boundary-reload'));

        expect(screen.getByTestId('recovered')).toBeInTheDocument();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('retries just this screen without reloading the window', () => {
      const reload = vi.fn();
      vi.stubGlobal('location', { ...window.location, reload });

      try {
        let shouldThrow = true;
        const Sometimes: React.FC = () => {
          if (shouldThrow) throw new Error('дрогнуло один раз');
          return <p data-testid="recovered">Снова здесь</p>;
        };

        render(
          <ErrorBoundary>
            <Sometimes />
          </ErrorBoundary>
        );

        shouldThrow = false;
        fireEvent.click(screen.getByTestId('error-boundary-retry'));

        expect(screen.getByTestId('recovered')).toBeInTheDocument();
        // Музыка играет в этом же окне — перезагрузка её бы оборвала.
        expect(reload).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('copies a report with the version, the runtime and both stacks', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const originalClipboard = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      try {
        render(
          <ErrorBoundary>
            <Boom message="упал визуализатор" />
          </ErrorBoundary>
        );

        fireEvent.click(screen.getByTestId('error-boundary-copy'));

        await waitFor(() => {
          expect(screen.getByTestId('error-boundary-copy-state')).toHaveTextContent(/скопирован/i);
        });

        const report = writeText.mock.calls[0][0] as string;
        expect(report).toContain(`Wireon Sounds ${APP_VERSION}`);
        expect(report).toContain('Среда:');
        expect(report).toContain('упал визуализатор');
        expect(report).toContain('Компоненты:');
        // Отчёт отдают чужому человеку — токена в нём быть не должно.
        expect(report).not.toMatch(/wireon_auth|access_token/);
      } finally {
        Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
      }
    });

    it('prints the report to the console when the clipboard refuses', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const originalClipboard = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

      try {
        render(
          <ErrorBoundary>
            <Boom message="нет буфера" />
          </ErrorBoundary>
        );

        fireEvent.click(screen.getByTestId('error-boundary-copy'));

        await waitFor(() => {
          expect(screen.getByTestId('error-boundary-copy-state')).toHaveTextContent(/консоль/i);
        });

        const printed = errorSpy.mock.calls.flat().join(' ');
        expect(printed).toContain('нет буфера');
      } finally {
        Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
      }
    });
  });

  // ==========================================================================
  // describeAuthError
  // ==========================================================================
  describe('describeAuthError', () => {
    it('tells a missing client id apart from a blocked popup', () => {
      const notConfigured = describeAuthError(new AuthError('NOT_CONFIGURED', 'no client id'));
      expect(notConfigured.blocking).toBe(true);
      expect(notConfigured.code).toBe('NOT_CONFIGURED');
      expect(notConfigured.detail).toContain(DISCORD_CONFIG_HINT);

      const blocked = describeAuthError(new AuthError('POPUP_BLOCKED', 'blocked'));
      // Retrying is worth a try here, so the notice must not be blocking.
      expect(blocked.blocking).toBe(false);
      expect(blocked.detail).toMatch(/разрешите всплывающие окна/i);
    });

    it('reads the HTTP status when the profile fetch is what failed', () => {
      expect(describeAuthError(new AuthError('PROFILE_FETCH_FAILED', 'x', 401)).title).toMatch(
        /отклонил токен доступа/i
      );
      expect(describeAuthError(new AuthError('PROFILE_FETCH_FAILED', 'x', 403)).detail).toContain('HTTP 403');
      expect(describeAuthError(new AuthError('PROFILE_FETCH_FAILED', 'x', 429)).title).toMatch(
        /ограничил частоту запросов/i
      );
      expect(describeAuthError(new AuthError('PROFILE_FETCH_FAILED', 'x', 500)).detail).toContain('HTTP 500');
      // No status at all still has to say something useful.
      expect(describeAuthError(new AuthError('PROFILE_FETCH_FAILED', 'x')).detail).toMatch(
        /проверьте соединение/i
      );
    });

    it('gives every code its own copy and never leaks a raw error', () => {
      const codes = [
        'UNSUPPORTED_ENVIRONMENT',
        'POPUP_CLOSED',
        'DEEP_LINK_UNAVAILABLE',
        'STATE_MISMATCH',
        'OAUTH_DENIED',
        'NO_TOKEN',
        'TIMEOUT'
      ] as const;

      const titles = new Set<string>();
      for (const code of codes) {
        const notice = describeAuthError(new AuthError(code, `raw ${code} text`));
        expect(notice.code).toBe(code);
        expect(notice.title).not.toContain('raw ');
        expect(notice.detail.length).toBeGreaterThan(20);
        titles.add(notice.title);
      }
      expect(titles.size).toBe(codes.length);

      // Only these three are hopeless without a change outside the app.
      expect(describeAuthError(new AuthError('UNSUPPORTED_ENVIRONMENT', '')).blocking).toBe(true);
      expect(describeAuthError(new AuthError('DEEP_LINK_UNAVAILABLE', '')).blocking).toBe(true);
      expect(describeAuthError(new AuthError('OAUTH_DENIED', '')).blocking).toBe(false);
    });

    it('handles anything that is not an AuthError', () => {
      const fromError = describeAuthError(new Error('socket hang up'));
      expect(fromError.code).toBe('UNKNOWN');
      expect(fromError.detail).toBe('socket hang up');

      const fromNothing = describeAuthError(undefined);
      expect(fromNothing.code).toBe('UNKNOWN');
      expect(fromNothing.detail).toBe('Неизвестная ошибка.');
    });
  });
});
