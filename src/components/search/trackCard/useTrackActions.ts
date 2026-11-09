import React, { useCallback } from 'react';
import { UnifiedTrack } from '../../../types/music';
import { usePlayerStore } from '../../../store/usePlayerStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useUIStore, refusedForAccount } from '../../../store/useUIStore';
import { shareTrack } from '../../../services/shareTrack';

const SOURCE_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
};

/** Opens a source page in the system browser, falling back to the web build. */
function openSourceUrl(url: string): void {
  const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (bridge && typeof bridge.openExternal === 'function') {
    void Promise.resolve(bridge.openExternal(url)).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export interface UseTrackActionsOptions {
  track: UnifiedTrack;
  index?: number;
  contextQueue?: UnifiedTrack[];
  onPlay?: (track: UnifiedTrack, queue?: UnifiedTrack[], index?: number) => void;
  /** Пункты меню закрывают его перед действием — см. `useTrackMenu`. */
  closeMenu: (restoreFocus?: boolean) => void;
  /** Окно выбора плейлиста — `useAddToPlaylist().open`. */
  openPlaylistPicker: (track: UnifiedTrack) => void;
}

export interface TrackActions {
  isCurrent: boolean;
  isTrackPlaying: boolean;
  isFavorite: boolean;
  /** `null` — обычный режим; массив — идёт выбор пачкой. */
  selectedTrackIds: string[] | null;
  isSelected: boolean;
  /** «YouTube»/«SoundCloud» для пункта «Открыть в …». */
  sourceLabel: string;
  activate: () => void;
  handleActivateClick: (e: React.MouseEvent) => void;
  handleRowKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  handleArtistClick: (e: React.MouseEvent) => void;
  handleFavoriteClick: (e: React.MouseEvent) => Promise<void>;
  handleAddToQueue: (e: React.MouseEvent) => void;
  handlePlayNext: (e: React.MouseEvent) => void;
  handleStartTrackRadio: (e: React.MouseEvent) => void;
  handleAddToQueueFromMenu: (e: React.MouseEvent) => void;
  handleFavoriteFromMenu: (e: React.MouseEvent) => Promise<void>;
  handleOpenPlaylistPicker: (e: React.MouseEvent) => void;
  handleShare: (e: React.MouseEvent) => Promise<void>;
  handleOpenSource: (e: React.MouseEvent) => void;
  /** Окно «Теги и заметка» — живёт в сторе интерфейса, как лист действий. */
  handleOpenNotes: (e: React.MouseEvent) => void;
  handleStartSelection: () => void;
}

/**
 * Всё, что карточка умеет делать с треком: играть, отмечать, ставить в
 * очередь, делиться, звать окно плейлиста, входить в режим выбора.
 *
 * Подписки на сторы живут здесь же, а не в контейнере: обработчикам нужны те
 * же значения (`isCurrent`, `isFavorite`, режим выбора), и разносить их по двум
 * файлам значило бы передавать полдюжины флагов туда-обратно.
 */
export function useTrackActions({
  track,
  index,
  contextQueue,
  onPlay,
  closeMenu,
  openPlaylistPicker,
}: UseTrackActionsOptions): TrackActions {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const addToQueueEnd = usePlayerStore((s) => s.addToQueueEnd);
  const addToQueueNext = usePlayerStore((s) => s.addToQueueNext);

  const isFavorite = useLibraryStore((s) => s.isFavorite(track.id));
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);

  const showToast = useUIStore((s) => s.showToast);
  const openArtist = useUIStore((s) => s.openArtist);
  const startSelection = useUIStore((s) => s.startSelection);
  const selectedTrackIds = useUIStore((s) => s.selectedTrackIds);
  const toggleSelected = useUIStore((s) => s.toggleSelected);
  const isSelected = selectedTrackIds?.includes(track.id) ?? false;

  const isCurrent = currentTrack?.id === track.id;
  const isTrackPlaying = isCurrent && isPlaying;
  const sourceLabel = SOURCE_LABELS[track.source] ?? track.source;

  const handleArtistClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (track.artist) {
      openArtist(track.artist);
    }
  };

  /**
   * Play resolution order, fixed by `.agents/CONTRACT.md`:
   * 1. `contextQueue` -> the whole list becomes the queue
   * 2. `onPlay` -> caller decides
   * 3. bare `playTrack`
   */
  const startPlayback = useCallback(() => {
    if (contextQueue) {
      void playTrack(track, contextQueue, index);
      return;
    }
    if (onPlay) {
      onPlay(track);
      return;
    }
    void playTrack(track);
  }, [contextQueue, index, onPlay, playTrack, track]);

  const activate = useCallback(() => {
    // В режиме выбора у нажатия по строке один смысл — отметить. Играть в это
    // время нельзя: человек собирает пачку, а не слушает.
    if (selectedTrackIds !== null) {
      toggleSelected(track.id);
      return;
    }
    if (isCurrent) {
      void togglePlayPause();
      return;
    }
    startPlayback();
  }, [isCurrent, selectedTrackIds, startPlayback, toggleSelected, togglePlayPause, track.id]);

  const handleActivateClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    activate();
  };

  /** Enter/Space on the row itself; inner buttons keep their own behaviour. */
  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      activate();
    }
  };

  const handleFavoriteClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const wasFavorite = isFavorite;
    const ok = await toggleFavorite(track);
    if (!ok) {
      // Приглашение войти уже на экране — красной строкой поверх него незачем.
      if (refusedForAccount()) return;
      showToast(useLibraryStore.getState().error || 'Не удалось обновить избранное', 'error');
      return;
    }
    showToast(
      wasFavorite ? `«${track.title}» убран из избранного` : `«${track.title}» в избранном`,
      'success'
    );
  };

  const handleAddToQueue = (e: React.MouseEvent) => {
    e.stopPropagation();
    addToQueueEnd(track);
    showToast(`«${track.title}» добавлен в очередь`, 'info');
  };

  const handlePlayNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    addToQueueNext(track);
    showToast(`«${track.title}» прозвучит следующим`, 'info');
  };

  const handleStartTrackRadio = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    void usePlayerStore.getState().startTrackRadio(track);
    showToast(`Запущено радио по треку "${track.title}"`, 'success');
  };

  const handleAddToQueueFromMenu = (e: React.MouseEvent) => {
    closeMenu();
    handleAddToQueue(e);
  };

  const handleFavoriteFromMenu = async (e: React.MouseEvent) => {
    closeMenu();
    await handleFavoriteClick(e);
  };

  const handleOpenPlaylistPicker = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    openPlaylistPicker(track);
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    const outcome = await shareTrack(track);
    const ui = useUIStore.getState();
    if (outcome === 'copied') ui.showToast('Ссылка на трек скопирована', 'success');
    else if (outcome === 'failed') ui.showToast('Не удалось поделиться — буфер обмена недоступен', 'error');
  };

  const handleOpenSource = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu();
    if (track.sourceUrl) openSourceUrl(track.sourceUrl);
  };

  const handleOpenNotes = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenu(false);
    useUIStore.getState().openTrackNotes(track);
  };

  /*
   * Вход в выбор пачкой из меню: найдя нужный трек, человек не должен
   * закрывать его меню и искать этот же трек заново уже в режиме выбора.
   * Отмечается сразу тот, из которого позвали; фокус на кнопку не возвращаем —
   * он уйдёт в панель выбора.
   */
  const handleStartSelection = () => {
    startSelection(track.id);
    closeMenu(false);
  };

  return {
    isCurrent,
    isTrackPlaying,
    isFavorite,
    selectedTrackIds,
    isSelected,
    sourceLabel,
    activate,
    handleActivateClick,
    handleRowKeyDown,
    handleArtistClick,
    handleFavoriteClick,
    handleAddToQueue,
    handlePlayNext,
    handleStartTrackRadio,
    handleAddToQueueFromMenu,
    handleFavoriteFromMenu,
    handleOpenPlaylistPicker,
    handleShare,
    handleOpenSource,
    handleOpenNotes,
    handleStartSelection,
  };
}
