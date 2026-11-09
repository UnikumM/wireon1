import { formatDuration } from '../utils/time';

/**
 * Точная перемотка пальцем — арифметика жеста, без DOM и без React.
 *
 * Идея из старого iPod: палец ведёт по обложке влево-вправо, и чем ниже он
 * уходит от точки, где начал, тем медленнее идёт время под ним. Четыре зоны:
 * «обычная» — вся ширина обложки равна всему треку, дальше вполовину, в
 * четверть и в десятую. Так одним движением можно и перелететь на три минуты,
 * и попасть в нужную секунду.
 *
 * Хук `useArtworkScrub` только считает смещения указателя и зовёт эти функции;
 * здесь всё, что можно проверить без браузера.
 */

/** Множители зон, от быстрой к точной. */
export const SCRUB_RATES = [1, 0.5, 0.25, 0.1] as const;

export type ScrubRate = (typeof SCRUB_RATES)[number];

/**
 * Границы зон в долях высоты обложки: первая четверть высоты — обычная
 * скорость, вторая — половина, третья — четверть, всё ниже — точная.
 */
const ZONE_FRACTIONS = [0.25, 0.5, 0.75] as const;

/**
 * Множитель скорости по тому, насколько палец ушёл вниз от начала жеста.
 *
 * Вверх от начала и без известной высоты — обычная скорость: лучше перемотать
 * быстрее, чем молча застрять в точной зоне на нулевом размере.
 */
export function scrubRate(verticalOffsetPx: number, height: number): ScrubRate {
  if (!(height > 0) || !Number.isFinite(verticalOffsetPx) || verticalOffsetPx <= 0) return 1;
  const fraction = verticalOffsetPx / height;
  if (fraction < ZONE_FRACTIONS[0]) return 1;
  if (fraction < ZONE_FRACTIONS[1]) return 0.5;
  if (fraction < ZONE_FRACTIONS[2]) return 0.25;
  return 0.1;
}

/** Подпись зоны для оверлея. */
export function scrubRateLabel(rate: ScrubRate): string {
  switch (rate) {
    case 1:
      return 'Обычная';
    case 0.5:
      return 'Вполовину';
    case 0.25:
      return 'Точная';
    default:
      return 'Очень точная';
  }
}

/**
 * Новая позиция после сдвига пальца на `dxPx`.
 *
 * Вся ширина при множителе 1 — весь трек. Функция считает приращение, а не
 * абсолют от точки касания: хук зовёт её на каждое движение с позицией
 * предыдущего шага, и смена зоны посреди жеста меняет только дальнейший ход
 * времени, без скачка.
 */
export function scrubPosition(start: number, dxPx: number, widthPx: number, duration: number, rate: ScrubRate): number {
  if (!(duration > 0) || !Number.isFinite(duration)) return 0;
  const safeStart = Number.isFinite(start) ? Math.max(0, Math.min(start, duration)) : 0;
  if (!(widthPx > 0) || !Number.isFinite(dxPx)) return safeStart;
  const next = safeStart + (dxPx / widthPx) * duration * rate;
  return Math.max(0, Math.min(next, duration));
}

/** Разница со знаком для оверлея: «+1:12», «−0:05», на месте — «0:00». */
export function formatScrubDelta(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const rounded = Math.round(seconds);
  if (rounded === 0) return '0:00';
  return `${rounded > 0 ? '+' : '−'}${formatDuration(Math.abs(rounded))}`;
}
