import { describe, it, expect } from 'vitest';
import { onsetGain } from '../../src/components/player/AudioVisualizer';

/**
 * Появление визуализации проверяется кривой, а не картинкой.
 *
 * Жалоба была ровно про первый кадр: полосы возникали на полную высоту между
 * двумя кадрами, и включение музыки выглядело помаркой отрисовки. Множитель
 * размаха — единственная часть визуализации, которую видно без холста, поэтому
 * проверяется он.
 */
describe('появление визуализации', () => {
  it('начинается с нуля и не прыгает на первом кадре', () => {
    // Ноль — это ровно та линия покоя, что нарисована до включения музыки:
    // множитель трогает только размах, а не саму фигуру.
    expect(onsetGain(0, true)).toBe(0);
    expect(onsetGain(16, true)).toBeLessThan(0.02);
  });

  it('доходит до полного размаха и дальше не растёт', () => {
    expect(onsetGain(520, true)).toBe(1);
    // Часы кадров идут дальше конца разгона, и здесь легко получить размах
    // больше единицы — то есть полосы выше холста.
    expect(onsetGain(5000, true)).toBe(1);
    expect(onsetGain(Number.MAX_SAFE_INTEGER, true)).toBe(1);
  });

  it('растёт монотонно и без ступенек', () => {
    let previous = -1;
    for (let elapsed = 0; elapsed <= 520; elapsed += 20) {
      const value = onsetGain(elapsed, true);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });

  it('концы кривой плоские: ни рывка на старте, ни обрыва на финише', () => {
    // Разница за первые и последние двадцать миллисекунд должна быть меньше, чем
    // в середине разгона, иначе появление всё равно читается щелчком.
    const start = onsetGain(20, true) - onsetGain(0, true);
    const middle = onsetGain(280, true) - onsetGain(260, true);
    const end = onsetGain(520, true) - onsetGain(500, true);

    expect(start).toBeLessThan(middle);
    expect(end).toBeLessThan(middle);
  });

  it('затухание — то же движение назад', () => {
    // Уход не имеет права быть другим по форме: иначе пауза выглядела бы
    // обрывом там, где включение выглядело плавным.
    for (const elapsed of [0, 100, 260, 400, 520]) {
      expect(onsetGain(elapsed, false) + onsetGain(elapsed, true)).toBeCloseTo(1, 10);
    }
    expect(onsetGain(520, false)).toBe(0);
  });

  it('на отрицательном времени не выходит за границы', () => {
    // Часы `requestAnimationFrame` в разных окнах считаются от разных нулей, и
    // отрицательная разница здесь встречается на переносе окна между экранами.
    expect(onsetGain(-999, true)).toBe(0);
    expect(onsetGain(-999, false)).toBe(1);
  });
});
