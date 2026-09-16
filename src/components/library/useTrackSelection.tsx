import React, { useCallback, useMemo } from 'react';
import { Download, HeartOff, ListPlus } from 'lucide-react';
import { SelectionBar, SelectionActionSpec } from '../common/SelectionBar';
import { useAddToPlaylist } from './AddToPlaylistModal';
import { useUIStore } from '../../store/useUIStore';
import { offlineMode } from '../../services/offlineMode';
import { UnifiedTrack } from '../../types/music';
import { pluralize } from '../../utils/plural';
import { ICON } from '../../styles/icons';

/**
 * Выбор пачки треков в списке — на большом экране.
 *
 * Общий узел, потому что списков несколько (избранное, недавнее, плейлист), а
 * действия над выбранным у них одни и те же. Раньше панель выбора стояла только
 * в плейлисте и умела лишь скачать и убрать: перенести выбранное в другой
 * плейлист на компьютере было нечем, хотя на телефоне это было.
 */
export interface TrackSelectionOptions {
  /** Весь список, из которого выбирают: по нему работает «Выбрать все». */
  tracks: ReadonlyArray<UnifiedTrack>;
  testId: string;
  /** Убрать выбранное отсюда. Нет — кнопки не будет (из недавнего убирать нечего). */
  onRemove?: (tracks: UnifiedTrack[]) => Promise<void> | void;
  removeLabel?: string;
}

export interface TrackSelectionResult {
  /** Панель с кнопками. Рисуется над списком; сама прячется, когда выбора нет. */
  bar: React.ReactNode;
  /** Окно выбора плейлиста. Рисуется где угодно в том же дереве. */
  modal: React.ReactNode;
  /** Включить режим выбора — кнопка «Выбрать» в шапке списка. */
  start: () => void;
  /** Выйти из режима выбора. */
  clear: () => void;
  /** Идёт ли выбор сейчас: кнопка в шапке меняет подпись. */
  active: boolean;
}

export function useTrackSelection({
  tracks,
  testId,
  onRemove,
  removeLabel = 'Убрать'
}: TrackSelectionOptions): TrackSelectionResult {
  const selectedTrackIds = useUIStore((s) => s.selectedTrackIds);
  const startSelection = useUIStore((s) => s.startSelection);
  const clearSelection = useUIStore((s) => s.clearSelection);
  const showToast = useUIStore((s) => s.showToast);
  const picker = useAddToPlaylist();

  const selectedTracks = useMemo(() => {
    if (!selectedTrackIds || selectedTrackIds.length === 0) return [];
    const chosen = new Set(selectedTrackIds);
    return tracks.filter((track) => chosen.has(track.id));
  }, [selectedTrackIds, tracks]);

  const handleSave = useCallback(async () => {
    if (selectedTracks.length === 0) return;
    const added = await offlineMode.queueTracks(selectedTracks).catch(() => 0);
    showToast(
      added > 0
        ? `${pluralize(added, 'трек', 'трека', 'треков')} в очереди на сохранение`
        : 'Всё выбранное уже сохранено',
      added > 0 ? 'success' : 'info'
    );
    clearSelection();
  }, [clearSelection, selectedTracks, showToast]);

  const handleRemove = useCallback(async () => {
    if (selectedTracks.length === 0 || !onRemove) return;
    await onRemove([...selectedTracks]);
    clearSelection();
  }, [clearSelection, onRemove, selectedTracks]);

  const actions: SelectionActionSpec[] = [
    {
      icon: <ListPlus size={ICON.sm} />,
      label: 'В плейлист',
      onClick: () => picker.openMany(selectedTracks),
      testId: `${testId}-move`
    },
    {
      icon: <Download size={ICON.sm} />,
      label: 'Скачать',
      onClick: () => void handleSave(),
      testId: `${testId}-save`
    }
  ];

  if (onRemove) {
    actions.push({
      icon: <HeartOff size={ICON.sm} />,
      label: removeLabel,
      danger: true,
      onClick: () => void handleRemove(),
      testId: `${testId}-remove`
    });
  }

  return {
    bar: (
      <SelectionBar
        total={tracks.length}
        allIds={tracks.map((track) => track.id)}
        testId={testId}
        actions={actions}
      />
    ),
    modal: picker.element,
    start: () => startSelection(),
    clear: () => clearSelection(),
    active: selectedTrackIds !== null
  };
}
