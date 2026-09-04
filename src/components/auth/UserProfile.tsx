import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AppWindow, CheckCircle2, ChevronDown, Cloud, CloudOff, HardDrive, LogIn, LogOut, RefreshCw, Settings, User, UserX } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import { useUIStore } from '../../store/useUIStore';
import { discordAuthService, getStoredSession } from '../../services/discordAuth';
import { cloudSyncEngine } from '../../services/cloudSync';
import { describeSyncError } from '../../services/syncErrors';
import { DiscordIcon } from './DiscordLoginButton';
import { useDiscordLogin } from './useDiscordLogin';
import { DISCORD_CONFIG_HINT } from './authErrors';
import { CloudSyncResult, SyncStatus } from '../../types/auth';
import { plural } from '../../utils/plural';
import { ICON } from '../../styles/icons';

export interface UserProfileProps {
  compact?: boolean;
  className?: string;
  /** Legacy hook: also called when the trigger is activated. */
  onAuthClick?: () => void;
  style?: React.CSSProperties;
  /**
   * Куда раскрывать меню. По умолчанию вниз — так стоит пилюля в шапке.
   *
   * В боковой панели она внизу окна, и меню, открытое вниз, уезжало за нижний
   * край: было видно верхние строки, а «Войти через Discord» и сообщение об
   * ошибке оказывались за экраном. Отсюда и «ломается весь экран» — на самом
   * деле ломалось не всё, а именно это меню, зато занимало оно полполосы.
   */
  placement?: 'down' | 'up';
  /**
   * От какого края расти вширь. По умолчанию от правого — так меню висит под
   * пилюлей в шапке, у правого края окна.
   *
   * В боковой панели наоборот: панель узкая (140 px), меню — 320, и рост влево
   * уводил половину за край экрана. Было видно обрезанное «ость», «хронизация»,
   * «ти через Discord» — то самое «ломается весь экран». Расти надо вправо, в
   * сторону содержимого.
   */
  align?: 'left' | 'right';
}

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

let menuIdCounter = 0;

const menuItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  width: '100%',
  justifyContent: 'flex-start',
  padding: 'var(--space-2) var(--space-3)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-sm)',
  letterSpacing: 'var(--tracking-sm)',
  fontWeight: 'var(--weight-medium)',
  color: 'var(--text-primary)',
  textAlign: 'left'
};

/** Discord presence colours mapped onto the semantic tokens. */
function statusColor(status: string | undefined, isAuthenticated: boolean): string {
  if (!isAuthenticated) return 'var(--text-muted)';
  switch (status) {
    case 'online':
      return 'var(--success)';
    case 'idle':
      return 'var(--warning)';
    case 'dnd':
      return 'var(--danger)';
    default:
      return 'var(--text-faint)';
  }
}

export const UserProfile: React.FC<UserProfileProps> = ({
  placement = 'down',
  align = 'right',
  compact = false,
  className = '',
  onAuthClick,
  style
}) => {
  const setActiveView = useUIStore((state) => state.setActiveView);

  const [isOpen, setIsOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(cloudSyncEngine.syncStatus);
  const [lastResult, setLastResult] = useState<CloudSyncResult | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [storedSessionExpired, setStoredSessionExpired] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const idRef = useRef<string>();
  if (!idRef.current) {
    menuIdCounter += 1;
    idRef.current = `user-profile-menu-${menuIdCounter}`;
  }

  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const showToast = useUIStore((s) => s.showToast);

  const remoteConfigured = cloudSyncEngine.isRemoteConfigured();

  const closeMenu = useCallback((restoreFocus = true) => {
    setIsOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const runSync = useCallback(async () => {
    setIsSyncing(true);
    const result = await cloudSyncEngine.syncAll();
    setIsSyncing(false);
    setLastResult(result);
    useAuthStore.getState().setLastSyncedAt(result.timestamp);

    if (!result.success) {
      const failure = describeSyncError(result.error);
      showToast(failure?.message ?? 'Не удалось проверить медиатеку.', 'error');
      return;
    }

    if (!result.remoteConfigured) {
      // Nothing was uploaded and nothing could be: say exactly that.
      showToast(
        result.message ??
          `Проверено на этом устройстве: ${result.localPlaylists} плейлистов и ${result.localFavorites} избранных треков.`,
        'info'
      );
      return;
    }

    showToast(
      `Выгружено ${result.syncedPlaylists} плейлистов и ${result.syncedFavorites} избранных треков.`,
      'success'
    );
  }, [showToast]);

  const {
    startLogin,
    startLoginAsOtherAccount,
    startLoginInAppWindow,
    canUseAppWindow,
    continueAsGuest,
    isLoggingIn,
    notice,
    isConfigured
  } = useDiscordLogin({
      onSuccess: (loggedIn) => {
        // Владельца журнала изменений выставляет сам auth-store — здесь только UI.
        setAvatarFailed(false);
        setStoredSessionExpired(false);
        showToast(`Вы вошли как ${loggedIn.username}.`, 'success');
        setIsOpen(false);
        void runSync();
      }
    });

  useEffect(() => {
    const unsubscribe = cloudSyncEngine.onStatusChange(setSyncStatus);
    return () => unsubscribe();
  }, []);

  // A stale token in storage is worth saying out loud rather than silently ignoring.
  useEffect(() => {
    if (!isOpen) return;
    setStoredSessionExpired(getStoredSession().isExpired);
  }, [isOpen]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [user?.avatarUrl]);

  useEffect(() => {
    if (!isOpen) return;

    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isOpen]);

  // Opening a menu moves focus into it (ARIA menu button pattern).
  useEffect(() => {
    if (!isOpen) return;
    const first = menuRef.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
    first?.focus();
  }, [isOpen]);

  const handleTriggerClick = () => {
    onAuthClick?.();
    setIsOpen((prev) => !prev);
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIsOpen(true);
    }
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === 'Tab') {
      setIsOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;

    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? []);
    if (items.length === 0) return;

    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = current;

    if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    if (e.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = items.length - 1;

    items[next]?.focus();
  };

  const handleLogout = () => {
    discordAuthService.logout();
    useAuthStore.getState().logout();
    setLastResult(null);
    setStoredSessionExpired(false);
    showToast('Вы вышли из аккаунта и слушаете как гость.', 'info');
    closeMenu();
  };

  const handleGuest = () => {
    continueAsGuest();
    showToast('Продолжаем без аккаунта. Медиатека остаётся на этом устройстве.', 'info');
    closeMenu();
  };

  const displayName = user?.username || (isAuthenticated ? 'Пользователь Discord' : 'Гость');
  const avatarUrl = !avatarFailed ? user?.avatarUrl : undefined;
  const dotColor = statusColor(user?.status, isAuthenticated);

  /**
   * The indicator never claims a cloud upload while `remoteConfigured` is false —
   * `local-only` is a normal, calm state, not a warning.
   */
  const syncIndicator = useMemo(() => {
    const wrap = (title: string, icon: React.ReactNode) => (
      <span
        title={title}
        aria-hidden="true"
        data-testid="user-profile-sync-indicator"
        style={{ display: 'inline-flex', alignItems: 'center' }}
      >
        {icon}
      </span>
    );

    if (syncStatus === 'syncing') {
      return wrap(
        'Проверяем медиатеку',
        <RefreshCw size={ICON.sm} className="animate-spin" style={{ color: 'var(--accent)' }} />
      );
    }
    if (syncStatus === 'offline') {
      return wrap('Нет сети', <CloudOff size={ICON.xs} style={{ color: 'var(--text-muted)' }} />);
    }
    if (syncStatus === 'error') {
      return wrap('Проверка медиатеки не удалась', <AlertCircle size={ICON.xs} style={{ color: 'var(--danger)' }} />);
    }
    if (!remoteConfigured) {
      return wrap(
        'Хранится только на этом устройстве',
        <HardDrive size={ICON.xs} style={{ color: 'var(--text-muted)' }} />
      );
    }
    if (syncStatus === 'synced') {
      return wrap('Синхронизировано с облаком', <CheckCircle2 size={ICON.xs} style={{ color: 'var(--success)' }} />);
    }
    return wrap('Облачная синхронизация готова', <Cloud size={ICON.xs} style={{ color: 'var(--text-muted)' }} />);
  }, [syncStatus, remoteConfigured]);

  const syncHeadline = (): string => {
    if (syncStatus === 'syncing' || isSyncing) return 'Проверяем медиатеку…';
    if (syncStatus === 'offline') return 'Нет сети — проверка не выполнена.';
    if (syncStatus === 'error') {
      return describeSyncError(lastResult?.error)?.message ?? 'Последняя проверка не удалась.';
    }
    if (!remoteConfigured) return 'Хранится только на этом устройстве.';
    if (syncStatus === 'synced') return 'Синхронизировано с облаком.';
    return 'Пока не проверялось.';
  };

  const syncDetail = (): string | null => {
    if (!lastResult) {
      return remoteConfigured
        ? null
        : 'Сервер не настроен, поэтому ничего не выгружается. Для резервной копии используйте «Настройки → Экспорт медиатеки».';
    }
    // Отказ уже назван в заголовке. Второй раз теми же словами — это не
    // подробность, а та самая «Failed to fetch» дважды подряд, которую владелец
    // и прислал на снимке.
    if (!lastResult.success) return null;

    const local = `${lastResult.localPlaylists} ${plural(lastResult.localPlaylists, 'плейлист', 'плейлиста', 'плейлистов')} · ${
      lastResult.localFavorites
    } ${plural(lastResult.localFavorites, 'избранный трек', 'избранных трека', 'избранных треков')} на этом устройстве`;

    if (!lastResult.remoteConfigured) {
      return `${lastResult.message ?? 'Ничего не выгружено.'} ${local}.`;
    }

    return `Выгружено ${lastResult.syncedPlaylists} плейлистов и ${lastResult.syncedFavorites} избранных треков. ${local}.`;
  };

  const detail = syncDetail();
  const lastCheckedAt = lastResult ? new Date(lastResult.timestamp).toLocaleTimeString() : null;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', display: 'inline-block', ...style }}
      data-testid="user-profile"
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        className="press-surface"
        data-open={isOpen || undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: compact ? 'var(--space-2)' : 'var(--space-3)',
          padding: compact ? 'var(--space-1) var(--space-2)' : 'var(--space-2) var(--space-3)',
          borderRadius: 'var(--radius-full)',
          // Фон, рамка и подсветка «меню открыто» — в `.press-surface`
          // (global.css §14). Инлайновый фон перебивал `.press:hover`, и пилюля
          // профиля — единственный вход в меню аккаунта — не отзывалась на
          // наведение.
          color: 'var(--text-primary)'
        }}
        data-testid="user-profile-btn"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-controls={isOpen ? idRef.current : undefined}
      >
        <span
          style={{
            position: 'relative',
            width: compact ? '22px' : '26px',
            height: compact ? '22px' : '26px',
            flexShrink: 0
          }}
        >
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={`Аватар ${displayName}`}
              onError={() => setAvatarFailed(true)}
              style={{
                width: '100%',
                height: '100%',
                borderRadius: 'var(--radius-full)',
                objectFit: 'cover',
                border: '1px solid var(--border)',
                backgroundColor: 'var(--surface-3)'
              }}
              data-testid="user-profile-avatar"
            />
          ) : (
            <span
              style={{
                width: '100%',
                height: '100%',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'var(--surface-3)',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              data-testid="user-profile-avatar"
            >
              <User size={compact ? 12 : 14} aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
            </span>
          )}

          <span
            style={{
              position: 'absolute',
              bottom: '-1px',
              right: '-1px',
              width: '7px',
              height: '7px',
              borderRadius: 'var(--radius-full)',
              backgroundColor: dotColor,
              border: '1px solid var(--surface-2)'
            }}
            data-testid="user-profile-status"
          />
        </span>

        <span className="user-profile-name hide-on-mobile">
          <span
            className="text-truncate"
            style={{
              fontSize: compact ? 'var(--text-xs)' : 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              letterSpacing: 'var(--tracking-sm)',
              fontWeight: 'var(--weight-medium)',
              maxWidth: '120px'
            }}
            data-testid="user-profile-username"
          >
            {displayName}
          </span>
          {syncIndicator}
        </span>

        <ChevronDown
          size={ICON.sm}
          aria-hidden="true"
          className="hide-on-mobile"
          style={{
            color: 'var(--text-muted)',
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform var(--dur-fast) var(--ease-out)'
          }}
        />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          id={idRef.current}
          role="menu"
          aria-label="Аккаунт"
          onKeyDown={handleMenuKeyDown}
          className="panel-raised animate-fade-in"
          style={{
            position: 'absolute',
            ...(placement === 'up'
              ? { bottom: 'calc(100% + var(--space-2))' }
              : { top: 'calc(100% + var(--space-2))' }),
            ...(align === 'left' ? { left: 0 } : { right: 0 }),
            // 272 придуманы под окно, где рядом ещё половина экрана. На
            // телефоне это колонка текста в сто пикселей, где подпись ломается
            // по слову. Берём столько, сколько есть, оставляя поля по краям.
            width: 'min(320px, calc(100vw - var(--space-5)))',
            // Меню длиннее окна раньше просто уходило за край вместе с
            // кнопками. Теперь прокручивается внутри себя.
            maxHeight: 'calc(var(--app-height) - var(--space-7))',
            overflowY: 'auto',
            padding: 'var(--space-3)',
            zIndex: 'var(--z-menu)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)'
          }}
          data-testid="user-profile-menu"
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              paddingBottom: 'var(--space-3)',
              borderBottom: '1px solid var(--border-subtle)'
            }}
          >
            <span style={{ position: 'relative', width: '38px', height: '38px', flexShrink: 0 }}>
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={`Аватар ${displayName}`}
                  onError={() => setAvatarFailed(true)}
                  style={{
                    width: '100%',
                    height: '100%',
                    borderRadius: 'var(--radius-full)',
                    objectFit: 'cover',
                    backgroundColor: 'var(--surface-3)'
                  }}
                />
              ) : (
                <span
                  style={{
                    width: '100%',
                    height: '100%',
                    borderRadius: 'var(--radius-full)',
                    backgroundColor: 'var(--surface-3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <User size={ICON.lg} aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
                </span>
              )}
              <span
                style={{
                  position: 'absolute',
                  bottom: 0,
                  right: 0,
                  width: '10px',
                  height: '10px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: dotColor,
                  border: '2px solid var(--surface-3)'
                }}
              />
            </span>

            <div style={{ minWidth: 0 }}>
              <div
                className="text-truncate"
                style={{
                  fontWeight: 'var(--weight-semibold)',
                  fontSize: 'var(--text-base)',
                  lineHeight: 'var(--leading-base)',
                  color: 'var(--text-primary)'
                }}
              >
                {displayName}
              </div>
              <div
                style={{
                  fontSize: 'var(--text-xs)',
                  lineHeight: 'var(--leading-xs)',
                  letterSpacing: 'var(--tracking-xs)',
                  color: 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-1)'
                }}
              >
                {isAuthenticated ? (
                  <>
                    <DiscordIcon size={ICON.xs} />
                    <span>Аккаунт Discord</span>
                  </>
                ) : (
                  <>
                    {/* Речь ровно о том, что всё лежит на диске, — так и рисуем. */}
                    <HardDrive size={ICON.xs} aria-hidden="true" />
                    <span>Гость — данные не покидают устройство</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {storedSessionExpired && (
            <p
              role="alert"
              style={{
                margin: 0,
                padding: 'var(--space-2) var(--space-3)',
                backgroundColor: 'var(--warning-soft)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--warning)',
                fontSize: 'var(--text-xs)',
                lineHeight: 'var(--leading-xs)'
              }}
              data-testid="user-profile-session-expired"
            >
              Сохранённая сессия Discord истекла. Войдите снова, чтобы восстановить связь.
            </p>
          )}

          <div className="panel-inset" style={{ padding: 'var(--space-3)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 'var(--space-3)'
              }}
            >
              <div style={{ display: 'flex', gap: 'var(--space-2)', minWidth: 0 }}>
                {syncIndicator}
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 'var(--text-sm)',
                      lineHeight: 'var(--leading-sm)',
                      fontWeight: 'var(--weight-medium)',
                      color: 'var(--text-secondary)'
                    }}
                  >
                    Синхронизация медиатеки
                  </div>
                  <div
                    style={{
                      fontSize: 'var(--text-xs)',
                      lineHeight: 'var(--leading-xs)',
                      color: 'var(--text-muted)'
                    }}
                    data-testid="user-profile-sync-headline"
                  >
                    {syncHeadline()}
                  </div>
                </div>
              </div>

              <button
                type="button"
                role="menuitem"
                onClick={() => void runSync()}
                disabled={isSyncing || syncStatus === 'syncing'}
                // `menu-item-inline` вместо простого `menu-item-hover`: у того
                // `width: 100%`, и кнопка забирала всю строку, сжимая заголовок
                // с подписью в ноль. Размеры — в классе, а не инлайном, иначе
                // их не перебить правилом (см. DESIGN_SYSTEM §14).
                className="menu-item-hover menu-item-inline"
                style={{
                  borderRadius: 'var(--radius-xs)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--text-xs)',
                  letterSpacing: 'var(--tracking-xs)',
                  fontWeight: 'var(--weight-medium)',
                  flexShrink: 0
                }}
                data-testid="user-profile-sync-now"
              >
                {isSyncing ? 'Проверяем…' : 'Проверить'}
              </button>
            </div>

            {detail && (
              <p
                style={{
                  margin: 'var(--space-2) 0 0 0',
                  fontSize: 'var(--text-xs)',
                  lineHeight: 'var(--leading-xs)',
                  color: 'var(--text-muted)'
                }}
                data-testid="user-profile-sync-detail"
              >
                {detail}
              </p>
            )}

            {lastCheckedAt && (
              <p
                style={{
                  margin: 'var(--space-1) 0 0 0',
                  fontSize: 'var(--text-xs)',
                  lineHeight: 'var(--leading-xs)',
                  color: 'var(--text-faint)'
                }}
              >
                Последняя проверка в <span data-numeric>{lastCheckedAt}</span>
              </p>
            )}
          </div>

          {notice && (
            <p
              role="alert"
              style={{
                margin: 0,
                padding: 'var(--space-2) var(--space-3)',
                backgroundColor: 'var(--danger-soft)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--danger)',
                fontSize: 'var(--text-xs)',
                lineHeight: 'var(--leading-xs)'
              }}
              data-testid="user-profile-auth-error"
            >
              {notice.title} {notice.detail}
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <button
              type="button"
              role="menuitem"
              onClick={() => void (isAuthenticated ? startLoginAsOtherAccount() : startLogin())}
              disabled={isLoggingIn || !isConfigured}
              className="menu-item-hover"
              style={menuItemStyle}
              data-testid="user-profile-login"
            >
              {isAuthenticated ? (
                <LogIn size={ICON.md} aria-hidden="true" />
              ) : (
                <DiscordIcon size={ICON.md} />
              )}
              <span>
                {isLoggingIn
                  ? 'Подключаемся…'
                  : isAuthenticated
                  ? 'Войти под другим аккаунтом'
                  : 'Войти через Discord'}
              </span>
            </button>

            {/*
              * Пока идёт вход, согласие открыто в системном браузере. Вернуться
              * оттуда он может только по схеме `wireon://` — а от перехода в
              * приложение человек волен и отказаться. Тогда заканчивать вход
              * нечем, и здесь есть чем.
              */}
            {isLoggingIn && canUseAppWindow && (
              <button
                type="button"
                role="menuitem"
                onClick={() => void startLoginInAppWindow()}
                className="menu-item-hover"
                style={menuItemStyle}
                data-testid="user-profile-login-in-app"
              >
                <AppWindow size={ICON.md} aria-hidden="true" />
                <span>Войти в окне приложения</span>
              </button>
            )}

            {!isConfigured && (
              <p
                style={{
                  margin: '0 var(--space-3) var(--space-1)',
                  fontSize: 'var(--text-xs)',
                  lineHeight: 'var(--leading-xs)',
                  color: 'var(--text-muted)'
                }}
                data-testid="user-profile-login-unavailable"
              >
                {DISCORD_CONFIG_HINT}
              </p>
            )}

            {/*
              * Настройки здесь, а не в нижней панели.
              *
              * В панели их подпись не влезала: шесть разделов делили ширину
              * экрана поровну. Но дело не только в ширине — настройки относятся
              * к аккаунту и устройству, а не к тому, что слушать, и в телефонных
              * приложениях они живут ровно тут, под аватаром.
              */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setActiveView('settings');
                setIsOpen(false);
              }}
              className="menu-item-hover"
              style={menuItemStyle}
              data-testid="user-profile-settings"
            >
              <Settings size={ICON.md} aria-hidden="true" />
              <span>Настройки</span>
            </button>

            {isAuthenticated ? (
              <button
                type="button"
                role="menuitem"
                onClick={handleLogout}
                className="menu-item-hover"
                data-variant="danger"
                style={{ ...menuItemStyle, color: 'var(--danger)' }}
                data-testid="user-profile-logout"
              >
                <LogOut size={ICON.md} aria-hidden="true" />
                <span>Выйти</span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={handleGuest}
                className="menu-item-hover"
                style={menuItemStyle}
                data-testid="user-profile-guest"
              >
                <UserX size={ICON.md} aria-hidden="true" />
                <span>Продолжить без аккаунта</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
