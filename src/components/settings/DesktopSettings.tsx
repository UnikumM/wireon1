import React, { useEffect, useState } from 'react';
import { SettingsSection, SettingRow, ToggleSetting } from './SettingsPrimitives';
import { usePlayerStore } from '../../store/usePlayerStore';
import {
  discordRpcService,
  DISCORD_RPC_SETTING_KEY,
  type DiscordPresenceOptions,
  type DiscordStatusDisplay
} from '../../services/discordRpcService';
import * as dbService from '../../services/db';
import type { DiscordRpcStatusView } from '../../types/electron';

function readPlatform(): string | null {
  if (typeof window === 'undefined' || typeof window.electronAPI?.getPlatform !== 'function') return null;
  try {
    return window.electronAPI.getPlatform();
  } catch {
    return null;
  }
}

const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
};

/**
 * Одна строка про то, что сейчас со связью.
 *
 * До неё «активность не работает» выглядело одинаково при закрытом Discord,
 * выключенной настройке и отказе самого Discord — и разобрать, где поломка,
 * было нельзя ни владельцу, ни мне.
 */
function describeRpcStatus(status: DiscordRpcStatusView): string {
  if (!status.enabled) return 'Выключено';
  if (status.ready) {
    return status.lastAcceptedAt ? 'Подключено, трек передан' : 'Подключено, ждём трек';
  }
  return status.lastError ?? 'Нет связи с Discord';
}

/**
 * Desktop-only preferences. The whole section is hidden in the browser build,
 * where none of it has a bridge to talk to.
 */
export const DesktopSettings: React.FC = () => {
  const mediaKeysEnabled = usePlayerStore((s) => s.mediaKeysEnabled);
  const setMediaKeysEnabled = usePlayerStore((s) => s.setMediaKeysEnabled);

  const [platform, setPlatform] = useState<string | null>(() => readPlatform());
  const [discordRpcEnabled, setDiscordRpcEnabled] = useState<boolean>(() => discordRpcService.isEnabled());
  const [rpcStatus, setRpcStatus] = useState<DiscordRpcStatusView | null>(null);
  const [presence, setPresence] = useState<DiscordPresenceOptions>(() => discordRpcService.getOptions());

  const updatePresence = (partial: Partial<DiscordPresenceOptions>): void => {
    setPresence((prev) => ({ ...prev, ...partial }));
    void discordRpcService.setOptions(partial);
  };

  const isDesktop =
    typeof window !== 'undefined' &&
    (typeof window.electronAPI?.setMediaKeysEnabled === 'function' ||
      typeof window.electronAPI?.discordRpcSetEnabled === 'function');

  useEffect(() => {
    setPlatform(readPlatform());
    void dbService.getSetting<boolean>(DISCORD_RPC_SETTING_KEY, true).then((persisted) => {
      if (persisted !== undefined) {
        setDiscordRpcEnabled(persisted !== false);
      }
    });
  }, []);

  /**
   * Связь с Discord опрашивается, а не подписывается: она живёт в главном
   * процессе и меняется от событий, которых у окна нет (Discord закрыли,
   * Discord запустили). Раз в три секунды и только пока раздел открыт.
   */
  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      const status = (await window.electronAPI?.discordRpcStatus?.()) ?? null;
      if (alive) setRpcStatus(status);
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [discordRpcEnabled]);

  const handleDiscordRpcToggle = async (enabled: boolean): Promise<void> => {
    setDiscordRpcEnabled(enabled);
    await discordRpcService.setEnabled(enabled);
  };

  if (!isDesktop) return null;

  return (
    <SettingsSection id="desktop" title="Приложение" description="Работает только в настольной версии Wireon Sounds.">
      <ToggleSetting
        id="setting-media-keys"
        label="Медиаклавиши"
        description="Кнопки play/pause, «вперёд» и «назад» на клавиатуре будут управлять Wireon Sounds, даже когда окно неактивно. Если клавиши уже заняты другой программой, перехватить их не получится."
        checked={mediaKeysEnabled}
        onChange={setMediaKeysEnabled}
      />

      <ToggleSetting
        id="setting-discord-rpc"
        label="Показывать трек в Discord"
        description="В вашем статусе Discord будет видно название, исполнителя и обложку. Название, исполнитель и обложка кликабельны."
        checked={discordRpcEnabled}
        onChange={handleDiscordRpcToggle}
      />

      {discordRpcEnabled && (
        <>
          <SettingRow
            label="Что видно в списке участников"
            controlId="setting-discord-status-display"
            description="Рядом с вашим именем на сервере: название приложения, исполнитель или название трека."
          >
            <select
              id="setting-discord-status-display"
              value={presence.statusDisplay}
              onChange={(e) => updatePresence({ statusDisplay: e.target.value as DiscordStatusDisplay })}
              data-testid="settings-discord-status-display"
            >
              <option value="track">Название трека</option>
              <option value="artist">Исполнитель</option>
              <option value="app">Wireon</option>
            </select>
          </SettingRow>

          <ToggleSetting
            id="setting-discord-listen-button"
            label="Кнопка «Слушать»"
            description="Друзья откроют этот же трек на YouTube или SoundCloud. Кнопки видят только другие: в вашей собственной карточке Discord их не рисует."
            checked={presence.listenButton}
            onChange={(value) => updatePresence({ listenButton: value })}
          />

          <ToggleSetting
            id="setting-discord-download-button"
            label="Кнопка «Скачать Wireon»"
            description="Ведёт на страницу последней версии. Та же ссылка висит на значке Wireon у обложки — его видите и вы."
            checked={presence.downloadButton}
            onChange={(value) => updatePresence({ downloadButton: value })}
          />

          <ToggleSetting
            id="setting-discord-listen-together"
            label="«Слушать вместе» через Discord"
            description="Пока вы в комнате совместного прослушивания, друзья видят у вас в статусе «Присоединиться», а в чате Discord можно позвать послушать вместе. Кнопки на это время заменяются приглашением — так устроен Discord."
            checked={presence.listenTogether}
            onChange={(value) => updatePresence({ listenTogether: value })}
          />

          <ToggleSetting
            id="setting-discord-progress"
            label="Полоса времени"
            description="Сколько отыграно и сколько осталось, как у Spotify."
            checked={presence.showProgress}
            onChange={(value) => updatePresence({ showProgress: value })}
          />
        </>
      )}

      {discordRpcEnabled && rpcStatus && (
        <SettingRow
          label="Связь с Discord"
          controlId="setting-discord-rpc-status"
          description="Активность показывает сам Discord, и делает он это только пока запущен. Если здесь «нет связи», дело не в Wireon."
        >
          <span
            id="setting-discord-rpc-status"
            style={{
              fontSize: 'var(--text-sm)',
              color: rpcStatus.ready ? 'var(--success)' : 'var(--text-muted)'
            }}
            data-testid="settings-discord-rpc-status"
          >
            {describeRpcStatus(rpcStatus)}
          </span>
        </SettingRow>
      )}

      <SettingRow label="Система" controlId="setting-platform">
        <span
          id="setting-platform"
          style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
          data-testid="settings-platform"
        >
          {platform ? PLATFORM_LABELS[platform] ?? platform : 'Неизвестно'}
        </span>
      </SettingRow>
    </SettingsSection>
  );
};

export default DesktopSettings;
