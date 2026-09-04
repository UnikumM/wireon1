/**
 * LRC (Lyric) file parser for time-synced and plain text lyrics.
 * Supports:
 * - Standard timestamps: [mm:ss.xx] and [mm:ss.xxx]
 * - Extended timestamps: [hh:mm:ss.xx], [m:ss.xx], [mm:ss:xx], [mm:ss]
 * - Multi-timestamp lines: [00:12.00][00:24.00]Line text
 * - Metadata tags: [ti:], [ar:], [al:], [by:], [offset:], [length:], etc.
 * - Millisecond offset adjustment ([offset:+/-ms])
 * - Chronological sorting of lines
 * - Plain lyrics fallback parsing
 */

export interface LyricsLine {
  time: number; // In floating-point seconds (e.g. 74.5)
  text: string;
}

export interface LyricsMetadata {
  title?: string;
  artist?: string;
  album?: string;
  by?: string;
  offset?: number; // In milliseconds
  length?: string;
  [key: string]: string | number | undefined;
}

export interface ParsedLRC {
  lines: LyricsLine[];
  metadata: LyricsMetadata;
}

/**
 * Regex to match metadata tags: [tag:value]
 * Matches tags like [ti:Title], [ar:Artist], [al:Album], [by:Author], [offset:+500], etc.
 */
const METADATA_TAG_REGEX = /^\[([a-zA-Z]+)\s*:\s*([^\]]*)\]$/;

/**
 * Regex to match timestamp tags: [mm:ss.xx], [hh:mm:ss.xx], [m:ss.xxx], [mm:ss:xx], [mm:ss]
 */
const TIMESTAMP_TAG_REGEX = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/**
 * Parses a single timestamp match into floating-point seconds.
 * 
 * @param hours Optional hours component
 * @param minutes Minutes component
 * @param seconds Seconds component
 * @param fraction Optional hundredths/thousandths/frames component
 * @returns Time in seconds
 */
export function parseTimestampToSeconds(
  hours: string | undefined,
  minutes: string,
  seconds: string,
  fraction: string | undefined
): number {
  const h = hours ? parseInt(hours, 10) : 0;
  const m = parseInt(minutes, 10);
  const s = parseInt(seconds, 10);

  let fracSec = 0;
  if (fraction) {
    if (fraction.length === 1) {
      fracSec = parseInt(fraction, 10) / 10;
    } else if (fraction.length === 2) {
      fracSec = parseInt(fraction, 10) / 100;
    } else if (fraction.length === 3) {
      fracSec = parseInt(fraction, 10) / 1000;
    } else {
      fracSec = parseFloat(`0.${fraction}`);
    }
  }

  return h * 3600 + m * 60 + s + fracSec;
}

/**
 * Parses an LRC string with both metadata tags and timestamped lines.
 * Applies any [offset:+/-ms] tag to all line timestamps and sorts lines chronologically.
 *
 * @param lrcText Raw LRC format string
 * @returns ParsedLRC object containing sorted lines and metadata
 */
export function parseLRCWithMetadata(lrcText: string): ParsedLRC {
  if (!lrcText || typeof lrcText !== 'string') {
    return { lines: [], metadata: {} };
  }

  const rawLines = lrcText.split(/\r?\n/);
  const lines: LyricsLine[] = [];
  const metadata: LyricsMetadata = {};

  let offsetMs = 0;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Check for metadata tag
    const metaMatch = trimmed.match(METADATA_TAG_REGEX);
    if (metaMatch) {
      const tag = metaMatch[1].toLowerCase();
      const val = metaMatch[2].trim();

      if (tag === 'ti') metadata.title = val;
      else if (tag === 'ar') metadata.artist = val;
      else if (tag === 'al') metadata.album = val;
      else if (tag === 'by') metadata.by = val;
      else if (tag === 'length') metadata.length = val;
      else if (tag === 'offset') {
        const parsedOffset = parseInt(val, 10);
        if (!isNaN(parsedOffset)) {
          offsetMs = parsedOffset;
          metadata.offset = offsetMs;
        }
      } else {
        metadata[tag] = val;
      }
      continue;
    }

    // Check for timestamped lyrics line (can have multiple timestamps on one line)
    const timestamps: number[] = [];
    let match: RegExpExecArray | null;
    TIMESTAMP_TAG_REGEX.lastIndex = 0;

    while ((match = TIMESTAMP_TAG_REGEX.exec(trimmed)) !== null) {
      const [, hours, minutes, seconds, fraction] = match;
      const timeSec = parseTimestampToSeconds(hours, minutes, seconds, fraction);
      timestamps.push(timeSec);
    }

    if (timestamps.length > 0) {
      // The lyrics text is everything after all leading timestamp tags
      const text = trimmed.replace(TIMESTAMP_TAG_REGEX, '').trim();
      for (const time of timestamps) {
        lines.push({
          time,
          text
        });
      }
    }
  }

  // Apply offset if defined: standard LRC offset in ms (positive offset shifts lyrics earlier / shifts time)
  // Time adjustment: timeSec = Math.max(0, timeSec + offsetMs / 1000)
  if (offsetMs !== 0) {
    const offsetSec = offsetMs / 1000;
    for (const line of lines) {
      line.time = Math.max(0, line.time + offsetSec);
    }
  }

  // Sort lines chronologically
  lines.sort((a, b) => a.time - b.time);

  return { lines, metadata };
}

/**
 * Standard parse function extracting sorted time-synced lyrics lines.
 *
 * @param lrcText Raw LRC format text
 * @returns Array of LyricsLine sorted by timestamp
 */
export function parseLRC(lrcText: string): LyricsLine[] {
  return parseLRCWithMetadata(lrcText).lines;
}

/**
 * Parses plain un-synced lyrics into lines.
 *
 * @param plainText Raw multi-line plain text
 * @returns Array of LyricsLine with time set to 0
 */
export function parsePlainLyrics(plainText: string): LyricsLine[] {
  if (!plainText || typeof plainText !== 'string') {
    return [];
  }

  return plainText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((text, index) => ({
      time: index === 0 ? 0 : index, // sequential index fallback
      text
    }));
}

/**
 * Binary search or linear scan to find the currently active line index given current playback time.
 * Returns the index of the line where line[i].time <= currentTime < line[i+1].time.
 * Returns -1 if currentTime is before the first line.
 *
 * @param lines Chronologically sorted LyricsLine array
 * @param currentTime Current playback time in seconds
 * @returns Index of active line, or -1 if none
 */
export function getActiveLineIndex(lines: LyricsLine[], currentTime: number): number {
  if (!lines || lines.length === 0 || currentTime < 0) {
    return -1;
  }

  if (currentTime < lines[0].time) {
    return -1;
  }

  // Binary search for largest index where lines[index].time <= currentTime
  let low = 0;
  let high = lines.length - 1;
  let result = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lines[mid].time <= currentTime) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}
