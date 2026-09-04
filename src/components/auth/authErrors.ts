import { AuthError } from '../../services/discordAuth';
import { AuthErrorCode } from '../../types/auth';

/** Where the client id has to be set, quoted identically everywhere. */
export const DISCORD_CONFIG_HINT =
  'Укажите VITE_DISCORD_CLIENT_ID в файле .env (скопируйте .env.example) и перезапустите приложение.';

export interface AuthErrorNotice {
  /** One short sentence naming what went wrong. */
  title: string;
  /** What the user can do about it. */
  detail: string;
  /** True when retrying is pointless until something outside the app changes. */
  blocking: boolean;
  code: AuthErrorCode | 'UNKNOWN';
}

/** Fallback text for a rejection that carried no message of its own. */
export const UNKNOWN_AUTH_ERROR_DETAIL = 'Неизвестная ошибка.';

/**
 * Turns a rejection from `discordAuthService.login()` into copy the user can act
 * on. Every `AuthErrorCode` gets its own message — a blocked popup and a missing
 * client id need completely different reactions.
 */
export function describeAuthError(err: unknown): AuthErrorNotice {
  if (!(err instanceof AuthError)) {
    const detail = err instanceof Error && err.message ? err.message : UNKNOWN_AUTH_ERROR_DETAIL;
    return {
      title: 'Не удалось войти через Discord.',
      detail,
      blocking: false,
      code: 'UNKNOWN'
    };
  }

  switch (err.code) {
    case 'NOT_CONFIGURED':
      return {
        title: 'Вход через Discord не настроен.',
        detail: `${DISCORD_CONFIG_HINT} Пока можно пользоваться Wireon Sounds без аккаунта.`,
        blocking: true,
        code: err.code
      };

    case 'UNSUPPORTED_ENVIRONMENT':
      return {
        title: 'Эта сборка не может открыть вход через Discord.',
        detail:
          'Нет ни окна браузера, ни моста Electron, поэтому авторизацию не запустить. Продолжайте без аккаунта.',
        blocking: true,
        code: err.code
      };

    case 'POPUP_BLOCKED':
      return {
        title: 'Браузер заблокировал окно Discord.',
        detail: 'Разрешите всплывающие окна для Wireon Sounds и начните вход заново.',
        blocking: false,
        code: err.code
      };

    case 'POPUP_CLOSED':
      return {
        title: 'Окно Discord закрылось раньше, чем вход завершился.',
        detail: 'Попробуйте снова и не закрывайте окно, пока Discord не вернёт вас в Wireon Sounds.',
        blocking: false,
        code: err.code
      };

    case 'DEEP_LINK_UNAVAILABLE':
      return {
        title: 'Приложение не смогло получить ответ Discord.',
        detail:
          'Обработчик ссылок wireon:// не зарегистрирован. Перезапустите Wireon Sounds; если не поможет — войдите в браузерной версии.',
        blocking: true,
        code: err.code
      };

    case 'STATE_MISMATCH':
      return {
        title: 'Ответ Discord не совпал с этим запросом входа.',
        detail:
          'Вход был прерван или повторён, поэтому он отклонён в целях безопасности. Начните вход заново из этого окна.',
        blocking: false,
        code: err.code
      };

    case 'OAUTH_DENIED':
      return {
        title: 'Вы отклонили запрос Discord.',
        detail: 'Подтвердите доступ на стороне Discord, чтобы привязать аккаунт, или останьтесь без аккаунта.',
        blocking: false,
        code: err.code
      };

    case 'NO_TOKEN':
      return {
        title: 'Discord не вернул токен доступа.',
        detail:
          'Повторите вход. Если повторяется — проверьте, что адрес перенаправления в приложении Discord совпадает с этим.',
        blocking: false,
        code: err.code
      };

    case 'PROFILE_FETCH_FAILED': {
      const status = typeof err.status === 'number' ? err.status : undefined;
      if (status === 401 || status === 403) {
        return {
          title: 'Discord отклонил токен доступа.',
          detail: `Загрузка профиля вернула HTTP ${status}. Войдите заново, чтобы получить свежий токен.`,
          blocking: false,
          code: err.code
        };
      }
      if (status === 429) {
        return {
          title: 'Discord ограничил частоту запросов.',
          detail: 'Загрузка профиля вернула HTTP 429. Подождите минуту и войдите снова.',
          blocking: false,
          code: err.code
        };
      }
      return {
        title: 'Discord впустил вас, но не отдал профиль.',
        detail: status
          ? `Загрузка профиля вернула HTTP ${status}. Попробуйте ещё раз через минуту.`
          : 'Не удалось загрузить профиль. Проверьте соединение и попробуйте снова.',
        blocking: false,
        code: err.code
      };
    }

    case 'TIMEOUT':
      return {
        title: 'Время входа через Discord истекло.',
        detail: 'Авторизация не была завершена вовремя. Начните вход заново.',
        blocking: false,
        code: err.code
      };

    default:
      return {
        title: 'Не удалось войти через Discord.',
        detail: err.message || UNKNOWN_AUTH_ERROR_DETAIL,
        blocking: false,
        code: 'UNKNOWN'
      };
  }
}
