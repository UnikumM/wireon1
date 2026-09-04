import { contextBridge, ipcRenderer } from 'electron';

export type MediaKeyAction = 'play-pause' | 'next' | 'prev' | 'stop';

/** Commands the detached mini player may send back to the window that owns audio. */
export type MiniPlayerCommand =
  | { type: 'play-pause' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'seek'; value: number }
  | { type: 'volume'; value: number }
  | { type: 'toggle-favorite' }
  | { type: 'shuffle' }
  | { type: 'repeat' }
  | { type: 'focus-main' }
  | { type: 'request-state' };

/** Snapshot pushed to the mini player; it renders this and owns no playback state. */
export interface MiniPlayerState {
  title: string;
  artist: string;
  artwork: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isFavorite: boolean;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  accent: string | null;
}

/** Outcome of the in-app Discord consent window. */
export interface DiscordLoginResult {
  ok: boolean;
  /** The redirect URL with the token fragment, when `ok`. */
  url?: string;
  error?: string;
  code?: string;
}

/** Что показывает панель диагностики: лог извлечения и состояние yt-dlp. */
export interface StreamDiagnostics {
  log: string[];
  ytDlpPath: string;
  ytDlpAvailable: boolean;
  /** `managed` — обновлённый бинарник из userData, `bundled` — из установщика. */
  ytDlpSource?: 'bundled' | 'managed';
  /** Версия обновлённого бинарника; у вшитого её никто не спрашивает. */
  ytDlpVersion?: string | null;
  /** Браузер, из cookies которого берётся сессия YouTube; `null` — не берётся. */
  cookiesBrowser?: string | null;
  /** В этом запуске уже натыкались на проверку «подтвердите, что вы не робот». */
  botCheckSeen?: boolean;
  logPath: string | null;
}

/** Что уезжает в ffmpeg на сжатие офлайн-трека, см. electron/transcoder.ts. */
export interface TranscodeAudioRequest {
  data: Uint8Array;
  /** Только из списка в transcoder.ts; чужое значение там заменят на дефолтное. */
  bitrateKbps?: number;
  /** Расширение источника — подсказка ffmpeg про контейнер. */
  sourceExt?: string;
}

/** Ответ ffmpeg. `compressed: false` — вернулся оригинал, причина в `reason`. */
export interface TranscodeAudioResult {
  data: Uint8Array;
  format: string;
  bitrate: number;
  compressed: boolean;
  reason?: string;
}

/** Mirrors `UpdateStatus` in electron/updater.ts. */
export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error';

/** Mirrors `UpdateState` in electron/updater.ts. */
export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  newVersion: string | null;
  percent: number;
  message: string | null;
  checkedAt: number | null;
}

/**
 * What the renderer is told when the main process cannot be reached at all.
 * A failed IPC call must not leave the UI without a status.
 */
const UPDATE_STATE_UNKNOWN: UpdateState = {
  status: 'unsupported',
  currentVersion: '',
  newVersion: null,
  percent: 0,
  message: 'Состояние обновлений недоступно.',
  checkedAt: null
};

/** Снимок связи с Discord — ровно то, что показывает раздел «Приложение». */
export interface DiscordRpcStatusView {
  connected: boolean;
  ready: boolean;
  enabled: boolean;
  clientId: string;
  lastError: string | null;
  lastAcceptedAt: number | null;
}

export interface ElectronAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  getPlatform: () => string;
  onWindowStateChange: (callback: (isMaximized: boolean) => void) => () => void;
  onMediaKey: (callback: (action: MediaKeyAction) => void) => () => void;
  setMediaKeysEnabled: (enabled: boolean) => void;
  openExternal: (url: string) => Promise<void>;
  onDeepLink: (callback: (url: string) => void) => () => void;
  /** Runs the Discord consent screen in a window owned by the app. */
  discordLogin: (authUrl: string) => Promise<DiscordLoginResult>;
  /** Доведёт ли система ответ Discord из системного браузера обратно к нам. */
  discordDeepLinkReady: () => Promise<boolean>;
  /** Forgets the remembered Discord account so another one can sign in. */
  discordForgetSession: () => Promise<boolean>;
  resolveYouTubeStream: (videoId: string, priority?: 'user' | 'prefetch') => Promise<any>;
  /** Есть ли вшитый ffmpeg: без него офлайн сохраняет без сжатия. */
  transcodeAvailable: () => Promise<boolean>;
  /** Сжимает аудио в opus перед укладкой в офлайн; на любой сбой вернёт оригинал. */
  transcodeAudio: (payload: TranscodeAudioRequest) => Promise<TranscodeAudioResult>;
  getStreamDiagnostics: () => Promise<StreamDiagnostics>;
  setYouTubeCookiesBrowser: (browser: string | null) => Promise<string | null>;
  clearStreamCache: () => Promise<boolean>;
  searchYouTube: (query: string) => Promise<any>;
  /** Радио YouTube Music от одной песни: сырой ответ InnerTube `next`. */
  youtubeRadio: (videoId: string) => Promise<any>;
  searchSoundCloud: (query: string, clientId: string, limit?: number) => Promise<any>;
  setMiniPlayerMode: (enabled: boolean, layout?: 'compact' | 'square' | 'expanded') => Promise<void>;
  setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<boolean>;
  isAlwaysOnTop: () => Promise<boolean>;
  discordRpcSetActivity: (activity: any) => Promise<boolean>;
  discordRpcSetEnabled: (enabled: boolean) => Promise<void>;
  /**
   * Что сейчас с Discord. `null` — старый главный процесс, в котором ручки
   * ещё нет: обновление приложения и его начинки не всегда совпадают по
   * времени.
   */
  discordRpcStatus: () => Promise<DiscordRpcStatusView | null>;
  /** Строка в журнал ссылок — чтобы заминки не пропадали вместе с консолью. */
  playbackLog: (message: string) => Promise<boolean>;
  /** True inside the detached mini player window. */
  isMiniWindow: boolean;
  openMiniWindow: () => Promise<boolean>;
  closeMiniWindow: () => Promise<boolean>;
  isMiniWindowOpen: () => Promise<boolean>;
  /** Main renderer → mini player. */
  sendMiniState: (state: MiniPlayerState) => void;
  onMiniState: (callback: (state: MiniPlayerState) => void) => () => void;
  /** Mini player → main renderer. */
  sendMiniCommand: (command: MiniPlayerCommand) => void;
  onMiniCommand: (callback: (command: MiniPlayerCommand) => void) => () => void;
  /** Lets the main renderer start/stop pushing state as the mini window appears. */
  onMiniWindowVisibility: (callback: (open: boolean) => void) => () => void;
  /** Current state of the background updater. */
  getUpdateState: () => Promise<UpdateState>;
  /** Asks the server right now; resolves with the state after the answer. */
  checkForUpdates: () => Promise<UpdateState>;
  /** Installs the downloaded update and restarts the app. */
  installUpdate: () => Promise<boolean>;
  onUpdateState: (callback: (state: UpdateState) => void) => () => void;
}

export const electronAPI: ElectronAPI = {
  minimize: (): void => {
    ipcRenderer.send('window-minimize');
  },
  maximize: (): void => {
    ipcRenderer.send('window-maximize');
  },
  close: (): void => {
    ipcRenderer.send('window-close');
  },
  isMaximized: async (): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke('window-is-maximized');
    } catch {
      return false;
    }
  },
  getPlatform: (): string => {
    return process.platform;
  },
  onWindowStateChange: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: any, isMaximized: boolean) => {
      callback(isMaximized);
    };
    ipcRenderer.on('window-state-changed', listener);
    return () => {
      ipcRenderer.removeListener('window-state-changed', listener);
    };
  },
  onMediaKey: (callback: (action: MediaKeyAction) => void): (() => void) => {
    const listener = (_event: any, action: MediaKeyAction) => {
      callback(action);
    };
    ipcRenderer.on('media-key-event', listener);
    return () => {
      ipcRenderer.removeListener('media-key-event', listener);
    };
  },
  setMediaKeysEnabled: (enabled: boolean): void => {
    ipcRenderer.send('set-media-keys-enabled', enabled);
  },
  openExternal: (url: string): Promise<void> => {
    return ipcRenderer.invoke('open-external', url);
  },
  onDeepLink: (callback: (url: string) => void): (() => void) => {
    const listener = (_event: any, url: string) => {
      callback(url);
    };
    ipcRenderer.on('deep-link', listener);
    return () => {
      ipcRenderer.removeListener('deep-link', listener);
    };
  },
  discordLogin: async (authUrl: string): Promise<DiscordLoginResult> => {
    try {
      return await ipcRenderer.invoke('discord-login', authUrl);
    } catch (err) {
      return {
        ok: false,
        code: 'IPC_FAILED',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
  discordDeepLinkReady: async (): Promise<boolean> => {
    try {
      return (await ipcRenderer.invoke('discord-deep-link-ready')) === true;
    } catch {
      // Старый главный процесс этого канала не знает. «Нет» здесь безопаснее:
      // приложение откроет своё окно входа вместо браузера, из которого ответ
      // может не вернуться.
      return false;
    }
  },
  discordForgetSession: async (): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke('discord-forget-session');
    } catch {
      return false;
    }
  },
  resolveYouTubeStream: (videoId: string, priority?: 'user' | 'prefetch'): Promise<any> => {
    return ipcRenderer.invoke('resolve-youtube-stream', videoId, priority);
  },
  transcodeAvailable: async (): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke('transcode-available');
    } catch {
      return false;
    }
  },
  transcodeAudio: async (payload: TranscodeAudioRequest): Promise<TranscodeAudioResult> => {
    // Сбой моста не должен рушить сохранение трека: возвращаем те же байты
    // несжатыми, ровно как это делает главный процесс на ошибку ffmpeg.
    try {
      return await ipcRenderer.invoke('transcode-audio', payload);
    } catch (err) {
      return {
        data: payload?.data ?? new Uint8Array(0),
        format: payload?.sourceExt || 'bin',
        bitrate: payload?.bitrateKbps ?? 0,
        compressed: false,
        reason: err instanceof Error ? err.message : String(err)
      };
    }
  },
  getStreamDiagnostics: async (): Promise<StreamDiagnostics> => {
    try {
      return await ipcRenderer.invoke('get-stream-diagnostics');
    } catch {
      return { log: [], ytDlpPath: '', ytDlpAvailable: false, logPath: null };
    }
  },
  /** `null` — не использовать cookies; вернётся то, что применилось. */
  setYouTubeCookiesBrowser: async (browser: string | null): Promise<string | null> => {
    try {
      return await ipcRenderer.invoke('set-youtube-cookies-browser', browser);
    } catch {
      return null;
    }
  },
  clearStreamCache: async (): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke('clear-stream-cache');
    } catch {
      return false;
    }
  },
  searchYouTube: (query: string): Promise<any> => {
    return ipcRenderer.invoke('search-youtube', query);
  },
  youtubeRadio: (videoId: string): Promise<any> => {
    return ipcRenderer.invoke('youtube-radio', videoId);
  },
  searchSoundCloud: (query: string, clientId: string, limit?: number): Promise<any> => {
    return ipcRenderer.invoke('search-soundcloud', query, clientId, limit);
  },
  setMiniPlayerMode: (enabled: boolean, layout?: 'compact' | 'square' | 'expanded'): Promise<void> => {
    return ipcRenderer.invoke('set-mini-player-mode', enabled, layout);
  },
  setAlwaysOnTop: (alwaysOnTop: boolean): Promise<boolean> => {
    return ipcRenderer.invoke('set-always-on-top', alwaysOnTop);
  },
  isAlwaysOnTop: (): Promise<boolean> => {
    return ipcRenderer.invoke('get-always-on-top');
  },
  discordRpcSetActivity: async (activity: any): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke('discord-rpc-set-activity', activity);
    } catch {
      return false;
    }
  },
  discordRpcSetEnabled: async (enabled: boolean): Promise<void> => {
    try {
      await ipcRenderer.invoke('discord-rpc-set-enabled', enabled);
    } catch {
      // Ignore
    }
  },
  discordRpcStatus: async (): Promise<DiscordRpcStatusView | null> => {
    try {
      return await ipcRenderer.invoke('discord-rpc-status');
    } catch {
      return null;
    }
  },
  playbackLog: async (message: string): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke('playback-log', message);
    } catch {
      return false;
    }
  },
  // The mini player runs in its own window, so it is told which one it is at
  // creation time rather than guessing from the URL.
  isMiniWindow: typeof process !== 'undefined' && Array.isArray(process.argv)
    ? process.argv.includes('--wireon-mini')
    : false,
  openMiniWindow: async (): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke('open-mini-window');
    } catch {
      return false;
    }
  },
  closeMiniWindow: async (): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke('close-mini-window');
    } catch {
      return false;
    }
  },
  isMiniWindowOpen: async (): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke('is-mini-window-open');
    } catch {
      return false;
    }
  },
  sendMiniState: (state: MiniPlayerState): void => {
    ipcRenderer.send('mini-state', state);
  },
  onMiniState: (callback: (state: MiniPlayerState) => void): (() => void) => {
    const listener = (_event: any, state: MiniPlayerState) => {
      callback(state);
    };
    ipcRenderer.on('mini-state', listener);
    return () => {
      ipcRenderer.removeListener('mini-state', listener);
    };
  },
  sendMiniCommand: (command: MiniPlayerCommand): void => {
    ipcRenderer.send('mini-command', command);
  },
  onMiniCommand: (callback: (command: MiniPlayerCommand) => void): (() => void) => {
    const listener = (_event: any, command: MiniPlayerCommand) => {
      callback(command);
    };
    ipcRenderer.on('mini-command', listener);
    return () => {
      ipcRenderer.removeListener('mini-command', listener);
    };
  },
  onMiniWindowVisibility: (callback: (open: boolean) => void): (() => void) => {
    const listener = (_event: any, open: boolean) => {
      callback(open);
    };
    ipcRenderer.on('mini-window-visibility', listener);
    return () => {
      ipcRenderer.removeListener('mini-window-visibility', listener);
    };
  },
  getUpdateState: async (): Promise<UpdateState> => {
    try {
      return await ipcRenderer.invoke('update:get-state');
    } catch {
      return UPDATE_STATE_UNKNOWN;
    }
  },
  checkForUpdates: async (): Promise<UpdateState> => {
    try {
      return await ipcRenderer.invoke('update:check');
    } catch {
      return UPDATE_STATE_UNKNOWN;
    }
  },
  installUpdate: async (): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke('update:install');
    } catch {
      return false;
    }
  },
  onUpdateState: (callback: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: any, state: UpdateState) => {
      callback(state);
    };
    ipcRenderer.on('update:state', listener);
    return () => {
      ipcRenderer.removeListener('update:state', listener);
    };
  }
};

// Expose safely in renderer main world via contextBridge
try {
  if (typeof contextBridge !== 'undefined' && typeof contextBridge.exposeInMainWorld === 'function') {
    contextBridge.exposeInMainWorld('electronAPI', electronAPI);
  }
} catch {
  // In pure unit test environment without Electron context isolation
}

export default electronAPI;
