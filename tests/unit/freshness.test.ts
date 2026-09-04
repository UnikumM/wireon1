import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Примитивы «свежести»: вход экрана, выпадение меню, оседание карточек, блик.
 *
 * Зачем отдельный тест. Анимации входа не складываются: две штуки на одном
 * элементе борются за `transform`, второе объявление отменяет первое на своём
 * первом кадре, и элемент дёргается ровно на старте — то есть в единственный
 * момент, когда на него смотрят. Глазами это ловится плохо (обе анимации
 * короткие, обе «работают»), а в разметке видно сразу.
 *
 * Читаются исходники, а не дерево: в vitest.config.ts нет `css: true`, стили в
 * прогоне не обрабатываются, и `getComputedStyle` про `animation` ничего не
 * скажет. Проверяется причина, а не следствие.
 */

const SRC = path.resolve(__dirname, '../../src');
const GLOBAL_CSS = path.join(SRC, 'styles/global.css');

/** Анимации появления. Ровно одна на элемент — вторая отменяет первую. */
const ENTRY_ANIMATIONS = [
  'animate-fade-in',
  'animate-slide-up',
  'animate-slide-left',
  'animate-pop-in',
  'animate-emerge',
  'animate-rise',
  'animate-view-in',
  'animate-drop-in',
  'animate-settle'
];

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, acc);
    else if (entry.name.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

interface Element {
  file: string;
  line: number;
  classes: string[];
  tag: string;
}

/**
 * Открывающий тег вокруг найденного `className`: назад до `<`, вперёд до `>`
 * верхнего уровня — вложенные `{...}` пропускаются, иначе выражение в атрибуте
 * оборвёт тег на своей первой `>`.
 */
function openingTag(source: string, from: number, to: number): string | null {
  const start = source.lastIndexOf('<', from);
  if (start < 0) return null;
  let depth = 0;
  for (let i = to; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return source.slice(start, i);
  }
  return null;
}

function elements(): Element[] {
  const found: Element[] = [];
  for (const file of tsxFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    const rel = 'src/' + path.relative(SRC, file).replace(/\\/g, '/');
    for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const tag = openingTag(source, match.index, match.index + match[0].length);
      if (!tag) continue;
      // Выражения в шаблоне выкидываем: `${className}` — не имя класса.
      const literal = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
      found.push({
        file: rel,
        line: source.slice(0, match.index).split('\n').length,
        classes: literal.split(/\s+/).filter(Boolean),
        tag: tag.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      });
    }
  }
  return found;
}

describe('свежесть: анимации появления', () => {
  const all = elements();

  it('на элементе не больше одной анимации появления', () => {
    const offenders = all
      .map((element) => ({
        element,
        entries: ENTRY_ANIMATIONS.filter((name) => element.classes.includes(name))
      }))
      .filter(({ entries }) => entries.length > 1)
      .map(({ element, entries }) => `${element.file}:${element.line} — ${entries.join(' + ')}`);

    expect(
      offenders,
      'Две анимации появления на одном элементе борются за transform: вторая ' +
        'отменяет первую на первом кадре, и элемент дёргается на старте. ' +
        'Оставьте одну:\n' + offenders.join('\n')
    ).toEqual([]);
  });

  it('--pop-origin ставят только там, где есть выпадение', () => {
    // Переменная читается ровно одним правилом — `.animate-drop-in`. На чужом
    // элементе она молча не делает ничего, и это худший вид мёртвого кода:
    // выглядит как настройка точки роста, которой нет.
    const offenders: string[] = [];

    for (const file of tsxFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      const rel = 'src/' + path.relative(SRC, file).replace(/\\/g, '/');
      for (const match of source.matchAll(/'--pop-origin'/g)) {
        const line = source.slice(0, match.index).split('\n').length;
        // Класс ищется в том же элементе: у `--pop-origin` в объекте стилей и у
        // `className` общий открывающий тег, но между ними бывает сто строк
        // разметки, поэтому берётся окно вокруг совпадения.
        const around = source.slice(Math.max(0, match.index - 3000), match.index + 500);
        if (around.includes('animate-drop-in')) continue;
        offenders.push(`${rel}:${line}`);
      }
    }

    expect(
      offenders,
      '`--pop-origin` без `animate-drop-in` не читает никто:\n' + offenders.join('\n')
    ).toEqual([]);
  });

  it('примитивы объявлены и держат первый кадр', () => {
    const css = readFileSync(GLOBAL_CSS, 'utf8');

    // `both`/`backwards` обязательны: без удержания первого кадра элемент
    // успевает мелькнуть готовым до начала анимации — это и была жалоба, что
    // всё «слишком резко появляется».
    expect(css).toMatch(/\.animate-view-in \{[^}]*animation:\s*viewIn[^}]*both/);
    expect(css).toMatch(/\.animate-drop-in \{[^}]*animation:\s*dropIn[^}]*both/);
    expect(css).toMatch(/\.animate-settle \{[^}]*animation:\s*settleIn[^}]*backwards/);

    // Точка роста выпадения — из переменной, иначе меню, открытое вверх,
    // растёт от верхнего края и уезжает от своей кнопки.
    expect(css).toMatch(/\.animate-drop-in \{[^}]*transform-origin:\s*var\(--pop-origin/);

    // Череда в сетке ограничена: без предела двадцатая карточка приезжает через
    // полсекунды после первой, и сетка выглядит подгружающейся.
    expect(css).toMatch(/\.animate-settle \{[^}]*min\(var\(--stagger[^}]*\)/);

    // Блик прозрачен для мыши: иначе слой поверх карточки съедает щелчок.
    expect(css).toMatch(/\.hover-sheen::after \{[^}]*pointer-events:\s*none/);
    // И глушится в «Обсидиане» — пресет неподвижен по договорённости.
    expect(css).toMatch(/\[data-preset='obsidian'\] \.hover-sheen::after/);
  });

  it('последний кадр снимает преобразование, а не выставляет единичное', () => {
    /*
     * `transform: translateY(0) scale(1)` и `filter: blur(0)` в кадре `to`
     * выглядят как «ничего», но это не `none`. С `fill-mode: both` кадр остаётся
     * на элементе навсегда, а элемент с преобразованием или фильтром — stacking
     * context и система отсчёта для `position: fixed` у всех потомков. Из-за
     * этого подложка модалки внутри такого корня мерится по корню, а не по окну,
     * и всплывающее меню не может подняться над полосой плеера никаким z-index.
     *
     * Анимации ухода это правило не задевает: они нарочно кончаются на
     * ненулевом сдвиге, а `none` тут запрещён только там, где значение и так
     * единичное.
     */
    const offenders: string[] = [];
    const styles = path.join(SRC, 'styles');

    for (const name of readdirSync(styles).filter((file) => file.endsWith('.css'))) {
      const css = readFileSync(path.join(styles, name), 'utf8');
      for (const frames of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
        for (const block of frames[2].matchAll(/\bto\s*\{([^}]*)\}/g)) {
          const body = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
          // Единичное преобразование: любой набор функций, где все значения нулевые
          // (или scale(1)) — то есть кадр, ничего не меняющий, кроме слоя.
          const transform = body.match(/transform:\s*([^;]+);/);
          if (transform && /^(?:(?:translate[XYZ]?|scale[XYZ]?|rotate[XYZ]?)\([^)]*\)\s*)+$/.test(transform[1].trim())) {
            const identity = [...transform[1].matchAll(/\(([^)]*)\)/g)].every((arg) =>
              /^(?:0(?:px|%|deg|rem)?|1(?:\.0+)?)$/.test(arg[1].trim())
            );
            if (identity) offenders.push(`${name} · @keyframes ${frames[1]} · transform: ${transform[1].trim()}`);
          }
          const filter = body.match(/filter:\s*blur\(0[a-z%]*\)/);
          if (filter) offenders.push(`${name} · @keyframes ${frames[1]} · ${filter[0]}`);
        }
      }
    }

    expect(
      offenders,
      'В кадре `to` вместо единичного значения нужен `none`, иначе элемент навсегда ' +
        'остаётся системой отсчёта для fixed-потомков и отдельным слоем композитора:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('иконочная кнопка получает своё скругление из CSS, а не из размера', () => {
    // `[data-variant='icon'] { border-radius: var(--radius-full) }` не работало
    // нигде, и каждая круглая кнопка приложения оказывалась квадратной.
    const source = readFileSync(path.join(SRC, 'components/common/Button.tsx'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const iconCase = code.slice(code.indexOf("case 'icon':"), code.indexOf("case 'md':"));

    expect(iconCase, 'размер снова объявляет скругление и глушит вариант').not.toMatch(/borderRadius/);
  });
});
