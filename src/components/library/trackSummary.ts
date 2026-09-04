import { UnifiedTrack } from '../../types/music';
import { formatDuration } from '../../utils/time';
import { pluralize } from '../../utils/plural';

export interface TrackTotals {
  count: number;
  /** Sum of the durations we actually know. */
  seconds: number;
  /** Tracks whose duration is missing or unusable. */
  unknown: number;
}

/**
 * A missing duration is not zero seconds. Unknown lengths are counted separately
 * so the summary line can admit it instead of quietly under-reporting the total.
 */
export function summarizeTracks(tracks: UnifiedTrack[]): TrackTotals {
  let seconds = 0;
  let unknown = 0;

  for (const track of tracks) {
    const duration = track?.duration;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      seconds += duration;
    } else {
      unknown += 1;
    }
  }

  return { count: tracks.length, seconds, unknown };
}

/** Например `12 треков · 48:20` — или `12 треков · 48:20 · 2 без длительности`. */
export function describeTrackTotals(tracks: UnifiedTrack[]): string {
  const { count, seconds, unknown } = summarizeTracks(tracks);
  const parts = [pluralize(count, 'трек', 'трека', 'треков')];

  if (count - unknown > 0) parts.push(formatDuration(seconds));
  if (unknown > 0) parts.push(`${unknown} без длительности`);

  return parts.join(' · ');
}

/**
 * The first `limit` distinct artworks, in order. Used for the playlist mosaic, so
 * duplicates of the same album do not produce four identical tiles.
 */
export function distinctArtwork(tracks: UnifiedTrack[], limit = 4): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const track of tracks) {
    const url = track?.artworkUrl;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= limit) break;
  }

  return urls;
}

/**
 * History newest-first with one entry per track. The store already prepends the
 * most recent play, so the first occurrence of an id is the one to keep.
 */
export function dedupeHistory(history: UnifiedTrack[]): UnifiedTrack[] {
  const seen = new Set<string>();
  const result: UnifiedTrack[] = [];

  for (const track of history) {
    if (!track?.id || seen.has(track.id)) continue;
    seen.add(track.id);
    result.push(track);
  }

  return result;
}
