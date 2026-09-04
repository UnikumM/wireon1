import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import * as discordAuthModule from '../../src/services/discordAuth';
import {
  getDiscordAvatarUrl,
  getDiscordBannerUrl,
  generateOAuthUrl,
  parseOAuthCallback,
  fetchDiscordUserProfile,
  createGuestProfile,
  saveStoredSession,
  getStoredSession,
  clearStoredSession,
  getDiscordClientId,
  resolveClientId,
  DEFAULT_DISCORD_CLIENT_ID,
  appSchemeRedirectUri,
  isDiscordConfigured,
  isDesktopRuntime,
  isAuthCallbackUrl,
  getBrowserRedirectUri,
  getDefaultRedirectUri,
  handleAuthCallbackPage,
  AuthError,
  DiscordAuthService,
  discordAuthService,
  DEV_BROWSER_REDIRECT_URI,
  STORAGE_KEY_AUTH_USER,
  STORAGE_KEY_AUTH_TOKEN,
  STORAGE_KEY_TOKEN_EXPIRES
} from '../../src/services/discordAuth';
import { DiscordUserRaw } from '../../src/types/auth';
import { UserProfile } from '../../src/types/music';

const TEST_CLIENT_ID = '112233445566778899';

const rawDiscordUser: DiscordUserRaw = {
  id: '847291048291048291',
  username: 'WireonFan',
  global_name: 'Wireon Audiophile',
  discriminator: '0',
  avatar: 'a_1829f04918239012',
  banner: 'banner_abc',
  email: 'audiophile@wireon.io',
  verified: true
};

/** Minimal fetch double for the `GET /users/@me` call. */
function mockProfileFetch(raw: DiscordUserRaw = rawDiscordUser) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => raw
  });
}

/** A complete stored profile, as `fetchDiscordUserProfile` would have built it. */
function profileOf(id: string, username: string): UserProfile {
  return {
    id,
    username,
    avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
    provider: 'discord',
    status: 'online'
  };
}

/** Popup double: `window.open` normally returns a Window, or null when blocked. */
function fakePopup() {
  return { closed: false, close: vi.fn() } as unknown as Window;
}

function expectNoStoredSession() {
  expect(localStorage.getItem(STORAGE_KEY_AUTH_USER)).toBeNull();
  expect(localStorage.getItem(STORAGE_KEY_AUTH_TOKEN)).toBeNull();
  expect(localStorage.getItem(STORAGE_KEY_TOKEN_EXPIRES)).toBeNull();
  expect(localStorage.length).toBe(0);
}

describe('Discord OAuth2 Service (src/services/discordAuth.ts)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // ==========================================================================
  // 1. Avatar & Banner CDN URL Generation
  // ==========================================================================
  describe('Avatar & Banner CDN URL Generation', () => {
    it('generates correct default avatar index using BigInt formula ((userId >> 22) % 6)', () => {
      const url1 = getDiscordAvatarUrl('847291048291048291', null);
      expect(url1).toBe('https://cdn.discordapp.com/embed/avatars/1.png');

      const urlIndex5 = getDiscordAvatarUrl('20971520', null);
      expect(urlIndex5).toBe('https://cdn.discordapp.com/embed/avatars/5.png');

      const urlZero = getDiscordAvatarUrl('0', null);
      expect(urlZero).toBe('https://cdn.discordapp.com/embed/avatars/0.png');

      const urlGuest = getDiscordAvatarUrl('guest_alpha', undefined);
      expect(urlGuest).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
    });

    it('generates animated GIF URL when avatar hash starts with "a_"', () => {
      const url = getDiscordAvatarUrl('123456789', 'a_abcdef123456', 256);
      expect(url).toBe('https://cdn.discordapp.com/avatars/123456789/a_abcdef123456.gif?size=256');
    });

    it('generates static PNG/WebP URL when avatar hash is static', () => {
      const urlDefault = getDiscordAvatarUrl('123456789', 'abcdef123456', 128);
      expect(urlDefault).toBe('https://cdn.discordapp.com/avatars/123456789/abcdef123456.png?size=128');

      const urlWebp = getDiscordAvatarUrl('123456789', 'abcdef123456', 512, 'webp');
      expect(urlWebp).toBe('https://cdn.discordapp.com/avatars/123456789/abcdef123456.webp?size=512');
    });

    it('generates banner CDN URLs for static and animated banners', () => {
      expect(getDiscordBannerUrl('123', null)).toBeUndefined();
      expect(getDiscordBannerUrl('123', undefined)).toBeUndefined();

      const staticBanner = getDiscordBannerUrl('123', 'banner_hash_xyz', 512);
      expect(staticBanner).toBe('https://cdn.discordapp.com/banners/123/banner_hash_xyz.png?size=512');

      const animatedBanner = getDiscordBannerUrl('123', 'a_banner_hash_xyz', 1024);
      expect(animatedBanner).toBe('https://cdn.discordapp.com/banners/123/a_banner_hash_xyz.gif?size=1024');
    });
  });

  // ==========================================================================
  // 2. Configuration Gate (no placeholder client id, no mock login)
  // ==========================================================================
  describe('Configuration Gate', () => {
    it('never exposes a mock-user helper, and ships a real application id', () => {
      expect(Object.keys(discordAuthModule)).not.toContain('createMockUserProfile');
      // The client id is public by design (it travels in the authorization URL),
      // so shipping it is what lets a packaged build sign in without a .env.
      // A placeholder would be worse than nothing: assert it is a real snowflake.
      expect(DEFAULT_DISCORD_CLIENT_ID).toMatch(/^\d{17,20}$/);
    });

    it('falls back to the built-in application id when VITE_DISCORD_CLIENT_ID is blank', () => {
      vi.stubEnv('VITE_DISCORD_CLIENT_ID', '');
      expect(getDiscordClientId()).toBe(DEFAULT_DISCORD_CLIENT_ID);
      expect(isDiscordConfigured()).toBe(true);

      vi.stubEnv('VITE_DISCORD_CLIENT_ID', '   ');
      expect(getDiscordClientId()).toBe(DEFAULT_DISCORD_CLIENT_ID);
      expect(isDiscordConfigured()).toBe(true);
    });

    it('reads and trims the client id from the Vite environment', () => {
      vi.stubEnv('VITE_DISCORD_CLIENT_ID', `  ${TEST_CLIENT_ID} `);
      expect(getDiscordClientId()).toBe(TEST_CLIENT_ID);
      expect(isDiscordConfigured()).toBe(true);
    });

    it('reports "not configured" only when both the override and the built-in id are gone', () => {
      // The state a fork reaches by stripping DEFAULT_DISCORD_CLIENT_ID.
      expect(resolveClientId('', '')).toBeNull();
      expect(resolveClientId('   ', '   ')).toBeNull();
      expect(resolveClientId(undefined, '')).toBeNull();
      // An override still wins over an emptied built-in id.
      expect(resolveClientId(TEST_CLIENT_ID, '')).toBe(TEST_CLIENT_ID);
    });

    it('builds the authorization URL from the built-in id with no env override', () => {
      vi.stubEnv('VITE_DISCORD_CLIENT_ID', '');
      const { url } = generateOAuthUrl();
      expect(url).toContain(`client_id=${DEFAULT_DISCORD_CLIENT_ID}`);
      expect(url).toContain('response_type=token');
    });

    it('still throws AuthError(NOT_CONFIGURED) rather than build a URL with no id', () => {
      // `resolveClientId` above covers every input that reaches the guard; this
      // pins the error the guard raises so the message stays actionable.
      const err = new AuthError(
        'NOT_CONFIGURED',
        'Discord login is not configured: set VITE_DISCORD_CLIENT_ID in your .env (see .env.example).'
      );
      expect(err.code).toBe('NOT_CONFIGURED');
      expect(err.message).toContain('VITE_DISCORD_CLIENT_ID');
    });

    it('lets login() run with the built-in id and stores no session on failure', async () => {
      vi.stubEnv('VITE_DISCORD_CLIENT_ID', '');
      const service = new DiscordAuthService();

      // The desktop bridge in tests never delivers a deep link, so the flow
      // fails — the point is that it fails on the flow, not on configuration.
      expect(isDiscordConfigured()).toBe(true);
      await expect(service.login({ timeoutMs: 10 })).rejects.toBeInstanceOf(AuthError);
      await expect(service.login({ timeoutMs: 10 })).rejects.not.toMatchObject({
        code: 'NOT_CONFIGURED'
      });
      expectNoStoredSession();
    });
  });

  // ==========================================================================
  // 3. OAuth2 Authorization URL Builder
  // ==========================================================================
  describe('OAuth2 Authorization URL Builder', () => {
    it('generates authorization URL from the configured client id, scopes and response_type', () => {
      vi.stubEnv('VITE_DISCORD_CLIENT_ID', TEST_CLIENT_ID);
      const { url, state } = generateOAuthUrl();

      expect(url).toContain('https://discord.com/api/oauth2/authorize');
      expect(url).toContain(`client_id=${TEST_CLIENT_ID}`);
      expect(url).toContain('response_type=token');
      expect(url).toContain('scope=identify+email');
      expect(url).toContain(`state=${state}`);
      expect(state.length).toBeGreaterThan(8);
    });

    it('accepts custom client ID, redirectUri, scopes, and response_type', () => {
      const { url } = generateOAuthUrl({
        clientId: '998877665544332211',
        redirectUri: 'https://custom.app/callback',
        scopes: ['identify', 'guilds', 'email'],
        responseType: 'code',
        state: 'custom_secure_state_123',
        prompt: 'none'
      });

      expect(url).toContain('client_id=998877665544332211');
      expect(url).toContain('redirect_uri=https%3A%2F%2Fcustom.app%2Fcallback');
      expect(url).toContain('response_type=code');
      expect(url).toContain('scope=identify+guilds+email');
      expect(url).toContain('state=custom_secure_state_123');
      expect(url).toContain('prompt=none');
    });

    it('в приложении возвращается по схеме Discord, в браузере — на свою страницу', () => {
      // tests/setup.ts installs a window.electronAPI mock, so this run is "desktop".
      expect(isDesktopRuntime()).toBe(true);
      // Не `wireon://`: Discord отвергает любую схему, кроме своей, даже
      // прописанную в панели разработчика. Одна и та же и на ПК, и на телефоне.
      expect(getDefaultRedirectUri()).toBe(appSchemeRedirectUri(DEFAULT_DISCORD_CLIENT_ID));
      expect(getDefaultRedirectUri()).toMatch(/^discord-\d+:\/authorize\/callback$/);

      vi.stubGlobal('electronAPI', undefined);
      expect(isDesktopRuntime()).toBe(false);
      expect(getDefaultRedirectUri()).toBe(getBrowserRedirectUri());
      expect(getBrowserRedirectUri()).toBe(`${window.location.origin}/auth/callback`);
      expect(DEV_BROWSER_REDIRECT_URI).toBe('http://localhost:3000/auth/callback');
    });

    it('recognizes both callback URL shapes', () => {
      expect(isAuthCallbackUrl('wireon://auth/callback#access_token=abc')).toBe(true);
      expect(isAuthCallbackUrl('http://localhost:3000/auth/callback?code=abc')).toBe(true);
      expect(isAuthCallbackUrl('http://localhost:3000/')).toBe(false);
      expect(isAuthCallbackUrl('')).toBe(false);
    });
  });

  // ==========================================================================
  // 4. OAuth2 Callback Parser
  // ==========================================================================
  describe('OAuth2 Callback Parser', () => {
    it('parses token parameters from URL hash fragment (Implicit Grant)', () => {
      const hashUrl = 'https://wireon.app/auth/callback#access_token=token_abc_123&token_type=Bearer&expires_in=604800&state=state_xyz';
      const result = parseOAuthCallback(hashUrl);

      expect(result).not.toBeNull();
      expect(result?.accessToken).toBe('token_abc_123');
      expect(result?.tokenType).toBe('Bearer');
      expect(result?.expiresIn).toBe(604800);
      expect(result?.state).toBe('state_xyz');
    });

    it('parses the desktop deep link the main process forwards', () => {
      const result = parseOAuthCallback('wireon://auth/callback#access_token=deep_token&expires_in=3600&state=deep_state');

      expect(result?.accessToken).toBe('deep_token');
      expect(result?.expiresIn).toBe(3600);
      expect(result?.state).toBe('deep_state');
    });

    it('parses authorization code from search query parameters (Code Grant)', () => {
      const queryUrl = 'https://wireon.app/auth/callback?code=discord_auth_code_789&state=state_xyz';
      const result = parseOAuthCallback(queryUrl);

      expect(result).not.toBeNull();
      expect(result?.code).toBe('discord_auth_code_789');
      expect(result?.state).toBe('state_xyz');
    });

    it('handles error response in callback', () => {
      const errorUrl = 'https://wireon.app/auth/callback?error=access_denied&error_description=The+user+denied+access';
      const result = parseOAuthCallback(errorUrl);

      expect(result).not.toBeNull();
      expect(result?.error).toBe('access_denied');
    });

    it('returns null for invalid or empty callback URLs', () => {
      expect(parseOAuthCallback('')).toBeNull();
      expect(parseOAuthCallback('https://wireon.app/other')).toBeNull();
    });
  });

  // ==========================================================================
  // 5. Discord User Profile Fetching & Mapping
  // ==========================================================================
  describe('Discord User Profile Fetching & Mapping', () => {
    it('fetches and maps Discord user profile correctly', async () => {
      const mockFetch = mockProfileFetch();
      const profile = await fetchDiscordUserProfile('valid_token', mockFetch as unknown as typeof fetch);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://discord.com/api/v10/users/@me',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer valid_token'
          })
        })
      );

      expect(profile.id).toBe('847291048291048291');
      expect(profile.username).toBe('Wireon Audiophile'); // Global name takes priority
      expect(profile.discriminator).toBeUndefined(); // '0' discriminator is omitted
      expect(profile.avatarUrl).toContain('a_1829f04918239012.gif');
      expect(profile.bannerUrl).toContain('banner_abc.png');
      expect(profile.email).toBe('audiophile@wireon.io');
      expect(profile.provider).toBe('discord');
      expect(profile.status).toBe('online');
      expect(profile.accessToken).toBe('valid_token');
    });

    it('throws typed AuthErrors for a missing token and for an API failure', async () => {
      await expect(fetchDiscordUserProfile('')).rejects.toMatchObject({
        name: 'AuthError',
        code: 'NO_TOKEN'
      });

      const mockErrorFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => '401: Unauthorized'
      });

      await expect(
        fetchDiscordUserProfile('bad_token', mockErrorFetch as unknown as typeof fetch)
      ).rejects.toMatchObject({
        code: 'PROFILE_FETCH_FAILED',
        status: 401,
        message: expect.stringContaining('Discord ответил ошибкой (401)')
      });
    });
  });

  // ==========================================================================
  // 6. Guest Profile & Session Persistence
  // ==========================================================================
  describe('Guest Profile & Session Persistence', () => {
    it('creates guest profile with unique ID and default avatar', () => {
      const guest1 = createGuestProfile();
      expect(guest1.id).toMatch(/^guest_/);
      expect(guest1.provider).toBe('guest');
      expect(guest1.username).toBe('Гость');
      expect(guest1.avatarUrl).toContain('cdn.discordapp.com/embed/avatars/');

      const guestCustom = createGuestProfile('custom_123');
      expect(guestCustom.id).toBe('guest_custom_123');
    });

    it('saves, retrieves, and clears the session in localStorage', () => {
      const stored = saveStoredSession(profileOf('user_100', 'TestUser'), 'test_token_123', 3600);

      expect(stored.accessToken).toBe('test_token_123');
      expect(stored.expiresAt).toBeGreaterThan(Date.now());

      const session = getStoredSession();
      expect(session.user?.id).toBe('user_100');
      expect(session.token).toBe('test_token_123');
      expect(session.isExpired).toBe(false);

      clearStoredSession();
      const cleared = getStoredSession();
      expect(cleared.user).toBeNull();
      expect(cleared.token).toBeNull();
      expectNoStoredSession();
    });

    it('detects expired sessions from wireon_auth_token_expires', () => {
      saveStoredSession(profileOf('user_1', 'U'), 'test_token_123', -100);

      const session = getStoredSession();
      expect(session.isExpired).toBe(true);
      expect(Number(localStorage.getItem(STORAGE_KEY_TOKEN_EXPIRES))).toBeLessThan(Date.now());
    });
  });

  // ==========================================================================
  // 7. Popup Login Flow (browser / dev)
  // ==========================================================================
  describe('Popup Login Flow', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_DISCORD_CLIENT_ID', TEST_CLIENT_ID);
    });

    it('rejects with AuthError(POPUP_BLOCKED) and writes nothing when the popup is blocked', async () => {
      const open = vi.fn().mockReturnValue(null);
      vi.stubGlobal('open', open);
      const service = new DiscordAuthService();

      const error = await service.loginWithPopup().catch((err: unknown) => err);

      expect(open).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('POPUP_BLOCKED');
      expect((error as AuthError).message).toContain('заблокировал');
      expectNoStoredSession();
    });

    it('rejects with AuthError(POPUP_BLOCKED) when window.open throws', async () => {
      vi.stubGlobal('open', vi.fn().mockImplementation(() => {
        throw new Error('Blocked by policy');
      }));
      const service = new DiscordAuthService();

      await expect(service.loginWithPopup()).rejects.toMatchObject({ code: 'POPUP_BLOCKED' });
      expectNoStoredSession();
    });

    it('completes the login when the callback page relays a matching state', async () => {
      vi.stubGlobal('open', vi.fn().mockReturnValue(fakePopup()));
      vi.stubGlobal('fetch', mockProfileFetch());
      const service = new DiscordAuthService();

      const pending = service.loginWithPopup({ state: 'state_ok' });
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'DISCORD_AUTH_SUCCESS', token: 'popup_token', expiresIn: 3600, state: 'state_ok' }
        })
      );

      const session = await pending;
      expect(session.token).toBe('popup_token');
      expect(session.user.id).toBe(rawDiscordUser.id);
      expect(getStoredSession().token).toBe('popup_token');
      expect(getStoredSession().isExpired).toBe(false);
    });

    it('rejects with AuthError(STATE_MISMATCH) when the relayed state does not match', async () => {
      vi.stubGlobal('open', vi.fn().mockReturnValue(fakePopup()));
      vi.stubGlobal('fetch', mockProfileFetch());
      const service = new DiscordAuthService();

      const pending = service.loginWithPopup({ state: 'state_expected' });
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'DISCORD_AUTH_SUCCESS', token: 'attacker_token', state: 'state_forged' }
        })
      );

      await expect(pending).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
      expectNoStoredSession();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('ignores messages from a foreign origin', async () => {
      vi.stubGlobal('open', vi.fn().mockReturnValue(fakePopup()));
      vi.stubGlobal('fetch', mockProfileFetch());
      const service = new DiscordAuthService();

      const pending = service.loginWithPopup({ state: 'state_ok', timeoutMs: 40 });
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://evil.example.com',
          data: { type: 'DISCORD_AUTH_SUCCESS', token: 'evil_token', state: 'state_ok' }
        })
      );

      await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      expectNoStoredSession();
    });

    it('rejects with AuthError(OAUTH_DENIED) when Discord reports an error', async () => {
      vi.stubGlobal('open', vi.fn().mockReturnValue(fakePopup()));
      const service = new DiscordAuthService();

      const pending = service.loginWithPopup({ state: 'state_ok' });
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'DISCORD_AUTH_ERROR', error: 'access_denied' }
        })
      );

      await expect(pending).rejects.toMatchObject({ code: 'OAUTH_DENIED' });
      expectNoStoredSession();
    });

    it('rejects with AuthError(TIMEOUT) when nothing comes back', async () => {
      vi.stubGlobal('open', vi.fn().mockReturnValue(fakePopup()));
      const service = new DiscordAuthService();

      await expect(service.loginWithPopup({ timeoutMs: 30 })).rejects.toMatchObject({ code: 'TIMEOUT' });
      expectNoStoredSession();
    });
  });

  // ==========================================================================
  // 8. Desktop Deep-Link Login Flow (wireon://auth/callback)
  // ==========================================================================
  describe('Desktop Deep-Link Login Flow', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_DISCORD_CLIENT_ID', TEST_CLIENT_ID);
    });

    function stubBridge() {
      const handlers: Array<(url: string) => void> = [];
      const openExternal = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('electronAPI', {
        onDeepLink: (cb: (url: string) => void) => {
          handlers.push(cb);
          return () => {
            const index = handlers.indexOf(cb);
            if (index >= 0) handlers.splice(index, 1);
          };
        },
        openExternal
      });
      return { handlers, openExternal };
    }

    it('routes login() to the deep-link flow inside Electron', async () => {
      // The setup mock exposes onDeepLink but no openExternal yet (main process work pending).
      const service = new DiscordAuthService();
      await expect(service.login()).rejects.toMatchObject({ code: 'DEEP_LINK_UNAVAILABLE' });
      expectNoStoredSession();
    });

    it('открывает согласие в системном браузере и доводит вход до токена', async () => {
      const { handlers, openExternal } = stubBridge();
      vi.stubGlobal('fetch', mockProfileFetch());
      const service = new DiscordAuthService();

      const pending = service.login({ state: 'deep_state' });
      // Выбор способа входа на ПК спрашивает у главного процесса, кому
      // принадлежит схема, — до открытия браузера успевает пройти несколько
      // микрозадач, а не одна.
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));

      const authUrl = String(openExternal.mock.calls[0][0]);
      const redirectUri = appSchemeRedirectUri(TEST_CLIENT_ID);
      expect(authUrl).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
      expect(authUrl).toContain('state=deep_state');
      // Поток по коду с PKCE — иначе Discord собственную схему не примет.
      expect(authUrl).toContain('response_type=code');
      expect(authUrl).toContain('code_challenge_method=S256');

      const exchange = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'deep_token', expires_in: 3600 })
      });
      const profile = mockProfileFetch();
      vi.stubGlobal('fetch', (...args: unknown[]) =>
        String(args[0]).includes('/oauth2/token') ? exchange() : (profile as unknown as typeof fetch)(...(args as [never]))
      );

      handlers.forEach((cb) => cb(`${redirectUri}?code=deep_code&state=deep_state`));

      const session = await pending;
      expect(session.token).toBe('deep_token');
      expect(getStoredSession().token).toBe('deep_token');
      expect(exchange).toHaveBeenCalledTimes(1);
    });

    it('rejects a deep link whose state does not match and writes nothing', async () => {
      const { handlers } = stubBridge();
      vi.stubGlobal('fetch', mockProfileFetch());
      const service = new DiscordAuthService();

      const pending = service.loginWithDeepLink({ state: 'deep_state' });
      await Promise.resolve();

      handlers.forEach((cb) => cb('wireon://auth/callback#access_token=forged&state=other_state'));

      await expect(pending).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
      expectNoStoredSession();
    });

    it('rejects when the system browser cannot be opened', async () => {
      const handlers: Array<(url: string) => void> = [];
      vi.stubGlobal('electronAPI', {
        onDeepLink: (cb: (url: string) => void) => {
          handlers.push(cb);
          return () => undefined;
        },
        openExternal: vi.fn().mockRejectedValue(new Error('shell.openExternal failed'))
      });
      const service = new DiscordAuthService();

      await expect(service.loginWithDeepLink()).rejects.toMatchObject({ code: 'DEEP_LINK_UNAVAILABLE' });
      expectNoStoredSession();
    });
  });

  // ==========================================================================
  // 8b. Выбор способа входа на ПК: браузер человека против окна приложения
  // ==========================================================================
  describe('Desktop login: system browser first, app window as the fallback', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_DISCORD_CLIENT_ID', TEST_CLIENT_ID);
    });

    /**
     * Полный десктопный мост: и браузер, и окно. Именно на нём видно, что
     * выбирается, — а раньше окно выигрывало всегда, потому что проверялось
     * первым.
     */
    function stubDesktop(options: { deepLinkReady: boolean; windowResult?: unknown }) {
      const handlers: Array<(url: string) => void> = [];
      const openExternal = vi.fn().mockResolvedValue(undefined);
      const discordLogin = vi.fn().mockResolvedValue(
        options.windowResult ?? {
          ok: true,
          url: 'wireon://auth/callback#access_token=window_token&token_type=Bearer&expires_in=3600&state=pick_state'
        }
      );
      vi.stubGlobal('electronAPI', {
        onDeepLink: (cb: (url: string) => void) => {
          handlers.push(cb);
          return () => {
            const index = handlers.indexOf(cb);
            if (index >= 0) handlers.splice(index, 1);
          };
        },
        openExternal,
        discordLogin,
        discordDeepLinkReady: vi.fn().mockResolvedValue(options.deepLinkReady)
      });
      return { handlers, openExternal, discordLogin };
    }

    it('идёт в системный браузер, когда схема wireon:// принадлежит приложению', async () => {
      const { handlers, openExternal, discordLogin } = stubDesktop({ deepLinkReady: true });
      vi.stubGlobal('fetch', mockProfileFetch());
      const service = new DiscordAuthService();

      const pending = service.login({ state: 'pick_state' });
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
      expect(discordLogin).not.toHaveBeenCalled();

      handlers.forEach((cb) =>
        cb('wireon://auth/callback#access_token=browser_token&token_type=Bearer&expires_in=3600&state=pick_state')
      );

      await expect(pending).resolves.toMatchObject({ token: 'browser_token' });
    });

    it('открывает окно приложения, когда схема не наша: иначе ответ ушёл бы в никуда', async () => {
      const { openExternal, discordLogin } = stubDesktop({ deepLinkReady: false });
      vi.stubGlobal('fetch', mockProfileFetch());
      const service = new DiscordAuthService();

      await expect(service.login({ state: 'pick_state' })).resolves.toMatchObject({
        token: 'window_token'
      });
      expect(discordLogin).toHaveBeenCalledTimes(1);
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('переходит на окно, если из браузера так ничего и не вернулось', async () => {
      const { openExternal, discordLogin } = stubDesktop({ deepLinkReady: true });
      vi.stubGlobal('fetch', mockProfileFetch());
      const service = new DiscordAuthService();

      // Ответ не приходит вовсе — ровно то, что видит человек, закрывший вкладку
      // согласия или отказавшийся открыть приложение.
      await expect(service.login({ state: 'pick_state', timeoutMs: 5 })).resolves.toMatchObject({
        token: 'window_token'
      });
      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(discordLogin).toHaveBeenCalledTimes(1);
    });

    it('не переспрашивает окном, когда человек отказал в браузере', async () => {
      const { handlers, discordLogin } = stubDesktop({ deepLinkReady: true });
      const service = new DiscordAuthService();

      const pending = service.login({ state: 'pick_state' });
      await vi.waitFor(() => expect(handlers.length).toBe(1));
      handlers.forEach((cb) => cb('wireon://auth/callback?error=access_denied&state=pick_state'));

      await expect(pending).rejects.toMatchObject({ code: 'OAUTH_DENIED' });
      expect(discordLogin).not.toHaveBeenCalled();
      expectNoStoredSession();
    });

    it('willUseSystemBrowser отвечает «нет» старому мосту без проверки схемы', async () => {
      vi.stubGlobal('electronAPI', {
        onDeepLink: () => () => undefined,
        openExternal: vi.fn(),
        discordLogin: vi.fn()
      });
      await expect(discordAuthModule.willUseSystemBrowser()).resolves.toBe(false);
      expect(discordAuthModule.hasAuthWindow()).toBe(true);
    });
  });

  // ==========================================================================
  // 9. Callback Handling & Session Validation
  // ==========================================================================
  describe('Callback Handling & Session Validation', () => {
    it('relays token AND state to the opener so CSRF can be verified', () => {
      const postMessage = vi.fn();
      vi.stubGlobal('opener', { postMessage });
      vi.stubGlobal('close', vi.fn());

      const result = discordAuthService.handleCallback(
        'http://localhost:3000/auth/callback#access_token=token_777&token_type=Bearer&expires_in=3600&state=state_777'
      );

      expect(result.success).toBe(true);
      expect(result.token).toBe('token_777');
      expect(result.state).toBe('state_777');
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DISCORD_AUTH_SUCCESS',
          token: 'token_777',
          state: 'state_777'
        }),
        window.location.origin
      );
    });

    it('reports STATE_MISMATCH when an expected state is supplied and differs', () => {
      const result = discordAuthService.handleCallback(
        'wireon://auth/callback#access_token=token_777&state=wrong',
        'right'
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe('STATE_MISMATCH');
      expect(result.token).toBeUndefined();
    });

    it('handles an error callback and an unsupported code grant', () => {
      const denied = discordAuthService.handleCallback('wireon://auth/callback?error=invalid_request');
      expect(denied.success).toBe(false);
      expect(denied.error).toBe('invalid_request');
      expect(denied.code).toBe('OAUTH_DENIED');

      const codeGrant = discordAuthService.handleCallback('wireon://auth/callback?code=abc123&state=s');
      expect(codeGrant.success).toBe(false);
      expect(codeGrant.code).toBe('NO_TOKEN');
    });

    it('does nothing when the app was not loaded on the callback route', () => {
      expect(handleAuthCallbackPage()).toBe(false);
    });

    it('validateSession returns null and clears storage without a usable session', async () => {
      const service = new DiscordAuthService();
      expect(await service.validateSession()).toBeNull();

      saveStoredSession(profileOf('expired_user', 'U'), 'stale_token', -10);
      expect(await service.validateSession()).toBeNull();
      expectNoStoredSession();
    });

    it('validateSession refreshes the profile and clears the session on 401', async () => {
      const service = new DiscordAuthService();
      saveStoredSession(profileOf('valid_user', 'Old Name'), 'valid_token', 3600);

      vi.stubGlobal('fetch', mockProfileFetch());
      const refreshed = await service.validateSession();
      expect(refreshed?.username).toBe('Wireon Audiophile');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' }));
      expect(await service.validateSession()).toBeNull();
      expectNoStoredSession();
    });

    it('validateSession keeps the cached profile when the network is unavailable', async () => {
      const service = new DiscordAuthService();
      saveStoredSession(profileOf('offline_user', 'Offline User'), 'valid_token', 3600);

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
      const cached = await service.validateSession();

      expect(cached?.id).toBe('offline_user');
      expect(getStoredSession().token).toBe('valid_token');
    });

    it('logout clears the stored session', () => {
      const service = new DiscordAuthService();
      saveStoredSession(profileOf('user_x', 'X'), 'token_x', 3600);

      service.logout();
      expectNoStoredSession();
    });
  });
});

describe('Вход с телефона: формат Discord и PKCE', () => {
  /*
   * Ради чего эти проверки. Вход на Android не работал вовсе, и причина была в
   * коде, а не в настройках: приложение отдавало `wireon://auth/callback` — ту
   * же схему, что на ПК, — а Discord принимает от мобильных приложений
   * **только** схему вида `discord-{ID}`. Ответ был буквальный: «Redirect URI
   * 'wireon://auth/callback' is not supported by client», и прописывание этого
   * адреса в панели разработчика ничего не меняло.
   *
   * Вторая половина требования — PKCE: для custom-схемы он обязателен, а с
   * неявным потоком не сочетается. Значит поток по коду.
   */

  it('адрес возврата собирается в формате, который требует Discord', async () => {
    const { appSchemeRedirectUri } = await import('../../src/services/discordAuth');
    expect(appSchemeRedirectUri('1539037027633332234')).toBe(
      'discord-1539037027633332234:/authorize/callback'
    );
  });

  it('возврат по схеме приложения опознаётся как свой', async () => {
    const { isAuthCallbackUrl } = await import('../../src/services/discordAuth');
    expect(isAuthCallbackUrl('discord-1539037027633332234:/authorize/callback?code=abc')).toBe(true);
    // Настольная схема продолжает работать: ПК ничего не менял.
    expect(isAuthCallbackUrl('wireon://auth/callback#access_token=x')).toBe(true);
    expect(isAuthCallbackUrl('https://example.com/other')).toBe(false);
  });

  it('PKCE даёт отпечаток, по которому нельзя восстановить секрет', async () => {
    const { createPkcePair } = await import('../../src/services/discordAuth');
    const pair = await createPkcePair();

    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).not.toBe(pair.verifier);
    // Base64url: без `+`, `/` и выравнивания — так требует RFC 7636, и Discord
    // отклоняет отпечаток в обычном base64.
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);

    const again = await createPkcePair();
    expect(again.verifier).not.toBe(pair.verifier);
  });

  it('отпечаток попадает в адрес согласия только когда его просили', async () => {
    const { generateOAuthUrl } = await import('../../src/services/discordAuth');

    const withPkce = generateOAuthUrl({
      clientId: '123',
      redirectUri: 'discord-123:/authorize/callback',
      responseType: 'code',
      codeChallenge: 'CHALLENGE'
    });
    const params = new URL(withPkce.url).searchParams;
    expect(params.get('code_challenge')).toBe('CHALLENGE');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('response_type')).toBe('code');

    // На ПК поток неявный, и лишние параметры Discord бы не принял.
    const plain = generateOAuthUrl({ clientId: '123', redirectUri: 'wireon://auth/callback' });
    expect(new URL(plain.url).searchParams.get('code_challenge')).toBeNull();
  });

  it('код авторизации не путается с кодом отказа', async () => {
    /*
     * В `CallbackResult` поле `code` занято кодом ошибки. Пока код авторизации
     * возвращался в нём же, обмен получал строку вроде `NO_TOKEN` и всегда
     * проваливался — причём молча, потому что Discord отвечает на такое обычным
     * отказом.
     */
    const { discordAuthService } = await import('../../src/services/discordAuth');
    const result = discordAuthService.handleCallback(
      'discord-123:/authorize/callback?code=REAL_CODE&state=S',
      'S'
    );

    expect(result.authCode).toBe('REAL_CODE');
    expect(result.token).toBeUndefined();
  });

  it('обмен кода идёт без секрета приложения', async () => {
    // Публичный клиент подтверждает себя `code_verifier`, а не секретом: секрет
    // в сборке, которую можно распаковать, ничего не защищает.
    const { exchangeCodeForToken } = await import('../../src/services/discordAuth');
    let sentBody = '';
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? '');
      return {
        ok: true,
        json: async () => ({ access_token: 'TOKEN', expires_in: 604800 })
      } as Response;
    }) as unknown as typeof fetch;

    const out = await exchangeCodeForToken('CODE', '123', 'discord-123:/authorize/callback', 'VERIFIER', fakeFetch);

    expect(out.token).toBe('TOKEN');
    const sent = new URLSearchParams(sentBody);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code_verifier')).toBe('VERIFIER');
    expect(sent.get('client_secret')).toBeNull();
  });

  it('отказ обмена доносит ответ Discord, а не «что-то пошло не так»', async () => {
    // Текст Discord — единственное, что отличает «код просрочен» от «адрес
    // возврата не тот».
    const { exchangeCodeForToken } = await import('../../src/services/discordAuth');
    const fakeFetch = (async () =>
      ({ ok: false, status: 400, text: async () => 'invalid_grant' }) as Response) as unknown as typeof fetch;

    await expect(
      exchangeCodeForToken('CODE', '123', 'discord-123:/authorize/callback', 'V', fakeFetch)
    ).rejects.toThrow(/invalid_grant/);
  });
});

describe('Вход с телефона: что именно уходит в Discord', () => {
  /*
   * Проверка на стыке, а не на кусочках. Отдельно `appSchemeRedirectUri` и
   * `createPkcePair` уже проверены выше, но поломка была ровно в том, что
   * телефон **не пользовался** ни тем, ни другим: он шёл общим путём с ПК.
   * Здесь ловится именно это.
   */
  it('адрес согласия собирается по мобильным правилам и код меняется на токен', async () => {
    const auth = await import('../../src/services/discordAuth');

    let openedUrl = '';
    let onDeepLink: ((url: string) => void) | null = null;
    const bridge = {
      openExternal: async (url: string) => {
        openedUrl = url;
      },
      onDeepLink: (cb: (url: string) => void) => {
        onDeepLink = cb;
        return () => {};
      }
    };

    // Обмен кода уходит в сеть — подменяем на месте, чтобы проверка не зависела
    // от Discord.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'TOKEN_FROM_EXCHANGE', expires_in: 604800 })
    } as Response);

    const pkce = await auth.createPkcePair();
    const redirectUri = auth.appSchemeRedirectUri('1539037027633332234');

    const promise = auth.discordAuthService.loginWithDeepLink(
      {
        clientId: '1539037027633332234',
        redirectUri,
        responseType: 'code',
        codeChallenge: pkce.challenge
      },
      bridge as never,
      pkce.verifier
    );

    // Даём мосту открыть адрес и подписаться.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const params = new URL(openedUrl).searchParams;
    expect(params.get('redirect_uri')).toBe('discord-1539037027633332234:/authorize/callback');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('code_challenge_method')).toBe('S256');

    // Discord возвращается по своей схеме с кодом — приложение обязано обменять
    // его на токен, а не сдаться с «нет токена».
    const state = params.get('state');
    onDeepLink!(`${redirectUri}?code=REAL_CODE&state=${state}`);

    await expect(promise).resolves.toMatchObject({ token: 'TOKEN_FROM_EXCHANGE' });
    fetchSpy.mockRestore();
  });

  it('телефонный вход сам выбирает мобильные правила, а не общие с ПК', async () => {
    /*
     * Ровно место поломки. Прежде `loginWithCapacitor` просто звал общий путь,
     * и телефон уходил в Discord с настольной схемой `wireon://` и неявным
     * потоком. Проверка выше этого не поймала бы: там правила передавались
     * руками. Здесь смотрим, что решает сам вход.
     */
    const auth = await import('../../src/services/discordAuth');

    vi.doMock('../../src/services/capacitorAuthBridge', () => ({
      createCapacitorAuthBridge: async () => ({
        openExternal: async () => {},
        onDeepLink: () => () => {}
      })
    }));

    const captured: { options?: Record<string, unknown> } = {};
    let verifier: string | undefined;
    const spy = vi
      .spyOn(auth.discordAuthService, 'loginWithDeepLink')
      .mockImplementation(async (options, _bridge, codeVerifier) => {
        captured.options = options as Record<string, unknown>;
        verifier = codeVerifier;
        return { token: 'x', expiresIn: 1 } as never;
      });

    await auth.discordAuthService.loginWithCapacitor({ clientId: '1539037027633332234' });

    expect(captured.options).toMatchObject({
      redirectUri: 'discord-1539037027633332234:/authorize/callback',
      responseType: 'code'
    });
    expect(String(captured.options?.codeChallenge ?? '')).not.toBe('');
    // Секрет PKCE обязан дойти до обмена: без него код бесполезен.
    expect(verifier).toBeTruthy();
    expect(verifier).not.toBe(captured.options?.codeChallenge);

    spy.mockRestore();
    vi.doUnmock('../../src/services/capacitorAuthBridge');
  });
});
