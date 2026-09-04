import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Предохранитель против оформления в обход темы.
 *
 * Проверяются исходники, а не отрендеренное дерево: каждое из правил ниже — это
 * настройка, которая тихо перестаёт работать на одном экране, пока работает на
 * остальных. В дереве одного экрана такое не видно, а глазами по файлам —
 * находится ровно до следующего коммита.
 *
 * Каждое правило появилось из настоящей находки, а не из общих соображений:
 *
 *   • насыщенность. `--weight-*` считаются из настройки «Насыщенность» в
 *     styles/typography.ts. Восемьдесят мест в приложении были набраны числом
 *     `fontWeight: 600` — и ползунок двигал шрифт примерно нигде;
 *
 *   • кегль. Лестница `--text-*` тоже масштабируется настройкой. Зашитые 10px и
 *     11px оставались одиннадцатью пикселями и при «крупном» кегле;
 *
 *   • слои. Пятизначные `zIndex: 99999` не сравнить между собой и не выстроить в
 *     порядок: у темы для этого есть лестница `--z-*`;
 *
 *   • движение. Длительность числом не схлопывается ни ручкой «Движение», ни
 *     системным «меньше движения» — экран продолжает ехать, когда всё остальное
 *     уже замерло.
 */

const SRC = path.resolve(__dirname, '../../src');

/** Осмысленные исключения: их немного, и каждое объяснено на месте. */
const ALLOWED = [
  // Образцы цвета обязаны быть литералами — в них весь смысл.
  /styles[\\/]palette\.ts$/,
  /styles[\\/]presets\.ts$/,
  /styles[\\/]miniSkins\.ts$/,
  /styles[\\/]typography\.ts$/
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !ALLOWED.some((rule) => rule.test(full))) acc.push(full);
  }
  return acc;
}

/** Все строки исходников приложения с их адресом — по ним идут все правила ниже. */
const LINES: { at: string; line: string }[] = sourceFiles(SRC).flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((line, index) => ({ at: `${path.relative(SRC, file)}:${index + 1}`, line }))
);

/** Строки, попавшие под правило, с адресом — для читаемого промаха. */
function offenders(rule: RegExp, skip?: RegExp): string[] {
  return LINES.filter(({ line }) => rule.test(line) && !(skip && skip.test(line))).map(
    ({ at, line }) => `${at} — ${line.trim().slice(0, 90)}`
  );
}

describe('оформление в обход темы', () => {
  it('насыщенность шрифта берётся из токена, а не числом', () => {
    // Число ищется в любом месте значения, а не только сразу после двоеточия:
    // восемь мест были набраны через условие — `fontWeight: isActive ? 600 : 500`.
    // Ползунок «Насыщенность» не двигал ни активную вкладку в мобильном меню, ни
    // выбранный жанр в настройке волны, и именно там разница веса что-то значит.
    const found = offenders(/fontWeight:[^,\n]*\d/);

    expect(
      found,
      `настройка «Насыщенность» этих мест не коснётся — нужен var(--weight-*):\n${found.join('\n')}`
    ).toEqual([]);
  });

  it('кегль и скругление берутся из лестницы, а не в пикселях', () => {
    const found = offenders(/(fontSize|borderRadius):\s*'?\d+px/);

    expect(
      found,
      `зашитый размер не слушается настройки кегля и пресета:\n${found.join('\n')}`
    ).toEqual([]);
  });

  it('кегль не собран из разных ступеней лестницы', () => {
    // `--text-lg` рядом с `--leading-sm`: ступени лестницы посчитаны вместе, и по
    // отдельности межстрочное с кеглём не сходятся — строки налезают или зияют.
    const found: string[] = [];
    for (const { at, line } of LINES) {
      const size = line.match(/fontSize:\s*'var\(--text-([a-z0-9]+)\)'/);
      if (!size) continue;
      for (const kind of ['leading', 'tracking']) {
        const other = line.match(new RegExp(`--${kind}-([a-z0-9]+)\\)`));
        if (other && other[1] !== size[1]) found.push(`${at} — text-${size[1]} + ${kind}-${other[1]}`);
      }
    }

    expect(found, `кегль и его пара из разных ступеней:\n${found.join('\n')}`).toEqual([]);
  });

  it('слои берутся из лестницы --z-*, без пятизначных чисел', () => {
    // Мелкие 0…10 разрешены: это порядок внутри одного компонента, и лестница
    // темы про него ничего не знает. Запрещены числа, которыми пытаются
    // перекрыть всё приложение снаружи.
    const found = offenders(/zIndex:\s*\d{3}/);

    expect(found, `слой числом вместо var(--z-*):\n${found.join('\n')}`).toEqual([]);
  });

  it('длительность и кривая перехода берутся из токенов', () => {
    // `linear` разрешён: у него нет торможения, и для равномерного роста полосы
    // он единственный подходит — в AboutSettings это объяснено на месте.
    const found = offenders(
      /(transition|animation)[A-Za-z]*:\s*[`'][^`']*(\b\d+(\.\d+)?m?s\b|\bease\b|\bease-in\b|\bease-out\b|\bease-in-out\b|cubic-bezier)/,
      /var\(--(dur|ease)/
    );

    expect(
      found,
      `движение мимо темы: не схлопнется ни ручкой «Движение», ни prefers-reduced-motion:\n${found.join('\n')}`
    ).toEqual([]);
  });

  it('сам предохранитель ловит нарушения, а не просто молчит', () => {
    // Проверка на проверку: пять правил из регулярных выражений легко сломать так,
    // что они перестанут находить что-либо вообще, и всё выше станет зелёным
    // навсегда. Здесь взято ровно то, что в приложении и лежало.
    const samples: [RegExp, string][] = [
      [/fontWeight:[^,\n]*\d/, 'fontWeight: 600,'],
      [/fontWeight:[^,\n]*\d/, 'fontWeight: isActive ? 600 : 500,'],
      [/(fontSize|borderRadius):\s*'?\d+px/, "fontSize: '10px',"],
      [/zIndex:\s*\d{3}/, 'zIndex: 99999,'],
      [
        /(transition|animation)[A-Za-z]*:\s*[`'][^`']*(\b\d+(\.\d+)?m?s\b|\bease\b|cubic-bezier)/,
        "transition: 'transform 0.4s ease'"
      ]
    ];

    for (const [rule, sample] of samples) expect(rule.test(sample), sample).toBe(true);

    // И не считает нарушением то, ради чего всё делалось.
    expect(/fontWeight:[^,\n]*\d/.test("fontWeight: 'var(--weight-semibold)'")).toBe(false);
    expect(
      /fontWeight:[^,\n]*\d/.test("fontWeight: isActive ? 'var(--weight-bold)' : 'var(--weight-normal)'")
    ).toBe(false);
    expect(
      /(transition|animation)[A-Za-z]*:\s*[`'][^`']*(\b\d+(\.\d+)?m?s\b|\bease\b)/.test(
        "transition: 'transform var(--dur-slow) var(--ease-out)'"
      ) && !/var\(--(dur|ease)/.test("transition: 'transform var(--dur-slow) var(--ease-out)'")
    ).toBe(false);
  });
});
