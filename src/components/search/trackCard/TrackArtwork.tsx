import React from 'react';
import { Music2 } from 'lucide-react';
import { UnifiedTrack } from '../../../types/music';
import { ICON } from '../../../styles/icons';
import type { HoverPreviewHandle } from '../../../hooks/useHoverPreview';
import { TrackPreviewRing } from './TrackPreviewRing';

export interface TrackArtworkProps {
  track: UnifiedTrack;
  size: number;
  radius: string;
  failed: boolean;
  onFailed: () => void;
  /** Превью по наведению (`useHoverPreview`); без него обложка просто картинка. */
  preview?: HoverPreviewHandle;
  children?: React.ReactNode;
}

/**
 * Square artwork with a matte fallback tile. A broken image renders an icon
 * rather than swapping in a data-URI so no colour is hardcoded here.
 *
 * Размер и скругление — из пропов, поэтому они и остаются инлайном: это
 * данные вызывающего, а не оформление.
 *
 * Наведение для превью слушает сама обложка, а не вся карточка: превью —
 * подсказка «что это за запись», и запускаться оно должно от жеста «смотрю на
 * обложку», а не от любого прохода курсора по строке к кнопке «ещё».
 */
export const TrackArtwork: React.FC<TrackArtworkProps> = ({ track, size, radius, failed, onFailed, preview, children }) => (
  <div
    className="relative shrink-0 overflow-hidden row justify-center bg-sunken border-subtle" style={{ width: size, height: size, borderRadius: radius }}
    onPointerEnter={preview?.onPointerEnter}
    onPointerLeave={preview?.onPointerLeave}
    data-previewing={preview?.isPreviewing ? 'true' : undefined}
    data-testid={`track-cover-${track.id}`}
  >
    {failed || !track.artworkUrl ? (
      // Размер по шкале, а не 40% от плитки.
      //
      // `Math.round(size * 0.4)` давал 16, 53 и 64 px на трёх вызовах — три
      // размера вне шкалы ICON, а значит и вне рампы `stroke-width` в global.css
      // §7: у 53 и 64 штрих истончался до декоративного волоска, тогда как в
      // строке рядом иконки нормальной толщины. Плиток ровно два вида — строка
      // (40) и карточка (132/160), поэтому и размеров хватает двух.
      <Music2
        size={size >= 96 ? ICON.hero : ICON.md}
        className="text-faint"
        aria-hidden="true"
      />
    ) : (
      <img
        src={track.artworkUrl}
        alt=""
        loading="lazy"
        className="fill-cover"
        onError={onFailed}
      />
    )}
    {children}
    {preview?.isPreviewing && <TrackPreviewRing progress={preview.progress} size={size} />}
  </div>
);
