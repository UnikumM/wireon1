/**
 * Wire-format fixtures for the two real upstreams.
 *
 * The Tier suites drive `youtubeService` / `soundCloudService` / `streamResolver`
 * for real and only replace `fetch`, so these builders have to produce the
 * payload shapes the parsers actually read — not a convenient shape invented for
 * the test. Anything here that drifts from the upstream JSON is a bug in the
 * fixture, and the parser tests in `tests/unit/{youtube,soundcloud}.test.ts`
 * guard the same shapes independently.
 */

import { FetchRoute, jsonResponse, httpErrorResponse } from './testUtils';

// ---------------------------------------------------------------------------
// YouTube — InnerTube search (music.youtube.com/youtubei/v1/search)
// ---------------------------------------------------------------------------

export interface InnerTubeItem {
  videoId: string;
  /** Raw upload title, e.g. `Queen - Bohemian Rhapsody (Official Video)`. */
  title: string;
  /** Second flex column runs: artist, album, duration, plays… */
  metaRuns: string[];
}

function musicResponsiveListItem(item: InnerTubeItem) {
  return {
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId: item.videoId },
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [{ text: item.title }] }
          }
        },
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: item.metaRuns.map((text) => ({ text })) }
          }
        }
      ],
      thumbnail: {
        musicThumbnailRenderer: {
          thumbnail: {
            thumbnails: [{ url: `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg` }]
          }
        }
      }
    }
  };
}

/** A complete InnerTube search response wrapping `items`. */
export function youtubeSearchPayload(items: InnerTubeItem[]) {
  return {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [{ musicShelfRenderer: { contents: items.map(musicResponsiveListItem) } }]
                }
              }
            }
          }
        ]
      }
    }
  };
}

/**
 * InnerTube answering 200 with a structurally valid but empty shelf — how
 * YouTube reports "no songs matched", as opposed to being unreachable.
 */
export function youtubeEmptySearchPayload() {
  return youtubeSearchPayload([]);
}

// ---------------------------------------------------------------------------
// YouTube — player endpoint (www.youtube.com/youtubei/v1/player)
// ---------------------------------------------------------------------------

export interface PlayerFormatOptions {
  /** 140 = m4a, 251 = opus. The parser prefers 140, then 251. */
  itag?: number;
  mimeType?: string;
  bitrate?: number;
  /** `expire` query param, seconds since epoch. */
  expireEpochSec?: number;
  url?: string;
}

export function youtubePlayerPayload(videoId: string, options: PlayerFormatOptions = {}) {
  const itag = options.itag ?? 140;
  const expire = options.expireEpochSec ?? Math.floor(Date.now() / 1000) + 3600;
  const url = options.url ?? `https://rr1.googlevideo.com/videoplayback?itag=${itag}&id=${videoId}&expire=${expire}`;

  return {
    streamingData: {
      adaptiveFormats: [
        {
          itag,
          mimeType: options.mimeType ?? 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: options.bitrate ?? 128000,
          url
        }
      ]
    }
  };
}

/** A player response carrying only video — the parser must reject it. */
export function youtubeVideoOnlyPlayerPayload() {
  return {
    streamingData: {
      adaptiveFormats: [
        { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4000000, url: 'https://rr1.googlevideo.com/v' }
      ]
    }
  };
}

/** Signature-ciphered formats: present, but with no plain `url`. */
export function youtubeCipheredPlayerPayload() {
  return {
    streamingData: {
      adaptiveFormats: [
        {
          itag: 140,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 128000,
          signatureCipher: 's=abc&sp=sig&url=https%3A%2F%2Frr1.googlevideo.com%2Fvideoplayback'
        }
      ]
    }
  };
}

// ---------------------------------------------------------------------------
// YouTube — Piped mirror (the first fallback pool)
// ---------------------------------------------------------------------------

export interface PipedItemOptions {
  videoId: string;
  title: string;
  uploaderName?: string;
  /** Seconds, as Piped reports it. */
  duration?: number;
  thumbnail?: string;
}

/**
 * A Piped `/search` response. `mapPipedItem` reads the video id out of `url`, so
 * the `/watch?v=` form matters — a bare id is silently dropped upstream too.
 */
export function pipedSearchPayload(items: PipedItemOptions[]) {
  return {
    items: items.map((item) => ({
      url: `/watch?v=${item.videoId}`,
      title: item.title,
      uploaderName: item.uploaderName ?? 'Piped Uploader',
      duration: item.duration ?? 240,
      thumbnail: item.thumbnail ?? `https://pipedproxy.example/vi/${item.videoId}/hq.jpg`
    }))
  };
}

// ---------------------------------------------------------------------------
// SoundCloud — api-v2 search & stream resolution
// ---------------------------------------------------------------------------

export interface SoundCloudItemOptions {
  id: number | string;
  title: string;
  username?: string;
  /** Milliseconds, as SoundCloud reports it. */
  durationMs?: number;
  artworkUrl?: string | null;
  permalinkUrl?: string;
}

export function soundcloudItem(options: SoundCloudItemOptions) {
  return {
    id: options.id,
    title: options.title,
    duration: options.durationMs ?? 210_000,
    artwork_url: options.artworkUrl === null ? undefined : options.artworkUrl ?? `https://i1.sndcdn.com/artworks-${options.id}-large.jpg`,
    permalink_url: options.permalinkUrl ?? `https://soundcloud.com/artist/${options.id}`,
    user: { username: options.username ?? 'SoundCloud Artist', avatar_url: 'https://i1.sndcdn.com/avatars-large.jpg' }
  };
}

export function soundcloudSearchPayload(items: SoundCloudItemOptions[]) {
  return { collection: items.map(soundcloudItem), total_results: items.length };
}

export interface TranscodingOptions {
  protocol?: 'progressive' | 'hls';
  quality?: 'hq' | 'sq' | 'lq';
  mimeType?: string;
  url?: string;
}

export function soundcloudTranscoding(trackId: string | number, options: TranscodingOptions = {}) {
  const protocol = options.protocol ?? 'progressive';
  return {
    url: options.url ?? `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}/${protocol}`,
    preset: protocol === 'hls' ? 'aac_160k' : 'mp3_0_0',
    duration: 210_000,
    quality: options.quality ?? 'sq',
    format: { protocol, mime_type: options.mimeType ?? (protocol === 'hls' ? 'audio/mp4; codecs="mp4a.40.2"' : 'audio/mpeg') }
  };
}

/** Track metadata as `/tracks/:id` returns it, including `media.transcodings`. */
export function soundcloudTrackPayload(
  trackId: string | number,
  transcodings: ReturnType<typeof soundcloudTranscoding>[] = [soundcloudTranscoding(trackId)]
) {
  return {
    ...soundcloudItem({ id: trackId, title: `Track ${trackId}` }),
    track_authorization: 'auth-token-abc',
    media: { transcodings }
  };
}

/** A CloudFront-signed CDN URL whose `Expires` the resolver can read. */
export function soundcloudCdnUrl(expireEpochSec: number = Math.floor(Date.now() / 1000) + 3600): string {
  return `https://cf-media.sndcdn.com/abc.128.mp3?Expires=${expireEpochSec}&Signature=sig&Key-Pair-Id=APKA`;
}

// ---------------------------------------------------------------------------
// Route sets
// ---------------------------------------------------------------------------

export interface SourceRouteOptions {
  youtube?: InnerTubeItem[];
  soundcloud?: SoundCloudItemOptions[];
  /** Protocol offered by the SoundCloud transcoding the resolver will pick. */
  soundcloudProtocol?: 'progressive' | 'hls';
  /** Stream URL handed back by the SoundCloud media endpoint. */
  soundcloudStreamUrl?: string;
  /** Extra routes, matched before the defaults. */
  extra?: FetchRoute[];
}

/**
 * Routes for a healthy world: both sources answer search, both resolve a
 * playable stream. Piped and Invidious are wired to 502 because InnerTube
 * succeeds first — if a test ever reaches them the assertion, not the fixture,
 * is what should change.
 */
export function healthySourceRoutes(options: SourceRouteOptions = {}): FetchRoute[] {
  const ytItems = options.youtube ?? [
    { videoId: 'yt00000001', title: 'Queen - Bohemian Rhapsody (Official Video)', metaRuns: ['Queen', 'A Night at the Opera', '5:55'] },
    { videoId: 'yt00000002', title: 'Queen - Radio Ga Ga', metaRuns: ['Queen', 'The Works', '5:48'] }
  ];
  const scItems = options.soundcloud ?? [
    { id: 501, title: 'Midnight Drive', username: 'Nightrunner', durationMs: 214_000 },
    { id: 502, title: 'Neon Coast', username: 'Nightrunner', durationMs: 187_000 }
  ];
  const protocol = options.soundcloudProtocol ?? 'progressive';
  const streamUrl = options.soundcloudStreamUrl ?? soundcloudCdnUrl();

  return [
    ...(options.extra ?? []),

    // --- YouTube ---
    { match: 'music.youtube.com/youtubei/v1/search', respond: () => jsonResponse(youtubeSearchPayload(ytItems)) },
    {
      match: 'www.youtube.com/youtubei/v1/player',
      respond: (_url, init) => {
        const videoId = readVideoId(init);
        return jsonResponse(youtubePlayerPayload(videoId));
      }
    },
    { match: '/search?q=', respond: () => httpErrorResponse(502, 'piped down') },
    { match: '/api/v1/search', respond: () => httpErrorResponse(502, 'invidious down') },

    // --- SoundCloud --- (ordered: /related and /media before the generic /tracks/:id)
    { match: 'api-v2.soundcloud.com/search/tracks', respond: () => jsonResponse(soundcloudSearchPayload(scItems)) },
    { match: /api-v2\.soundcloud\.com\/tracks\/[^/]+\/related/, respond: () => jsonResponse({ collection: [] }) },
    { match: /api-v2\.soundcloud\.com\/media\//, respond: () => jsonResponse({ url: streamUrl }) },
    {
      match: /api-v2\.soundcloud\.com\/tracks\/[^/?]+/,
      respond: (url) => {
        const id = url.split('/tracks/')[1].split(/[?/]/)[0];
        return jsonResponse(soundcloudTrackPayload(id, [soundcloudTranscoding(id, { protocol })]));
      }
    }
  ];
}

/** Reads `videoId` out of an InnerTube POST body so streams stay per-track. */
function readVideoId(init?: RequestInit): string {
  try {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    return typeof body?.videoId === 'string' ? body.videoId : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Every YouTube backend refuses to answer at all. `youtubeService.search` must
 * distinguish this from "answered with nothing" and throw
 * `ALL_BACKENDS_UNAVAILABLE_MESSAGE`.
 */
export function youtubeTotalOutageRoutes(): FetchRoute[] {
  const dead = () => {
    throw new Error('ECONNREFUSED');
  };
  return [
    { match: 'music.youtube.com/youtubei/v1/search', respond: dead },
    { match: '/search?q=', respond: dead },
    { match: '/api/v1/search', respond: dead }
  ];
}

// ---------------------------------------------------------------------------
// YouTube Music — artist channel (search with the Artists filter, then browse)
//
// `artistService` reads these payloads, so the nesting here is the real nesting:
// `musicImmersiveHeaderRenderer` for the header, `musicShelfRenderer` for the
// songs, `musicCarouselShelfRenderer` for albums and related artists.
// ---------------------------------------------------------------------------

function runs(...texts: string[]) {
  return { runs: texts.map((text) => ({ text })) };
}

function artistThumbnails(...sizes: { url: string; width: number }[]) {
  return {
    musicThumbnailRenderer: {
      thumbnail: { thumbnails: sizes.map((s) => ({ url: s.url, width: s.width, height: s.width })) }
    }
  };
}

function flexColumn(...texts: string[]) {
  return { musicResponsiveListItemFlexColumnRenderer: { text: runs(...texts) } };
}

export interface ArtistSearchRowOptions {
  /** `UC…` for a real channel; anything else must be ignored by the parser. */
  browseId: string;
  name: string;
  subtitle?: string;
  thumbUrl?: string;
}

export function artistSearchRow(options: ArtistSearchRowOptions) {
  return {
    musicResponsiveListItemRenderer: {
      navigationEndpoint: { browseEndpoint: { browseId: options.browseId } },
      thumbnail: options.thumbUrl
        ? artistThumbnails(
            { url: `${options.thumbUrl}?s=60`, width: 60 },
            { url: options.thumbUrl, width: 544 }
          )
        : undefined,
      flexColumns: [flexColumn(options.name), flexColumn(options.subtitle ?? 'Исполнитель')]
    }
  };
}

export function artistSearchPayload(rows: unknown[]) {
  return {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: rows } }] } }
            }
          }
        ]
      }
    }
  };
}

export interface ArtistSongRowOptions {
  videoId: string;
  title: string;
  /** Second flex column, joined with « • » the way YouTube Music does. */
  secondary?: string[];
  duration?: string;
  thumbUrl?: string;
}

export function artistSongRow(options: ArtistSongRowOptions) {
  return {
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId: options.videoId },
      thumbnail: options.thumbUrl ? artistThumbnails({ url: options.thumbUrl, width: 226 }) : undefined,
      flexColumns: [
        flexColumn(options.title),
        flexColumn(...(options.secondary ?? []).flatMap((part, i) => (i === 0 ? [part] : [' • ', part])))
      ],
      fixedColumns: options.duration
        ? [{ musicResponsiveListItemFixedColumnRenderer: { text: runs(options.duration) } }]
        : undefined
    }
  };
}

export interface TwoRowItemOptions {
  title: string;
  subtitle?: string;
  browseId?: string;
  thumbUrl?: string;
}

/** One album card or related-artist card. */
export function artistTwoRowItem(options: TwoRowItemOptions) {
  return {
    musicTwoRowItemRenderer: {
      title: runs(options.title),
      subtitle: options.subtitle ? runs(options.subtitle) : undefined,
      thumbnailRenderer: options.thumbUrl ? artistThumbnails({ url: options.thumbUrl, width: 226 }) : undefined,
      navigationEndpoint: options.browseId ? { browseEndpoint: { browseId: options.browseId } } : undefined
    }
  };
}

export function artistCarouselShelf(title: string, items: unknown[]) {
  return {
    musicCarouselShelfRenderer: {
      header: { musicCarouselShelfBasicHeaderRenderer: { title: runs(title) } },
      contents: items
    }
  };
}

export function artistSongShelf(title: string, rows: unknown[]) {
  return { musicShelfRenderer: { title: runs(title), contents: rows } };
}

export interface ArtistBrowseOptions {
  name?: string;
  description?: string;
  subscribers?: string;
  avatarUrl?: string;
  sections?: unknown[];
}

export function artistBrowsePayload(options: ArtistBrowseOptions) {
  return {
    header: {
      musicImmersiveHeaderRenderer: {
        title: options.name ? runs(options.name) : undefined,
        description: options.description ? runs(options.description) : undefined,
        thumbnail: options.avatarUrl
          ? artistThumbnails(
              { url: `${options.avatarUrl}?s=120`, width: 120 },
              { url: options.avatarUrl, width: 1200 }
            )
          : undefined,
        subscriptionButton: options.subscribers
          ? { subscribeButtonRenderer: { longSubscriberCountText: runs(options.subscribers) } }
          : undefined
      }
    },
    contents: {
      singleColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: options.sections ?? [] } } } }]
      }
    }
  };
}

/** A Wikipedia REST summary. `type: 'disambiguation'` must be rejected. */
export function wikipediaSummary(extract: string, type: string = 'standard') {
  return { type, extract, title: 'summary' };
}

export interface ArtistRoutesOptions {
  name: string;
  channelId?: string;
  subscribers?: string;
  avatarUrl?: string;
  description?: string;
  songs?: ArtistSongRowOptions[];
  albums?: TwoRowItemOptions[];
  similar?: TwoRowItemOptions[];
  /** Russian Wikipedia extract; omit for a 404 from both languages. */
  wikipedia?: string;
}

/**
 * A complete, healthy artist: one search hit, one populated channel page and a
 * Russian Wikipedia summary.
 */
export function artistProfileRoutes(options: ArtistRoutesOptions): FetchRoute[] {
  const channelId = options.channelId ?? 'UCtestchannelid00000000';

  return [
    {
      match: '/youtubei/v1/search',
      respond: () =>
        jsonResponse(
          artistSearchPayload([
            artistSearchRow({
              browseId: channelId,
              name: options.name,
              subtitle: options.subscribers
                ? `Исполнитель · ${options.subscribers}`
                : 'Исполнитель',
              thumbUrl: options.avatarUrl
            })
          ])
        )
    },
    {
      match: '/youtubei/v1/browse',
      respond: () =>
        jsonResponse(
          artistBrowsePayload({
            name: options.name,
            description: options.description,
            subscribers: options.subscribers,
            avatarUrl: options.avatarUrl,
            sections: [
              ...(options.songs ? [artistSongShelf('Песни', options.songs.map(artistSongRow))] : []),
              ...(options.albums ? [artistCarouselShelf('Альбомы', options.albums.map(artistTwoRowItem))] : []),
              ...(options.similar
                ? [artistCarouselShelf('Похожие исполнители', options.similar.map(artistTwoRowItem))]
                : [])
            ]
          })
        )
    },
    {
      match: 'ru.wikipedia.org',
      respond: () =>
        options.wikipedia ? jsonResponse(wikipediaSummary(options.wikipedia)) : httpErrorResponse(404)
    },
    { match: 'en.wikipedia.org', respond: () => httpErrorResponse(404) }
  ];
}
