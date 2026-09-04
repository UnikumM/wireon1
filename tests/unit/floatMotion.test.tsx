import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import '../setup';
import { EmptyState } from '../../src/components/common/EmptyState';

/**
 * Парение.
 *
 * Просьба была «небольшую анимацию самой иконке чтобы она парила», и слово
 * «небольшую» здесь — не оговорка, а требование: бесконечный цикл видно всё
 * время, пока экран открыт, и стоит ходу вырасти до заметного, как иконка
 * начинает тянуть взгляд на себя вместо содержимого. Поэтому проверяются именно
 * границы приёма — ход, замкнутость цикла и то, что «сокращённое движение» его
 * снимает.
 */

const SRC = path.resolve(__dirname, '../../src');
const GLOBAL_CSS = readFileSync(path.join(SRC, 'styles/global.css'), 'utf8');

/** Тело правила по селектору — до первой закрывающей скобки. */
function ruleBody(selector: string, from = 0): string {
  const start = GLOBAL_CSS.indexOf(`${selector} {`, from);
  if (start === -1) throw new Error(`нет правила ${selector}`);
  return GLOBAL_CSS.slice(start, GLOBAL_CSS.indexOf('}', start));
}

/** Кадры анимации целиком, вместе с вложенными процентами. */
function keyframes(name: string): string {
  const start = GLOBAL_CSS.indexOf(`@keyframes ${name}`);
  if (start === -1) throw new Error(`нет кадров ${name}`);
  // Конец блока — счётом скобок, а не поиском по переводу строки. Тот способ
  // молча разваливается на CRLF, которыми написан весь репозиторий: совпадения
  // нет, `indexOf` отдаёт −1, и в «кадры» утягивается весь остаток файла вместе
  // с чужими анимациями. Держалось это на одной случайной строке с одиночным
  // LF, и первая же правка файла роняла проверку в стороне от причины.
  let depth = 0;
  for (let i = GLOBAL_CSS.indexOf('{', start); i < GLOBAL_CSS.length; i += 1) {
    if (GLOBAL_CSS[i] === '{') depth += 1;
    else if (GLOBAL_CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return GLOBAL_CSS.slice(start, i + 1);
    }
  }
  throw new Error(`кадры ${name} не закрыты`);
}

describe('Парение иконки', () => {
  it('ход маленький: единицы пикселей, а не десятки', () => {
    const shifts = Array.from(keyframes('levitate').matchAll(/translateY\((-?\d+)px\)/g)).map((m) =>
      Math.abs(Number(m[1]))
    );
    expect(shifts.length).toBeGreaterThan(0);
    expect(Math.max(...shifts)).toBeLessThanOrEqual(6);
  });

  it('цикл замкнут: на стыке оборотов нет скачка', () => {
    // Начало и конец обязаны стоять в одной точке, иначе каждые несколько секунд
    // иконка дёргается — самый заметный дефект бесконечной анимации.
    const body = keyframes('levitate');
    expect(body).toMatch(/0%,\s*\n?\s*100%\s*{\s*\n?\s*transform:\s*translateY\(0\)/);
  });

  it('идёт медленно и без конца', () => {
    const body = ruleBody('.animate-float');
    expect(body).toContain('infinite');
    const seconds = Number(/levitate\s+([\d.]+)s/.exec(body)?.[1]);
    // Быстрее двух секунд на оборот — уже не парение, а дрожание.
    expect(seconds).toBeGreaterThanOrEqual(2);
  });

  it('фаза сдвигается назад, а не вперёд', () => {
    // Положительная задержка означала бы, что предмет сначала стоит — то есть на
    // первом же экране парения не видно вовсе.
    expect(ruleBody('.animate-float')).toMatch(/animation-delay:\s*calc\(var\(--float-phase[^)]*\)\s*\*\s*-/);
  });

  it('«сокращённое движение» снимает парение целиком', () => {
    // Обнуления длительности мало: цикл бесконечный, и в этом режиме важно, чтобы
    // его именно не было, а не чтобы он шёл за одну миллисекунду.
    const reduced = GLOBAL_CSS.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(reduced).toBeGreaterThan(0);
    expect(ruleBody('.animate-float', reduced)).toContain('animation: none');
  });

  it('пустой блок вешает свою иконку', () => {
    render(<EmptyState icon={<span data-testid="empty-icon" />} title="Ничего нет" />);
    const wrapper = screen.getByTestId('empty-icon').parentElement;
    expect(wrapper?.className).toContain('animate-float');
    // Украшение — значит, вне доступного дерева.
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
  });

  it('иконка приложения в боковой панели парит тоже', () => {
    const sidebar = readFileSync(path.join(SRC, 'components/layout/Sidebar.tsx'), 'utf8');
    expect(sidebar).toContain('animate-float');
  });
});
