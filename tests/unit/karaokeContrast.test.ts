/**
 * Читаемость текста песни на всех темах.
 *
 * Жалоба звучала дословно: «текста песен не видно из-за определённых тем».
 * Причина была не в раскладке — экран текста давно вынесен из полосы плеера, —
 * а в произведении двух величин: цвет строки умножался на прозрачность, и обе
 * правились порознь. Один раз подняли прозрачность и забыли цвет; на светлых
 * темах результат так и остался нечитаемым.
 *
 * Поэтому тест не сверяет число с числом, а считает настоящий контраст по
 * формуле WCAG для каждого пресета и каждой глубины. Разъехаться молча после
 * этого нельзя: любая правка цвета или прозрачности сразу видна здесь.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { designVars, DESIGN_PRESETS, NO_OVERRIDES } from '../../src/styles/presets';
import { DEFAULT_ACCENT_HEX, type ThemeDepth } from '../../src/styles/palette';
import { KARAOKE_MIN_OPACITY } from '../../src/components/lyrics/KaraokeView';

/** Ниже этого неактивная строка перестаёт читаться как текст. */
const MIN_RATIO = 3;

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const clean = hex.trim().replace('#', '');
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
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}

/** Что глаз видит на самом деле: полупрозрачный текст поверх подложки. */
function flatten(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((channel, index) => channel * alpha + bg[index] * (1 - alpha)) as Rgb;
}

// Все четыре глубины: жалоба пришла именно про «определённые темы», а значит
// проверять надо каждую, а не пару крайних.
const DEPTHS: ThemeDepth[] = ['night', 'dusk', 'steel', 'light'];

describe('строка караоке читается на каждой теме', () => {
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
        const text = hexToRgb(vars['--text-secondary']);
        const ratio = contrast(flatten(text, background, KARAOKE_MIN_OPACITY), background);

        expect(ratio, `${preset.id}/${depth}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          MIN_RATIO
        );
      });
    }
  }

  it('строка красится именно тем токеном, по которому считали', () => {
    // Половина прежней правки потерялась ровно здесь: комментарий в компоненте
    // уже говорил «--text-muted», а в таблице стилей всё ещё стоял
    // «--text-faint». Считать контраст по одному токену и красить другим —
    // это и есть способ снова сделать текст невидимым.
    const css = readFileSync(path.resolve(__dirname, '../../src/styles/global.css'), 'utf8');
    const rule = css.slice(css.indexOf('.karaoke-line {'));
    const body = rule.slice(0, rule.indexOf('}'));

    expect(body).toContain('color: var(--text-secondary)');
  });
});
