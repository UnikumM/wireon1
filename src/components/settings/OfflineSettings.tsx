import React, { useCallback, useEffect, useState } from 'react';
import { HardDriveDownload, Heart, Trash2, WifiOff } from 'lucide-react';
import { Button } from '../common/Button';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { SettingsSection, SettingRow, InfoRow, ToggleSetting } from './SettingsPrimitives';
import { useUIStore } from '../../store/useUIStore';
import { pluralize } from '../../utils/plural';
import { offlineStorage, type StorageUsage } from '../../services/offlineStorage';
import {
  offlineMode,
  OFFLINE_LIMIT_OPTIONS,
  OFFLINE_BITRATE_OPTIONS,
  DEFAULT_OFFLINE_LIMIT_BYTES,
  DEFAULT_OFFLINE_BITRATE_KBPS,
  type OfflineModeState
} from '../../services/offlineMode';
import {
  offlineAutoDownload,
  FAVORITES_LIMIT_OPTIONS,
  DEFAULT_FAVORITES_LIMIT_BYTES,
  formatRuBytes,
  type OfflineAutoDownloadState
} from '../../services/offlineAutoDownload';
import { ICON } from '../../styles/icons';

const EMPTY_USAGE: StorageUsage = { count: 0, trackCount: 0, totalBytes: 0, formattedSize: '0 B' };

/**
 * The offline switch that replaced the per-track download button.
 *
 * One toggle, one size cap, one honest usage read-out — the user turns it on and
 * stops thinking about it.
 */
export const OfflineSettings: React.FC = () => {
  const showToast = useUIStore((s) => s.showToast);

  const [state, setState] = useState<OfflineModeState>(() => offlineMode.getState());
  const [favState, setFavState] = useState<OfflineAutoDownloadState>(() => offlineAutoDownload.getState());
  const [usage, setUsage] = useState<StorageUsage>(EMPTY_USAGE);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await offlineStorage.getTotalStorageUsed());
    } catch {
      setUsage(EMPTY_USAGE);
    }
  }, []);

  useEffect(() => {
    void offlineMode.init();
    const unsubscribeMode = offlineMode.subscribe(setState);
    // Цифры «42 из 118» честные и при выключенной службе: считаем при открытии.
    void offlineAutoDownload.init().then(() => offlineAutoDownload.refreshStats());
    const unsubscribeFavorites = offlineAutoDownload.subscribe(setFavState);
    // Каждое сохранение и удаление меняет занятое место, поэтому цифра
    // пересчитывается по событию, а не по таймеру.
    const unsubscribeStorage = offlineStorage.subscribe(() => {
      void refreshUsage();
    });
    void refreshUsage();
    return () => {
      unsubscribeMode();
      unsubscribeFavorites();
      unsubscribeStorage();
    };
  }, [refreshUsage]);

  const handleToggle = useCallback(
    (enabled: boolean) => {
      void offlineMode.setEnabled(enabled).then(() => {
        showToast(
          enabled
            ? 'Офлайн-режим включён — прослушанное сохраняется автоматически'
            : 'Офлайн-режим выключен. Уже сохранённое осталось на месте',
          'success'
        );
      });
    },
    [showToast]
  );

  const handleLimitChange = useCallback(
    (raw: string) => {
      const bytes = Number(raw);
      void offlineMode.setLimitBytes(Number.isFinite(bytes) ? bytes : DEFAULT_OFFLINE_LIMIT_BYTES).then(() => {
        void refreshUsage();
      });
    },
    [refreshUsage]
  );

  const handleBitrateChange = useCallback((raw: string) => {
    const kbps = Number(raw);
    void offlineMode.setBitrateKbps(Number.isFinite(kbps) ? kbps : DEFAULT_OFFLINE_BITRATE_KBPS);
  }, []);

  const handleFavoritesToggle = useCallback(
    (enabled: boolean) => {
      void offlineAutoDownload.setEnabled(enabled).then(() => {
        showToast(
          enabled
            ? 'Избранное будет скачиваться само, по одному треку в фоне'
            : 'Автозагрузка избранного выключена. Скачанное осталось на месте',
          'success'
        );
      });
    },
    [showToast]
  );

  const handleFavoritesWifiOnly = useCallback((wifiOnly: boolean) => {
    void offlineAutoDownload.setWifiOnly(wifiOnly);
  }, []);

  const handleFavoritesLimitChange = useCallback((raw: string) => {
    const bytes = Number(raw);
    void offlineAutoDownload.setLimitBytes(Number.isFinite(bytes) ? bytes : DEFAULT_FAVORITES_LIMIT_BYTES);
  }, []);

  const handleDownloadNow = useCallback(() => {
    void offlineAutoDownload.runNow();
  }, []);

  const handleClear = useCallback(async () => {    setConfirmClearOpen(false);
    setIsClearing(true);
    try {
      await offlineStorage.clearAllOffline();
      await refreshUsage();
      showToast('Офлайн-кэш очищен', 'success');
    } catch {
      showToast('Не удалось очистить кэш', 'error');
    } finally {
      setIsClearing(false);
    }
  }, [refreshUsage, showToast]);

  const limitLabel =
    OFFLINE_LIMIT_OPTIONS.find((option) => option.bytes === state.limitBytes)?.label ??
    offlineStorage.formatBytes(state.limitBytes);

  const bitrateHint =
    OFFLINE_BITRATE_OPTIONS.find((option) => option.kbps === state.bitrateKbps)?.hint ?? '';

  const favLimitLabel =
    FAVORITES_LIMIT_OPTIONS.find((option) => option.bytes === favState.limitBytes)?.label ?? formatRuBytes(favState.limitBytes);
  // «1,3 ГБ из 5 ГБ»; без лимита вторая половина фразы не нужна.
  const favUsageText =
    favState.limitBytes > 0
      ? `${formatRuBytes(favState.usedBytes)} из ${favLimitLabel}`
      : formatRuBytes(favState.usedBytes);
  const favStatusDescription = favState.storageFull
    ? 'Место кончилось: остались только треки из избранного, их мы не удаляем. Поднимите лимит или уберите лишнее из избранного.'
    : favState.waitingForWifi
      ? 'Ждём Wi‑Fi: по сотовой сети избранное не качается.'
      : favState.downloadingTrackId
        ? `Сохраняется трек, в очереди ещё ${favState.queued}.`
        : favState.queued > 0
          ? `В очереди ${pluralize(favState.queued, 'трек', 'трека', 'треков')}.`
          : favState.favoritesTotal > 0
            ? 'Всё избранное уже на устройстве.'
            : 'В избранном пока пусто.';

  return (
    <SettingsSection
      id="offline"
      title="Офлайн-режим"
      description="Всё, что вы слушаете, остаётся доступным без интернета."
    >
      {/*
        * У тумблера была своя подпись: «Каждый включённый трек тихо оседает на диске
        * и в следующий раз играет из кэша — быстрее и без сети». Она пересказывала
        * описание раздела над ней, только длиннее и с оборотом «тихо оседает».
        * Одно и то же дважды подряд читается как заполнение места, поэтому у тумблера
        * осталось только название — а оно и есть описание действия.
        */}
      <ToggleSetting
        id="offline-mode-toggle"
        label="Сохранять прослушанное"
        checked={state.enabled}
        onChange={handleToggle}
      />

      <SettingRow
        label="Сколько места можно занять"
        controlId="offline-limit-select"
        description="Когда лимит достигнут, первыми уходят треки, которые дольше всех не включали."
      >
        <select
          id="offline-limit-select"
          value={String(state.limitBytes)}
          onChange={(e) => handleLimitChange(e.target.value)}
          data-testid="offline-limit-select"
          style={{ minWidth: '150px' }}
        >
          {OFFLINE_LIMIT_OPTIONS.map((option) => (
            <option key={option.label} value={String(option.bytes)}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="Качество сохранённого"
        controlId="offline-bitrate-select"
        description={
          state.compressionAvailable
            ? `Треки пережимаются в Opus. ${bitrateHint}`
            : 'В этой сборке пережимать нечем: треки сохраняются как есть.'
        }
      >
        <select
          id="offline-bitrate-select"
          value={String(state.bitrateKbps)}
          onChange={(e) => handleBitrateChange(e.target.value)}
          disabled={!state.compressionAvailable}
          data-testid="offline-bitrate-select"
          style={{ minWidth: '150px' }}
        >
          {OFFLINE_BITRATE_OPTIONS.map((option) => (
            <option key={option.label} value={String(option.kbps)}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <div className="divider" />

      {/*
        * Офлайн 2.0: не «что слушал», а «что отметил». Блок живёт в том же
        * разделе, потому что место на диске у них общее — лимит избранного
        * считается по всему офлайн-кэшу.
        */}
      <ToggleSetting
        id="offline-favorites-auto"
        label="Скачивать избранное само"
        description="Всё с сердечком появляется на устройстве — по одному треку, в фоне."
        checked={favState.enabled}
        onChange={handleFavoritesToggle}
      />

      {favState.wifiOnlyApplies && (
        <ToggleSetting
          id="offline-favorites-wifi"
          label="Только по Wi‑Fi"
          description="По сотовой сети очередь ждёт."
          checked={favState.wifiOnly}
          onChange={handleFavoritesWifiOnly}
        />
      )}

      <SettingRow
        label="Лимит места"
        controlId="offline-favorites-limit"
        description="Когда места нет, первыми уходят давно не слушанные треки не из избранного."
      >
        <select
          id="offline-favorites-limit"
          value={String(favState.limitBytes)}
          onChange={(e) => handleFavoritesLimitChange(e.target.value)}
          data-testid="offline-favorites-limit"
          style={{ minWidth: '150px' }}
        >
          {FAVORITES_LIMIT_OPTIONS.map((option) => (
            <option key={option.label} value={String(option.bytes)}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <InfoRow label="Избранное офлайн" description={favStatusDescription}>
        <span
          data-numeric
          data-testid="offline-favorites-status"
          className={`text-sm inline-row gap-2 ${favState.storageFull ? 'text-warning' : 'text-secondary'}`}
        >
          {favState.downloadingTrackId ? (
            <HardDriveDownload size={ICON.sm} aria-hidden="true" />
          ) : (
            <Heart size={ICON.sm} aria-hidden="true" />
          )}
          {favState.favoritesOffline} из {favState.favoritesTotal} · {favUsageText}
          {favState.downloadingTrackId ? ` · ${favState.downloadingProgress}%` : ''}
        </span>
      </InfoRow>

      {favState.lastError && (
        <div
          role="status"
          data-testid="offline-favorites-error"
          className="row gap-2 radius-sm text-xs text-secondary py-2 px-3 bg-surface-2 border-subtle"
        >
          <WifiOff size={ICON.sm} aria-hidden="true" className="shrink-0" />
          <span>Последняя проблема: {favState.lastError}</span>
        </div>
      )}

      <SettingRow
        label="Скачать сейчас"
        controlId="offline-favorites-download"
        description="Не ждать фона: пройти по избранному прямо сейчас."
      >
        <Button
          id="offline-favorites-download"
          variant="secondary"
          size="sm"
          icon={<HardDriveDownload size={ICON.sm} />}
          isLoading={favState.downloadingTrackId !== null}
          disabled={favState.queued === 0 && favState.downloadingTrackId === null}
          onClick={handleDownloadNow}
          data-testid="offline-favorites-download"
        >
          Скачать сейчас
        </Button>
      </SettingRow>

      <div className="divider" />

      <InfoRow
        label="Занято на устройстве"
        description={
          state.limitBytes > 0
            ? `Лимит: ${limitLabel}. Считается только офлайн-кэш, без плейлистов и истории.`
            : 'Лимит не задан: кэш растёт, пока есть место на диске.'
        }
      >
        <span
          data-numeric
          data-testid="offline-usage"
          className="text-sm text-secondary"
        >
          {usage.formattedSize} · {pluralize(usage.trackCount, 'трек', 'трека', 'треков')}
        </span>
      </InfoRow>

      {state.cachingTrackId && (
        <InfoRow
          label="Сохраняется сейчас"
          description={
            state.batchTotal > 0
              ? `Загрузка целиком: ${state.batchDone + 1} из ${state.batchTotal}.`
              : state.pendingCount > 0
                ? `В очереди ещё ${state.pendingCount}.`
                : 'Это последний трек в очереди.'
          }
        >
          <span
            data-numeric
            data-testid="offline-progress"
            className="text-sm text-accent inline-row gap-2"
          >
            <HardDriveDownload size={ICON.sm} aria-hidden="true" />
            {state.cachingProgress}%
          </span>
        </InfoRow>
      )}

      {state.lastError && (
        <div
          role="status"
          data-testid="offline-error"
          className="row gap-2 radius-sm text-xs text-secondary py-2 px-3 bg-surface-2 border-subtle"
        >
          <WifiOff size={ICON.sm} aria-hidden="true" className="shrink-0" />
          <span>Последняя проблема: {state.lastError}</span>
        </div>
      )}

      <SettingRow
        label="Очистить офлайн-кэш"
        controlId="offline-clear"
        description="Удаляет сохранённые копии. Плейлисты, избранное и история не тронуты."
      >
        <Button
          id="offline-clear"
          variant="danger"
          size="sm"
          icon={<Trash2 size={ICON.sm} />}
          isLoading={isClearing}
          disabled={usage.trackCount === 0}
          onClick={() => setConfirmClearOpen(true)}
          data-testid="offline-clear"
        >
          Очистить
        </Button>
      </SettingRow>

      <ConfirmDialog
        isOpen={confirmClearOpen}
        title="Очистить офлайн-кэш?"
        description={`С устройства будет удалено ${pluralize(usage.trackCount, 'сохранённый трек', 'сохранённых трека', 'сохранённых треков')} (${usage.formattedSize}). Онлайн они останутся доступны.`}
        confirmLabel="Очистить кэш"
        danger
        onConfirm={handleClear}
        onCancel={() => setConfirmClearOpen(false)}
      />
    </SettingsSection>
  );
};

export default OfflineSettings;
