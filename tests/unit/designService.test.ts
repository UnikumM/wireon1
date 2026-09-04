import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  applyDesign,
  applyParticles,
  clearDesign,
  currentDepth,
  readExitMs
} from '../../src/services/designService';
import { DEFAULT_PRESET_ID, NO_OVERRIDES, exitDurationMs, findPreset } from '../../src/styles/presets';
import { DEFAULT_TYPOGRAPHY } from '../../src/styles/typography';
import { DEFAULT_ACCENT_HEX } from '../../src/styles/palette';
import { EXIT_MS } from '../../src/styles/motion';

/**
 * Применение оформления к документу.
 *
 * Отдельно от `designTokens.test.ts`: там проверяется математика (какие значения
 * даёт пресет), здесь — что именно доходит до `<html>` и что из него читается
 * обратно. Второе важнее, чем кажется: `readExitMs` — единственный мост между
 * кадрами ухода в CSS и таймером в React, и когда он врёт, уведомление либо
 * рубится на середине, либо остаётся висеть в дереве.
 */

const DEFAULT_SELECTION = {
  presetId: DEFAULT_PRESET_ID,
  depth: 'night' as const,
  accentHex: DEFAULT_ACCENT_HEX,
  overrides: { ...NO_OVERRIDES },
  typography: DEFAULT_TYPOGRAPHY
};

describe('designService', () => {
  beforeEach(() => {
    clearDesign();
    document.documentElement.style.removeProperty('--dur-fast');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearDesign();
  });

  describe('applyDesign', () => {
    it('помечает документ пресетом и глубиной', () => {
      applyDesign(DEFAULT_SELECTION);

      expect(document.documentElement.dataset.preset).toBe(DEFAULT_PRESET_ID);
      expect(document.documentElement.dataset.theme).toBe('night');
      expect(currentDepth()).toBe('night');
    });

    it('пресет вправе потребовать своей глубины', () => {
      // «Бумага» на почти чёрной базе — не бумага. Пресет с `forceDepth`
      // перебивает выбор глубины, иначе получается набор из двух половин.
      applyDesign({ ...DEFAULT_SELECTION, presetId: 'paper', depth: 'night' });

      expect(document.documentElement.dataset.theme).toBe(findPreset('paper').forceDepth);
    });

    it('пишет длительности так, чтобы их можно было прочитать обратно', () => {
      applyDesign(DEFAULT_SELECTION);

      const written = document.documentElement.style.getPropertyValue('--dur-fast').trim();
      expect(written.length).toBeGreaterThan(0);
    });

    it('снятие возвращает документ к оформлению из таблицы стилей', () => {
      applyDesign(DEFAULT_SELECTION);
      applyParticles('storm');

      clearDesign();

      expect(document.documentElement.style.getPropertyValue('--dur-fast')).toBe('');
      expect(document.documentElement.dataset.preset).toBeUndefined();
      expect(document.documentElement.dataset.particles).toBeUndefined();
    });
  });

  describe('readExitMs', () => {
    it('отдаёт то, что применено к документу, а не значение по умолчанию', () => {
      applyDesign({ ...DEFAULT_SELECTION, overrides: { ...NO_OVERRIDES, motion: 'slow' } });

      // Ровно столько же, сколько считает движок: разъехавшись, таймер снимет
      // элемент не в тот кадр, когда доиграла анимация.
      const expected = exitDurationMs({ presetId: DEFAULT_PRESET_ID, overrides: { ...NO_OVERRIDES, motion: 'slow' } });
      expect(readExitMs(EXIT_MS)).toBe(expected);
    });

    it('«Мгновенно» и «Плавно» дают разные длительности', () => {
      applyDesign({ ...DEFAULT_SELECTION, overrides: { ...NO_OVERRIDES, motion: 'instant' } });
      const instant = readExitMs(EXIT_MS);

      applyDesign({ ...DEFAULT_SELECTION, overrides: { ...NO_OVERRIDES, motion: 'slow' } });
      const slow = readExitMs(EXIT_MS);

      expect(slow).toBeGreaterThan(instant);
    });

    it('понимает длительность, заданную в секундах', () => {
      document.documentElement.style.setProperty('--dur-fast', '0.32s');
      expect(readExitMs(EXIT_MS)).toBe(320);
    });

    it('никогда не отдаёт ноль', () => {
      // Ноль законен при «меньше движения», но снять элемент в том же кадре
      // нельзя: React не успеет отрисовать конечное состояние, и уход мигнёт.
      document.documentElement.style.setProperty('--dur-fast', '0ms');
      expect(readExitMs(EXIT_MS)).toBe(1);
    });

    it('на мусоре и на отрицательном значении отдаёт значение по умолчанию', () => {
      for (const value of ['auto', 'fast', '-40ms']) {
        document.documentElement.style.setProperty('--dur-fast', value);
        expect(readExitMs(EXIT_MS), value).toBe(EXIT_MS);
      }
    });

    it('без документа отдаёт значение по умолчанию, а не роняет вызов', () => {
      // Элемент, оставшийся в дереве навсегда, хуже неточной длительности.
      vi.stubGlobal('getComputedStyle', undefined);
      expect(readExitMs(EXIT_MS)).toBe(EXIT_MS);
    });
  });

  describe('applyParticles', () => {
    it('профиль уходит в атрибут, чтобы его читали и CSS, и canvas', () => {
      applyParticles('mist');
      expect(document.documentElement.dataset.particles).toBe('mist');

      applyParticles('off');
      expect(document.documentElement.dataset.particles).toBe('off');
    });
  });

  describe('метка смены оформления', () => {
    const el = () => document.documentElement;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('первое применение проходит без метки', () => {
      // Загрузка окна — не смена оформления. С меткой человек увидел бы, как
      // приложение проявляется из значений таблицы стилей.
      applyDesign(DEFAULT_SELECTION);

      expect(el().dataset.presetShift).toBeUndefined();
    });

    it('второе применение помечает документ', () => {
      applyDesign(DEFAULT_SELECTION);
      applyDesign({ ...DEFAULT_SELECTION, presetId: 'paper' });

      expect(el().dataset.presetShift).toBe('');
    });

    it('метка ставится и когда меняется не пресет, а глубина', () => {
      // Глубина переписывает всю лестницу поверхностей — для глаза это такая же
      // смена, как другой пресет.
      applyDesign(DEFAULT_SELECTION);
      applyDesign({ ...DEFAULT_SELECTION, depth: 'steel' });

      expect(el().dataset.presetShift).toBe('');
    });

    it('метка снимается сама, когда переход доигран', () => {
      applyDesign(DEFAULT_SELECTION);
      applyDesign({ ...DEFAULT_SELECTION, presetId: 'paper' });

      // Висящая метка перебивала бы длительности наведения на всём дереве.
      vi.advanceTimersByTime(500);

      expect(el().dataset.presetShift).toBeUndefined();
    });

    it('быстрая череда смен держит метку до последней', () => {
      applyDesign(DEFAULT_SELECTION);
      applyDesign({ ...DEFAULT_SELECTION, presetId: 'paper' });
      vi.advanceTimersByTime(300);

      // Человек щёлкает по списку пресетов подряд: снятие от первой смены не
      // должно обрывать переход второй.
      applyDesign({ ...DEFAULT_SELECTION, presetId: 'aurora' });
      vi.advanceTimersByTime(300);
      expect(el().dataset.presetShift).toBe('');

      vi.advanceTimersByTime(300);
      expect(el().dataset.presetShift).toBeUndefined();
    });

    it('снятие оформления забирает и метку, и отложенное снятие', () => {
      applyDesign(DEFAULT_SELECTION);
      applyDesign({ ...DEFAULT_SELECTION, presetId: 'paper' });

      clearDesign();
      expect(el().dataset.presetShift).toBeUndefined();

      // Если таймер выжил, он сработал бы уже поверх следующего применения и
      // оборвал бы его переход на середине.
      applyDesign(DEFAULT_SELECTION);
      applyDesign({ ...DEFAULT_SELECTION, presetId: 'paper' });
      vi.advanceTimersByTime(100);
      expect(el().dataset.presetShift).toBe('');
    });
  });
});
