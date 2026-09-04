/**
 * Main-process YouTube stream resolution (`electron/streamResolver.ts`).
 *
 * This module is the whole answer to "only about 30% of songs load": it rotates
 * yt-dlp client configurations, probes the URL before the renderer commits to it,
 * classifies the failures that no retry can fix and writes every attempt to a log.
 * All of that is behaviour, not plumbing, so it is asserted here rather than left
 * to a manual smoke pass — every dependency is injected precisely so it can be.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  StreamResolver,
  RESOLVE_ATTEMPTS,
  DEFAULT_STREAM_TTL_MS,
  getStreamExpiry,
  pickAudioFormat,
  classifyResolveError,
  buildAttempts,
  normalizeCookieBrowser,
  BOT_CHECK_PATTERN
} from '../../electron/streamResolver';

const VIDEO_ID = 'dQw4w9WgXcQ';
const NOW = 1_700_000_000_000;

/** Дословно то, чем YouTube отвечает на проверку «вы не робот». */
const BOT_CHECK_MESSAGE =
  "ERROR: [youtube] MURua52_YPg: Sign in to confirm you're not a bot. " +
  'Use --cookies-from-browser or --cookies for the authentication.';

/** Ступени, которым yt-dlp вообще передаёт cookies. */
const COOKIE_AWARE_COUNT = RESOLVE_ATTEMPTS.filter((attempt) => attempt.cookieAware).length;

/** A yt-dlp payload with one progressive m4a format. */
function goodInfo(url = 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=140'): unknown {
  return {
    formats: [
      { url, ext: 'm4a', abr: 128, acodec: 'mp4a.40.2', vcodec: 'none', protocol: 'https' }
    ]
  };
}

/** A fetch that answers every probe with `status`. */
function probe(status: number): typeof fetch {
  return vi.fn().mockResolvedValue({ status, body: null }) as unknown as typeof fetch;
}

describe('electron/streamResolver', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'wireon-stream-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // getStreamExpiry
  // ==========================================================================
  describe('getStreamExpiry', () => {
    it('trusts the expire parameter over any fixed TTL', () => {
      const expire = Math.floor(NOW / 1000) + 6 * 3600;
      expect(getStreamExpiry(`https://x.googlevideo.com/videoplayback?expire=${expire}`, NOW)).toBe(
        expire * 1000
      );
    });

    it('reads a deadline carried in the path instead of the query', () => {
      const expire = Math.floor(NOW / 1000) + 3600;
      expect(getStreamExpiry(`https://x.googlevideo.com/expire/${expire}/videoplayback`, NOW)).toBe(
        expire * 1000
      );
    });

    it('falls back to the default TTL for an absent, stale or unparseable expiry', () => {
      const stale = Math.floor(NOW / 1000) - 60;
      expect(getStreamExpiry('https://x.googlevideo.com/videoplayback', NOW)).toBe(
        NOW + DEFAULT_STREAM_TTL_MS
      );
      // A deadline in the past must not be handed back as "still valid".
      expect(getStreamExpiry(`https://x.googlevideo.com/vp?expire=${stale}`, NOW)).toBe(
        NOW + DEFAULT_STREAM_TTL_MS
      );
      expect(getStreamExpiry('not-a-url', NOW)).toBe(NOW + DEFAULT_STREAM_TTL_MS);
    });
  });

  // ==========================================================================
  // pickAudioFormat
  // ==========================================================================
  describe('pickAudioFormat', () => {
    it('prefers progressive audio-only m4a over a manifest and over muxed video', () => {
      const picked = pickAudioFormat({
        formats: [
          { url: 'https://a/hls.m3u8', ext: 'm4a', abr: 256, acodec: 'mp4a', vcodec: 'none', protocol: 'm3u8_native' },
          { url: 'https://a/muxed.mp4', ext: 'mp4', abr: 192, acodec: 'mp4a', vcodec: 'avc1', protocol: 'https' },
          { url: 'https://a/audio.m4a', ext: 'm4a', abr: 128, acodec: 'mp4a', vcodec: 'none', protocol: 'https' }
        ]
      });

      expect(picked?.format.url).toBe('https://a/audio.m4a');
      expect(picked?.isManifest).toBe(false);
    });

    it('picks the higher bitrate when nothing else separates two formats', () => {
      const picked = pickAudioFormat({
        formats: [
          { url: 'https://a/low.m4a', ext: 'm4a', abr: 64, acodec: 'mp4a', vcodec: 'none', protocol: 'https' },
          { url: 'https://a/high.m4a', ext: 'm4a', abr: 160, acodec: 'mp4a', vcodec: 'none', protocol: 'https' }
        ]
      });
      expect(picked?.format.url).toBe('https://a/high.m4a');
    });

    it('flags a manifest when that is the only thing on offer', () => {
      const picked = pickAudioFormat({
        formats: [{ url: 'https://a/only.m3u8', ext: 'm4a', acodec: 'mp4a', vcodec: 'none' }]
      });
      expect(picked?.isManifest).toBe(true);
    });

    it('accepts a bare top-level url and requested_downloads', () => {
      expect(pickAudioFormat({ url: 'https://a/direct.m4a', ext: 'm4a', abr: 96 })?.format.url).toBe(
        'https://a/direct.m4a'
      );
      expect(
        pickAudioFormat({
          requested_downloads: [{ url: 'https://a/req.m4a', ext: 'm4a', acodec: 'mp4a', vcodec: 'none' }]
        })?.format.url
      ).toBe('https://a/req.m4a');
    });

    it('returns null for nothing playable', () => {
      expect(pickAudioFormat(null)).toBeNull();
      expect(pickAudioFormat({})).toBeNull();
      expect(pickAudioFormat({ formats: [{ ext: 'm4a' }] })).toBeNull();
    });
  });

  // ==========================================================================
  // classifyResolveError
  // ==========================================================================
  describe('classifyResolveError', () => {
    it('names the failures that no retry can fix', () => {
      expect(classifyResolveError('Sign in to confirm your age')).toBe('YT_AGE_RESTRICTED');
      expect(classifyResolveError('This is a private video. Please sign in')).toBe('YT_PRIVATE');
      expect(classifyResolveError('The uploader has not made this video available in your country')).toBe(
        'YT_GEO_BLOCKED'
      );
      expect(classifyResolveError('This video is not available from your location.')).toBe('YT_GEO_BLOCKED');
      expect(classifyResolveError('Video unavailable')).toBe('YT_UNAVAILABLE');
      expect(classifyResolveError('This live event will begin in 3 hours')).toBe('YT_LIVE');
      expect(classifyResolveError('spawn /opt/yt-dlp ENOENT')).toBe('YT_BINARY_MISSING');
    });

    it('returns null for anything a different client might still resolve', () => {
      expect(classifyResolveError('HTTP Error 403: Forbidden')).toBeNull();
      expect(classifyResolveError('Unable to extract player response')).toBeNull();
      expect(classifyResolveError('')).toBeNull();
    });
  });

  // ==========================================================================
  // Проверка «вы не робот» и cookies: чистые функции
  // ==========================================================================
  describe('BOT_CHECK_PATTERN', () => {
    it('узнаёт проверку и не путает её с обычным отказом', () => {
      expect(BOT_CHECK_PATTERN.test(BOT_CHECK_MESSAGE)).toBe(true);
      expect(BOT_CHECK_PATTERN.test('Please confirm your identity')).toBe(true);
      expect(BOT_CHECK_PATTERN.test('HTTP Error 403: Forbidden')).toBe(false);
      // Проверка не терминальная нарочно: другой клиент в ту же секунду может
      // отдать формат, поэтому лестница обязана продолжиться.
      expect(classifyResolveError(BOT_CHECK_MESSAGE)).toBeNull();
    });
  });

  describe('normalizeCookieBrowser', () => {
    it('принимает известный браузер, не глядя на регистр и пробелы', () => {
      expect(normalizeCookieBrowser('firefox')).toBe('firefox');
      expect(normalizeCookieBrowser('  Chrome ')).toBe('chrome');
    });

    it('отбрасывает всё, чего нет в списке', () => {
      // Значение приходит из renderer и уезжает в аргументы дочернего процесса,
      // так что «почти похоже» здесь равно «нельзя».
      expect(normalizeCookieBrowser('chrome; rm -rf /')).toBeNull();
      expect(normalizeCookieBrowser('chrome:/tmp/profile')).toBeNull();
      expect(normalizeCookieBrowser('--exec=calc')).toBeNull();
      expect(normalizeCookieBrowser('netscape')).toBeNull();
      expect(normalizeCookieBrowser(null)).toBeNull();
      expect(normalizeCookieBrowser(42)).toBeNull();
      expect(normalizeCookieBrowser('')).toBeNull();
    });
  });

  describe('buildAttempts', () => {
    it('без cookies — это ровно лестница по умолчанию', () => {
      expect(buildAttempts(null)).toEqual([...RESOLVE_ATTEMPTS]);
      expect(buildAttempts(null).every((a) => !('cookiesFromBrowser' in a.flags))).toBe(true);
    });

    it('дописывает cookies только тем клиентам, которые их принимают, и в конец', () => {
      const attempts = buildAttempts('firefox');

      expect(attempts).toHaveLength(RESOLVE_ATTEMPTS.length + COOKIE_AWARE_COUNT);
      // Пока YouTube отдаёт аудио анонимно, аккаунт светить незачем.
      expect(attempts.slice(0, RESOLVE_ATTEMPTS.length)).toEqual([...RESOLVE_ATTEMPTS]);

      const authorized = attempts.slice(RESOLVE_ATTEMPTS.length);
      expect(authorized.map((a) => a.label)).toEqual(
        RESOLVE_ATTEMPTS.filter((a) => a.cookieAware).map((a) => `${a.label}+cookies`)
      );
      expect(authorized.every((a) => a.flags.cookiesFromBrowser === 'firefox')).toBe(true);
      // У visionos в извлекателе SUPPORTS_COOKIES: false — сессия ему не поедет.
      expect(authorized.some((a) => a.label.startsWith('visionos'))).toBe(false);
    });

    it('после проверки «вы не робот» ставит cookies первыми', () => {
      const attempts = buildAttempts('firefox', true);

      expect(attempts).toHaveLength(RESOLVE_ATTEMPTS.length + COOKIE_AWARE_COUNT);
      expect(attempts[0].flags.cookiesFromBrowser).toBe('firefox');
      // Анонимные ступени остаются: проверку могли снять, и тогда сессия не нужна.
      expect(attempts.slice(COOKIE_AWARE_COUNT)).toEqual([...RESOLVE_ATTEMPTS]);
    });

    it('не даёт себя мутировать через возвращённые ступени', () => {
      const attempts = buildAttempts(null);
      attempts[0].flags.cookiesFromBrowser = 'chrome';
      expect(RESOLVE_ATTEMPTS[0].flags).toEqual({});
    });
  });

  // ==========================================================================
  // resolve(): the attempt ladder
  // ==========================================================================
  describe('resolve', () => {
    it('rejects a malformed video id before spawning anything', async () => {
      const ytdl = vi.fn();
      const resolver = new StreamResolver({ ytdl, verify: false });

      await expect(resolver.resolve('short')).rejects.toThrow(/Invalid YouTube video ID/);
      await expect(resolver.resolve('')).rejects.toThrow(/Invalid YouTube video ID/);
      expect(ytdl).not.toHaveBeenCalled();
    });

    it('returns the first attempt that yields a verified URL', async () => {
      const ytdl = vi.fn().mockResolvedValue(goodInfo());
      const fetchImpl = probe(206);
      const resolver = new StreamResolver({ ytdl, fetchImpl, now: () => NOW, stateDir });

      const stream = await resolver.resolve(VIDEO_ID);

      expect(ytdl).toHaveBeenCalledTimes(1);
      expect(stream).toEqual({
        streamUrl: 'https://rr1---sn-x.googlevideo.com/videoplayback?itag=140',
        format: 'm4a',
        bitrate: 128,
        expiresAt: NOW + DEFAULT_STREAM_TTL_MS
      });
      // The probe is the point: a URL nobody checked is a URL that fails on play.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('rotates client configurations when the URL fails its playback probe', async () => {
      // This is the "only 30% of songs load" case: yt-dlp answers happily, but the
      // URL it hands back needs a proof-of-origin token and answers 403 on play.
      const ytdl = vi
        .fn()
        .mockResolvedValueOnce(goodInfo('https://a/poisoned.m4a'))
        .mockResolvedValueOnce(goodInfo('https://a/second.m4a'));
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({ status: 403, body: null })
        .mockResolvedValueOnce({ status: 200, body: null }) as unknown as typeof fetch;

      const resolver = new StreamResolver({ ytdl, fetchImpl, now: () => NOW, stateDir });
      const stream = await resolver.resolve(VIDEO_ID);

      expect(stream.streamUrl).toBe('https://a/second.m4a');
      expect(ytdl).toHaveBeenCalledTimes(2);
      // The second call must actually be a different client, not a blind retry.
      expect(ytdl.mock.calls[0][1]).not.toEqual(ytdl.mock.calls[1][1]);
      expect(ytdl.mock.calls[1][1]).toMatchObject(RESOLVE_ATTEMPTS[1].flags);
    });

    it('skips the probe for a manifest, which cannot be byte-ranged', async () => {
      const ytdl = vi.fn().mockResolvedValue({
        formats: [{ url: 'https://a/stream.m3u8', ext: 'm4a', acodec: 'mp4a', vcodec: 'none' }]
      });
      const fetchImpl = probe(403);
      const resolver = new StreamResolver({ ytdl, fetchImpl, now: () => NOW, stateDir });

      const stream = await resolver.resolve(VIDEO_ID);

      expect(stream.streamUrl).toBe('https://a/stream.m3u8');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('stops on a terminal failure instead of burning three more attempts', async () => {
      const ytdl = vi.fn().mockRejectedValue(new Error('Sign in to confirm your age'));
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      await expect(resolver.resolve(VIDEO_ID)).rejects.toThrow(/^YT_AGE_RESTRICTED: /);
      expect(ytdl).toHaveBeenCalledTimes(1);
    });

    it('reports every attempt in the message once the ladder is exhausted', async () => {
      const ytdl = vi.fn().mockRejectedValue(new Error('HTTP Error 403: Forbidden'));
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      await expect(resolver.resolve(VIDEO_ID)).rejects.toThrow(/^YT_ALL_ATTEMPTS_FAILED: /);
      expect(ytdl).toHaveBeenCalledTimes(RESOLVE_ATTEMPTS.length);

      const log = resolver.readLog().join('\n');
      for (const { label } of RESOLVE_ATTEMPTS) {
        expect(log).toContain(label);
      }
    });

    it('treats a response with no playable format as a retryable attempt', async () => {
      const ytdl = vi
        .fn()
        .mockResolvedValueOnce({ formats: [{ ext: 'm4a' }] })
        .mockResolvedValueOnce(goodInfo('https://a/eventually.m4a'));
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      const stream = await resolver.resolve(VIDEO_ID);
      expect(stream.streamUrl).toBe('https://a/eventually.m4a');
      expect(ytdl).toHaveBeenCalledTimes(2);
    });

    it('shares one extractor process between concurrent callers for the same id', async () => {
      let release: (value: unknown) => void = () => {};
      const ytdl = vi.fn().mockImplementation(
        () => new Promise((resolve) => { release = resolve; })
      );
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      const first = resolver.resolve(VIDEO_ID);
      const second = resolver.resolve(VIDEO_ID);
      release(goodInfo('https://a/shared.m4a'));

      expect((await first).streamUrl).toBe('https://a/shared.m4a');
      expect(await second).toEqual(await first);
      expect(ytdl).toHaveBeenCalledTimes(1);
    });

    it('holds extra callers at the concurrency limit rather than spawning more', async () => {
      let active = 0;
      let peak = 0;
      const ytdl = vi.fn().mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return goodInfo();
      });
      // Оба лимита по одному: здесь проверяется само ожидание, а не приоритет.
      // Разницу между полосами держат тесты в блоке `priority queue`.
      const resolver = new StreamResolver({
        ytdl,
        verify: false,
        maxConcurrent: 1,
        maxConcurrentUrgent: 1,
        now: () => NOW
      });

      await Promise.all([
        resolver.resolve('aaaaaaaaaaa'),
        resolver.resolve('bbbbbbbbbbb'),
        resolver.resolve('ccccccccccc')
      ]);

      expect(peak).toBe(1);
      expect(ytdl).toHaveBeenCalledTimes(3);
    });
  });

  // ==========================================================================
  // Очередь с приоритетом: нажатие play не ждёт фоновую предзагрузку
  // ==========================================================================
  describe('priority queue', () => {
    /** Даём отработать всем микротаскам: очередь просыпается через промисы. */
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    /**
     * yt-dlp, который висит до явного разрешения, и порядок запусков.
     *
     * Порядок — единственное наблюдаемое проявление приоритета: убить уже
     * запущенный процесс мы не можем, значит вся разница в том, кого пускают
     * раньше и кого пускают рядом.
     */
    function controllableYtdl() {
      const started: string[] = [];
      const pending = new Map<string, () => void>();
      const ytdl = vi.fn().mockImplementation((url: string) => {
        const id = String(url).split('v=')[1];
        started.push(id);
        return new Promise((resolve) => {
          pending.set(id, () => resolve(goodInfo(`https://a/${id}.m4a`)));
        });
      });
      return {
        ytdl,
        started,
        finish(id: string): void {
          pending.get(id)?.();
          pending.delete(id);
        },
        finishAll(): void {
          for (const done of pending.values()) done();
          pending.clear();
        }
      };
    }

    const ID_A = 'aaaaaaaaaaa';
    const ID_B = 'bbbbbbbbbbb';
    const ID_C = 'ccccccccccc';
    const ID_D = 'ddddddddddd';

    it('lets a user request run alongside background prefetches instead of behind them', async () => {
      const { ytdl, started, finishAll } = controllableYtdl();
      const resolver = new StreamResolver({
        ytdl,
        verify: false,
        now: () => NOW,
        maxConcurrent: 2,
        maxConcurrentUrgent: 4
      });

      const pending = [
        resolver.resolve(ID_A, 'prefetch'),
        resolver.resolve(ID_B, 'prefetch'),
        resolver.resolve(ID_C, 'prefetch'),
        resolver.resolve(ID_D, 'user')
      ];
      await flush();

      // Фон занял свои два слота, третья фоновая ждёт — а человек уже пошёл.
      expect(started).toEqual([ID_A, ID_B, ID_D]);

      finishAll();
      await flush();
      finishAll();
      await Promise.all(pending);
      expect(started).toContain(ID_C);
    });

    it('wakes the user request first when everything is queued', async () => {
      const { ytdl, started, finish, finishAll } = controllableYtdl();
      const resolver = new StreamResolver({
        ytdl,
        verify: false,
        now: () => NOW,
        maxConcurrent: 1,
        maxConcurrentUrgent: 1
      });

      const pending = [
        resolver.resolve(ID_A, 'prefetch'),
        resolver.resolve(ID_B, 'prefetch'),
        resolver.resolve(ID_C, 'prefetch'),
        resolver.resolve(ID_D, 'user')
      ];
      await flush();
      expect(started).toEqual([ID_A]);

      finish(ID_A);
      await flush();
      // Встал в очередь последним, пошёл первым.
      expect(started).toEqual([ID_A, ID_D]);

      finish(ID_D);
      await flush();
      // Внутри одного приоритета — по порядку поступления.
      expect(started).toEqual([ID_A, ID_D, ID_B]);

      finishAll();
      await flush();
      finishAll();
      await Promise.all(pending);
    });

    it('raises a queued prefetch when the listener asks for that very track', async () => {
      const { ytdl, started, finish, finishAll } = controllableYtdl();
      const resolver = new StreamResolver({
        ytdl,
        verify: false,
        now: () => NOW,
        stateDir,
        maxConcurrent: 1,
        maxConcurrentUrgent: 1
      });

      const pending = [
        resolver.resolve(ID_A, 'prefetch'),
        resolver.resolve(ID_B, 'prefetch'),
        resolver.resolve(ID_C, 'prefetch')
      ];
      await flush();
      expect(started).toEqual([ID_A]);

      // Человек нажал play на том, что уже стоит в фоновой очереди третьим.
      pending.push(resolver.resolve(ID_C, 'user'));
      finish(ID_A);
      await flush();

      expect(started).toEqual([ID_A, ID_C]);
      expect(resolver.readLog().join('\n')).toContain(`priority raised for ${ID_C}`);

      finishAll();
      await flush();
      finishAll();
      await Promise.all(pending);
      // Повышение не запускает второй извлекатель: заявка одна.
      expect(ytdl).toHaveBeenCalledTimes(3);
    });

    it('shares one resolution between a prefetch and the play that catches up with it', async () => {
      const { ytdl, finishAll } = controllableYtdl();
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW });

      const background = resolver.resolve(ID_A, 'prefetch');
      const foreground = resolver.resolve(ID_A, 'user');
      finishAll();

      expect(await foreground).toEqual(await background);
      expect(ytdl).toHaveBeenCalledTimes(1);
    });

    it('still holds background prefetches at their own narrow limit', async () => {
      let active = 0;
      let peak = 0;
      const ytdl = vi.fn().mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return goodInfo();
      });
      const resolver = new StreamResolver({
        ytdl,
        verify: false,
        now: () => NOW,
        maxConcurrent: 2,
        maxConcurrentUrgent: 6
      });

      await Promise.all(
        [ID_A, ID_B, ID_C, ID_D].map((id) => resolver.resolve(id, 'prefetch'))
      );

      expect(peak).toBe(2);
      expect(ytdl).toHaveBeenCalledTimes(4);
    });

    it('never exceeds the urgent limit either', async () => {
      let active = 0;
      let peak = 0;
      const ytdl = vi.fn().mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return goodInfo();
      });
      const resolver = new StreamResolver({
        ytdl,
        verify: false,
        now: () => NOW,
        maxConcurrent: 1,
        maxConcurrentUrgent: 2
      });

      await Promise.all(
        [ID_A, ID_B, ID_C, ID_D].map((id) => resolver.resolve(id, 'user'))
      );

      expect(peak).toBe(2);
    });
  });

  // ==========================================================================
  // Проверка «вы не робот» и cookies в самой лестнице
  // ==========================================================================
  describe('bot check', () => {
    it('продолжает перебор: один клиент получил проверку, следующий отдал формат', async () => {
      const ytdl = vi
        .fn()
        .mockRejectedValueOnce(new Error(BOT_CHECK_MESSAGE))
        .mockResolvedValueOnce(goodInfo('https://a/second-client.m4a'));
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      const stream = await resolver.resolve(VIDEO_ID);

      expect(stream.streamUrl).toBe('https://a/second-client.m4a');
      expect(ytdl).toHaveBeenCalledTimes(2);
      // Трек заиграл, но адрес уже помечен — это видно диагностике.
      expect(resolver.hasSeenBotCheck()).toBe(true);
    });

    it('называет проверку своим кодом вместо «ничего не вышло»', async () => {
      const ytdl = vi.fn().mockRejectedValue(new Error(BOT_CHECK_MESSAGE));
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      // Разные коды — разные подсказки человеку: у проверки есть лечение.
      await expect(resolver.resolve(VIDEO_ID)).rejects.toThrow(/^YT_BOT_CHECK: /);
      expect(ytdl).toHaveBeenCalledTimes(RESOLVE_ATTEMPTS.length);

      const log = resolver.readLog().join('\n');
      expect(log).toContain('не от робота');
      expect(log).toContain(`bot check blocked ${VIDEO_ID}`);
    });

    it('оставляет YT_ALL_ATTEMPTS_FAILED там, где проверки не было', async () => {
      const ytdl = vi.fn().mockRejectedValue(new Error('HTTP Error 403: Forbidden'));
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      await expect(resolver.resolve(VIDEO_ID)).rejects.toThrow(/^YT_ALL_ATTEMPTS_FAILED: /);
      expect(resolver.hasSeenBotCheck()).toBe(false);
    });
  });

  // ==========================================================================
  // cookies браузера
  // ==========================================================================
  describe('cookies', () => {
    it('добирает попытки с cookies, когда анонимные кончились', async () => {
      const ytdl = vi.fn().mockRejectedValue(new Error('HTTP Error 403: Forbidden'));
      const resolver = new StreamResolver({
        ytdl,
        verify: false,
        now: () => NOW,
        stateDir,
        cookiesFromBrowser: 'firefox'
      });

      await expect(resolver.resolve(VIDEO_ID)).rejects.toThrow(/^YT_ALL_ATTEMPTS_FAILED: /);

      expect(ytdl).toHaveBeenCalledTimes(RESOLVE_ATTEMPTS.length + COOKIE_AWARE_COUNT);
      const flags = ytdl.mock.calls.map((call) => call[1] as Record<string, unknown>);
      // Сначала анонимно — сессия идёт в дело только когда без неё не выходит.
      expect(flags.slice(0, RESOLVE_ATTEMPTS.length).every((f) => !('cookiesFromBrowser' in f))).toBe(true);
      expect(
        flags.slice(RESOLVE_ATTEMPTS.length).every((f) => f.cookiesFromBrowser === 'firefox')
      ).toBe(true);
      // Флаги базовой попытки при этом остаются на месте.
      expect(flags[flags.length - 1]).toMatchObject({ dumpSingleJson: true, noPlaylist: true });
    });

    it('меняет источник на ходу и отбрасывает незнакомый браузер', async () => {
      const ytdl = vi.fn().mockResolvedValue(goodInfo());
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      expect(resolver.getCookiesFromBrowser()).toBeNull();

      resolver.setCookiesFromBrowser('Edge');
      expect(resolver.getCookiesFromBrowser()).toBe('edge');
      expect(resolver.readLog().join('\n')).toContain('cookies YouTube берутся из edge');

      // Мусор не должен «прилипать»: настройка просто выключается.
      resolver.setCookiesFromBrowser('netscape');
      expect(resolver.getCookiesFromBrowser()).toBeNull();
      expect(resolver.readLog().join('\n')).toContain('cookies YouTube отключены');
    });

    it('после проверки «вы не робот» начинает следующий трек с cookies', async () => {
      const ytdl = vi.fn().mockRejectedValue(new Error(BOT_CHECK_MESSAGE));
      const resolver = new StreamResolver({
        ytdl,
        verify: false,
        now: () => NOW,
        stateDir,
        cookiesFromBrowser: 'chrome'
      });

      await expect(resolver.resolve('aaaaaaaaaaa')).rejects.toThrow(/^YT_BOT_CHECK: /);
      const afterFirst = ytdl.mock.calls.length;
      expect(ytdl.mock.calls[0][1]).not.toHaveProperty('cookiesFromBrowser');

      ytdl.mockResolvedValueOnce(goodInfo('https://a/authorized.m4a'));
      const stream = await resolver.resolve('bbbbbbbbbbb');

      // Иначе каждый следующий трек начинался бы с пяти заведомо провальных
      // попыток и играл на минуту позже.
      expect(stream.streamUrl).toBe('https://a/authorized.m4a');
      expect(ytdl.mock.calls[afterFirst][1]).toMatchObject({ cookiesFromBrowser: 'chrome' });
      expect(ytdl).toHaveBeenCalledTimes(afterFirst + 1);
    });
  });

  // ==========================================================================
  // verifyStreamUrl
  // ==========================================================================
  describe('verifyStreamUrl', () => {
    it('asks the open-ended range the player asks for, and accepts only 200 or 206', async () => {
      const fetchImpl = probe(206);
      const resolver = new StreamResolver({ ytdl: vi.fn(), fetchImpl });

      const ok = await resolver.verifyStreamUrl('https://a/x.m4a');
      expect(ok).toEqual({ ok: true, reason: 'HTTP 206' });

      const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.method).toBe('GET');
      // Not `bytes=0-1`: googlevideo answers a bounded two-byte range with 206
      // even for a URL that needs a proof-of-origin token, so the probe used to
      // certify URLs that then failed on playback. Chromium sends `bytes=0-`.
      expect(init.headers).toMatchObject({ Range: 'bytes=0-' });
      expect(String((init.headers as Record<string, string>).Range)).not.toMatch(/bytes=0-\d/);

      const forbidden = new StreamResolver({ ytdl: vi.fn(), fetchImpl: probe(403) });
      expect(await forbidden.verifyStreamUrl('https://a/x.m4a')).toEqual({ ok: false, reason: 'HTTP 403' });
    });

    it('releases the body it never reads', async () => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      const fetchImpl = vi.fn().mockResolvedValue({ status: 200, body: { cancel } }) as unknown as typeof fetch;
      const resolver = new StreamResolver({ ytdl: vi.fn(), fetchImpl });

      await resolver.verifyStreamUrl('https://a/x.m4a');
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('turns a thrown probe into a reason instead of a rejection', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) as unknown as typeof fetch;
      const resolver = new StreamResolver({ ytdl: vi.fn(), fetchImpl });

      expect(await resolver.verifyStreamUrl('https://a/x.m4a')).toEqual({ ok: false, reason: 'ETIMEDOUT' });
    });

    it('passes the URL through when the runtime has no fetch at all', async () => {
      // `fetchImpl: undefined` falls back to `globalThis.fetch`, so the only way
      // to reach the no-probe branch is a runtime without fetch.
      vi.stubGlobal('fetch', undefined);
      try {
        const resolver = new StreamResolver({ ytdl: vi.fn() });
        expect(await resolver.verifyStreamUrl('https://a/x.m4a')).toEqual({
          ok: true,
          reason: 'no fetch available'
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // ==========================================================================
  // Cache
  // ==========================================================================
  describe('cache', () => {
    it('serves a second request from memory without spawning yt-dlp again', async () => {
      const expire = Math.floor(NOW / 1000) + 3600;
      const ytdl = vi.fn().mockResolvedValue(goodInfo(`https://a/x.m4a?expire=${expire}`));
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      const first = await resolver.resolve(VIDEO_ID);
      const second = await resolver.resolve(VIDEO_ID);

      expect(second).toEqual(first);
      expect(ytdl).toHaveBeenCalledTimes(1);
    });

    it('survives a restart through cache/streams.json', async () => {
      const expire = Math.floor(NOW / 1000) + 3600;
      const ytdl = vi.fn().mockResolvedValue(goodInfo(`https://a/persisted.m4a?expire=${expire}`));
      await new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir }).resolve(VIDEO_ID);

      expect(existsSync(path.join(stateDir, 'cache', 'streams.json'))).toBe(true);

      const reborn = new StreamResolver({ ytdl: vi.fn(), verify: false, now: () => NOW, stateDir });
      expect((await reborn.resolve(VIDEO_ID)).streamUrl).toContain('persisted.m4a');
    });

    it('re-resolves a URL that expires within the minute rather than handing it out', async () => {
      const cacheFile = path.join(stateDir, 'cache', 'streams.json');
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(
        cacheFile,
        JSON.stringify({
          [VIDEO_ID]: { streamUrl: 'https://a/nearly-dead.m4a', format: 'm4a', bitrate: 128, expiresAt: NOW + 30_000 }
        }),
        'utf-8'
      );

      const ytdl = vi.fn().mockResolvedValue(goodInfo('https://a/fresh.m4a'));
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      expect((await resolver.resolve(VIDEO_ID)).streamUrl).toBe('https://a/fresh.m4a');
      expect(ytdl).toHaveBeenCalledTimes(1);
    });

    it('drops an already-expired entry while loading the file', async () => {
      const cacheFile = path.join(stateDir, 'cache', 'streams.json');
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(
        cacheFile,
        JSON.stringify({
          [VIDEO_ID]: { streamUrl: 'https://a/dead.m4a', format: 'm4a', bitrate: 128, expiresAt: NOW - 1 }
        }),
        'utf-8'
      );

      const ytdl = vi.fn().mockResolvedValue(goodInfo('https://a/fresh.m4a'));
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });
      expect((await resolver.resolve(VIDEO_ID)).streamUrl).toBe('https://a/fresh.m4a');
    });

    it('logs and keeps working when the cache file is corrupt', async () => {
      const cacheFile = path.join(stateDir, 'cache', 'streams.json');
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, '{ not json', 'utf-8');

      const ytdl = vi.fn().mockResolvedValue(goodInfo());
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      await expect(resolver.resolve(VIDEO_ID)).resolves.toBeTruthy();
      expect(resolver.readLog().join('\n')).toMatch(/could not read stream cache/);
    });

    it('clearCache empties memory and disk so the next play re-resolves', async () => {
      const ytdl = vi.fn().mockResolvedValue(goodInfo());
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });
      await resolver.resolve(VIDEO_ID);

      resolver.clearCache();

      expect(readFileSync(path.join(stateDir, 'cache', 'streams.json'), 'utf-8')).toBe('{}');
      await resolver.resolve(VIDEO_ID);
      expect(ytdl).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Log
  // ==========================================================================
  describe('log', () => {
    it('records a cache hit and a resolution with the id and the client used', async () => {
      const expire = Math.floor(NOW / 1000) + 3600;
      const ytdl = vi.fn().mockResolvedValue(goodInfo(`https://a/x.m4a?expire=${expire}`));
      const resolver = new StreamResolver({ ytdl, verify: false, now: () => NOW, stateDir });

      await resolver.resolve(VIDEO_ID);
      await resolver.resolve(VIDEO_ID);

      const log = resolver.readLog();
      expect(log.some((line) => line.includes(`resolved ${VIDEO_ID} via default`))).toBe(true);
      expect(log.some((line) => line.includes(`cache hit ${VIDEO_ID}`))).toBe(true);
      // Every line is timestamped, or the log cannot be correlated with anything.
      expect(log.every((line) => /^\[\d{4}-\d{2}-\d{2}T/.test(line))).toBe(true);
    });

    it('returns the tail, not the whole file', () => {
      const resolver = new StreamResolver({ ytdl: vi.fn(), stateDir, now: () => NOW });
      for (let i = 0; i < 40; i++) resolver.log(`line ${i}`);

      const tail = resolver.readLog(5);
      expect(tail).toHaveLength(5);
      expect(tail[4]).toContain('line 39');
    });

    it('reads as empty before anything was written, and with no state directory', () => {
      expect(new StreamResolver({ ytdl: vi.fn(), stateDir }).readLog()).toEqual([]);
      expect(new StreamResolver({ ytdl: vi.fn() }).readLog()).toEqual([]);
    });

    it('falls back to the console when there is nowhere to write', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      new StreamResolver({ ytdl: vi.fn() }).log('nowhere to go');
      expect(spy).toHaveBeenCalledWith('[StreamResolver] nowhere to go');
    });
  });
});
