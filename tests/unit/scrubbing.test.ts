import { describe, it, expect } from 'vitest';
import { formatScrubDelta, scrubPosition, scrubRate, scrubRateLabel, SCRUB_RATES } from '../../src/services/scrubbing';

/**
 * Арифметика точной перемотки: зоны, приращение позиции, подписи.
 * Хук проверяется отдельно, здесь — то, что считается без браузера.
 */
describe('scrubRate: зоны по высоте обложки', () => {
  it('у начала и выше — обычная скорость', () => {
    expect(scrubRate(0, 300)).toBe(1);
    expect(scrubRate(-80, 300)).toBe(1);
    expect(scrubRate(70, 300)).toBe(1);
  });

  it('чем ниже палец, тем медленнее: половина, четверть, точная', () => {
    expect(scrubRate(90, 300)).toBe(0.5);
    expect(scrubRate(160, 300)).toBe(0.25);
    expect(scrubRate(240, 300)).toBe(0.1);
    // За нижним краем обложки — всё ещё точная, а не ошибка.
    expect(scrubRate(900, 300)).toBe(0.1);
  });

  it('без высоты не застревает в точной зоне', () => {
    expect(scrubRate(200, 0)).toBe(1);
    expect(scrubRate(200, Number.NaN)).toBe(1);
  });

  it('подписи зон — по-русски и у каждого множителя своя', () => {
    const labels = SCRUB_RATES.map(scrubRateLabel);
    expect(labels).toEqual(['Обычная', 'Вполовину', 'Точная', 'Очень точная']);
    expect(new Set(labels).size).toBe(SCRUB_RATES.length);
  });
});

describe('scrubPosition: приращение по ширине', () => {
  it('вся ширина при обычной скорости — весь трек', () => {
    expect(scrubPosition(0, 300, 300, 240, 1)).toBe(240);
    expect(scrubPosition(120, 150, 300, 240, 1)).toBe(240);
    expect(scrubPosition(120, -150, 300, 240, 1)).toBe(0);
  });

  it('множитель замедляет ход времени под пальцем', () => {
    expect(scrubPosition(100, 30, 300, 240, 1)).toBeCloseTo(124);
    expect(scrubPosition(100, 30, 300, 240, 0.5)).toBeCloseTo(112);
    expect(scrubPosition(100, 30, 300, 240, 0.25)).toBeCloseTo(106);
    expect(scrubPosition(100, 30, 300, 240, 0.1)).toBeCloseTo(102.4);
  });

  it('не выходит за [0, duration]', () => {
    expect(scrubPosition(230, 500, 300, 240, 1)).toBe(240);
    expect(scrubPosition(5, -500, 300, 240, 1)).toBe(0);
    expect(scrubPosition(999, 0, 300, 240, 1)).toBe(240);
  });

  it('без длительности или ширины не придумывает позицию', () => {
    expect(scrubPosition(10, 50, 300, 0, 1)).toBe(0);
    expect(scrubPosition(10, 50, 0, 240, 1)).toBe(10);
    expect(scrubPosition(Number.NaN, 50, 300, 240, 1)).toBe(40);
  });
});

describe('formatScrubDelta', () => {
  it('показывает знак и время', () => {
    expect(formatScrubDelta(72)).toBe('+1:12');
    expect(formatScrubDelta(-5)).toBe('−0:05');
    expect(formatScrubDelta(0)).toBe('0:00');
    expect(formatScrubDelta(0.3)).toBe('0:00');
    expect(formatScrubDelta(Number.NaN)).toBe('0:00');
  });
});
