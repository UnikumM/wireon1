import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Предохранитель против эмодзи в облике приложения.
 *
 * Просьба была дословной: «везде эмодзи убери, а то неуместно, эмодзи заменяй на
 * иконки». Причина не в вкусах: эмодзи рисует шрифт операционной системы, а не
 * приложение. Он не берёт цвет акцента, не отвечает на глубину темы, не
 * масштабируется вместе с шкалой `ICON`, выглядит по-разному в Windows, macOS и
 * Linux — и на любом пресете оформления остаётся чужой наклейкой. У приложения
 * для этого есть `lucide-react`.
 *
 * Проверяются исходники, а не отрендеренное дерево: эмодзи может лежать в
 * атрибуте, в подсказке, в тексте уведомления и в строке заголовка окна, и в
 * дереве одного экрана его не увидеть.
 *
 * Что намеренно разрешено — типографика, а не эмодзи: «·», «…», «×», «→», «←»,
 * знак бесконечности и тире. Это символы набора, у них нет цветного варианта, и
 * они рисуются тем же шрифтом, что текст рядом.
 */

const SRC = path.resolve(__dirname, '../../src');

/**
 * Диапазоны эмодзи.
 *
 * Разложены по группам, чтобы промах был читаемым: «Misc Symbols», «Dingbats» и
 * «Supplemental Symbols» лежат вне астральной плоскости, и одним диапазоном
 * `1F300–1FAFF` их не поймать — а именно оттуда берутся ✨, ✅, ❤ и ⚡, то есть
 * ровно то, что обычно и попадает в интерфейс.
 */
const EMOJI = [
  { name: 'пиктограммы и лица', pattern: /[\u{1F300}-\u{1FAFF}]/u },
  { name: 'эмотиконы', pattern: /[\u{1F600}-\u{1F64F}]/u },
  { name: 'транспорт и карты', pattern: /[\u{1F680}-\u{1F6FF}]/u },
  { name: 'региональные значки', pattern: /[\u{1F1E6}-\u{1F1FF}]/u },
  { name: 'разные символы', pattern: /[\u{2600}-\u{26FF}]/u },
  { name: 'дингбаты', pattern: /[\u{2700}-\u{27BF}]/u },
  { name: 'часы и стрелки-значки', pattern: /[\u{231A}-\u{23FF}]/u },
  { name: 'цветной вариант глифа', pattern: /\u{FE0F}/u },
  { name: 'составной эмодзи', pattern: /\u{200D}[\u{2000}-\u{3300}\u{1F000}-\u{1FAFF}]/u }
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx|css|html)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('эмодзи в интерфейсе', () => {
  it('ни одного эмодзи во всех исходниках приложения', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const group of EMOJI) {
          const found = group.pattern.exec(line);
          if (!found) continue;
          offenders.push(
            `${path.relative(SRC, file)}:${index + 1} — ${group.name}: ${found[0]} (${line.trim().slice(0, 80)})`
          );
          break;
        }
      });
    }

    expect(offenders, `эмодзи вместо иконки:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('сам предохранитель ловит эмодзи, а не просто молчит', () => {
    // Проверка на проверку: правило из девяти диапазонов легко сломать так, что
    // оно перестанет находить что-либо вообще, и тест выше станет зелёным
    // навсегда. Здесь берутся именно те символы, которые в приложении и были.
    for (const sample of ['Больше похожих ✨', 'готово ✅', 'играет 🎵', 'сердце ❤️', 'молния ⚡']) {
      expect(EMOJI.some((group) => group.pattern.test(sample)), sample).toBe(true);
    }
  });

  it('типографику и стрелки-подписи не считает эмодзи', () => {
    // Иначе предохранитель начал бы требовать «иконку вместо многоточия», и
    // подписи горячих клавиш «←/→» пришлось бы переписывать словами.
    for (const sample of ['Волна · Поток', 'Загрузка…', 'закрыть ×', '←/→ — перемотка', '∞ бесконечно', '0.8×']) {
      expect(EMOJI.some((group) => group.pattern.test(sample)), sample).toBe(false);
    }
  });
});
