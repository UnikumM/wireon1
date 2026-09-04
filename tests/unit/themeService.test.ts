import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import { applyAccent, applyDepth, applyTheme } from '../../src/services/themeService';
import {
  ACCENT_CSS_VARS,
  DEFAULT_ACCENT_HEX,
  DEFAULT_THEME_DEPTH,
  deriveAccentShades,
  type ThemeDepth
} from '../../src/styles/palette';

/**
 * Применение темы к документу.
 *
 * Математику цвета проверяет palette.test.ts, здесь — только то, что она
 * доезжает до `<html>` целиком и в правильные имена. Именно на этом стыке
 * ошибка не видна ни глазами, ни в типах: пропущенная переменная просто
 * оставляет часть интерфейса на старом акценте.
 */

const root = () => document.documentElement;

function clearThemeFromRoot(): void {
  for (const name of Object.values(ACCENT_CSS_VARS)) {
    root().style.removeProperty(name);
  }
  delete root().dataset.theme;
}

describe('themeService', () => {
  beforeEach(() => {
    clearThemeFromRoot();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearThemeFromRoot();
  });

  it('раскладывает все переменные акцента на <html>', () => {
    applyAccent('#8fe0c8');

    const shades = deriveAccentShades('#8fe0c8');
    for (const [key, cssName] of Object.entries(ACCENT_CSS_VARS)) {
      expect(
        root().style.getPropertyValue(cssName),
        `переменная ${cssName} не попала в документ`
      ).toBe(shades[key as keyof typeof shades]);
    }
  });

  it('принимает короткую запись и запись без решётки', () => {
    applyAccent('8fc');

    expect(root().style.getPropertyValue('--accent')).toBe('#88ffcc');
  });

  it('на мусоре берёт акцент по умолчанию, а не оставляет интерфейс без цвета', () => {
    applyAccent('очень синий');

    expect(root().style.getPropertyValue('--accent')).toBe(DEFAULT_ACCENT_HEX);
  });

  it('подбирает читаемый цвет подписи под сам акцент', () => {
    applyAccent('#ffffff');
    expect(root().style.getPropertyValue('--text-on-accent')).toBe('#0b0f16');

    applyAccent('#101820');
    expect(root().style.getPropertyValue('--text-on-accent')).toBe('#ffffff');
  });

  it('ставит глубину атрибутом, включая «Сумерки» без своего блока в CSS', () => {
    applyDepth('light');
    expect(root().dataset.theme).toBe('light');

    applyDepth('dusk');
    // Атрибут ставится и здесь: он всегда отражает выбор, иначе по документу не
    // понять, тема это по умолчанию или потерянная настройка.
    expect(root().dataset.theme).toBe('dusk');
  });

  it('неизвестную глубину заменяет темой по умолчанию', () => {
    applyDepth('neon' as ThemeDepth);

    expect(root().dataset.theme).toBe(DEFAULT_THEME_DEPTH);
  });

  it('applyTheme делает обе операции сразу', () => {
    applyTheme({ accentHex: '#f2a3bd', depth: 'night' });

    expect(root().style.getPropertyValue('--accent')).toBe('#f2a3bd');
    expect(root().dataset.theme).toBe('night');
  });

  it('без документа ничего не делает и не бросает', () => {
    // Smoke-режим и часть тестов исполняют код без окна. Падение на оформлении
    // остановило бы запуск целиком, поэтому отсутствие документа — штатный случай.
    vi.stubGlobal('document', undefined);

    expect(() => applyAccent('#8fc7ff')).not.toThrow();
    expect(() => applyDepth('light')).not.toThrow();
    expect(() => applyTheme({ accentHex: '#8fc7ff', depth: 'steel' })).not.toThrow();
  });
});
