import { app, BrowserWindow, ipcMain, globalShortcut, protocol, session, shell } from 'electron';
import type { Session } from 'electron';
import { cpSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import youtubedl, { create } from 'youtube-dl-exec';
import discordRpc, { DiscordRpcClient, DiscordActivityPayload } from './discordRpc.js';
import { StreamResolver, normalizeCookieBrowser } from './streamResolver.js';
import { AudioTranscoder, normalizeBitrate } from './transcoder.js';
import { YtDlpManager } from './ytdlp.js';
import { DISCORD_AUTH_SCHEME, runDiscordLogin } from './authWindow.js';
import {
  createUpdateService,
  setupUpdaterIpc,
  UpdateService,
  UpdateState,
  UPDATE_STATE_CHANNEL,
} from './updater.js';

export { discordRpc };

let mainWindow: BrowserWindow | null = null;
/** The detached always-on-top mini player, when the user has opened it. */
let miniWindow: BrowserWindow | null = null;
let mediaKeysEnabled = false;
/** Deep link captured before the renderer was ready to receive it. */
let pendingDeepLink: string | null = null;
let rendererReady = false;
/** Background update checks; lives as long as the app does. */
let updateService: UpdateService | null = null;

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_DEV_SERVER_URL = 'http://localhost:3000';

/** Собственная схема приложения. Ответ Discord через неё больше не ходит. */
export const DEEP_LINK_SCHEME = 'wireon';

/**
 * Схемы, которые приложение забирает себе в системе.
 *
 * Вторая — та, по которой возвращается Discord. Своя `wireon://` для этого не
 * годится: Discord принимает только `discord-{идентификатор заявки}` и любую
 * другую отвергает, даже прописанную в панели разработчика. Проверено на обеих
 * настройках «общедоступного клиента».
 */
export const DEEP_LINK_SCHEMES = [DEEP_LINK_SCHEME, DISCORD_AUTH_SCHEME] as const;

/** Scheme claimed by builds released before the rename to Wireon. */
export const LEGACY_DEEP_LINK_SCHEME = 'vireon';

/** `productName` of those same pre-rename builds; also their userData folder. */
export const LEGACY_PRODUCT_NAME = 'VireonMusic';

/**
 * Profile subdirectories carried over from a pre-rename install: the library and
 * offline audio live in `IndexedDB`, the auth session in `Local Storage`.
 */
const MIGRATED_PROFILE_DIRS = ['IndexedDB', 'Local Storage', 'Session Storage'] as const;

/** Milliseconds to wait for `ready-to-show` before showing the window regardless. */
const SHOW_TIMEOUT_MS = 10_000;

type MediaKeyAction = 'play-pause' | 'next' | 'prev' | 'stop';

const MEDIA_KEY_MAP: ReadonlyArray<{ key: string; action: MediaKeyAction }> = [
  { key: 'MediaPlayPause', action: 'play-pause' },
  { key: 'MediaNextTrack', action: 'next' },
  { key: 'MediaPreviousTrack', action: 'prev' },
  { key: 'MediaStop', action: 'stop' },
];

/**
 * Hosts whose requests need a desktop User-Agent and a permissive CORS
 * response. Covers the YouTube/SoundCloud APIs plus every Piped and Invidious
 * fallback instance the renderer talks to.
 */
export const targetUrls: ReadonlyArray<string> = [
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
];

/** Hosts that expect YouTube's own Origin/Referer pair. */
const YOUTUBE_HOSTS = ['youtube.com', 'music.youtube.com', 'suggestqueries.google.com'];
const GOOGLEVIDEO_HOSTS = ['googlevideo.com'];

const SOUNDCLOUD_HOSTS = ['soundcloud.com', 'sndcdn.com'];

/** Third-party mirrors: desktop User-Agent only, never YouTube's Origin/Referer. */
const MIRROR_HOSTS = [
  'ytimg.com',
  'piped.privacydev.net',
  'pipedapi.kavin.rocks',
  'pipedapi.leptons.xyz',
  'piped.video',
  'piped.private.coffee',
  'api.piped.private.coffee',
  'invidious.flokinet.to',
  'invidious.schenkel.eti.br',
  'invidious.materialio.us',
  'invidious.nerdvpn.de',
  'inv.nadeko.net',
  'invidious.jing.rocks',
  'yt.drgnz.club',
  'invidious.io',
];

// Safe __dirname resolution supporting both CJS and ESM environments
export function getAppDir(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Application root — the parent of `dist-electron`. Resolves identically in dev
 * and inside `app.asar`, where electron-builder copies `dist/`, `dist-electron/`
 * and `public/` next to each other.
 */
export function getAppRoot(): string {
  return path.join(getAppDir(), '..');
}

/** CommonJS preload bundle; Electron cannot load an ESM preload. */
export function getPreloadPath(): string {
  return path.join(getAppDir(), 'preload.cjs');
}

export function getIndexHtmlPath(): string {
  return path.join(getAppRoot(), 'dist', 'index.html');
}

export function getWindowIconPath(): string {
  return path.join(getAppRoot(), 'public', 'icon.png');
}

/**
 * Путь к yt-dlp из установщика — и в dev, и внутри распакованного asar.
 *
 * Это запас: обычно играет обновлённый бинарник из userData, см. ytdlp.ts.
 */
export function getBundledYtDlpPath(): string {
  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  if (app && app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'youtube-dl-exec',
      'bin',
      binaryName
    );
  }
  return path.join(getAppRoot(), 'node_modules', 'youtube-dl-exec', 'bin', binaryName);
}

/**
 * Путь к вшитому ffmpeg — им сжимается офлайн-библиотека, см. transcoder.ts.
 *
 * Считается так же, как путь к yt-dlp, и по той же причине: изнутри asar
 * бинарник не запустить, поэтому в упакованной сборке он лежит распакованным
 * рядом (`asarUnpack` в electron-builder.json).
 */
export function getBundledFfmpegPath(): string {
  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', binaryName);
  }
  return path.join(getAppRoot(), 'node_modules', 'ffmpeg-static', binaryName);
}

let audioTranscoder: AudioTranscoder | null = null;

/**
 * Тот, кто сжимает офлайн-треки.
 *
 * Лениво по той же причине, что резолвер: `app.getPath` до инициализации
 * Electron смысла не имеет, а модуль импортируют тесты.
 */
export function getAudioTranscoder(): AudioTranscoder {
  if (!audioTranscoder) {
    let tempDir: string | null = null;
    try {
      tempDir = app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
    } catch {
      tempDir = null;
    }
    audioTranscoder = new AudioTranscoder({
      ffmpegPath: getBundledFfmpegPath(),
      // Внутри userData, а не в системном temp: временный файл здесь размером с
      // трек, и чистильщики Windows не должны унести его посреди работы.
      tempDir: tempDir || tmpdir(),
      log: (message: string) => getStreamResolver().log(message)
    });
  }
  return audioTranscoder;
}

let ytDlpManager: YtDlpManager | null = null;

/**
 * Тот, кто держит yt-dlp свежим.
 *
 * Лениво по той же причине, что и резолвер: `app.getPath('userData')` имеет
 * смысл только после инициализации Electron, а модуль импортируют тесты.
 */
export function getYtDlpManager(): YtDlpManager {
  if (!ytDlpManager) {
    let stateDir: string | null = null;
    try {
      stateDir = app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
    } catch {
      stateDir = null;
    }
    ytDlpManager = new YtDlpManager({
      bundledPath: getBundledYtDlpPath(),
      stateDir,
      // Один лог на всё извлечение: разбираться в одном файле проще, чем в двух.
      log: (message: string) => getStreamResolver().log(`yt-dlp: ${message}`),
      // Кэш пережил бы обновление и продолжил отдавать ссылки прежнего
      // извлекателя — те самые, которые не играют.
      onUpdated: () => getStreamResolver().clearCache()
    });
  }
  return ytDlpManager;
}

/** Бинарник, которым извлекаем прямо сейчас: обновлённый, если он есть. */
export function getYtDlpBinaryPath(): string {
  return getYtDlpManager().getBinaryPath();
}

type YtdlFn = (url: string, flags: Record<string, unknown>) => Promise<unknown>;

let ytdlBinding: { exe: string; run: YtdlFn } | null = null;

/**
 * `youtube-dl-exec`, привязанный к актуальному бинарнику.
 *
 * Привязка пересоздаётся, когда путь изменился, — иначе обновлённый yt-dlp
 * начал бы работать только после перезапуска приложения, а весь смысл в том,
 * чтобы починка доехала до человека сразу.
 */
function getYtdl(): YtdlFn {
  const exe = getYtDlpBinaryPath();
  if (!ytdlBinding || ytdlBinding.exe !== exe) {
    ytdlBinding = {
      exe,
      run: (typeof create === 'function' ? create(exe) : youtubedl) as YtdlFn
    };
  }
  return ytdlBinding.run;
}

let streamResolver: StreamResolver | null = null;

/**
 * The single {@link StreamResolver} for the process.
 *
 * Built lazily because `app.getPath('userData')` is only meaningful once Electron
 * has initialised, and this module is imported by unit tests that have no app.
 */
export function getStreamResolver(): StreamResolver {
  if (!streamResolver) {
    let stateDir: string | null = null;
    try {
      stateDir = app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
    } catch {
      stateDir = null;
    }
    streamResolver = new StreamResolver({
      // Через обёртку, а не напрямую: путь к бинарнику может поменяться на ходу.
      ytdl: (url, flags) => getYtdl()(url, flags),
      stateDir,
    });
  }
  return streamResolver;
}

/**
 * Resolves the URL the renderer should load: the Vite dev server when one is
 * announced, otherwise the built bundle.
 */
export function getDevServerUrl(): string | undefined {
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }
  const packaged = Boolean(app && app.isPackaged);
  if (packaged || existsSync(getIndexHtmlPath())) {
    return undefined;
  }
  return DEFAULT_DEV_SERVER_URL;
}

function hostMatches(hostname: string, suffixes: ReadonlyArray<string>): boolean {
  return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True for the app's own documents: the built bundle over file:// or the dev server. */
export function isAppContentUrl(url: string, devServerUrl?: string): boolean {
  if (url.startsWith('file://')) {
    return true;
  }
  if (devServerUrl && url.startsWith(devServerUrl)) {
    return true;
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);
}

/**
 * Guards {@link shell.openExternal}: only web URLs may be handed to the OS. A
 * renderer-supplied `file:`/`vbscript:` string would otherwise be launched with
 * the user's privileges.
 */
export function isExternallyOpenableUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

/**
 * Запирает окно на своих страницах: наружу — только в системный браузер.
 *
 * Без этого окно приложения можно увести куда угодно. Названия треков, описания
 * альбомов и тексты песен приходят от чужих сервисов, и любая ссылка оттуда —
 * `target="_blank"`, `window.open`, присвоение `location.href` — открывала бы
 * либо новое окно Electron без ограничений, либо уводила бы само приложение на
 * посторонний сайт, откуда обратно человек уже не вернётся.
 *
 * Окно авторизации живёт по своим правилам (ему как раз положено ходить на
 * discord.com) и настраивает всё это самостоятельно — см. authWindow.ts.
 */
export function guardWindowNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenableUrl(url)) {
      void shell.openExternal(url);
    }
    // Новых окон Electron не открываем никогда: всё внешнее — в браузер.
    return { action: 'deny' };
  });

  const blockNavigation = (event: Electron.Event, url: string): void => {
    if (isAppContentUrl(url, getDevServerUrl())) {
      return;
    }
    event.preventDefault();
    if (isExternallyOpenableUrl(url)) {
      void shell.openExternal(url);
    }
  };

  win.webContents.on('will-navigate', blockNavigation);
  // Отдельно от `will-navigate`: перенаправление с разрешённого адреса на чужой
  // события навигации не вызывает.
  win.webContents.on('will-redirect', blockNavigation);
}

/** True for every host in {@link targetUrls} — the hosts that need CORS relaxed. */
export function isStreamingHost(url: string): boolean {
  const hostname = getHostname(url);
  if (!hostname) {
    return false;
  }
  return (
    hostMatches(hostname, GOOGLEVIDEO_HOSTS) ||
    hostMatches(hostname, YOUTUBE_HOSTS) ||
    hostMatches(hostname, SOUNDCLOUD_HOSTS) ||
    hostMatches(hostname, MIRROR_HOSTS)
  );
}

/**
 * Spoofs a desktop browser for the media hosts. Origin/Referer are only sent to
 * the first-party hosts — the Piped/Invidious mirrors reject or mis-handle a
 * YouTube Origin. googlevideo.com CDN direct audio streams return 403 Forbidden
 * if an Origin header is sent, so Origin/Referer are stripped for googlevideo.
 */
export function rewriteRequestHeaders(
  url: string,
  headers: Record<string, string>
): Record<string, string> {
  const next: Record<string, string> = { ...headers };
  const hostname = getHostname(url);

  // Case-insensitively purge User-Agent, Origin, and Referer/Referrer variants
  for (const key of Object.keys(next)) {
    const lower = key.toLowerCase();
    if (lower === 'user-agent' || lower === 'origin' || lower === 'referer' || lower === 'referrer') {
      delete next[key];
    }
  }

  next['User-Agent'] = DESKTOP_USER_AGENT;

  if (hostMatches(hostname, YOUTUBE_HOSTS)) {
    next['Origin'] = 'https://music.youtube.com';
    next['Referer'] = 'https://music.youtube.com/';
  } else if (hostMatches(hostname, SOUNDCLOUD_HOSTS)) {
    next['Origin'] = 'https://soundcloud.com';
    next['Referer'] = 'https://soundcloud.com/';
  }

  return next;
}

/**
 * Content Security Policy for the app's own documents. The dev build needs
 * inline scripts (React Refresh preamble) and the HMR websocket; the packaged
 * build gets neither.
 */
/**
 * Источники, к которым окну можно обращаться, — те же, что зашиты в него при
 * сборке.
 *
 * Главный процесс собирается `tsc`, а не Vite, и `import.meta.env` ему
 * недоступен: значения кладёт рядом `scripts/build-preload.mjs`. Файла может не
 * быть (сборка без сервера, запуск из исходников) — тогда список пуст, и CSP
 * остаётся прежним, строгим.
 *
 * Схема здесь значима сама по себе. Разрешение `http://хост` **не покрывает**
 * соединение `ws://хост`, и это не мелочь: брокер «слушать вместе» живёт на том
 * же сервере и на том же порту, но обращаются к нему по `ws:` — комната
 * оставалась «только на этом устройстве» с подписью «Брокер не ответил», хотя
 * сервер отвечал сразу. Поэтому источники перечисляются по одному, вместе со
 * своими схемами.
 */
let cachedConnectOrigins: string[] | undefined;

export function readConfiguredConnectOrigins(): string[] {
  if (cachedConnectOrigins !== undefined) return cachedConnectOrigins;
  cachedConnectOrigins = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.join(here, 'server-origin.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { origins?: unknown; origin?: unknown };
    // `origin` строкой — форма прежних сборок; читается, чтобы обновление кода и
    // обновление сгенерированного файла не обязаны были совпасть по времени.
    const list = Array.isArray(parsed.origins)
      ? parsed.origins
      : typeof parsed.origin === 'string'
        ? [parsed.origin]
        : [];
    for (const item of list) {
      if (typeof item !== 'string' || !item) continue;
      try {
        const url = new URL(item);
        const origin = `${url.protocol}//${url.host}`;
        if (!cachedConnectOrigins.includes(origin)) cachedConnectOrigins.push(origin);
      } catch {
        // Кривой адрес молча пропускается: политика от этого только строже.
      }
    }
  } catch {
    // Ни файла, ни разбираемых адресов — значит сервера у этой сборки нет.
  }
  return cachedConnectOrigins;
}

/** Сбрасывает запомненные источники. Нужен тестам. */
export function resetConfiguredServerOrigin(): void {
  cachedConnectOrigins = undefined;
}

export function buildContentSecurityPolicy(
  isPackaged: boolean,
  serverOrigins: string | string[] | null = readConfiguredConnectOrigins()
): string {
  /*
   * Свой сервер приходится называть отдельным источником.
   *
   * `connect-src` разрешает `https:` целиком, а наш сервер отвечает по `http` на
   * нестандартном порту — то есть под разрешение не попадал. Это была вторая
   * стена, стоявшая за первой: даже когда сервер научился отвечать на предзапрос
   * браузера, запрос из упакованного приложения гасился ещё раньше, своим же
   * CSP, и `fetch` бросал ровно тот же `Failed to fetch`. В окне разработки
   * этого не видно вовсе — там страницу отдаёт Vite, и заголовка нет.
   *
   * Именно источники, а не `http:`/`ws:` целиком: разрешить весь
   * незашифрованный транспорт значило бы открыть дверь ради одной комнаты.
   * Адреса берутся из тех же настроек сборки, что и у окна
   * (`scripts/build-preload.mjs` кладёт их рядом с главным процессом), поэтому
   * сборка без сервера остаётся строгой.
   *
   * Их два, и второй — брокер «слушать вместе». Он на том же сервере и на том
   * же порту, но обращаются к нему по `ws:`, а разрешение `http://хост`
   * соединение `ws://хост` не покрывает: комната оставалась «только на этом
   * устройстве» с подписью «Брокер не ответил», хотя сервер отвечал сразу.
   */
  const extra = (Array.isArray(serverOrigins) ? serverOrigins : serverOrigins ? [serverOrigins] : [])
    .filter(Boolean)
    .join(' ');
  const connectExtra = extra ? ` ${extra}` : '';

  return [
    "default-src 'self'",
    isPackaged ? "script-src 'self'" : "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' https: blob:",
    (isPackaged ? "connect-src 'self' https: wss:" : "connect-src 'self' https: ws: wss:") +
      connectExtra,
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-src 'none'",
  ].join('; ');
}

/**
 * Installs the single request/response header pipeline: UA spoofing for the
 * media hosts, permissive CORS for their responses and a CSP for our own pages.
 * Electron keeps only the last listener per webRequest event, so both concerns
 * share one handler.
 */
export function setupSessionHeaders(sess: Session, isPackaged: boolean): void {
  const csp = buildContentSecurityPolicy(isPackaged);

  sess.webRequest.onBeforeSendHeaders(
    { urls: [...targetUrls] },
    (details, callback) => {
      callback({
        requestHeaders: rewriteRequestHeaders(
          details.url,
          details.requestHeaders as Record<string, string>
        ),
      });
    }
  );

  sess.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders: Record<string, string[]> = {
      ...(details.responseHeaders as Record<string, string[]> | undefined),
    };

    if (isStreamingHost(details.url)) {
      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase().startsWith('access-control-')) {
          delete responseHeaders[key];
        }
      }

      responseHeaders['Access-Control-Allow-Origin'] = ['*'];
      responseHeaders['Access-Control-Allow-Methods'] = ['GET, HEAD, POST, OPTIONS'];
      responseHeaders['Access-Control-Allow-Headers'] = ['*'];
      responseHeaders['Access-Control-Expose-Headers'] = [
        'Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Encoding, Range'
      ];
    }

    if (isAppContentUrl(details.url, getDevServerUrl())) {
      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase() === 'content-security-policy') {
          delete responseHeaders[key];
        }
      }
      responseHeaders['Content-Security-Policy'] = [csp];
    }

    callback({ responseHeaders });
  });
}

/**
 * Setup Window State Listeners to notify the renderer process
 */
export function setupWindowStateListeners(win: BrowserWindow): void {
  const emit = (isMaximized: boolean): void => {
    if (!win.isDestroyed()) {
      win.webContents.send('window-state-changed', isMaximized);
    }
  };

  win.on('maximize', () => emit(true));
  win.on('unmaximize', () => emit(false));
  win.on('enter-full-screen', () => emit(true));
  win.on('leave-full-screen', () => emit(!win.isDestroyed() && win.isMaximized()));
}

/**
 * Register the hardware media keys system-wide
 */
export function registerMediaKeys(
  shortcuts: typeof globalShortcut,
  getWin: () => BrowserWindow | null
): void {
  MEDIA_KEY_MAP.forEach(({ key, action }) => {
    try {
      shortcuts.register(key, () => {
        const win = getWin();
        if (win && !win.isDestroyed()) {
          win.webContents.send('media-key-event', action);
        }
      });
    } catch (error) {
      console.warn(`[Electron] Failed to register global shortcut: ${key}`, error);
    }
  });
  mediaKeysEnabled = true;
}

/**
 * Release the hardware media keys so other players can use them again
 */
export function unregisterMediaKeys(shortcuts: typeof globalShortcut): void {
  MEDIA_KEY_MAP.forEach(({ key }) => {
    try {
      shortcuts.unregister(key);
    } catch (error) {
      console.warn(`[Electron] Failed to unregister global shortcut: ${key}`, error);
    }
  });
  mediaKeysEnabled = false;
}

export function areMediaKeysEnabled(): boolean {
  return mediaKeysEnabled;
}

/**
 * Register IPC handlers for frameless window control
 */
export function setupIpcHandlers(
  ipc: typeof ipcMain,
  getWin: () => BrowserWindow | null,
  shortcuts: typeof globalShortcut = globalShortcut,
  rpcClient: DiscordRpcClient = discordRpc
): void {
  // Minimize
  ipc.on('window-minimize', () => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.minimize();
    }
  });

  // Maximize / Restore Toggle
  ipc.on('window-maximize', () => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  // Close
  ipc.on('window-close', () => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  // Check if maximized (handle invoke)
  ipc.handle('window-is-maximized', () => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      return win.isMaximized();
    }
    return false;
  });

  // Mini Player Mode & Window Sizing
  let normalWindowBounds: Electron.Rectangle | null = null;

  /**
   * Legacy in-place mini mode, kept for the compact main-window layout. The
   * floating mini player is a separate window — see `open-mini-window`.
   */
  ipc.handle('set-mini-player-mode', async (_event, enabled: boolean, layout: 'compact' | 'square' | 'expanded' = 'compact') => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;

    if (enabled) {
      if (!normalWindowBounds) {
        normalWindowBounds = win.getBounds();
      }
      win.setAlwaysOnTop(true, 'floating');

      let targetWidth = 360;
      let targetHeight = 140;
      if (layout === 'square') {
        targetWidth = 320;
        targetHeight = 340;
      } else if (layout === 'expanded') {
        targetWidth = 340;
        targetHeight = 440;
      }

      win.setMinimumSize(260, 100);
      win.setSize(targetWidth, targetHeight, true);
    } else {
      win.setAlwaysOnTop(false);
      win.setMinimumSize(960, 600);
      if (normalWindowBounds) {
        win.setBounds(normalWindowBounds, true);
        normalWindowBounds = null;
      } else {
        win.setSize(1280, 800, true);
        win.center();
      }
    }
  });

  // ---- Detached mini player ------------------------------------------------

  ipc.handle('open-mini-window', async () => {
    const existing = getMiniWindow();
    if (existing) {
      existing.show();
      existing.focus();
      return true;
    }
    createMiniWindow();
    return true;
  });

  ipc.handle('close-mini-window', async () => {
    closeMiniWindow();
    return true;
  });

  ipc.handle('is-mini-window-open', async () => getMiniWindow() !== null);

  // Main renderer → mini player. Dropped silently when nothing is listening,
  // which is the common case (the mini player is usually closed).
  ipc.on('mini-state', (_event, state: unknown) => {
    const mini = getMiniWindow();
    if (mini) {
      mini.webContents.send('mini-state', state);
    }
  });

  // Mini player → main renderer, which owns the audio element.
  ipc.on('mini-command', (_event, command: { type?: string } | null) => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    if (command && command.type === 'focus-main') {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    win.webContents.send('mini-command', command);
  });

  // Always on top toggle
  ipc.handle('set-always-on-top', async (_event, alwaysOnTop: boolean) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(alwaysOnTop, 'floating');
      return win.isAlwaysOnTop();
    }
    return false;
  });

  ipc.handle('get-always-on-top', async () => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      return win.isAlwaysOnTop();
    }
    return false;
  });

  // Global media keys toggle (Settings screen)
  ipc.on('set-media-keys-enabled', (_event, enabled: boolean) => {
    if (enabled) {
      registerMediaKeys(shortcuts, getWin);
    } else {
      unregisterMediaKeys(shortcuts);
    }
  });

  // Open a link in the system browser (Discord OAuth, external artist pages)
  ipc.handle('open-external', async (_event, url: string) => {
    if (!isExternallyOpenableUrl(url)) {
      throw new Error('Refused to open a URL that is not http(s)');
    }
    await shell.openExternal(url);
  });

  /**
   * Runs the Discord consent screen in a window we own and hands back the
   * redirect URL. Preferred over the system browser: it needs no protocol
   * registration, cannot be intercepted by another app and keeps the user inside
   * Wireon. See electron/authWindow.ts.
   */
  ipc.handle('discord-login', async (_event, authUrl: string) => {
    if (typeof authUrl !== 'string' || !authUrl.startsWith('https://discord.com/')) {
      return { ok: false, code: 'UNSUPPORTED', error: 'Некорректный адрес авторизации.' };
    }
    return runDiscordLogin(authUrl, { createWindow: () => createAuthWindow(getWin()) });
  });

  /**
   * Отвечает, доведёт ли система ответ Discord обратно до приложения.
   *
   * От этого зависит выбор способа входа. Системный браузер удобнее: там
   * человек уже вошёл в Discord, там его менеджер паролей и его двухфакторка —
   * заново вводить пароль не приходится. Но ответ оттуда приходит только своей
   * схемой `wireon://`, а её обслуживает реестр Windows, а не мы. Если запись
   * не наша (портативный запуск, установка другой копией, вычищенный реестр),
   * согласие в браузере уйдёт в никуда и вход просто повиснет. Поэтому
   * спрашиваем систему заранее и, если схема не наша, открываем своё окно.
   */
  ipc.handle('discord-deep-link-ready', async () => {
    try {
      if (typeof app.isDefaultProtocolClient !== 'function') return false;
      // Спрашиваем про ту схему, по которой ответ и придёт, — Discord.
      if (process.defaultApp && process.argv.length >= 2) {
        return app.isDefaultProtocolClient(DISCORD_AUTH_SCHEME, process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      }
      return app.isDefaultProtocolClient(DISCORD_AUTH_SCHEME);
    } catch (err) {
      console.warn('[Auth] Could not check the wireon:// handler:', err);
      return false;
    }
  });

  /** Drops the Discord auth cookies so the next sign-in can use another account. */
  ipc.handle('discord-forget-session', async () => {
    try {
      const authSession = session.fromPartition(AUTH_PARTITION);
      await authSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb'] });
      return true;
    } catch (err) {
      console.warn('[Auth] Could not clear the Discord auth session:', err);
      return false;
    }
  });

  // Resolve YouTube Stream — client rotation + playback verification, see streamResolver.ts
  // `priority` приходит из renderer, поэтому не доверяем: всё, кроме явной
  // строки 'prefetch', считаем запросом человека — ошибиться в эту сторону
  // безопаснее, чем отправить нажатие play в фоновую очередь.
  ipc.handle('resolve-youtube-stream', async (_, videoId: string, priority?: unknown) => {
    return getStreamResolver().resolve(videoId, priority === 'prefetch' ? 'prefetch' : 'user');
  });

  /** Есть ли вшитый ffmpeg. Настройки спрашивают заранее, чтобы не обещать сжатие впустую. */
  ipc.handle('transcode-available', async () => {
    try {
      return getAudioTranscoder().isAvailable();
    } catch (err) {
      console.warn('[Transcode] Проверка ffmpeg не удалась:', err);
      return false;
    }
  });

  /**
   * Сжимает скачанный трек в opus перед укладкой в офлайн-хранилище.
   *
   * Всё, что приходит из renderer, — байты и два параметра; аргументы ffmpeg
   * собирает transcoder.ts, см. пояснение там. Ошибка сюда не долетает: модуль
   * возвращает оригинал, потому что сохранить несжатым лучше, чем не сохранить.
   */
  ipc.handle('transcode-audio', async (_, payload: unknown) => {
    const request = (payload || {}) as { data?: ArrayBuffer | Uint8Array; bitrateKbps?: unknown; sourceExt?: unknown };
    const raw = request.data;
    const bytes =
      raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
    if (!bytes || bytes.byteLength === 0) {
      return { data: new Uint8Array(0), format: 'bin', bitrate: normalizeBitrate(request.bitrateKbps), compressed: false, reason: 'пустые данные' };
    }
    return getAudioTranscoder().transcode({
      data: bytes,
      bitrateKbps: normalizeBitrate(request.bitrateKbps),
      sourceExt: typeof request.sourceExt === 'string' ? request.sourceExt : undefined
    });
  });

  /**
   * Разрешает брать сессию YouTube из cookies браузера.
   *
   * Единственное известное лечение проверки «подтвердите, что вы не робот»:
   * анонимные клиенты её обойти не могут. Значение проверяется по закрытому
   * списку в streamResolver.ts — оно уезжает в аргументы дочернего процесса.
   */
  ipc.handle('set-youtube-cookies-browser', async (_, browser: unknown) => {
    const normalized = normalizeCookieBrowser(browser);
    getStreamResolver().setCookiesFromBrowser(normalized);
    return normalized;
  });

  /** Feeds the in-app diagnostics panel so a failure leaves a trail the user can read. */
  ipc.handle('get-stream-diagnostics', async () => {
    const ytdlp = getYtDlpManager().describe();
    const resolver = getStreamResolver();
    return {
      log: resolver.readLog(150),
      ytDlpPath: ytdlp.path,
      ytDlpAvailable: existsSync(ytdlp.path),
      ytDlpSource: ytdlp.source,
      ytDlpVersion: ytdlp.version,
      cookiesBrowser: resolver.getCookiesFromBrowser(),
      botCheckSeen: resolver.hasSeenBotCheck(),
      logPath: app && typeof app.getPath === 'function' ? path.join(app.getPath('userData'), 'logs', 'streams.log') : null,
    };
  });

  /** Forces fresh URLs; the usual fix when a machine slept through every expiry. */
  ipc.handle('clear-stream-cache', async () => {
    getStreamResolver().clearCache();
    return true;
  });

  // Search YouTube InnerTube via Main Process (Bypasses all CORS)
  ipc.handle('search-youtube', async (_, query: string) => {
    try {
      const payload = {
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20240101.01.00',
            hl: 'en',
            gl: 'US'
          }
        },
        query,
        params: 'Eg-KAQwIARAAGAAgACgAMABqChAEEAMQCRAFEAo%3D'
      };

      const response = await fetch('https://music.youtube.com/youtubei/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': DESKTOP_USER_AGENT,
          'X-YouTube-Client-Name': '67',
          'Origin': 'https://music.youtube.com',
          'Referer': 'https://music.youtube.com/'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`InnerTube HTTP error: ${response.status}`);
      }

      return await response.json();
    } catch (err: any) {
      console.error('[Electron IPC] search-youtube failed:', err);
      throw err;
    }
  });

  /**
   * Радио YouTube Music от одной песни — тот же список, что играет там в
   * «Автовоспроизведении».
   *
   * Зачем в главном процессе. Ответ на этот вопрос есть только у InnerTube, а из
   * renderer до него не достать: запрос уходит с `Content-Type: application/json`
   * и `X-YouTube-Client-Name`, поэтому Chromium обязан сделать предзапрос CORS, а
   * `OPTIONS` на этот адрес отвечает отказом. Здесь предзапроса нет вообще.
   *
   * Почему это важнее публичных зеркал. Раньше «похожие» приходили только из
   * Piped и Invidious, и когда те лежали — а лежат они почти всегда, — поток
   * скатывался в поиск по жанру: от фонка играло что попало. Здесь список
   * составляет сам YouTube Music по своей песне, и жанр держится сам.
   *
   * `RDAMVM<id>` — идентификатор радиостанции для конкретного видео; без него
   * `next` отдаёт очередь из одного трека.
   */
  ipc.handle('youtube-radio', async (_, videoId: string) => {
    if (typeof videoId !== 'string' || videoId.length === 0) {
      throw new Error('youtube-radio: videoId required');
    }
    try {
      const response = await fetch('https://music.youtube.com/youtubei/v1/next', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': DESKTOP_USER_AGENT,
          'X-YouTube-Client-Name': '67',
          'Origin': 'https://music.youtube.com',
          'Referer': 'https://music.youtube.com/'
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB_REMIX',
              clientVersion: '1.20240101.01.00',
              hl: 'ru',
              gl: 'RU'
            }
          },
          videoId,
          playlistId: `RDAMVM${videoId}`,
          isAudioOnly: true
        })
      });

      if (!response.ok) {
        throw new Error(`InnerTube next HTTP error: ${response.status}`);
      }

      return await response.json();
    } catch (err: any) {
      console.error('[Electron IPC] youtube-radio failed:', err);
      throw err;
    }
  });

  // Search SoundCloud via Main Process (Bypasses all CORS)
  ipc.handle('search-soundcloud', async (_, query: string, clientId: string, limit: number = 20) => {
    try {
      const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${limit}&offset=0`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': DESKTOP_USER_AGENT
        }
      });
      if (!response.ok) {
        throw new Error(`SoundCloud HTTP error: ${response.status}`);
      }
      return await response.json();
    } catch (err: any) {
      console.error('[Electron IPC] search-soundcloud failed:', err);
      throw err;
    }
  });

  // Discord Rich Presence (RPC)
  ipc.handle('discord-rpc-set-activity', async (_, activity: DiscordActivityPayload | null) => {
    try {
      return await rpcClient.setActivity(activity);
    } catch (err: any) {
      console.error('[Electron IPC] discord-rpc-set-activity failed:', err);
      return false;
    }
  });

  /**
   * Запись из окна в тот же журнал, где живут ссылки.
   *
   * Заминки воспроизведения до этого оставались только в консоли окна, которую
   * никто не открывает: человек говорит «поиграло и повисло», а посмотреть
   * нечего. Теперь это ложится рядом с историей ссылок, где видно и сколько
   * занял поход к извлекателю.
   */
  ipc.handle('playback-log', async (_, message: unknown) => {
    if (typeof message !== 'string' || !message) return false;
    // Обрезка не из вежливости: сюда пишет renderer, и без предела одна кривая
    // строка могла бы раздуть журнал до размера диска.
    getStreamResolver().log(`плеер: ${message.slice(0, 400)}`);
    return true;
  });

  // Состояние связи, чтобы «активности нет» перестало быть безмолвным.
  ipc.handle('discord-rpc-status', async () => {
    const status = rpcClient.getStatus();
    return {
      connected: status.connected,
      ready: status.ready,
      enabled: status.enabled,
      clientId: status.clientId,
      lastError: status.lastError,
      lastAcceptedAt: status.lastAcceptedAt
    };
  });

  ipc.handle('discord-rpc-set-enabled', async (_, enabled: boolean) => {
    try {
      await rpcClient.setEnabled(enabled);
    } catch (err: any) {
      console.error('[Electron IPC] discord-rpc-set-enabled failed:', err);
    }
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Standalone page shown when the renderer bundle cannot be loaded, so a broken
 * build never results in an invisible or missing window. It is served from a
 * data: URL, which is outside the CSP scope on purpose — the inline Reload
 * handler has to keep working even when the app's own policy is enforced.
 */
export function buildLoadErrorPage(detail: {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
}): string {
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Wireon Sounds — load failed</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
        background: #0a0a0f; color: #ededf2; text-align: center;
        font: 400 14px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif;
      }
      main { max-width: 30rem; padding: 2rem; }
      h1 { font-size: 1.125rem; font-weight: 600; margin: 0 0 .75rem; }
      code { color: #8b7cf6; word-break: break-all; }
      p { color: #ababba; margin: .5rem 0; }
      button {
        margin-top: 1.5rem; padding: .625rem 1.25rem; border: 0; border-radius: 10px;
        background: #8b7cf6; color: #0a0a0f; font-weight: 600; font-size: .875rem; cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Wireon Sounds could not load its interface</h1>
      <p>${escapeHtml(detail.errorDescription)} (${detail.errorCode})</p>
      <p><code>${escapeHtml(detail.validatedURL)}</code></p>
      <p>Run <code>npm run electron:build</code> to rebuild the bundle, then reload.</p>
      <button onclick="location.reload()">Reload</button>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Loads the renderer: dev server when announced, otherwise the built bundle.
 */
function loadAppContent(win: BrowserWindow): void {
  const devServerUrl = getDevServerUrl();
  if (devServerUrl) {
    console.log(`[Electron] Loading dev server: ${devServerUrl}`);
    win.loadURL(devServerUrl);
  } else {
    const indexHtml = getIndexHtmlPath();
    console.log(`[Electron] Loading bundle: ${indexHtml}`);
    win.loadFile(indexHtml);
  }
}

/**
 * Reports the packaged boot sequence to stdout and quits, so CI can prove that
 * the window loads and the context bridge is present. Enabled with
 * WIREON_SMOKE=1 only.
 */
function setupSmokeDiagnostics(win: BrowserWindow, preloadPath: string): void {
  win.webContents.on('console-message', (details) => {
    console.log(`[smoke][renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });

  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript('typeof window.electronAPI')
      .then(async (bridge: string) => {
        console.log(`[smoke] electronAPI=${bridge}`);
        const keys = await win.webContents.executeJavaScript(
          'Object.keys(window.electronAPI || {}).sort().join(",")'
        );
        console.log(`[smoke] bridge=${keys}`);
      })
      .catch((err: unknown) => {
        console.log(`[smoke] electronAPI=<error> ${String(err)}`);
      })
      .finally(() => {
        console.log(`[smoke] preloadPath=${preloadPath} exists=${existsSync(preloadPath)}`);
        console.log(`[smoke] loaded=${win.isDestroyed() ? '<destroyed>' : win.webContents.getURL()}`);
        setTimeout(() => app.quit(), 3000);
      });
  });
}

/**
 * Creates the primary application window with frameless obsidian glass styling
 */
export function createWindow(): BrowserWindow {
  const preloadPath = getPreloadPath();

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    frame: false, // Custom title bar; window controls live in the app header.
    titleBarStyle: 'hidden',
    // Keep in sync with --bg-base in src/styles/theme.css, otherwise the window
    // flashes the wrong colour between "shown" and "renderer painted".
    backgroundColor: '#0E0F12',
    title: 'Wireon Sounds',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    icon: getWindowIconPath(),
  });
  mainWindow = win;
  guardWindowNavigation(win);

  let shown = false;
  let fallbackArmed = false;

  const showTimer = setTimeout(() => {
    if (!shown) {
      console.warn(`[Electron] Window not ready after ${SHOW_TIMEOUT_MS}ms — showing it anyway`);
      reveal();
    }
  }, SHOW_TIMEOUT_MS);

  function reveal(): void {
    if (shown || win.isDestroyed()) {
      return;
    }
    shown = true;
    clearTimeout(showTimer);
    win.show();
  }

  // Gracefully show window when content is rendered
  win.once('ready-to-show', () => reveal());

  win.webContents.on('did-finish-load', () => {
    const url = win.isDestroyed() ? '<destroyed>' : win.webContents.getURL();
    console.log(`[Electron] did-finish-load: ${url}`);

    if (fallbackArmed && url.startsWith('data:')) {
      // The user pressed Reload on the fallback page — retry the real bundle.
      fallbackArmed = false;
      loadAppContent(win);
      return;
    }
    if (url.startsWith('data:')) {
      fallbackArmed = true;
    }
    reveal();

    // Only the real bundle listens for deep links; the fallback page does not.
    if (isAppContentUrl(url, getDevServerUrl())) {
      flushPendingDeepLink(win);
    }
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(
      `[Electron] did-fail-load code=${errorCode} description=${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`
    );
    // -3 is ERR_ABORTED, emitted for superseded navigations and reloads.
    if (!isMainFrame || errorCode === -3 || win.isDestroyed()) {
      return;
    }
    fallbackArmed = false;
    win.loadURL(buildLoadErrorPage({ errorCode, errorDescription, validatedURL }));
    reveal();
    win.focus();
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[Electron] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });

  win.on('unresponsive', () => {
    console.warn('[Electron] Window became unresponsive');
  });

  // Setup listeners for maximize/unmaximize state transitions
  setupWindowStateListeners(win);

  if (process.env.WIREON_SMOKE === '1') {
    setupSmokeDiagnostics(win, preloadPath);
  }

  loadAppContent(win);

  win.on('closed', () => {
    clearTimeout(showTimer);
    rendererReady = false;
    mainWindow = null;
    // Without this the always-on-top mini player outlives the app it controls.
    closeMiniWindow();
  });

  return win;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

// ----------------------------------------------------------------------------
// Detached mini player
// ----------------------------------------------------------------------------

/**
 * The mini player is a second, always-on-top window rather than a resized main
 * window: shrinking the main window tore down the audio element's layout and
 * left the library unusable behind it. This window renders controls only — audio
 * stays in the main renderer, and the two talk over `mini-state`/`mini-command`.
 */
export function createMiniWindow(): BrowserWindow {
  const preloadPath = getPreloadPath();

  const win = new BrowserWindow({
    width: 340,
    height: 132,
    minWidth: 300,
    minHeight: 120,
    maxWidth: 520,
    maxHeight: 420,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // The mini window paints --surface-1, not --bg-base; keep the two in sync.
    backgroundColor: '#141619',
    title: 'Wireon Sounds — мини-плеер',
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Tells the preload which window it is; the renderer branches on this.
      additionalArguments: ['--wireon-mini'],
    },
    icon: getWindowIconPath(),
  });

  // 'screen-saver' keeps it above full-screen apps, which 'floating' does not.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  win.webContents.on('did-finish-load', () => {
    // The main renderer only pushes state while someone is listening.
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('mini-window-visibility', true);
    }
  });

  win.on('closed', () => {
    miniWindow = null;
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('mini-window-visibility', false);
    }
  });

  loadAppContent(win);
  guardWindowNavigation(win);
  miniWindow = win;
  return win;
}

export function getMiniWindow(): BrowserWindow | null {
  return miniWindow && !miniWindow.isDestroyed() ? miniWindow : null;
}

/**
 * Its own persistent session, so a signed-in Discord account is remembered for
 * the next login (one click instead of a password) while staying out of the app's
 * own session — none of the header rewriting or CSP applies to discord.com.
 */
export const AUTH_PARTITION = 'persist:wireon-discord-auth';

/**
 * A plain Chromium window for the Discord consent screen: no preload, no node,
 * nothing of ours reachable from the page. It is modal on the main window so it
 * cannot be lost behind it mid-login.
 */
export function createAuthWindow(parent: BrowserWindow | null): BrowserWindow {
  return new BrowserWindow({
    width: 520,
    height: 760,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    modal: Boolean(parent && !parent.isDestroyed()),
    autoHideMenuBar: true,
    // Deliberately not one of our surfaces: this window shows Discord's own
    // login page, so it flashes Discord's dark grey rather than our blue base.
    backgroundColor: '#1a1b1e',
    title: 'Вход через Discord',
    webPreferences: {
      partition: AUTH_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
    icon: getWindowIconPath(),
  });
}

/** Closes the mini player if it is open. Safe to call when it is not. */
export function closeMiniWindow(): void {
  const win = getMiniWindow();
  if (win) {
    win.close();
  }
  miniWindow = null;
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/** Brings an existing window back to front when a second instance is launched. */
export function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) {
    return;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
}

/**
 * Picks the `wireon://` URL out of an argv-style list. On Windows and Linux a
 * deep link is delivered as a command line, either to a cold start or to the
 * `second-instance` event.
 */
export function extractDeepLinkUrl(argv: ReadonlyArray<string>): string | undefined {
  // У схемы Discord один слеш (`discord-123:/authorize/callback`), у нашей два.
  // Поэтому сверяем по «схема плюс двоеточие», а не по полному началу адреса.
  return argv.find(
    (arg) => typeof arg === 'string' && DEEP_LINK_SCHEMES.some((scheme) => arg.startsWith(`${scheme}:`))
  );
}

/**
 * Hands a deep link to the renderer verbatim — its fragment carries the OAuth
 * access token, so the URL is never logged and never re-encoded. Links that
 * arrive before the renderer is listening are queued and replayed by
 * {@link flushPendingDeepLink}.
 */
export function deliverDeepLink(url: string, win: BrowserWindow | null = getMainWindow()): void {
  if (!win || win.isDestroyed() || !rendererReady) {
    pendingDeepLink = url;
    return;
  }
  win.webContents.send('deep-link', url);
}

/** Replays a queued deep link once the renderer has loaded. */
export function flushPendingDeepLink(win: BrowserWindow): void {
  rendererReady = true;
  if (!pendingDeepLink || win.isDestroyed()) {
    return;
  }
  const url = pendingDeepLink;
  pendingDeepLink = null;
  console.log('[Electron] Replaying deep link received before the window was ready');
  win.webContents.send('deep-link', url);
}

/**
 * Starts background updates and the three IPC channels the UI talks to.
 *
 * The state is pushed to every open window (the mini player included) rather
 * than to `mainWindow` alone, and a window that opens later asks for it itself
 * over `update:get-state` — so there is no window that shows a stale banner.
 */
export function startAutoUpdates(ipc: typeof ipcMain = ipcMain): UpdateService {
  updateService?.dispose();

  const service = createUpdateService({
    broadcast: (state: UpdateState) => {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send(UPDATE_STATE_CHANNEL, state);
        }
      });
    },
  });

  setupUpdaterIpc(ipc, service);
  service.start();
  updateService = service;
  return service;
}

/** Test seam: clears the queued deep link and the renderer readiness flag. */
export function resetDeepLinkState(): void {
  pendingDeepLink = null;
  rendererReady = false;
}

/**
 * Claims the `wireon://` scheme for this executable. In development Electron
 * runs the repository as an argument, so the argv form is required for Windows
 * to relaunch us correctly.
 */
export function registerDeepLinkProtocol(): void {
  if (typeof app.setAsDefaultProtocolClient !== 'function') {
    return;
  }
  // Проверочный запуск не должен переписывать реестр: `npm run verify` поднимает
  // Electron из репозитория, и установленное приложение теряло бы `wireon://`
  // — вход через Discord после этого открывал бы не то приложение.
  if (process.env.WIREON_SMOKE === '1') {
    return;
  }
  for (const scheme of DEEP_LINK_SCHEMES) {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(scheme);
    }
  }
  // The pre-rename build left a `vireon` handler in the registry pointing at an
  // executable that may no longer exist. Nothing else will ever clean it up.
  if (typeof app.removeAsDefaultProtocolClient === 'function') {
    try {
      app.removeAsDefaultProtocolClient(LEGACY_DEEP_LINK_SCHEME);
    } catch {
      // Not being the registered handler is the outcome we wanted anyway.
    }
  }
}

/**
 * Copies a pre-rename profile into this one, once.
 *
 * `productName` moved from `VireonMusic` to `Wireon`, which moves userData from
 * `%APPDATA%/VireonMusic` to `%APPDATA%/Wireon` and would strand the user's
 * library, playlists, offline audio and session. Chromium locks these
 * directories as soon as a window loads, so this has to run before `whenReady`.
 *
 * Only ever writes into an untouched profile: if this install already has web
 * storage of its own, it returns without copying anything.
 *
 * @returns true when data was copied
 */
export function migrateLegacyUserData(): boolean {
  try {
    if (!app || typeof app.getPath !== 'function') return false;

    const currentDir = app.getPath('userData');
    if (typeof currentDir !== 'string' || currentDir.length === 0) return false;
    const legacyDir = path.join(path.dirname(currentDir), LEGACY_PRODUCT_NAME);
    if (currentDir === legacyDir || !existsSync(legacyDir)) return false;

    // Web storage present means this profile is already in use — leave it alone.
    const alreadyInUse = MIGRATED_PROFILE_DIRS.some((dir) => existsSync(path.join(currentDir, dir)));
    if (alreadyInUse) return false;

    let copied = false;
    for (const dir of MIGRATED_PROFILE_DIRS) {
      const from = path.join(legacyDir, dir);
      if (!existsSync(from)) continue;
      cpSync(from, path.join(currentDir, dir), { recursive: true });
      copied = true;
    }

    if (copied) {
      console.log(`[Electron] Migrated user data from ${legacyDir}`);
    }
    return copied;
  } catch (err) {
    // A failed migration must never stop the app from starting; the user just
    // starts from an empty library, and their old folder is still on disk.
    console.warn('[Electron] User data migration failed:', err);
    return false;
  }
}

// App lifecycle management
if (app) {
  // Both must run before the app is ready: Chromium locks the profile
  // directories on first use, and the renderer treats wireon:// as a
  // standard, secure origin.
  migrateLegacyUserData();

  if (protocol && typeof protocol.registerSchemesAsPrivileged === 'function') {
    protocol.registerSchemesAsPrivileged([
      { scheme: DEEP_LINK_SCHEME, privileges: { standard: true, secure: true } },
    ]);
  }

  const hasSingleInstanceLock =
    typeof app.requestSingleInstanceLock === 'function' ? app.requestSingleInstanceLock() : true;

  if (!hasSingleInstanceLock) {
    console.log('[Electron] Another instance is already running — exiting');
    app.quit();
  } else {
    registerDeepLinkProtocol();

    // Cold start: the OAuth redirect is already on our command line.
    const launchDeepLink = extractDeepLinkUrl(process.argv);
    if (launchDeepLink) {
      console.log('[Electron] Deep link present at launch');
      deliverDeepLink(launchDeepLink, null);
    }

    app.on('second-instance', (_event, commandLine) => {
      focusMainWindow();
      const deepLink = extractDeepLinkUrl(commandLine);
      if (deepLink) {
        console.log('[Electron] Deep link received from a second instance');
        deliverDeepLink(deepLink);
      }
    });

    // macOS delivers deep links as an event instead of a command line.
    app.on('open-url', (event, url) => {
      event.preventDefault();
      console.log('[Electron] Deep link received via open-url');
      focusMainWindow();
      deliverDeepLink(url);
    });

    app.whenReady().then(() => {
      setupSessionHeaders(session.defaultSession, Boolean(app.isPackaged));
      setupIpcHandlers(ipcMain, getMainWindow);
      startAutoUpdates(ipcMain);
      // Извлекатель обновляется отдельно от приложения: YouTube ломает старые
      // версии быстрее, чем мы выпускаем релизы.
      getYtDlpManager().start();
      createWindow();
      registerMediaKeys(globalShortcut, getMainWindow);
      void discordRpc.connect();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow();
        }
      });
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    app.on('will-quit', () => {
      globalShortcut.unregisterAll();
      discordRpc.destroy();
      updateService?.dispose();
      ytDlpManager?.dispose();
    });
  }
}

export default {
  createWindow,
  setupIpcHandlers,
  setupSessionHeaders,
  registerMediaKeys,
  unregisterMediaKeys,
  setupWindowStateListeners,
  registerDeepLinkProtocol,
  deliverDeepLink,
  getMainWindow,
  setMainWindow,
  focusMainWindow,
  startAutoUpdates,
  discordRpc,
};
