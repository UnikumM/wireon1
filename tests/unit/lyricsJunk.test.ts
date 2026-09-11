/**
 * Служебные строки в текстах песен (`src/services/lrcParser.ts`).
 *
 * LRCLIB собирает тексты из открытых источников и приносит вместе с ними всё,
 * что было на странице: пометки частей, шапку сборщика, рекламную врезку и
 * хвост «Embed». Жалоба звучала как «бывает мусор вместо текста лишний».
 *
 * Вторая половина проверки не менее важна первой: потерянная строчка песни
 * хуже лишней, поэтому здесь стоят настоящие строки, похожие на мусор.
 */

import { describe, it, expect } from 'vitest';
import { isJunkLyricLine, parseLRC, parsePlainLyrics } from '../../src/services/lrcParser';

describe('служебные строки', () => {
  it('пометки частей, шапка сборщика и хвост страницы — мусор', () => {
    for (const junk of [
      '[Chorus]',
      '[Verse 2]',
      '[Припев: Баста]',
      '(Bridge)',
      '15 ContributorsGet Lucky Lyrics',
      'You might also like',
      'Embed',
      '1.2KEmbed',
      'Written by: Thomas Bangalter',
      'Translations'
    ]) {
      expect(isJunkLyricLine(junk), junk).toBe(true);
    }
  });

  it('настоящие строчки не выбрасываются, даже если похожи', () => {
    for (const real of [
      'Like the legend of the phoenix',
      '(Ooh, ooh, ooh)',
      'We could embed this moment in time',
      'She was written by the stars',
      'Get lucky'
    ]) {
      expect(isJunkLyricLine(real), real).toBe(false);
    }
  });
});

describe('разбор с мусором', () => {
  it('пометка части с меткой времени не становится строкой караоке', () => {
    const lrc = [
      '[00:10.00][Verse 1]',
      '[00:12.00]Like the legend of the phoenix',
      '[00:20.00][Chorus]',
      '[00:22.00]We are up all night to get lucky'
    ].join('\n');

    const lines = parseLRC(lrc);

    expect(lines.map((line) => line.text)).toEqual([
      'Like the legend of the phoenix',
      'We are up all night to get lucky'
    ]);
  });

  it('обычный текст чистится тоже', () => {
    const plain = [
      '7 ContributorsOne More Time Lyrics',
      '[Intro]',
      'One more time',
      'You might also like',
      'We gonna celebrate',
      '28Embed'
    ].join('\n');

    expect(parsePlainLyrics(plain).map((line) => line.text)).toEqual([
      'One more time',
      'We gonna celebrate'
    ]);
  });
});
