import { AudioSource, UnifiedTrack } from '../types/music';
import { youtubeService, YouTubeService } from './youtube';
import { soundCloudService, SoundCloudService } from './soundcloud';
import { streamResolver, StreamResolver } from './streamResolver';
import { isPlaceholderArtist } from '../utils/placeholders';

export interface SearchOptions {
  source?: AudioSource | 'all';
  limit?: number;
}

export interface SearchAggregateResult {
  results: UnifiedTrack[];
  sources: {
    youtube: number;
    soundcloud: number;
  };
  errors?: Record<string, string>;
}

export interface ISearchAggregator {
  search(query: string, options?: SearchOptions): Promise<SearchAggregateResult>;
  resolveStream(track: UnifiedTrack): Promise<string>;
  getSuggestions(query: string): Promise<string[]>;
  getRelatedTracks(track: UnifiedTrack, limit?: number): Promise<UnifiedTrack[]>;
}

/** Hard cap on cached queries so a long session cannot grow unbounded. */
const MAX_CACHE_ENTRIES = 50;

/** Radio duration band, in seconds: 30s to 15min. */
const RADIO_MIN_DURATION = 30;
const RADIO_MAX_DURATION = 900;

/**
 * Ceiling for a top-up candidate. The band can be relaxed to keep radio from
 * running dry, but a multi-hour stream is never acceptable in a queue.
 */
const RADIO_TOPUP_MAX_DURATION = 1800;

/** Minimum survivors before the rejected pool is reconsidered. */
const RADIO_MIN_SURVIVORS = 3;

/**
 * Long-form titles that slip under the duration cap. Word-bounded so `Remix`,
 * `Remixes` and `VIP Mix` survive; a bare `mix` or `live` is deliberately not
 * banned because it would take legitimate single tracks and live performances
 * with it.
 */
const LONG_FORM_TITLE_PATTERN =
  /\b(?:full album|album completo|podcast|episode|ep\.?\s*\d+|compilation|megamix|dj set|liveset|live set|playlist|non[- ]stop|\d+\s*hours?)\b/i;

/**
 * Normalizes title string for duplicate comparison
 */
function normalizeString(str: string): string {
  return (str || '')
    .toLowerCase()
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeKey(track: UnifiedTrack): string {
  return `${normalizeString(track.artist)}::${normalizeString(track.title)}`;
}

/**
 * A missing or unparseable duration means "unknown", not "unsuitable" —
 * discarding tracks for absent metadata is how radio ends up empty.
 */
function hasUnknownDuration(duration: number): boolean {
  return !Number.isFinite(duration) || duration === 0;
}

function isInRadioDurationBand(duration: number): boolean {
  if (hasUnknownDuration(duration)) return true;
  return duration >= RADIO_MIN_DURATION && duration <= RADIO_MAX_DURATION;
}

function isRadioFriendly(track: UnifiedTrack): boolean {
  if (!isInRadioDurationBand(track.duration)) return false;
  return !LONG_FORM_TITLE_PATTERN.test(track.title || '');
}

/** Anything not known to run past the top-up ceiling. */
function isTopUpEligible(track: UnifiedTrack): boolean {
  return hasUnknownDuration(track.duration) || track.duration < RADIO_TOPUP_MAX_DURATION;
}

export class SearchAggregator implements ISearchAggregator {
  private ytService: YouTubeService;
  private scService: SoundCloudService;
  private resolver: StreamResolver;
  private searchCache: Map<string, { timestamp: number; data: SearchAggregateResult }> = new Map();
  private cacheTTL = 60000; // 1 minute query cache

  constructor(
    ytService: YouTubeService = youtubeService,
    scService: SoundCloudService = soundCloudService,
    resolver: StreamResolver = streamResolver
  ) {
    this.ytService = ytService;
    this.scService = scService;
    this.resolver = resolver;
  }

  /**
   * Drops every entry whose TTL has elapsed. Called on each cache access so
   * stale results never linger for the rest of the session.
   */
  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.searchCache) {
      if (now - entry.timestamp >= this.cacheTTL) {
        this.searchCache.delete(key);
      }
    }
  }

  /**
   * Reads a cache entry, refreshing its LRU position on a hit.
   */
  private readCache(key: string): SearchAggregateResult | null {
    this.pruneExpired();

    const entry = this.searchCache.get(key);
    if (!entry) return null;

    // Re-insert so the most recently used key sits at the tail of the Map.
    this.searchCache.delete(key);
    this.searchCache.set(key, entry);
    return entry.data;
  }

  /**
   * Writes a cache entry, evicting the least recently used keys past the cap.
   */
  private writeCache(key: string, data: SearchAggregateResult): void {
    this.searchCache.delete(key);
    this.searchCache.set(key, { timestamp: Date.now(), data });

    while (this.searchCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.searchCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.searchCache.delete(oldestKey);
    }
  }

  /**
   * Number of live cache entries (expired ones are pruned first).
   */
  public getCacheSize(): number {
    this.pruneExpired();
    return this.searchCache.size;
  }

  /**
   * Unified parallel multi-source search with fault isolation & result interleaving
   */
  public async search(query: string, options: SearchOptions = {}): Promise<SearchAggregateResult> {
    const trimmed = (query || '').trim();
    if (!trimmed) {
      return {
        results: [],
        sources: { youtube: 0, soundcloud: 0 }
      };
    }

    const source = options.source || 'all';
    const limit = options.limit || 30;
    const cacheKey = `${trimmed}::${source}::${limit}`;

    const cached = this.readCache(cacheKey);
    if (cached) {
      return cached;
    }

    const errors: Record<string, string> = {};
    let ytResults: UnifiedTrack[] = [];
    let scResults: UnifiedTrack[] = [];

    const perSourceLimit = source === 'all' ? Math.ceil(limit / 2) + 5 : limit;

    const promises: Promise<void>[] = [];

    // Query YouTube
    if (source === 'all' || source === 'youtube') {
      promises.push(
        this.ytService
          .search(trimmed, perSourceLimit)
          .then(tracks => {
            ytResults = tracks;
          })
          .catch(err => {
            console.warn('[SearchAggregator] YouTube search failed:', err);
            errors.youtube = err?.message || 'YouTube search error';
          })
      );
    }

    // Query SoundCloud
    if (source === 'all' || source === 'soundcloud') {
      promises.push(
        this.scService
          .search(trimmed, perSourceLimit)
          .then(tracks => {
            scResults = tracks;
          })
          .catch(err => {
            console.warn('[SearchAggregator] SoundCloud search failed:', err);
            errors.soundcloud = err?.message || 'SoundCloud search error';
          })
      );
    }

    // Wait for all settled
    await Promise.allSettled(promises);

    let mergedResults: UnifiedTrack[] = [];

    if (source === 'youtube') {
      mergedResults = ytResults.slice(0, limit);
    } else if (source === 'soundcloud') {
      mergedResults = scResults.slice(0, limit);
    } else {
      // Interleave results 1:1: yt0, sc0, yt1, sc1, yt2, sc2...
      const maxLen = Math.max(ytResults.length, scResults.length);
      const seenTitles = new Set<string>();

      for (let i = 0; i < maxLen; i++) {
        if (i < ytResults.length) {
          const ytTrack = ytResults[i];
          const key = dedupeKey(ytTrack);
          if (!seenTitles.has(key)) {
            seenTitles.add(key);
            mergedResults.push(ytTrack);
          }
        }
        if (i < scResults.length) {
          const scTrack = scResults[i];
          const key = dedupeKey(scTrack);
          if (!seenTitles.has(key)) {
            seenTitles.add(key);
            mergedResults.push(scTrack);
          }
        }
        if (mergedResults.length >= limit) break;
      }
    }

    const result: SearchAggregateResult = {
      results: mergedResults,
      sources: {
        youtube: ytResults.length,
        soundcloud: scResults.length
      },
      ...(Object.keys(errors).length > 0 ? { errors } : {})
    };

    this.writeCache(cacheKey, result);
    return result;
  }

  /**
   * Resolves direct audio stream for a track
   */
  public async resolveStream(track: UnifiedTrack): Promise<string> {
    const info = await this.resolver.resolve(track);
    return info.streamUrl;
  }

  /**
   * Search suggestions autocomplete. Always degrades to an empty list.
   */
  public async getSuggestions(query: string): Promise<string[]> {
    try {
      const suggestions = await this.ytService.getSuggestions(query);
      return Array.isArray(suggestions) ? suggestions : [];
    } catch (err) {
      console.warn('[SearchAggregator] Suggestions failed:', err);
      return [];
    }
  }

  /**
   * Related tracks for the autoplay radio feature. Prefers the platform's own
   * recommendations and falls back to an artist search, then applies the radio
   * quality band. Never throws.
   */
  public async getRelatedTracks(track: UnifiedTrack, limit: number = 10): Promise<UnifiedTrack[]> {
    if (!track || !track.originalId) return [];

    const candidates: UnifiedTrack[] = [];
    const seenIds = new Set<string>([track.id]);
    const seenKeys = new Set<string>([dedupeKey(track)]);
    // Gather more than `limit` so the quality filter has slack to work with.
    const poolTarget = Math.max(limit * 3, limit + 10);

    const collect = (incoming: UnifiedTrack[] | undefined): void => {
      for (const candidate of incoming || []) {
        if (candidates.length >= poolTarget) return;
        if (!candidate || !candidate.id) continue;
        const key = dedupeKey(candidate);
        if (seenIds.has(candidate.id) || seenKeys.has(key)) continue;
        seenIds.add(candidate.id);
        seenKeys.add(key);
        candidates.push(candidate);
      }
    };

    try {
      if (track.source === 'youtube') {
        collect(await this.ytService.getRelatedVideos(track.originalId, limit * 2));
      } else if (track.source === 'soundcloud') {
        collect(await this.scService.getRelatedTracks(track.originalId, limit * 2));
      }
    } catch (err) {
      console.warn(`[SearchAggregator] Platform recommendations failed for ${track.id}:`, err);
    }

    // Counted after filtering: a pool of nothing but long-form uploads is as
    // empty as no pool at all, and should still trigger the artist search.
    if (candidates.filter(isRadioFriendly).length < limit) {
      const fallbackQuery =
        !isPlaceholderArtist(track.artist) ? track.artist : track.title;

      if (fallbackQuery) {
        try {
          const sameSource = await this.search(fallbackQuery, {
            limit: limit * 2,
            source: track.source
          });
          collect(sameSource.results);

          if (candidates.filter(isRadioFriendly).length === 0) {
            const anySource = await this.search(fallbackQuery, { limit: limit * 2, source: 'all' });
            collect(anySource.results);
          }
        } catch (err) {
          console.warn(`[SearchAggregator] Related-track fallback search failed for ${track.id}:`, err);
        }
      }
    }

    const collected = this.applyRadioFilter(candidates, limit);

    if (collected.length === 0) {
      console.warn(`[SearchAggregator] No related tracks found for ${track.id}`);
    }

    return collected;
  }

  /**
   * Keeps radio musical: drops anything outside the duration band or carrying a
   * long-form title. The filter itself never empties the radio — if too few
   * survive, rejects are restored in their original order, excluding anything
   * known to run past the top-up ceiling.
   */
  private applyRadioFilter(candidates: UnifiedTrack[], limit: number): UnifiedTrack[] {
    const kept: UnifiedTrack[] = [];
    const rejected: UnifiedTrack[] = [];

    for (const candidate of candidates) {
      if (isRadioFriendly(candidate)) {
        kept.push(candidate);
      } else {
        rejected.push(candidate);
      }
    }

    if (kept.length < Math.min(RADIO_MIN_SURVIVORS, limit)) {
      for (const candidate of rejected) {
        if (kept.length >= limit) break;
        if (isTopUpEligible(candidate)) kept.push(candidate);
      }
      if (rejected.length > 0) {
        console.warn(
          `[SearchAggregator] Radio filter left too few tracks; relaxed the duration band to fill ${kept.length}`
        );
      }
    }

    return kept.slice(0, limit);
  }

  /**
   * Clears in-memory search cache
   */
  public clearCache(): void {
    this.searchCache.clear();
  }
}

export const searchAggregator = new SearchAggregator();
