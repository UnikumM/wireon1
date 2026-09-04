import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import { SESSION_EXPIRED_MESSAGE, useAuthStore } from '../../src/store/useAuthStore';
import { useUIStore } from '../../src/store/useUIStore';
import {
  STORAGE_KEY_AUTH_TOKEN,
  STORAGE_KEY_AUTH_USER,
  STORAGE_KEY_TOKEN_EXPIRES,
  saveStoredSession
} from '../../src/services/discordAuth';
import { UserProfile } from '../../src/types/music';
import { cloudSyncEngine } from '../../src/services/cloudSync';
import { createWireonRemote } from '../../src/services/wireonRemote';
import { DiscordUserRaw } from '../../src/types/auth';

// Настоящий адаптер читает адрес сервера из окружения, а в прогоне оно пусто
// нарочно (vitest.config.ts): с настоящими адресом и токеном проверки ходили бы
// в рабочий сервер. Здесь подменяется только он.
vi.mock('../../src/services/wireonRemote', () => ({
  createWireonRemote: vi.fn(() => null)
}));

const mockDiscordUser: UserProfile = {
  id: '123456789012345678',
  username: 'CyberAstronaut',
  discriminator: '0001',
  avatarUrl: 'https://cdn.discordapp.com/avatars/123456789012345678/abc.png',
  provider: 'discord',
  status: 'online',
  email: 'cyber@example.com'
};

const rawDiscordUser: DiscordUserRaw = {
  id: '123456789012345678',
  username: 'CyberAstronaut',
  discriminator: '0001',
  avatar: 'abc',
  email: 'cyber@example.com'
};

/** Discord's `GET /users/@me`, so `restoreSession` never hits the network. */
function stubProfileFetch() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => rawDiscordUser });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Самосверка заводится при входе', () => {
  /*
   * Здесь жила беда «синхронизация работает хз когда».
   *
   * Удалённая сторона считает себя настроенной только когда токен Discord уже
   * лежит в сторе — она читает его оттуда. А состояние ставилось **после**
   * подключения, и в тот миг токена ещё не было: `startPeriodicSync` честно
   * отказывался заводиться со словами «сервер не настроен», и самосверка не
   * запускалась ни разу. Работало только то, что вызывается вручную и позже:
   * кнопка «Проверить» и один заход сразу после входа.
   */
  const remote = {
    id: 'wireon',
    isConfigured: () => Boolean(useAuthStore.getState().token),
    pushPlaylists: vi.fn(async () => 0),
    pullPlaylists: vi.fn(async () => []),
    pushFavorites: vi.fn(async () => 0),
    pullFavorites: vi.fn(async () => []),
    deletePlaylist: vi.fn(async () => true),
    deleteFavorite: vi.fn(async () => true)
  };

  beforeEach(() => {
    vi.mocked(createWireonRemote).mockReturnValue(remote as never);
  });

  afterEach(() => {
    cloudSyncEngine.stopPeriodicSync();
    vi.mocked(createWireonRemote).mockReturnValue(null as never);
  });

  it('к моменту подключения токен уже в сторе', () => {
    const started = vi.spyOn(cloudSyncEngine, 'startPeriodicSync');

    useAuthStore.getState().login(mockDiscordUser, 'mock_token_xyz', 3600);

    expect(started).toHaveBeenCalled();
    // Именно значение важно: `false` означает «не завелась».
    expect(started.mock.results[0].value).toBe(true);
    expect(cloudSyncEngine.isRemoteConfigured()).toBe(true);
  });

  it('на сервере без ожидания цикл не долбится, а уходит на расписание', async () => {
    /*
     * Сборка у людей обновляется раньше сервера, и это обычное дело. Важен
     * именно код: у сервера зарегистрирован общий маршрут под предзапросы
     * (`OPTIONS /{tail:.*}`), поэтому неизвестный путь **находится** и
     * отвергается по методу — проверено на живом сервере до обновления, он
     * ответил 405, а не 404. С проверкой только на 404 цикл бился бы в стену
     * вечно, с растущей паузой, но без конца.
     */
    const { getSyncChannel } = await import('../../src/store/useAuthStore');
    const waitForChange = vi.fn(async () => {
      throw new Error('HTTP_405: сервер ответил 405');
    });
    vi.mocked(createWireonRemote).mockReturnValue({ ...remote, waitForChange } as never);

    useAuthStore.getState().login(mockDiscordUser, 'mock_token_xyz', 3600);

    await vi.waitFor(() => expect(getSyncChannel()).toBe('schedule'));
    expect(waitForChange).toHaveBeenCalledTimes(1);
  });

  it('после выхода самосверка останавливается', () => {
    useAuthStore.getState().login(mockDiscordUser, 'mock_token_xyz', 3600);
    const stopped = vi.spyOn(cloudSyncEngine, 'stopPeriodicSync');

    useAuthStore.getState().logout();

    expect(stopped).toHaveBeenCalled();
    expect(cloudSyncEngine.isRemoteConfigured()).toBe(false);
  });
});

describe('Auth Store (useAuthStore)', () => {
  beforeEach(() => {
    localStorage.clear();
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
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('handles Discord login and sets authenticated status', () => {
    useAuthStore.getState().login(mockDiscordUser, 'mock_token_xyz', 3600);

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.isGuest).toBe(false);
    expect(state.authStatus).toBe('authenticated');
    expect(state.user?.username).toBe('CyberAstronaut');
    expect(state.token).toBe('mock_token_xyz');
    expect(state.user?.accessToken).toBe('mock_token_xyz');
    expect(state.user?.expiresAt).toBeGreaterThan(Date.now());

    // discordAuth owns the storage keys; the store only asks it to persist.
    expect(localStorage.getItem(STORAGE_KEY_AUTH_TOKEN)).toBe('mock_token_xyz');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_AUTH_USER) || 'null').id).toBe(mockDiscordUser.id);
    expect(Number(localStorage.getItem(STORAGE_KEY_TOKEN_EXPIRES))).toBeGreaterThan(Date.now());
  });

  /**
   * Самосверка заводится входом, а не запуском приложения.
   *
   * Так это и сломалось: `App.tsx` звал `startPeriodicSync` один раз при
   * старте, когда сессия ещё не восстановлена и удалённой стороны нет. Движок
   * честно отказывался заводиться, после входа его никто не будил, и медиатека
   * уезжала на сервер только по нажатию «Проверить». Владелец описал это как
   * «синхронизация не работает»: она и правда не работала сама ни разу.
   */
  it('заводит самосверку при входе и останавливает при выходе', () => {
    const remote = new (class {
      id = 'test-remote';
      isConfigured() {
        return true;
      }
      async pullPlaylists() {
        return [];
      }
      async pullFavorites() {
        return [];
      }
      async pushPlaylists() {
        return 0;
      }
      async pushFavorites() {
        return 0;
      }
      async deletePlaylist() {
        return true;
      }
      async deleteFavorite() {
        return true;
      }
    })();
    vi.mocked(createWireonRemote).mockReturnValue(remote as never);

    const start = vi.spyOn(cloudSyncEngine, 'startPeriodicSync').mockReturnValue(true);
    const stop = vi.spyOn(cloudSyncEngine, 'stopPeriodicSync').mockImplementation(() => {});
    vi.spyOn(cloudSyncEngine, 'syncAll').mockResolvedValue({
      success: true,
      syncedPlaylists: 0,
      syncedFavorites: 0,
      localPlaylists: 0,
      localFavorites: 0,
      remoteConfigured: true,
      timestamp: Date.now()
    });

    useAuthStore.getState().login(mockDiscordUser, 'mock_token_xyz', 3600);
    expect(start).toHaveBeenCalledTimes(1);
    // Первый заход сразу: ждать минуту, чтобы увидеть свои плейлисты, — это
    // ровно то ожидание, ради которого человек и жал кнопку руками.
    expect(cloudSyncEngine.syncAll).toHaveBeenCalled();

    useAuthStore.getState().logout();
    expect(stop).toHaveBeenCalled();
  });

  it('handles logout and falls back to guest mode', () => {
    useAuthStore.getState().login(mockDiscordUser, 'mock_token_xyz');
    useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isGuest).toBe(true);
    expect(state.authStatus).toBe('guest');
    expect(state.token).toBeNull();
    expect(state.user?.provider).toBe('guest');
    expect(localStorage.length).toBe(0);
  });

  it('stays in guest mode without writing any storage key', () => {
    useAuthStore.getState().continueAsGuest();

    const state = useAuthStore.getState();
    expect(state.isGuest).toBe(true);
    expect(state.authStatus).toBe('guest');
    expect(state.user?.provider).toBe('guest');
    expect(localStorage.length).toBe(0);
  });

  it('restores authenticated session from localStorage', async () => {
    const fetchMock = stubProfileFetch();
    useAuthStore.getState().login(mockDiscordUser, 'mock_token_xyz', 3600);

    // Reset in-memory state
    useAuthStore.setState({
      user: null,
      token: null,
      isAuthenticated: false,
      isGuest: true,
      authStatus: 'idle'
    });

    await useAuthStore.getState().restoreSession();
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.user?.id).toBe(mockDiscordUser.id);
    expect(state.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops an expired session on restore instead of resurrecting it', async () => {
    const fetchMock = stubProfileFetch();
    // A session whose wireon_auth_token_expires is already in the past.
    saveStoredSession(mockDiscordUser, 'expired_token', -60);
    expect(Number(localStorage.getItem(STORAGE_KEY_TOKEN_EXPIRES))).toBeLessThan(Date.now());

    await useAuthStore.getState().restoreSession();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isGuest).toBe(true);
    expect(state.authStatus).toBe('guest');
    expect(state.token).toBeNull();
    expect(state.user?.provider).toBe('guest');
    expect(state.error).toMatch(/истекла/i);
    expect(localStorage.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to guest when Discord rejects the stored token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' }));
    saveStoredSession(mockDiscordUser, 'revoked_token', 3600);

    await useAuthStore.getState().restoreSession();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isGuest).toBe(true);
    expect(state.error).toMatch(/больше не действительна/i);
    expect(localStorage.length).toBe(0);
  });

  it('keeps a valid session when the profile refresh fails offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    saveStoredSession(mockDiscordUser, 'valid_token', 3600);

    await useAuthStore.getState().restoreSession();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.user?.id).toBe(mockDiscordUser.id);
    expect(localStorage.getItem(STORAGE_KEY_AUTH_TOKEN)).toBe('valid_token');
  });

  it('restores into guest mode when nothing is stored', async () => {
    const fetchMock = stubProfileFetch();

    await useAuthStore.getState().restoreSession();

    const state = useAuthStore.getState();
    expect(state.isGuest).toBe(true);
    expect(state.authStatus).toBe('guest');
    expect(state.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('checkSessionExpiry', () => {
    it('keeps a healthy session and reports nothing changed', () => {
      useAuthStore.getState().login(mockDiscordUser, 'fresh_token', 3600);

      expect(useAuthStore.getState().checkSessionExpiry()).toBe(false);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().error).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY_AUTH_TOKEN)).toBe('fresh_token');
    });

    it('drops to guest with a readable message once the token expires mid-session', () => {
      useAuthStore.getState().login(mockDiscordUser, 'soon_stale_token', 3600);
      // The window stayed open past the TTL: only storage knows, memory still says "signed in".
      saveStoredSession(mockDiscordUser, 'soon_stale_token', -1);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);

      expect(useAuthStore.getState().checkSessionExpiry()).toBe(true);

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isGuest).toBe(true);
      expect(state.authStatus).toBe('guest');
      expect(state.token).toBeNull();
      expect(state.user?.provider).toBe('guest');
      expect(state.error).toBe(SESSION_EXPIRED_MESSAGE);
      expect(localStorage.length).toBe(0);
    });

    it('drops to guest when the stored session vanished from under it', () => {
      useAuthStore.getState().login(mockDiscordUser, 'token_to_wipe', 3600);
      // Another tab signed out, or the user cleared site data.
      localStorage.clear();

      expect(useAuthStore.getState().checkSessionExpiry()).toBe(true);
      expect(useAuthStore.getState().isGuest).toBe(true);
      expect(useAuthStore.getState().error).toBe(SESSION_EXPIRED_MESSAGE);
    });

    it('says nothing while already in guest mode', () => {
      useAuthStore.getState().continueAsGuest();

      expect(useAuthStore.getState().checkSessionExpiry()).toBe(false);
      expect(useAuthStore.getState().error).toBeNull();
    });

    it('is idempotent: a second check does not re-report the same expiry', () => {
      useAuthStore.getState().login(mockDiscordUser, 'stale_token', 3600);
      saveStoredSession(mockDiscordUser, 'stale_token', -1);

      expect(useAuthStore.getState().checkSessionExpiry()).toBe(true);
      expect(useAuthStore.getState().checkSessionExpiry()).toBe(false);
    });
  });
});

describe('UI Store (useUIStore)', () => {
  beforeEach(() => {
    useUIStore.setState({
      activeView: 'search',
      activePlaylistId: null,
      isQueueOpen: false,
      isFullscreenPlayerOpen: false,
      searchQuery: '',
      searchFilter: 'all',
      toastMessage: null
    });
  });

  it('switches active views and active playlists', () => {
    useUIStore.getState().setActiveView('library');
    expect(useUIStore.getState().activeView).toBe('library');

    useUIStore.getState().setActivePlaylistId('pl_123');
    expect(useUIStore.getState().activePlaylistId).toBe('pl_123');
  });

  it('toggles queue drawer and fullscreen player', () => {
    expect(useUIStore.getState().isQueueOpen).toBe(false);

    useUIStore.getState().toggleQueue();
    expect(useUIStore.getState().isQueueOpen).toBe(true);

    useUIStore.getState().toggleFullscreenPlayer();
    expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);
  });

  it('manages search query and search filters', () => {
    useUIStore.getState().setSearchQuery('Daft Punk');
    expect(useUIStore.getState().searchQuery).toBe('Daft Punk');

    useUIStore.getState().setSearchFilter('soundcloud');
    expect(useUIStore.getState().searchFilter).toBe('soundcloud');
  });

  it('shows and clears toast notifications', () => {
    useUIStore.getState().showToast('Added to queue!', 'success');
    expect(useUIStore.getState().toastMessage?.text).toBe('Added to queue!');
    expect(useUIStore.getState().toastMessage?.type).toBe('success');

    useUIStore.getState().clearToast();
    expect(useUIStore.getState().toastMessage).toBeNull();
  });
});
