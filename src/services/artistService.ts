/**
 * Artist profiles for Wireon.
 *
 * Everything here is sourced or absent. The previous version filled the gaps —
 * an invented "1.2M monthly listeners", a synthesized "Greatest Hits" album, a
 * `verified: true` nobody checked, a `cdn.art` banner that does not exist — which
 * made a half-real profile look complete. A missing field now stays missing, and
 * the UI simply does not render that row.
 *
 * Sources, in order of trust:
 *   1. YouTube Music InnerTube `browse` on the artist channel — name, avatar,
 *      real subscriber count, real albums with real years, real "fans might also
 *      like", and the artist's own description.
 *   2. Wikipedia (Russian first, then English) — biography.
 *   3. The search aggregator — top tracks, when `browse` gave none.
 */

import { UnifiedTrack } from '../types/music';
import { formatDuration, parseDurationToSeconds } from '../utils/time';
import { searchAggregator } from './aggregator';
import { getYouTubeArtworkUrl, youtubeService } from './youtube';
import { UNKNOWN_ARTIST } from '../utils/placeholders';

export interface ArtistAlbum {
  id: string;
  title: string;
  /** Release year as YouTube Music states it. Absent when it does not. */
  year?: string;
  coverUrl?: string;
  /** Only set when the source actually reports a track count. */
  trackCount?: number;
  /** `browseId` of the album, for a future "open album" view. */
  browseId?: string;
}

export interface SimilarArtist {
  name: string;
  imageUrl?: string;
  browseId?: string;
}

export interface ArtistProfile {
  name: string;
  bannerUrl?: string;
  avatarUrl?: string;
  bio?: string;
  /** Where `bio` came from, so the UI can credit it honestly. */
  bioSource?: 'wikipedia-ru' | 'wikipedia-en' | 'youtube-music';
  topTracks: UnifiedTrack[];
  albums: ArtistAlbum[];
  similarArtists: SimilarArtist[];
  /** Verbatim from YouTube Music, e.g. «4,5 млн подписчиков». */
  subscriberCount?: string;
  /** YouTube Music channel id, so a refresh can skip the search step. */
  channelId?: string;
  /** True when nothing but the name could be resolved. */
  isSparse?: boolean;
}

/** InnerTube `params` for the "Artists" search filter. */
const ARTIST_SEARCH_PARAMS = 'EgWKAQIgAWoKEAMQBBAJEAoQBQ%3D%3D';

const MUSIC_ORIGIN = 'https://music.youtube.com';
const INNERTUBE_BROWSE = `${MUSIC_ORIGIN}/youtubei/v1/browse`;
const INNERTUBE_SEARCH = `${MUSIC_ORIGIN}/youtubei/v1/search`;

const REQUEST_TIMEOUT_MS = 8000;
const MAX_TOP_TRACKS = 10;
const MAX_ALBUMS = 12;
const MAX_SIMILAR = 12;

/** Interface language. Russian first — this is a Russian-language build. */
const INNERTUBE_CONTEXT = {
  client: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240101.01.00',
    hl: 'ru',
    gl: 'RU'
  }
};

const INNERTUBE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-YouTube-Client-Name': '67',
  Origin: MUSIC_ORIGIN,
  Referer: `${MUSIC_ORIGIN}/`
};

type Json = Record<string, unknown>;

/**
 * Собирает строки треков откуда угодно в ответе.
 *
 * Глубина ограничена: ответы InnerTube иногда содержат ссылки на самих себя, и
 * обход без предела на таком уходит в бесконечность вместе с окном.
 */
function collectRows(node: unknown, out: unknown[], depth: number): void {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) {
    for (const item of node) collectRows(item, out, depth + 1);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.musicResponsiveListItemRenderer) out.push(record);
  for (const key of Object.keys(record)) collectRows(record[key], out, depth + 1);
}

/** Reads `a.b.c` without a chain of `?.` at every call site. */
function dig(source: unknown, ...path: (string | number)[]): unknown {
  let node: unknown = source;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Json)[key as string];
  }
  return node;
}

/** Joins an InnerTube `runs` array into plain text. */
function runsText(node: unknown): string {
  const runs = dig(node, 'runs');
  if (Array.isArray(runs)) {
    return runs
      .map((run) => (typeof dig(run, 'text') === 'string' ? (dig(run, 'text') as string) : ''))
      .join('')
      .trim();
  }
  const simple = dig(node, 'simpleText');
  return typeof simple === 'string' ? simple.trim() : '';
}

/** Picks the largest thumbnail from any of InnerTube's thumbnail shapes. */
function largestThumbnail(node: unknown): string | undefined {
  const candidates = [
    dig(node, 'musicThumbnailRenderer', 'thumbnail', 'thumbnails'),
    dig(node, 'croppedSquareThumbnailRenderer', 'thumbnail', 'thumbnails'),
    dig(node, 'thumbnail', 'thumbnails'),
    dig(node, 'thumbnails')
  ];

  for (const list of candidates) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const best = list.reduce((widest: unknown, item: unknown) => {
      const width = Number(dig(item, 'width')) || 0;
      const widestWidth = Number(dig(widest, 'width')) || 0;
      return width > widestWidth ? item : widest;
    }, list[0]);
    const url = dig(best, 'url');
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return undefined;
}

/**
 * A year anywhere in an album subtitle («Альбом · 1973», «Single • 2021»).
 * Bounded to 1900-2099 so a track count never gets read as a year.
 */
export function extractYear(subtitle: string): string | undefined {
  const match = /\b(19\d{2}|20\d{2})\b/.exec(subtitle);
  return match ? match[1] : undefined;
}

/**
 * «10 треков» / «10 songs» → 10. Absent when the subtitle says nothing.
 *
 * No trailing `\b`: JavaScript word boundaries are ASCII-only, so there is no
 * boundary at the end of «треков» and the anchor would reject every Russian
 * subtitle. A negative lookahead for another letter does the same job.
 */
export function extractTrackCount(subtitle: string): number | undefined {
  const match = /\b(\d{1,3})\s*(?:трек(?:а|ов)?|песен|песни|songs?|tracks?)(?![\wа-яё])/i.exec(subtitle);
  if (!match) return undefined;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? count : undefined;
}

/** Section titles YouTube Music uses for a discography, in both languages. */
const ALBUM_SECTION = /альбом|album|сингл|single|релиз|release/i;
const SIMILAR_SECTION = /похож|fans might also like|similar|поклонник/i;
const SONGS_SECTION = /песни|songs|треки|tracks|популярн|popular/i;

export class ArtistService {
  private cache = new Map<string, ArtistProfile>();
  /** Shares one round of requests between concurrent callers for the same name. */
  private inFlight = new Map<string, Promise<ArtistProfile>>();
  /** Состав альбомов: он не меняется, а нажимают на карточку не по одному разу. */
  private albumCache = new Map<string, UnifiedTrack[]>();

  public clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.albumCache.clear();
  }

  /**
   * Real profile for `artistName`, cached in memory.
   *
   * Never throws for a missing source: an artist YouTube Music has never heard
   * of still returns a profile with `isSparse: true`, because a name plus the
   * tracks we can find is more useful than an error screen.
   */
  public async getArtistProfile(artistName: string): Promise<ArtistProfile> {
    if (!artistName || typeof artistName !== 'string' || !artistName.trim()) {
      throw new Error('Artist name is required');
    }

    const name = artistName.trim();
    const cacheKey = name.toLowerCase();

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const task = this.buildProfile(name)
      .then((profile) => {
        this.cache.set(cacheKey, profile);
        return profile;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });

    this.inFlight.set(cacheKey, task);
    return task;
  }

  private async buildProfile(name: string): Promise<ArtistProfile> {
    // The channel lookup and the biography are independent, so they overlap.
    const [channel, wiki] = await Promise.all([
      this.findArtistChannel(name).catch(() => null),
      this.fetchBiography(name).catch(() => null)
    ]);

    const browsed = channel ? await this.browseArtistChannel(channel.channelId).catch(() => null) : null;

    // Top tracks from the channel page are the artist's real popular songs;
    // a plain search is the fallback and is filtered to this artist.
    let topTracks = browsed?.topTracks ?? [];
    if (topTracks.length === 0) {
      topTracks = await this.searchTopTracks(name);
    }

    const profile: ArtistProfile = {
      name: browsed?.name || channel?.name || name,
      avatarUrl: browsed?.avatarUrl || channel?.thumbnailUrl || topTracks[0]?.artworkUrl,
      // No separate banner asset exists on YouTube Music; the artist image is
      // the hero, and the UI blurs it rather than inventing a second file.
      bannerUrl: browsed?.avatarUrl || channel?.thumbnailUrl || topTracks[0]?.artworkUrl,
      bio: wiki?.bio || browsed?.description,
      bioSource: wiki?.source || (browsed?.description ? 'youtube-music' : undefined),
      topTracks: topTracks.slice(0, MAX_TOP_TRACKS),
      albums: browsed?.albums ?? [],
      similarArtists: browsed?.similarArtists ?? [],
      subscriberCount: browsed?.subscriberCount || channel?.subscriberCount,
      channelId: channel?.channelId
    };

    // Says "we found almost nothing" so the view can offer a retry instead of
    // rendering a page of empty sections.
    if (
      profile.topTracks.length === 0 &&
      profile.albums.length === 0 &&
      !profile.bio &&
      !profile.subscriberCount
    ) {
      profile.isSparse = true;
    }

    return profile;
  }

  // ==========================================================================
  // InnerTube: find the channel
  // ==========================================================================

  /** Searches YouTube Music with the Artists filter and takes the best match. */
  private async findArtistChannel(name: string): Promise<{
    channelId: string;
    name: string;
    thumbnailUrl?: string;
    subscriberCount?: string;
  } | null> {
    const data = await this.innerTube(INNERTUBE_SEARCH, { query: name, params: ARTIST_SEARCH_PARAMS });
    if (!data) return null;

    const sections = this.sectionList(data);
    const wanted = name.toLowerCase();

    let fallback: { channelId: string; name: string; thumbnailUrl?: string; subscriberCount?: string } | null =
      null;

    for (const section of sections) {
      const items = dig(section, 'musicShelfRenderer', 'contents');
      if (!Array.isArray(items)) continue;

      for (const item of items) {
        const renderer = dig(item, 'musicResponsiveListItemRenderer');
        if (!renderer) continue;

        const browseId = dig(renderer, 'navigationEndpoint', 'browseEndpoint', 'browseId');
        // Artist channels are `UC…`; anything else is a song or a playlist row.
        if (typeof browseId !== 'string' || !browseId.startsWith('UC')) continue;

        const columns = dig(renderer, 'flexColumns');
        const columnText = (index: number): string =>
          Array.isArray(columns)
            ? runsText(dig(columns[index], 'musicResponsiveListItemFlexColumnRenderer', 'text'))
            : '';

        const candidateName = columnText(0);
        if (!candidateName) continue;

        const subtitle = columnText(1);
        const entry = {
          channelId: browseId,
          name: candidateName,
          thumbnailUrl: largestThumbnail(dig(renderer, 'thumbnail')),
          subscriberCount: /подписчик|subscriber/i.test(subtitle) ? subtitle : undefined
        };

        // An exact name match beats YouTube's own ranking, which likes
        // tribute channels and "X Radio" for short names.
        if (candidateName.toLowerCase() === wanted) return entry;
        fallback = fallback ?? entry;
      }
    }

    return fallback;
  }

  // ==========================================================================
  // InnerTube: browse the channel
  // ==========================================================================

  private async browseArtistChannel(channelId: string): Promise<{
    name?: string;
    avatarUrl?: string;
    description?: string;
    subscriberCount?: string;
    topTracks: UnifiedTrack[];
    albums: ArtistAlbum[];
    similarArtists: SimilarArtist[];
  } | null> {
    const data = await this.innerTube(INNERTUBE_BROWSE, { browseId: channelId });
    if (!data) return null;

    const header = dig(data, 'header', 'musicImmersiveHeaderRenderer') ?? dig(data, 'header', 'musicVisualHeaderRenderer');

    const subscriberCount =
      runsText(dig(header, 'subscriptionButton', 'subscribeButtonRenderer', 'longSubscriberCountText')) ||
      runsText(dig(header, 'subscriptionButton', 'subscribeButtonRenderer', 'subscriberCountText')) ||
      undefined;

    const albums: ArtistAlbum[] = [];
    const similarArtists: SimilarArtist[] = [];
    const topTracks: UnifiedTrack[] = [];
    const headerName = runsText(dig(header, 'title'));

    for (const section of this.sectionList(data)) {
      const shelf = dig(section, 'musicShelfRenderer');
      if (shelf) {
        const title = runsText(dig(shelf, 'title'));
        const rows = dig(shelf, 'contents');
        if (Array.isArray(rows) && (SONGS_SECTION.test(title) || title === '')) {
          for (const row of rows) {
            const track = this.parseSongRow(row, headerName);
            if (track) topTracks.push(track);
          }
        }
        continue;
      }

      const carousel = dig(section, 'musicCarouselShelfRenderer');
      if (!carousel) continue;

      const title = runsText(dig(carousel, 'header', 'musicCarouselShelfBasicHeaderRenderer', 'title'));
      const items = dig(carousel, 'contents');
      if (!Array.isArray(items)) continue;

      const isSimilar = SIMILAR_SECTION.test(title);
      const isAlbums = !isSimilar && ALBUM_SECTION.test(title);
      if (!isSimilar && !isAlbums) continue;

      for (const item of items) {
        const row = dig(item, 'musicTwoRowItemRenderer');
        if (!row) continue;

        const rowTitle = runsText(dig(row, 'title'));
        if (!rowTitle) continue;
        const browseId = dig(row, 'navigationEndpoint', 'browseEndpoint', 'browseId');

        if (isSimilar) {
          if (similarArtists.length >= MAX_SIMILAR) continue;
          similarArtists.push({
            name: rowTitle,
            imageUrl: largestThumbnail(dig(row, 'thumbnailRenderer')),
            browseId: typeof browseId === 'string' ? browseId : undefined
          });
          continue;
        }

        if (albums.length >= MAX_ALBUMS) continue;
        const subtitle = runsText(dig(row, 'subtitle'));
        albums.push({
          // Deterministic and unique: the browse id when we have it, the title
          // otherwise, so React keys survive a refetch.
          id: typeof browseId === 'string' ? browseId : `album_${rowTitle.toLowerCase().replace(/\s+/g, '_')}`,
          title: rowTitle,
          year: extractYear(subtitle),
          trackCount: extractTrackCount(subtitle),
          coverUrl: largestThumbnail(dig(row, 'thumbnailRenderer')),
          browseId: typeof browseId === 'string' ? browseId : undefined
        });
      }
    }

    return {
      name: headerName || undefined,
      avatarUrl: largestThumbnail(dig(header, 'thumbnail')),
      description: runsText(dig(header, 'description')) || undefined,
      subscriberCount,
      topTracks: topTracks.slice(0, MAX_TOP_TRACKS),
      albums,
      similarArtists
    };
  }

  /** One row of the channel's Songs shelf → a playable track. */
  private parseSongRow(row: unknown, fallbackArtist: string): UnifiedTrack | null {
    const renderer = dig(row, 'musicResponsiveListItemRenderer');
    if (!renderer) return null;

    const videoId =
      dig(renderer, 'playlistItemData', 'videoId') ??
      dig(
        renderer,
        'overlay',
        'musicItemThumbnailOverlayRenderer',
        'content',
        'musicPlayButtonRenderer',
        'playNavigationEndpoint',
        'watchEndpoint',
        'videoId'
      );
    if (typeof videoId !== 'string' || !videoId) return null;

    const columns = dig(renderer, 'flexColumns');
    const columnText = (index: number): string =>
      Array.isArray(columns)
        ? runsText(dig(columns[index], 'musicResponsiveListItemFlexColumnRenderer', 'text'))
        : '';

    const title = columnText(0);
    if (!title) return null;

    // The secondary column is «Артист · Альбом · 12 млн прослушиваний»; the
    // artist leads it, and a segment that parses as a timestamp is the length.
    const secondary = columnText(1)
      .split(/[•·]/)
      .map((part) => part.trim())
      .filter(Boolean);

    const fixed = dig(renderer, 'fixedColumns');
    const fixedText = Array.isArray(fixed)
      ? runsText(dig(fixed[0], 'musicResponsiveListItemFixedColumnRenderer', 'text'))
      : '';
    const duration =
      parseDurationToSeconds(fixedText) ||
      secondary.reduce((found, part) => found || parseDurationToSeconds(part), 0);

    // A song shelf row never repeats a view count in the artist slot, but it can
    // omit the artist entirely on the channel's own page.
    const artist = secondary.find((part) => parseDurationToSeconds(part) === 0) || fallbackArtist;
    const album = secondary.find((part) => part !== artist && parseDurationToSeconds(part) === 0);

    return {
      id: `yt_${videoId}`,
      source: 'youtube',
      originalId: videoId,
      title,
      artist,
      album,
      duration,
      durationFormatted: duration > 0 ? formatDuration(duration) : undefined,
      artworkUrl: largestThumbnail(dig(renderer, 'thumbnail')) || getYouTubeArtworkUrl(videoId),
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }

  /** `sectionListRenderer.contents` for both search and browse payloads. */
  private sectionList(data: unknown): unknown[] {
    const candidates = [
      dig(
        data,
        'contents',
        'tabbedSearchResultsRenderer',
        'tabs',
        0,
        'tabRenderer',
        'content',
        'sectionListRenderer',
        'contents'
      ),
      dig(
        data,
        'contents',
        'singleColumnBrowseResultsRenderer',
        'tabs',
        0,
        'tabRenderer',
        'content',
        'sectionListRenderer',
        'contents'
      ),
      dig(data, 'contents', 'sectionListRenderer', 'contents')
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  }

  /** One InnerTube POST. Resolves to null for any transport or HTTP failure. */
  private async innerTube(url: string, body: Json): Promise<unknown | null> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: INNERTUBE_HEADERS,
        body: JSON.stringify({ context: INNERTUBE_CONTEXT, ...body }),
        signal: controller?.signal
      });
      if (!response.ok) {
        console.warn(`[artistService] InnerTube ответил ${response.status}`);
        return null;
      }
      return await response.json();
    } catch (err) {
      /*
       * Молчать здесь нельзя: отказ этого запроса стоит целого раздела.
       *
       * Раньше на этом месте стояло, что на ПК ответ не приходит никогда —
       * запрос уходит из окна прямо на music.youtube.com, заголовки обязывают
       * браузер сперва спросить разрешение, и YouTube на такой вопрос отвечает
       * отказом. **Это оказалось неверно, проверено вживую на упакованной
       * сборке 2026-08-31: `POST /youtubei/v1/search` отвечает 200.** Разрешение
       * подставляет главный процесс: `setupSessionHeaders` дописывает
       * `Access-Control-Allow-Origin: *` ко всем ответам с хостов из
       * `targetUrls`, а music.youtube.com в этом списке есть.
       *
       * На телефоне тот же запрос уводит в родной слой `CapacitorHttp`
       * (`capacitor.config.ts`), где разрешения никто не спрашивает.
       */
      console.warn('[artistService] запрос к InnerTube не прошёл:', err);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ==========================================================================
  // Biography
  // ==========================================================================

  /**
   * Wikipedia summary, Russian first. Only a real extract counts — the previous
   * "Official artist profile for X." placeholder said nothing and looked like
   * copy someone had written.
   */
  private async fetchBiography(
    name: string
  ): Promise<{ bio: string; source: 'wikipedia-ru' | 'wikipedia-en' } | null> {
    const attempts: { host: string; source: 'wikipedia-ru' | 'wikipedia-en' }[] = [
      { host: 'ru.wikipedia.org', source: 'wikipedia-ru' },
      { host: 'en.wikipedia.org', source: 'wikipedia-en' }
    ];

    for (const { host, source } of attempts) {
      try {
        const response = await fetch(
          `https://${host}/api/rest_v1/page/summary/${encodeURIComponent(name)}`
        );
        if (!response.ok) continue;
        const data = await response.json();

        // A disambiguation page is not a biography.
        if (data?.type === 'disambiguation') continue;
        const extract = typeof data?.extract === 'string' ? data.extract.trim() : '';
        if (extract.length > 40) return { bio: extract, source };
      } catch {
        // Next language.
      }
    }
    return null;
  }

  // ==========================================================================
  // Top tracks fallback
  // ==========================================================================

  /** Aggregator search, kept to tracks that credit this artist. */
  private async searchTopTracks(name: string): Promise<UnifiedTrack[]> {
    try {
      const { results } = await searchAggregator.search(name, { limit: 20, source: 'all' });
      const wanted = name.toLowerCase();
      const byArtist = results.filter((track) => {
        const artist = (track.artist || '').toLowerCase();
        return artist.includes(wanted) || wanted.includes(artist);
      });
      // Falling back to unfiltered results would put other artists on this page.
      return byArtist.length > 0 ? byArtist : [];
    } catch {
      return [];
    }
  }

  /**
   * Треки альбома по его `browseId`.
   *
   * До этого альбомы на странице исполнителя были картинками и только: у
   * карточки не было ни обработчика нажатия, ни кнопки, ни клавиатурного пути —
   * даже курсор стоял `default`. В коде это честно называлось «for a future
   * open album view». Здесь это будущее и наступает.
   *
   * Разбор идёт **обходом дерева**, а не по известному пути. Ответ на альбом
   * приходит в `twoColumnBrowseResultsRenderer` — не в той раскладке, что
   * страница исполнителя, — и YouTube эту раскладку меняет, ничего никому не
   * сообщая. Строка трека при этом узнаётся однозначно по своему рендереру, так
   * что искать её надёжнее, чем угадывать дорогу к ней.
   */
  public async getAlbumTracks(browseId: string, fallbackArtist: string = UNKNOWN_ARTIST): Promise<UnifiedTrack[]> {
    if (!browseId) return [];

    const cached = this.albumCache.get(browseId);
    if (cached) return cached;

    const data = await this.innerTube(INNERTUBE_BROWSE, { browseId });
    if (!data) return [];

    const rows: unknown[] = [];
    collectRows(data, rows, 0);

    const seen = new Set<string>();
    const tracks: UnifiedTrack[] = [];
    for (const row of rows) {
      const track = this.parseSongRow(row, fallbackArtist);
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      tracks.push(track);
    }

    if (tracks.length) this.albumCache.set(browseId, tracks);
    return tracks;
  }

  /**
   * Related videos for the artist's best-known track — the honest basis for an
   * "artist radio", instead of a similar-artists list made of the artist's own
   * name with " Radio" appended.
   */
  public async getArtistRadioSeed(artistName: string): Promise<UnifiedTrack[]> {
    const profile = await this.getArtistProfile(artistName);
    const seed = profile.topTracks[0];
    if (!seed?.originalId) return profile.topTracks;

    try {
      const related = await youtubeService.getRelatedVideos(seed.originalId, 20);
      return [seed, ...related];
    } catch {
      return profile.topTracks;
    }
  }
}

export const artistService = new ArtistService();
