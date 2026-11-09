import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../../utils/time';

const KEYBOARD_SEEK_STEP_SECONDS = 5;

/** Высота в единицах viewBox; на экране SVG растянут CSS-правилом `.waveform-bar`. */
const VIEW_HEIGHT = 32;

/** Зазор между столбиками в долях шага — чтобы форма читалась как ряд, а не как заливка. */
const BAR_GAP = 0.35;

/** Тихие места всё равно оставляют точку: иначе дорожка в паузах исчезает совсем. */
const MIN_BAR = 0.08;

export interface WaveformBarProps {
  /** Столбики 0..1 из `services/waveform`. */
  samples: number[];
  /** Пройденная доля трека 0..1. */
  progress: number;
  /** Длительность в секундах — для aria и шага стрелок. */
  duration: number;
  /** Перемотка к доле трека 0..1. */
  onSeek: (fraction: number) => void;
  /** Доля под пальцем во время протаскивания; null — палец отпущен. */
  onScrub?: (fraction: number | null) => void;
  idPrefix?: string;
  className?: string;
}

const clampFraction = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Форма волны вместо ровной полосы прогресса.
 *
 * Один SVG и один набор прямоугольников в `<defs>`: он рисуется дважды через
 * `<use>` — серым целиком и акцентом под маской пройденной части. Так в DOM
 * сто двадцать узлов, а не двести сорок, и прогресс двигается с точностью до
 * пикселя, а не столбика. Цвета — в CSS токенами, чтобы тема и акцент
 * доходили до дорожки так же, как до остального плеера.
 *
 * Контракт ползунка тот же, что у SeekBar: role="slider", стрелки на ±5 с,
 * Home/End, перемотка кликом и протаскиванием. Роль ещё и отключает жест
 * закрытия листа, который иначе ловил бы это же движение.
 */
export const WaveformBar: React.FC<WaveformBarProps> = ({
  samples,
  progress,
  duration,
  onSeek,
  onScrub,
  idPrefix = 'player',
  className = ''
}) => {
  const [scrubFraction, setScrubFraction] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Обработчик отпускания живёт на window и должен видеть долю того же тика.
  const scrubRef = useRef<number | null>(null);

  const bars = samples.length;
  const seekable = duration > 0 && bars > 0;
  const shown = clampFraction(scrubFraction ?? progress);
  const shownSeconds = shown * duration;

  const fractionAt = (event: React.PointerEvent<SVGSVGElement>): number | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return null;
    return clampFraction((event.clientX - rect.left) / rect.width);
  };

  const commitScrub = useCallback(() => {
    const fraction = scrubRef.current;
    scrubRef.current = null;
    setScrubFraction(null);
    onScrub?.(null);
    if (fraction !== null) onSeek(fraction);
  }, [onSeek, onScrub]);

  // Палец часто уходит с дорожки раньше, чем его отпускают.
  useEffect(() => {
    if (scrubFraction === null || typeof window === 'undefined') return;

    window.addEventListener('pointerup', commitScrub);
    window.addEventListener('pointercancel', commitScrub);
    return () => {
      window.removeEventListener('pointerup', commitScrub);
      window.removeEventListener('pointercancel', commitScrub);
    };
  }, [scrubFraction, commitScrub]);

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!seekable) return;
    const fraction = fractionAt(event);
    if (fraction === null) return;
    // Захват нужен на телефоне, чтобы движение за край дорожки не терялось;
    // в тестовом DOM метода нет, и без него всё равно работает слушатель на window.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* ничего: окно подхватит отпускание */
      }
    }
    scrubRef.current = fraction;
    setScrubFraction(fraction);
    setHoverIndex(null);
    onScrub?.(fraction);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!seekable) return;
    const fraction = fractionAt(event);
    if (fraction === null) return;
    if (scrubRef.current !== null) {
      scrubRef.current = fraction;
      setScrubFraction(fraction);
      onScrub?.(fraction);
      return;
    }
    setHoverIndex(Math.min(bars - 1, Math.floor(fraction * bars)));
  };

  const handleKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (!seekable) return;

    const base = shownSeconds;
    let targetSeconds: number | null = null;

    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        targetSeconds = base - KEYBOARD_SEEK_STEP_SECONDS;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        targetSeconds = base + KEYBOARD_SEEK_STEP_SECONDS;
        break;
      case 'Home':
        targetSeconds = 0;
        break;
      case 'End':
        targetSeconds = duration;
        break;
      default:
        return;
    }

    event.preventDefault();
    onSeek(clampFraction(targetSeconds / duration));
  };

  const shapeId = `${idPrefix}-waveform-shape`;
  const clipId = `${idPrefix}-waveform-clip`;
  const barWidth = 1 - BAR_GAP;

  return (
    <svg
      role="slider"
      tabIndex={seekable ? 0 : -1}
      aria-label="Перемотка по треку"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={seekable ? Math.floor(duration) : 0}
      aria-valuenow={Math.floor(shownSeconds)}
      aria-valuetext={
        seekable
          ? `${formatDuration(shownSeconds)} из ${formatDuration(duration)}`
          : 'Позиция неизвестна — длительность ещё не загрузилась'
      }
      aria-disabled={seekable ? undefined : true}
      data-testid={`${idPrefix}-seek-slider`}
      data-scrubbing={scrubFraction !== null ? 'true' : undefined}
      className={`waveform-bar ${className}`.trim()}
      viewBox={`0 0 ${bars} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHoverIndex(null)}
      onKeyDown={handleKeyDown}
    >
      <defs>
        <g id={shapeId}>
          {samples.map((sample, index) => {
            const height = Math.max(MIN_BAR, Math.min(1, sample)) * VIEW_HEIGHT;
            return (
              <rect
                key={index}
                x={index + BAR_GAP / 2}
                y={(VIEW_HEIGHT - height) / 2}
                width={barWidth}
                height={height}
              />
            );
          })}
        </g>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={shown * bars} height={VIEW_HEIGHT} />
        </clipPath>
      </defs>

      <use href={`#${shapeId}`} className="waveform-bar-rest" />
      <use href={`#${shapeId}`} className="waveform-bar-played" clipPath={`url(#${clipId})`} />

      {hoverIndex !== null && (
        <rect
          className="waveform-bar-hover"
          data-testid={`${idPrefix}-waveform-hover`}
          x={hoverIndex + BAR_GAP / 2}
          y={(VIEW_HEIGHT - Math.max(MIN_BAR, Math.min(1, samples[hoverIndex])) * VIEW_HEIGHT) / 2}
          width={barWidth}
          height={Math.max(MIN_BAR, Math.min(1, samples[hoverIndex])) * VIEW_HEIGHT}
        />
      )}
    </svg>
  );
};
