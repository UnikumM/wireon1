import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '../setup';
import { TransportControls } from '../../src/components/player/TransportControls';
import { resetPlayerStore } from '../helpers/testUtils';
import { ICON } from '../../src/styles/icons';

/**
 * Три ступени ряда транспорта.
 *
 * Проверяется не «красиво ли», а согласованность пары: кнопка и её глиф обязаны
 * брать один и тот же шаг шкалы (`--control-lg` ↔ `ICON.lg`). Именно на этой паре
 * держится то, что ряд читается как ряд, а главная кнопка — как главная, и именно
 * её нельзя проверить в браузере глазами: размер глифа у lucide — число в JS, а
 * размер кнопки — переменная CSS, и разъехаться они могут молча.
 *
 * Ступень `tight` появилась из поломки: облики, отдавшие часть высоты полосы
 * («Парящая», «Линия», «Карточка»), оставляли кнопку 48 px в таблетке 54 px, и она
 * выходила за скруглённый контур сверху и снизу.
 */

/** Пары шкалы: кнопка и глиф одного шага. */
const PAIRS = {
  sm: { control: 'var(--control-sm)', icon: ICON.sm },
  md: { control: 'var(--control-md)', icon: ICON.md },
  lg: { control: 'var(--control-lg)', icon: ICON.lg },
  xl: { control: 'var(--control-xl)', icon: ICON.xl },
  '2xl': { control: 'var(--control-2xl)', icon: ICON['2xl'] }
} as const;

type Step = keyof typeof PAIRS;

/** Ожидаемые шаги: мелкие кнопки, перемотка, главная. */
const EXPECTED: Record<'tight' | 'compact' | 'comfortable', { small: Step; step: Step; main: Step }> = {
  tight: { small: 'sm', step: 'md', main: 'lg' },
  compact: { small: 'md', step: 'lg', main: 'xl' },
  comfortable: { small: 'lg', step: 'xl', main: '2xl' }
};

/** Кнопка и её единственный глиф. */
function pairOf(testId: string): { control: string; icon: number } {
  const button = screen.getByTestId(testId);
  const svg = button.querySelector('svg');
  if (!svg) throw new Error(`${testId} без глифа`);
  return { control: button.style.width, icon: Number(svg.getAttribute('width')) };
}

describe('Ступени ряда транспорта', () => {
  beforeEach(() => {
    resetPlayerStore();
    cleanup();
  });

  for (const [variant, steps] of Object.entries(EXPECTED)) {
    it(`«${variant}»: кнопка и глиф берут один шаг шкалы`, () => {
      render(<TransportControls variant={variant as 'tight' | 'compact' | 'comfortable'} idPrefix="t" />);

      expect(pairOf('t-play-pause-btn')).toEqual(PAIRS[steps.main]);
      expect(pairOf('t-prev-btn')).toEqual(PAIRS[steps.step]);
      expect(pairOf('t-next-btn')).toEqual(PAIRS[steps.step]);
      expect(pairOf('t-shuffle-btn')).toEqual(PAIRS[steps.small]);
      expect(pairOf('t-repeat-btn')).toEqual(PAIRS[steps.small]);
      // Знак бесконечности раньше брал `ICON.md + 2` и выбивался из ряда.
      expect(pairOf('t-radio-autoplay-btn')).toEqual(PAIRS[steps.small]);
    });
  }

  it('«tight» — тот же ряд на ступень ниже, а не отдельный набор чисел', () => {
    // Свойство важнее чисел: пока ступени сдвигаются целиком, сжатый ряд остаётся
    // тем же рядом, и главная кнопка в нём не сравнивается по размеру с соседней.
    expect(EXPECTED.tight.main).toBe(EXPECTED.compact.step);
    expect(EXPECTED.tight.step).toBe(EXPECTED.compact.small);
    expect(EXPECTED.compact.main).toBe(EXPECTED.comfortable.step);
    expect(EXPECTED.compact.step).toBe(EXPECTED.comfortable.small);
  });

  it('на неизвестной ступени остаётся обычный ряд, а не пустые размеры', () => {
    // Значение приходит из облика, то есть в конечном счёте из базы. Пустая строка
    // в `width` дала бы кнопку по размеру глифа — заметно, но необъяснимо.
    render(<TransportControls variant={'huge' as never} idPrefix="t" />);
    expect(pairOf('t-play-pause-btn')).toEqual(PAIRS[EXPECTED.compact.main]);
  });

  it('ряд обходится без выключенных кнопок', () => {
    render(<TransportControls variant="tight" idPrefix="t" showShuffle={false} showRepeat={false} />);

    expect(screen.queryByTestId('t-shuffle-btn')).toBeNull();
    expect(screen.queryByTestId('t-repeat-btn')).toBeNull();
    // Главная кнопка от этого мельче не становится: набор кнопок и ступень —
    // независимые настройки.
    expect(pairOf('t-play-pause-btn')).toEqual(PAIRS.lg);
  });
});
