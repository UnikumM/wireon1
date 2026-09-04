import React, { useCallback, useEffect, useState } from 'react';
import { HardDrive, LogOut, RefreshCw, ShieldCheck, UserRound, Users } from 'lucide-react';
import { Button } from '../common/Button';
import { DiscordLoginButton, DiscordIcon } from '../auth/DiscordLoginButton';
import { useDiscordLogin } from '../auth/useDiscordLogin';
import { SettingsSection, SettingRow, InfoRow } from './SettingsPrimitives';
import { getSyncChannel, useAuthStore, type SyncChannel } from '../../store/useAuthStore';
import { useUIStore } from '../../store/useUIStore';
import { cloudSyncEngine } from '../../services/cloudSync';
import { describeSyncError } from '../../services/syncErrors';

import { discordAuthService, getStoredSession, isDiscordConfigured } from '../../services/discordAuth';
import { CloudSyncResult } from '../../types/auth';
import { plural } from '../../utils/plural';
import { ICON } from '../../styles/icons';

function formatTimestamp(ms: number | null): string {
  if (!ms) return 'Никогда';
  return new Date(ms).toLocaleString('ru-RU');
}

const AVATAR_SIZE = 40;

/**
 * Account and sync. The sync engine has no remote backend, so this section
 * states that plainly instead of implying a cloud round-trip happened.
 */
/** Что показать в строке «Мгновенные обновления» при каждом из состояний. */
function describeInstantSync(
  channel: SyncChannel,
  isAuthenticated: boolean,
  syncsAcrossDevices: boolean
): { badge: string; description: string; good: boolean } {
  if (!isAuthenticated || !syncsAcrossDevices) {
    return {
      badge: 'нужен вход',
      description: 'Войдите через Discord — тогда устройства начнут узнавать об изменениях друг друга.',
      good: false
    };
  }
  if (channel === 'instant') {
    return {
      badge: 'подключено',
      description: 'Изменения с других устройств приходят сразу, без ожидания.',
      good: true
    };
  }
  if (channel === 'waiting') {
    return {
      badge: 'подключено',
      description: 'Приложение держит связь с сервером и получает изменения с других устройств за секунды.',
      good: true
    };
  }
  return {
    badge: 'нет связи',
    description: 'Связь с другими устройствами не установлена — медиатека сходится по расписанию.',
    good: false
  };
}

export const AccountSettings: React.FC = () => {
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const lastSyncedAt = useAuthStore((s) => s.lastSyncedAt);

  /*
   * Состояние звонка спрашивается по таймеру, а не подпиской.
   *
   * Подписка на статус брокера означала бы ещё один слушатель, живущий дольше
   * экрана настроек, ради строки, на которую смотрят раз в месяц. Опрос раз в
   * три секунды стоит одного сравнения булевых значений.
   */
  /** Есть ли вторая сторона: вход выполнен и адрес сервера задан. */
  const syncsAcrossDevices = isAuthenticated && cloudSyncEngine.isRemoteConfigured();


  const [channel, setChannel] = useState<SyncChannel>(() => getSyncChannel());
  useEffect(() => {
    const timer = setInterval(() => setChannel(getSyncChannel()), 3000);
    return () => clearInterval(timer);
  }, []);
  /*
   * «Нет связи» отвечало сразу на три разных вопроса — и ни на один внятно.
   *
   * Так выглядело и «вы не вошли», и «этому устройству такой канал недоступен»,
   * и настоящий обрыв. Владелец на телефоне видел «нет связи» и справедливо
   * читал это как поломку, хотя на телефоне мгновенный канал невозможен в
   * принципе: страница там живёт на https, а брокер у нас ws://, и браузер
   * запрещает такое соединение сам.
   */
  const instantNotice = describeInstantSync(channel, isAuthenticated, syncsAcrossDevices);
  const setSyncing = useAuthStore((s) => s.setSyncing);
  const setLastSyncedAt = useAuthStore((s) => s.setLastSyncedAt);
  const showToast = useUIStore((s) => s.showToast);

  const [isSyncing, setIsSyncing] = useState(false);
  const [result, setResult] = useState<CloudSyncResult | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const configured = isDiscordConfigured();

  const { startLoginAsOtherAccount, isLoggingIn, notice } = useDiscordLogin({
    onSuccess: (loggedIn) => {
      // Владельца журнала изменений выставляет auth-store — здесь только UI.
      setAvatarFailed(false);
      setSessionExpired(false);
      showToast(`Вы вошли как ${loggedIn.username}.`, 'success');
    }
  });

  // A token that is still in storage but past its expiry is worth saying out loud.
  useEffect(() => {
    setSessionExpired(isAuthenticated ? getStoredSession().isExpired : false);
  }, [isAuthenticated, user?.id]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [user?.avatarUrl]);

  const handleSync = useCallback(async () => {
    setIsSyncing(true);
    setSyncing(true);
    try {
      const outcome = await cloudSyncEngine.syncAll();
      setResult(outcome);
      if (outcome.success) {
        setLastSyncedAt(outcome.timestamp);
        showToast(
          outcome.remoteConfigured
            ? `Выгружено ${outcome.syncedPlaylists} ${plural(
                outcome.syncedPlaylists,
                'плейлист',
                'плейлиста',
                'плейлистов'
              )} и ${outcome.syncedFavorites} ${plural(
                outcome.syncedFavorites,
                'избранный трек',
                'избранных трека',
                'избранных треков'
              )}`
            : `Проверено на этом устройстве: ${outcome.localPlaylists} ${plural(
                outcome.localPlaylists,
                'плейлист',
                'плейлиста',
                'плейлистов'
              )} и ${outcome.localFavorites} ${plural(
                outcome.localFavorites,
                'избранный трек',
                'избранных трека',
                'избранных треков'
              )}`,
          'success'
        );
      } else {
        showToast(outcome.error ?? outcome.message ?? 'Проверка не удалась.', 'error');
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      showToast(`Проверка не удалась: ${detail}`, 'error');
    } finally {
      setSyncing(false);
      setIsSyncing(false);
    }
  }, [setLastSyncedAt, setSyncing, showToast]);

  const handleLogout = useCallback(() => {
    discordAuthService.logout();
    useAuthStore.getState().logout();
    setSessionExpired(false);
    setResult(null);
    showToast('Вы вышли из аккаунта.', 'info');
  }, [showToast]);

  const avatarUrl = !avatarFailed ? user?.avatarUrl : undefined;
  const accountLabel = isAuthenticated && user ? (user.username ?? 'Вы вошли') : 'Вход не выполнен';

  return (
    <SettingsSection
      id="account"
      title="Аккаунт и синхронизация"
      description="Вход через Discord — это и есть синхронизация: плейлисты и избранное сходятся между вашими устройствами. Без входа медиатека остаётся здесь."
    >
      <InfoRow
        label={accountLabel}
        description={
          isAuthenticated && user
            ? user.email
              ? `Аккаунт Discord · ${user.email}`
              : 'Аккаунт Discord привязан к этой копии приложения.'
            : configured
              ? 'Воспроизведение и медиатека работают полностью и без аккаунта.'
              : 'Вход через Discord недоступен: в этой сборке не задан VITE_DISCORD_CLIENT_ID.'
        }
      >
        {isAuthenticated ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={`Аватар ${accountLabel}`}
                width={AVATAR_SIZE}
                height={AVATAR_SIZE}
                onError={() => setAvatarFailed(true)}
                style={{
                  width: AVATAR_SIZE,
                  height: AVATAR_SIZE,
                  borderRadius: 'var(--radius-full)',
                  objectFit: 'cover',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--surface-3)'
                }}
                data-testid="account-avatar"
              />
            ) : (
              <span
                style={{
                  width: AVATAR_SIZE,
                  height: AVATAR_SIZE,
                  borderRadius: 'var(--radius-full)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--surface-3)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-muted)'
                }}
                data-testid="account-avatar"
              >
                <UserRound size={ICON.lg} aria-hidden="true" />
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<Users size={ICON.sm} />}
              isLoading={isLoggingIn}
              onClick={() => void startLoginAsOtherAccount()}
              data-testid="account-switch"
            >
              Другой аккаунт
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<LogOut size={ICON.sm} />}
              onClick={handleLogout}
              data-testid="account-logout"
            >
              Выйти
            </Button>
          </div>
        ) : (
          <DiscordLoginButton size="sm" showNotice={false} data-testid="account-login" />
        )}
      </InfoRow>

      {sessionExpired && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--warning-soft)',
            color: 'var(--warning)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)'
          }}
          data-testid="account-session-expired"
        >
          Сохранённая сессия Discord истекла. Нажмите «Другой аккаунт», чтобы войти заново.
        </p>
      )}

      {notice && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)'
          }}
          data-testid="account-auth-error"
        >
          {notice.title} {notice.detail}
        </p>
      )}

      <div className="divider" />

      {/*
        * Текст здесь врал, и это стоило доверия ко всей синхронизации.
        *
        * Он был написан, когда сервера действительно не было, и с тех пор не
        * менялся: экран синхронизации сообщал «сервера синхронизации у
        * приложения нет, между устройствами данные не переносятся» — то есть
        * прямо отрицал то, что уже работало. Человек, у которого что-то не
        * сошлось, читал это как приговор и переставал искать причину.
        */}
      <InfoRow
        label="Как хранятся данные"
        description={
          syncsAcrossDevices
            ? 'Медиатека хранится на устройстве, а изменения уезжают на сервер и приходят обратно — плейлисты и избранное сходятся между вашими устройствами.'
            : 'Пока вход не выполнен, изменения журналируются только здесь: переносить их между устройствами не по чему.'
        }
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: '2px var(--space-2)',
            borderRadius: 'var(--radius-full)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--surface-2)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-secondary)'
          }}
          data-testid="account-storage-mode"
        >
          <HardDrive size={ICON.xs} />
          {syncsAcrossDevices ? 'Синхронизируется' : 'Только на этом устройстве'}
        </span>
      </InfoRow>

      <InfoRow
        label="Что видит Discord"
        description="Wireon Sounds запрашивает только имя, аватар и e-mail (scope identify + email). Токен хранится на этом устройстве и не отправляется никуда, кроме Discord."
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: '2px var(--space-2)',
            borderRadius: 'var(--radius-full)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--surface-2)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-secondary)'
          }}
          data-testid="account-scopes"
        >
          <ShieldCheck size={ICON.xs} />
          identify · email
        </span>
      </InfoRow>

      {/*
        * Видно ли, что мгновенные обновления живы.
        *
        * Строка появилась после «синхронизация как будто не работает»: и когда
        * она работает, и когда нет, экран выглядел одинаково, и проверить
        * догадку человеку было нечем. Здесь сказано прямо — устройство слышит
        * остальные или сходится только по расписанию.
        */}
      <SettingRow
        label="Мгновенные обновления"
        controlId="account-instant-sync"
        description={instantNotice.description}
      >
        <span
          id="account-instant-sync"
          className="badge"
          style={{
            color: instantNotice.good ? 'var(--accent)' : 'var(--text-muted)',
            backgroundColor: instantNotice.good ? 'var(--accent-soft)' : 'var(--surface-sunken)',
            borderColor: instantNotice.good ? 'var(--border-accent)' : 'var(--border-subtle)'
          }}
          data-testid="account-instant-sync"
        >
          {instantNotice.badge}
        </span>
      </SettingRow>

      <SettingRow
        label="Проверить медиатеку"
        controlId="account-sync"
        description="Проигрывает отложенные изменения в локальной базе и сообщает, что именно затронуло."
      >
        <span data-numeric style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          {formatTimestamp(lastSyncedAt)}
        </span>
        <Button
          id="account-sync"
          variant="secondary"
          size="sm"
          icon={<RefreshCw size={ICON.sm} />}
          isLoading={isSyncing}
          onClick={handleSync}
          data-testid="account-sync"
        >
          Проверить
        </Button>
      </SettingRow>

      {result && (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)',
            color: result.success ? 'var(--text-secondary)' : 'var(--danger)'
          }}
          data-testid="account-sync-result"
        >
          {describeSyncError(result.error)?.message ?? result.message ?? 'Готово.'}
          {result.success && (
            <>
              {' '}
              <span data-numeric>
                Локально сверено: {result.localPlaylists}{' '}
                {plural(result.localPlaylists, 'плейлист', 'плейлиста', 'плейлистов')} ·{' '}
                {result.localFavorites}{' '}
                {plural(result.localFavorites, 'избранный трек', 'избранных трека', 'избранных треков')}
              </span>
            </>
          )}
        </p>
      )}

      {!isAuthenticated && configured && (
        <p
          style={{
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)',
            color: 'var(--text-muted)'
          }}
        >
          <DiscordIcon size={ICON.xs} />
          Вход открывается прямо в приложении — отдельный браузер не нужен.
        </p>
      )}
    </SettingsSection>
  );
};

export default AccountSettings;
