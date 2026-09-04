/**
 * Typed fixtures for the Tier 1-4 suites.
 *
 * Every factory returns a value of the *real* domain type from `src/types`, so a
 * change to `UnifiedTrack`, `Playlist` or `UserProfile` breaks these fixtures at
 * compile time instead of letting a test assert against a shape the application
 * can no longer produce. There are no `as any` casts here on purpose.
 */

import { Playlist, UnifiedTrack, UserProfile } from '../../src/types/music';

/** Deterministic base timestamp so fixtures never depend on the wall clock. */
export const FIXTURE_NOW = 1_700_000_000_000;

/**
 * A plain YouTube track with a pre-resolved progressive stream, so loading it
 * through the audio engine does not require a resolver round trip.
 */
export function createMockTrack(overrides: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return {
    id: 'yt_dQw4w9WgXcQ',
    source: 'youtube',
    originalId: 'dQw4w9WgXcQ',
    title: 'Midnight Protocol',
    artist: 'Wireon Test Artist',
    album: 'Integration Suite',
    duration: 225,
    durationFormatted: '3:45',
    artworkUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    streamUrl: 'https://rr3---sn-test.googlevideo.com/videoplayback?itag=140',
    streamExpiry: FIXTURE_NOW + 5 * 3600 * 1000,
    bitrate: 128,
    format: 'm4a',
    ...overrides
  };
}

export function createMockYouTubeTrack(
  idSuffix: string = '1',
  overrides: Partial<UnifiedTrack> = {}
): UnifiedTrack {
  return createMockTrack({
    id: `yt_video${idSuffix}`,
    originalId: `video${idSuffix}`,
    title: `YouTube Track ${idSuffix}`,
    artist: `YouTube Artist ${idSuffix}`,
    artworkUrl: `https://i.ytimg.com/vi/video${idSuffix}/hqdefault.jpg`,
    sourceUrl: `https://www.youtube.com/watch?v=video${idSuffix}`,
    streamUrl: `https://rr3---sn-test.googlevideo.com/videoplayback?id=video${idSuffix}&itag=140`,
    ...overrides
  });
}

/**
 * A progressive (MP3) SoundCloud track. Note that this is the *rare* case in
 * production — see `createMockHlsSoundCloudTrack` for what SoundCloud actually
 * hands back most of the time.
 */
export function createMockSoundCloudTrack(
  idSuffix: string = '1',
  overrides: Partial<UnifiedTrack> = {}
): UnifiedTrack {
  return {
    id: `sc_90210${idSuffix}`,
    source: 'soundcloud',
    originalId: `90210${idSuffix}`,
    title: `SoundCloud Track ${idSuffix}`,
    artist: `SoundCloud Artist ${idSuffix}`,
    duration: 180,
    durationFormatted: '3:00',
    artworkUrl: `https://i1.sndcdn.com/artworks-${idSuffix}-t500x500.jpg`,
    sourceUrl: `https://soundcloud.com/artist/track-${idSuffix}`,
    streamUrl: `https://cf-media.sndcdn.com/${idSuffix}.128.mp3`,
    bitrate: 128,
    format: 'mp3',
    ...overrides
  };
}

/**
 * The realistic SoundCloud case: the chosen transcoding is an HLS manifest, so
 * `format` is `'hls'` and the stream URL is an `.m3u8`. Playing this track goes
 * through `src/services/hls.ts`, which must be mocked in a jsdom run.
 */
export function createMockHlsSoundCloudTrack(
  idSuffix: string = 'hls',
  overrides: Partial<UnifiedTrack> = {}
): UnifiedTrack {
  return createMockSoundCloudTrack(idSuffix, {
    title: `SoundCloud HLS Track ${idSuffix}`,
    streamUrl: `https://cf-hls-media.sndcdn.com/playlist/${idSuffix}.128.mp3/playlist.m3u8?Policy=abc`,
    format: 'hls',
    ...overrides
  });
}

/**
 * A chunked opus upload whose duration is not known yet. Real streams report
 * `Infinity` here until metadata lands; the player must never format or seek
 * against that value.
 */
export function createMockInfiniteDurationTrack(
  overrides: Partial<UnifiedTrack> = {}
): UnifiedTrack {
  return createMockTrack({
    id: 'yt_chunked_opus',
    originalId: 'chunked_opus',
    title: 'Chunked Opus Live Set',
    duration: Infinity,
    durationFormatted: undefined,
    format: 'opus',
    ...overrides
  });
}

/** A track whose duration is genuinely unknown (`0`), not zero-length. */
export function createMockZeroDurationTrack(overrides: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return createMockTrack({
    id: 'yt_unknown_duration',
    originalId: 'unknown_duration',
    title: 'Duration Unknown',
    duration: 0,
    durationFormatted: undefined,
    ...overrides
  });
}

/** `count` distinct tracks, alternating source, deterministic ids. */
export function createMockTrackList(count: number, prefix: string = 'bulk'): UnifiedTrack[] {
  const tracks: UnifiedTrack[] = [];
  for (let i = 0; i < count; i++) {
    tracks.push(
      i % 2 === 0
        ? createMockYouTubeTrack(`${prefix}${i}`, {
            title: `${prefix} Track ${i}`,
            artist: `Artist ${i}`,
            duration: 120 + i
          })
        : createMockSoundCloudTrack(`${prefix}${i}`, {
            title: `${prefix} Track ${i}`,
            artist: `Artist ${i}`,
            duration: 120 + i
          })
    );
  }
  return tracks;
}

export function createMockPlaylist(
  title: string = 'Test Playlist',
  trackCount: number = 3,
  overrides: Partial<Playlist> = {}
): Playlist {
  const id = overrides.id || `pl_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  return {
    id,
    title,
    description: `${title} description`,
    tracks: createMockTrackList(trackCount, id),
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    isSynced: false,
    ...overrides
  };
}

/**
 * A deliberately oversized playlist for the 500-track boundary case. Kept as a
 * generator rather than a constant so a suite only pays for it when it asks.
 */
export function createLargePlaylist(
  trackCount: number = 500,
  overrides: Partial<Playlist> = {}
): Playlist {
  return {
    id: 'pl_large',
    title: `Large Playlist (${trackCount})`,
    tracks: createMockTrackList(trackCount, 'large'),
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    isSynced: false,
    ...overrides
  };
}

/** A playlist that stores the same track id twice (a legal, ugly state). */
export function createPlaylistWithDuplicates(overrides: Partial<Playlist> = {}): Playlist {
  const track = createMockYouTubeTrack('dupe');
  return {
    id: 'pl_duplicates',
    title: 'Duplicate Entries',
    tracks: [track, createMockSoundCloudTrack('other'), { ...track }],
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    isSynced: false,
    ...overrides
  };
}

/** A signed-in Discord profile, matching what `fetchDiscordUserProfile` builds. */
export function createMockUserProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: '123456789012345678',
    username: 'WireonTester',
    avatarUrl: 'https://cdn.discordapp.com/avatars/123456789012345678/abc123.png?size=256',
    email: 'tester@example.com',
    provider: 'discord',
    status: 'online',
    ...overrides
  };
}

/** Kept for callers that still ask for a "Discord user": same real type. */
export const createMockDiscordUser = createMockUserProfile;

/**
 * Raw `/users/@me` payload, so a test can drive the real profile mapper instead
 * of hand-building the mapped result.
 */
export function createDiscordUserRawPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: '123456789012345678',
    username: 'wireontester',
    global_name: 'WireonTester',
    discriminator: '0',
    avatar: 'abc123',
    email: 'tester@example.com',
    verified: true,
    ...overrides
  };
}

/** Titles that have broken formatting, sorting or DOM rendering in the past. */
export const AWKWARD_TITLES = {
  emoji: '🎵 Bass Drop 🔥🔥 (Extended)',
  cjk: '夜に駆ける — 花火の音',
  rtl: 'أغنية الليل الطويلة',
  combining: 'Café Del Mar',
  zeroWidth: 'Hidden​Break',
  veryLong: 'A'.repeat(400)
} as const;

/** A search query at the 5000-character boundary. */
export const HUGE_QUERY = 'a'.repeat(5000);
