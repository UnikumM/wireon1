import { describe, it, expect } from 'vitest';
import { formatDuration, parseDurationToSeconds } from '../../src/utils/time';

describe('utils/time', () => {
  describe('formatDuration', () => {
    it('formats sub-hour durations as m:ss', () => {
      expect(formatDuration(225)).toBe('3:45');
      expect(formatDuration(59)).toBe('0:59');
      expect(formatDuration(60)).toBe('1:00');
      expect(formatDuration(600)).toBe('10:00');
      expect(formatDuration(3599)).toBe('59:59');
    });

    it('formats hour-long durations as h:mm:ss', () => {
      expect(formatDuration(3600)).toBe('1:00:00');
      expect(formatDuration(3723)).toBe('1:02:03');
      expect(formatDuration(36000)).toBe('10:00:00');
    });

    it('truncates fractional seconds', () => {
      expect(formatDuration(225.9)).toBe('3:45');
      expect(formatDuration(0.4)).toBe('0:00');
    });

    it('returns 0:00 for every unusable input', () => {
      expect(formatDuration(0)).toBe('0:00');
      expect(formatDuration(-5)).toBe('0:00');
      expect(formatDuration(NaN)).toBe('0:00');
      expect(formatDuration(Infinity)).toBe('0:00');
      expect(formatDuration(-Infinity)).toBe('0:00');
      expect(formatDuration(undefined as unknown as number)).toBe('0:00');
      expect(formatDuration(null as unknown as number)).toBe('0:00');
      expect(formatDuration('225' as unknown as number)).toBe('0:00');
    });
  });

  describe('parseDurationToSeconds', () => {
    it('parses m:ss and mm:ss', () => {
      expect(parseDurationToSeconds('3:45')).toBe(225);
      expect(parseDurationToSeconds('0:07')).toBe(7);
      expect(parseDurationToSeconds('12:00')).toBe(720);
      expect(parseDurationToSeconds('59:59')).toBe(3599);
    });

    it('parses h:mm:ss and hh:mm:ss', () => {
      expect(parseDurationToSeconds('1:02:03')).toBe(3723);
      expect(parseDurationToSeconds('10:00:00')).toBe(36000);
    });

    it('trims surrounding whitespace', () => {
      expect(parseDurationToSeconds('  3:45 ')).toBe(225);
      expect(parseDurationToSeconds('\n1:02:03\t')).toBe(3723);
    });

    it('returns 0 for anything that is not a strict clock string', () => {
      expect(parseDurationToSeconds('1.2M plays')).toBe(0);
      expect(parseDurationToSeconds('5')).toBe(0);
      expect(parseDurationToSeconds('')).toBe(0);
      expect(parseDurationToSeconds('   ')).toBe(0);
      expect(parseDurationToSeconds('99:99')).toBe(0);
      expect(parseDurationToSeconds('abc')).toBe(0);
      expect(parseDurationToSeconds('3:45 min')).toBe(0);
      expect(parseDurationToSeconds('1:99:00')).toBe(0);
      expect(parseDurationToSeconds('-3:45')).toBe(0);
      expect(parseDurationToSeconds('3:4')).toBe(0);
      expect(parseDurationToSeconds('1:2:3')).toBe(0);
      expect(parseDurationToSeconds(null as unknown as string)).toBe(0);
      expect(parseDurationToSeconds(225 as unknown as string)).toBe(0);
    });

    it('round-trips with formatDuration', () => {
      for (const seconds of [7, 65, 225, 3599, 3600, 3723, 36000]) {
        expect(parseDurationToSeconds(formatDuration(seconds))).toBe(seconds);
      }
    });
  });
});
