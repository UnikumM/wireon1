import React, { useCallback, useEffect, useState } from 'react';
import { HardDriveDownload, Trash2, WifiOff } from 'lucide-react';
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
    // Каждое сохранение и удаление меняет занятое место, поэтому цифра
    // пересчитывается по событию, а не по таймеру.
    const unsubscribeStorage = offlineStorage.subscribe(() => {
      void refreshUsage();
    });
    void refreshUsage();
    return () => {
      unsubscribeMode();
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
          style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
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
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--accent)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)'
            }}
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
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-secondary)'
          }}
        >
          <WifiOff size={ICON.sm} aria-hidden="true" style={{ flexShrink: 0 }} />
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
