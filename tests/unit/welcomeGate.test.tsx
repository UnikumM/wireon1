import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import '../setup';

import {
  STORAGE_KEY_INTRO_SEEN,
  WelcomeGate,
  hasSeenAuthIntro,
  markAuthIntroSeen
} from '../../src/components/auth/WelcomeGate';
import { SESSION_CHECK_INTERVAL_MS, useSessionWatch } from '../../src/hooks/useSessionWatch';
import { saveStoredSession } from '../../src/services/discordAuth';
import { SESSION_EXPIRED_MESSAGE, useAuthStore } from '../../src/store/useAuthStore';
import { useUIStore } from '../../src/store/useUIStore';
import { UserProfile } from '../../src/types/music';

/**
 * The first-run screen and the session watchdog — the two halves of "аккаунт не
 * работает": one makes signing in a real, visible choice, the other notices when
 * a stored session quietly stopped being valid.
 */

/** Switchable build configuration + a stand-in for the OAuth round-trip. */
const authState = vi.hoisted(() => ({
  configured: true,
  login: null as null | (() => Promise<{ user: unknown; token: string }>)
}));

// Only the two boundaries are replaced: the client-id check (there is a built-in
// application id, so a "not configured" build cannot be simulated through env)
// and `login()`, which would otherwise open a real consent window. Session
// storage stays real — the store under test writes through it.
vi.mock('../../src/services/discordAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/discordAuth')>();
  return {
    ...actual,
    isDiscordConfigured: () => authState.configured,
    discordAuthService: {
      login: () => (authState.login ? authState.login() : Promise.reject(new Error('login not stubbed'))),
      logout: () => {},
      forgetSession: async () => {}
    }
  };
});

const discordUser: UserProfile = {
  id: '424242424242424242',
  username: 'НочнойСлушатель',
  discriminator: '0',
  avatarUrl: 'https://cdn.discordapp.com/avatars/424242424242424242/xyz.png',
  provider: 'discord',
  status: 'online',
  email: 'listener@example.com'
};

function resetAuthStore() {
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

function toast() {
  return useUIStore.getState().toastMessage;
}

/** `useSessionWatch` is a hook, so it needs something mounted to live in. */
function SessionWatchHost() {
  useSessionWatch();
  return <div data-testid="session-watch-host" />;
}

describe('WelcomeGate (first-run account choice)', () => {
  beforeEach(() => {
    localStorage.clear();
    authState.configured = true;
    authState.login = null;
    resetAuthStore();
    useUIStore.setState({ toastMessage: null });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('greets a first launch and says plainly that Discord is the registration', () => {
    render(<WelcomeGate />);

    const gate = screen.getByTestId('welcome-gate');
    expect(gate).toBeInTheDocument();
    expect(gate).toHaveAttribute('role', 'dialog');
    expect(gate).toHaveAttribute('aria-modal', 'true');
    // Заголовок — вопрос, ради которого экран показан, а не название приложения:
    // человек уже запустил Wireon Sounds и знает, как оно называется.
    expect(screen.getByRole('heading', { name: 'Войти через Discord?' })).toBeInTheDocument();
    expect(screen.getByText(/это и есть регистрация/i)).toBeInTheDocument();

    // Both ways in are open, and neither is a dead end.
    expect(screen.getByTestId('welcome-gate-login')).toBeEnabled();
    expect(screen.getByTestId('welcome-gate-guest')).toBeEnabled();

    // The promises are the ones the app actually keeps.
    expect(screen.getByText(/совместном прослушивании/i)).toBeInTheDocument();
    expect(screen.getByText(/после перезапуска/i)).toBeInTheDocument();
    // Раньше здесь обещали, что медиатека никуда не уезжает: сервера тогда не
    // было. Теперь есть, и обещание сменилось на то, что приложение правда
    // делает, — плейлисты живут на всех устройствах, но только с аккаунтом.
    expect(screen.getByText(/на всех устройствах/i)).toBeInTheDocument();
    expect(screen.getByText(/Без аккаунта сохранять некуда/i)).toBeInTheDocument();
    expect(screen.getByTestId('welcome-gate-scopes')).toHaveTextContent(/имя, аватар и e-mail/i);
  });

  it('stays reachable on a screen too short for it', () => {
    render(<WelcomeGate />);

    const gate = screen.getByTestId('welcome-gate');
    const card = screen.getByRole('heading', { name: 'Войти через Discord?' }).closest('.panel-raised');

    // На 360×640 карточка выше экрана. Отцентрованный флекс-элемент вылезает в
    // обе стороны, и верх при прокрутке недостижим — так пропадал заголовок.
    // Прокрутка плюс `margin: auto` центрируют так же, пока место есть, и
    // отдают верх, когда его нет.
    expect(gate).toHaveStyle({ overflowY: 'auto' });
    expect(gate.style.alignItems).toBe('');
    expect(card).toHaveStyle({ margin: 'auto' });

    // Карточка накрывает экран целиком (viewport-fit=cover), поэтому её край
    // обязан отступать от часов и от полосы жеста, а не только от края окна.
    expect(gate.style.padding).toContain('--safe-top');
    expect(gate.style.padding).toContain('--safe-bottom');
  });

  it('never shows again once the choice was recorded', () => {
    markAuthIntroSeen();
    expect(localStorage.getItem(STORAGE_KEY_INTRO_SEEN)).toBe('1');
    expect(hasSeenAuthIntro()).toBe(true);

    render(<WelcomeGate />);
    expect(screen.queryByTestId('welcome-gate')).not.toBeInTheDocument();
  });

  it('stays out of the way when a session was restored from storage', () => {
    useAuthStore.setState({ isAuthenticated: true, isGuest: false, authStatus: 'authenticated', user: discordUser });

    render(<WelcomeGate />);

    expect(screen.queryByTestId('welcome-gate')).not.toBeInTheDocument();
    // And it remembers, so it does not ambush the user after a later sign-out.
    expect(localStorage.getItem(STORAGE_KEY_INTRO_SEEN)).toBe('1');
  });

  it('does not flash over a sign-in that is already in flight', () => {
    useAuthStore.setState({ authStatus: 'authenticating' });

    render(<WelcomeGate />);
    expect(screen.queryByTestId('welcome-gate')).not.toBeInTheDocument();
  });

  it('lets the user continue without an account and says so', () => {
    render(<WelcomeGate />);

    fireEvent.click(screen.getByTestId('welcome-gate-guest'));

    expect(screen.queryByTestId('welcome-gate')).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY_INTRO_SEEN)).toBe('1');

    const state = useAuthStore.getState();
    expect(state.isGuest).toBe(true);
    expect(state.authStatus).toBe('guest');
    expect(state.user?.provider).toBe('guest');
    expect(state.isAuthenticated).toBe(false);

    expect(toast()?.text).toMatch(/без аккаунта/i);
    expect(toast()?.type).toBe('info');
    // Guest mode is not a session: nothing but the "seen" flag may be written.
    expect(localStorage.length).toBe(1);
  });

  it('signs in through Discord and closes for good', async () => {
    authState.login = async () => ({ user: discordUser, token: 'live_token_xyz' });

    render(<WelcomeGate />);
    fireEvent.click(screen.getByTestId('welcome-gate-login'));

    await waitFor(() => {
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });

    expect(useAuthStore.getState().user?.username).toBe('НочнойСлушатель');
    expect(screen.queryByTestId('welcome-gate')).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY_INTRO_SEEN)).toBe('1');
    expect(toast()?.text).toContain('НочнойСлушатель');
    expect(toast()?.type).toBe('success');
  });

  it('reports a failed sign-in instead of pretending it worked', async () => {
    authState.login = async () => {
      throw new Error('Окно входа закрыли');
    };

    render(<WelcomeGate />);
    fireEvent.click(screen.getByTestId('welcome-gate-login'));

    await waitFor(() => {
      expect(screen.getByTestId('discord-login-notice')).toBeInTheDocument();
    });

    // The gate is still there: the user has not chosen anything yet.
    expect(screen.getByTestId('welcome-gate')).toBeInTheDocument();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY_INTRO_SEEN)).toBeNull();
  });

  it('admits when the build has no Discord client id rather than offering a dead button', () => {
    authState.configured = false;

    render(<WelcomeGate />);

    expect(screen.getByTestId('welcome-gate-scopes')).toHaveTextContent(/не настроен/i);
    expect(screen.getByTestId('welcome-gate-login')).toBeDisabled();
    // Guest mode is still a real way in.
    expect(screen.getByTestId('welcome-gate-guest')).toBeEnabled();
  });

  it('does not block the app when localStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });

    // Unreadable storage means "assume the choice was made" — better a missed
    // greeting than a screen that returns on every single launch.
    expect(hasSeenAuthIntro()).toBe(true);
    expect(() => markAuthIntroSeen()).not.toThrow();

    render(<WelcomeGate />);
    expect(screen.queryByTestId('welcome-gate')).not.toBeInTheDocument();
  });
});

describe('useSessionWatch (expiry noticed while the window is open)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAuthStore();
    useUIStore.setState({ toastMessage: null });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('does nothing for a guest', () => {
    render(<SessionWatchHost />);

    expect(useAuthStore.getState().isGuest).toBe(true);
    expect(toast()).toBeNull();
  });

  it('leaves a healthy session alone', () => {
    useAuthStore.getState().login(discordUser, 'fresh_token', 3600);

    render(<SessionWatchHost />);

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(toast()).toBeNull();
  });

  it('catches a session that expires while the app is open', () => {
    vi.useFakeTimers();
    useAuthStore.getState().login(discordUser, 'stale_token', 3600);

    render(<SessionWatchHost />);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    // Only storage knows the token aged out; memory still says "signed in".
    saveStoredSession(discordUser, 'stale_token', -1);

    act(() => {
      vi.advanceTimersByTime(SESSION_CHECK_INTERVAL_MS);
    });

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isGuest).toBe(true);
    expect(state.error).toBe(SESSION_EXPIRED_MESSAGE);
    expect(toast()?.text).toBe(SESSION_EXPIRED_MESSAGE);
    expect(toast()?.type).toBe('info');
  });

  it('re-checks the moment the window comes back into focus', () => {
    useAuthStore.getState().login(discordUser, 'napping_token', 3600);
    render(<SessionWatchHost />);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    // The machine slept: by the time the window is focused again the token is old.
    saveStoredSession(discordUser, 'napping_token', -1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(useAuthStore.getState().isGuest).toBe(true);
    expect(toast()?.text).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('re-checks when the tab becomes visible again', () => {
    useAuthStore.getState().login(discordUser, 'hidden_tab_token', 3600);
    render(<SessionWatchHost />);

    saveStoredSession(discordUser, 'hidden_tab_token', -1);

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(useAuthStore.getState().isGuest).toBe(true);
    expect(toast()?.text).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('stops checking once unmounted', () => {
    vi.useFakeTimers();
    useAuthStore.getState().login(discordUser, 'stale_token', 3600);
    const { unmount } = render(<SessionWatchHost />);

    unmount();
    saveStoredSession(discordUser, 'stale_token', -1);

    act(() => {
      vi.advanceTimersByTime(SESSION_CHECK_INTERVAL_MS * 3);
    });

    // Nobody is watching any more, so nothing was touched.
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(toast()).toBeNull();

    // …and no stray listener fires either.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});
