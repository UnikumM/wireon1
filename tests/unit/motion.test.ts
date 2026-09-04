import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT_MS } from '../../src/styles/motion';

/**
 * Стык между кадрами ухода в CSS и таймером в JS, который держит элемент в
 * дереве, пока они играют.
 *
 * Зачем тест. Длительность анимации ухода живёт в таблице стилей, а снимает
 * элемент React — значит одно число продублировано в двух местах. Разъедутся
 * они молча: уменьшить `--dur-fast` — и последний кадр отпустится раньше
 * снятия, элемент мигнёт обратно; увеличить — и он замрёт в пустом ожидании.
 * Ни то, ни другое не свалит ни один поведенческий тест.
 *
 * Проверяется исходник, а не отрендеренное дерево: в vitest.config.ts нет
 * `css: true`, стили в прогоне вообще не обрабатываются, и `getComputedStyle`
 * про `animation` ничего не расскажет.
 */

const SRC = path.resolve(__dirname, '../../src');
const GLOBAL_CSS = readFileSync(path.join(SRC, 'styles/global.css'), 'utf8');
const THEME_CSS = readFileSync(path.join(SRC, 'styles/theme.css'), 'utf8');

/** Утилита ухода → кадры, которые она обязана проигрывать. */
const EXIT_UTILITIES: Array<[utility: string, keyframes: string]> = [
  ['animate-fade-out', 'fadeOut'],
  ['animate-slide-out', 'slideOutDown'],
  ['animate-pop-out', 'popOut']
];

/** Объявление одной утилиты из таблицы стилей, целиком. */
function declarationOf(utility: string): string {
  const match = GLOBAL_CSS.match(new RegExp(`\\.${utility}\\s*\\{([^}]*)\\}`));
  expect(match, `в global.css нет правила .${utility}`).not.toBeNull();
  return match![1];
}

describe('Motion: анимации ухода', () => {
  it('EXIT_MS совпадает с --dur-fast из theme.css', () => {
    // Базовое значение токена, а не то, что внутри prefers-reduced-motion:
    // там все длительности схлопнуты в 1ms, и брать его за эталон нельзя.
    const base = THEME_CSS.slice(0, THEME_CSS.indexOf('@media (prefers-reduced-motion'));
    const declared = base.match(/--dur-fast:\s*(\d+)ms/);

    expect(declared, 'в theme.css не нашёлся токен --dur-fast').not.toBeNull();
    expect(
      Number(declared![1]),
      'EXIT_MS в src/styles/motion.ts разъехался с --dur-fast: JS снимет элемент не в тот момент, когда доиграют кадры'
    ).toBe(EXIT_MS);
  });

  it('каждая утилита ухода описана и проигрывает свои кадры на --dur-fast', () => {
    for (const [utility, keyframes] of EXIT_UTILITIES) {
      expect(
        new RegExp(`@keyframes\\s+${keyframes}\\s*\\{`).test(GLOBAL_CSS),
        `нет @keyframes ${keyframes}, на который ссылается .${utility}`
      ).toBe(true);

      const declaration = declarationOf(utility);
      expect(declaration, `.${utility} должна ссылаться на ${keyframes}`).toContain(keyframes);
      expect(
        declaration,
        `.${utility} обязана идти на var(--dur-fast) — это и есть EXIT_MS в JS`
      ).toContain('var(--dur-fast)');
    }
  });

  it('утилиты ухода удерживают последний кадр', () => {
    for (const [utility] of EXIT_UTILITIES) {
      // Без `forwards` последний кадр отпускается: элемент на мгновение
      // возвращается в исходную непрозрачность и мигает перед снятием.
      expect(declarationOf(utility), `.${utility} без forwards мигнёт перед снятием`).toContain('forwards');
    }
  });

  it('кадры ухода заканчиваются полной прозрачностью', () => {
    for (const [, keyframes] of EXIT_UTILITIES) {
      const body = GLOBAL_CSS.match(new RegExp(`@keyframes\\s+${keyframes}\\s*\\{([\\s\\S]*?)\\n\\}`));
      expect(body, `не разобрались кадры ${keyframes}`).not.toBeNull();

      // `to { opacity: 0 }` — единственное, что делает уход уходом. Всё
      // остальное в кадрах декоративно: смещение, масштаб.
      expect(
        /to\s*\{[^}]*opacity:\s*0\b/.test(body![1]),
        `${keyframes} не доводит до opacity: 0 — элемент снимется видимым`
      ).toBe(true);
    }
  });

  it('уходящий элемент не принимает нажатия', () => {
    // Клик по тому, чего через миг не будет, промахивается по тому, что под
    // ним, — и это не гипотеза: оверлей окна занимает весь экран.
    for (const file of ['Toast.tsx', 'Modal.tsx']) {
      const source = readFileSync(path.join(SRC, 'components/common', file), 'utf8');
      expect(
        /pointerEvents:\s*(?:entry\.)?isLeaving\s*\?\s*'none'/.test(source),
        `${file}: у уходящего элемента должны быть отключены нажатия`
      ).toBe(true);
    }
  });

  it('таймер снятия спрашивает длительность у документа, а не берёт константу', () => {
    // `EXIT_MS` — только значение по умолчанию. Пресет и ручка «Движение» пишут
    // своё `--dur-fast`, поэтому таймер, зашитый на константу, у «Плавно» рубил
    // бы уход на середине, а у «Мгновенно» держал бы призрак лишние сто мс.
    for (const file of ['Toast.tsx', 'Modal.tsx']) {
      const source = readFileSync(path.join(SRC, 'components/common', file), 'utf8');
      expect(source, `${file}: длительность ухода должна читаться из документа`).toContain('readExitMs(EXIT_MS)');
      expect(
        /setTimeout\([\s\S]*?,\s*EXIT_MS\s*\)/.test(source),
        `${file}: остался таймер на константе EXIT_MS — выбор человека до него не доходит`
      ).toBe(false);
    }
  });
});

/** Список свойств из `transition-property`, разобранный на имена. */
function transitionProperties(body: string): string[] {
  const match = body.match(/transition-property\s*:\s*([^;]+);/);
  expect(match, 'в правиле смены оформления нет transition-property').not.toBeNull();
  return match![1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

describe('Motion: смена оформления', () => {
  /** Правило целиком: селектор многострочный, поэтому берётся от первого вхождения. */
  const shiftRule = GLOBAL_CSS.match(/\[data-preset-shift\][^{]*\{([^}]*)\}/);

  it('под меткой смены объявлен переход на всё дерево', () => {
    // Не только на сам `<html>`: пресет меняет вид каждой панели, и переход,
    // висящий на одном элементе, оставил бы остальные щёлкать в один кадр.
    expect(shiftRule, 'в global.css нет правила [data-preset-shift]').not.toBeNull();
    expect(GLOBAL_CSS).toContain('[data-preset-shift] *');
    expect(GLOBAL_CSS).toContain('[data-preset-shift] *::before');
  });

  it('переход идёт по своей длительности, а не по общим', () => {
    // Общие четыре в этот самый момент подменяются новыми значениями пресета:
    // переход взял бы то ли прошлое, то ли уже следующее.
    expect(shiftRule![1]).toContain('var(--dur-preset-shift)');
    expect(THEME_CSS).toMatch(/--dur-preset-shift:\s*\d+ms;/);
  });

  it('плавно меняется раскраска, а не раскладка', () => {
    const props = transitionProperties(shiftRule![1]);

    for (const name of ['background-color', 'border-color', 'border-radius', 'box-shadow', 'color']) {
      expect(props, `${name} обязано переходить плавно`).toContain(name);
    }

    // Отступы, кегль и размеры двигают положение соседей: их переход на всём
    // дереве — не плавность, а дрожание строк в списке. `all` запрещено по той
    // же причине — он включает и раскладку тоже.
    for (const name of ['all', 'padding', 'gap', 'font-size', 'width', 'height', 'margin']) {
      expect(props, `${name} не должно попадать в переход смены оформления`).not.toContain(name);
    }
  });

  it('при «меньше движения» смена оформления мгновенная', () => {
    // Своя длительность не подчиняется общему схлопыванию: она объявлена
    // отдельно, поэтому и в сокращённый блок вписана отдельно.
    const reduced = THEME_CSS.slice(THEME_CSS.indexOf('prefers-reduced-motion'));
    expect(reduced).toContain('--dur-preset-shift: 1ms;');
  });
});
