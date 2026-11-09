import React from 'react';
import { Volume2 } from 'lucide-react';
import { ICON } from '../../../styles/icons';

export interface TrackPreviewRingProps {
  /** 0…1 — доля прошедших десяти секунд превью. */
  progress: number;
  /** Сторона обложки, px: от неё зависит размер значка (строка — 40, карточка — 120+). */
  size: number;
}

/** Геометрия круга в единицах viewBox; толщина штриха — в CSS. */
const RADIUS = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Кольцо прогресса превью поверх обложки: тонкая окружность акцентным цветом
 * закрывается за десять секунд, в центре — динамик. Не ловит указатель, чтобы
 * уход курсора с обложки доходил до её обработчика и превью останавливалось.
 *
 * `strokeDashoffset` — единственный инлайн: он считается из данных (прогресса),
 * остальное оформление — в `.preview-ring*` в global.css.
 */
export const TrackPreviewRing: React.FC<TrackPreviewRingProps> = ({ progress, size }) => {
  const clamped = Math.max(0, Math.min(1, progress));
  return (
    <div className="preview-ring" aria-hidden="true" data-testid="preview-ring">
      <svg className="preview-ring-svg" viewBox="0 0 36 36">
        <circle className="preview-ring-track" cx="18" cy="18" r={RADIUS} />
        <circle
          className="preview-ring-bar"
          cx="18"
          cy="18"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          style={{ strokeDashoffset: CIRCUMFERENCE * (1 - clamped) }}
        />
      </svg>
      <Volume2 size={size >= 96 ? ICON.lg : ICON.xs} className="preview-ring-icon" />
    </div>
  );
};
