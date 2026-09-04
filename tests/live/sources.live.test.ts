/**
 * Live source check — the real YouTube and SoundCloud endpoints, no stubs.
 *
 * Everything else in `tests/` stubs the network so the suite is deterministic.
 * That proves the parsers handle the payload shapes we recorded; it cannot prove
 * those shapes are still what the services send today. This file closes that
 * gap, and it is the one test that can fail because the internet changed rather
 * than because the code did.
 *
 * Skipped unless WIREON_LIVE=1, so `npm test` stays offline and deterministic:
 *
 *     npm run smoke:sources
 *
 * It runs in the node environment on purpose. Under jsdom, `AbortSignal` comes
 * from jsdom while `fetch` comes from undici, and undici rejects the foreign
 * signal — an artefact of the test environment that has nothing to do with the
 * app, which runs both from Chromium.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';

import { youtubeService } from '../../src/services/youtube';
import { soundCloudService, SoundCloudService } from '../../src/services/soundcloud';
import { SearchAggregator } from '../../src/services/aggregator';
import { streamResolver } from '../../src/services/streamResolver';
import { UnifiedTrack } from '../../src/types/music';

const execFileAsync = promisify(execFile);
const LIVE = process.env.WIREON_LIVE === '1';

/** Long enough for a cold SoundCloud client_id scrape plus a search. */
const NET_TIMEOUT = 90_000;

/** A query with results on both services for as long as either has existed. */
const QUERY = 'daft punk';

/** Four hours: past this a "track" is a stream or a mis-parsed duration. */
const MAX_SANE_DURATION = 4 * 60 * 60;

/** The binary the main process shells out to for YouTube playback. */
const YT_DLP = path.join(
  process.cwd(),
  'node_modules',
  'youtube-dl-exec',
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

function expectSaneTrack(track: UnifiedTrack): void {
  expect(track.id, 'track id').toBeTruthy();
  expect(track.originalId, 'source id').toBeTruthy();
  expect(track.title.trim(), 'title').not.toBe('');
  expect(track.artist.trim(), 'artist').not.toBe('');
  // C4: "1.2M plays" once parsed as a one-second duration, which combined with
  // an unseekable stream made the track unplayable.
  expect(track.duration, `duration of "${track.title}"`).toBeGreaterThan(20);
  expect(track.duration, `duration of "${track.title}"`).toBeLessThan(MAX_SANE_DURATION);
}

/** Minutes until an epoch-ms deadline. */
function minutesUntil(epochMs: number): number {
  return (epochMs - Date.now()) / 60_000;
}

describe.skipIf(!LIVE)('Live sources', () => {
  beforeAll(() => {
    console.log('[live] hitting the real YouTube and SoundCloud endpoints');
  });

  // -------------------------------------------------------------------------
  // YouTube
  // -------------------------------------------------------------------------
  describe('YouTube', () => {
    it(
      'searches and parses tracks that are actually playable',
      async () => {
        const tracks = await youtubeService.search(QUERY, 10);

        expect(tracks.length).toBeGreaterThan(0);
        console.log(`[live] youtube search → ${tracks.length} tracks, first: ${tracks[0].title} — ${tracks[0].artist}`);

        for (const track of tracks) {
          expect(track.source).toBe('youtube');
          expectSaneTrack(track);
        }
        // A YouTube id is always 11 characters; anything else means the parser
        // picked up the wrong field.
        expect(tracks[0].originalId).toHaveLength(11);
      },
      NET_TIMEOUT
    );

    /**
     * The shipping path. In the desktop app `resolveStreamUrl` calls
     * `resolve-youtube-stream` over IPC, and the main process shells out to the
     * bundled yt-dlp. There is no Electron here, so this runs the same binary
     * with the same flags main.ts passes and applies main.ts's own expiry rule.
     */
    it(
      'resolves a playable URL through the bundled yt-dlp, expiring hours out',
      async () => {
        expect(existsSync(YT_DLP), `yt-dlp is not at ${YT_DLP}`).toBe(true);

        const [track] = await youtubeService.search(QUERY, 5);
        expect(track, 'search returned nothing to resolve').toBeTruthy();

        // electron/main.ts:409 — dumpSingleJson, noWarnings, preferFreeFormats,
        // format: 'bestaudio'.
        const { stdout } = await execFileAsync(
          YT_DLP,
          [
            `https://www.youtube.com/watch?v=${track.originalId}`,
            '--dump-single-json',
            '--no-warnings',
            '--prefer-free-formats',
            '-f',
            'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio'
          ],
          { maxBuffer: 32 * 1024 * 1024 }
        );

        const info = JSON.parse(stdout);
        expect(info.url, 'yt-dlp returned no direct URL').toMatch(/^https:\/\//);
        expect(info.url).toContain('googlevideo.com');

        // main.ts:420-429 reads the deadline off the URL and falls back to 5.5h.
        const expire = new URL(info.url).searchParams.get('expire');
        const expiresAt = expire ? Number(expire) * 1000 : Date.now() + 5.5 * 3600 * 1000;

        console.log(
          `[live] youtube resolve (desktop path) → ${info.ext} ${Math.round(info.abr ?? 0)}kbps, ` +
            `expires in ${Math.round(minutesUntil(expiresAt))} min`
        );

        // C6: expiresAt used to be approxDurationMs — the length of the song — so
        // the resolver declared the URL stale mid-playback and re-resolved every
        // few minutes. A googlevideo URL is good for hours.
        expect(minutesUntil(expiresAt), 'stream URL lifetime').toBeGreaterThan(30);
      },
      NET_TIMEOUT
    );

    /**
     * The browser fallback, reported rather than required.
     *
     * `resolveViaWebPlayer` asks InnerTube for formats from a plain fetch. As of
     * this writing every client it can impersonate either rejects the request
     * (ANDROID/IOS → HTTP 400) or answers with ciphered URLs only (MWEB → 6
     * audio formats, 0 direct), because YouTube now requires PO tokens for
     * direct URLs. That blocks browser playback, not the desktop app.
     *
     * So this asserts the invariants *if* resolution succeeds, and otherwise
     * asserts the failure is the descriptive error the UI can show. A hang, or a
     * TypeError from a parser walking a payload that changed shape, still fails.
     */
    it(
      'either resolves over the web player path or fails with a clear message',
      async () => {
        const [track] = await youtubeService.search(QUERY, 5);
        expect(track).toBeTruthy();

        let resolved: Awaited<ReturnType<typeof streamResolver.resolve>> | null = null;
        let failure: Error | null = null;
        try {
          resolved = await streamResolver.resolve(track);
        } catch (err) {
          failure = err as Error;
        }

        if (resolved) {
          console.log(
            `[live] youtube resolve (web path) → ${resolved.format} ${resolved.bitrate}bps, ` +
              `expires in ${Math.round(minutesUntil(resolved.expiresAt))} min`
          );
          expect(resolved.streamUrl).toMatch(/^https:\/\//);
          expect(resolved.format).toBeTruthy();
          expect(minutesUntil(resolved.expiresAt), 'stream URL lifetime').toBeGreaterThan(30);

          const expire = new URL(resolved.streamUrl).searchParams.get('expire');
          if (expire) {
            expect(Math.abs(Number(expire) * 1000 - resolved.expiresAt)).toBeLessThan(5 * 60_000);
          }

          // Only meaningful on the path that actually resolved.
          const second = await streamResolver.resolve(track);
          expect(second.cached, 'second resolve should come from cache').toBe(true);
          expect(second.streamUrl).toBe(resolved.streamUrl);
          return;
        }

        console.log(
          `[live] youtube resolve (web path) unavailable: ${failure?.message}\n` +
            '       Expected outside Electron — YouTube ciphers all formats for browser ' +
            'clients now. The desktop build resolves through yt-dlp (checked above).'
        );

        // The renderer surfaces this string, so it has to name the problem and
        // the video rather than read like a crash.
        expect(failure).toBeInstanceOf(Error);
        expect(failure!.name, `unexpected ${failure!.name}: ${failure!.message}`).toBe('Error');
        expect(failure!.message).toMatch(/unable to resolve|no audio|stream/i);
        expect(failure!.message).toContain(track.originalId);
      },
      NET_TIMEOUT
    );
  });

  // -------------------------------------------------------------------------
  // SoundCloud
  // -------------------------------------------------------------------------
  describe('SoundCloud', () => {
    it(
      'obtains a client_id and searches with it',
      async () => {
        const tracks = await soundCloudService.search(QUERY, 10);

        expect(tracks.length).toBeGreaterThan(0);
        console.log(`[live] soundcloud search → ${tracks.length} tracks, first: ${tracks[0].title} — ${tracks[0].artist}`);

        for (const track of tracks) {
          expect(track.source).toBe('soundcloud');
          expectSaneTrack(track);
        }
      },
      NET_TIMEOUT
    );

    it(
      'resolves a stream in a format the app can play',
      async () => {
        const tracks = await soundCloudService.search(QUERY, 10);

        // Not every public track exposes a usable transcoding — some are
        // HLS-only (unplayable in node, which has no Media Source Extensions),
        // some 404 on the CDN. Try several, then assert on the first success
        // *outside* the loop so a failed assertion is reported as itself rather
        // than swallowed as one more unresolvable track.
        const failures: string[] = [];
        let resolved: Awaited<ReturnType<typeof streamResolver.resolve>> | null = null;
        let resolvedTitle = '';

        for (const track of tracks.slice(0, 6)) {
          try {
            resolved = await streamResolver.resolve(track);
            resolvedTitle = track.title;
            break;
          } catch (err) {
            failures.push(`${track.title}: ${(err as Error).message}`);
          }
        }

        if (!resolved) {
          throw new Error(`No SoundCloud track resolved:\n  ${failures.join('\n  ')}`);
        }
        if (failures.length) {
          console.log(`[live] soundcloud skipped ${failures.length} track(s):\n  ${failures.join('\n  ')}`);
        }

        console.log(`[live] soundcloud resolve → ${resolved.format} for "${resolvedTitle}"`);

        expect(resolved.streamUrl).toMatch(/^https:\/\//);
        // The resolver reports the container, not the transport: 'mp3' for a
        // progressive CDN file, 'hls' for a manifest. Anything else means the
        // audio engine is handed something it has no branch for.
        expect(['mp3', 'opus', 'hls']).toContain(resolved.format);
        if (resolved.format === 'hls') expect(resolved.streamUrl).toMatch(/\.m3u8?(\?|$)/i);

        // C7: a SoundCloud CDN URL carries its own policy deadline, and the
        // resolver has to read it rather than assume the YouTube lifetime.
        expect(minutesUntil(resolved.expiresAt), 'stream URL lifetime').toBeGreaterThan(5);

        // The URL is not just well-formed, it serves audio.
        const head = await fetch(resolved.streamUrl, { headers: { Range: 'bytes=0-1023' } });
        expect(head.ok || head.status === 206, `CDN returned HTTP ${head.status}`).toBe(true);
        console.log(`[live] soundcloud CDN → HTTP ${head.status} ${head.headers.get('content-type') ?? ''}`);
      },
      NET_TIMEOUT
    );

    /**
     * C5: HLS-only tracks are a large slice of the catalogue, and before hls.js
     * was bundled they were handed to a plain `<audio>` element as an .m3u8 and
     * failed silently. Node cannot play HLS, so the environment check is
     * overridden here to exercise the branch Chromium takes.
     */
    it(
      'hands an HLS-only track back as a manifest when HLS can be played',
      async () => {
        const hlsCapable = new SoundCloudService({ hlsSupported: true });
        const tracks = await soundCloudService.search(QUERY, 10);

        const failures: string[] = [];
        for (const track of tracks.slice(0, 6)) {
          try {
            const result = await hlsCapable.resolveStreamUrl(track.originalId);
            if (result.format !== 'hls') continue;

            console.log(`[live] soundcloud hls → ${result.streamUrl.split('?')[0]} for "${track.title}"`);
            expect(result.streamUrl).toMatch(/\.m3u8?(\?|$)/i);

            // A manifest hls.js can actually load: text, with the EXTM3U tag.
            const manifest = await fetch(result.streamUrl);
            expect(manifest.ok, `manifest returned HTTP ${manifest.status}`).toBe(true);
            expect(await manifest.text()).toContain('#EXTM3U');
            return;
          } catch (err) {
            failures.push(`${track.title}: ${(err as Error).message}`);
          }
        }

        // Every sampled track was progressive. Nothing is broken; there was just
        // nothing to check. Say so rather than passing quietly.
        console.log(
          '[live] soundcloud hls → none of the sampled tracks were HLS-only' +
            (failures.length ? `; ${failures.length} failed to resolve:\n  ${failures.join('\n  ')}` : '')
        );
        expect(await hlsCapable.isHlsPlaybackSupported(), 'the override should report HLS support').toBe(true);
      },
      NET_TIMEOUT
    );
  });

  // -------------------------------------------------------------------------
  // Both at once, the way the search screen asks for them
  // -------------------------------------------------------------------------
  describe('Aggregator', () => {
    it(
      'returns interleaved results from both sources with no duplicates',
      async () => {
        // A private instance: the singleton's cache and dead-mirror memory
        // would otherwise carry over from an earlier test.
        const aggregator = new SearchAggregator();
        const { results, sources, errors } = await aggregator.search(QUERY, { source: 'all', limit: 20 });

        console.log(
          `[live] aggregate → ${results.length} results ` +
            `(youtube ${sources.youtube}, soundcloud ${sources.soundcloud})` +
            (errors ? ` errors: ${JSON.stringify(errors)}` : '')
        );

        // Both sources must contribute: a zero here is the outage the fallback
        // pool exists to prevent.
        expect(sources.youtube, `youtube: ${errors?.youtube ?? 'no results'}`).toBeGreaterThan(0);
        expect(sources.soundcloud, `soundcloud: ${errors?.soundcloud ?? 'no results'}`).toBeGreaterThan(0);
        expect(errors).toBeUndefined();

        const ids = results.map((t) => t.id);
        expect(new Set(ids).size, 'duplicate ids in the merged list').toBe(ids.length);
        for (const track of results) expectSaneTrack(track);
      },
      NET_TIMEOUT
    );
  });
});

describe.skipIf(LIVE)('Live sources (skipped)', () => {
  it('is opt-in', () => {
    // Keeps the file from reporting zero tests in the default offline run.
    expect(LIVE).toBe(false);
  });
});
