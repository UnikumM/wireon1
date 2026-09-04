import { describe, it, expect } from 'vitest';
import {
  parseLRC,
  parseLRCWithMetadata,
  parsePlainLyrics,
  getActiveLineIndex,
  parseTimestampToSeconds
} from '../../src/services/lrcParser';

describe('lrcParser', () => {
  describe('parseTimestampToSeconds', () => {
    it('parses standard [mm:ss.xx] hundredths', () => {
      expect(parseTimestampToSeconds(undefined, '01', '23', '45')).toBeCloseTo(83.45, 2);
      expect(parseTimestampToSeconds(undefined, '00', '05', '50')).toBeCloseTo(5.5, 2);
      expect(parseTimestampToSeconds(undefined, '02', '00', '00')).toBe(120);
    });

    it('parses thousandths [mm:ss.xxx]', () => {
      expect(parseTimestampToSeconds(undefined, '01', '23', '456')).toBeCloseTo(83.456, 3);
      expect(parseTimestampToSeconds(undefined, '00', '10', '050')).toBeCloseTo(10.05, 3);
    });

    it('parses tenths [mm:ss.x]', () => {
      expect(parseTimestampToSeconds(undefined, '00', '12', '5')).toBeCloseTo(12.5, 1);
    });

    it('parses timestamps without fractional seconds', () => {
      expect(parseTimestampToSeconds(undefined, '03', '45', undefined)).toBe(225);
    });

    it('parses timestamps with hours [hh:mm:ss.xx]', () => {
      expect(parseTimestampToSeconds('01', '02', '03', '45')).toBeCloseTo(3723.45, 2);
    });
  });

  describe('parseLRC', () => {
    it('parses standard LRC lyrics string into sorted LyricsLine array', () => {
      const lrc = `
[ti:Test Song]
[ar:Test Artist]
[00:04.50]First line of lyrics
[00:12.00]Second line of lyrics
[00:25.80]Third line of lyrics
      `;

      const lines = parseLRC(lrc);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toEqual({ time: 4.5, text: 'First line of lyrics' });
      expect(lines[1]).toEqual({ time: 12.0, text: 'Second line of lyrics' });
      expect(lines[2]).toEqual({ time: 25.8, text: 'Third line of lyrics' });
    });

    it('handles multiple timestamp tags on a single line (repeated lines)', () => {
      const lrc = `
[00:10.00][00:20.00]Chorus line repeated
[00:05.00]Intro line
[00:30.00]Outro line
      `;

      const lines = parseLRC(lrc);
      expect(lines).toHaveLength(4);

      // Should be sorted chronologically
      expect(lines[0]).toEqual({ time: 5.0, text: 'Intro line' });
      expect(lines[1]).toEqual({ time: 10.0, text: 'Chorus line repeated' });
      expect(lines[2]).toEqual({ time: 20.0, text: 'Chorus line repeated' });
      expect(lines[3]).toEqual({ time: 30.0, text: 'Outro line' });
    });

    it('sorts lines chronologically when file is out of order', () => {
      const lrc = `
[01:00.00]Verse 2
[00:15.00]Verse 1
[00:45.00]Chorus 1
[00:02.00]Intro
      `;

      const lines = parseLRC(lrc);
      expect(lines).toHaveLength(4);
      expect(lines[0]).toEqual({ time: 2.0, text: 'Intro' });
      expect(lines[1]).toEqual({ time: 15.0, text: 'Verse 1' });
      expect(lines[2]).toEqual({ time: 45.0, text: 'Chorus 1' });
      expect(lines[3]).toEqual({ time: 60.0, text: 'Verse 2' });
    });

    it('handles Cyrillic and unicode characters in lyrics', () => {
      const lrc = `
[00:05.00]Привет, это тестовый трек
[00:10.50]Солнце светит ярко ☀️
[00:20.00]Звучит музыка в ночи 🎵
      `;

      const lines = parseLRC(lrc);
      expect(lines).toHaveLength(3);
      expect(lines[0].text).toBe('Привет, это тестовый трек');
      expect(lines[1].text).toBe('Солнце светит ярко ☀️');
      expect(lines[2].text).toBe('Звучит музыка в ночи 🎵');
    });

    it('returns empty array for empty, invalid, or null inputs', () => {
      expect(parseLRC('')).toEqual([]);
      expect(parseLRC('   \n\n\t ')).toEqual([]);
      expect(parseLRC(null as unknown as string)).toEqual([]);
      expect(parseLRC(undefined as unknown as string)).toEqual([]);
      expect(parseLRC('This is just plain text with no timestamps')).toEqual([]);
    });

    it('handles lines with timestamp but empty text (instrumental pause)', () => {
      const lrc = `
[00:05.00]Intro
[00:10.00]
[00:15.00]Verse starts
      `;

      const lines = parseLRC(lrc);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toEqual({ time: 5.0, text: 'Intro' });
      expect(lines[1]).toEqual({ time: 10.0, text: '' });
      expect(lines[2]).toEqual({ time: 15.0, text: 'Verse starts' });
    });
  });

  describe('parseLRCWithMetadata', () => {
    it('extracts metadata tags [ti:], [ar:], [al:], [by:], [length:]', () => {
      const lrc = `
[ti: Bohemian Rhapsody]
[ar: Queen]
[al: A Night at the Opera]
[by: Freddie Mercury]
[length: 05:55]
[00:01.00]Is this the real life?
[00:04.50]Is this just fantasy?
      `;

      const parsed = parseLRCWithMetadata(lrc);
      expect(parsed.metadata.title).toBe('Bohemian Rhapsody');
      expect(parsed.metadata.artist).toBe('Queen');
      expect(parsed.metadata.album).toBe('A Night at the Opera');
      expect(parsed.metadata.by).toBe('Freddie Mercury');
      expect(parsed.metadata.length).toBe('05:55');

      expect(parsed.lines).toHaveLength(2);
      expect(parsed.lines[0]).toEqual({ time: 1.0, text: 'Is this the real life?' });
    });

    it('applies positive and negative [offset:+/-ms] tag to all lines', () => {
      const lrcPositiveOffset = `
[offset:+500]
[00:10.00]Line 1
[00:20.00]Line 2
      `;

      const parsedPositive = parseLRCWithMetadata(lrcPositiveOffset);
      expect(parsedPositive.metadata.offset).toBe(500);
      expect(parsedPositive.lines[0].time).toBeCloseTo(10.5, 2);
      expect(parsedPositive.lines[1].time).toBeCloseTo(20.5, 2);

      const lrcNegativeOffset = `
[offset:-2000]
[00:01.00]Clamped line
[00:10.00]Shifted line
      `;

      const parsedNegative = parseLRCWithMetadata(lrcNegativeOffset);
      expect(parsedNegative.metadata.offset).toBe(-2000);
      // 1.0 - 2.0 = -1.0 -> clamped to 0
      expect(parsedNegative.lines[0].time).toBe(0);
      // 10.0 - 2.0 = 8.0
      expect(parsedNegative.lines[1].time).toBeCloseTo(8.0, 2);
    });
  });

  describe('parsePlainLyrics', () => {
    it('splits non-empty lines and returns array of lines', () => {
      const plain = `
First line
Second line

Third line
      `;

      const lines = parsePlainLyrics(plain);
      expect(lines).toHaveLength(3);
      expect(lines[0].text).toBe('First line');
      expect(lines[1].text).toBe('Second line');
      expect(lines[2].text).toBe('Third line');
    });

    it('returns empty array on empty or falsy inputs', () => {
      expect(parsePlainLyrics('')).toEqual([]);
      expect(parsePlainLyrics('   \n\n ')).toEqual([]);
      expect(parsePlainLyrics(null as unknown as string)).toEqual([]);
    });
  });

  describe('getActiveLineIndex', () => {
    const lines = [
      { time: 5.0, text: 'Intro' },
      { time: 12.0, text: 'Verse 1' },
      { time: 25.5, text: 'Chorus' },
      { time: 40.0, text: 'Verse 2' },
      { time: 60.0, text: 'Outro' }
    ];

    it('returns -1 before the first lyrics line starts', () => {
      expect(getActiveLineIndex(lines, 0)).toBe(-1);
      expect(getActiveLineIndex(lines, 4.9)).toBe(-1);
      expect(getActiveLineIndex(lines, -5)).toBe(-1);
    });

    it('returns exact line index when currentTime matches or falls within line window', () => {
      expect(getActiveLineIndex(lines, 5.0)).toBe(0);
      expect(getActiveLineIndex(lines, 8.5)).toBe(0);
      expect(getActiveLineIndex(lines, 11.99)).toBe(0);

      expect(getActiveLineIndex(lines, 12.0)).toBe(1);
      expect(getActiveLineIndex(lines, 20.0)).toBe(1);

      expect(getActiveLineIndex(lines, 25.5)).toBe(2);
      expect(getActiveLineIndex(lines, 30.0)).toBe(2);

      expect(getActiveLineIndex(lines, 40.0)).toBe(3);
      expect(getActiveLineIndex(lines, 59.9)).toBe(3);
    });

    it('returns last line index when playback passes the last line', () => {
      expect(getActiveLineIndex(lines, 60.0)).toBe(4);
      expect(getActiveLineIndex(lines, 120.0)).toBe(4);
      expect(getActiveLineIndex(lines, 999.0)).toBe(4);
    });

    it('returns -1 for empty or invalid lines array', () => {
      expect(getActiveLineIndex([], 10)).toBe(-1);
      expect(getActiveLineIndex(null as unknown as any[], 10)).toBe(-1);
    });
  });
});
