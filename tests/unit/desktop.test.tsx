import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Define hoisted mocks
const {
  mockIpcSend,
  mockIpcInvoke,
  mockIpcOn,
  mockIpcRemoveListener,
  mockIpcMainOn,
  mockIpcMainHandle,
  mockGlobalShortcutRegister,
  mockGlobalShortcutUnregister,
  mockGlobalShortcutUnregisterAll,
  mockBrowserWindowConstructor,
  mockShellOpenExternal,
  mockSetAsDefaultProtocolClient,
  mockRemoveAsDefaultProtocolClient,
  appPaths,
  privilegedSchemes,
  createdWindows,
} = vi.hoisted(() => {
  const createdWindows: any[] = [];
  const privilegedSchemes: any[] = [];
  const mockBrowserWindowConstructor = vi.fn().mockImplementation((options) => {
    const windowListeners: Record<string, Function> = {};
    const contentsListeners: Record<string, Function> = {};
    const win = {
      options,
      windowListeners,
      contentsListeners,
      isDestroyed: vi.fn().mockReturnValue(false),
      isVisible: vi.fn().mockReturnValue(false),
      isMinimized: vi.fn().mockReturnValue(false),
      isMaximized: vi.fn().mockReturnValue(false),
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      restore: vi.fn(),
      close: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      once: vi.fn((event: string, cb: Function) => {
        windowListeners[event] = cb;
      }),
      on: vi.fn((event: string, cb: Function) => {
        windowListeners[event] = cb;
      }),
      webContents: {
        send: vi.fn(),
        focus: vi.fn(),
        getURL: vi.fn().mockReturnValue('file:///app/dist/index.html'),
        executeJavaScript: vi.fn().mockResolvedValue('object'),
        on: vi.fn((event: string, cb: Function) => {
          contentsListeners[event] = cb;
        }),
        once: vi.fn((event: string, cb: Function) => {
          contentsListeners[event] = cb;
        }),
      },
    };
    createdWindows.push(win);
    return win;
  });

  return {
    mockIpcSend: vi.fn(),
    mockIpcInvoke: vi.fn(),
    mockIpcOn: vi.fn(),
    mockIpcRemoveListener: vi.fn(),
    mockIpcMainOn: vi.fn(),
    mockIpcMainHandle: vi.fn(),
    mockGlobalShortcutRegister: vi.fn(),
    mockGlobalShortcutUnregister: vi.fn(),
    mockGlobalShortcutUnregisterAll: vi.fn(),
    mockBrowserWindowConstructor,
    mockShellOpenExternal: vi.fn().mockResolvedValue(undefined),
    mockSetAsDefaultProtocolClient: vi.fn().mockReturnValue(true),
    mockRemoveAsDefaultProtocolClient: vi.fn().mockReturnValue(true),
    // Empty at import time on purpose: `migrateLegacyUserData()` runs as a side
    // effect of importing main.ts, and with no userData path it bails out before
    // touching the filesystem. Tests point it at a temp profile themselves.
    appPaths: { userData: '' } as Record<string, string>,
    privilegedSchemes,
    createdWindows,
  };
});

vi.mock('electron', () => ({
  ipcRenderer: {
    send: (...args: any[]) => mockIpcSend(...args),
    invoke: (...args: any[]) => mockIpcInvoke(...args),
    on: (...args: any[]) => mockIpcOn(...args),
    removeListener: (...args: any[]) => mockIpcRemoveListener(...args),
  },
  ipcMain: {
    on: (...args: any[]) => mockIpcMainOn(...args),
    handle: (...args: any[]) => mockIpcMainHandle(...args),
  },
  globalShortcut: {
    register: (...args: any[]) => mockGlobalShortcutRegister(...args),
    unregister: (...args: any[]) => mockGlobalShortcutUnregister(...args),
    unregisterAll: (...args: any[]) => mockGlobalShortcutUnregisterAll(...args),
  },
  BrowserWindow: Object.assign(mockBrowserWindowConstructor, {
    getAllWindows: vi.fn().mockReturnValue([]),
  }),
  app: {
    isPackaged: false,
    whenReady: vi.fn().mockResolvedValue(undefined),
    requestSingleInstanceLock: vi.fn().mockReturnValue(true),
    setAsDefaultProtocolClient: (...args: any[]) => mockSetAsDefaultProtocolClient(...args),
    removeAsDefaultProtocolClient: (...args: any[]) => mockRemoveAsDefaultProtocolClient(...args),
    getPath: (name: string) => appPaths[name] ?? '',
    on: vi.fn(),
    quit: vi.fn(),
  },
  protocol: {
    // Recorded in a plain array: this runs at import time, before any beforeEach
    // clears the mocks.
    registerSchemesAsPrivileged: (schemes: any[]) => privilegedSchemes.push(...schemes),
  },
  shell: {
    openExternal: (...args: any[]) => mockShellOpenExternal(...args),
  },
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  session: {
    defaultSession: {
      webRequest: {
        onBeforeSendHeaders: vi.fn(),
        onHeadersReceived: vi.fn(),
      },
    },
  },
}));

// Import Header component to test desktop titlebar integration
import { Header } from '../../src/components/layout/Header';
import type { ElectronAPI } from '../../src/types/electron';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { recommendationEngine } from '../../src/services/recommendationEngine';
import { MediaSessionService } from '../../src/services/mediaSession';
import { WaveView } from '../../src/components/wave/WaveView';
import { UnifiedTrack } from '../../src/types/music';

// Import functions from electron main and preload modules
import {
  buildContentSecurityPolicy,
  buildLoadErrorPage,
  createWindow,
  deliverDeepLink,
  extractDeepLinkUrl,
  flushPendingDeepLink,
  focusMainWindow,
  getAppDir,
  getAppRoot,
  getIndexHtmlPath,
  getPreloadPath,
  getStreamResolver,
  getWindowIconPath,
  isAppContentUrl,
  isExternallyOpenableUrl,
  isStreamingHost,
  migrateLegacyUserData,
  DEEP_LINK_SCHEMES,
  registerDeepLinkProtocol,
  registerMediaKeys,
  resetDeepLinkState,
  rewriteRequestHeaders,
  setMainWindow,
  setupIpcHandlers,
  setupSessionHeaders,
  setupWindowStateListeners,
  targetUrls,
  unregisterMediaKeys,
} from '../../electron/main';
import { electronAPI } from '../../electron/preload';
import {
  DISCORD_AUTH_REDIRECT,
  DISCORD_AUTH_SCHEME,
  DISCORD_CLIENT_ID,
} from '../../electron/authWindow';
import {
  DEFAULT_DISCORD_CLIENT_ID,
  appSchemeRedirectUri,
} from '../../src/services/discordAuth';

const ROOT = process.cwd();
const readRoot = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf-8');

/**
 * The window background is read out of the token file instead of being repeated
 * here. A hardcoded copy silently drifts from the palette, and the window would
 * flash the old colour on open while the test still passed.
 */
function baseColourFromTokens(): string {
  const match = /--bg-base:\s*(#[0-9a-fA-F]{6})/.exec(
    readRoot(path.join('src', 'styles', 'theme.css'))
  );
  if (!match) throw new Error('theme.css no longer declares --bg-base as a 6-digit hex');
  return match[1].toUpperCase();
}

function makeMockWindow() {
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    isMinimized: vi.fn().mockReturnValue(false),
    isMaximized: vi.fn().mockReturnValue(false),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    webContents: { send: vi.fn() },
    on: vi.fn(),
  };
}

describe('Milestone 5: Desktop Packaging & Electron Integration Test Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Release the pending "show anyway" safety timers of any window created here.
    createdWindows.forEach((win) => win.windowListeners['closed']?.());
    createdWindows.length = 0;
    setMainWindow(null);
    resetDeepLinkState();
  });

  // =========================================================================
  // 1. Electron Preload & ContextBridge API (electron/preload.ts)
  // =========================================================================
  describe('Preload & ContextBridge API (electron/preload.ts)', () => {
    it('exposes exactly the documented bridge surface', () => {
      expect(Object.keys(electronAPI).sort()).toEqual(
        [
          'checkForUpdates',
          'clearStreamCache',
          'close',
          'closeMiniWindow',
          'discordDeepLinkReady',
          'discordForgetSession',
          'discordLogin',
          'discordRpcSetActivity',
          'discordRpcSetEnabled',
          'discordRpcStatus',
          'playbackLog',
          'getPlatform',
          'getStreamDiagnostics',
          'getUpdateState',
          'installUpdate',
          'isAlwaysOnTop',
          'isMaximized',
          'isMiniWindow',
          'isMiniWindowOpen',
          'maximize',
          'minimize',
          'onDeepLink',
          'onMediaKey',
          'onMiniCommand',
          'onMiniState',
          'onMiniWindowVisibility',
          'onUpdateState',
          'onWindowStateChange',
          'openExternal',
          'openMiniWindow',
          'resolveYouTubeStream',
          'searchSoundCloud',
          'searchYouTube',
          'sendMiniCommand',
          'sendMiniState',
          'setAlwaysOnTop',
          'setMediaKeysEnabled',
          'setMiniPlayerMode',
          'setYouTubeCookiesBrowser',
          'transcodeAudio',
          'transcodeAvailable',
          'youtubeRadio',
        ].sort()
      );
    });

    it('minimize sends window-minimize IPC event', () => {
      electronAPI.minimize();
      expect(mockIpcSend).toHaveBeenCalledWith('window-minimize');
    });

    it('maximize sends window-maximize IPC event', () => {
      electronAPI.maximize();
      expect(mockIpcSend).toHaveBeenCalledWith('window-maximize');
    });

    it('close sends window-close IPC event', () => {
      electronAPI.close();
      expect(mockIpcSend).toHaveBeenCalledWith('window-close');
    });

    it('isMaximized invokes window-is-maximized IPC and resolves boolean', async () => {
      mockIpcInvoke.mockResolvedValueOnce(true);
      const isMax = await electronAPI.isMaximized();
      expect(mockIpcInvoke).toHaveBeenCalledWith('window-is-maximized');
      expect(isMax).toBe(true);

      mockIpcInvoke.mockResolvedValueOnce(false);
      const isNotMax = await electronAPI.isMaximized();
      expect(isNotMax).toBe(false);
    });

    it('youtubeRadio invokes youtube-radio IPC with the seed video id', async () => {
      // Радио YouTube Music живёт в главном процессе: из renderer запрос не
      // выпускает CORS, поэтому весь путь — через этот мост.
      mockIpcInvoke.mockResolvedValueOnce({ contents: {} });
      const payload = await electronAPI.youtubeRadio('seed0000001');
      expect(mockIpcInvoke).toHaveBeenCalledWith('youtube-radio', 'seed0000001');
      expect(payload).toEqual({ contents: {} });
    });

    it('getPlatform returns current platform string', () => {
      const platform = electronAPI.getPlatform();
      expect(typeof platform).toBe('string');
      expect(platform.length).toBeGreaterThan(0);
    });

    it('onWindowStateChange forwards the raw boolean payload', () => {
      const callback = vi.fn();
      const unsubscribe = electronAPI.onWindowStateChange(callback);

      expect(mockIpcOn).toHaveBeenCalledWith('window-state-changed', expect.any(Function));

      const handler = mockIpcOn.mock.calls.find((call) => call[0] === 'window-state-changed')?.[1];
      handler({}, true);
      expect(callback).toHaveBeenCalledWith(true);

      handler({}, false);
      expect(callback).toHaveBeenLastCalledWith(false);

      unsubscribe();
      expect(mockIpcRemoveListener).toHaveBeenCalledWith('window-state-changed', handler);
    });

    it('onMediaKey subscribes to media-key-event and unsubscribes cleanly', () => {
      const callback = vi.fn();
      const unsubscribe = electronAPI.onMediaKey(callback);

      expect(mockIpcOn).toHaveBeenCalledWith('media-key-event', expect.any(Function));

      const handler = mockIpcOn.mock.calls.find((call) => call[0] === 'media-key-event')?.[1];
      expect(handler).toBeDefined();

      (['play-pause', 'next', 'prev', 'stop'] as const).forEach((action) => {
        handler({}, action);
        expect(callback).toHaveBeenLastCalledWith(action);
      });

      unsubscribe();
      expect(mockIpcRemoveListener).toHaveBeenCalledWith('media-key-event', handler);
    });

    it('setMediaKeysEnabled sends the toggle to the main process', () => {
      electronAPI.setMediaKeysEnabled(false);
      expect(mockIpcSend).toHaveBeenCalledWith('set-media-keys-enabled', false);

      electronAPI.setMediaKeysEnabled(true);
      expect(mockIpcSend).toHaveBeenLastCalledWith('set-media-keys-enabled', true);
    });

    it('openExternal delegates the URL to the main process for validation', async () => {
      mockIpcInvoke.mockResolvedValueOnce(undefined);
      await electronAPI.openExternal('https://discord.com/oauth2/authorize');
      expect(mockIpcInvoke).toHaveBeenCalledWith(
        'open-external',
        'https://discord.com/oauth2/authorize'
      );
    });

    it('openExternal surfaces a main-process rejection to the caller', async () => {
      mockIpcInvoke.mockRejectedValueOnce(new Error('Refused to open a URL that is not http(s)'));
      await expect(electronAPI.openExternal('file:///C:/Windows/system32/cmd.exe')).rejects.toThrow(
        /not http/
      );
    });

    it('onDeepLink forwards the URL verbatim and returns a working unsubscribe', () => {
      const callback = vi.fn();
      const unsubscribe = electronAPI.onDeepLink(callback);

      expect(typeof unsubscribe).toBe('function');
      expect(mockIpcOn).toHaveBeenCalledWith('deep-link', expect.any(Function));

      const handler = mockIpcOn.mock.calls.find((call) => call[0] === 'deep-link')?.[1];
      expect(handler).toBeDefined();

      // The access token rides in the fragment — nothing may be stripped.
      const callbackUrl = 'wireon://auth/callback#access_token=abc.def&state=xyz&token_type=Bearer';
      handler({}, callbackUrl);
      expect(callback).toHaveBeenCalledWith(callbackUrl);

      unsubscribe();
      expect(mockIpcRemoveListener).toHaveBeenCalledWith('deep-link', handler);
    });
  });

  // =========================================================================
  // 2. Electron Main Process IPC Handlers & Logic (electron/main.ts)
  // =========================================================================
  describe('Main Process Logic (electron/main.ts)', () => {
    let mockWin: ReturnType<typeof makeMockWindow>;
    let registeredIpcListeners: Record<string, Function>;
    let registeredIpcHandlers: Record<string, Function>;
    let mockShortcuts: any;
    let registeredShortcuts: Record<string, Function>;

    beforeEach(() => {
      registeredIpcListeners = {};
      registeredIpcHandlers = {};
      registeredShortcuts = {};
      mockWin = makeMockWindow();

      mockShortcuts = {
        register: vi.fn((key: string, callback: Function) => {
          registeredShortcuts[key] = callback;
        }),
        unregister: vi.fn(),
        unregisterAll: vi.fn(),
      };

      const mockIpcMain = {
        on: vi.fn((channel: string, listener: Function) => {
          registeredIpcListeners[channel] = listener;
        }),
        handle: vi.fn((channel: string, handler: Function) => {
          registeredIpcHandlers[channel] = handler;
        }),
      } as any;

      setupIpcHandlers(mockIpcMain, () => mockWin as any, mockShortcuts);
    });

    it('registers all required IPC channels', () => {
      expect(registeredIpcListeners['window-minimize']).toBeDefined();
      expect(registeredIpcListeners['window-maximize']).toBeDefined();
      expect(registeredIpcListeners['window-close']).toBeDefined();
      expect(registeredIpcListeners['set-media-keys-enabled']).toBeDefined();
      expect(registeredIpcHandlers['window-is-maximized']).toBeDefined();
      expect(registeredIpcHandlers['open-external']).toBeDefined();
      expect(registeredIpcHandlers['resolve-youtube-stream']).toBeDefined();
      expect(registeredIpcHandlers['search-youtube']).toBeDefined();
      expect(registeredIpcHandlers['search-soundcloud']).toBeDefined();
      expect(registeredIpcHandlers['discord-rpc-set-activity']).toBeDefined();
      expect(registeredIpcHandlers['discord-rpc-set-enabled']).toBeDefined();
      expect(registeredIpcHandlers['get-stream-diagnostics']).toBeDefined();
      expect(registeredIpcHandlers['set-youtube-cookies-browser']).toBeDefined();
    });

    it('set-youtube-cookies-browser applies a known browser and refuses anything else', async () => {
      // Значение приходит из renderer и уезжает в аргументы дочернего процесса,
      // поэтому проверяется здесь, а не только в выпадающем списке настроек.
      await expect(registeredIpcHandlers['set-youtube-cookies-browser']({}, ' Firefox ')).resolves.toBe(
        'firefox'
      );
      expect(getStreamResolver().getCookiesFromBrowser()).toBe('firefox');

      await expect(
        registeredIpcHandlers['set-youtube-cookies-browser']({}, 'chrome; rm -rf /')
      ).resolves.toBeNull();
      expect(getStreamResolver().getCookiesFromBrowser()).toBeNull();
    });

    it('get-stream-diagnostics reports the cookie source and the bot check', async () => {
      const diagnostics = await registeredIpcHandlers['get-stream-diagnostics']({});

      // Панель диагностики строит по этим двум полям и совет, и предупреждение.
      expect(diagnostics).toMatchObject({ cookiesBrowser: null, botCheckSeen: false });

      await registeredIpcHandlers['set-youtube-cookies-browser']({}, 'edge');
      expect((await registeredIpcHandlers['get-stream-diagnostics']({})).cookiesBrowser).toBe('edge');

      await registeredIpcHandlers['set-youtube-cookies-browser']({}, null);
    });

    it('window-minimize handler minimizes the window', () => {
      registeredIpcListeners['window-minimize']();
      expect(mockWin.minimize).toHaveBeenCalledTimes(1);
    });

    it('window-maximize handler maximizes when unmaximized and unmaximizes when maximized', () => {
      mockWin.isMaximized.mockReturnValue(false);
      registeredIpcListeners['window-maximize']();
      expect(mockWin.maximize).toHaveBeenCalledTimes(1);
      expect(mockWin.unmaximize).not.toHaveBeenCalled();

      mockWin.isMaximized.mockReturnValue(true);
      registeredIpcListeners['window-maximize']();
      expect(mockWin.unmaximize).toHaveBeenCalledTimes(1);
    });

    it('window-close handler closes the window', () => {
      registeredIpcListeners['window-close']();
      expect(mockWin.close).toHaveBeenCalledTimes(1);
    });

    it('window-is-maximized handle returns window maximized status', () => {
      mockWin.isMaximized.mockReturnValue(true);
      expect(registeredIpcHandlers['window-is-maximized']()).toBe(true);

      mockWin.isMaximized.mockReturnValue(false);
      expect(registeredIpcHandlers['window-is-maximized']()).toBe(false);
    });

    it('set-media-keys-enabled registers and unregisters the media keys', () => {
      registeredIpcListeners['set-media-keys-enabled']({}, false);
      expect(mockShortcuts.unregister).toHaveBeenCalledWith('MediaPlayPause');
      expect(mockShortcuts.unregister).toHaveBeenCalledWith('MediaNextTrack');
      expect(mockShortcuts.unregister).toHaveBeenCalledWith('MediaPreviousTrack');
      expect(mockShortcuts.unregister).toHaveBeenCalledWith('MediaStop');

      registeredIpcListeners['set-media-keys-enabled']({}, true);
      expect(mockShortcuts.register).toHaveBeenCalledWith('MediaPlayPause', expect.any(Function));
      expect(mockShortcuts.register).toHaveBeenCalledTimes(4);
    });

    it('open-external opens http(s) URLs in the system browser', async () => {
      await registeredIpcHandlers['open-external']({}, 'https://discord.com/oauth2/authorize');
      expect(mockShellOpenExternal).toHaveBeenCalledWith('https://discord.com/oauth2/authorize');
    });

    it('open-external refuses any scheme other than http(s)', async () => {
      const hostile = [
        'file:///C:/Windows/system32/cmd.exe',
        'wireon://auth/callback#access_token=abc',
        'javascript:alert(1)',
        'not a url',
        '',
      ];

      for (const url of hostile) {
        await expect(registeredIpcHandlers['open-external']({}, url)).rejects.toThrow(
          /not http/
        );
      }
      expect(mockShellOpenExternal).not.toHaveBeenCalled();
    });

    it('isExternallyOpenableUrl allows only web URLs', () => {
      expect(isExternallyOpenableUrl('https://discord.com/')).toBe(true);
      expect(isExternallyOpenableUrl('http://localhost:3000/auth/callback')).toBe(true);
      expect(isExternallyOpenableUrl('file:///etc/passwd')).toBe(false);
      expect(isExternallyOpenableUrl('wireon://auth/callback')).toBe(false);
      expect(isExternallyOpenableUrl('data:text/html,<b>x</b>')).toBe(false);
      expect(isExternallyOpenableUrl('')).toBe(false);
    });

    it('setupWindowStateListeners sends a plain boolean payload', () => {
      const windowListeners: Record<string, Function> = {};
      mockWin.on.mockImplementation((event: string, fn: Function) => {
        windowListeners[event] = fn;
      });

      setupWindowStateListeners(mockWin as any);

      expect(windowListeners['maximize']).toBeDefined();
      expect(windowListeners['unmaximize']).toBeDefined();
      expect(windowListeners['enter-full-screen']).toBeDefined();
      expect(windowListeners['leave-full-screen']).toBeDefined();

      windowListeners['maximize']();
      expect(mockWin.webContents.send).toHaveBeenLastCalledWith('window-state-changed', true);

      windowListeners['unmaximize']();
      expect(mockWin.webContents.send).toHaveBeenLastCalledWith('window-state-changed', false);

      windowListeners['enter-full-screen']();
      expect(mockWin.webContents.send).toHaveBeenLastCalledWith('window-state-changed', true);

      mockWin.isMaximized.mockReturnValue(true);
      windowListeners['leave-full-screen']();
      expect(mockWin.webContents.send).toHaveBeenLastCalledWith('window-state-changed', true);

      mockWin.isMaximized.mockReturnValue(false);
      windowListeners['leave-full-screen']();
      expect(mockWin.webContents.send).toHaveBeenLastCalledWith('window-state-changed', false);

      // No object payloads: the renderer treats the argument as a boolean.
      mockWin.webContents.send.mock.calls
        .filter((call) => call[0] === 'window-state-changed')
        .forEach((call) => expect(typeof call[1]).toBe('boolean'));
    });

    it('registerMediaKeys registers hardware media keys and forwards the actions', () => {
      registerMediaKeys(mockShortcuts, () => mockWin as any);

      expect(mockShortcuts.register).toHaveBeenCalledWith('MediaPlayPause', expect.any(Function));
      expect(mockShortcuts.register).toHaveBeenCalledWith('MediaNextTrack', expect.any(Function));
      expect(mockShortcuts.register).toHaveBeenCalledWith('MediaPreviousTrack', expect.any(Function));
      expect(mockShortcuts.register).toHaveBeenCalledWith('MediaStop', expect.any(Function));

      registeredShortcuts['MediaPlayPause']();
      expect(mockWin.webContents.send).toHaveBeenCalledWith('media-key-event', 'play-pause');

      registeredShortcuts['MediaNextTrack']();
      expect(mockWin.webContents.send).toHaveBeenCalledWith('media-key-event', 'next');

      registeredShortcuts['MediaPreviousTrack']();
      expect(mockWin.webContents.send).toHaveBeenCalledWith('media-key-event', 'prev');

      registeredShortcuts['MediaStop']();
      expect(mockWin.webContents.send).toHaveBeenCalledWith('media-key-event', 'stop');
    });

    it('unregisterMediaKeys releases every media key', () => {
      unregisterMediaKeys(mockShortcuts);
      expect(mockShortcuts.unregister.mock.calls.map((call: any[]) => call[0])).toEqual([
        'MediaPlayPause',
        'MediaNextTrack',
        'MediaPreviousTrack',
        'MediaStop',
      ]);
    });

    it('focusMainWindow restores and focuses a minimized window', () => {
      mockWin.isMinimized.mockReturnValue(true);
      setMainWindow(mockWin as any);

      focusMainWindow();

      expect(mockWin.restore).toHaveBeenCalledTimes(1);
      expect(mockWin.show).toHaveBeenCalledTimes(1);
      expect(mockWin.focus).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 3. Window creation, path resolution and load diagnostics
  // =========================================================================
  describe('Window creation & load diagnostics (electron/main.ts)', () => {
    it('createWindow creates BrowserWindow with frameless, sandboxed configuration', () => {
      createWindow();

      expect(mockBrowserWindowConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          frame: false,
          titleBarStyle: 'hidden',
          backgroundColor: baseColourFromTokens(),
          title: 'Wireon Sounds',
          show: false,
          webPreferences: expect.objectContaining({
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          }),
        })
      );

      const { webPreferences, icon } = mockBrowserWindowConstructor.mock.calls[0][0];
      // Sandbox must stay at its secure default and the preload must be CommonJS.
      expect(webPreferences.sandbox).toBeUndefined();
      expect(webPreferences.preload).toBe(path.join(getAppDir(), 'preload.cjs'));
      expect(icon).toBe(path.join(getAppRoot(), 'public', 'icon.png'));
    });

    it('resolves every runtime path from the app directory, never from the cwd', () => {
      expect(getAppRoot()).toBe(path.join(getAppDir(), '..'));
      expect(getPreloadPath()).toBe(path.join(getAppDir(), 'preload.cjs'));
      expect(getIndexHtmlPath()).toBe(path.join(getAppRoot(), 'dist', 'index.html'));
      expect(getWindowIconPath()).toBe(path.join(getAppRoot(), 'public', 'icon.png'));

      // getAppDir() keeps a process.cwd() fallback; nothing else may use the cwd.
      const source = readRoot(path.join('electron', 'main.ts'));
      expect(source).not.toMatch(/path\.join\(\s*process\.cwd\(\)/);
    });

    it('shows the window on ready-to-show', () => {
      createWindow();
      const win = createdWindows[0];

      expect(win.show).not.toHaveBeenCalled();
      win.windowListeners['ready-to-show']();
      expect(win.show).toHaveBeenCalledTimes(1);
    });

    it('shows the window anyway when ready-to-show never fires', () => {
      vi.useFakeTimers();
      try {
        createWindow();
        const win = createdWindows[0];
        expect(win.show).not.toHaveBeenCalled();

        vi.advanceTimersByTime(10_000);
        expect(win.show).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('renders an inline fallback page and shows the window when the load fails', () => {
      createWindow();
      const win = createdWindows[0];
      win.loadURL.mockClear();

      win.contentsListeners['did-fail-load'](
        {},
        -6,
        'ERR_FILE_NOT_FOUND',
        'file:///app/dist/index.html',
        true
      );

      expect(win.loadURL).toHaveBeenCalledTimes(1);
      const fallback = win.loadURL.mock.calls[0][0];
      expect(fallback.startsWith('data:text/html')).toBe(true);
      expect(decodeURIComponent(fallback)).toContain('ERR_FILE_NOT_FOUND');
      expect(decodeURIComponent(fallback)).toContain('location.reload()');
      expect(win.show).toHaveBeenCalledTimes(1);
      expect(win.focus).toHaveBeenCalledTimes(1);
    });

    it('ignores aborted navigations and sub-frame load failures', () => {
      createWindow();
      const win = createdWindows[0];
      win.loadURL.mockClear();

      win.contentsListeners['did-fail-load']({}, -3, 'ERR_ABORTED', 'file:///x', true);
      win.contentsListeners['did-fail-load']({}, -6, 'ERR_FILE_NOT_FOUND', 'file:///y', false);

      expect(win.loadURL).not.toHaveBeenCalled();
    });

    it('logs did-finish-load and registers crash diagnostics', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        createWindow();
        const win = createdWindows[0];

        expect(win.contentsListeners['did-finish-load']).toBeDefined();
        expect(win.contentsListeners['render-process-gone']).toBeDefined();
        expect(win.windowListeners['unresponsive']).toBeDefined();

        win.contentsListeners['did-finish-load']();
        expect(log.mock.calls.flat().join(' ')).toContain('did-finish-load');
      } finally {
        log.mockRestore();
      }
    });

    it('buildLoadErrorPage escapes into a self-contained data URL with a reload affordance', () => {
      const page = buildLoadErrorPage({
        errorCode: -102,
        errorDescription: 'ERR_CONNECTION_REFUSED',
        validatedURL: 'http://localhost:3000/',
      });

      expect(page.startsWith('data:text/html;charset=utf-8,')).toBe(true);
      const html = decodeURIComponent(page.replace('data:text/html;charset=utf-8,', ''));
      expect(html).toContain('ERR_CONNECTION_REFUSED');
      expect(html).toContain('-102');
      expect(html).toContain('http://localhost:3000/');
      expect(html).toContain('<button onclick="location.reload()">Reload</button>');
    });

    it('buildLoadErrorPage escapes markup coming from the failed URL', () => {
      const page = buildLoadErrorPage({
        errorCode: -6,
        errorDescription: 'ERR_FILE_NOT_FOUND',
        validatedURL: 'file:///x?<script>alert("x")</script>',
      });

      const html = decodeURIComponent(page.replace('data:text/html;charset=utf-8,', ''));
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('runs the smoke diagnostic only when WIREON_SMOKE=1', () => {
      createWindow();
      expect(createdWindows[0].contentsListeners['console-message']).toBeUndefined();

      process.env.WIREON_SMOKE = '1';
      try {
        createWindow();
        expect(createdWindows[1].contentsListeners['console-message']).toBeDefined();
      } finally {
        delete process.env.WIREON_SMOKE;
      }
    });
  });

  // =========================================================================
  // 4. wireon:// deep links (Discord OAuth callback)
  // =========================================================================
  describe('Deep links (electron/main.ts)', () => {
    const CALLBACK_URL = 'wireon://auth/callback#access_token=secret.token&state=abc123';

    it('extractDeepLinkUrl finds the protocol argument in a command line', () => {
      expect(
        extractDeepLinkUrl(['C:\\app\\Wireon.exe', '--allow-file-access', CALLBACK_URL])
      ).toBe(CALLBACK_URL);
      expect(extractDeepLinkUrl(['electron.exe', '.'])).toBeUndefined();
      expect(extractDeepLinkUrl([])).toBeUndefined();
    });

    /*
     * Ответ Discord приходит не по нашей схеме, а по его собственной.
     *
     * `wireon://auth/callback` был прописан в панели разработчика и всё равно
     * отвергался: Discord принимает только `discord-{ID заявки}`. У неё один
     * слеш вместо двух, поэтому поиск по «схема://» её бы не нашёл — и ответ
     * доходил бы до системы, но не до приложения.
     */
    it('находит и возврат Discord — у его схемы один слеш, а не два', () => {
      const discordCallback = `${DISCORD_AUTH_REDIRECT}?code=abc&state=xyz`;
      expect(extractDeepLinkUrl(['Wireon.exe', discordCallback])).toBe(discordCallback);
      expect(DEEP_LINK_SCHEMES).toContain(DISCORD_AUTH_SCHEME);
      expect(DEEP_LINK_SCHEMES).toContain('wireon');
    });

    /*
     * Идентификатор заявки записан дважды: в главном процессе и в renderer.
     * Разойдись они — приложение просило бы возврат на одну схему, а система
     * отдавала бы другой, и вход молча ждал бы до срока.
     */
    it('идентификатор заявки в главном процессе совпадает с тем, что у renderer', () => {
      expect(DISCORD_CLIENT_ID).toBe(DEFAULT_DISCORD_CLIENT_ID);
      expect(DISCORD_AUTH_REDIRECT).toBe(appSchemeRedirectUri(DEFAULT_DISCORD_CLIENT_ID));
    });

    it('queues a deep link until the renderer is ready, then replays it verbatim', () => {
      const win = createWindow();
      const created = createdWindows[0];

      deliverDeepLink(CALLBACK_URL, win);
      expect(created.webContents.send).not.toHaveBeenCalledWith('deep-link', expect.anything());

      created.contentsListeners['did-finish-load']();
      expect(created.webContents.send).toHaveBeenCalledWith('deep-link', CALLBACK_URL);
    });

    it('forwards a deep link immediately once the renderer has loaded', () => {
      const win = createWindow();
      const created = createdWindows[0];
      created.contentsListeners['did-finish-load']();

      deliverDeepLink(CALLBACK_URL, win);
      expect(created.webContents.send).toHaveBeenLastCalledWith('deep-link', CALLBACK_URL);
    });

    it('never writes the deep link (and its token) to the log', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const win = createWindow();
        deliverDeepLink(CALLBACK_URL, win);
        flushPendingDeepLink(createdWindows[0] as any);

        const logged = logSpy.mock.calls.flat().join(' ');
        expect(logged).not.toContain('access_token');
        expect(logged).not.toContain(CALLBACK_URL);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('does not send to a destroyed window', () => {
      const win = createWindow();
      deliverDeepLink(CALLBACK_URL, win);
      createdWindows[0].isDestroyed.mockReturnValue(true);

      expect(() => flushPendingDeepLink(createdWindows[0] as any)).not.toThrow();
      expect(createdWindows[0].webContents.send).not.toHaveBeenCalledWith(
        'deep-link',
        expect.anything()
      );
    });

    it('claims the wireon:// scheme for this executable', () => {
      registerDeepLinkProtocol();
      expect(mockSetAsDefaultProtocolClient).toHaveBeenCalled();
      expect(mockSetAsDefaultProtocolClient.mock.calls[0][0]).toBe('wireon');
    });

    it('drops the pre-rename vireon:// handler left in the registry', () => {
      registerDeepLinkProtocol();
      expect(mockRemoveAsDefaultProtocolClient).toHaveBeenCalledWith('vireon');
    });

    it('leaves the registry alone during a smoke launch', () => {
      // `npm run verify` boots Electron out of the repository. Claiming the
      // scheme there would point wireon:// at the checkout, and the Discord
      // sign-in of the installed app would open the wrong executable.
      process.env.WIREON_SMOKE = '1';
      try {
        registerDeepLinkProtocol();
        expect(mockSetAsDefaultProtocolClient).not.toHaveBeenCalled();
        expect(mockRemoveAsDefaultProtocolClient).not.toHaveBeenCalled();
      } finally {
        delete process.env.WIREON_SMOKE;
      }
    });

    it('registers wireon:// as a privileged scheme at import time', () => {
      expect(privilegedSchemes).toEqual([
        { scheme: 'wireon', privileges: { standard: true, secure: true } },
      ]);
    });
  });

  // =========================================================================
  // 4b. Carrying a pre-rename profile across (VireonMusic → Wireon)
  // =========================================================================
  describe('User data migration after the rename (electron/main.ts)', () => {
    let tempRoot = '';

    /** A profile pair the way Electron lays them out: siblings under %APPDATA%. */
    function makeProfiles(): { current: string; legacy: string } {
      const current = path.join(tempRoot, 'Wireon');
      const legacy = path.join(tempRoot, 'VireonMusic');
      fs.mkdirSync(current, { recursive: true });
      appPaths.userData = current;
      return { current, legacy };
    }

    beforeEach(() => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wireon-migrate-'));
      appPaths.userData = '';
    });

    afterEach(() => {
      appPaths.userData = '';
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('does nothing when there is no pre-rename profile', () => {
      makeProfiles();
      expect(migrateLegacyUserData()).toBe(false);
    });

    it('copies the library, offline audio and session out of %APPDATA%/VireonMusic', () => {
      const { current, legacy } = makeProfiles();
      fs.mkdirSync(path.join(legacy, 'IndexedDB', 'https_wireon_0.indexeddb.leveldb'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'IndexedDB', 'https_wireon_0.indexeddb.leveldb', '000003.log'), 'library');
      fs.mkdirSync(path.join(legacy, 'Local Storage'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'Local Storage', 'leveldb.log'), 'session');

      expect(migrateLegacyUserData()).toBe(true);

      expect(
        fs.readFileSync(
          path.join(current, 'IndexedDB', 'https_wireon_0.indexeddb.leveldb', '000003.log'),
          'utf-8'
        )
      ).toBe('library');
      expect(fs.readFileSync(path.join(current, 'Local Storage', 'leveldb.log'), 'utf-8')).toBe('session');

      // The original is left alone: a failed update must not cost the user anything.
      expect(fs.existsSync(path.join(legacy, 'Local Storage', 'leveldb.log'))).toBe(true);
    });

    it('refuses to overwrite a profile that is already in use', () => {
      const { current, legacy } = makeProfiles();
      fs.mkdirSync(path.join(legacy, 'Local Storage'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'Local Storage', 'leveldb.log'), 'старое');
      fs.mkdirSync(path.join(current, 'Local Storage'), { recursive: true });
      fs.writeFileSync(path.join(current, 'Local Storage', 'leveldb.log'), 'текущее');

      expect(migrateLegacyUserData()).toBe(false);
      expect(fs.readFileSync(path.join(current, 'Local Storage', 'leveldb.log'), 'utf-8')).toBe('текущее');
    });

    it('runs only once: the second launch finds the profile in use', () => {
      const { legacy } = makeProfiles();
      fs.mkdirSync(path.join(legacy, 'IndexedDB'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'IndexedDB', 'data.log'), 'library');

      expect(migrateLegacyUserData()).toBe(true);
      expect(migrateLegacyUserData()).toBe(false);
    });

    it('starts the app anyway when the profile cannot be written', () => {
      // A userData path that is not a directory stands in for every real way the
      // copy dies on Windows: a locked file, an antivirus, a full disk.
      const legacy = path.join(tempRoot, 'VireonMusic');
      fs.mkdirSync(path.join(legacy, 'IndexedDB'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'IndexedDB', 'data.log'), 'library');
      const currentAsFile = path.join(tempRoot, 'Wireon');
      fs.writeFileSync(currentAsFile, 'not a directory');
      appPaths.userData = currentAsFile;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(migrateLegacyUserData()).toBe(false);
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does not confuse a profile that is its own legacy folder', () => {
      const legacy = path.join(tempRoot, 'VireonMusic');
      fs.mkdirSync(path.join(legacy, 'IndexedDB'), { recursive: true });
      appPaths.userData = legacy;

      // A build still named VireonMusic must not copy its own data onto itself.
      expect(migrateLegacyUserData()).toBe(false);
    });
  });

  // =========================================================================
  // 5. Network headers & Content Security Policy
  // =========================================================================
  describe('Session headers & CSP (electron/main.ts)', () => {
    it('covers the YouTube, SoundCloud, Piped and Invidious hosts', () => {
      [
        '*://*.googlevideo.com/*',
        '*://*.youtube.com/*',
        '*://music.youtube.com/*',
        '*://*.ytimg.com/*',
        '*://*.soundcloud.com/*',
        '*://*.sndcdn.com/*',
        '*://suggestqueries.google.com/*',
        '*://*.piped.privacydev.net/*',
        '*://pipedapi.kavin.rocks/*',
        '*://pipedapi.leptons.xyz/*',
        '*://*.piped.video/*',
        '*://*.piped.private.coffee/*',
        '*://api.piped.private.coffee/*',
        '*://*.invidious.flokinet.to/*',
        '*://invidious.flokinet.to/*',
        '*://*.invidious.schenkel.eti.br/*',
        '*://invidious.schenkel.eti.br/*',
        '*://*.invidious.materialio.us/*',
        '*://invidious.materialio.us/*',
        '*://invidious.nerdvpn.de/*',
        '*://inv.nadeko.net/*',
        '*://invidious.jing.rocks/*',
        '*://yt.drgnz.club/*',
        '*://*.invidious.io/*',
      ].forEach((pattern) => expect(targetUrls).toContain(pattern));
    });

    it('isStreamingHost matches every fallback instance but nothing else', () => {
      [
        'https://api.piped.privacydev.net/streams/abc',
        'https://pipedapi.kavin.rocks/streams/abc',
        'https://pipedapi.leptons.xyz/streams/abc',
        'https://api.piped.private.coffee/streams/abc',
        'https://invidious.flokinet.to/api/v1/videos/abc',
        'https://invidious.schenkel.eti.br/api/v1/videos/abc',
        'https://invidious.materialio.us/api/v1/videos/abc',
        'https://invidious.nerdvpn.de/api/v1/videos/abc',
        'https://inv.nadeko.net/api/v1/videos/abc',
        'https://invidious.jing.rocks/api/v1/videos/abc',
        'https://yt.drgnz.club/api/v1/videos/abc',
        'https://i.ytimg.com/vi/abc/hq720.jpg',
        'https://rr3---sn-x.googlevideo.com/videoplayback?x=1',
        'https://api-v2.soundcloud.com/search/tracks',
        'https://cf-hls-media.sndcdn.com/playlist.m3u8',
      ].forEach((url) => expect(isStreamingHost(url)).toBe(true));

      ['https://example.com/x', 'https://evil.test/piped.video', 'not a url'].forEach((url) =>
        expect(isStreamingHost(url)).toBe(false)
      );
    });

    it('sends the desktop User-Agent everywhere but YouTube Origin/Referer only to YouTube with case-insensitive sanitation', () => {
      const yt = rewriteRequestHeaders('https://music.youtube.com/youtubei/v1/search', {
        'origin': 'http://localhost:3000',
        'referer': 'http://localhost:3000/',
        'user-agent': 'old-ua'
      });
      expect(yt['User-Agent']).toContain('Chrome/122');
      expect(yt['user-agent']).toBeUndefined();
      expect(yt['Origin']).toBe('https://music.youtube.com');
      expect(yt['origin']).toBeUndefined();
      expect(yt['Referer']).toBe('https://music.youtube.com/');
      expect(yt['referer']).toBeUndefined();

      const sc = rewriteRequestHeaders('https://api-v2.soundcloud.com/search/tracks', {
        'Origin': 'http://localhost:3000',
        'referrer': 'http://localhost:3000/'
      });
      expect(sc['Origin']).toBe('https://soundcloud.com');
      expect(sc['Referer']).toBe('https://soundcloud.com/');
      expect(sc['referrer']).toBeUndefined();

      ['https://pipedapi.kavin.rocks/streams/abc', 'https://invidious.nerdvpn.de/api/v1/videos/abc', 'https://i.ytimg.com/vi/abc/hq720.jpg', 'https://rr1---sn-x.googlevideo.com/videoplayback'].forEach(
        (url) => {
          const headers = rewriteRequestHeaders(url, {
            'origin': 'https://music.youtube.com',
            'Origin': 'https://music.youtube.com',
            'referer': 'https://music.youtube.com/',
            'Referer': 'https://music.youtube.com/',
            'user-agent': 'old-ua'
          });
          expect(headers['User-Agent']).toContain('Chrome/122');
          expect(headers['user-agent']).toBeUndefined();
          expect(headers['Origin']).toBeUndefined();
          expect(headers['origin']).toBeUndefined();
          expect(headers['Referer']).toBeUndefined();
          expect(headers['referer']).toBeUndefined();
        }
      );
    });

    it('builds a CSP that is strict when packaged and dev-server friendly otherwise', () => {
      const packaged = buildContentSecurityPolicy(true);
      expect(packaged).toContain("default-src 'self'");
      expect(packaged).toContain("script-src 'self'");
      expect(packaged).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(packaged).toContain("style-src 'self' 'unsafe-inline'");
      expect(packaged).toContain("img-src 'self' data: blob: https:");
      expect(packaged).toContain("media-src 'self' https: blob:");
      expect(packaged).toContain("font-src 'self' data:");
      expect(packaged).toContain("object-src 'none'");
      expect(packaged).toContain("frame-src 'none'");
      expect(packaged).not.toContain('ws:');

      const dev = buildContentSecurityPolicy(false);
      expect(dev).toContain("script-src 'self' 'unsafe-inline'");
      expect(dev).toContain("connect-src 'self' https: ws: wss:");
    });

    /**
     * Вторая стена, стоявшая за первой.
     *
     * Сервер синхронизации отвечает по `http` на нестандартном порту, а
     * `connect-src` разрешает `https:` — то есть под разрешение он не попадал.
     * Даже когда сервер научился отвечать на предзапрос браузера, запрос из
     * упакованного приложения гасился своим же CSP, и `fetch` бросал ровно тот
     * же `Failed to fetch`. В окне разработки этого не видно: страницу отдаёт
     * Vite, и заголовка нет вовсе.
     */
    it('вписывает в CSP источники своего сервера, но не весь http и не весь ws', () => {
      const withServer = buildContentSecurityPolicy(true, [
        'http://203.0.113.10:8099',
        'ws://203.0.113.10:8099'
      ]);
      expect(withServer).toContain(
        "connect-src 'self' https: wss: http://203.0.113.10:8099 ws://203.0.113.10:8099"
      );
      // Именно источники, а не разрешение всему незашифрованному транспорту.
      expect(withServer).not.toMatch(/connect-src[^;]*http:(?!\/\/)/);
      expect(withServer).not.toMatch(/connect-src[^;]*ws:(?!\/\/)/);

      // Сборка без сервера остаётся строгой.
      expect(buildContentSecurityPolicy(true, [])).toContain("connect-src 'self' https: wss:;");
      expect(buildContentSecurityPolicy(true, null)).toContain("connect-src 'self' https: wss:;");
    });

    /**
     * Схема в источнике значима сама по себе.
     *
     * Брокер «слушать вместе» живёт на том же сервере и на том же порту, но
     * обращаются к нему по `ws:`. Разрешение `http://хост` соединение
     * `ws://хост` **не покрывает** — Chromium блокирует сокет, и комната
     * оставалась «только на этом устройстве» с подписью «Брокер не ответил»,
     * хотя сервер отвечал сразу. Поймано в живой сборке по записи в журнале
     * безопасности.
     */
    it('адрес брокера попадает в CSP отдельной строкой со своей схемой', () => {
      const onlyHttp = buildContentSecurityPolicy(true, ['http://203.0.113.10:8099']);
      expect(onlyHttp).not.toContain('ws://203.0.113.10:8099');

      const both = buildContentSecurityPolicy(true, [
        'http://203.0.113.10:8099',
        'ws://203.0.113.10:8099'
      ]);
      expect(both).toContain('ws://203.0.113.10:8099');
    });

    it('isAppContentUrl recognises the bundle and the dev server only', () => {
      expect(isAppContentUrl('file:///C:/app/dist/index.html')).toBe(true);
      expect(isAppContentUrl('http://localhost:3000/index.html', 'http://localhost:3000')).toBe(true);
      expect(isAppContentUrl('http://127.0.0.1:5173/')).toBe(true);
      expect(isAppContentUrl('https://music.youtube.com/')).toBe(false);
      expect(isAppContentUrl('https://localhost.evil.test/')).toBe(false);
    });

    it('setupSessionHeaders installs one request and one response listener and normalizes CORS headers', () => {
      const onBeforeSendHeaders = vi.fn();
      const onHeadersReceived = vi.fn();
      setupSessionHeaders({ webRequest: { onBeforeSendHeaders, onHeadersReceived } } as any, true);

      expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1);
      expect(onBeforeSendHeaders.mock.calls[0][0]).toEqual({ urls: [...targetUrls] });
      expect(onHeadersReceived).toHaveBeenCalledTimes(1);
      expect(typeof onHeadersReceived.mock.calls[0][0]).toBe('function');

      const requestListener = onBeforeSendHeaders.mock.calls[0][1];
      const requestCallback = vi.fn();
      requestListener(
        { url: 'https://music.youtube.com/x', requestHeaders: {} },
        requestCallback
      );
      expect(requestCallback.mock.calls[0][0].requestHeaders['Origin']).toBe(
        'https://music.youtube.com'
      );

      const responseListener = onHeadersReceived.mock.calls[0][0];
      const streamCallback = vi.fn();
      responseListener(
        {
          url: 'https://pipedapi.kavin.rocks/streams/abc',
          responseHeaders: {
            'access-control-allow-origin': ['null'],
            'access-control-expose-headers': ['old-headers']
          }
        },
        streamCallback
      );
      const streamHeaders = streamCallback.mock.calls[0][0].responseHeaders;
      expect(streamHeaders['access-control-allow-origin']).toBeUndefined();
      expect(streamHeaders['access-control-expose-headers']).toBeUndefined();
      expect(streamHeaders['Access-Control-Allow-Origin']).toEqual(['*']);
      expect(streamHeaders['Access-Control-Allow-Methods']).toEqual(['GET, HEAD, POST, OPTIONS']);
      expect(streamHeaders['Access-Control-Allow-Headers']).toEqual(['*']);
      expect(streamHeaders['Access-Control-Expose-Headers']).toEqual([
        'Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Encoding, Range'
      ]);
      expect(streamHeaders['Content-Security-Policy']).toBeUndefined();

      const appCallback = vi.fn();
      responseListener(
        {
          url: 'file:///C:/app/dist/index.html',
          responseHeaders: { 'content-security-policy': ['old-csp'] }
        },
        appCallback
      );
      expect(appCallback.mock.calls[0][0].responseHeaders['content-security-policy']).toBeUndefined();
      expect(appCallback.mock.calls[0][0].responseHeaders['Content-Security-Policy']).toEqual([
        buildContentSecurityPolicy(true),
      ]);
    });
  });

  // =========================================================================
  // 6. UI Desktop Integration Tests (Header.tsx & Window Controls)
  // =========================================================================
  describe('UI Desktop Integration (src/components/layout/Header.tsx)', () => {
    let mockElectronAPI: ElectronAPI;
    let stateChangeCallback: ((isMaximized: boolean) => void) | null = null;

    beforeEach(() => {
      stateChangeCallback = null;
      mockElectronAPI = {
        minimize: vi.fn(),
        maximize: vi.fn(),
        close: vi.fn(),
        isMaximized: vi.fn().mockResolvedValue(false),
        getPlatform: vi.fn().mockReturnValue('win32'),
        onWindowStateChange: vi.fn((cb) => {
          stateChangeCallback = cb;
          return () => {
            stateChangeCallback = null;
          };
        }),
        onMediaKey: vi.fn().mockReturnValue(() => {}),
        setMediaKeysEnabled: vi.fn(),
        openExternal: vi.fn().mockResolvedValue(undefined),
        onDeepLink: vi.fn().mockReturnValue(() => {}),
        resolveYouTubeStream: vi.fn(),
        getStreamDiagnostics: vi
          .fn()
          .mockResolvedValue({ log: [], ytDlpPath: '', ytDlpAvailable: true, logPath: null }),
        clearStreamCache: vi.fn().mockResolvedValue(true),
        searchYouTube: vi.fn(),
        searchSoundCloud: vi.fn(),
        setMiniPlayerMode: vi.fn().mockResolvedValue(undefined),
        setAlwaysOnTop: vi.fn().mockResolvedValue(true),
        isAlwaysOnTop: vi.fn().mockResolvedValue(true),
        discordRpcSetActivity: vi.fn().mockResolvedValue(true),
        discordRpcSetEnabled: vi.fn().mockResolvedValue(undefined),
        isMiniWindow: false,
        openMiniWindow: vi.fn().mockResolvedValue(true),
        closeMiniWindow: vi.fn().mockResolvedValue(true),
        isMiniWindowOpen: vi.fn().mockResolvedValue(false),
        sendMiniState: vi.fn(),
        onMiniState: vi.fn().mockReturnValue(() => {}),
        sendMiniCommand: vi.fn(),
        onMiniCommand: vi.fn().mockReturnValue(() => {}),
        onMiniWindowVisibility: vi.fn().mockReturnValue(() => {}),
      };
    });

    afterEach(() => {
      delete (window as any).electronAPI;
    });

    it('does NOT render frameless window controls when window.electronAPI is undefined (Web Mode)', () => {
      delete (window as any).electronAPI;

      render(<Header />);

      expect(screen.getByTestId('app-header')).toBeInTheDocument();
      expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument();
      expect(screen.queryByTestId('window-minimize-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('window-maximize-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('window-close-btn')).not.toBeInTheDocument();
    });

    it('renders frameless window controls when window.electronAPI is present (Desktop Mode)', async () => {
      (window as any).electronAPI = mockElectronAPI;

      render(<Header />);

      await waitFor(() => {
        expect(screen.getByTestId('window-controls')).toBeInTheDocument();
      });

      expect(screen.getByTestId('window-minimize-btn')).toBeInTheDocument();
      expect(screen.getByTestId('window-maximize-btn')).toBeInTheDocument();
      expect(screen.getByTestId('window-close-btn')).toBeInTheDocument();
    });

    it('clicking window controls invokes corresponding electronAPI methods', async () => {
      (window as any).electronAPI = mockElectronAPI;

      render(<Header />);

      await waitFor(() => {
        expect(screen.getByTestId('window-controls')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('window-minimize-btn'));
      expect(mockElectronAPI.minimize).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId('window-maximize-btn'));
      expect(mockElectronAPI.maximize).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId('window-close-btn'));
      expect(mockElectronAPI.close).toHaveBeenCalledTimes(1);
    });

    it('toggles the maximize/restore affordance from the boolean window-state payload', async () => {
      (window as any).electronAPI = mockElectronAPI;

      render(<Header />);

      await waitFor(() => {
        expect(screen.getByTestId('window-maximize-btn')).toBeInTheDocument();
      });

      expect(screen.getByTestId('window-maximize-btn')).toHaveAttribute('title', 'Развернуть');

      await act(async () => {
        stateChangeCallback?.(true);
      });

      await waitFor(() => {
        expect(screen.getByTestId('window-maximize-btn')).toHaveAttribute('title', 'Свернуть в окно');
      });

      await act(async () => {
        stateChangeCallback?.(false);
      });

      await waitFor(() => {
        expect(screen.getByTestId('window-maximize-btn')).toHaveAttribute('title', 'Развернуть');
      });
    });
  });

  // =========================================================================
  // 7. Packaging Configuration Validation
  // =========================================================================
  describe('Packaging & Build Configuration', () => {
    it('package.json wires the desktop, icon and typecheck scripts', () => {
      const pkg = JSON.parse(readRoot('package.json'));

      expect(pkg.main).toBe('dist-electron/main.js');
      expect(pkg.type).toBe('module');
      expect(pkg.scripts['electron:dev']).toBeDefined();
      expect(pkg.scripts['build:win']).toBeDefined();
      expect(pkg.scripts['pack:win']).toBeDefined();
      expect(pkg.scripts['gen:icon']).toContain('scripts/gen-icon.mjs');

      // The packaged build needs the icon, the renderer bundle, main and preload.
      expect(pkg.scripts['electron:build']).toContain('gen:icon');
      expect(pkg.scripts['electron:build']).toContain('vite build');
      expect(pkg.scripts['electron:build']).toContain('tsconfig.electron.json');
      expect(pkg.scripts['electron:build']).toContain('scripts/build-preload.mjs');

      expect(pkg.scripts['typecheck']).toBe('tsc --noEmit');
      expect(pkg.scripts['typecheck:electron']).toContain('tsconfig.electron.json --noEmit');
      expect(pkg.scripts['typecheck:preload']).toContain('tsconfig.preload.json --noEmit');
      ['typecheck', 'typecheck:electron', 'typecheck:preload'].forEach((script) =>
        expect(pkg.scripts['typecheck:all']).toContain(script)
      );
    });

    it('electron-builder targets a real icon and unique artifact names', () => {
      const config = JSON.parse(readRoot('electron-builder.json'));

      expect(config.appId).toBe('com.wireon.music');
      // The visible product name is "Wireon Sounds", but `productName` must stay
      // `Wireon`: it names %APPDATA%/Wireon, and renaming it a second time would
      // strand every existing library, playlist and offline download. `appId` is
      // the update identity — changing it installs a second app instead of
      // updating this one.
      expect(config.productName).toBe('Wireon');
      expect(config.directories.output).toBe('release');
      expect(config.directories.buildResources).toBe('build');
      expect(fs.existsSync(path.join(ROOT, config.directories.buildResources))).toBe(true);

      const targets = config.win.target.map((t: any) => t.target);
      expect(targets).toContain('nsis');
      expect(targets).toContain('portable');

      // Windows cannot use an SVG icon.
      expect(config.win.icon).toBe('build/icon.png');
      expect(fs.existsSync(path.join(ROOT, config.win.icon))).toBe(true);

      // A shared artifactName makes the second target overwrite the first.
      expect(config.win.artifactName).toBeUndefined();
      expect(config.nsis.artifactName).toBe('${productName}-Setup-${version}.${ext}');
      expect(config.portable.artifactName).toBe('${productName}-Portable-${version}.${ext}');
      expect(config.nsis.artifactName).not.toBe(config.portable.artifactName);

      expect(config.nsis.oneClick).toBe(false);
      expect(config.nsis.allowToChangeInstallationDirectory).toBe(true);
      expect(config.nsis.createDesktopShortcut).toBe(true);
      expect(config.nsis.shortcutName).toBe('Wireon');

      ['dist/**/*', 'dist-electron/**/*', 'package.json', 'public/**/*'].forEach((entry) =>
        expect(config.files).toContain(entry)
      );
    });

    it('the installer registers wireon:// so the auth callback survives a reinstall', () => {
      const config = JSON.parse(readRoot('electron-builder.json'));

      // Without this the deep-link login depends on a runtime registry write that
      // an uninstall (or a non-elevated run) can leave broken.
      expect(config.protocols).toEqual([{ name: 'Wireon', schemes: ['wireon'] }]);
    });

    it('nothing user-facing is still called Vireon', () => {
      const pkg = JSON.parse(readRoot('package.json'));
      expect(pkg.name).toBe('wireon');

      const lock = JSON.parse(readRoot('package-lock.json'));
      // A stale lockfile name makes npm rewrite it on every install.
      expect(lock.name).toBe(pkg.name);
      expect(lock.packages['']?.name).toBe(pkg.name);

      const html = readRoot('index.html');
      expect(html).toMatch(/<title>Wireon Sounds<\/title>/);
      expect(html.toLowerCase()).not.toContain('vireon');

      // The rename left exactly three legacy identifiers behind, all of them
      // needed to find pre-rename data. Anything else is a leftover.
      expect(readRoot('src/services/db.ts')).toContain("LEGACY_DB_NAME = 'VireonMusicDB'");
      expect(readRoot('electron/main.ts')).toContain("LEGACY_DEEP_LINK_SCHEME = 'vireon'");
      expect(readRoot('electron/main.ts')).toContain("LEGACY_PRODUCT_NAME = 'VireonMusic'");
    });

    it('build/icon.png is a valid 512x512 PNG', () => {
      const png = fs.readFileSync(path.join(ROOT, 'build', 'icon.png'));

      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
      expect(png.readUInt32BE(16)).toBe(512);
      expect(png.readUInt32BE(20)).toBe(512);
      expect(png[24]).toBe(8); // bit depth
      expect(png[25]).toBe(6); // RGBA
    });

    it('compiles the preload as CommonJS and the main process as ESM', () => {
      const preload = JSON.parse(readRoot('tsconfig.preload.json'));
      expect(preload.compilerOptions.module).toBe('CommonJS');
      expect(preload.compilerOptions.moduleResolution).toBe('node');
      expect(preload.compilerOptions.outDir).toBe('dist-electron');
      expect(preload.include).toEqual(['electron/preload.ts']);

      const main = JSON.parse(readRoot('tsconfig.electron.json'));
      expect(main.compilerOptions.outDir).toBe('dist-electron');
      expect(main.compilerOptions.module).toBe('ESNext');
      expect(main.include).toContain('electron');
      // The ESM project must not emit a second, unusable preload.js.
      expect(main.exclude).toContain('electron/preload.ts');
    });

    it('vite emits relative asset URLs for file:// loading', () => {
      expect(readRoot('vite.config.ts')).toMatch(/base:\s*'\.\/'/);
    });

    it('index.html ships no remote font CDN and no absolute module script', () => {
      const html = readRoot('index.html');
      expect(html).not.toContain('fonts.googleapis.com');
      expect(html).not.toContain('fonts.gstatic.com');
      expect(html).not.toContain('preconnect');
      expect(html).toContain('<div id="root"></div>');
    });

    it('index.html and the window share the Matte Slate base colour', () => {
      const hex = baseColourFromTokens();

      expect(readRoot('index.html')).toContain(`<meta name="theme-color" content="${hex}" />`);
      expect(readRoot(path.join('electron', 'main.ts'))).toContain(`backgroundColor: '${hex}'`);
    });

    it('the repo no longer carries the scratch files', () => {
      [
        '1786912216250-player-script.js',
        '1786912216260-player-script.js',
        'test_stream.cjs',
        'test_ytdl.mjs',
        'test_ytdlp.cjs',
        'electron-builder.json5',
      ].forEach((file) => expect(fs.existsSync(path.join(ROOT, file))).toBe(false));
    });

    it('guards against a second instance stealing the media keys', () => {
      const source = readRoot(path.join('electron', 'main.ts'));
      expect(source).toContain('requestSingleInstanceLock');
      expect(source).toContain("app.on('second-instance'");
    });
  });

  // =========================================================================
  // 8. Wave & Radio Desktop Shortcuts, MediaSession & Responsive UI (M4)
  // =========================================================================
  describe('Wave & Radio Desktop Shortcuts & MediaSession (Milestone 4)', () => {
    const ShortcutHost: React.FC = () => {
      useKeyboardShortcuts();
      return (
        <div>
          <input data-testid="search-input" defaultValue="query" />
          <textarea data-testid="text-area" defaultValue="notes" />
        </div>
      );
    };

    const mockTrack1: UnifiedTrack = {
      id: 'yt_m4_track1',
      source: 'youtube',
      originalId: 'm4_track1',
      title: 'Starlight Symphony',
      artist: 'Cosmic Orchestra',
      album: 'Space Odyssey',
      duration: 240,
      artworkUrl: 'https://example.com/starlight.jpg'
    };

    const mockTrack2: UnifiedTrack = {
      id: 'sc_m4_track2',
      source: 'soundcloud',
      originalId: 'm4_track2',
      title: 'Neon Nights',
      artist: 'Synthwave Duo',
      album: 'Retrowave 2026',
      duration: 180,
      artworkUrl: 'https://example.com/neon.jpg'
    };

    function sendKey(init: KeyboardEventInit): boolean {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }

    beforeEach(async () => {
      usePlayerStore.setState({
        currentTrack: null,
        isPlaying: false,
        playbackState: 'idle',
        queueMode: 'sequential',
        sourceQueue: [],
        userQueue: [],
        currentIndex: -1,
        activeWaveMood: 'favorite',
        activeWaveGenre: null
      });
      useLibraryStore.setState({
        favorites: [],
        playlists: [],
        history: [],
        isLoading: false,
        error: null
      });
      useUIStore.setState({
        activeView: 'search',
        activeWaveMood: 'favorite',
        activeWaveGenre: null,
        toastMessage: null
      });
      MediaSessionService.clear();
    });

    it('Alt+W navigates to "wave" tab and starts Wave when outside wave view', async () => {
      const startMyWaveSpy = vi.spyOn(usePlayerStore.getState(), 'startMyWave').mockResolvedValue();
      render(<ShortcutHost />);

      useUIStore.setState({ activeView: 'search' });
      const prevented = sendKey({ key: 'w', altKey: true });
      expect(prevented).toBe(true);

      expect(useUIStore.getState().activeView).toBe('wave');
      expect(startMyWaveSpy).toHaveBeenCalledWith('favorite', null);
      startMyWaveSpy.mockRestore();
    });

    it('Alt+W / KeyW toggles play/pause when already in "wave" view with active playback', async () => {
      const togglePlayPauseSpy = vi.spyOn(usePlayerStore.getState(), 'togglePlayPause').mockResolvedValue();
      render(<ShortcutHost />);

      useUIStore.setState({ activeView: 'wave' });
      usePlayerStore.setState({
        queueMode: 'my_wave',
        currentTrack: mockTrack1,
        isPlaying: true,
        playbackState: 'playing'
      });

      const prevented = sendKey({ key: 'w', code: 'KeyW', altKey: true });
      expect(prevented).toBe(true);
      expect(togglePlayPauseSpy).toHaveBeenCalledTimes(1);
      togglePlayPauseSpy.mockRestore();
    });

    it('Alt+R starts Track Radio on the current track and displays a toast', async () => {
      const startTrackRadioSpy = vi.spyOn(usePlayerStore.getState(), 'startTrackRadio').mockResolvedValue();
      render(<ShortcutHost />);

      usePlayerStore.setState({ currentTrack: mockTrack1 });

      const prevented = sendKey({ key: 'r', altKey: true });
      expect(prevented).toBe(true);
      expect(startTrackRadioSpy).toHaveBeenCalledWith(mockTrack1);
      expect(useUIStore.getState().toastMessage?.text).toContain('Запущено радио по треку "Starlight Symphony"');
      startTrackRadioSpy.mockRestore();
    });

    it('Alt+R does nothing when no track is loaded', async () => {
      const startTrackRadioSpy = vi.spyOn(usePlayerStore.getState(), 'startTrackRadio').mockResolvedValue();
      render(<ShortcutHost />);

      usePlayerStore.setState({ currentTrack: null });

      sendKey({ key: 'r', altKey: true });
      expect(startTrackRadioSpy).not.toHaveBeenCalled();
      startTrackRadioSpy.mockRestore();
    });

    it('L shortcut toggles favorite on active track, records feedback and shows toast', async () => {
      const toggleFavSpy = vi.spyOn(useLibraryStore.getState(), 'toggleFavorite').mockResolvedValue(true);
      const recordFeedbackSpy = vi.spyOn(recommendationEngine, 'recordFeedback').mockResolvedValue();
      render(<ShortcutHost />);

      usePlayerStore.setState({ currentTrack: mockTrack1 });
      useLibraryStore.setState({ favorites: [] });

      const prevented = sendKey({ key: 'l' });
      expect(prevented).toBe(true);
      expect(toggleFavSpy).toHaveBeenCalledWith(mockTrack1);

      await waitFor(() => {
        expect(recordFeedbackSpy).toHaveBeenCalledWith(mockTrack1, 'like');
        expect(useUIStore.getState().toastMessage?.text).toContain('Добавлено в любимое: "Starlight Symphony"');
      });

      toggleFavSpy.mockRestore();
      recordFeedbackSpy.mockRestore();
    });

    it('L shortcut removes favorite and shows info toast when track is already liked', async () => {
      const toggleFavSpy = vi.spyOn(useLibraryStore.getState(), 'toggleFavorite').mockResolvedValue(true);
      const recordFeedbackSpy = vi.spyOn(recommendationEngine, 'recordFeedback').mockResolvedValue();
      render(<ShortcutHost />);

      usePlayerStore.setState({ currentTrack: mockTrack1 });
      useLibraryStore.setState({ favorites: [mockTrack1] });

      const prevented = sendKey({ key: 'L' });
      expect(prevented).toBe(true);
      expect(toggleFavSpy).toHaveBeenCalledWith(mockTrack1);

      await waitFor(() => {
        expect(recordFeedbackSpy).not.toHaveBeenCalled();
        expect(useUIStore.getState().toastMessage?.text).toContain('Удалено из любимого: "Starlight Symphony"');
      });

      toggleFavSpy.mockRestore();
      recordFeedbackSpy.mockRestore();
    });

    it('D shortcut triggers dislikeAndSkipCurrentTrack and shows toast', async () => {
      const dislikeSpy = vi.spyOn(usePlayerStore.getState(), 'dislikeAndSkipCurrentTrack').mockResolvedValue();
      render(<ShortcutHost />);

      usePlayerStore.setState({ currentTrack: mockTrack1 });

      const prevented = sendKey({ key: 'd' });
      expect(prevented).toBe(true);
      expect(dislikeSpy).toHaveBeenCalledTimes(1);

      await waitFor(() => {
        expect(useUIStore.getState().toastMessage?.text).toContain('"Starlight Symphony" больше не будет рекомендоваться');
      });

      dislikeSpy.mockRestore();
    });

    it('protects text entry: typing w, r, l, d inside input or textarea does not trigger player shortcuts', () => {
      const startMyWaveSpy = vi.spyOn(usePlayerStore.getState(), 'startMyWave').mockResolvedValue();
      const startTrackRadioSpy = vi.spyOn(usePlayerStore.getState(), 'startTrackRadio').mockResolvedValue();
      const dislikeSpy = vi.spyOn(usePlayerStore.getState(), 'dislikeAndSkipCurrentTrack').mockResolvedValue();
      const toggleFavSpy = vi.spyOn(useLibraryStore.getState(), 'toggleFavorite').mockResolvedValue(true);

      render(<ShortcutHost />);
      const input = screen.getByTestId('search-input');
      const textarea = screen.getByTestId('text-area');

      usePlayerStore.setState({ currentTrack: mockTrack1 });

      // Trigger inside input
      fireEvent.keyDown(input, { key: 'w', altKey: true });
      fireEvent.keyDown(input, { key: 'r', altKey: true });
      fireEvent.keyDown(input, { key: 'l' });
      fireEvent.keyDown(input, { key: 'd' });

      // Trigger inside textarea
      fireEvent.keyDown(textarea, { key: 'l' });
      fireEvent.keyDown(textarea, { key: 'd' });

      expect(startMyWaveSpy).not.toHaveBeenCalled();
      expect(startTrackRadioSpy).not.toHaveBeenCalled();
      expect(toggleFavSpy).not.toHaveBeenCalled();
      expect(dislikeSpy).not.toHaveBeenCalled();

      startMyWaveSpy.mockRestore();
      startTrackRadioSpy.mockRestore();
      dislikeSpy.mockRestore();
      toggleFavSpy.mockRestore();
    });

    it('ignores unmodified W and R or chords with Ctrl/Meta/Shift', () => {
      const startMyWaveSpy = vi.spyOn(usePlayerStore.getState(), 'startMyWave').mockResolvedValue();
      const startTrackRadioSpy = vi.spyOn(usePlayerStore.getState(), 'startTrackRadio').mockResolvedValue();
      render(<ShortcutHost />);

      usePlayerStore.setState({ currentTrack: mockTrack1 });

      expect(sendKey({ key: 'w' })).toBe(false);
      expect(sendKey({ key: 'r' })).toBe(false);
      expect(sendKey({ key: 'w', ctrlKey: true })).toBe(false);
      expect(sendKey({ key: 'r', ctrlKey: true })).toBe(false);
      expect(sendKey({ key: 'l', shiftKey: true })).toBe(false);
      expect(sendKey({ key: 'd', shiftKey: true })).toBe(false);

      expect(startMyWaveSpy).not.toHaveBeenCalled();
      expect(startTrackRadioSpy).not.toHaveBeenCalled();

      startMyWaveSpy.mockRestore();
      startTrackRadioSpy.mockRestore();
    });

    it('MediaSession handles metadata, playback state, position state, and action callbacks smoothly', () => {
      // 1. Update metadata
      MediaSessionService.updateMetadata(mockTrack1);
      const meta = navigator.mediaSession.metadata;
      expect(meta).toBeDefined();
      expect(meta?.title).toBe('Starlight Symphony');
      expect(meta?.artist).toBe('Cosmic Orchestra');
      expect(meta?.album).toBe('Space Odyssey');
      expect(meta?.artwork).toHaveLength(4);

      // 2. Playback state transitions
      MediaSessionService.updatePlaybackState('loading');
      expect(navigator.mediaSession.playbackState).toBe('paused');
      MediaSessionService.updatePlaybackState('playing');
      expect(navigator.mediaSession.playbackState).toBe('playing');
      MediaSessionService.updatePlaybackState('paused');
      expect(navigator.mediaSession.playbackState).toBe('paused');

      // 3. Position state
      MediaSessionService.updatePositionState(240, 60, 1);
      const posState = (navigator.mediaSession as any).positionState;
      expect(posState?.duration).toBe(240);
      expect(posState?.position).toBe(60);

      // 4. Action handlers
      const callbacks = {
        onPlay: vi.fn(),
        onPause: vi.fn(),
        onNext: vi.fn(),
        onPrev: vi.fn(),
        onSeek: vi.fn(),
        onStop: vi.fn()
      };
      MediaSessionService.registerActionHandlers(callbacks);

      const session = navigator.mediaSession as any;
      session.triggerAction('play');
      expect(callbacks.onPlay).toHaveBeenCalledTimes(1);
      session.triggerAction('pause');
      expect(callbacks.onPause).toHaveBeenCalledTimes(1);
      session.triggerAction('nexttrack');
      expect(callbacks.onNext).toHaveBeenCalledTimes(1);
      session.triggerAction('previoustrack');
      expect(callbacks.onPrev).toHaveBeenCalledTimes(1);
      session.triggerAction('seekto', { seekTime: 120 });
      expect(callbacks.onSeek).toHaveBeenCalledWith(120);
      session.triggerAction('stop');
      expect(callbacks.onStop).toHaveBeenCalledTimes(1);

      // 5. Clear
      MediaSessionService.clear();
      expect(navigator.mediaSession.metadata).toBeNull();
      expect(navigator.mediaSession.playbackState).toBe('none');
    });

    it('WaveView renders Cyber-Glass UI with visualizer orb, current track, and tuner', () => {
      vi.spyOn(recommendationEngine, 'buildUserProfile').mockRejectedValue(new Error('no profile'));
      usePlayerStore.setState({
        currentTrack: mockTrack1,
        isPlaying: true,
        queueMode: 'my_wave',
        activeWaveMood: 'favorite',
        sourceQueue: [mockTrack1, mockTrack2],
        currentIndex: 0
      });

      render(<WaveView />);

      expect(screen.getByTestId('wave-view')).toBeInTheDocument();
      expect(screen.getByText('Поток')).toBeInTheDocument();
      expect(screen.getByTestId('wave-visualizer-orb')).toBeInTheDocument();
      expect(screen.getByTestId('wave-current-track')).toBeInTheDocument();
      expect(screen.getByText('Starlight Symphony')).toBeInTheDocument();
      expect(screen.getByText('Cosmic Orchestra')).toBeInTheDocument();
      expect(screen.getByTestId('wave-controls')).toBeInTheDocument();

      // Регуляторы спрятаны, пока их не открыли: экран волны должен начинаться
      // с музыки, а не с настроек.
      expect(screen.queryByTestId('wave-tuner')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('wave-btn-tune'));
      expect(screen.getByTestId('wave-source-picker')).toBeInTheDocument();
      expect(screen.getByTestId('wave-tuner')).toBeInTheDocument();
    });
  });
});
