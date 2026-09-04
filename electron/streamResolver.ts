/**
 * YouTube audio stream resolution for the main process.
 *
 * Split out of `main.ts` because resolving a stream is no longer a single call:
 * it rotates yt-dlp client configurations, verifies the URL actually plays
 * before the renderer commits to it, caches results across restarts, caps how
 * many extractor processes run at once and records every attempt to a log the
 * user can hand over when something fails.
 *
 * Everything the module touches is injected, so it runs under vitest without
 * Electron, a real yt-dlp binary or a network.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import path from 'path';

/** What the renderer receives for a playable track. */
export interface ResolvedStream {
  streamUrl: string;
  format: string;
  bitrate: number;
  expiresAt: number;
}

/** Stable prefixes so the renderer can explain a failure without parsing prose. */
export type StreamFailureCode =
  | 'YT_AGE_RESTRICTED'
  | 'YT_UNAVAILABLE'
  | 'YT_GEO_BLOCKED'
  | 'YT_PRIVATE'
  | 'YT_LIVE'
  | 'YT_BINARY_MISSING'
  | 'YT_NETWORK'
  | 'YT_NO_AUDIO'
  | 'YT_BOT_CHECK'
  | 'YT_ALL_ATTEMPTS_FAILED';

export interface StreamResolverDeps {
  /** `youtube-dl-exec` instance bound to the bundled binary. */
  ytdl: (url: string, flags: Record<string, unknown>) => Promise<unknown>;
  /** Directory for `logs/streams.log` and `cache/streams.json`; usually userData. */
  stateDir?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Concurrent extractor processes. Two keeps a slow machine responsive. */
  maxConcurrent?: number;
  /**
   * Столько процессов разрешено, когда ссылку ждёт человек. Больше `maxConcurrent`
   * нарочно: фоновая предзагрузка не должна задерживать нажатие play.
   */
  maxConcurrentUrgent?: number;
  /** Set false in tests to skip the network probe. */
  verify?: boolean;
  /**
   * Браузер, из cookies которого берётся сессия YouTube (`chrome`, `firefox`, …).
   * `null` — не использовать; см. {@link buildAttempts}.
   */
  cookiesFromBrowser?: string | null;
}

/** yt-dlp flags shared by every attempt. */
const BASE_FLAGS: Readonly<Record<string, unknown>> = {
  dumpSingleJson: true,
  noWarnings: true,
  noPlaylist: true,
  noCheckCertificates: true,
  socketTimeout: 12,
  retries: 1
};

/** Одна ступень лестницы попыток. */
export interface ResolveAttempt {
  label: string;
  flags: Record<string, unknown>;
  /**
   * Клиент, которому yt-dlp вообще передаёт cookies. У `visionos`, `android*` и
   * `ios` в извлекателе стоит `SUPPORTS_COOKIES: false`, поэтому сессию им
   * подсовывать бессмысленно — попытка будет анонимной, только медленнее.
   */
  cookieAware?: boolean;
}

/**
 * Client configurations tried in order until one yields a URL that verifies.
 *
 * YouTube ties some formats to a proof-of-origin token; those resolve to a URL
 * that answers 403 on playback. Different clients hand back different format
 * sets, so rotating them is what turns "only some songs play" into "songs play".
 *
 * Порядок — от самых живучих к самым капризным, и он не произвольный:
 * `tv` и `tv_downgraded` в извлекателе вообще не имеют политики PO-токена, у
 * `visionos` её тоже нет и ему не нужен JS-плеер (меньше запросов — меньше
 * поводов для проверки «вы не робот»), а `web_safari` отдаёт заранее склеенный
 * HLS, который приложение умеет играть через hls.js.
 *
 * Чего здесь больше нет: `android_vr` (в самом yt-dlp помечен как отдающий 403
 * на все форматы) и `web_music` (требует PO-токен для HTTPS и DASH, то есть
 * ссылку, которую наша проверка всё равно отбракует). Обе ступени тратили по
 * десять секунд на заведомый провал.
 */
export const RESOLVE_ATTEMPTS: ReadonlyArray<ResolveAttempt> = [
  { label: 'default', flags: {}, cookieAware: true },
  { label: 'tv', flags: { extractorArgs: 'youtube:player_client=tv' }, cookieAware: true },
  { label: 'tv_downgraded', flags: { extractorArgs: 'youtube:player_client=tv_downgraded' }, cookieAware: true },
  { label: 'visionos', flags: { extractorArgs: 'youtube:player_client=visionos' } },
  { label: 'web_safari', flags: { extractorArgs: 'youtube:player_client=web_safari' }, cookieAware: true }
];

/**
 * «Sign in to confirm you're not a bot».
 *
 * Это не приговор конкретному видео: один клиент получает проверку, другой в ту
 * же секунду отдаёт формат — поэтому среди TERMINAL_ERROR_PATTERNS её нет,
 * перебор обязан продолжиться. Но если её увидели все клиенты, честный ответ
 * человеку не «ничего не вышло», а «YouTube требует подтверждения»: с этим он
 * хотя бы знает, что делать дальше.
 */
export const BOT_CHECK_PATTERN = /not a bot|bot check|confirm your identity/i;

/**
 * Браузеры, из которых yt-dlp умеет читать cookies.
 *
 * Список закрытый нарочно: значение приходит из renderer и уезжает в аргументы
 * дочернего процесса, поэтому всё, чего здесь нет, отбрасывается. Копия для
 * выпадающего списка — в `src/components/settings/DiagnosticsSettings.tsx`.
 */
export const COOKIE_BROWSERS: ReadonlyArray<string> = [
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'brave',
  'opera',
  'vivaldi',
  'safari',
  'whale'
];

/** Приводит выбор к одному из {@link COOKIE_BROWSERS} или к `null`. */
export function normalizeCookieBrowser(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  return COOKIE_BROWSERS.includes(name) ? name : null;
}

/**
 * Собирает лестницу попыток под текущие условия.
 *
 * Без cookies это просто {@link RESOLVE_ATTEMPTS}. Если человек разрешил брать
 * сессию из браузера, те же клиенты добавляются ещё раз, уже с cookies — но в
 * конец: пока YouTube отдаёт аудио анонимно, светить аккаунт незачем. А как
 * только проверка «вы не робот» в этом запуске уже случилась, cookies уходят
 * вперёд — иначе каждый следующий трек начинается с пяти заведомо провальных
 * попыток и играет на минуту позже.
 */
export function buildAttempts(cookiesFromBrowser: string | null, botCheckSeen: boolean = false): ResolveAttempt[] {
  // Копия и самих ступеней, и их флагов: `flags` иначе остался бы тем же
  // объектом, что в RESOLVE_ATTEMPTS, и любая правка на месте переписала бы
  // лестницу до конца работы процесса.
  const anonymous = RESOLVE_ATTEMPTS.map((attempt) => ({ ...attempt, flags: { ...attempt.flags } }));
  if (!cookiesFromBrowser) return anonymous;

  const authorized = RESOLVE_ATTEMPTS.filter((attempt) => attempt.cookieAware).map((attempt) => ({
    label: `${attempt.label}+cookies`,
    flags: { ...attempt.flags, cookiesFromBrowser },
    cookieAware: true
  }));

  return botCheckSeen ? [...authorized, ...anonymous] : [...anonymous, ...authorized];
}

/** Fallback lifetime when the URL carries no `expire` parameter. */
export const DEFAULT_STREAM_TTL_MS = 5 * 60 * 60 * 1000;

/** Entries kept in the on-disk cache; oldest expiries are dropped first. */
const MAX_CACHE_ENTRIES = 400;

/** Log size before it rolls over to `streams.log.1`. */
const MAX_LOG_BYTES = 512 * 1024;

/** yt-dlp messages that mean "retrying will not help". */
const TERMINAL_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; code: StreamFailureCode }> = [
  { pattern: /age[- ]restricted|confirm your age|inappropriate for some users/i, code: 'YT_AGE_RESTRICTED' },
  { pattern: /private video|sign in if you've been granted access/i, code: 'YT_PRIVATE' },
  // yt-dlp's usual wording is "The uploader has not made this video available in
  // your country", so anchoring on "not available" missed the common case.
  {
    pattern:
      /available in your country|available (?:in|from) your location|geo[- ]?restricted|blocked it in your country/i,
    code: 'YT_GEO_BLOCKED'
  },
  { pattern: /video unavailable|has been removed|been terminated|does not exist/i, code: 'YT_UNAVAILABLE' },
  { pattern: /is live|premiere|live event will begin/i, code: 'YT_LIVE' },
  { pattern: /ENOENT|spawn .*yt-dlp|no such file or directory/i, code: 'YT_BINARY_MISSING' }
];

/** A yt-dlp format entry, narrowed to the fields that matter for audio. */
interface YtDlpFormat {
  url?: string;
  ext?: string;
  abr?: number;
  tbr?: number;
  acodec?: string;
  vcodec?: string;
  protocol?: string;
  format_id?: string;
  filesize?: number;
}

/**
 * Reads the expiry stamped into a googlevideo URL.
 *
 * These URLs die on a schedule YouTube picks, so trusting a fixed TTL either
 * throws away a good URL or keeps a dead one. Falls back to a conservative TTL.
 */
export function getStreamExpiry(streamUrl: string, now: number = Date.now()): number {
  try {
    const parsed = new URL(streamUrl);
    const expire = parsed.searchParams.get('expire');
    if (expire && /^\d+$/.test(expire)) {
      const asMs = Number(expire) * 1000;
      if (asMs > now) return asMs;
    }
    // Some CDN URLs carry the deadline inside the path (`/expire/1893456000/`).
    const inPath = /\/expire\/(\d{9,})/.exec(parsed.pathname);
    if (inPath) {
      const asMs = Number(inPath[1]) * 1000;
      if (asMs > now) return asMs;
    }
  } catch {
    // Not a parseable URL — fall through to the default TTL.
  }
  return now + DEFAULT_STREAM_TTL_MS;
}

/**
 * Picks the best directly playable audio format from a yt-dlp info payload.
 *
 * Progressive HTTP wins over HLS and DASH: `<audio>` plays the former natively,
 * while a manifest needs hls.js and fails outright for DASH. Video-bearing
 * formats are a last resort — they play, but waste bandwidth on frames nobody
 * sees.
 */
export function pickAudioFormat(info: unknown): { format: YtDlpFormat; isManifest: boolean } | null {
  const payload = info as { formats?: YtDlpFormat[]; url?: string; ext?: string; abr?: number; requested_downloads?: YtDlpFormat[] } | null;
  if (!payload) return null;

  const candidates: YtDlpFormat[] = [];
  if (Array.isArray(payload.formats)) candidates.push(...payload.formats);
  if (Array.isArray(payload.requested_downloads)) candidates.push(...payload.requested_downloads);
  if (payload.url) {
    candidates.push({ url: payload.url, ext: payload.ext, abr: payload.abr, acodec: 'unknown', vcodec: 'none' });
  }

  const playable = candidates.filter((f) => typeof f.url === 'string' && f.url.length > 0);
  if (playable.length === 0) return null;

  const isManifest = (f: YtDlpFormat): boolean =>
    /m3u8|dash|manifest/i.test(f.protocol || '') || /\.m3u8(\?|$)/i.test(f.url || '');
  const isAudioOnly = (f: YtDlpFormat): boolean =>
    f.vcodec === 'none' || (!!f.acodec && f.acodec !== 'none' && !f.vcodec);
  const hasAudio = (f: YtDlpFormat): boolean => f.acodec !== 'none';
  const rate = (f: YtDlpFormat): number => f.abr || f.tbr || 0;
  // m4a first: the widest native support, and what YouTube Music itself serves.
  const extRank = (f: YtDlpFormat): number => (f.ext === 'm4a' ? 2 : f.ext === 'webm' ? 1 : 0);

  const score = (f: YtDlpFormat): number =>
    (isAudioOnly(f) ? 4000 : hasAudio(f) ? 500 : 0) +
    (isManifest(f) ? 0 : 2000) +
    extRank(f) * 100 +
    Math.min(rate(f), 320);

  const sorted = [...playable].sort((a, b) => score(b) - score(a));
  const chosen = sorted[0];
  return { format: chosen, isManifest: isManifest(chosen) };
}

/** Maps a yt-dlp failure onto a stable code, or null when a retry may help. */
export function classifyResolveError(message: string): StreamFailureCode | null {
  for (const { pattern, code } of TERMINAL_ERROR_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return null;
}

/**
 * Кто ждёт ссылку: человек, который сейчас смотрит на кнопку play, или фон.
 *
 * Разница не в вежливости, а в секундах ожидания. Предзагрузка следующего трека
 * и пакетное сохранение плейлиста в офлайн занимают все слоты извлекателя, и без
 * приоритета нажатие play встаёт в очередь за десятками фоновых задач.
 */
export type ResolvePriority = 'user' | 'prefetch';

const PRIORITY_USER = 2;
const PRIORITY_PREFETCH = 1;

/**
 * Место в очереди на слот извлекателя.
 *
 * Приоритет — изменяемое поле, а не аргумент: пока заявка ждёт, человек может
 * нажать play ровно на том треке, который мы качали в фоне. Тогда её поднимают
 * на месте, и очередь обязана увидеть новое значение — see {@link StreamResolver.resolve}.
 */
interface ResolveTicket {
  priority: number;
}

/**
 * Bounded concurrency с приоритетом: extra callers wait instead of spawning
 * more processes, но заявка человека ждёт меньше фоновой.
 *
 * Два лимита вместо одного. Фон живёт в узком (`limit`) — на слабой машине два
 * yt-dlp уже заметны. Заявке человека разрешён более широкий (`urgentLimit`),
 * поэтому она не ждёт вообще: свободных слотов по её счёту ещё хватает, даже
 * когда фон занял все свои. Убить уже запущенный процесс мы всё равно не можем,
 * так что «вытеснение» здесь — это право пройти рядом, а не вместо.
 */
class PriorityGate {
  private active = 0;
  private readonly waiting: Array<{ ticket: ResolveTicket; seq: number; wake: () => void }> = [];
  private seq = 0;

  constructor(
    private readonly limit: number,
    private readonly urgentLimit: number
  ) {}

  /** Сколько процессов разрешено этому приоритету. */
  private allowanceFor(priority: number): number {
    return priority >= PRIORITY_USER ? this.urgentLimit : this.limit;
  }

  public async run<T>(ticket: ResolveTicket, task: () => Promise<T>): Promise<T> {
    let counted = false;
    if (this.active >= this.allowanceFor(ticket.priority)) {
      await new Promise<void>((resolve) => {
        this.waiting.push({ ticket, seq: this.seq++, wake: resolve });
      });
      // Слот посчитан тем, кто разбудил, — see pump().
      counted = true;
    }
    if (!counted) this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  /**
   * Пропускает столько ожидающих, сколько проходит по их лимиту: заявка человека
   * пройдёт там, где фоновая ещё нет.
   *
   * Слот занимается здесь, а не в разбуженной заявке: между `wake()` и
   * продолжением её микротаски прошёл бы ещё один цикл событий, и всё это время
   * `active` был бы занижен — pump разбудил бы всю очередь сразу.
   */
  private pump(): void {
    for (;;) {
      let bestAt = -1;
      for (let i = 0; i < this.waiting.length; i++) {
        const candidate = this.waiting[i];
        if (this.active >= this.allowanceFor(candidate.ticket.priority)) continue;
        const best = bestAt >= 0 ? this.waiting[bestAt] : null;
        const better =
          !best ||
          candidate.ticket.priority > best.ticket.priority ||
          (candidate.ticket.priority === best.ticket.priority && candidate.seq < best.seq);
        if (better) bestAt = i;
      }
      if (bestAt < 0) return;
      const [chosen] = this.waiting.splice(bestAt, 1);
      this.active += 1;
      chosen.wake();
    }
  }
}

export class StreamResolver {
  private readonly ytdl: StreamResolverDeps['ytdl'];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly gate: PriorityGate;
  private readonly shouldVerify: boolean;
  private readonly logFile: string | null;
  private readonly cacheFile: string | null;

  /** Resolutions in flight, so two callers for one track share one process. */
  private readonly inFlight = new Map<string, { promise: Promise<ResolvedStream>; ticket: ResolveTicket }>();
  private cache = new Map<string, ResolvedStream>();
  private cacheLoaded = false;
  private cookiesFromBrowser: string | null;
  /**
   * Проверку «вы не робот» уже видели в этом запуске.
   *
   * Один раз наткнувшись, дальше начинаем с cookies: YouTube помечает адрес, а
   * не отдельное видео, поэтому анонимные попытки будут проваливаться и на всех
   * следующих треках.
   */
  private botCheckSeen = false;

  constructor(deps: StreamResolverDeps) {
    this.ytdl = deps.ytdl;
    this.fetchImpl = deps.fetchImpl || ((globalThis as { fetch?: typeof fetch }).fetch as typeof fetch);
    this.now = deps.now || (() => Date.now());
    const background = Math.max(1, deps.maxConcurrent ?? 2);
    // Запас для человека считается от фонового лимита: настроили один слот —
    // получите два, а не жёстко вписанное число.
    this.gate = new PriorityGate(background, Math.max(background, deps.maxConcurrentUrgent ?? background * 2));
    this.shouldVerify = deps.verify !== false;
    this.cookiesFromBrowser = normalizeCookieBrowser(deps.cookiesFromBrowser);
    const stateDir = deps.stateDir || null;
    this.logFile = stateDir ? path.join(stateDir, 'logs', 'streams.log') : null;
    this.cacheFile = stateDir ? path.join(stateDir, 'cache', 'streams.json') : null;
  }

  /**
   * Меняет источник cookies на ходу — настройка применяется без перезапуска.
   *
   * Кэш ссылок при этом не сбрасывается: уже проверенные адреса играют и без
   * сессии, а вот заново запрашивать их будем уже с ней.
   */
  public setCookiesFromBrowser(browser: string | null): void {
    const next = normalizeCookieBrowser(browser);
    if (next === this.cookiesFromBrowser) return;
    this.cookiesFromBrowser = next;
    this.log(next ? `cookies YouTube берутся из ${next}` : 'cookies YouTube отключены');
  }

  /** Для диагностики: какой источник cookies настроен сейчас. */
  public getCookiesFromBrowser(): string | null {
    return this.cookiesFromBrowser;
  }

  /** Для диагностики: натыкались ли на проверку «вы не робот» в этом запуске. */
  public hasSeenBotCheck(): boolean {
    return this.botCheckSeen;
  }

  /**
   * Resolves a playable audio URL for a video id.
   *
   * @param priority `prefetch` — фоновая задача (предзагрузка следующего трека,
   *   сохранение в офлайн); её обгонит любой запрос от человека.
   * @throws Error whose message starts with a {@link StreamFailureCode}
   */
  public async resolve(videoId: string, priority: ResolvePriority = 'user'): Promise<ResolvedStream> {
    if (!videoId || typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      throw new Error(`Invalid YouTube video ID format: ${videoId}`);
    }

    const cached = this.readCache(videoId);
    if (cached) {
      this.log(`cache hit ${videoId} (expires in ${Math.round((cached.expiresAt - this.now()) / 1000)}s)`);
      return cached;
    }

    const wanted = priority === 'prefetch' ? PRIORITY_PREFETCH : PRIORITY_USER;
    const existing = this.inFlight.get(videoId);
    if (existing) {
      // Человек нажал play на том, что уже качается в фоне. Заявка может стоять
      // в очереди — тогда без повышения он прождёт наравне с предзагрузкой.
      if (wanted > existing.ticket.priority) {
        existing.ticket.priority = wanted;
        this.log(`priority raised for ${videoId}: prefetch → user`);
      }
      return existing.promise;
    }

    const ticket: ResolveTicket = { priority: wanted };
    const attempt = this.gate
      .run(ticket, () => this.resolveUncached(videoId))
      .finally(() => this.inFlight.delete(videoId));
    this.inFlight.set(videoId, { promise: attempt, ticket });
    return attempt;
  }

  /** Runs the attempt ladder. Separated so queueing stays readable. */
  private async resolveUncached(videoId: string): Promise<ResolvedStream> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const failures: string[] = [];
    const startedAt = this.now();
    let sawBotCheck = false;

    for (const { label, flags } of buildAttempts(this.cookiesFromBrowser, this.botCheckSeen)) {
      try {
        const info = await this.ytdl(url, { ...BASE_FLAGS, ...flags });
        const picked = pickAudioFormat(info);
        if (!picked || !picked.format.url) {
          failures.push(`${label}: no audio format in response`);
          continue;
        }

        const streamUrl = picked.format.url;
        // A manifest cannot be probed with a byte range, and hls.js will report
        // its own errors, so it goes through unverified.
        if (this.shouldVerify && !picked.isManifest) {
          const probe = await this.verifyStreamUrl(streamUrl);
          if (!probe.ok) {
            failures.push(`${label}: URL rejected on playback (${probe.reason})`);
            this.log(`attempt ${label} for ${videoId} resolved but failed probe: ${probe.reason}`);
            continue;
          }
        }

        const resolved: ResolvedStream = {
          streamUrl,
          format: picked.format.ext || 'm4a',
          bitrate: Math.round(picked.format.abr || picked.format.tbr || 128),
          expiresAt: getStreamExpiry(streamUrl, this.now())
        };

        this.writeCache(videoId, resolved);
        this.log(
          `resolved ${videoId} via ${label} → ${resolved.format} ${resolved.bitrate}kbps in ${this.now() - startedAt}ms` +
            (failures.length > 0 ? ` (after ${failures.length} failed attempt(s))` : '')
        );
        return resolved;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${label}: ${message}`);

        if (BOT_CHECK_PATTERN.test(message)) {
          sawBotCheck = true;
          if (!this.botCheckSeen) {
            this.botCheckSeen = true;
            this.log(
              this.cookiesFromBrowser
                ? 'YouTube потребовал подтвердить, что запросы не от робота — дальше начинаем с cookies'
                : 'YouTube потребовал подтвердить, что запросы не от робота — без cookies браузера это не обойти'
            );
          }
        }

        // A removed or age-gated video fails identically for every client;
        // trying three more is 15 wasted seconds and a worse error message.
        const terminal = classifyResolveError(message);
        if (terminal) {
          this.log(`terminal failure for ${videoId} (${terminal}): ${message}`);
          throw new Error(`${terminal}: ${message}`);
        }
      }
    }

    const detail = failures.join('; ');
    // Проверка «вы не робот» — не «ничего не вышло»: у неё есть понятная причина
    // и понятное лечение, поэтому у неё отдельный код и отдельная фраза.
    if (sawBotCheck) {
      this.log(`bot check blocked ${videoId}: ${detail}`);
      throw new Error(`YT_BOT_CHECK: ${detail}`);
    }
    this.log(`all attempts failed for ${videoId}: ${detail}`);
    throw new Error(`YT_ALL_ATTEMPTS_FAILED: ${detail}`);
  }

  /**
   * Makes the exact request the media element will make, and keeps the URL only
   * if the CDN answers it.
   *
   * The header matters more than it looks. googlevideo serves a URL that needs a
   * proof-of-origin token only in narrow slices — a bounded `bytes=0-1` comes
   * back 206, which is why this probe used to certify URLs that never played.
   * Chromium asks for `bytes=0-` (open-ended, the whole file), and *that* is what
   * a gated URL answers with 403. Asking the same question the player will ask is
   * the only way the attempt ladder learns to move on to the next client.
   */
  public async verifyStreamUrl(streamUrl: string): Promise<{ ok: boolean; reason: string }> {
    if (typeof this.fetchImpl !== 'function') return { ok: true, reason: 'no fetch available' };
    try {
      const res = await this.fetchImpl(streamUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-' },
        signal: AbortSignal.timeout(6000)
      });
      // Reading the body is pointless once the status is known, and leaving it
      // open holds a socket for a stream we may discard.
      try {
        await res.body?.cancel();
      } catch {
        // Already consumed or unsupported — nothing to release.
      }
      if (res.status === 200 || res.status === 206) {
        return { ok: true, reason: `HTTP ${res.status}` };
      }
      return { ok: false, reason: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // --------------------------------------------------------------------------
  // Cache
  // --------------------------------------------------------------------------

  private ensureCacheLoaded(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    if (!this.cacheFile || !existsSync(this.cacheFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf-8')) as Record<string, ResolvedStream>;
      const now = this.now();
      for (const [videoId, entry] of Object.entries(raw)) {
        if (entry && typeof entry.streamUrl === 'string' && entry.expiresAt > now) {
          this.cache.set(videoId, entry);
        }
      }
    } catch (err) {
      this.log(`could not read stream cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readCache(videoId: string): ResolvedStream | null {
    this.ensureCacheLoaded();
    const entry = this.cache.get(videoId);
    if (!entry) return null;
    // Expire a minute early: a URL that dies mid-request looks like a bug.
    if (entry.expiresAt - 60_000 <= this.now()) {
      this.cache.delete(videoId);
      return null;
    }
    return entry;
  }

  private writeCache(videoId: string, stream: ResolvedStream): void {
    this.ensureCacheLoaded();
    this.cache.set(videoId, stream);
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const byExpiry = [...this.cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (const [key] of byExpiry.slice(0, this.cache.size - MAX_CACHE_ENTRIES)) {
        this.cache.delete(key);
      }
    }
    if (!this.cacheFile) return;
    try {
      mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(Object.fromEntries(this.cache)), 'utf-8');
    } catch (err) {
      this.log(`could not write stream cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Drops every cached URL. Exposed for the diagnostics panel. */
  public clearCache(): void {
    this.cache.clear();
    this.cacheLoaded = true;
    if (!this.cacheFile) return;
    try {
      writeFileSync(this.cacheFile, '{}', 'utf-8');
    } catch {
      // A cache we cannot clear is still a cache we can ignore.
    }
  }

  // --------------------------------------------------------------------------
  // Log
  // --------------------------------------------------------------------------

  /**
   * Appends one line to the stream log.
   *
   * Playback failures were previously invisible: the user saw "different errors"
   * and there was nothing to read afterwards. Every attempt lands here.
   */
  public log(message: string): void {
    const line = `[${new Date(this.now()).toISOString()}] ${message}\n`;
    if (!this.logFile) {
      console.log(`[StreamResolver] ${message}`);
      return;
    }
    try {
      mkdirSync(path.dirname(this.logFile), { recursive: true });
      if (existsSync(this.logFile) && statSync(this.logFile).size > MAX_LOG_BYTES) {
        renameSync(this.logFile, `${this.logFile}.1`);
      }
      appendFileSync(this.logFile, line, 'utf-8');
    } catch {
      console.log(`[StreamResolver] ${message}`);
    }
  }

  /** Returns the tail of the log for the in-app diagnostics view. */
  public readLog(maxLines = 200): string[] {
    if (!this.logFile || !existsSync(this.logFile)) return [];
    try {
      const lines = readFileSync(this.logFile, 'utf-8').split(/\r?\n/).filter(Boolean);
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }
}
