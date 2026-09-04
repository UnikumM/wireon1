import React from 'react';
import { Loader2 } from 'lucide-react';
import { Button, ButtonSize } from '../common/Button';
import { UserProfile } from '../../types/music';
import { useDiscordLogin } from './useDiscordLogin';
import { DISCORD_CONFIG_HINT } from './authErrors';

export interface DiscordLoginButtonProps {
  text?: string;
  /** Forces the busy state while a parent owns part of the flow. */
  isLoading?: boolean;
  disabled?: boolean;
  size?: Extract<ButtonSize, 'sm' | 'md' | 'lg'>;
  fullWidth?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Fired with the real profile after the session is stored. */
  onSuccess?: (user: UserProfile) => void;
  /** Also called when the user activates the button, before the flow starts. */
  onClick?: () => void;
  /** Set false to render the failure/configuration copy somewhere else. */
  showNotice?: boolean;
  'data-testid'?: string;
}

export const DiscordIcon: React.FC<{ size?: number; color?: string; className?: string }> = ({
  size = 20,
  color = 'currentColor',
  className = ''
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={color}
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    style={{ flexShrink: 0 }}
    aria-hidden="true"
  >
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.893.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

let noticeIdCounter = 0;

/**
 * Runs the real Discord OAuth2 flow. When `VITE_DISCORD_CLIENT_ID` is missing the
 * button is disabled and says so — it never falls back to a fabricated session.
 */
export const DiscordLoginButton: React.FC<DiscordLoginButtonProps> = ({
  text = 'Войти через Discord',
  isLoading = false,
  disabled = false,
  size = 'md',
  fullWidth = false,
  className = '',
  style,
  onSuccess,
  onClick,
  showNotice = true,
  'data-testid': testId = 'discord-login-btn'
}) => {
  const { startLogin, startLoginInAppWindow, canUseAppWindow, isLoggingIn, notice, isConfigured } =
    useDiscordLogin({ onSuccess });

  const idRef = React.useRef<string>();
  if (!idRef.current) {
    noticeIdCounter += 1;
    idRef.current = `discord-login-notice-${noticeIdCounter}`;
  }

  const busy = isLoading || isLoggingIn;
  const iconSize = size === 'sm' ? 15 : size === 'lg' ? 20 : 17;

  const configNotice = !isConfigured
    ? `Вход через Discord недоступен. ${DISCORD_CONFIG_HINT}`
    : null;
  const message = notice ? `${notice.title} ${notice.detail}` : configNotice;

  const handleClick = () => {
    onClick?.();
    void startLogin();
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        width: fullWidth ? '100%' : undefined
      }}
    >
      <Button
        variant="primary"
        size={size}
        fullWidth={fullWidth}
        onClick={handleClick}
        disabled={disabled || busy || !isConfigured}
        className={className}
        style={style}
        aria-describedby={showNotice && message ? idRef.current : undefined}
        icon={
          busy ? (
            <Loader2
              size={iconSize}
              className="animate-spin"
              aria-hidden="true"
              data-testid="discord-login-spinner"
            />
          ) : (
            <DiscordIcon size={iconSize} />
          )
        }
        data-testid={testId}
      >
        {busy ? 'Подключаемся…' : text}
      </Button>

      {/*
        * Запасной путь, пока идёт вход.
        *
        * Согласие открывается в системном браузере — там человек уже вошёл в
        * Discord, и пароль вводить не надо. Но вернуться оттуда приложение
        * может только по схеме `wireon://`, а её человек волен и не разрешить:
        * закрыть вкладку, отмахнуться от «Открыть Wireon Sounds?», уйти в
        * другой браузер. Тогда ждать нечего, и вместо двух минут тишины здесь
        * есть чем закончить вход.
        */}
      {busy && canUseAppWindow && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void startLoginInAppWindow()}
          data-testid="discord-login-in-app"
        >
          Браузер не вернулся? Войти в окне приложения
        </Button>
      )}

      {showNotice && message && (
        <p
          id={idRef.current}
          role={notice ? 'alert' : undefined}
          style={{
            margin: 0,
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)',
            letterSpacing: 'var(--tracking-xs)',
            color: notice ? 'var(--danger)' : 'var(--text-muted)'
          }}
          data-testid="discord-login-notice"
        >
          {message}
        </p>
      )}
    </div>
  );
};
