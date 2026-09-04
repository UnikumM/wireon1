/**
 * Duration formatting / parsing helpers shared by the whole app.
 */

/**
 * Formats a duration in seconds as 'm:ss' or 'h:mm:ss'.
 * Non-finite, negative and zero inputs collapse to '0:00'.
 */
export function formatDuration(totalSeconds: number): string {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '0:00';
  }

  const total = Math.floor(totalSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const TWO_PART = /^(\d{1,2}):([0-5]\d)$/;
const THREE_PART = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/;

/**
 * Parses a strict 'm:ss' / 'mm:ss' / 'h:mm:ss' / 'hh:mm:ss' timestamp into seconds.
 * Anything else (view counts, bare numbers, out-of-range fields) yields 0.
 */
export function parseDurationToSeconds(input: string): number {
  if (typeof input !== 'string') return 0;

  const trimmed = input.trim();
  if (!trimmed) return 0;

  const threeMatch = THREE_PART.exec(trimmed);
  if (threeMatch) {
    return Number(threeMatch[1]) * 3600 + Number(threeMatch[2]) * 60 + Number(threeMatch[3]);
  }

  const twoMatch = TWO_PART.exec(trimmed);
  if (twoMatch) {
    return Number(twoMatch[1]) * 60 + Number(twoMatch[2]);
  }

  return 0;
}
