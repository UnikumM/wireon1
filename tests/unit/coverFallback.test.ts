import { describe, it, expect } from 'vitest';
import { coverGradient, coverInitial, coverSeed } from '../../src/utils/coverFallback';

describe('Обложка-заглушка из названия', () => {
  it('у одного трека один и тот же градиент, у разных — разный', () => {
    expect(coverGradient('Город спит', 'Лампа')).toBe(coverGradient('Город спит', 'Лампа'));
    expect(coverGradient('Город спит', 'Лампа')).not.toBe(coverGradient('Пыль и неон', 'Лампа'));
    expect(coverSeed('a')).not.toBe(coverSeed('b'));
  });

  it('градиент собран из hsl, без литералов темы', () => {
    const css = coverGradient('Стекло');
    expect(css).toMatch(/^linear-gradient\(\d+deg, hsl\(\d+ 42% 28%\), hsl\(\d+ 50% 56%\)\)$/);
  });

  it('буква — первая осмысленная, заглавная; без букв — точка', () => {
    expect(coverInitial('  холодный свет')).toBe('Х');
    expect(coverInitial('…')).toBe('·');
    expect(coverInitial('7 рингтон')).toBe('7');
  });
});
