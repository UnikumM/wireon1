import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { designVars, DEFAULT_PRESET_ID, NO_OVERRIDES } from '../../src/styles/presets';
import { typographyVars, DEFAULT_TYPOGRAPHY } from '../../src/styles/typography';
import { DEFAULT_ACCENT_HEX, DEFAULT_THEME_DEPTH } from '../../src/styles/palette';

/**
 * Договор между таблицей стилей и движком оформления.
 *
 * `theme.css` рисует самый первый кадр — до того, как выполнился JS и записал
 * переменные в `<html>`. Если значения в `:root` не совпадают с тем, что посчитает
 * `designVars` для пресета и глубины по умолчанию, окно моргнёт: сначала одна
 * палитра, через кадр другая. Заметно это именно на запуске, то есть каждый раз.
 *
 * Поэтому тест сравнивает не «примерно похоже», а точное равенство строк.
 */

const THEME_CSS = path.resolve(__dirname, '../../src/styles/theme.css');

/** Все файлы, где токен может быть объявлен или использован. */
const SRC_ROOT = path.resolve(__dirname, '../../src');

/**
 * Убирает комментарии, но не ссылки.
 *
 * Нужно затем, что в пояснениях токены упоминаются как есть — например
 * `var(--surface-*)` в DesignSettings.tsx. Без вычистки такое упоминание попало
 * бы в список использований и тест ругался бы на несуществующее имя. Строчные
 * комментарии срезаются только целой строкой: `//` внутри `https://` — не
 * комментарий.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(css|ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Значения из блока `:root` — до первого `[data-theme]`. */
function rootBlock(): Map<string, string> {
  const css = readFileSync(THEME_CSS, 'utf8');
  const start = css.indexOf(':root {');
  const end = css.indexOf("[data-theme='", start);
  const block = css.slice(start, end === -1 ? undefined : end);

  const out = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1], match[2].replace(/\s+/g, ' ').trim());
  }
  return out;
}

const EXPECTED = {
  ...designVars({
    presetId: DEFAULT_PRESET_ID,
    depth: DEFAULT_THEME_DEPTH,
    accentHex: DEFAULT_ACCENT_HEX,
    overrides: NO_OVERRIDES
  }),
  ...typographyVars(DEFAULT_TYPOGRAPHY)
};

describe('оформление по умолчанию', () => {
  const root = rootBlock();

  it('в :root объявлено каждое имя, которое пишет движок', () => {
    const missing = Object.keys(EXPECTED).filter((name) => !root.has(name));
    expect(missing, 'без этих имён первый кадр останется без значения').toEqual([]);
  });

  it('значения в :root совпадают с расчётом для пресета по умолчанию', () => {
    const drifted: string[] = [];
    for (const [name, value] of Object.entries(EXPECTED)) {
      const declared = root.get(name);
      if (declared === undefined) continue;
      if (declared !== value.replace(/\s+/g, ' ').trim()) drifted.push(`${name}: ${declared} ≠ ${value}`);
    }
    expect(drifted, 'первый кадр разойдётся с итоговым — окно моргнёт').toEqual([]);
  });
});

/**
 * Каждое имя, которое читается, должно кем-то объявляться.
 *
 * `var(--нет-такого)` не ошибка для браузера: свойство просто становится
 * недействительным и элемент получает начальное значение. Поэтому такая опечатка
 * не падает нигде и живёт годами — так и было с `--control-xs` в кнопке размера
 * `xs`: `min-height` молча превращался в `auto`, и высота кнопки зависела от
 * кегля и плотности вместо того, чтобы иметь пол.
 *
 * Имя со значением по умолчанию (`var(--x, 0)`) проверять незачем: у него пол
 * уже есть, и объявлять его необязательно — так работает `--float-phase`.
 */
describe('объявлены все токены, которые читаются', () => {
  const files = walk(SRC_ROOT);

  /** Объявления: `--x:` в CSS, `'--x'` строкой в TS (инлайновые свойства и setProperty). */
  const declared = new Set<string>(Object.keys(EXPECTED));

  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) declared.add(m[1]);
    for (const m of text.matchAll(/['"`](--[a-zA-Z0-9-]+)['"`]/g)) declared.add(m[1]);
  }

  it('нет ни одного var() без объявления и без значения по умолчанию', () => {
    const missing = new Map<string, string>();

    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      // Запятая внутри — значение по умолчанию, такое имя объявлять необязательно.
      for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
        if (!declared.has(m[1])) missing.set(m[1], path.relative(SRC_ROOT, file));
      }
    }

    expect(
      [...missing].map(([name, file]) => `${name} (${file})`),
      'эти имена читаются, но нигде не объявлены — свойство станет недействительным'
    ).toEqual([]);
  });
});
