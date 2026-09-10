/**
 * Вход в Spotify — только чтобы прочитать библиотеку.
 *
 * Зачем он вообще. Публичную страницу плейлиста можно разобрать и без входа
 * (см. playlistImporter), но оттуда приезжает лишь первая сотня треков, а
 * «Любимые» и приватные плейлисты не приезжают вовсе. Через их собственный API
 * ограничения нет: списки читаются страницами до конца.
 *
 * Схема — PKCE, без пароля приложения. Настольной программе хранить пароль
 * негде: он всё равно уехал бы внутрь сборки, и любой желающий достал бы его
 * оттуда за минуту. PKCE придуман ровно для этого случая — секрет рождается на
 * время одного входа и живёт в памяти.
 *
 * Права запрашиваются самые узкие, какие позволяют прочитать библиотеку:
 * чужие публичные плейлисты, свои приватные и «Любимые треки». Ни изменения,
 * ни воспроизведения, ни данных об оплате.
 */

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/** Адрес возврата. Он же прописан в кабинете приложения на стороне Spotify. */
export const SPOTIFY_REDIRECT_URI = 'wireon://spotify/callback';

export const SPOTIFY_SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read'];

const STORAGE_KEY = 'wireon_spotify_session';

export interface SpotifySession {
  accessToken: string;
  refreshToken: string | null;
  /** Момент времени, после которого токен уже не примут. */
  expiresAt: number;
}

/** Токен считаем протухшим за минуту до срока: запрос успеет уйти по дороге. */
const EXPIRY_MARGIN_MS = 60_000;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Случайная строка, из которой считается «загадка» для Spotify. */
export function createCodeVerifier(size = 64): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function getClientId(): string {
  try {
    return (import.meta.env?.VITE_SPOTIFY_CLIENT_ID as string | undefined)?.trim() || '';
  } catch {
    return '';
  }
}

/** Адрес страницы согласия. `state` возвращается назад и сверяется. */
export function buildAuthUrl(clientId: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SPOTIFY_SCOPES.join(' ')
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Разбирает адрес возврата.
 *
 * Возвращает либо код, либо причину отказа — человек мог нажать «Отмена», и это
 * не ошибка программы, а его решение.
 */
export function parseCallbackUrl(url: string): { code?: string; state?: string; error?: string } {
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    return {
      code: params.get('code') || undefined,
      state: params.get('state') || undefined,
      error: params.get('error') || undefined
    };
  } catch {
    return { error: 'Не удалось разобрать адрес возврата' };
  }
}

async function requestToken(body: URLSearchParams): Promise<SpotifySession> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof data.error_description === 'string' ? data.error_description : `HTTP ${response.status}`;
    throw new Error(`Spotify отказал: ${detail}`);
  }

  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  if (!accessToken) throw new Error('Spotify не выдал токен');

  return {
    accessToken,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresAt: Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000
  };
}

export function exchangeCode(clientId: string, code: string, verifier: string): Promise<SpotifySession> {
  return requestToken(
    new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      code_verifier: verifier
    })
  );
}

export async function refreshSession(clientId: string, refreshToken: string): Promise<SpotifySession> {
  const session = await requestToken(
    new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  );
  // Обновление не всегда возвращает новый ключ обновления — тогда действует старый.
  return { ...session, refreshToken: session.refreshToken || refreshToken };
}

/** Сколько ждём возврата из браузера, прежде чем считать, что человек ушёл. */
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Ведёт вход от начала до конца: открывает согласие в системном браузере и ждёт
 * возврата по `wireon://`.
 *
 * Именно в системном, а не в своём окне: страница входа Spotify — чужая, и
 * пароль там человек вводит в браузере, которому доверяет, а не в окне,
 * нарисованном нами.
 */
export async function runSpotifyLogin(): Promise<SpotifySession> {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error('Не задан VITE_SPOTIFY_CLIENT_ID — вход в Spotify не настроен');
  }

  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.onDeepLink || !api.openExternal) {
    throw new Error('Вход в Spotify доступен только в настольном приложении');
  }

  const verifier = createCodeVerifier();
  const challenge = await createCodeChallenge(verifier);
  const state = createCodeVerifier(16);

  const code = await new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe?.();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('Вход не завершён — окно Spotify так и не вернулось'))),
      LOGIN_TIMEOUT_MS
    );

    const unsubscribe = api.onDeepLink?.((url: string) => {
      if (!url.startsWith('wireon://spotify')) return;

      const result = parseCallbackUrl(url);
      if (result.error) {
        finish(() => reject(new Error(result.error === 'access_denied' ? 'Вход отменён' : `Spotify: ${result.error}`)));
        return;
      }
      // Чужой ответ на наш адрес — не наш вход. Сверка `state` для того и нужна.
      if (result.state !== state) return;
      if (!result.code) {
        finish(() => reject(new Error('Spotify вернулся без кода')));
        return;
      }
      finish(() => resolve(result.code as string));
    });

    void api.openExternal?.(buildAuthUrl(clientId, challenge, state)).catch((err: unknown) =>
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    );
  });

  const session = await exchangeCode(clientId, code, verifier);
  saveSession(session);
  return session;
}

export function loadSession(): SpotifySession | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SpotifySession>;
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
      expiresAt: Number(parsed.expiresAt) || 0
    };
  } catch {
    return null;
  }
}

export function saveSession(session: SpotifySession | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (!session) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Приватный режим или переполненное хранилище: вход просто не переживёт перезапуск.
  }
}

export function isExpired(session: SpotifySession, now = Date.now()): boolean {
  return now + EXPIRY_MARGIN_MS >= session.expiresAt;
}

/**
 * Токен, годный прямо сейчас: при необходимости обновляет и сохраняет.
 *
 * `null` — входа нет или он больше не действует; звать вход должен тот, кто
 * спрашивал, а не эта функция: неожиданно открытое окно браузера пугает.
 */
export async function getFreshAccessToken(clientId = getClientId()): Promise<string | null> {
  const session = loadSession();
  if (!session) return null;
  if (!isExpired(session)) return session.accessToken;
  if (!session.refreshToken || !clientId) {
    saveSession(null);
    return null;
  }

  try {
    const next = await refreshSession(clientId, session.refreshToken);
    saveSession(next);
    return next.accessToken;
  } catch {
    saveSession(null);
    return null;
  }
}
