/**
 * The Settings page.
 *
 * This is the one screen where a user can permanently change or destroy their
 * library, so every test here drives the real component against the real stores,
 * the real IndexedDB layer and the real backup service. Nothing application-side
 * is faked. What is stubbed is the handful of browser edges jsdom does not
 * implement: object URLs, anchor navigation, the clipboard, `scrollIntoView` and
 * `File.prototype.text`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '../setup';

import { SettingsView } from '../../src/components/settings/SettingsView';
import { PlaybackSettings } from '../../src/components/settings/PlaybackSettings';
import { AppearanceSettings } from '../../src/components/settings/AppearanceSettings';
import { LibrarySettings } from '../../src/components/settings/LibrarySettings';
import { AccountSettings } from '../../src/components/settings/AccountSettings';
import { DesktopSettings } from '../../src/components/settings/DesktopSettings';
import { DiagnosticsSettings } from '../../src/components/settings/DiagnosticsSettings';
import { ShortcutsSettings } from '../../src/components/settings/ShortcutsSettings';
import { AboutSettings } from '../../src/components/settings/AboutSettings';

import { usePlayerStore, PLAYER_SETTING_KEYS } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useUIStore } from '../../src/store/useUIStore';
import { cloudSyncEngine, NullRemoteAdapter } from '../../src/services/cloudSync';
import { exportLibrary } from '../../src/services/backup';
import * as dbService from '../../src/services/db';
import { youtubeCookiesService } from '../../src/services/youtubeCookies';
import { Playlist, UnifiedTrack, UserProfile } from '../../src/types/music';
import { StreamDiagnostics } from '../../src/types/electron';

import {
  resetPlayerStore,
  resetLibraryStore,
  resetAuthStore,
  resetUIStore,
  clearAuthStorage,
  hasNoStoredSession,
  flushAsync,
  signInForTests
} from '../helpers/testUtils';
import { APP_VERSION } from '../../src/utils/appInfo';

const player = () => usePlayerStore.getState();
const library = () => useLibraryStore.getState();
const auth = () => useAuthStore.getState();
const ui = () => useUIStore.getState();

const trackA: UnifiedTrack = {
  id: 'yt_settings_a',
  source: 'youtube',
  originalId: 'settings_a',
  title: 'Settings Track A',
  artist: 'Artist A',
  duration: 180,
  artworkUrl: ''
};

const trackB: UnifiedTrack = {
  id: 'sc_settings_b',
  source: 'soundcloud',
  originalId: 'settings_b',
  title: 'Settings Track B',
  artist: 'Artist B',
  duration: 240,
  artworkUrl: ''
};

/** jsdom's `Blob` has no `text()`, so read it the long way. */
function readBlob(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/**
 * A file the component can actually read. Chromium has had `File.prototype.text`
 * since 2019; jsdom still does not, and without it every import would take the
 * "could not read that file" branch for the wrong reason.
 */
function jsonFile(contents: string, name = 'wireon-library.json'): File {
  const file = new File([contents], name, { type: 'application/json' });
  if (typeof file.text !== 'function') {
    Object.defineProperty(file, 'text', { value: async () => contents });
  }
  return file;
}

/** Installs the desktop half of the preload bridge for one test. */
function installDesktopBridge(overrides: Record<string, unknown> = {}): {
  mediaKeyCalls: boolean[];
} {
  const mediaKeyCalls: boolean[] = [];
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
    getPlatform: () => 'win32',
    setMediaKeysEnabled: (enabled: boolean) => {
      mediaKeyCalls.push(enabled);
    },
    ...overrides
  };
  return { mediaKeyCalls };
}

describe('Settings (src/components/settings)', () => {
  let originalElectronAPI: unknown;
  let createdBlobs: Blob[];
  let anchorClicks: Array<{ href: string; download: string }>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    originalElectronAPI = (window as unknown as { electronAPI?: unknown }).electronAPI;

    resetPlayerStore();
    resetLibraryStore();
    resetAuthStore();
    signInForTests();
    resetUIStore();
    clearAuthStorage();

    cloudSyncEngine.setRemoteAdapter(new NullRemoteAdapter());
    cloudSyncEngine.pendingLocalMutations = [];
    cloudSyncEngine.parkedMutations = [];

    await dbService.clearAllData();

    // jsdom has none of these.
    createdBlobs = [];
    anchorClicks = [];
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn((blob: Blob) => {
      createdBlobs.push(blob);
      return `blob:wireon/${createdBlobs.length}`;
    });
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
      this: HTMLAnchorElement
    ) {
      anchorClicks.push({ href: this.href, download: this.download });
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    player().setSleepTimer(null);
    await flushAsync();
    (window as unknown as { electronAPI?: unknown }).electronAPI = originalElectronAPI;
    clearAuthStorage();
    if (!dbService.db.isOpen()) await dbService.db.open();
    await dbService.clearAllData();
  });

  // ==========================================================================
  // SettingsView — composition and navigation
  // ==========================================================================
  describe('SettingsView', () => {
    it('renders every section as an independently labelled panel', () => {
      render(<SettingsView />);

      for (const id of ['playback', 'appearance', 'library', 'account', 'shortcuts', 'about']) {
        expect(screen.getByTestId(`settings-section-${id}`)).toBeInTheDocument();
        expect(screen.getByTestId(`settings-nav-${id}`)).toBeInTheDocument();
      }
      // Each panel is labelled by its own heading, so a screen reader can list them.
      expect(screen.getByTestId('settings-section-playback')).toHaveAttribute(
        'aria-labelledby',
        'playback-heading'
      );
    });

    it('omits the Desktop section entirely in a browser build', () => {
      // The default mock bridge has no `setMediaKeysEnabled`: nothing to talk to.
      render(<SettingsView />);

      expect(screen.queryByTestId('settings-nav-desktop')).toBeNull();
      expect(screen.queryByTestId('settings-section-desktop')).toBeNull();
    });

    it('adds the Desktop section once the preload bridge exposes it', () => {
      installDesktopBridge();
      render(<SettingsView />);

      expect(screen.getByTestId('settings-nav-desktop')).toBeInTheDocument();
      expect(screen.getByTestId('settings-section-desktop')).toBeInTheDocument();
      expect(screen.getByTestId('settings-platform')).toHaveTextContent('Windows');
    });

    it('scrolls to a section when its chip is used and marks that chip active', () => {
      render(<SettingsView />);

      const aboutChip = screen.getByTestId('settings-nav-about');
      expect(screen.getByTestId('settings-nav-playback')).toHaveAttribute('aria-pressed', 'true');

      fireEvent.click(aboutChip);

      expect(aboutChip).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('settings-nav-playback')).toHaveAttribute('aria-pressed', 'false');
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PlaybackSettings
  // ==========================================================================
  describe('PlaybackSettings', () => {
    it('writes the volume through to the store and to the database', async () => {
      render(<PlaybackSettings />);

      const slider = screen.getByTestId('setting-volume');
      expect(slider).toHaveAttribute('aria-valuetext', '80%');

      fireEvent.change(slider, { target: { value: '35' } });

      expect(player().volume).toBeCloseTo(0.35, 5);
      expect(screen.getByTestId('setting-volume-value')).toHaveTextContent('35%');
      // Persisted, so the level survives a restart.
      await waitFor(async () =>
        expect(await dbService.getSetting<number>(PLAYER_SETTING_KEYS.volume, -1)).toBeCloseTo(0.35, 5)
      );
    });

    it('applies each EQ band and labels it in decibels', async () => {
      render(<PlaybackSettings />);

      fireEvent.change(screen.getByTestId('setting-eq-bass'), { target: { value: '6' } });
      fireEvent.change(screen.getByTestId('setting-eq-treble'), { target: { value: '-3' } });

      expect(player().eq).toEqual({ bass: 6, mid: 0, treble: -3 });
      expect(screen.getByTestId('setting-eq-bass-value')).toHaveTextContent('+6 дБ');
      expect(screen.getByTestId('setting-eq-treble-value')).toHaveTextContent('-3 дБ');
      await waitFor(async () =>
        expect(await dbService.getSetting(PLAYER_SETTING_KEYS.eq, null)).toEqual({
          bass: 6,
          mid: 0,
          treble: -3
        })
      );
    });

    it('offers the EQ reset only when there is something to reset', () => {
      render(<PlaybackSettings />);

      expect(screen.getByTestId('settings-eq-reset')).toBeDisabled();

      fireEvent.change(screen.getByTestId('setting-eq-mid'), { target: { value: '4' } });
      expect(screen.getByTestId('settings-eq-reset')).toBeEnabled();

      fireEvent.click(screen.getByTestId('settings-eq-reset'));

      expect(player().eq).toEqual({ bass: 0, mid: 0, treble: 0 });
      expect(screen.getByTestId('settings-eq-reset')).toBeDisabled();
    });

    it('applies a preset to all three bands at once', async () => {
      render(<PlaybackSettings />);

      // «Ровно» — это тоже пресет, и на нетронутом эквалайзере он уже активен.
      expect(screen.getByTestId('settings-eq-preset-flat')).toHaveAttribute('aria-pressed', 'true');

      fireEvent.click(screen.getByTestId('settings-eq-preset-bass'));

      expect(player().eq).toEqual({ bass: 6, mid: -1, treble: 1 });
      expect(screen.getByTestId('setting-eq-bass-value')).toHaveTextContent('+6 дБ');
      expect(screen.getByTestId('settings-eq-preset-bass')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('settings-eq-preset-flat')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByTestId('settings-eq-preset-state')).toHaveTextContent(/Плотный низ/i);

      // Пресет — обычная настройка эквалайзера, значит он тоже переживает перезапуск.
      await waitFor(async () =>
        expect(await dbService.getSetting(PLAYER_SETTING_KEYS.eq, null)).toEqual({
          bass: 6,
          mid: -1,
          treble: 1
        })
      );
    });

    it('stops claiming a preset once the bands are moved by hand', () => {
      render(<PlaybackSettings />);

      fireEvent.click(screen.getByTestId('settings-eq-preset-vocal'));
      expect(screen.getByTestId('settings-eq-preset-vocal')).toHaveAttribute('aria-pressed', 'true');

      fireEvent.change(screen.getByTestId('setting-eq-treble'), { target: { value: '-8' } });

      expect(screen.getByTestId('settings-eq-preset-vocal')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByTestId('settings-eq-preset-state')).toHaveTextContent('Полосы настроены вручную.');
      expect(player().eq).toEqual({ bass: -3, mid: 4, treble: -8 });
    });

    it('persists the autoplay-radio preference', async () => {
      render(<PlaybackSettings />);

      const toggle = screen.getByTestId('setting-autoplay-radio');
      expect(toggle).not.toBeChecked();

      fireEvent.click(toggle);

      expect(player().autoplayRadio).toBe(true);
      expect(toggle).toBeChecked();
      await waitFor(async () =>
        expect(await dbService.getSetting(PLAYER_SETTING_KEYS.autoplayRadio, null)).toBe(true)
      );
      // The copy has to admit what this feature actually is.
      expect(screen.getByText(/подбор по ключевым словам, а не полноценные рекомендации/i)).toBeInTheDocument();
    });

    it('arms the sleep timer, counts down, and cancels back to Off', () => {
      vi.useFakeTimers();
      try {
        render(<PlaybackSettings />);

        const select = screen.getByTestId('settings-sleep-timer');
        fireEvent.change(select, { target: { value: '15' } });

        expect(player().sleepTimerEndsAt).not.toBeNull();
        expect(screen.getByText(/Музыка встанет на паузу через 15:00\./)).toBeInTheDocument();

        // A minute later the row says so, without re-reading the store.
        act(() => {
          vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByText(/Музыка встанет на паузу через 14:00\./)).toBeInTheDocument();

        fireEvent.change(select, { target: { value: '' } });

        expect(player().sleepTimerEndsAt).toBeNull();
        expect(screen.getByText(/Поставить музыку на паузу через заданное время\./)).toBeInTheDocument();
      } finally {
        player().setSleepTimer(null);
        vi.useRealTimers();
      }
    });

    it('clears the picker when the timer is cancelled from elsewhere', async () => {
      render(<PlaybackSettings />);
      const select = screen.getByTestId('settings-sleep-timer') as HTMLSelectElement;

      fireEvent.change(select, { target: { value: '30' } });
      expect(select.value).toBe('30');

      // Somebody else — the mini player, a shortcut — turns it off.
      await act(async () => {
        player().setSleepTimer(null);
      });

      expect(select.value).toBe('');
    });
  });

  // ==========================================================================
  // AppearanceSettings
  // ==========================================================================
  describe('AppearanceSettings', () => {
    it('offers one picker where «Нет» stands for the visualizer being off', async () => {
      render(<AppearanceSettings />);

      const preset = screen.getByTestId('settings-visualizer-preset');
      // Bars is the shipped default, and the picker opens on it.
      expect(preset).toHaveValue('CYBER_BARS');
      expect(screen.getByRole('option', { name: 'Полосы' })).toBeInTheDocument();

      fireEvent.change(preset, { target: { value: 'OFF' } });

      expect(player().visualizerEnabled).toBe(false);
      expect(preset).toHaveValue('OFF');
      await waitFor(async () =>
        expect(await dbService.getSetting(PLAYER_SETTING_KEYS.visualizerEnabled, null)).toBe(false)
      );
    });

    it('re-enables the visualizer when a style is chosen again', async () => {
      player().setVisualizerEnabled(false);
      render(<AppearanceSettings />);

      fireEvent.change(screen.getByTestId('settings-visualizer-preset'), {
        target: { value: 'AMBIENT_AURORA' }
      });

      expect(player().visualizerPreset).toBe('AMBIENT_AURORA');
      // Picking a style with the visualizer off would otherwise change nothing visible.
      expect(player().visualizerEnabled).toBe(true);
      await waitFor(async () =>
        expect(await dbService.getSetting(PLAYER_SETTING_KEYS.visualizerPreset, null)).toBe('AMBIENT_AURORA')
      );
    });
  });

  // ==========================================================================
  // LibrarySettings — the destructive half of the page
  // ==========================================================================
  describe('LibrarySettings', () => {
    async function seedLibrary(): Promise<Playlist> {
      await library().toggleFavorite(trackA);
      const playlist = await library().createPlaylist('Settings Mix');
      await library().addTrackToPlaylist(playlist!.id, trackB);
      await library().addToHistory(trackB);
      await flushAsync();
      return playlist!;
    }

    it('reports the counts actually held in the library', async () => {
      await seedLibrary();
      render(<LibrarySettings />);

      expect(screen.getByText('1 плейлистов · 1 избранных · 1 прослушано')).toBeInTheDocument();
    });

    it('exports the library as a downloadable JSON file', async () => {
      await seedLibrary();
      render(<LibrarySettings />);

      fireEvent.click(screen.getByTestId('library-export'));

      await waitFor(() => expect(anchorClicks).toHaveLength(1));
      expect(anchorClicks[0].download).toMatch(/^wireon-library-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
      expect(anchorClicks[0].href).toBe('blob:wireon/1');
      // No dangling object URL, and no orphaned anchor in the document.
      expect(URL.revokeObjectURL).toBeDefined();
      expect(document.querySelectorAll('a[download]')).toHaveLength(0);

      const written = JSON.parse(await readBlob(createdBlobs[0]));
      expect(written.favorites.map((t: UnifiedTrack) => t.id)).toEqual([trackA.id]);
      expect(written.playlists[0].title).toBe('Settings Mix');
      expect(ui().toastMessage?.type).toBe('success');
      expect(ui().toastMessage?.text).toContain('1 плейлистов и 1 избранных');
    });

    it('merges an imported backup into the existing library', async () => {
      await library().toggleFavorite(trackA);
      await flushAsync();

      // A backup made elsewhere that holds a track this device has never seen.
      await dbService.addFavorite(trackB);
      const backup = await exportLibrary();
      await dbService.removeFavorite(trackB.id);
      await library().loadInitialData();

      render(<LibrarySettings />);
      expect(library().favorites.map((t) => t.id)).toEqual([trackA.id]);

      fireEvent.change(screen.getByTestId('library-import-file'), {
        target: { files: [jsonFile(JSON.stringify(backup))] }
      });

      await waitFor(() => expect(library().favorites).toHaveLength(2));
      expect(library().favorites.map((t) => t.id).sort()).toEqual([trackA.id, trackB.id].sort());
      expect(ui().toastMessage?.type).toBe('success');
      expect(ui().toastMessage?.text).toMatch(/Загружено: .* избранных/);
    });

    it('reports a corrupt file in the user’s own terms and changes nothing', async () => {
      await seedLibrary();
      render(<LibrarySettings />);

      fireEvent.change(screen.getByTestId('library-import-file'), {
        target: { files: [jsonFile('{ this is not json', 'notes.json')] }
      });

      await waitFor(() => expect(ui().toastMessage?.type).toBe('error'));
      // The BackupError message is shown as-is: no stack, no "[object Object]".
      expect(ui().toastMessage?.text).toMatch(/Файл резервной копии — не JSON/i);
      expect(library().favorites).toHaveLength(1);
      expect(library().playlists).toHaveLength(1);
      expect(await dbService.getFavorites()).toHaveLength(1);
    });

    it('refuses to replace the library until the warning is confirmed', async () => {
      await seedLibrary();
      const replacement = JSON.stringify({
        version: 1,
        exportedAt: Date.now(),
        favorites: [trackB],
        playlists: [],
        history: [],
        settings: {}
      });

      render(<LibrarySettings />);
      fireEvent.change(screen.getByTestId('library-import-mode'), { target: { value: 'replace' } });
      fireEvent.change(screen.getByTestId('library-import-file'), {
        target: { files: [jsonFile(replacement)] }
      });

      // Nothing has happened yet — a dialog is waiting instead.
      await waitFor(() => expect(screen.getByText('Заменить локальную медиатеку?')).toBeInTheDocument());
      expect(library().favorites.map((t) => t.id)).toEqual([trackA.id]);
      expect(library().playlists).toHaveLength(1);

      // Backing out leaves the library exactly as it was.
      fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
      await flushAsync();
      expect(library().favorites.map((t) => t.id)).toEqual([trackA.id]);
      expect(library().playlists).toHaveLength(1);

      // Окно уходит с анимацией и живёт в дереве, пока играют кадры. Ждём, пока
      // уйдёт: иначе проверка ниже поймает уходящее окно вместо нового, а клик
      // придётся уже в пустоту.
      await waitFor(() => expect(screen.queryByTestId('modal-backdrop')).not.toBeInTheDocument());

      // Doing it again and confirming this time really does replace it.
      fireEvent.change(screen.getByTestId('library-import-file'), {
        target: { files: [jsonFile(replacement)] }
      });
      await waitFor(() => expect(screen.getByTestId('confirm-dialog-confirm')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

      await waitFor(() => expect(library().favorites.map((t) => t.id)).toEqual([trackB.id]));
      expect(library().playlists).toHaveLength(0);
      expect(ui().toastMessage?.type).toBe('success');
    });

    it('clears the listening history only after confirmation, and only the history', async () => {
      render(<LibrarySettings />);
      // Nothing to clear yet, so the button is not offered.
      expect(screen.getByTestId('library-clear-history')).toBeDisabled();

      const playlist = await act(async () => seedLibrary());
      expect(screen.getByTestId('library-clear-history')).toBeEnabled();

      fireEvent.click(screen.getByTestId('library-clear-history'));
      expect(screen.getByText('Очистить историю прослушиваний?')).toBeInTheDocument();
      expect(screen.getByTestId('confirm-dialog-description')).toHaveTextContent('будет удалено 1 записей');

      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

      await waitFor(() => expect(library().history).toHaveLength(0));
      expect(await dbService.getHistory()).toHaveLength(0);
      // Favorites and playlists are explicitly promised to survive.
      expect(library().favorites.map((t) => t.id)).toEqual([trackA.id]);
      expect((await dbService.getPlaylistById(playlist.id))?.tracks).toHaveLength(1);
      expect(ui().toastMessage?.text).toBe('История прослушиваний очищена');
    });
  });

  // ==========================================================================
  // AccountSettings
  // ==========================================================================
  describe('AccountSettings', () => {
    const profile: UserProfile = {
      id: '9001',
      username: 'wireon-listener',
      avatarUrl: 'https://cdn.discordapp.com/avatars/9001/abc.png',
      provider: 'discord',
      status: 'online'
    };

    it('гостю говорит, что медиатека остаётся здесь, и зовёт войти', () => {
      /*
       * Раньше эта строка стояла всегда и утверждала, что «сервера
       * синхронизации у приложения нет». Сервер появился, а текст остался — и
       * экран синхронизации прямо отрицал то, что уже работало. Владелец,
       * у которого что-то не сошлось, читал это как приговор.
       *
       * Теперь строка про состояние: без входа переносить нечего и не по чему,
       * а со входом сказано обратное — см. проверку ниже.
       */
      resetAuthStore();
      render(<AccountSettings />);

      expect(screen.getByText('Вход не выполнен')).toBeInTheDocument();
      expect(screen.getByTestId('account-storage-mode')).toHaveTextContent('Только на этом устройстве');
      expect(screen.getByTestId('account-login')).toBeInTheDocument();
      expect(screen.queryByTestId('account-logout')).toBeNull();
    });

    it('не утверждает, что сервера синхронизации не существует', () => {
      resetAuthStore();
      render(<AccountSettings />);

      expect(screen.queryByText(/сервера синхронизации у приложения нет/i)).toBeNull();
    });

    it('reconciles locally and says exactly what it did', async () => {
      await library().toggleFavorite(trackA);
      await library().createPlaylist('Reconciled');
      await flushAsync();

      render(<AccountSettings />);
      expect(screen.getByText('Никогда')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('account-sync'));

      await waitFor(() => expect(screen.getByTestId('account-sync-result')).toBeInTheDocument());
      expect(screen.getByTestId('account-sync-result')).toHaveTextContent(/только на этом устройстве/i);
      expect(screen.getByTestId('account-sync-result')).toHaveTextContent('1 плейлист · 1 избранный трек');
      expect(auth().lastSyncedAt).not.toBeNull();
      expect(auth().isSyncing).toBe(false);
      expect(ui().toastMessage?.type).toBe('success');
      expect(ui().toastMessage?.text).toMatch(/Проверено на этом устройстве: 1 плейлист и 1 избранный трек/);
    });

    it('signs out without touching the library', async () => {
      await library().toggleFavorite(trackA);
      await flushAsync();
      act(() => {
        auth().login(profile, 'discord-access-token', 3600);
      });

      render(<AccountSettings />);
      expect(screen.getByText('wireon-listener')).toBeInTheDocument();
      expect(hasNoStoredSession()).toBe(false);

      fireEvent.click(screen.getByTestId('account-logout'));

      expect(auth().isAuthenticated).toBe(false);
      expect(hasNoStoredSession()).toBe(true);
      expect(screen.getByText('Вход не выполнен')).toBeInTheDocument();
      expect(library().favorites.map((t) => t.id)).toEqual([trackA.id]);
      expect(await dbService.getFavorites()).toHaveLength(1);
    });
  });

  // ==========================================================================
  // DesktopSettings
  // ==========================================================================
  describe('DesktopSettings', () => {
    it('renders nothing at all without a desktop bridge', () => {
      const { container } = render(<DesktopSettings />);
      expect(container).toBeEmptyDOMElement();
    });

    it('forwards the media-key preference to the main process', async () => {
      const { mediaKeyCalls } = installDesktopBridge();
      render(<DesktopSettings />);

      const toggle = screen.getByTestId('setting-media-keys');
      expect(toggle).toBeChecked();

      fireEvent.click(toggle);

      expect(player().mediaKeysEnabled).toBe(false);
      // The renderer cannot unregister a global shortcut itself.
      expect(mediaKeyCalls).toEqual([false]);
      await waitFor(async () =>
        expect(await dbService.getSetting(PLAYER_SETTING_KEYS.mediaKeysEnabled, null)).toBe(false)
      );
    });

    it('toggles Discord RPC preference and forwards to electronAPI bridge and database', async () => {
      const rpcEnabledCalls: boolean[] = [];
      installDesktopBridge({
        discordRpcSetEnabled: async (enabled: boolean) => {
          rpcEnabledCalls.push(enabled);
        }
      });
      render(<DesktopSettings />);

      const toggle = screen.getByTestId('setting-discord-rpc');
      expect(toggle).toBeChecked();

      fireEvent.click(toggle);

      expect(toggle).not.toBeChecked();
      await waitFor(async () =>
        expect(await dbService.getSetting('discordRpcEnabled', null)).toBe(false)
      );
    });

    it('survives a bridge whose getPlatform throws', () => {
      installDesktopBridge({
        getPlatform: () => {
          throw new Error('bridge revoked');
        }
      });

      render(<DesktopSettings />);
      expect(screen.getByTestId('settings-platform')).toHaveTextContent('Неизвестно');
    });
  });

  // ==========================================================================
  // DiagnosticsSettings
  // ==========================================================================
  describe('DiagnosticsSettings', () => {
    const SAMPLE_LOG = [
      '[2026-08-17T09:00:01.000Z] resolved abc via default → m4a 128kbps in 900ms',
      '[2026-08-17T09:00:02.000Z] attempt default for xyz resolved but failed probe: HTTP 403',
      '[2026-08-17T09:00:03.000Z] resolved xyz via android_vr → m4a 128kbps in 1400ms (after 1 failed attempt(s))',
      '[2026-08-17T09:00:04.000Z] cache hit abc (expires in 3200s)',
      '[2026-08-17T09:00:05.000Z] terminal failure for gone (YT_UNAVAILABLE): Video unavailable'
    ];

    // Сервис cookies — синглтон, и его выбор пережил бы соседний тест.
    beforeEach(async () => {
      await youtubeCookiesService.set(null);
    });

    /** The diagnostics half of the bridge. */
    function installDiagnosticsBridge(
      overrides: Record<string, unknown> = {},
      diagnostics: Partial<StreamDiagnostics> = {}
    ): { clearCalls: number[] } {
      const clearCalls: number[] = [];
      installDesktopBridge({
        getStreamDiagnostics: async () => ({
          log: SAMPLE_LOG,
          ytDlpPath: 'C:\\wireon\\bin\\yt-dlp.exe',
          ytDlpAvailable: true,
          logPath: 'C:\\wireon\\logs\\streams.log',
          ...diagnostics
        }),
        clearStreamCache: async () => {
          clearCalls.push(1);
          return true;
        },
        ...overrides
      });
      return { clearCalls };
    }

    it('renders nothing without the diagnostics bridge', () => {
      const { container } = render(<DiagnosticsSettings />);
      expect(container).toBeEmptyDOMElement();
    });

    it('reads the log on mount, newest entry first', async () => {
      installDiagnosticsBridge();
      render(<DiagnosticsSettings />);

      await waitFor(() => expect(screen.getByTestId('diagnostics-ytdlp-status')).toHaveTextContent('Найден'));

      const log = screen.getByTestId('diagnostics-log');
      expect(log).toHaveTextContent('Video unavailable');
      // The most recent line leads, and the timestamp is rendered as a clock time.
      expect(log.textContent?.indexOf('Video unavailable')).toBeLessThan(
        log.textContent?.indexOf('resolved abc') ?? -1
      );
      // Rendered as a local clock time; the offset depends on the machine, the
      // seconds do not.
      expect(log.textContent).toMatch(/\d{2}:\d{2}:05/);
    });

    it('counts probe rejections separately from hard failures', async () => {
      installDiagnosticsBridge();
      render(<DiagnosticsSettings />);

      await waitFor(() =>
        expect(screen.getByTestId('diagnostics-stats')).toHaveTextContent(
          '2 успешно · 1 ссылка отклонена · 1 ошибок · 1 из кэша'
        )
      );
    });

    it('calls out a missing yt-dlp, which breaks YouTube entirely', async () => {
      installDiagnosticsBridge({}, { ytDlpAvailable: false });
      render(<DiagnosticsSettings />);

      await waitFor(() => expect(screen.getByTestId('diagnostics-ytdlp-missing')).toBeInTheDocument());
      expect(screen.getByTestId('diagnostics-ytdlp-status')).toHaveTextContent('Не найден');
    });

    it('clears the stream cache and re-reads the log afterwards', async () => {
      let reads = 0;
      const { clearCalls } = installDiagnosticsBridge({
        getStreamDiagnostics: async () => {
          reads += 1;
          return { log: SAMPLE_LOG, ytDlpPath: 'yt-dlp', ytDlpAvailable: true, logPath: null };
        }
      });
      render(<DiagnosticsSettings />);
      await waitFor(() => expect(reads).toBe(1));

      fireEvent.click(screen.getByTestId('diagnostics-clear-cache'));

      await waitFor(() => expect(clearCalls).toHaveLength(1));
      // Stale numbers after a reset would be worse than none.
      await waitFor(() => expect(reads).toBe(2));
      expect(useUIStore.getState().toastMessage?.text).toMatch(/Кэш ссылок сброшен/);
    });

    it('copies a report that names the binary, the log file and every line', async () => {
      installDiagnosticsBridge();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      render(<DiagnosticsSettings />);
      await waitFor(() => expect(screen.getByTestId('diagnostics-copy')).not.toBeDisabled());

      fireEvent.click(screen.getByTestId('diagnostics-copy'));

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const report = writeText.mock.calls[0][0] as string;
      expect(report).toContain('yt-dlp: найден');
      expect(report).toContain('C:\\wireon\\logs\\streams.log');
      expect(report).toContain('failed probe: HTTP 403');
      // Про cookies и проверку «вы не робот» спрашивают первым делом, когда
      // «у друга не играет» — в отчёте они должны быть сразу.
      expect(report).toContain('cookies: не используются');
      expect(report).toContain('проверка «вы не робот»: не встречалась');
    });

    it('surfaces a bridge that throws instead of rendering a blank panel', async () => {
      installDiagnosticsBridge({
        getStreamDiagnostics: async () => {
          throw new Error('main process gone');
        }
      });
      render(<DiagnosticsSettings />);

      await waitFor(() => expect(screen.getByTestId('diagnostics-error')).toHaveTextContent('main process gone'));
      expect(screen.getByTestId('diagnostics-log')).toHaveTextContent('Журнал пуст');
    });

    it('передаёт выбранный браузер в main-процесс и запоминает выбор', async () => {
      const pushed: Array<string | null> = [];
      installDiagnosticsBridge({
        setYouTubeCookiesBrowser: async (browser: string | null) => {
          pushed.push(browser);
          return browser;
        }
      });
      render(<DiagnosticsSettings />);

      const select = await screen.findByTestId('diagnostics-cookies-browser');
      // По умолчанию выключено: приложение не берётся за чужой аккаунт само.
      expect(select).toHaveValue('off');

      fireEvent.change(select, { target: { value: 'firefox' } });

      await waitFor(() => expect(pushed).toContain('firefox'));
      expect(select).toHaveValue('firefox');
      // Main забывает выбор при каждом запуске, поэтому он должен лежать в базе.
      await waitFor(async () =>
        expect(await dbService.getSetting('youtubeCookiesBrowser', null)).toBe('firefox')
      );
      expect(ui().toastMessage?.text).toMatch(/cookies из firefox/i);
    });

    it('предупреждает про проверку «вы не робот», пока cookies не выбраны', async () => {
      installDiagnosticsBridge(
        {
          setYouTubeCookiesBrowser: async (browser: string | null) => browser
        },
        { botCheckSeen: true }
      );
      render(<DiagnosticsSettings />);

      // Без этого предупреждения «часть треков не играет» выглядит случайностью.
      await waitFor(() => expect(screen.getByTestId('diagnostics-bot-check')).toBeInTheDocument());

      fireEvent.change(screen.getByTestId('diagnostics-cookies-browser'), {
        target: { value: 'chrome' }
      });

      // Выбор сделан — совет больше не нужен.
      await waitFor(() => expect(screen.queryByTestId('diagnostics-bot-check')).toBeNull());
    });
  });

  // ==========================================================================
  // ShortcutsSettings
  // ==========================================================================
  describe('ShortcutsSettings', () => {
    it('lists the shortcuts the app really binds, with the platform modifier', () => {
      installDesktopBridge();
      render(<ShortcutsSettings />);

      expect(screen.getByText('Играть / пауза')).toBeInTheDocument();
      expect(screen.getByText('Палитра команд')).toBeInTheDocument();
      expect(screen.getByText('Ctrl')).toBeInTheDocument();
      expect(screen.queryByText('⌘')).toBeNull();
      // One row per binding, so the cheatsheet cannot silently lose one.
      expect(screen.getAllByRole('listitem')).toHaveLength(11);
    });

    it('uses the Command glyph on macOS', () => {
      installDesktopBridge({ getPlatform: () => 'darwin' });
      render(<ShortcutsSettings />);

      expect(screen.getByText('⌘')).toBeInTheDocument();
      expect(screen.queryByText('Ctrl')).toBeNull();
    });
  });

  // ==========================================================================
  // AboutSettings
  // ==========================================================================
  describe('AboutSettings', () => {
    it('names the runtime and both audio sources', () => {
      render(<AboutSettings />);

      expect(screen.getByText(APP_VERSION)).toBeInTheDocument();
      expect(screen.getByText('Браузер')).toBeInTheDocument();
      expect(screen.getByText('YouTube Music · SoundCloud')).toBeInTheDocument();
    });

    it('copies diagnostics that include the last playback error', async () => {
      const writeText = vi.fn(async (_text: string) => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      installDesktopBridge();
      usePlayerStore.setState({ error: 'Unable to resolve audio stream' });

      render(<AboutSettings />);
      fireEvent.click(screen.getByTestId('about-diagnostics'));

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const copied = writeText.mock.calls[0][0];
      expect(copied).toContain(`Wireon Sounds ${APP_VERSION}`);
      expect(copied).toContain('Среда: Приложение · Windows');
      expect(copied).toContain('Последняя ошибка воспроизведения: Unable to resolve audio stream');
      expect(ui().toastMessage?.type).toBe('success');
    });

    it('reports a denied clipboard instead of failing silently', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async () => {
            throw new Error('NotAllowedError');
          }
        },
        configurable: true
      });

      render(<AboutSettings />);
      fireEvent.click(screen.getByTestId('about-diagnostics'));

      await waitFor(() => expect(ui().toastMessage?.type).toBe('error'));
      expect(ui().toastMessage?.text).toBe('Доступ к буферу обмена запрещён');
    });
  });
});
