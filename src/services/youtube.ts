import { detectPlatform, getStreamBridge } from './nativeBridge';
import { UnifiedTrack } from '../types/music';
import { formatDuration, parseDurationToSeconds } from '../utils/time';
import { UNKNOWN_ARTIST } from '../utils/placeholders';

export interface YouTubePlayerStream {
  streamUrl: string;
  format: 'm4a' | 'opus' | 'mp3' | string;
  bitrate: number;
  expiresAt: number;
}

export interface YouTubeServiceConfig {
  innertubeBaseUrl?: string;
  invidiousInstances?: string[];
  pipedInstances?: string[];
  requestTimeout?: number;
  /**
   * Allows the unauthenticated web `player` endpoint to be used as a last
   * resort. Defaults to "only when there is no Electron bridge available",
   * because that endpoint regularly answers 400 or returns URL-less formats
   * outside of a real browser context.
   */
  allowWebPlayerFallback?: boolean;
}

interface ElectronBridge {
  searchYouTube?: (query: string) => Promise<unknown>;
  /** Радио YouTube Music от песни; идёт через главный процесс из-за CORS. */
  youtubeRadio?: (videoId: string) => Promise<unknown>;
  resolveYouTubeStream?: (
    videoId: string,
    priority?: 'user' | 'prefetch',
    rejectUrl?: string
  ) => Promise<unknown>;
}

/**
 * Verified against `/api/v1/search?type=video` on 2026-08-17 and ordered by
 * measured latency. The public instance directory has largely collapsed, so
 * these were found by sweeping the known community hosts; most answer 401/403/
 * 404 or refuse the connection outright. Re-probe before assuming any of them
 * still works.
 */
const DEFAULT_INVIDIOUS_INSTANCES = [
  'https://invidious.flokinet.to',
  'https://invidious.schenkel.eti.br',
  'https://invidious.materialio.us'
];

/**
 * Verified against `/search?filter=music_songs` on 2026-08-17. Only one host in
 * the entire published directory still serves the API; the rest are shut down,
 * 502-ing behind a proxy, or returning their landing page as HTML.
 */
const DEFAULT_PIPED_INSTANCES = ['https://api.piped.private.coffee'];

/**
 * Per-instance budget for the fallback pool. Deliberately much shorter than
 * `requestTimeout`: a dead instance must not delay the next candidate, and the
 * verified hosts all answer well inside this (318-1826ms measured serially).
 */
const INSTANCE_TIMEOUT_MS = 4000;

/** Consecutive failures after which an instance is dropped for the session. */
const MAX_INSTANCE_FAILURES = 2;

/**
 * Thrown when no search backend could be reached at all. Distinct from an empty
 * result set, which legitimately means "this query has no matches".
 */
export const ALL_BACKENDS_UNAVAILABLE_MESSAGE = 'All YouTube search backends unavailable';

/** Outcome of walking an instance pool: did anything actually answer? */
interface PoolOutcome {
  tracks: UnifiedTrack[];
  reachable: boolean;
}

/** Fallback stream lifetime when a URL carries no `expire` parameter. */
const DEFAULT_STREAM_TTL_MS = 5.5 * 3600 * 1000;

/** `m:ss`, `mm:ss`, `h:mm:ss` — the only shapes a YouTube timestamp run takes. */
const TIMESTAMP_PATTERN = /^\d{1,2}(:\d{2}){1,2}$/;

/** Metadata runs such as "1.2M plays" or "532 views" — never a duration. */
const COUNT_RUN_PATTERN = /(views?|plays?|listeners?|followers?|subscribers?)$/i;

/** Leading result-type labels InnerTube prepends to the metadata column. */
const TYPE_LABEL_RUNS = new Set([
  'song',
  'video',
  'album',
  'single',
  'ep',
  'playlist',
  'artist',
  'station',
  'podcast',
  'episode'
]);

/**
 * Кто добывает поток и метаданные: главный процесс на десктопе, наш сервер на
 * телефоне. Выбор сделан в `nativeBridge.ts` — здесь важно только то, что формы
 * ответов у обоих совпадают, поэтому разбор ниже один на всех.
 */
function getElectronBridge(): ElectronBridge | null {
  return getStreamBridge();
}

/**
 * Coerces a number coming from a third party API, rejecting anything that is
 * not a finite positive value (Piped reports -1 for live streams, Invidious
 * sometimes omits `lengthSeconds` entirely).
 */
export function toPositiveInt(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric);
}

/** Alias kept for readability at the call sites that deal with durations. */
export const toDurationSeconds = toPositiveInt;

/**
 * Reads the real lifetime of a googlevideo stream URL from its `expire` query
 * parameter (seconds since epoch), mirroring the yt-dlp path in the main
 * process. Falls back to a fixed TTL when the parameter is missing.
 */
export function getStreamExpiryFromUrl(url: string, fallbackTtlMs: number = DEFAULT_STREAM_TTL_MS): number {
  if (url) {
    try {
      const expire = new URL(url).searchParams.get('expire');
      if (expire) {
        const seconds = parseInt(expire, 10);
        if (Number.isFinite(seconds) && seconds > 0) {
          return seconds * 1000;
        }
      }
    } catch (err) {
      console.warn('[YouTubeService] Could not read expiry from stream URL:', err);
    }
  }
  return Date.now() + fallbackTtlMs;
}

/**
 * Sanitizes YouTube video titles by stripping noise tags ([Official Video], (Lyrics), etc.)
 * and splitting "Artist - Title" formats.
 */
export function sanitizeYouTubeTitle(rawTitle: string, channelName: string = ''): { title: string; artist: string } {
  if (!rawTitle) return { title: '', artist: channelName };

  let cleaned = rawTitle
    .replace(/\[(Official\s*(Music\s*)?Video|Official\s*Audio|HD|4K|HQ|Lyrics?|Visualizer|Audio)\]/gi, '')
    .replace(/\((Official\s*(Music\s*)?Video|Official\s*Audio|HD|4K|HQ|Lyrics?|Visualizer|Audio)\)/gi, '')
    .replace(/\|.*$/g, '')
    .trim();

  let artist = (channelName || '').replace(/ - Topic$/i, '').trim();
  let title = cleaned;

  if (cleaned.includes(' - ')) {
    const parts = cleaned.split(' - ');
    if (parts.length >= 2) {
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    }
  }

  return {
    title: title || rawTitle,
    artist: artist || channelName || UNKNOWN_ARTIST
  };
}

/**
 * Обложка трека по идентификатору видео.
 *
 * `mqdefault`, а не `hqdefault`, и это не про качество. У `hqdefault` кадр
 * 480×360, то есть 4:3, и широкое видео YouTube вписывает в него **с чёрными
 * полями сверху и снизу, запечёнными в саму картинку**. Никакой `object-fit`
 * их не уберёт: для браузера это часть изображения, и на квадратной обложке
 * плеера получается марка в рамке вместо обложки.
 *
 * `mqdefault` — 320×180 без полей. Обрезать 16:9 до квадрата умеет `cover`, и
 * выходит то же, что делает любой телефонный плеер. 320 пикселей на обложку
 * размером в треть экрана хватает, а на телефоне это ещё и вчетверо меньше
 * трафика на каждую строку списка.
 */
export function getYouTubeArtworkUrl(videoId: string, fallbackThumbUrl?: string): string {
  if (!videoId) return fallbackThumbUrl || '';
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/**
 * Picks the run that actually looks like a timestamp out of an InnerTube
 * metadata column. Positional guessing produced 1-second durations whenever the
 * last run happened to be something like "1.2M plays".
 */
export function pickTimestampRun(runs: string[]): string {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = (runs[i] || '').trim();
    if (TIMESTAMP_PATTERN.test(run)) return run;
  }
  return '';
}

/**
 * Splits an InnerTube metadata column into the descriptive runs (artist, album)
 * and the duration string.
 */
export function splitMetadataRuns(runs: string[]): { meta: string[]; duration: string } {
  const cleaned = runs.map(run => (run || '').trim()).filter(run => run.length > 0 && run !== '•');
  const duration = pickTimestampRun(cleaned);

  const meta = cleaned.filter(
    run => run !== duration && !TIMESTAMP_PATTERN.test(run) && !COUNT_RUN_PATTERN.test(run)
  );

  if (meta.length > 1 && TYPE_LABEL_RUNS.has(meta[0].toLowerCase())) {
    meta.shift();
  }

  return { meta, duration };
}

export class YouTubeService {
  private invidiousInstances: string[];
  private pipedInstances: string[];
  private requestTimeout: number;
  private allowWebPlayerFallback?: boolean;
  /** Consecutive failure count per instance; capped entries are skipped. */
  private instanceFailures = new Map<string, number>();

  constructor(config: YouTubeServiceConfig = {}) {
    this.invidiousInstances = config.invidiousInstances || DEFAULT_INVIDIOUS_INSTANCES;
    this.pipedInstances = config.pipedInstances || DEFAULT_PIPED_INSTANCES;
    this.requestTimeout = config.requestTimeout || 6000;
    this.allowWebPlayerFallback = config.allowWebPlayerFallback;
  }

  /**
   * Instances that have not yet exhausted their failure budget. Once a host has
   * failed twice in a row it is skipped for the rest of the session, so a dead
   * pool costs one round of timeouts rather than one per search.
   *
   * Health is tracked per `scope` because the two endpoints fail independently:
   * a host commonly serves `/search` while returning 500 for `/streams/<id>`,
   * and losing a good search instance to a broken radio lookup would be worse
   * than the extra bookkeeping.
   */
  private liveInstances(pool: string[], scope: string): string[] {
    return pool.filter(
      instance =>
        (this.instanceFailures.get(`${scope}:${instance}`) || 0) < MAX_INSTANCE_FAILURES
    );
  }

  private recordInstanceFailure(instance: string, scope: string): void {
    const key = `${scope}:${instance}`;
    const failures = (this.instanceFailures.get(key) || 0) + 1;
    this.instanceFailures.set(key, failures);
    if (failures >= MAX_INSTANCE_FAILURES) {
      console.warn(
        `[YouTubeService] Disabling ${instance} (${scope}) for this session after ${failures} consecutive failures`
      );
    }
  }

  private recordInstanceSuccess(instance: string, scope: string): void {
    this.instanceFailures.delete(`${scope}:${instance}`);
  }

  /**
   * Clears the session's instance blocklist, e.g. after the network comes back.
   */
  public resetInstanceHealth(): void {
    this.instanceFailures.clear();
  }

  /**
   * Every outgoing request goes through here so nothing can hang forever.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = this.requestTimeout
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Primary Search: YouTube Music InnerTube WEB_REMIX API, with the Piped and
   * Invidious pools behind it. Throws `ALL_BACKENDS_UNAVAILABLE_MESSAGE` when
   * nothing answered, so callers can tell an outage from an empty result set.
   */
  public async search(query: string, limit: number = 20): Promise<UnifiedTrack[]> {
    if (!query || !query.trim()) {
      return [];
    }

    const trimmedQuery = query.trim();
    let anyBackendResponded = false;

    try {
      // 1. Try InnerTube WEB_REMIX endpoint
      const tracks = await this.searchInnerTube(trimmedQuery, limit);
      anyBackendResponded = true;
      if (tracks && tracks.length > 0) {
        return tracks.slice(0, limit);
      }
    } catch (err) {
      console.warn('[YouTubeService] InnerTube search failed, attempting fallback pool:', err);
    }

    // 2. Fallback to Piped API
    const piped = await this.searchPiped(trimmedQuery, limit);
    anyBackendResponded = anyBackendResponded || piped.reachable;
    if (piped.tracks.length > 0) {
      return piped.tracks.slice(0, limit);
    }

    // 3. Fallback to Invidious API
    const invidious = await this.searchInvidious(trimmedQuery, limit);
    anyBackendResponded = anyBackendResponded || invidious.reachable;
    if (invidious.tracks.length > 0) {
      return invidious.tracks.slice(0, limit);
    }

    if (!anyBackendResponded) {
      throw new Error(ALL_BACKENDS_UNAVAILABLE_MESSAGE);
    }

    console.warn(`[YouTubeService] No results for "${trimmedQuery}" from any provider`);
    return [];
  }

  /**
   * Query YouTube Music InnerTube Search
   */
  private async searchInnerTube(query: string, limit: number): Promise<UnifiedTrack[]> {
    const bridge = getElectronBridge();
    if (bridge && typeof bridge.searchYouTube === 'function') {
      try {
        const data = await bridge.searchYouTube(query);
        if (data) {
          return this.parseInnerTubeResponse(data, limit);
        }
      } catch (ipcErr) {
        console.warn('[YouTubeService] IPC search failed, trying direct fetch:', ipcErr);
      }
    }

    const payload = {
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20240101.01.00',
          hl: 'en',
          gl: 'US'
        }
      },
      query,
      params: 'Eg-KAQwIARAAGAAgACgAMABqChAEEAMQCRAFEAo%3D' // Songs filter
    };

    const response = await this.fetchWithTimeout('https://music.youtube.com/youtubei/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'X-YouTube-Client-Name': '67',
        'Origin': 'https://music.youtube.com',
        'Referer': 'https://music.youtube.com/'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`InnerTube HTTP error: ${response.status}`);
    }

    const data = await response.json();
    return this.parseInnerTubeResponse(data, limit);
  }

  /**
   * Parse InnerTube Search JSON payload
   */
  public parseInnerTubeResponse(data: any, limit: number = 20): UnifiedTrack[] {
    const results: UnifiedTrack[] = [];
    if (!data) return results;

    try {
      // Navigate through sections
      const sectionList = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ||
        data?.contents?.sectionListRenderer?.contents || [];

      for (const section of sectionList) {
        const items = section?.musicShelfRenderer?.contents ||
                      section?.musicCardShelfRenderer?.contents || [];

        for (const item of items) {
          if (results.length >= limit) break;
          const renderer = item.musicResponsiveListItemRenderer;
          if (!renderer) continue;

          // Video ID
          const videoId = renderer.playlistItemData?.videoId ||
                          renderer.doubleTapEndpoint?.watchEndpoint?.videoId ||
                          renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;

          if (!videoId) continue;

          // Title & Channel
          const flexColumns = renderer.flexColumns || [];
          const rawTitle = flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';

          const col1Runs: string[] = (flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [])
            .map((r: any) => r?.text || '');

          const { meta, duration: durationStr } = splitMetadataRuns(col1Runs);
          const channelName = meta[0] || '';
          const albumName = meta.length >= 2 ? meta[1] : undefined;
          const durationSec = parseDurationToSeconds(durationStr);

          // Artwork
          const thumbnails = renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
          const rawArtwork = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : '';
          const artworkUrl = getYouTubeArtworkUrl(videoId, rawArtwork);

          const { title, artist } = sanitizeYouTubeTitle(rawTitle, channelName);

          results.push({
            id: `yt_${videoId}`,
            source: 'youtube',
            originalId: videoId,
            title,
            artist,
            album: albumName,
            duration: durationSec,
            durationFormatted: formatDuration(durationSec),
            artworkUrl,
            sourceUrl: `https://www.youtube.com/watch?v=${videoId}`
          });
        }
      }
    } catch (e) {
      console.warn('[YouTubeService] Error parsing InnerTube response:', e);
    }

    return results;
  }

  /**
   * Piped Search Fallback. Only a well-formed payload counts as "reachable":
   * a 502 from a proxy in front of a dead backend is a failure, not a query
   * that legitimately has no matches.
   */
  private async searchPiped(query: string, limit: number): Promise<PoolOutcome> {
    let reachable = false;

    for (const instance of this.liveInstances(this.pipedInstances, 'search')) {
      try {
        const url = `${instance}/search?q=${encodeURIComponent(query)}&filter=music_songs`;
        const response = await this.fetchWithTimeout(url, {}, INSTANCE_TIMEOUT_MS);

        if (!response.ok) {
          console.warn(`[YouTubeService] Piped ${instance} returned HTTP ${response.status}`);
          this.recordInstanceFailure(instance, 'search');
          continue;
        }
        const data = await response.json();
        if (!data || !Array.isArray(data.items)) {
          console.warn(`[YouTubeService] Piped ${instance} returned an unexpected payload`);
          this.recordInstanceFailure(instance, 'search');
          continue;
        }

        reachable = true;
        const results: UnifiedTrack[] = [];
        for (const item of data.items) {
          if (results.length >= limit) break;
          const track = this.mapPipedItem(item);
          if (track) results.push(track);
        }

        this.recordInstanceSuccess(instance, 'search');
        if (results.length > 0) {
          return { tracks: results, reachable };
        }
      } catch (err) {
        console.warn(`[YouTubeService] Piped ${instance} unreachable:`, err);
        this.recordInstanceFailure(instance, 'search');
      }
    }
    return { tracks: [], reachable };
  }

  /**
   * Normalizes a Piped search/related entry. Returns null when unusable.
   */
  private mapPipedItem(item: any): UnifiedTrack | null {
    const rawUrl: string = item?.url || '';
    const videoId = rawUrl.includes('v=') ? rawUrl.split('v=')[1].split('&')[0] : '';
    if (!videoId) return null;

    const durationSec = toDurationSeconds(item?.duration);
    const { title, artist } = sanitizeYouTubeTitle(item?.title || '', item?.uploaderName || '');
    if (!title) return null;

    return {
      id: `yt_${videoId}`,
      source: 'youtube',
      originalId: videoId,
      title,
      artist,
      duration: durationSec,
      durationFormatted: formatDuration(durationSec),
      artworkUrl: item?.thumbnail || getYouTubeArtworkUrl(videoId),
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }

  /**
   * Invidious Search Fallback. Mirrors `searchPiped`, including the distinction
   * between "answered with nothing" and "never answered".
   */
  private async searchInvidious(query: string, limit: number): Promise<PoolOutcome> {
    let reachable = false;

    for (const instance of this.liveInstances(this.invidiousInstances, 'search')) {
      try {
        const url = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
        const response = await this.fetchWithTimeout(url, {}, INSTANCE_TIMEOUT_MS);

        if (!response.ok) {
          console.warn(`[YouTubeService] Invidious ${instance} returned HTTP ${response.status}`);
          this.recordInstanceFailure(instance, 'search');
          continue;
        }
        const data = await response.json();
        if (!Array.isArray(data)) {
          console.warn(`[YouTubeService] Invidious ${instance} returned an unexpected payload`);
          this.recordInstanceFailure(instance, 'search');
          continue;
        }

        reachable = true;
        const results: UnifiedTrack[] = [];
        for (const item of data) {
          if (results.length >= limit) break;
          const track = this.mapInvidiousItem(item);
          if (track) results.push(track);
        }

        this.recordInstanceSuccess(instance, 'search');
        if (results.length > 0) {
          return { tracks: results, reachable };
        }
      } catch (err) {
        console.warn(`[YouTubeService] Invidious ${instance} unreachable:`, err);
        this.recordInstanceFailure(instance, 'search');
      }
    }
    return { tracks: [], reachable };
  }

  /**
   * Normalizes an Invidious video entry. Returns null when unusable.
   */
  private mapInvidiousItem(item: any): UnifiedTrack | null {
    const videoId: string = item?.videoId || '';
    if (!videoId) return null;

    const durationSec = toDurationSeconds(item?.lengthSeconds);
    const { title, artist } = sanitizeYouTubeTitle(item?.title || '', item?.author || '');
    if (!title) return null;

    return {
      id: `yt_${videoId}`,
      source: 'youtube',
      originalId: videoId,
      title,
      artist,
      duration: durationSec,
      durationFormatted: formatDuration(durationSec),
      artworkUrl: getYouTubeArtworkUrl(videoId),
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }

  /**
   * Autocomplete search suggestions from Google suggest. The response is served
   * as text/javascript, so it is parsed manually rather than through res.json().
   */
  public async getSuggestions(query: string): Promise<string[]> {
    if (!query || !query.trim()) return [];

    try {
      const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query.trim())}`;
      const res = await this.fetchWithTimeout(url, {}, Math.min(this.requestTimeout, 3000));

      if (!res.ok) {
        console.warn(`[YouTubeService] Suggestions returned HTTP ${res.status}`);
        return [];
      }

      const parsed = await this.readSuggestionPayload(res);
      if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
        return parsed[1].filter((s: unknown): s is string => typeof s === 'string').slice(0, 8);
      }
      console.warn('[YouTubeService] Unexpected suggestions payload shape');
    } catch (err) {
      console.warn('[YouTubeService] Suggestions request failed:', err);
    }
    return [];
  }

  /**
   * Accepts either a real JSON response or the text/javascript body Google
   * actually returns.
   */
  private async readSuggestionPayload(res: Response): Promise<unknown> {
    if (typeof res.text === 'function') {
      const body = await res.text();
      try {
        return JSON.parse(body);
      } catch (err) {
        console.warn('[YouTubeService] Suggestions body was not JSON:', err);
        return null;
      }
    }
    return res.json();
  }

  /**
   * Разбирает очередь радио из ответа InnerTube `next`.
   *
   * Открыт наружу ради тестов: сам запрос уходит через мост в главный процесс, а
   * проверять надо именно разбор — на нём и держится связность жанра.
   *
   * Исполнитель берётся по признаку страницы (`MUSIC_PAGE_TYPE_ARTIST`), а не по
   * месту в строке: подпись бывает и «Артист • Альбом • Год», и «Канал • 1,8 млрд
   * просмотров», и разбор по позиции во втором случае принёс бы в имя счётчик
   * просмотров.
   */
  public parseRadioResponse(data: any, limit: number = 20, seedVideoId?: string): UnifiedTrack[] {
    const results: UnifiedTrack[] = [];
    if (!data) return results;

    try {
      const contents =
        data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
          ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer
          ?.content?.playlistPanelRenderer?.contents || [];

      for (const item of contents) {
        if (results.length >= limit) break;
        const renderer = item?.playlistPanelVideoRenderer;
        if (!renderer) continue;

        const id = renderer.videoId;
        // Первым в очереди стоит сама песня-семя: в поток её добавлять незачем.
        if (typeof id !== 'string' || id.length === 0 || id === seedVideoId) continue;

        const rawTitle = renderer.title?.runs?.[0]?.text || '';
        if (!rawTitle) continue;

        const bylineRuns: any[] = renderer.longBylineText?.runs || [];
        const artistRun = bylineRuns.find(
          (run) =>
            run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
              ?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ARTIST'
        );
        const albumRun = bylineRuns.find(
          (run) =>
            run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
              ?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ALBUM'
        );
        const channelName =
          artistRun?.text ||
          renderer.shortBylineText?.runs?.[0]?.text ||
          bylineRuns[0]?.text ||
          '';

        const durationSec = parseDurationToSeconds(renderer.lengthText?.runs?.[0]?.text || '');
        const thumbnails = renderer.thumbnail?.thumbnails || [];
        const rawArtwork = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1]?.url : '';

        const { title, artist } = sanitizeYouTubeTitle(rawTitle, channelName);

        results.push({
          id: `yt_${id}`,
          source: 'youtube',
          originalId: id,
          title,
          artist,
          album: albumRun?.text,
          duration: durationSec,
          durationFormatted: formatDuration(durationSec),
          artworkUrl: getYouTubeArtworkUrl(id, rawArtwork),
          sourceUrl: `https://www.youtube.com/watch?v=${id}`
        });
      }
    } catch (e) {
      console.warn('[YouTubeService] Error parsing radio response:', e);
    }

    return results;
  }

  /**
   * Радио от песни через главный процесс. Пустой массив — «этим путём не вышло».
   */
  private async radioViaBridge(videoId: string, limit: number): Promise<UnifiedTrack[]> {
    const bridge = getElectronBridge();
    if (!bridge || typeof bridge.youtubeRadio !== 'function') return [];
    try {
      const data = await bridge.youtubeRadio(videoId);
      return this.parseRadioResponse(data, limit, videoId);
    } catch (err) {
      console.warn('[YouTubeService] Radio via bridge failed:', err);
      return [];
    }
  }

  /**
   * Related videos for autoplay radio. Never throws — an empty array simply
   * means "no radio available from this provider".
   *
   * Порядок источников: сначала радио самого YouTube Music, потом публичные
   * зеркала. Зеркала оставлены не «на всякий случай», а потому что в браузерной
   * сборке моста нет вовсе — там они единственный путь.
   */
  public async getRelatedVideos(videoId: string, limit: number = 10): Promise<UnifiedTrack[]> {
    if (!videoId) return [];

    const radio = await this.radioViaBridge(videoId, limit);
    if (radio.length > 0) return radio;

    for (const instance of this.liveInstances(this.pipedInstances, 'related')) {
      try {
        const response = await this.fetchWithTimeout(
          `${instance}/streams/${encodeURIComponent(videoId)}`,
          {},
          INSTANCE_TIMEOUT_MS
        );
        if (!response.ok) {
          console.warn(`[YouTubeService] Piped related ${instance} returned HTTP ${response.status}`);
          this.recordInstanceFailure(instance, 'related');
          continue;
        }
        const data = await response.json();
        const related = Array.isArray(data?.relatedStreams) ? data.relatedStreams : [];
        const results: UnifiedTrack[] = [];
        for (const item of related) {
          if (results.length >= limit) break;
          const track = this.mapPipedItem(item);
          if (track && track.originalId !== videoId) results.push(track);
        }
        if (results.length > 0) {
          this.recordInstanceSuccess(instance, 'related');
          return results;
        }
        this.recordInstanceFailure(instance, 'related');
      } catch (err) {
        console.warn(`[YouTubeService] Piped related ${instance} unreachable:`, err);
        this.recordInstanceFailure(instance, 'related');
      }
    }

    for (const instance of this.liveInstances(this.invidiousInstances, 'related')) {
      try {
        const response = await this.fetchWithTimeout(
          `${instance}/api/v1/videos/${encodeURIComponent(videoId)}`,
          {},
          INSTANCE_TIMEOUT_MS
        );
        if (!response.ok) {
          console.warn(`[YouTubeService] Invidious related ${instance} returned HTTP ${response.status}`);
          this.recordInstanceFailure(instance, 'related');
          continue;
        }
        const data = await response.json();
        const related = Array.isArray(data?.recommendedVideos) ? data.recommendedVideos : [];
        const results: UnifiedTrack[] = [];
        for (const item of related) {
          if (results.length >= limit) break;
          const track = this.mapInvidiousItem(item);
          if (track && track.originalId !== videoId) results.push(track);
        }
        if (results.length > 0) {
          this.recordInstanceSuccess(instance, 'related');
          return results;
        }
        this.recordInstanceFailure(instance, 'related');
      } catch (err) {
        console.warn(`[YouTubeService] Invidious related ${instance} unreachable:`, err);
        this.recordInstanceFailure(instance, 'related');
      }
    }

    console.warn(`[YouTubeService] No related videos available for ${videoId}`);
    return [];
  }

  /**
   * Resolves a direct audio stream for a YouTube video. The Electron IPC path
   * (yt-dlp in the main process) is authoritative; the unauthenticated web
   * `player` endpoint is only tried when no bridge exists at all.
   *
   * @param priority `prefetch` — фоновая задача. Главный процесс держит для
   *   такой узкий лимит процессов, чтобы нажатие play не ждало её.
   */
  /**
   * @param rejectUrl ссылка, которую плеер уже получил и играть не смог.
   *   Доезжает до перебора клиентов на телефоне, чтобы повтор после осечки не
   *   вернул тот же самый адрес. Главный процесс на десктопе её игнорирует —
   *   там перебор с проверкой ссылки идёт внутри и без подсказок.
   */
  public async resolveStreamUrl(
    videoId: string,
    priority: 'user' | 'prefetch' = 'user',
    rejectUrl?: string
  ): Promise<YouTubePlayerStream> {
    if (!videoId) {
      throw new Error('Missing YouTube videoId');
    }

    const bridge = getElectronBridge();
    const hasIpc = !!bridge && typeof bridge.resolveYouTubeStream === 'function';

    if (hasIpc) {
      try {
        const resolved = await bridge!.resolveYouTubeStream!(videoId, priority, rejectUrl);
        const normalized = this.normalizeIpcStream(resolved);
        if (normalized) return normalized;
        console.warn('[YouTubeService] IPC returned an unusable stream payload');
        throw new Error(`YT_NO_AUDIO: main process returned no usable stream for ${videoId}`);
      } catch (err) {
        console.error('[YouTubeService] IPC stream resolution failed:', err);

        // Opting in is the only way to reach the web `player` endpoint from the
        // desktop build — see the comment below for why it is off by default.
        if (this.allowWebPlayerFallback === true) {
          try {
            const fallback = await this.resolveViaWebPlayer(videoId);
            if (fallback) return fallback;
          } catch (fallbackErr) {
            console.warn('[YouTubeService] Web player fallback failed:', fallbackErr);
          }
        }

        // yt-dlp already rotated four client configurations and probed each URL.
        // The web `player` endpoint is strictly weaker, so the precise diagnosis
        // (`YT_AGE_RESTRICTED`, `YT_GEO_BLOCKED`, …) is worth more than a retry —
        // `describePlaybackError` turns those codes into copy the listener can act on.
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    // Browser build only: no main process, so this is the sole option.
    if (this.allowWebPlayerFallback !== false) {
      try {
        const fallback = await this.resolveViaWebPlayer(videoId);
        if (fallback) return fallback;
      } catch (err) {
        console.warn('[YouTubeService] Web player fallback failed:', err);
      }
    }

    throw new Error(`Unable to resolve audio stream for YouTube video: ${videoId}`);
  }

  /**
   * Говорит главному процессу, что фоновую заявку теперь ждёт человек.
   *
   * Нужно из-за склейки одинаковых запросов: если ссылку уже качает
   * предзагрузка, второй вызов `resolveStreamUrl` до главного процесса не
   * доходит вообще — а значит и приоритет там остаётся фоновым. Дедупликация по
   * videoId живёт и в главном процессе, поэтому лишнего извлекателя это не
   * запускает: заявка находится по id и поднимается на месте.
   *
   * Ошибку глотаем: это подсказка планировщику, а не само получение ссылки —
   * его результат ждёт другой вызов.
   */
  public raiseStreamPriority(videoId: string): void {
    if (!videoId) return;

    /*
     * На телефоне очередь своя, и она здесь же, на устройстве.
     *
     * Раньше этот вызов на телефоне не делал ничего: считалось, что приоритет —
     * свойство главного процесса, а у сервера очередь общая на всех слушателей.
     * С тех пор ссылки добывает сам телефон, и очередь у него двухполосная:
     * заявку, которая ждёт в фоновой полосе, можно перенести в полосу человека.
     * Без этого нажатие play на треке, который уже греется, стояло за всеми
     * остальными прогревами — на эмуляторе замерено 25,5 секунды.
     */
    if (detectPlatform() === 'mobile') {
      void import('./ytDlpOnDevice')
        .then(({ raiseYtDlpPriority }) => raiseYtDlpPriority(videoId))
        .catch(() => {});
      return;
    }
    if (detectPlatform() !== 'electron') return;

    const bridge = getElectronBridge();
    if (!bridge || typeof bridge.resolveYouTubeStream !== 'function') return;
    try {
      void Promise.resolve(bridge.resolveYouTubeStream(videoId, 'user')).catch(() => {});
    } catch {
      // Мост может исчезнуть между проверкой и вызовом — молча, приоритет не критичен.
    }
  }

  /**
   * Validates and repairs a stream payload coming back over IPC. The expiry is
   * recomputed from the URL when the main process did not supply a sane one.
   */
  private normalizeIpcStream(resolved: unknown): YouTubePlayerStream | null {
    const candidate = resolved as Partial<YouTubePlayerStream> | null | undefined;
    if (!candidate || typeof candidate.streamUrl !== 'string' || !candidate.streamUrl) {
      return null;
    }

    const expiresAt =
      typeof candidate.expiresAt === 'number' &&
      Number.isFinite(candidate.expiresAt) &&
      candidate.expiresAt > Date.now()
        ? candidate.expiresAt
        : getStreamExpiryFromUrl(candidate.streamUrl);

    return {
      streamUrl: candidate.streamUrl,
      format: candidate.format || 'm4a',
      bitrate: toPositiveInt(candidate.bitrate) || 128,
      expiresAt
    };
  }

  /**
   * Last-resort resolution through the public InnerTube `player` endpoint. This
   * frequently answers 400 or hands back signature-ciphered formats outside a
   * browser, so callers must treat null as the normal outcome.
   */
  private async resolveViaWebPlayer(videoId: string): Promise<YouTubePlayerStream | null> {
    const payload = {
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '19.09.37',
          hl: 'en',
          gl: 'US'
        }
      },
      videoId
    };

    const response = await this.fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11; en_US) gzip'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.warn(`[YouTubeService] Web player endpoint returned HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    const adaptiveFormats: any[] = data?.streamingData?.adaptiveFormats || [];
    const audioFormats = adaptiveFormats
      .filter(f => f.mimeType && f.mimeType.startsWith('audio/') && f.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    const bestM4a = audioFormats.find(f => f.itag === 140);
    const bestOpus = audioFormats.find(f => f.itag === 251);
    const chosen = bestM4a || bestOpus || audioFormats[0];

    if (!chosen) {
      console.warn('[YouTubeService] Web player endpoint returned no directly playable audio format');
      return null;
    }

    return {
      streamUrl: chosen.url,
      format: chosen.mimeType?.includes('mp4') ? 'm4a' : 'opus',
      bitrate: Math.round((chosen.bitrate || 128000) / 1000),
      expiresAt: getStreamExpiryFromUrl(chosen.url)
    };
  }
}

export const youtubeService = new YouTubeService();
