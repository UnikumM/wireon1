import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { previewPlayer } from '../services/previewPlayer';
import { usePreviewStore } from '../store/usePreviewStore';
import type { UnifiedTrack } from '../types/music';

export interface HoverPreviewHandle {
  onPointerEnter: (e?: { pointerType?: string }) => void;
  onPointerLeave: () => void;
  /** Превью именно этого трека сейчас звучит. */
  isPreviewing: boolean;
  /** 0…1 — доля прошедших десяти секунд. */
  progress: number;
}

const NOOP_HANDLE: Pick<HoverPreviewHandle, 'isPreviewing' | 'progress'> = { isPreviewing: false, progress: 0 };

/**
 * Превью по наведению на обложку — см. `services/previewPlayer.ts`.
 *
 * `enabled: false` — на телефоне: там долгое нажатие уже открывает действия,
 * а «наведения» нет. Флаг приходит пропом, а не из `useMobileShell` внутри:
 * хук зовётся на каждую строку списка, и своя подписка на медиазапрос в каждой
 * из сотни строк стоила бы дороже, чем решает (см. `TrackCardProps.heroStacked`).
 */
export function useHoverPreview(track: UnifiedTrack, enabled = true): HoverPreviewHandle {
  const previewOnHover = usePreviewStore((s) => s.previewOnHover);
  const hydrate = usePreviewStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const state = useSyncExternalStore(previewPlayer.subscribe, previewPlayer.getState, previewPlayer.getState);
  const active = enabled && previewOnHover;
  const trackId = track?.id;

  const onPointerEnter = useCallback(
    (e?: { pointerType?: string }) => {
      if (!active) return;
      // Касание на ПК с сенсорным экраном — это нажатие, а не наведение.
      if (e?.pointerType === 'touch') return;
      previewPlayer.request(track);
    },
    [active, track]
  );

  const onPointerLeave = useCallback(() => {
    if (trackId) previewPlayer.cancel(trackId);
  }, [trackId]);

  // Строка исчезла из списка (поиск сменился) — её превью не должно доиграть вслепую.
  useEffect(
    () => () => {
      if (trackId) previewPlayer.cancel(trackId);
    },
    [trackId]
  );

  const mine = trackId !== undefined && state.trackId === trackId;
  return {
    onPointerEnter,
    onPointerLeave,
    ...(mine ? { isPreviewing: state.status === 'playing', progress: state.progress } : NOOP_HANDLE)
  };
}
