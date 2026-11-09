import { useLibraryStore } from '../../../store/useLibraryStore';
import { refusedForAccount, useUIStore } from '../../../store/useUIStore';
import type { UnifiedTrack } from '../../../types/music';

/**
 * «В избранное» для играющего трека: состояние, переключение и отклик.
 *
 * Было три копии этой логики с тремя разными текстами тостов. Текст один:
 * трек «добавлен»/«убран», и молчание, если отказ пришёл из-за отсутствия
 * аккаунта — об этом уже спросил экран входа, второе сообщение лишнее.
 */
export function useFavoriteToggle(track: UnifiedTrack | null) {
  const isFavorite = useLibraryStore((s) => (track ? s.isFavorite(track.id) : false));
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const showToast = useUIStore((s) => s.showToast);

  const toggle = async (): Promise<void> => {
    if (!track) return;
    const wasFavorite = isFavorite;
    const ok = await toggleFavorite(track);
    if (!ok) {
      if (refusedForAccount()) return;
      showToast('Не удалось обновить избранное', 'error');
      return;
    }
    showToast(
      wasFavorite ? `«${track.title}» убрана из избранного` : `«${track.title}» добавлена в избранное`,
      'success'
    );
  };

  const label = isFavorite ? 'Убрать из избранного' : 'В избранное';

  return { isFavorite, toggle, label };
}
