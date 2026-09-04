import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Trash2,
  Play,
  Search,
  HardDrive,
  HardDriveDownload,
  Clock,
  WifiOff
} from 'lucide-react';
import { pluralize } from '../../utils/plural';
import { offlineStorage, OfflineTrackRecord } from '../../services/offlineStorage';
import { UnifiedTrack } from '../../types/music';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Skeleton } from '../common/Skeleton';
import { TrackCard } from '../search/TrackCard';
import { offlineMode, type OfflineModeState } from '../../services/offlineMode';
import { ICON } from '../../styles/icons';

export interface OfflineSectionProps {
  className?: string;
}

export const OfflineSection: React.FC<OfflineSectionProps> = ({ className = '' }) => {
  const [offlineRecords, setOfflineRecords] = useState<OfflineTrackRecord[]>([]);
  const [storageInfo, setStorageInfo] = useState<{ count: number; totalBytes: number; formattedSize: string }>({
    count: 0,
    totalBytes: 0,
    formattedSize: '0 B'
  });
  const [isLoading, setIsLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [isClearingAll, setIsClearingAll] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<{ id: string; title: string } | null>(null);
  const [modeState, setModeState] = useState<OfflineModeState>(() => offlineMode.getState());

  const playTrack = usePlayerStore((s) => s.playTrack);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const showToast = useUIStore((s) => s.showToast);

  const loadData = useCallback(async () => {
    try {
      const [records, usage] = await Promise.all([
        offlineStorage.getOfflineTracks(),
        offlineStorage.getTotalStorageUsed()
      ]);
      setOfflineRecords(records);
      setStorageInfo(usage);
    } catch (err) {
      console.error('[OfflineSection] Failed to load offline records:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    void offlineMode.init();
    const unsubscribe = offlineStorage.subscribe(() => {
      void loadData();
    });
    const unsubscribeMode = offlineMode.subscribe(setModeState);
    return () => {
      unsubscribe();
      unsubscribeMode();
    };
  }, [loadData]);

  const needle = query.trim().toLowerCase();

  const filteredRecords = useMemo(() => {
    if (!needle) return offlineRecords;
    return offlineRecords.filter(
      (r) =>
        r.track.title.toLowerCase().includes(needle) ||
        r.track.artist.toLowerCase().includes(needle)
    );
  }, [offlineRecords, needle]);

  const offlineTracks: UnifiedTrack[] = useMemo(
    () => filteredRecords.map((r) => r.track),
    [filteredRecords]
  );

  const handlePlayAll = async () => {
    if (offlineTracks.length === 0) return;
    await playTrack(offlineTracks[0], offlineTracks, 0);
  };

  const handleConfirmClearAll = async () => {
    setIsClearingAll(false);
    try {
      await offlineStorage.clearAllOffline();
      showToast('Офлайн-кэш очищен', 'info');
      await loadData();
    } catch (err) {
      console.error('[OfflineSection] Clear all error:', err);
      showToast('Не удалось очистить офлайн-кэш', 'error');
    }
  };

  const handleConfirmDeleteSingle = async () => {
    if (!pendingDeleteId) return;
    const { id, title } = pendingDeleteId;
    setPendingDeleteId(null);

    try {
      await offlineStorage.deleteOfflineTrack(id);
      showToast(`«${title}» удалён из офлайн-кэша`, 'info');
      await loadData();
    } catch (err) {
      console.error('[OfflineSection] Delete track error:', err);
      showToast(`Не удалось удалить «${title}»`, 'error');
    }
  };

  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', width: '100%' }}
      data-testid="offline-section"
    >
      {/* Header with stats and actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          flexWrap: 'wrap'
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--text-xl)',
              lineHeight: 'var(--leading-xl)',
              color: 'var(--text-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)'
            }}
          >
            <HardDrive size={ICON.lg} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
            Офлайн
          </h2>
          <p
            style={{
              margin: 'var(--space-1) 0 0 0',
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              color: 'var(--text-secondary)'
            }}
            data-testid="offline-storage-indicator"
          >
            {pluralize(storageInfo.count, 'трек', 'трека', 'треков')} · занято {storageInfo.formattedSize}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          {offlineRecords.length > 0 && (
            <>
              <Button
                variant="primary"
                size="sm"
                icon={<Play size={ICON.md} aria-hidden="true" />}
                onClick={handlePlayAll}
                data-testid="offline-play-all-btn"
              >
                Слушать всё
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={ICON.md} aria-hidden="true" />}
                onClick={() => setIsClearingAll(true)}
                data-testid="offline-clear-all-btn"
              >
                Очистить всё
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Whether the cache is still growing — the list alone cannot say that */}
      <div
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
        data-testid="offline-mode-status"
        data-enabled={modeState.enabled ? 'true' : 'false'}
      >
        {modeState.enabled ? (
          <HardDriveDownload size={ICON.sm} aria-hidden="true" style={{ color: 'var(--accent)', flexShrink: 0 }} />
        ) : (
          <WifiOff size={ICON.sm} aria-hidden="true" style={{ flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, minWidth: 0 }}>
          {modeState.enabled
            ? modeState.cachingTrackId
              ? `Сохраняем очередной трек — ${modeState.cachingProgress}%`
              : 'Офлайн-режим включён: всё прослушанное сохраняется автоматически'
            : 'Офлайн-режим выключен — новые треки не сохраняются'}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setActiveView('settings')}
          data-testid="offline-mode-settings-link"
        >
          Настроить
        </Button>
      </div>

      {/* Toolbar / Search input */}
      {offlineRecords.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flexWrap: 'wrap'
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              flex: '1 1 260px',
              maxWidth: '360px',
              padding: '0 var(--space-3)',
              backgroundColor: 'var(--surface-sunken)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)'
            }}
          >
            <Search size={ICON.md} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск среди офлайн-треков…"
              aria-label="Поиск среди офлайн-треков"
              style={{
                flex: 1,
                minWidth: 0,
                padding: 'var(--space-2) 0',
                background: 'transparent',
                border: 'none',
                fontSize: 'var(--text-sm)'
              }}
              data-testid="offline-search-input"
            />
          </label>
        </div>
      )}

      {/* Content list or empty state */}
      {isLoading ? (
        <Skeleton count={5} height={54} radius="var(--radius-sm)" />
      ) : offlineRecords.length === 0 ? (
        <EmptyState
          icon={<HardDrive size={ICON.display} />}
          title="Пока ничего не сохранено"
          description="Включите офлайн-режим в настройках — и всё, что вы слушаете, останется доступным без интернета."
          action={
            <Button variant="secondary" size="sm" onClick={() => setActiveView('settings')} data-testid="offline-open-settings">
              Открыть настройки офлайна
            </Button>
          }
          data-testid="offline-empty-state"
        />
      ) : filteredRecords.length === 0 ? (
        <EmptyState
          icon={<Clock size={ICON.display} />}
          title="Ничего не найдено"
          description={`Среди офлайн-треков нет ничего по запросу «${query}».`}
          data-testid="offline-no-matches"
        />
      ) : (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
          data-testid="offline-track-list"
        >
          {filteredRecords.map((record, index) => (
            <div
              key={record.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                position: 'relative'
              }}
              data-testid={`offline-track-row-${index}`}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <TrackCard
                  track={record.track}
                  index={index}
                  layout="row"
                  contextQueue={offlineTracks}
                  showIndex
                />
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  flexShrink: 0
                }}
              >
                <span
                  data-numeric
                  style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-muted)',
                    padding: 'var(--space-1) var(--space-2)',
                    backgroundColor: 'var(--surface-sunken)',
                    borderRadius: 'var(--radius-xs)',
                    border: '1px solid var(--border-subtle)'
                  }}
                  title={`Размер: ${offlineStorage.formatBytes(record.sizeBytes)}`}
                  data-testid={`offline-size-badge-${record.id}`}
                >
                  {offlineStorage.formatBytes(record.sizeBytes)}
                </span>

                <Button
                  variant="icon"
                  size="icon"
                  onClick={() =>
                    setPendingDeleteId({ id: record.id, title: record.track.title })
                  }
                  aria-label={`Удалить «${record.track.title}» из офлайн-кэша`}
                  title="Удалить офлайн-копию"
                  data-testid={`offline-delete-btn-${record.id}`}
                >
                  <Trash2 size={ICON.md} style={{ color: 'var(--text-secondary)' }} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirmation Dialogs */}
      <ConfirmDialog
        isOpen={isClearingAll}
        title="Очистить весь офлайн-кэш?"
        description="Все сохранённые аудиофайлы будут удалены с устройства. Плейлисты и избранное останутся на месте."
        confirmLabel="Очистить всё"
        danger
        onConfirm={() => void handleConfirmClearAll()}
        onCancel={() => setIsClearingAll(false)}
      />

      <ConfirmDialog
        isOpen={pendingDeleteId !== null}
        title={pendingDeleteId ? `Удалить «${pendingDeleteId.title}»?` : 'Удалить офлайн-копию?'}
        description="Копия трека удалится с устройства. Онлайн он останется доступен, а при включённом офлайн-режиме сохранится снова."
        confirmLabel="Удалить копию"
        danger
        onConfirm={() => void handleConfirmDeleteSingle()}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
};
