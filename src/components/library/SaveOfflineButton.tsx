import React, { useCallback, useEffect, useState } from 'react';
import { HardDriveDownload, Check, X } from 'lucide-react';
import { Button } from '../common/Button';
import { useUIStore } from '../../store/useUIStore';
import { pluralize } from '../../utils/plural';
import { offlineStorage } from '../../services/offlineStorage';
import { offlineMode, type OfflineModeState } from '../../services/offlineMode';
import type { UnifiedTrack } from '../../types/music';
import { ICON } from '../../styles/icons';

export interface SaveOfflineButtonProps {
  tracks: ReadonlyArray<UnifiedTrack>;
  /** Что подставить в подсказку: «плейлист», «избранное». */
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
  'data-testid'?: string;
}

/**
 * «Сохранить в офлайн» для целого списка.
 *
 * Автосохранение прослушанного покрывает обычный случай, но не тот, ради
 * которого офлайн вообще включают: перед дорогой человек хочет забрать плейлист
 * целиком, не прослушав его весь заранее. Эта кнопка ставит список в ту же
 * очередь и, в отличие от автосохранения, работает независимо от переключателя —
 * это прямая просьба, а не побочный эффект.
 *
 * Кнопка не ждёт окончания загрузки: она отдаёт очереди список и сразу
 * превращается в живой счётчик, потому что сотня треков — это минуты, и держать
 * человека в модальном ожидании нечего.
 */
export const SaveOfflineButton: React.FC<SaveOfflineButtonProps> = ({
  tracks,
  label = 'плейлист',
  size = 'md',
  className = '',
  'data-testid': testId = 'save-offline-btn'
}) => {
  const showToast = useUIStore((s) => s.showToast);
  const [state, setState] = useState<OfflineModeState>(() => offlineMode.getState());
  const [isQueueing, setIsQueueing] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  useEffect(() => {
    void offlineMode.init();
    return offlineMode.subscribe(setState);
  }, []);

  // Сколько из этого списка уже лежит на диске — считаем один раз на список,
  // чтобы не обещать сохранить то, что и так сохранено.
  useEffect(() => {
    let cancelled = false;
    const ids = tracks.map((track) => track?.id).filter(Boolean) as string[];
    if (ids.length === 0) {
      setSavedCount(0);
      return;
    }
    void (async () => {
      let saved = 0;
      for (const id of ids) {
        if (await offlineStorage.isDownloaded(id)) saved += 1;
      }
      if (!cancelled) setSavedCount(saved);
    })();
    return () => {
      cancelled = true;
    };
    // Пересчитываем при смене состава и после каждой удачной загрузки:
    // `batchTotal` падает в ноль ровно тогда, когда очередь опустела.
  }, [tracks, state.batchTotal]);

  const handleSave = useCallback(async () => {
    setIsQueueing(true);
    try {
      const added = await offlineMode.queueTracks(tracks);
      if (added === 0) {
        showToast('Всё из этого списка уже сохранено', 'info');
        return;
      }
      showToast(
        `${added} ${pluralize(added, 'трек', 'трека', 'треков')} в очереди на сохранение`,
        'success'
      );
    } catch {
      showToast('Не удалось поставить треки в очередь', 'error');
    } finally {
      setIsQueueing(false);
    }
  }, [tracks, showToast]);

  const handleCancel = useCallback(() => {
    offlineMode.cancelBatch();
    showToast('Загрузка в офлайн остановлена', 'info');
  }, [showToast]);

  if (tracks.length === 0) return null;

  // Пока очередь идёт, та же кнопка показывает прогресс и отменяет: две кнопки
  // рядом на одно действие путали бы.
  if (state.batchTotal > 0) {
    return (
      <Button
        variant="secondary"
        size={size}
        className={className}
        icon={<X size={ICON.md} aria-hidden="true" />}
        onClick={handleCancel}
        title="Остановить сохранение"
        data-testid={`${testId}-cancel`}
      >
        {state.batchDone} из {state.batchTotal} · Отменить
      </Button>
    );
  }

  const allSaved = savedCount !== null && savedCount >= tracks.length;

  return (
    <Button
      variant="secondary"
      size={size}
      className={className}
      icon={
        allSaved ? (
          <Check size={ICON.md} aria-hidden="true" />
        ) : (
          <HardDriveDownload size={ICON.md} aria-hidden="true" />
        )
      }
      isLoading={isQueueing}
      disabled={allSaved}
      onClick={() => void handleSave()}
      title={
        allSaved
          ? `Весь ${label} уже доступен без интернета`
          : `Сохранить ${label} на устройство, чтобы слушать без интернета`
      }
      data-testid={testId}
    >
      {allSaved ? 'В офлайне' : 'В офлайн'}
    </Button>
  );
};

export default SaveOfflineButton;
