/**
 * Читаемость текста на каждой теме.
 *
 * «Нормализация вида тем» — это не про вкус, а про измеримое: одна и та же
 * подпись обязана читаться и на «Островке», и на «Бумаге». Проверялось это
 * прежде глазами и по одной теме за раз, поэтому самая нижняя ступень текста
 * годами стояла сломанной: на светлых глубинах она давала 2.77:1, то есть
 * меньше, чем нужно даже нетексту, и значки-заглушки на светлой теме выцветали
 * в фон.
 *
 * Здесь считается настоящий контраст по формуле WCAG 2.1 для каждого сочетания
 * пресета и глубины. Двадцать четыре сочетания руками не пересматривают — а
 * тест пересматривает их на каждый запуск.
 */

import { describe, it, expect } from 'vitest';
import {
  CONTRAST_OPTIONS,
  DESIGN_PRESETS,
  NO_OVERRIDES,
  designVars
} from '../../src/styles/presets';
import { DEFAULT_ACCENT_HEX, type ThemeDepth } from '../../src/styles/palette';

/**
 * Пол для каждой ступени.
 *
 * `primary` и `secondary` несут текст, который читают, — с них спрашивается
 * строго. `muted` — подписи и вторые строки, порог AA. `faint` — значки-
 * заглушки и самые тихие пометки: с них хватает порога для нетекста, но не
 * меньше, иначе они перестают существовать.
 */
const FLOORS: Record<string, number> = {
  '--text-primary': 7,
  '--text-secondary': 4.5,
  '--text-muted': 4.5,
  '--text-faint': 3
};

const DEPTHS: ThemeDepth[] = ['night', 'dusk', 'steel', 'light'];

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const clean = String(hex).trim().replace('#', '');
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16)) as Rgb;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('контраст текста на всех темах', () => {
  for (const preset of DESIGN_PRESETS) {
    for (const depth of DEPTHS) {
      it(`${preset.id} / ${depth}`, () => {
        const vars = designVars({
          presetId: preset.id,
          depth,
          accentHex: DEFAULT_ACCENT_HEX,
          overrides: NO_OVERRIDES
        });

        const background = hexToRgb(vars['--bg-base']);
        // Проверяется и на фоне окна, и на панели: строка списка лежит на
        // первой, а не на нулевой поверхности, и именно там она тусклее.
        const surface = hexToRgb(vars['--surface-1']);

        const failures: string[] = [];
        for (const [token, floor] of Object.entries(FLOORS)) {
          const colour = hexToRgb(vars[token]);
          const onBackground = contrast(colour, background);
          const onSurface = contrast(colour, surface);
          const worst = Math.min(onBackground, onSurface);
          if (worst < floor) failures.push(`${token}: ${worst.toFixed(2)}:1 < ${floor}:1`);
        }

        expect(failures, `${preset.id}/${depth}`).toEqual([]);
      });
    }
  }
});

/**
 * Ручка контраста не должна уводить текст ниже порога.
 *
 * Настройка, которой можно сделать себе нечитаемо, — это не настройка, а
 * ловушка: человек подвинет ползунок, увидит «вроде тише», и жалоба вернётся
 * тем же «не видно текста», только теперь с его собственной рукой в причине.
 */
describe('ручка контраста остаётся в границах', () => {
  for (const option of CONTRAST_OPTIONS) {
    it(`«${option.label}» читается на любой теме`, () => {
      const failures: string[] = [];

      for (const preset of DESIGN_PRESETS) {
        for (const depth of DEPTHS) {
          const vars = designVars({
            presetId: preset.id,
            depth,
            accentHex: DEFAULT_ACCENT_HEX,
            overrides: { ...NO_OVERRIDES, contrast: option.id }
          });
          const background = hexToRgb(vars['--bg-base']);
          const surface = hexToRgb(vars['--surface-1']);

          for (const [token, floor] of Object.entries(FLOORS)) {
            const colour = hexToRgb(vars[token]);
            const worst = Math.min(contrast(colour, background), contrast(colour, surface));
            if (worst < floor) {
              failures.push(`${preset.id}/${depth} ${token}: ${worst.toFixed(2)}:1 < ${floor}:1`);
            }
          }
        }
      }

      expect(failures).toEqual([]);
    });
  }
});
