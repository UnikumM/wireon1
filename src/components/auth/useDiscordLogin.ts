import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuthSession,
  discordAuthService,
  hasAuthWindow,
  isDiscordConfigured,
  willUseSystemBrowser
} from '../../services/discordAuth';
import { useAuthStore } from '../../store/useAuthStore';
import { UserProfile } from '../../types/music';
import { AuthErrorNotice, DISCORD_CONFIG_HINT, describeAuthError } from './authErrors';

export interface UseDiscordLoginOptions {
  onSuccess?: (user: UserProfile) => void;
}

export interface UseDiscordLogin {
  /** Runs the real OAuth2 flow. Resolves true only when a session was stored. */
  startLogin: () => Promise<boolean>;
  /**
   * Forgets the Discord account the consent window remembers, then signs in — this
   * is what makes "log in as somebody else" actually show the account picker.
   */
  startLoginAsOtherAccount: () => Promise<boolean>;
  /**
   * Тот же вход, но в окне приложения вместо браузера.
   *
   * Нужен, когда браузер открылся, а обратно ничего не пришло: человек закрыл
   * вкладку, отказался от перехода в приложение, ушёл в другой браузер. Без
   * этой кнопки оставалось бы ждать две минуты до срока.
   */
  startLoginInAppWindow: () => Promise<boolean>;
  /** Есть ли в сборке окно входа, то есть стоит ли показывать запасной путь. */
  canUseAppWindow: boolean;
  /** Drops to guest mode without pretending anybody signed in. */
  continueAsGuest: () => void;
  isLoggingIn: boolean;
  /** The last failure, already turned into actionable copy. */
  notice: AuthErrorNotice | null;
  dismissNotice: () => void;
  isConfigured: boolean;
}

/**
 * The single owner of the sign-in flow for the auth components. There is no mock
 * fallback: if `login()` rejects, the store keeps `isAuthenticated: false` and the
 * caller renders `notice`.
 */
export function useDiscordLogin(options?: UseDiscordLoginOptions): UseDiscordLogin {
  const { onSuccess } = options ?? {};
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [notice, setNotice] = useState<AuthErrorNotice | null>(null);
  /**
   * Показывать ли запасной путь «войти в окне приложения».
   *
   * Только когда вход идёт через системный браузер: если он и так идёт окном,
   * предлагать то же самое второй раз незачем. Ответ приходит из главного
   * процесса, поэтому доезжает не сразу — до тех пор запасного пути нет.
   */
  const [canUseAppWindow, setCanUseAppWindow] = useState(false);
  const isMountedRef = useRef(true);
  /** Номер последней начатой попытки: ответы всех прежних отбрасываются. */
  const attemptRef = useRef(0);
  const isConfigured = isDiscordConfigured();

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hasAuthWindow()) return;
    let cancelled = false;
    void willUseSystemBrowser().then((viaBrowser) => {
      if (!cancelled && isMountedRef.current) setCanUseAppWindow(viaBrowser);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Общая половина всех входов: состояние кнопки, разбор отказа, запись сессии.
   *
   * Номер попытки нужен из-за запасного пути. Когда человек, не дождавшись
   * ответа из браузера, открывает окно входа, первая попытка никуда не
   * девается — она доживает до своего срока и отказывает. Без номера этот
   * запоздалый отказ стёр бы уже состоявшийся вход: «Не удалось войти» поверх
   * своего же аккаунта.
   */
  const runLogin = useCallback(
    async (flow: () => Promise<AuthSession>): Promise<boolean> => {
      if (!isDiscordConfigured()) {
        setNotice({
          title: 'Вход через Discord не настроен.',
          detail: `${DISCORD_CONFIG_HINT} Пока можно пользоваться Wireon Sounds без аккаунта.`,
          blocking: true,
          code: 'NOT_CONFIGURED'
        });
        return false;
      }

      const attempt = ++attemptRef.current;
      setIsLoggingIn(true);
      setNotice(null);

      try {
        const session = await flow();
        if (attempt !== attemptRef.current) return false;
        // `AuthSession` carries the TTL on the profile, not as a separate field.
        const expiresAt = session.user.expiresAt;
        const expiresInSeconds =
          typeof expiresAt === 'number' && expiresAt > Date.now()
            ? Math.round((expiresAt - Date.now()) / 1000)
            : undefined;

        useAuthStore.getState().login(session.user, session.token, expiresInSeconds);
        onSuccess?.(session.user);
        return true;
      } catch (err) {
        if (attempt !== attemptRef.current) return false;
        const described = describeAuthError(err);
        if (isMountedRef.current) setNotice(described);
        useAuthStore.getState().setError(`${described.title} ${described.detail}`);
        return false;
      } finally {
        if (attempt === attemptRef.current && isMountedRef.current) setIsLoggingIn(false);
      }
    },
    [onSuccess]
  );

  const startLogin = useCallback(
    (): Promise<boolean> => runLogin(() => discordAuthService.login()),
    [runLogin]
  );

  const startLoginInAppWindow = useCallback(
    (): Promise<boolean> => runLogin(() => discordAuthService.loginWithAuthWindow()),
    [runLogin]
  );

  const startLoginAsOtherAccount = useCallback(async (): Promise<boolean> => {
    // Only the desktop build remembers the account (persistent auth partition);
    // in the browser Discord's own cookie decides, and there is nothing to clear.
    const forget = typeof window !== 'undefined' ? window.electronAPI?.discordForgetSession : undefined;
    if (forget) {
      try {
        await forget();
      } catch (err) {
        // Not fatal: the worst case is Discord skipping the account picker.
        console.warn('[useDiscordLogin] Не удалось забыть аккаунт Discord:', err);
      }
    }
    return startLogin();
  }, [startLogin]);

  const continueAsGuest = useCallback(() => {
    setNotice(null);
    useAuthStore.getState().continueAsGuest();
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    startLogin,
    startLoginAsOtherAccount,
    startLoginInAppWindow,
    canUseAppWindow,
    continueAsGuest,
    isLoggingIn,
    notice,
    dismissNotice,
    isConfigured
  };
}
