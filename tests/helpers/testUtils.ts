/**
 * Shared plumbing for the Tier 1-4 suites.
 *
 * The rule these helpers exist to enforce: **mock the network, never the module
 * under test.** Nothing here re-implements application behaviour — there is no
 * fake player, no fake aggregator and no fake sync engine. What is provided is
 * a `fetch` router, `Response` builders, store reset helpers that drive the real
 * Zustand stores, and remote sync adapters (the one genuinely absent collaborator
 * in this codebase, since Wireon ships with `NullRemoteAdapter`).
 */

import { vi } from 'vitest';
import { RemoteSyncAdapter } from '../../src/types/auth';
import { Playlist, UnifiedTrack } from '../../src/types/music';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useUIStore } from '../../src/store/useUIStore';
import { HlsHandle } from '../../src/services/hls';

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function textResponse(body: string, status: number = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

/** A non-2xx answer, e.g. the 502 a dead Piped proxy returns. */
export function httpErrorResponse(status: number, body: string = 'error'): Response {
  return new Response(body, { status });
}

/** An HTML landing page where JSON was expected (a very common failure). */
export function htmlResponse(status: number = 200): Response {
  return new Response('<!doctype html><html><body>nope</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' }
  });
}

// ---------------------------------------------------------------------------
// fetch router
// ---------------------------------------------------------------------------

export interface FetchRoute {
  /** Substring or pattern matched against the request URL. */
  match: string | RegExp;
  /** Answer for a matching request, or a thrower to simulate a dead host. */
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export interface FetchMockOptions {
  /** Used when no route matches. Defaults to throwing, which surfaces gaps. */
  fallback?: (url: string) => Response | Promise<Response>;
}

export interface InstalledFetchMock {
  fn: ReturnType<typeof vi.fn>;
  /** Every URL that was requested, in order. */
  calls: string[];
}

/**
 * Installs a `fetch` stub that answers by URL. Any request that matches no
 * route rejects with a descriptive error, so a test can never silently reach the
 * real internet.
 */
export function installFetchMock(
  routes: FetchRoute[],
  options: FetchMockOptions = {}
): InstalledFetchMock {
  const calls: string[] = [];

  const fn = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    calls.push(url);

    for (const route of routes) {
      const hit =
        typeof route.match === 'string' ? url.includes(route.match) : route.match.test(url);
      if (hit) return route.respond(url, init);
    }

    if (options.fallback) return options.fallback(url);
    throw new Error(`[testUtils] Unrouted fetch in test: ${url}`);
  });

  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

/** A `respond` implementation that behaves like an unreachable host. */
export function unreachable(message: string = 'network unreachable') {
  return () => {
    throw new Error(message);
  };
}

export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Drains several macrotask turns. One is not enough to settle an IndexedDB
 * transaction, which matters for the writes the app fires without awaiting —
 * left pending, they land in the *next* test's store and corrupt it.
 */
export async function flushAsync(turns: number = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Polls until `predicate` holds. Needed for the writes the app deliberately does
 * not await — `commitTrack` fires its history write and moves on, so a single
 * microtask flush is not enough to observe an IndexedDB transaction.
 */
export async function waitFor(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`[testUtils] waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// HLS test doubles
// ---------------------------------------------------------------------------

/**
 * A stand-in for the handle `attachHls` resolves with. Only the `hls.js` import
 * boundary is faked; `isHlsUrl` and the audio engine's own routing stay real.
 */
export function createStubHlsHandle(url: string): HlsHandle & { destroyed: boolean } {
  const handle = {
    url,
    usingNative: false,
    destroyed: false,
    destroy(): void {
      handle.destroyed = true;
    }
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Remote sync adapters
// ---------------------------------------------------------------------------

export interface SpyRemoteAdapter extends RemoteSyncAdapter {
  pushPlaylists: ReturnType<typeof vi.fn>;
  pullPlaylists: ReturnType<typeof vi.fn>;
  pushFavorites: ReturnType<typeof vi.fn>;
  pullFavorites: ReturnType<typeof vi.fn>;
  deletePlaylist: ReturnType<typeof vi.fn>;
  deleteFavorite: ReturnType<typeof vi.fn>;
}

/**
 * A configured remote that accepts everything. Only for tests about what happens
 * *when a backend exists* — never as a way to make a local-only assertion pass.
 */
export function createAcceptingRemote(): SpyRemoteAdapter {
  return {
    id: 'accepting-test-remote',
    isConfigured: () => true,
    pushPlaylists: vi.fn(async (playlists: Playlist[]) => playlists.length),
    pullPlaylists: vi.fn(async (): Promise<Playlist[]> => []),
    pushFavorites: vi.fn(async (tracks: UnifiedTrack[]) => tracks.length),
    pullFavorites: vi.fn(async (): Promise<UnifiedTrack[]> => []),
    deletePlaylist: vi.fn(async () => true),
    deleteFavorite: vi.fn(async () => true)
  };
}

/** A configured but unreachable remote: exercises the journal and backoff. */
export function createFailingRemote(message: string = 'remote unreachable'): SpyRemoteAdapter {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    id: 'failing-test-remote',
    isConfigured: () => true,
    pushPlaylists: vi.fn(fail),
    pullPlaylists: vi.fn(fail),
    pushFavorites: vi.fn(fail),
    pullFavorites: vi.fn(fail),
    deletePlaylist: vi.fn(fail),
    deleteFavorite: vi.fn(fail)
  };
}

// ---------------------------------------------------------------------------
// Store resets (the real stores, not copies of them)
// ---------------------------------------------------------------------------

/** Restores `usePlayerStore` to its documented initial state. */
export function resetPlayerStore(): void {
  usePlayerStore.setState({
    currentTrack: null,
    playbackState: 'idle',
    isPlaying: false,
    isLoading: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 0.8,
    isMuted: false,
    previousVolume: 0.8,
    repeatMode: 'off',
    isShuffled: false,
    error: null,
    errorDetail: null,
    errorCanRetry: true,
    isPreviewStream: false,
    userQueue: [],
    sourceQueue: [],
    history: [],
    currentIndex: -1,
    shuffleOrder: [],
    visualizerEnabled: true,
    visualizerPreset: 'CYBER_BARS',
    sleepTimerEndsAt: null,
    autoplayRadio: false,
    eq: { bass: 0, mid: 0, treble: 0 },
    crossfadeEnabled: false,
    crossfadeDuration: 3,
    loudnessNormalization: false,
    mediaKeysEnabled: true,
    settingsHydrated: false,
    // Настройки Потока тоже сбрасываются: иначе сдвинутый в одном тесте
    // регулятор молча меняет поведение следующего.
    queueMode: 'sequential',
    activeWaveMood: 'favorite',
    activeWaveGenre: null,
    activeSeedTrack: null,
    isReplenishingQueue: false,
    waveNovelty: 0.35,
    waveEnergy: 0.5,
    waveSeedKind: 'library',
    waveSeedArtist: null
  });
}

export function resetLibraryStore(): void {
  useLibraryStore.setState({
    favorites: [],
    playlists: [],
    history: [],
    isLoading: false,
    error: null
  });
}

export function resetAuthStore(): void {
  useAuthStore.setState({
    user: null,
    token: null,
    isAuthenticated: false,
    isGuest: true,
    isSyncing: false,
    lastSyncedAt: null,
    authStatus: 'idle',
    error: null
  });
}

/**
 * Ставит прогон в состояние «человек вошёл».
 *
 * Нужен с тех пор, как медиатека привязана к аккаунту: гость больше не может
 * завести плейлист или добавить трек в избранное — приложение вместо этого
 * просит войти. Проверкам самой медиатеки такой отказ не интересен, они про
 * другое, поэтому вход выставляется прямо в сторе, без сети и без Discord.
 *
 * Вызывать **после** `resetAuthStore()`, иначе сброс снимет вход обратно.
 */
export function signInForTests(id: string = 'test-user'): void {
  useAuthStore.setState({
    user: {
      id,
      username: 'Тестовый слушатель',
      avatarUrl: null,
      isGuest: false
    } as never,
    token: 'test-token',
    isAuthenticated: true,
    isGuest: false,
    authStatus: 'authenticated',
    error: null
  });
}

export function resetUIStore(): void {
  useUIStore.setState({
    activeView: 'search',
    activePlaylistId: null,
    isQueueOpen: false,
    isFullscreenPlayerOpen: false,
    isCommandPaletteOpen: false,
    searchQuery: '',
    searchFilter: 'all',
    toastMessage: null
  });
}

/** Clears every `wireon_auth_*` key so a session assertion starts from zero. */
export function clearAuthStorage(): void {
  try {
    window.localStorage.clear();
  } catch {
    // jsdom without storage: nothing to clear.
  }
}

/** True when no part of a Discord session is present in localStorage. */
export function hasNoStoredSession(): boolean {
  return (
    window.localStorage.getItem('wireon_auth_user') === null &&
    window.localStorage.getItem('wireon_auth_token') === null &&
    window.localStorage.getItem('wireon_auth_token_expires') === null
  );
}
