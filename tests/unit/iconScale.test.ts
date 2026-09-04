import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ICON } from '../../src/styles/icons';

/**
 * Предохранитель для шкалы иконок.
 *
 * Зачем он: два прошлых прогона по дизайну заводили `src/styles/icons.ts`, но
 * разметка продолжала писать `size={15}` руками, и к моменту проверки таких мест
 * набралось 198. Ломается от этого именно выравнивание: 15 px внутри рамки
 * `--control-md` (32 px) даёт отступ 8.5 px, полпиксельная дробь съезжает на
 * device pixel и иконка стоит не по центру, да ещё и мылит на фоне рамки в 1 px.
 * Глазами такое ловится плохо, а тестом — сразу.
 */

const SRC = path.resolve(__dirname, '../../src');
const GLOBAL_CSS = path.join(SRC, 'styles/global.css');
const THEME_CSS = path.join(SRC, 'styles/theme.css');

/** У этих компонентов `size` — пиксельный размер обложки, а не глифа. */
const ARTWORK_COMPONENTS = new Set(['TrackArtwork', 'PlaylistCover']);

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, acc);
    else if (entry.name.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

/** Ближайший открывающий тег с заглавной буквы слева — владелец атрибута. */
function ownerOf(source: string, index: number): string {
  const before = source.slice(Math.max(0, index - 600), index);
  const tags = [...before.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)];
  return tags.length ? tags[tags.length - 1][1] : '(unknown)';
}

describe('шкала размеров иконок', () => {
  const files = tsxFiles(SRC);

  it('в разметке нет числовых литералов size, кроме обложек', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = path.relative(SRC, file).replace(/\\/g, '/');

      for (const match of source.matchAll(/size=\{(\d+)\}/g)) {
        const owner = ownerOf(source, match.index);
        if (ARTWORK_COMPONENTS.has(owner)) continue;
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`src/${rel}:${line} — <${owner} size={${match[1]}}>`);
      }
    }

    expect(
      offenders,
      `Размер иконки задан литералом. Возьмите значение из src/styles/icons.ts:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('файлы, берущие размер из шкалы, импортируют её, а не объявляют свою', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // Комментарии выкидываем: `ICON.md` в пояснении к --control-md — это не
      // использование, а ссылка на договорённость.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (!/\bICON[.[]/.test(code)) continue;
      if (/from '(\.\.\/)+styles\/icons'/.test(source)) continue;
      offenders.push(path.relative(SRC, file).replace(/\\/g, '/'));
    }

    expect(offenders, `ICON используется без импорта шкалы: ${offenders.join(', ')}`).toEqual([]);
  });

  it('рампа stroke-width покрывает шкалу ровно, без мёртвых строк', () => {
    const css = readFileSync(GLOBAL_CSS, 'utf8');
    const ramp = [...css.matchAll(/svg\.lucide\[width='(\d+)'\]/g)].map((m) => Number(m[1]));

    // Ровное совпадение в обе стороны: пропущенный шаг оставит иконку с
    // библиотечным штрихом 2, а лишняя строка — мёртвый CSS, который прошлый
    // проход по облику как раз вычищал.
    expect([...ramp].sort((a, b) => a - b)).toEqual([...new Set(Object.values(ICON))].sort((a, b) => a - b));
  });

  it('размер иконки и парная рамка центруются без полпикселя', () => {
    const theme = readFileSync(THEME_CSS, 'utf8');
    const controls = new Map<string, number>();
    for (const m of theme.matchAll(/--control-([a-z0-9]+):\s*(\d+)px/g)) {
      controls.set(m[1], Number(m[2]));
    }

    // Пары зафиксированы в комментариях src/styles/icons.ts; здесь они проверяются.
    const pairs: Array<[keyof typeof ICON, string]> = [
      ['xs', 'xs'],
      ['sm', 'sm'],
      ['md', 'md'],
      ['lg', 'lg'],
      ['xl', 'xl'],
      ['2xl', '2xl']
    ];

    for (const [iconKey, controlKey] of pairs) {
      const box = controls.get(controlKey);
      expect(box, `--control-${controlKey} нет в theme.css`).toBeDefined();
      const inset = (box! - ICON[iconKey]) / 2;
      expect(
        Number.isInteger(inset),
        `ICON.${iconKey} (${ICON[iconKey]}px) в --control-${controlKey} (${box}px) даёт отступ ${inset}px — иконка съедет с центра`
      ).toBe(true);
      expect(inset, `ICON.${iconKey} не влезает в --control-${controlKey}`).toBeGreaterThan(0);
    }
  });

  it('каждый шаг шкалы — чётный, чтобы центрирование всегда было целым', () => {
    const odd = Object.entries(ICON).filter(([, px]) => px % 2 !== 0);
    expect(odd, `нечётные шаги шкалы: ${odd.map(([k, v]) => `${k}=${v}`).join(', ')}`).toEqual([]);
  });
});
