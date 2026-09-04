/**
 * Discord OAuth2 Authentication Service for Wireon
 * Builds the authorization URL, runs the OAuth2 implicit flow (browser popup in dev,
 * `wireon://` deep link in the packaged desktop app), fetches the user profile,
 * resolves CDN avatar URLs and persists the session in localStorage.
 *
 * There is no offline / mock login: every failure path produces an `AuthError`
 * with a machine-readable `code` and leaves storage untouched.
 */

import { AuthErrorCode, DiscordUserRaw } from '../types/auth';
import { UserProfile } from '../types/music';
import { detectPlatform } from './nativeBridge';
import type { DeepLinkAuthBridge } from './capacitorAuthBridge';

// Discord OAuth2 Constants
export const DISCORD_API_BASE = 'https://discord.com/api/v10';
export const DISCORD_CDN_BASE = 'https://cdn.discordapp.com';
export const DISCORD_AUTH_URL = 'https://discord.com/api/oauth2/authorize';
export const DEFAULT_OAUTH_SCOPES = ['identify', 'email'];
export const DEFAULT_SESSION_TTL_SECONDS = 604800;
export const DEFAULT_LOGIN_TIMEOUT_MS = 120000;

/** Custom protocol used by the packaged desktop app for the OAuth2 redirect. */
export const DESKTOP_PROTOCOL = 'wireon';
export const DESKTOP_REDIRECT_URI = `${DESKTOP_PROTOCOL}://auth/callback`;
/** Route the Vite dev server serves the SPA on for the popup flow. */
export const BROWSER_CALLBACK_PATH = '/auth/callback';
export const DEV_BROWSER_REDIRECT_URI = `http://localhost:3000${BROWSER_CALLBACK_PATH}`;

/**
 * Адрес возврата — в единственном формате, который принимает Discord.
 *
 * Произвольную схему он не принимает ни на телефоне, ни на компьютере.
 * `wireon://auth/callback` был **прописан** в панели разработчика — и всё равно
 * отвергался с «Redirect URI 'wireon://auth/callback' is not supported by
 * client». Проверено и с выключенным переключателем «общедоступный клиент», и с
 * включённым: разрешена ровно одна собственная схема, `discord-{ID заявки}`.
 *
 * Вторая половина того же требования — PKCE: для собственной схемы он
 * обязателен, а с неявным потоком (`response_type=token`) не сочетается. Значит
 * возвращается код, и приложение меняет его на токен само. Секрет заявки для
 * этого не нужен — PKCE ровно для того и придуман, чтобы клиент без секрета
 * подтвердил, что вход начинал он.
 *
 * Дубль этой строки живёт в `electron/authWindow.ts`: главный процесс до
 * модулей renderer не дотягивается. Совпадение сторожит тест.
 */
export function appSchemeRedirectUri(clientId: string): string {
  return `discord-${clientId}:/authorize/callback`;
}

/** Обмен кода на токен. Публичный клиент, без секрета — за счёт PKCE. */
export const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';

export const STORAGE_KEY_AUTH_USER = 'wireon_auth_user';
export const STORAGE_KEY_AUTH_TOKEN = 'wireon_auth_token';
export const STORAGE_KEY_TOKEN_EXPIRES = 'wireon_auth_token_expires';

export interface OAuthUrlOptions {
  clientId?: string;
  redirectUri?: string;
  scopes?: string[];
  responseType?: 'token' | 'code';
  state?: string;
  prompt?: 'consent' | 'none';
  /** Отпечаток PKCE. Задан — значит поток по коду, как требует телефон. */
  codeChallenge?: string;
}

export interface LoginOptions extends OAuthUrlOptions {
  width?: number;
  height?: number;
  timeoutMs?: number;
}

export interface AuthSession {
  user: UserProfile;
  token: string;
}

export interface CallbackResult {
  success: boolean;
  token?: string;
  expiresIn?: number;
  state?: string;
  error?: string;
  /** Код **ошибки**, а не код авторизации — их легко перепутать. */
  code?: AuthErrorCode;
  /**
   * Код авторизации из потока по коду: его ещё предстоит обменять на токен.
   * Отдельное поле, потому что `code` выше занято кодом отказа.
   */
  authCode?: string;
}

/**
 * Typed authentication failure. `code` lets the UI decide between "explain and
 * offer a retry" (POPUP_BLOCKED) and "disable the button" (NOT_CONFIGURED).
 */
export class AuthError extends Error {
  public readonly code: AuthErrorCode;
  public readonly status?: number;

  constructor(code: AuthErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Minimal shape the preload bridge must expose for the desktop deep-link flow.
 * Declared locally so this module does not depend on the full `ElectronAPI`.
 */
interface DesktopAuthBridge {
  onDeepLink: (callback: (url: string) => void) => () => void;
  openExternal: (url: string) => void | Promise<void>;
  /**
   * Человек закрыл окно согласия сам.
   *
   * Есть только у моста Capacitor: системный браузер на десктопе о своём
   * закрытии не сообщает, и там отказ от входа честно ждёт срока. На телефоне
   * же вкладка согласия — часть приложения, и её закрытие видно сразу.
   */
  onCancelled?: (callback: () => void) => () => void;
  /**
   * Вернётся ли ответ Discord из системного браузера обратно в приложение.
   * Спрашивает у системы, кому принадлежит схема `wireon://`.
   */
  isDeepLinkReady?: () => Promise<boolean>;
}

/** Запасной десктопный вход: согласие Discord в окне, которым владеет приложение. */
interface AuthWindowBridge {
  discordLogin: (authUrl: string) => Promise<{ ok: boolean; url?: string; error?: string; code?: string }>;
}

function getAuthWindowBridge(): AuthWindowBridge | null {
  if (typeof window === 'undefined') return null;
  const api = window.electronAPI as unknown as Partial<AuthWindowBridge> | undefined;
  return api && typeof api.discordLogin === 'function' ? (api as AuthWindowBridge) : null;
}

/** Есть ли в этой сборке окно входа — то есть можно ли предложить его запасным путём. */
export function hasAuthWindow(): boolean {
  return getAuthWindowBridge() !== null;
}

/**
 * Пойдёт ли вход через системный браузер — и, значит, стоит ли предлагать
 * человеку окно приложения запасным путём. Когда вход и так идёт окном,
 * предлагать его второй раз незачем.
 */
export async function willUseSystemBrowser(): Promise<boolean> {
  const bridge = getDesktopAuthBridge();
  return bridge ? canUseSystemBrowser(bridge) : false;
}

function generateState(): string {
  const random = Math.random().toString(36).substring(2, 15);
  return `${random}${Date.now().toString(36)}`;
}

/**
 * Wireon's own Discord application ("Application ID" in the Developer Portal).
 *
 * A client id is public by design — it travels in the authorization URL that the
 * user's browser opens, so shipping it is not a leak, and the app is a public
 * client that holds no secret. Baking it in is what lets a packaged build sign
 * in on a machine that has no `.env` file. `VITE_DISCORD_CLIENT_ID` still wins
 * when set, so a fork can point at its own application.
 */
export const DEFAULT_DISCORD_CLIENT_ID = '1539037027633332234';

/**
 * Picks the client id to use, preferring an explicit environment override over
 * the built-in application id. Pure so the "no id at all" case — a fork that
 * strips {@link DEFAULT_DISCORD_CLIENT_ID} — stays testable without globals.
 *
 * @param rawEnvValue value of `VITE_DISCORD_CLIENT_ID`, in whatever shape it came
 * @param fallback built-in id to use when the override is missing or blank
 */
export function resolveClientId(
  rawEnvValue: unknown,
  fallback: string = DEFAULT_DISCORD_CLIENT_ID
): string | null {
  const override = typeof rawEnvValue === 'string' ? rawEnvValue.trim() : '';
  if (override.length > 0) return override;
  const builtIn = typeof fallback === 'string' ? fallback.trim() : '';
  return builtIn.length > 0 ? builtIn : null;
}

/**
 * Reads the OAuth2 client id: the Vite environment first
 * (`.env` → `import.meta.env`), then the built-in application id.
 */
export function getDiscordClientId(): string | null {
  return resolveClientId(import.meta.env?.VITE_DISCORD_CLIENT_ID);
}

/** False only if the built-in id is stripped and no env override is set. */
export function isDiscordConfigured(): boolean {
  return getDiscordClientId() !== null;
}

/** True when running inside the Electron renderer. */
export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electronAPI);
}

function getDesktopAuthBridge(): DesktopAuthBridge | null {
  if (typeof window === 'undefined') return null;
  const api = window.electronAPI as unknown as
    | (Partial<DesktopAuthBridge> & { discordDeepLinkReady?: () => Promise<boolean> })
    | undefined;
  if (!api || typeof api.onDeepLink !== 'function' || typeof api.openExternal !== 'function') {
    return null;
  }
  // Отдельный объект, а не сам `electronAPI`: тот приходит через contextBridge и
  // дописывать в него ничего нельзя. Имя в мосте длиннее
  // (`discordDeepLinkReady`), потому что живёт среди трёх десятков не связанных
  // с входом методов; внутри моста входа уточнять нечего.
  const askReady = api.discordDeepLinkReady;
  return {
    onDeepLink: api.onDeepLink.bind(api),
    openExternal: api.openExternal.bind(api),
    ...(typeof askReady === 'function' ? { isDeepLinkReady: askReady.bind(api) } : {})
  };
}

/** Redirect target for the popup flow: the SPA route served by the dev server. */
export function getBrowserRedirectUri(): string {
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    if (origin && /^https?:/.test(origin)) {
      return `${origin}${BROWSER_CALLBACK_PATH}`;
    }
  }
  return DEV_BROWSER_REDIRECT_URI;
}

/**
 * Куда Discord возвращает ответ: собственная схема в приложении, адрес страницы
 * в браузере.
 *
 * У компьютера и телефона он один и тот же, и не по нашему выбору — Discord
 * принимает только `discord-{ID заявки}`. В браузере же возвращаться некуда,
 * кроме самой страницы: там открыть согласие можно всплывающим окном, которое
 * само и передаст ответ открывшему.
 */
export function getDefaultRedirectUri(): string {
  if (isDesktopRuntime() || detectPlatform() === 'mobile') {
    const clientId = getDiscordClientId();
    if (clientId) return appSchemeRedirectUri(clientId);
    return DESKTOP_REDIRECT_URI;
  }
  return getBrowserRedirectUri();
}

/** True for the desktop deep link, the phone's `discord-…` scheme and the browser route. */
export function isAuthCallbackUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith(`${DESKTOP_PROTOCOL}://auth/callback`)) return true;
  // Схема телефона: `discord-1539…:/authorize/callback`. Проверяем по началу, а
  // не разбором URL: у схемы один слеш, и `new URL` разбирает такое неровно.
  if (/^discord-\d+:\/authorize\/callback/.test(url)) return true;
  try {
    return new URL(url).pathname === BROWSER_CALLBACK_PATH;
  } catch {
    return false;
  }
}

/**
 * Calculates the Discord CDN avatar URL from user ID and avatar hash.
 * Supports static WebP/PNG, animated GIFs (if hash starts with `a_`),
 * and default embed avatar formula `(userId >> 22) % 6`.
 */
export function getDiscordAvatarUrl(
  userId: string,
  avatarHash?: string | null,
  size = 128,
  preferredFormat?: 'webp' | 'png' | 'gif'
): string {
  if (!avatarHash) {
    let defaultIndex = 0;
    try {
      if (userId && /^\d+$/.test(userId)) {
        // BigInt bit shift formula specified by Discord API
        defaultIndex = Number(BigInt(userId) >> 22n) % 6;
        if (defaultIndex < 0 || isNaN(defaultIndex)) defaultIndex = 0;
      } else {
        // Fallback hash for non-numeric or guest IDs
        let sum = 0;
        for (let i = 0; i < (userId || '').length; i++) {
          sum += (userId || '').charCodeAt(i);
        }
        defaultIndex = sum % 6;
      }
    } catch {
      defaultIndex = 0;
    }
    return `${DISCORD_CDN_BASE}/embed/avatars/${defaultIndex}.png`;
  }

  const isAnimated = avatarHash.startsWith('a_');
  const format = preferredFormat || (isAnimated ? 'gif' : 'png');
  return `${DISCORD_CDN_BASE}/avatars/${userId}/${avatarHash}.${format}?size=${size}`;
}

/**
 * Calculates the Discord CDN banner URL from user ID and banner hash.
 */
export function getDiscordBannerUrl(
  userId: string,
  bannerHash?: string | null,
  size = 512
): string | undefined {
  if (!bannerHash) return undefined;
  const isAnimated = bannerHash.startsWith('a_');
  const ext = isAnimated ? 'gif' : 'png';
  return `${DISCORD_CDN_BASE}/banners/${userId}/${bannerHash}.${ext}?size=${size}`;
}

/**
 * Пара PKCE: секрет остаётся в приложении, наружу уходит только его отпечаток.
 *
 * Зачем это здесь. Custom-схему (`discord-…:/…`) на телефоне может перехватить
 * другое приложение, объявившее ту же схему. Без PKCE перехватчику досталось бы
 * то, чем можно войти; с PKCE — код, который без секрета ничего не стоит, потому
 * что секрет знает только тот, кто начинал вход. Discord поэтому и требует PKCE
 * для таких схем, а не предлагает.
 */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Base64url без выравнивания — как требует RFC 7636. */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createPkcePair(): Promise<PkcePair> {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const verifier = base64Url(random);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/**
 * Меняет код авторизации на токен доступа.
 *
 * Без секрета приложения: публичный клиент подтверждает себя тем, что предъявляет
 * `code_verifier`, отпечаток которого отдал в самом начале.
 */
export async function exchangeCodeForToken(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string,
  fetchFn: typeof fetch = fetch
): Promise<{ token: string; expiresIn?: number }> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });

  const response = await fetchFn(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!response.ok) {
    // Текст ответа Discord — единственное, что отличает «код просрочен» от
    // «адрес возврата не тот», поэтому он доходит до человека, а не глотается.
    const detail = await response.text().catch(() => '');
    throw new AuthError(
      'OAUTH_DENIED',
      `Discord не выдал токен (${response.status}). ${detail.slice(0, 200)}`.trim()
    );
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload?.access_token) {
    throw new AuthError('NO_TOKEN', 'Discord вернул ответ без токена доступа.');
  }
  return { token: payload.access_token, expiresIn: payload.expires_in };
}

/**
 * Constructs the Discord OAuth2 authorization URL.
 * Throws `AuthError('NOT_CONFIGURED')` when no client id is available.
 */
export function generateOAuthUrl(options?: OAuthUrlOptions): { url: string; state: string } {
  const clientId = options?.clientId || getDiscordClientId();
  if (!clientId) {
    throw new AuthError(
      'NOT_CONFIGURED',
      'Вход через Discord не настроен: укажите VITE_DISCORD_CLIENT_ID в файле .env (пример — .env.example).'
    );
  }

  const redirectUri = options?.redirectUri || getDefaultRedirectUri();
  const scopes = (options?.scopes || DEFAULT_OAUTH_SCOPES).join(' ');
  const responseType = options?.responseType || 'token';
  const state = options?.state || generateState();
  const prompt = options?.prompt || 'consent';

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: responseType,
    scope: scopes,
    state: state,
    prompt: prompt
  });

  // PKCE добавляется только когда его попросили: на ПК поток неявный, и лишние
  // параметры там Discord бы не принял.
  if (options?.codeChallenge) {
    params.set('code_challenge', options.codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  return {
    url: `${DISCORD_AUTH_URL}?${params.toString()}`,
    state
  };
}

/**
 * Parses OAuth2 callback parameters from URL hash (implicit grant) or search parameters (code grant).
 */
export function parseOAuthCallback(
  callbackUrlOrHash: string
): { accessToken?: string; code?: string; tokenType?: string; expiresIn?: number; state?: string; error?: string } | null {
  if (!callbackUrlOrHash) return null;

  try {
    let searchParams: URLSearchParams;

    if (callbackUrlOrHash.includes('#')) {
      const hashContent = callbackUrlOrHash.split('#')[1] || '';
      searchParams = new URLSearchParams(hashContent);
    } else if (callbackUrlOrHash.includes('?')) {
      const queryContent = callbackUrlOrHash.split('?')[1] || '';
      searchParams = new URLSearchParams(queryContent);
    } else {
      searchParams = new URLSearchParams(callbackUrlOrHash);
    }

    const accessToken = searchParams.get('access_token') || undefined;
    const code = searchParams.get('code') || undefined;
    const tokenType = searchParams.get('token_type') || 'Bearer';
    const expiresIn = searchParams.get('expires_in') ? parseInt(searchParams.get('expires_in')!, 10) : undefined;
    const state = searchParams.get('state') || undefined;
    const error = searchParams.get('error') || searchParams.get('error_description') || undefined;

    if (error) {
      return { error, state };
    }

    if (!accessToken && !code) {
      return null;
    }

    return {
      accessToken,
      code,
      tokenType,
      expiresIn,
      state
    };
  } catch (err) {
    console.error('[DiscordAuth] Failed to parse OAuth callback:', err);
    return null;
  }
}

/**
 * Fetches user profile from Discord API using the access token.
 */
export async function fetchDiscordUserProfile(
  accessToken: string,
  fetchFn: typeof fetch = fetch
): Promise<UserProfile> {
  if (!accessToken) {
    throw new AuthError('NO_TOKEN', 'Для загрузки профиля Discord нужен токен доступа.');
  }

  const response = await fetchFn(`${DISCORD_API_BASE}/users/@me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new AuthError(
      'PROFILE_FETCH_FAILED',
      `Discord ответил ошибкой (${response.status}): ${errorText}`,
      response.status
    );
  }

  const rawData: DiscordUserRaw = await response.json();

  const userProfile: UserProfile = {
    id: rawData.id,
    username: rawData.global_name || rawData.username,
    discriminator: rawData.discriminator && rawData.discriminator !== '0' ? rawData.discriminator : undefined,
    avatarUrl: getDiscordAvatarUrl(rawData.id, rawData.avatar, 256),
    bannerUrl: rawData.banner ? getDiscordBannerUrl(rawData.id, rawData.banner, 512) : undefined,
    email: rawData.email,
    provider: 'discord',
    status: 'online',
    accessToken
  };

  return userProfile;
}

/**
 * Creates a guest user profile with fallback credentials.
 * Single owner of the guest identity shape.
 */
export function createGuestProfile(customId?: string): UserProfile {
  const randomSuffix = customId || Math.random().toString(36).substring(2, 9);
  const id = `guest_${randomSuffix}`;
  return {
    id,
    username: 'Гость',
    provider: 'guest',
    status: 'online',
    avatarUrl: getDiscordAvatarUrl(id, null)
  };
}

/** Session keys written by builds released before the rename to Wireon. */
const LEGACY_STORAGE_KEYS: ReadonlyArray<[legacy: string, current: string]> = [
  ['vireon_auth_user', STORAGE_KEY_AUTH_USER],
  ['vireon_auth_token', STORAGE_KEY_AUTH_TOKEN],
  ['vireon_auth_token_expires', STORAGE_KEY_TOKEN_EXPIRES]
];

/**
 * Carries a signed-in session across the rename so nobody is silently logged
 * out by an update. Legacy keys are removed once copied, making this a no-op
 * from the second call onwards.
 */
export function migrateLegacySessionKeys(): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    for (const [legacyKey, currentKey] of LEGACY_STORAGE_KEYS) {
      const legacyValue = localStorage.getItem(legacyKey);
      if (legacyValue === null) continue;
      if (localStorage.getItem(currentKey) === null) {
        localStorage.setItem(currentKey, legacyValue);
      }
      localStorage.removeItem(legacyKey);
    }
  } catch (err) {
    console.warn('[DiscordAuth] Failed to migrate legacy session keys:', err);
  }
}

/**
 * LocalStorage Session Persistence Helpers.
 * These three functions are the only writers of the `wireon_auth_*` keys.
 * Returns the profile as it was stored (with `accessToken` and `expiresAt`).
 */
export function saveStoredSession(
  user: UserProfile,
  token: string,
  expiresInSeconds = DEFAULT_SESSION_TTL_SECONDS
): UserProfile {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const profileToSave: UserProfile = {
    ...user,
    accessToken: token,
    expiresAt
  };

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(STORAGE_KEY_AUTH_USER, JSON.stringify(profileToSave));
      localStorage.setItem(STORAGE_KEY_AUTH_TOKEN, token);
      localStorage.setItem(STORAGE_KEY_TOKEN_EXPIRES, expiresAt.toString());
    }
  } catch (err) {
    console.warn('[DiscordAuth] Failed to save session to localStorage:', err);
  }

  return profileToSave;
}

export function getStoredSession(): { user: UserProfile | null; token: string | null; isExpired: boolean } {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      migrateLegacySessionKeys();
      const userStr = localStorage.getItem(STORAGE_KEY_AUTH_USER);
      const token = localStorage.getItem(STORAGE_KEY_AUTH_TOKEN);
      const expiresStr = localStorage.getItem(STORAGE_KEY_TOKEN_EXPIRES);

      if (!userStr || !token) {
        return { user: null, token: null, isExpired: false };
      }

      const user = JSON.parse(userStr) as UserProfile;
      const expiresAt = expiresStr ? parseInt(expiresStr, 10) : 0;
      const isExpired = expiresAt > 0 && Date.now() > expiresAt;

      return { user, token, isExpired };
    }
  } catch (err) {
    console.warn('[DiscordAuth] Failed to load session from localStorage:', err);
  }

  return { user: null, token: null, isExpired: false };
}

export function clearStoredSession(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(STORAGE_KEY_AUTH_USER);
      localStorage.removeItem(STORAGE_KEY_AUTH_TOKEN);
      localStorage.removeItem(STORAGE_KEY_TOKEN_EXPIRES);
    }
  } catch (err) {
    console.warn('[DiscordAuth] Failed to clear session from localStorage:', err);
  }
}

/**
 * Сбои, после которых имеет смысл предложить другой путь входа.
 *
 * Всё остальное — ответ по существу: человек отказал, состояние не совпало,
 * приложение не настроено. Повторять такое другим способом бессмысленно, а в
 * случае несовпадения состояния ещё и опасно.
 */
function isTransportFailure(err: unknown): boolean {
  if (!(err instanceof AuthError)) return false;
  return err.code === 'TIMEOUT' || err.code === 'DEEP_LINK_UNAVAILABLE' || err.code === 'UNSUPPORTED_ENVIRONMENT';
}

/**
 * Доведёт ли система ответ Discord из браузера обратно в приложение.
 *
 * Старые сборки моста об этом не спрашивали — для них ответ «нет»: они и раньше
 * входили окном приложения, и менять им поведение вслепую нельзя.
 */
async function canUseSystemBrowser(bridge: DesktopAuthBridge): Promise<boolean> {
  if (typeof bridge.isDeepLinkReady !== 'function') return false;
  try {
    return (await bridge.isDeepLinkReady()) === true;
  } catch {
    return false;
  }
}

/**
 * DiscordAuthService Singleton Class
 */
export class DiscordAuthService {
  private activePopup: Window | null = null;
  private messageListener: ((event: MessageEvent) => void) | null = null;

  /**
   * Runs the OAuth2 flow that fits the current runtime: the desktop pair
   * (системный браузер, окно приложения запасным), собственная схема на
   * телефоне, всплывающее окно в браузере.
   */
  public async login(options?: LoginOptions): Promise<AuthSession> {
    if (!options?.clientId && !isDiscordConfigured()) {
      throw new AuthError(
        'NOT_CONFIGURED',
        'Вход через Discord не настроен: задайте VITE_DISCORD_CLIENT_ID в .env (см. .env.example).'
      );
    }

    if (isDesktopRuntime()) return this.loginOnDesktop(options);
    // Телефон раньше попадал во всплывающее окно — и не мог войти никогда:
    // возврат шёл на `https://localhost`, до которого системному браузеру не
    // добраться. Своя схема работает, и поток тот же, что на десктопе.
    if (detectPlatform() === 'mobile') return this.loginWithCapacitor(options);
    return this.loginWithPopup(options);
  }

  /**
   * Вход на ПК: сначала системный браузер, окно приложения — запасным путём.
   *
   * Почему браузер впереди. В окне приложения своя, отдельная от браузера
   * учётная запись: там нет ни куки Discord, ни менеджера паролей, ни
   * подтверждения входа с телефона. Человек, у которого Discord открыт в
   * браузере годами, вводил пароль заново — и это была единственная жалоба на
   * вход. В браузере он чаще всего просто нажимает «Авторизовать».
   *
   * Почему окно всё-таки осталось. Ответ из браузера приходит схемой
   * `wireon://`, а её обслуживает реестр Windows: если запись не наша, ответ
   * уйдёт в никуда. Систему спрашиваем заранее ({@link DesktopAuthBridge.isDeepLinkReady}),
   * а на сбои самого перехода — переходим на окно, не заставляя начинать заново.
   */
  public async loginOnDesktop(options?: LoginOptions): Promise<AuthSession> {
    const deepLinkBridge = getDesktopAuthBridge();
    const hasWindow = getAuthWindowBridge() !== null;

    if (deepLinkBridge && (await canUseSystemBrowser(deepLinkBridge))) {
      try {
        return await this.loginWithAppScheme(options, deepLinkBridge);
      } catch (err) {
        // Отказ человека и несовпадение состояния — не сбой транспорта:
        // повторять их в окне значит спрашивать второй раз то, на что уже
        // ответили «нет».
        if (!hasWindow || !isTransportFailure(err)) throw err;
        console.warn(
          '[DiscordAuth] Возврат из браузера не дошёл, открываем окно входа:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    if (hasWindow) return this.loginWithAuthWindow(options);
    if (deepLinkBridge) return this.loginWithAppScheme(options, deepLinkBridge);
    throw new AuthError(
      'DEEP_LINK_UNAVAILABLE',
      'В этой сборке нет способа открыть согласие Discord.'
    );
  }

  /**
   * Desktop flow: the consent screen opens in a window the app owns and the
   * redirect is read off the navigation.
   *
   * This is preferred over the deep link because it depends on nothing outside
   * the app — no `wireon://` handler in the registry, no second app instance, no
   * cooperation from whichever browser is default.
   */
  public async loginWithAuthWindow(options?: LoginOptions): Promise<AuthSession> {
    const bridge = getAuthWindowBridge();
    if (!bridge) {
      throw new AuthError(
        'DEEP_LINK_UNAVAILABLE',
        'В этой сборке нет окна входа Discord (electronAPI.discordLogin).'
      );
    }

    const clientId = options?.clientId || getDiscordClientId();
    if (!clientId) {
      throw new AuthError('NOT_CONFIGURED', 'Вход через Discord не настроен.');
    }

    // Адрес возврата и поток — те же, что в браузере: их диктует Discord, а не
    // то, чьё окно показывает согласие. Окно лишь снимает адрес с перехода,
    // вместо того чтобы ждать его от системы.
    const expectedState = options?.state || generateState();
    const pkce = await createPkcePair();
    const redirectUri = options?.redirectUri || appSchemeRedirectUri(clientId);
    const { url } = generateOAuthUrl({
      clientId,
      redirectUri,
      scopes: options?.scopes,
      responseType: 'code',
      state: expectedState,
      codeChallenge: pkce.challenge
    });

    const result = await bridge.discordLogin(url);

    if (!result || !result.ok || !result.url) {
      const code: AuthErrorCode =
        result?.code === 'WINDOW_CLOSED'
          ? 'POPUP_CLOSED'
          : result?.code === 'TIMEOUT'
            ? 'TIMEOUT'
            : 'OAUTH_DENIED';
      throw new AuthError(code, result?.error || 'Вход через Discord не завершён.');
    }

    const callback = this.handleCallback(result.url, expectedState);

    if (callback.authCode) {
      const exchanged = await exchangeCodeForToken(callback.authCode, clientId, redirectUri, pkce.verifier);
      return this.completeLogin(exchanged.token, exchanged.expiresIn);
    }

    // Токен во фрагменте остаётся возможен только у старой заявки с неявным
    // потоком. Своя ветка ему не нужна — просто не отбрасываем то, что пришло.
    if (callback.success && callback.token) {
      return this.completeLogin(callback.token, callback.expiresIn);
    }

    throw new AuthError(callback.code || 'NO_TOKEN', callback.error || 'Discord не вернул ни кода, ни токена.');
  }

  /**
   * Browser / dev flow: opens Discord in a popup which redirects back to
   * `<origin>/auth/callback` and posts the token to this window.
   */
  public async loginWithPopup(options?: LoginOptions): Promise<AuthSession> {
    if (typeof window === 'undefined' || typeof window.open !== 'function') {
      throw new AuthError(
        'UNSUPPORTED_ENVIRONMENT',
        'Для входа во всплывающем окне нужен браузер с доступным window.open.'
      );
    }

    const expectedState = options?.state || generateState();
    const { url } = generateOAuthUrl({
      clientId: options?.clientId,
      redirectUri: options?.redirectUri || getBrowserRedirectUri(),
      scopes: options?.scopes,
      responseType: 'token',
      state: expectedState
    });

    const width = options?.width || 500;
    const height = options?.height || 800;
    const timeoutMs = options?.timeoutMs || DEFAULT_LOGIN_TIMEOUT_MS;
    const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);

    const token = await new Promise<{ token: string; expiresIn?: number }>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let checkClosedInterval: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (checkClosedInterval) clearInterval(checkClosedInterval);
        if (this.messageListener) {
          window.removeEventListener('message', this.messageListener);
          this.messageListener = null;
        }
        if (this.activePopup && !this.activePopup.closed) {
          try {
            this.activePopup.close();
          } catch {
            // Ignore popup close error
          }
        }
        this.activePopup = null;
      };

      this.messageListener = (event: MessageEvent) => {
        if (!event.data || event.origin !== window.location.origin) return;

        const data = event.data as { type?: string; token?: string; expiresIn?: number; state?: string; error?: string };
        if (data.type === 'DISCORD_AUTH_SUCCESS') {
          // CSRF: the callback echoes Discord's `state`; anything else is rejected.
          if (data.state !== expectedState) {
            cleanup();
            reject(new AuthError('STATE_MISMATCH', 'Не совпал код состояния OAuth — вход отменён в целях безопасности.'));
            return;
          }
          if (!data.token) {
            cleanup();
            reject(new AuthError('NO_TOKEN', 'Discord не вернул токен доступа.'));
            return;
          }

          cleanup();
          resolve({ token: data.token, expiresIn: data.expiresIn });
        } else if (data.type === 'DISCORD_AUTH_ERROR') {
          cleanup();
          reject(new AuthError('OAUTH_DENIED', data.error || 'Discord отклонил авторизацию.'));
        }
      };

      window.addEventListener('message', this.messageListener);

      let popup: Window | null = null;
      try {
        popup = window.open(
          url,
          'discord_auth_popup',
          `width=${width},height=${height},top=${top},left=${left},status=no,menubar=no,toolbar=no`
        );
      } catch (err) {
        cleanup();
        reject(
          new AuthError(
            'POPUP_BLOCKED',
            `Не удалось открыть окно входа Discord: ${err instanceof Error ? err.message : String(err)}`
          )
        );
        return;
      }

      if (!popup) {
        cleanup();
        reject(
          new AuthError(
            'POPUP_BLOCKED',
            'Браузер заблокировал окно входа Discord. Разрешите всплывающие окна для Wireon Sounds и попробуйте снова.'
          )
        );
        return;
      }

      this.activePopup = popup;

      checkClosedInterval = setInterval(() => {
        if (this.activePopup && this.activePopup.closed) {
          cleanup();
          reject(new AuthError('POPUP_CLOSED', 'Окно входа Discord закрыто до завершения авторизации.'));
        }
      }, 1000);

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new AuthError('TIMEOUT', `Вход через Discord не завершён за ${Math.round(timeoutMs / 1000)} с.`));
      }, timeoutMs);
    });

    return this.completeLogin(token.token, token.expiresIn);
  }

  /**
   * Вход по собственной схеме — общий для компьютера и телефона.
   *
   * Разница между платформами свелась к транспорту: на компьютере согласие
   * открывает системный браузер, а ответ приносит главный процесс; на телефоне
   * то и другое делает Capacitor. Сам поток — «отпечаток PKCE при запросе, код
   * в ответе, обмен кода на токен» — один, потому что требование у Discord одно,
   * а вторая копия разошлась бы с первой при первой же правке.
   */
  public async loginWithAppScheme(
    options: LoginOptions | undefined,
    bridge: DeepLinkAuthBridge
  ): Promise<AuthSession> {
    const clientId = options?.clientId || getDiscordClientId();
    if (!clientId) {
      throw new AuthError('NOT_CONFIGURED', 'Вход через Discord не настроен.');
    }

    const pkce = await createPkcePair();
    const redirectUri = options?.redirectUri || appSchemeRedirectUri(clientId);

    return this.loginWithDeepLink(
      {
        ...options,
        clientId,
        redirectUri,
        responseType: 'code',
        codeChallenge: pkce.challenge
      },
      bridge,
      pkce.verifier
    );
  }

  /** Вход на Android: тот же поток, транспорт — плагины Capacitor. */
  public async loginWithCapacitor(options?: LoginOptions): Promise<AuthSession> {
    const { createCapacitorAuthBridge } = await import('./capacitorAuthBridge');
    const bridge = await createCapacitorAuthBridge();
    if (!bridge) {
      throw new AuthError(
        'DEEP_LINK_UNAVAILABLE',
        'В этой сборке нет плагинов Capacitor для входа через Discord.'
      );
    }
    return this.loginWithAppScheme(options, bridge);
  }

  public async loginWithDeepLink(
    options?: LoginOptions,
    injectedBridge?: DeepLinkAuthBridge | null,
    /** Секрет PKCE. Задан — значит вернётся код, и его надо обменять на токен. */
    codeVerifier?: string
  ): Promise<AuthSession> {
    // Мост приходит снаружи только у телефона: транспорт там другой
    // (`@capacitor/browser` вместо системного браузера), а сам поток —
    // «открыть согласие, дождаться своей схемы, разобрать фрагмент» — тот же
    // до строчки. Две копии этого разошлись бы при первой же правке.
    const bridge = injectedBridge ?? getDesktopAuthBridge();
    if (!bridge) {
      throw new AuthError(
        'DEEP_LINK_UNAVAILABLE',
        'Для входа в приложении нужны electronAPI.onDeepLink и electronAPI.openExternal из основного процесса.'
      );
    }

    const expectedState = options?.state || generateState();
    const redirectUri = options?.redirectUri || DESKTOP_REDIRECT_URI;
    const { url } = generateOAuthUrl({
      clientId: options?.clientId,
      redirectUri,
      scopes: options?.scopes,
      responseType: options?.responseType || 'token',
      state: expectedState,
      codeChallenge: options?.codeChallenge
    });

    const timeoutMs = options?.timeoutMs || DEFAULT_LOGIN_TIMEOUT_MS;

    const token = await new Promise<{ token: string; expiresIn?: number }>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;
      let unsubscribeCancel: (() => void) | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (unsubscribeCancel) {
          unsubscribeCancel();
          unsubscribeCancel = null;
        }
      };

      // Человек закрыл окно согласия сам. Без этой подписки отказ от входа
      // ничем не отличается от зависшего: приложение показывало бы «входим»
      // до самого срока, хотя закрывать окно уже некому. Подписка
      // необязательная — у десктопного моста её нет.
      if (typeof bridge.onCancelled === 'function') {
        unsubscribeCancel = bridge.onCancelled(() => {
          cleanup();
          reject(new AuthError('POPUP_CLOSED', 'Окно входа Discord закрыто.'));
        });
      }

      unsubscribe = bridge.onDeepLink((callbackUrl: string) => {
        if (!isAuthCallbackUrl(callbackUrl)) return;

        const result = this.handleCallback(callbackUrl, expectedState);
        cleanup();

        // Поток по коду: Discord вернул не токен, а разрешение его получить.
        if (codeVerifier && result.authCode) {
          exchangeCodeForToken(
            result.authCode,
            options?.clientId || getDiscordClientId() || '',
            redirectUri,
            codeVerifier
          )
            .then(resolve)
            .catch(reject);
          return;
        }

        if (!result.success || !result.token) {
          reject(new AuthError(result.code || 'NO_TOKEN', result.error || 'Discord отклонил авторизацию.'));
          return;
        }
        resolve({ token: result.token, expiresIn: result.expiresIn });
      });

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new AuthError('TIMEOUT', `Вход через Discord не завершён за ${Math.round(timeoutMs / 1000)} с.`));
      }, timeoutMs);

      Promise.resolve()
        .then(() => bridge.openExternal(url))
        .catch((err: unknown) => {
          cleanup();
          reject(
            new AuthError(
              'DEEP_LINK_UNAVAILABLE',
              `Не удалось открыть браузер для входа через Discord: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        });
    });

    return this.completeLogin(token.token, token.expiresIn);
  }

  /**
   * Validates an OAuth2 redirect. Called by the popup callback page (which relays
   * the token to the opener) and by the desktop deep-link listener.
   */
  public handleCallback(urlOrHash?: string, expectedState?: string): CallbackResult {
    const targetUrl = urlOrHash || (typeof window !== 'undefined' ? window.location.href : '');
    const result = parseOAuthCallback(targetUrl);

    if (!result) {
      return { success: false, error: 'В ответе Discord нет данных авторизации.', code: 'NO_TOKEN' };
    }

    if (result.error) {
      this.postToOpener({ type: 'DISCORD_AUTH_ERROR', error: result.error, state: result.state });
      return { success: false, error: result.error, state: result.state, code: 'OAUTH_DENIED' };
    }

    if (expectedState !== undefined && result.state !== expectedState) {
      return {
        success: false,
        error: 'Не совпал код состояния OAuth — вход отменён в целях безопасности.',
        state: result.state,
        code: 'STATE_MISMATCH'
      };
    }

    if (result.accessToken) {
      const expiresIn = result.expiresIn || DEFAULT_SESSION_TTL_SECONDS;
      // `state` must travel with the token, otherwise the opener cannot verify it.
      this.postToOpener({
        type: 'DISCORD_AUTH_SUCCESS',
        token: result.accessToken,
        expiresIn,
        state: result.state
      });
      return { success: true, token: result.accessToken, expiresIn, state: result.state };
    }

    /*
     * Пришёл код, а не токен. На телефоне это штатный путь: Discord требует для
     * мобильной схемы поток по коду с PKCE, и обмен делает сам клиент — секрет
     * приложения для этого не нужен. Отдаём код наверх; решает вызывающий.
     */
    if (result.code) {
      return { success: false, authCode: result.code, state: result.state, code: 'NO_TOKEN' };
    }

    return {
      success: false,
      error: 'Discord не вернул ни токена, ни кода авторизации.',
      state: result.state,
      code: 'NO_TOKEN'
    };
  }

  /**
   * Restores and refreshes the persisted session, clearing it when the token is
   * expired or rejected by Discord.
   */
  public async validateSession(): Promise<UserProfile | null> {
    const { user, token, isExpired } = getStoredSession();
    if (!user || !token || isExpired) {
      clearStoredSession();
      return null;
    }

    try {
      const refreshedProfile = await fetchDiscordUserProfile(token);
      saveStoredSession(refreshedProfile, token);
      return refreshedProfile;
    } catch (err) {
      const status = err instanceof AuthError ? err.status : undefined;
      if (status === 401 || status === 403) {
        clearStoredSession();
        return null;
      }
      // Network failure: keep the cached profile so the app works offline.
      return user;
    }
  }

  /**
   * Logs out and cleans up session.
   */
  public logout(): void {
    clearStoredSession();
  }

  private async completeLogin(token: string, expiresInSeconds?: number): Promise<AuthSession> {
    const userProfile = await fetchDiscordUserProfile(token).catch((err: unknown) => {
      if (err instanceof AuthError) throw err;
      throw new AuthError(
        'PROFILE_FETCH_FAILED',
        `Не удалось загрузить профиль Discord: ${err instanceof Error ? err.message : String(err)}`
      );
    });

    const stored = saveStoredSession(userProfile, token, expiresInSeconds || DEFAULT_SESSION_TTL_SECONDS);
    return { user: stored, token };
  }

  private postToOpener(message: { type: string; token?: string; expiresIn?: number; state?: string; error?: string }): void {
    if (typeof window === 'undefined' || !window.opener) return;
    try {
      window.opener.postMessage(message, window.location.origin);
      window.close();
    } catch (err) {
      console.warn('[DiscordAuth] Failed to notify the opener window:', err);
    }
  }
}

export const discordAuthService = new DiscordAuthService();

/**
 * Entry point for the popup callback page: relays the OAuth2 result to the opener
 * when the current URL is `/auth/callback`. Returns false when the app was loaded
 * normally, so the caller can continue booting the SPA.
 */
export function handleAuthCallbackPage(): boolean {
  if (typeof window === 'undefined') return false;
  if (!isAuthCallbackUrl(window.location.href)) return false;

  const result = discordAuthService.handleCallback(window.location.href);
  if (!result.success) {
    console.warn('[DiscordAuth] OAuth callback rejected:', result.code, result.error);
  }
  return true;
}
