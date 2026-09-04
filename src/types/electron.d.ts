import type { MiniSkinId } from '../styles/miniSkins';

export type MediaKeyAction = 'play-pause' | 'next' | 'prev' | 'stop';

/** Commands the detached mini player sends to the window that owns audio. */
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

/** Snapshot pushed to the mini player; it holds no playback state of its own. */
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
  /**
   * Chosen mini-player skin. Optional on purpose: the mini window reads its own
   * persisted copy on boot, so a snapshot without this field simply leaves the
   * look alone — which is what makes changing the skin mid-session possible
   * without a second IPC channel.
   */
  skin?: MiniSkinId;
}

/** What the main process knows about the last stream resolutions. */
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

/** Outcome of the in-app Discord consent window. */
export interface DiscordLoginResult {
  ok: boolean;
  /** The redirect URL with the token fragment, when `ok`. */
  url?: string;
  error?: string;
  code?: string;
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

/** Where the background updater is right now. See electron/updater.ts. */
export type UpdateStatus =
  /** Nowhere to update from: dev run, portable build, or no release channel. */
  | 'unsupported'
  | 'idle'
  | 'checking'
  /** A newer version exists; the download starts on its own. */
  | 'available'
  | 'downloading'
  /** The package is on disk — waiting for a restart. */
  | 'ready'
  | 'up-to-date'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  newVersion: string | null;
  /** Whole percent, 0–100. */
  percent: number;
  /** Human-readable reason for `error` and `unsupported`. */
  message: string | null;
  checkedAt: number | null;
}

/**
 * The context-bridge surface exposed by `electron/preload.ts`. This is the only
 * renderer-side declaration of the desktop API — keep it in sync with the
 * preload implementation.
 */
/** Снимок связи с Discord — то же, что отдаёт главный процесс. */
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
  /** Opens an http(s) URL in the system browser; rejects for any other scheme. */
  openExternal: (url: string) => Promise<void>;
  /** Subscribes to `wireon://` deep links. Returns its own unsubscribe function. */
  onDeepLink: (callback: (url: string) => void) => () => void;
  /**
   * Runs the Discord consent screen in a window owned by the app and resolves
   * with the redirect URL. Absent in the browser build, which uses a popup.
   */
  discordLogin?: (authUrl: string) => Promise<DiscordLoginResult>;
  /**
   * Доведёт ли система ответ Discord из системного браузера обратно к нам.
   * Отсутствует в сборках до 1.0.10 — там вход всегда шёл окном приложения.
   */
  discordDeepLinkReady?: () => Promise<boolean>;
  /** Forgets the remembered Discord account so another one can sign in. */
  discordForgetSession?: () => Promise<boolean>;
  /**
   * @param priority `prefetch` — фон (предзагрузка, сохранение в офлайн): такой
   *   запрос пропустит вперёд любой, которого ждёт человек.
   */
  resolveYouTubeStream: (videoId: string, priority?: 'user' | 'prefetch') => Promise<any>;
  /**
   * Есть ли в сборке ffmpeg.
   *
   * Опционально: в старой сборке метода нет вообще, и офлайн тогда сохраняет
   * без сжатия — проверять надо наличие функции, а не только её ответ.
   */
  transcodeAvailable?: () => Promise<boolean>;
  /** Сжимает аудио в opus. На любой сбой вернёт исходные байты с `compressed: false`. */
  transcodeAudio?: (payload: TranscodeAudioRequest) => Promise<TranscodeAudioResult>;
  /** Stream log plus yt-dlp status, for Settings → Диагностика. */
  getStreamDiagnostics: () => Promise<StreamDiagnostics>;
  /** Источник cookies для YouTube; `null` — не использовать. Вернёт применённое значение. */
  setYouTubeCookiesBrowser?: (browser: string | null) => Promise<string | null>;
  clearStreamCache: () => Promise<boolean>;
  searchYouTube: (query: string) => Promise<any>;
  /**
   * Радио YouTube Music от одной песни — сырой ответ InnerTube `next`.
   * Необязательный: в сборке без обновлённого preload его просто нет.
   */
  youtubeRadio?: (videoId: string) => Promise<any>;
  searchSoundCloud: (query: string, clientId: string, limit?: number) => Promise<any>;
  setMiniPlayerMode: (enabled: boolean, layout?: 'compact' | 'square' | 'expanded') => Promise<void>;
  setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<boolean>;
  isAlwaysOnTop: () => Promise<boolean>;
  discordRpcSetActivity: (activity: any) => Promise<boolean>;
  discordRpcSetEnabled: (enabled: boolean) => Promise<void>;
  /** `null` — в этом главном процессе ручки ещё нет. */
  discordRpcStatus?: () => Promise<DiscordRpcStatusView | null>;
  /** Строка в журнал ссылок. Необязательна: у старого главного процесса её нет. */
  playbackLog?: (message: string) => Promise<boolean>;
  /** True inside the detached mini player window. */
  isMiniWindow?: boolean;
  openMiniWindow: () => Promise<boolean>;
  closeMiniWindow: () => Promise<boolean>;
  isMiniWindowOpen: () => Promise<boolean>;
  sendMiniState: (state: MiniPlayerState) => void;
  onMiniState: (callback: (state: MiniPlayerState) => void) => () => void;
  sendMiniCommand: (command: MiniPlayerCommand) => void;
  onMiniCommand: (callback: (command: MiniPlayerCommand) => void) => () => void;
  onMiniWindowVisibility: (callback: (open: boolean) => void) => () => void;
  /**
   * Background updates. Absent in the browser build and in older desktop
   * builds, so every caller has to cope with them being missing.
   */
  getUpdateState?: () => Promise<UpdateState>;
  checkForUpdates?: () => Promise<UpdateState>;
  /** Installs the downloaded update and restarts the app. */
  installUpdate?: () => Promise<boolean>;
  onUpdateState?: (callback: (state: UpdateState) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}
