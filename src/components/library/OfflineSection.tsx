import React, { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  Trash2,
  Play,
  Search,
  HardDrive,
  HardDriveDownload,
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
      className={clsx('stack gap-4 w-full', className)}
      data-testid="offline-section"
    >
      {/* Header with stats and actions */}
      <div
        className="row justify-between gap-4 wrap"
      >
        <div>
          <h2
            className="m-0 text-xl text-primary row gap-2 leading-xl"
          >
            <HardDrive size={ICON.lg} className="text-secondary" aria-hidden="true" />
            Офлайн
          </h2>
          <p
            className="text-sm text-secondary leading-sm" style={{ margin: 'var(--space-1) 0 0 0' }}
            data-testid="offline-storage-indicator"
          >
            {pluralize(storageInfo.count, 'трек', 'трека', 'треков')} · занято {storageInfo.formattedSize}
          </p>
        </div>

        <div className="row gap-2">
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
        className="row gap-2 radius-sm text-xs text-secondary py-2 px-3 bg-surface-2 border-subtle"
        data-testid="offline-mode-status"
        data-enabled={modeState.enabled ? 'true' : 'false'}
      >
        {modeState.enabled ? (
          <HardDriveDownload size={ICON.sm} aria-hidden="true" className="text-accent shrink-0" />
        ) : (
          <WifiOff size={ICON.sm} aria-hidden="true" className="shrink-0" />
        )}
        <span className="grow">
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
          className="row gap-3 wrap"
        >
          <label
            className="search-field row gap-2 py-0 px-3"
            style={{ flex: '1 1 260px', maxWidth: '360px' }}
          >
            <Search size={ICON.md} aria-hidden="true" className="text-muted shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск среди офлайн-треков…"
              aria-label="Поиск среди офлайн-треков"
              className="grow text-sm py-2 px-0 bg-transparent border-none"
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
          art="offline"
          title="Здесь будет музыка без интернета"
          description="Включите офлайн-режим, и прослушанное останется на устройстве."
          action={{
            label: 'Открыть настройки офлайна',
            onClick: () => setActiveView('settings'),
            'data-testid': 'offline-open-settings'
          }}
          data-testid="offline-empty-state"
        />
      ) : filteredRecords.length === 0 ? (
        <EmptyState
          art="search"
          title="Ничего не нашлось"
          description={`Среди офлайн-треков нет ничего по запросу «${query}».`}
          action={{ label: 'Сбросить поиск', onClick: () => setQuery('') }}
          data-testid="offline-no-matches"
        />
      ) : (
        <div
          className="stack gap-1"
          data-testid="offline-track-list"
        >
          {filteredRecords.map((record, index) => (
            <div
              key={record.id}
              className="row gap-2 relative"
              data-testid={`offline-track-row-${index}`}
            >
              <div className="grow">
                <TrackCard
                  track={record.track}
                  index={index}
                  layout="row"
                  contextQueue={offlineTracks}
                  showIndex
                />
              </div>

              <div
                className="row gap-2 shrink-0"
              >
                <span
                  data-numeric
                  className="text-xs text-muted radius-xs py-1 px-2 bg-sunken border-subtle"
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
                  <Trash2 size={ICON.md} className="text-secondary" />
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
