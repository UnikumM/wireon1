import { UnifiedTrack } from '../types/music';
import { formatDuration } from '../utils/time';

export interface SoundCloudStreamResult {
  streamUrl: string;
  format: 'mp3' | 'opus' | 'hls' | string;
  bitrate: number;
  expiresAt: number;
  /** True when SoundCloud only offered a snipped preview (usually 30 seconds). */
  isPreview?: boolean;
}

export interface SoundCloudServiceConfig {
  clientIds?: string[];
  requestTimeout?: number;
  /** Overrides the HLS capability probe (used by tests and by the main process). */
  hlsSupported?: boolean;
}

const DEFAULT_SOUNDCLOUD_CLIENT_IDS = [
  'UMY1dzQ68n2QbCuypNe8JOivmV2FO2Ep',
  'iZIs9mchVcX5lhVR1EzGCddqqBFMG2Gz',
  '2t9loNUA90tgrUmYD90deLdWICTLKYjx',
  'bJvN83Fp9oH3vTsmN6nJ0VvYgG83fT4x'
];

/** How long a client_id is trusted before it is re-checked. */
const CLIENT_ID_TTL_MS = 6 * 3600 * 1000;

/**
 * Сколько ключ считается негодным после отказа.
 *
 * Не навсегда: отказ мог относиться к конкретной загрузке, а не к ключу, да и
 * сам ключ со временем может ожить. Полчаса — достаточно, чтобы не долбиться в
 * мёртвый на каждом треке, и мало, чтобы не потерять живой из-за случайности.
 */
const DEAD_CLIENT_ID_TTL_MS = 30 * 60 * 1000;

/**
 * Чаще этого за свежим ключом не ходим.
 *
 * Поиск ключа — это загрузка страницы soundcloud.com и нескольких её сборок.
 * Когда все известные ключи разом переставали приниматься, каждый запрос
 * приложения тянул за собой такой поход, а SoundCloud за это отвечает 429 —
 * человек видел «источник ограничивает частоту запросов». Неудачная попытка
 * стоит паузы: если ключа не нашлось сейчас, через секунду он не появится.
 */
const DISCOVERY_COOLDOWN_MS = 60 * 1000;

/** Upper bound on the rotation pool so it cannot grow for the whole session. */
const MAX_CLIENT_IDS = 8;

/** Only the last few bundles ever carry the client_id — do not download megabytes. */
const MAX_BUNDLES_SCANNED = 3;

/** Fallback stream lifetime when the CDN policy cannot be read. */
const DEFAULT_STREAM_TTL_MS = 3600 * 1000;

const HLS_UNAVAILABLE = 'SoundCloud HLS playback unavailable';

const QUALITY_SCORE: Record<string, number> = { hq: 3, sq: 2, lq: 1 };

interface ElectronBridge {
  searchSoundCloud?: (query: string, clientId: string, limit?: number) => Promise<unknown>;
}

function getElectronBridge(): ElectronBridge | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { electronAPI?: ElectronBridge }).electronAPI;
  return api || null;
}

/**
 * «Ключ доступа не принят» — отдельно от всех прочих отказов.
 *
 * `client_id` у SoundCloud не выдаётся, а вычитывается из их же сборок и живёт
 * недолго; протухший ключ отвечает 401 на всё подряд. Без отдельного типа такой
 * отказ неотличим от «этой загрузки нет», и человек получал приговор треку там,
 * где надо было просто взять ключ поновее.
 */
export class SoundCloudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoundCloudAuthError';
  }
}

/**
 * Upgrades SoundCloud artwork URL to high resolution 500x500
 */
export function upgradeSoundCloudArtwork(rawUrl?: string): string {
  if (!rawUrl) return '';
  // Replace -large.jpg or -t120x120.jpg with -t500x500.jpg
  return rawUrl.replace(/-large\./, '-t500x500.').replace(/-t120x120\./, '-t500x500.');
}

/**
 * Reads the real expiry out of a CloudFront-signed SoundCloud CDN URL. The
 * `Policy` parameter is base64 with CloudFront's URL-safe alphabet and contains
 * `Condition.DateLessThan["AWS:EpochTime"]`.
 */
export function getSoundCloudStreamExpiry(
  url: string,
  fallbackTtlMs: number = DEFAULT_STREAM_TTL_MS
): number {
  try {
    const params = new URL(url).searchParams;

    const expires = params.get('Expires');
    if (expires) {
      const seconds = parseInt(expires, 10);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    }

    const policy = params.get('Policy');
    if (policy && typeof atob === 'function') {
      const normalized = policy.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
      const decoded = JSON.parse(atob(normalized));
      const epoch = decoded?.Statement?.[0]?.Condition?.DateLessThan?.['AWS:EpochTime'];
      if (typeof epoch === 'number' && Number.isFinite(epoch) && epoch > 0) {
        return epoch * 1000;
      }
    }
  } catch {
    // Signed policies change shape occasionally; the fixed TTL is a safe floor.
  }
  return Date.now() + fallbackTtlMs;
}

/**
 * Scores a transcoding so the best playable option wins: progressive beats HLS,
 * then higher quality, then a mime type an <audio> element understands.
 *
 * DRM protocols (`cbc-encrypted-hls`, `ctr-encrypted-hls`) score -1: they need a
 * licence server, so a URL from one is never playable here. Whether a
 * transcoding is a snipped preview is handled by `rankTranscodings`, not here.
 */
export function scoreTranscoding(transcoding: any): number {
  const protocol = transcoding?.format?.protocol;
  const mimeType: string = transcoding?.format?.mime_type || '';
  const quality: string = transcoding?.quality || '';

  if (!transcoding?.url || (protocol !== 'progressive' && protocol !== 'hls')) return -1;

  let score = protocol === 'progressive' ? 1000 : 0;
  score += (QUALITY_SCORE[quality] || 0) * 10;

  // `audio/mpegurl` is a playlist, not audio, and it contains the substring
  // "mpeg" — scored as mp3 it outranked the concrete codecs, and SoundCloud's
  // adaptive (`abr_sq`) manifest is the one variant that most often 404s.
  if (/mpegurl|m3u/i.test(mimeType)) score += 0;
  else if (mimeType.includes('mpeg') || mimeType.includes('mp3')) score += 3;
  else if (mimeType.includes('mp4') || mimeType.includes('aac')) score += 2;
  else if (mimeType.includes('opus') || mimeType.includes('ogg')) score += 1;

  return score;
}

/**
 * Every playable transcoding, best first.
 *
 * Snipped previews form a second tier rather than taking a score penalty: a
 * 30-second snippet is still playable when it is all SoundCloud offers, so it
 * must rank below every full transcoding without being filtered out as
 * unplayable.
 */
export function rankTranscodings(transcodings: any[]): any[] {
  return (transcodings || [])
    .map((transcoding) => ({
      transcoding,
      score: scoreTranscoding(transcoding),
      snipped: transcoding?.snipped === true
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => (a.snipped === b.snipped ? b.score - a.score : a.snipped ? 1 : -1))
    .map((entry) => entry.transcoding);
}

/**
 * Picks the best progressive transcoding, falling back to the best HLS one.
 */
export function pickBestTranscoding(transcodings: any[]): any | null {
  return rankTranscodings(transcodings)[0] ?? null;
}

export class SoundCloudService {
  private clientIds: string[];
  private currentClientIdIndex: number = 0;
  private requestTimeout: number;
  private cachedClientId: string | null = null;
  private clientIdExpiry: number = 0;
  /** Когда в последний раз ходили за свежим ключом — удачно или нет. */
  private lastDiscoveryAt: number = 0;
  /**
   * Ключи, которые только что отвечали «не авторизован», и когда это было.
   *
   * Ради этого списка всё и затевалось. Из четырёх вшитых ключей живым может
   * быть один: замерено 2026-09-01 — первый отдаёт 200, остальные три 401. Пока
   * перебор шёл вслепую, первый же отказ уводил приложение с рабочего ключа на
   * мёртвый и **кэшировал его на шесть часов** — после чего переставали работать
   * и звук, и поиск. Снаружи это выглядело как «SoundCloud выдаёт ошибку».
   */
  private deadClientIds: Map<string, number> = new Map();
  private discoveryInFlight: Promise<string | null> | null = null;
  private hlsSupportedOverride?: boolean;

  constructor(config: SoundCloudServiceConfig = {}) {
    this.clientIds = SoundCloudService.dedupe(config.clientIds || DEFAULT_SOUNDCLOUD_CLIENT_IDS);
    this.requestTimeout = config.requestTimeout || 6000;
    this.hlsSupportedOverride = config.hlsSupported;
  }

  private static dedupe(ids: string[]): string[] {
    return [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0))].slice(
      0,
      MAX_CLIENT_IDS
    );
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
   * The currently cached client_id, or null when there is none / it expired.
   */
  public getCachedClientId(): string | null {
    if (this.cachedClientId && Date.now() < this.clientIdExpiry) {
      return this.cachedClientId;
    }
    return null;
  }

  /**
   * Stores a client_id for reuse. Passing null invalidates the cache.
   */
  public setClientId(clientId: string | null, ttlMs: number = CLIENT_ID_TTL_MS): void {
    if (!clientId) {
      this.cachedClientId = null;
      this.clientIdExpiry = 0;
      return;
    }
    this.registerClientId(clientId);
    this.cachedClientId = clientId;
    this.clientIdExpiry = Date.now() + ttlMs;
  }

  /**
   * Adds a client_id to the front of the rotation pool, deduped and capped.
   */
  private registerClientId(clientId: string): void {
    if (!clientId) return;
    this.clientIds = SoundCloudService.dedupe([
      clientId,
      ...this.clientIds.filter(id => id !== clientId)
    ]);
    this.currentClientIdIndex = 0;
  }

  /**
   * Returns a client_id without touching the network on the happy path: the
   * cached value first, then the known-good static pool. Scraping soundcloud.com
   * only happens once the pool has actually been rejected.
   */
  public async getClientId(): Promise<string> {
    const cached = this.getCachedClientId();
    if (cached && !this.isDead(cached)) return cached;

    const known = this.firstLiveClientId();
    if (known) {
      this.cachedClientId = known;
      this.clientIdExpiry = Date.now() + CLIENT_ID_TTL_MS;
      return known;
    }

    const discovered = await this.discoverFreshClientId();
    if (discovered) return discovered;

    throw new Error('No SoundCloud client_id available');
  }

  /** Первый ключ из набора, который сейчас не помечен негодным. */
  private firstLiveClientId(): string | null {
    const size = this.clientIds.length;
    for (let step = 0; step < size; step++) {
      const candidate = this.clientIds[(this.currentClientIdIndex + step) % size];
      if (candidate && !this.isDead(candidate)) {
        this.currentClientIdIndex = (this.currentClientIdIndex + step) % size;
        return candidate;
      }
    }
    return null;
  }

  /**
   * Помечает ключ негодным — но никогда не оставляет набор без живых.
   *
   * Иначе один отказ на последнем ключе отключал бы SoundCloud целиком на
   * полчаса: `getClientId` не нашёл бы ни одного и ушёл бы в поиск свежего, а
   * тот может и не найтись. Последний ключ остаётся в строю: плохой рабочий
   * лучше, чем никакого.
   */
  private markDead(clientId: string): void {
    const liveElsewhere = this.clientIds.some((id) => id !== clientId && !this.isDead(id));
    if (!liveElsewhere) return;
    this.deadClientIds.set(clientId, Date.now());
  }

  private isDead(clientId: string): boolean {
    const at = this.deadClientIds.get(clientId);
    if (at === undefined) return false;
    if (Date.now() - at < DEAD_CLIENT_ID_TTL_MS) return true;
    this.deadClientIds.delete(clientId);
    return false;
  }

  /**
   * Ключ только что отработал — снимаем с него отметку негодного.
   *
   * Иначе одна случайная неудача держала бы рабочий ключ в чёрном списке
   * полчаса, хотя следующий же запрос по нему прошёл.
   */
  public noteClientIdWorked(clientId: string): void {
    this.deadClientIds.delete(clientId);
  }

  /**
   * Discovers a fresh client_id from the SoundCloud web bundles. Concurrent
   * callers share a single scrape.
   */
  public async discoverFreshClientId(): Promise<string | null> {
    if (this.discoveryInFlight) return this.discoveryInFlight;
    if (Date.now() - this.lastDiscoveryAt < DISCOVERY_COOLDOWN_MS) return null;
    this.lastDiscoveryAt = Date.now();

    this.discoveryInFlight = this.performDiscovery()
      .catch(err => {
        console.warn('[SoundCloudService] client_id discovery failed:', err);
        return null;
      })
      .finally(() => {
        this.discoveryInFlight = null;
      });

    return this.discoveryInFlight;
  }

  private async performDiscovery(): Promise<string | null> {
    let html: string;
    try {
      const resp = await this.fetchWithTimeout('https://soundcloud.com', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (!resp.ok) {
        console.warn(`[SoundCloudService] soundcloud.com returned HTTP ${resp.status}`);
        return null;
      }
      html = await resp.text();
    } catch (err) {
      console.warn('[SoundCloudService] Could not load soundcloud.com:', err);
      return null;
    }

    const scriptUrls = [...new Set(
      [...html.matchAll(/<script[^>]+src="([^">]+\.js)"/g)]
        .map(m => m[1])
        .filter(src => src.includes('sndcdn.com') || src.includes('/assets/'))
        .map(src => (src.startsWith('http') ? src : `https://soundcloud.com${src}`))
    )];

    // The client_id lives in one of the last bundles; scan from the end and stop
    // at the first hit instead of downloading every bundle.
    const candidates = scriptUrls.slice(-MAX_BUNDLES_SCANNED).reverse();

    for (const url of candidates) {
      try {
        const jsResp = await this.fetchWithTimeout(url);
        if (!jsResp.ok) {
          console.warn(`[SoundCloudService] Bundle ${url} returned HTTP ${jsResp.status}`);
          continue;
        }
        const js = await jsResp.text();
        const match =
          js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/) ||
          js.match(/["']client_id["']\s*:\s*["']([a-zA-Z0-9]{32})["']/);
        if (match && match[1]) {
          this.setClientId(match[1]);
          return match[1];
        }
      } catch (err) {
        console.warn(`[SoundCloudService] Bundle ${url} unreachable:`, err);
      }
    }

    console.warn('[SoundCloudService] No client_id found in the scanned bundles');
    return null;
  }

  /**
   * Rotates to the next client ID upon 401/403 rate limits. The cache expiry is
   * refreshed too, otherwise the next getClientId() would undo the rotation.
   */
  public rotateClientId(): string {
    /*
     * Ушедший ключ помечается негодным, а не просто уступает очередь.
     *
     * Без пометки перебор шёл по кругу и возвращался к тому же мёртвому ключу,
     * а хуже того — кэшировал его на шесть часов, отключая заодно и поиск.
     */
    const leaving = this.cachedClientId ?? this.clientIds[this.currentClientIdIndex];
    if (leaving) this.markDead(leaving);

    this.currentClientIdIndex = (this.currentClientIdIndex + 1) % this.clientIds.length;
    const next = this.firstLiveClientId();
    if (!next) {
      // Живых не осталось: снимаем кэш, чтобы `getClientId` пошёл за свежим.
      // Возвращается пустая строка, а не последний ключ: отдать негодный
      // значило бы предложить вызывающему сделать ещё один заведомо мёртвый
      // запрос.
      this.cachedClientId = null;
      this.clientIdExpiry = 0;
      return '';
    }
    this.cachedClientId = next;
    this.clientIdExpiry = Date.now() + CLIENT_ID_TTL_MS;
    return next;
  }

  /**
   * Search SoundCloud tracks
   */
  public async search(query: string, limit: number = 20): Promise<UnifiedTrack[]> {
    if (!query || !query.trim()) {
      return [];
    }

    const trimmedQuery = query.trim();

    const bridge = getElectronBridge();
    if (bridge && typeof bridge.searchSoundCloud === 'function') {
      try {
        const clientId = await this.getClientId();
        const data = await bridge.searchSoundCloud(trimmedQuery, clientId, limit);
        if (data) {
          return this.parseTracksResponse(data, limit);
        }
      } catch (ipcErr) {
        console.warn('[SoundCloudService] IPC search failed, falling back to fetch:', ipcErr);
      }
    }

    // One attempt per pooled client_id, plus one final attempt with a freshly
    // discovered id.
    const maxAttempts = Math.min(this.clientIds.length, MAX_CLIENT_IDS);
    let discoveryTried = false;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      let clientId: string;
      try {
        clientId = await this.getClientId();
      } catch (err) {
        console.warn('[SoundCloudService] Could not obtain a client_id:', err);
        break;
      }

      try {
        const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(trimmedQuery)}&client_id=${clientId}&limit=${limit}&offset=0`;
        const response = await this.fetchWithTimeout(searchUrl, {
          headers: { 'Accept': 'application/json' }
        });

        if (response.status === 401 || response.status === 403) {
          console.warn('[SoundCloudService] Client ID unauthorized or expired, rotating...');
          if (attempt < maxAttempts - 1) {
            this.rotateClientId();
            continue;
          }
          if (!discoveryTried) {
            discoveryTried = true;
            const fresh = await this.discoverFreshClientId();
            if (fresh) continue;
          }
          break;
        }

        if (!response.ok) {
          throw new Error(`SoundCloud search HTTP ${response.status}`);
        }

        const data = await response.json();
        // Ключ отработал — снимаем с него отметку негодного, если она была.
        this.noteClientIdWorked(clientId);
        return this.parseTracksResponse(data, limit);
      } catch (err) {
        console.warn(`[SoundCloudService] Search attempt ${attempt + 1} failed:`, err);
        if (attempt < maxAttempts - 1) {
          this.rotateClientId();
          continue;
        }
        if (!discoveryTried) {
          discoveryTried = true;
          const fresh = await this.discoverFreshClientId();
          if (fresh) continue;
        }
        break;
      }
    }

    console.warn(`[SoundCloudService] Search for "${trimmedQuery}" produced no results`);
    return [];
  }

  /**
   * Normalizes SoundCloud track JSON objects to UnifiedTrack format
   */
  public parseTracksResponse(data: any, limit: number = 20): UnifiedTrack[] {
    const results: UnifiedTrack[] = [];
    const items = Array.isArray(data?.collection) ? data.collection : Array.isArray(data) ? data : [];

    for (const item of items) {
      if (results.length >= limit) break;
      if (!item || !item.id || !item.title) continue;

      const trackId = String(item.id);
      const durationMs = typeof item.duration === 'number' ? item.duration : Number(item.duration);
      const durationSec =
        Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : 0;
      const artist = item.user?.username || 'SoundCloud Artist';
      const artwork = upgradeSoundCloudArtwork(item.artwork_url || item.user?.avatar_url);

      results.push({
        id: `sc_${trackId}`,
        source: 'soundcloud',
        originalId: trackId,
        title: item.title.trim(),
        artist: artist.trim(),
        duration: durationSec,
        durationFormatted: formatDuration(durationSec),
        artworkUrl: artwork,
        sourceUrl: item.permalink_url || `https://soundcloud.com/tracks/${trackId}`,
        format: 'mp3',
        bitrate: 128
      });
    }

    return results;
  }

  /**
   * Related tracks for autoplay radio. Never throws.
   */
  public async getRelatedTracks(trackId: string, limit: number = 10): Promise<UnifiedTrack[]> {
    if (!trackId) return [];

    try {
      const clientId = await this.getClientId();
      const url = `https://api-v2.soundcloud.com/tracks/${encodeURIComponent(trackId)}/related?client_id=${clientId}&limit=${limit}`;
      const response = await this.fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        console.warn(`[SoundCloudService] Related tracks returned HTTP ${response.status}`);
        return [];
      }

      const data = await response.json();
      return this.parseTracksResponse(data, limit).filter(t => t.originalId !== String(trackId));
    } catch (err) {
      console.warn(`[SoundCloudService] Related tracks failed for ${trackId}:`, err);
      return [];
    }
  }

  /**
   * True when an HLS manifest can actually be played here. hls.js is imported
   * lazily so jsdom test runs never need it.
   */
  public async isHlsPlaybackSupported(): Promise<boolean> {
    if (typeof this.hlsSupportedOverride === 'boolean') return this.hlsSupportedOverride;

    try {
      const { isHlsSupported } = await import('./hls');
      return await isHlsSupported();
    } catch (err) {
      console.warn('[SoundCloudService] Could not determine HLS support:', err);
      return false;
    }
  }

  /**
   * Resolves a playable audio stream for a SoundCloud track. Progressive MP3 is
   * preferred; an HLS-only track is returned with format 'hls' so the audio
   * engine can attach it through services/hls.ts, and rejected outright when
   * HLS cannot be played at all.
   *
   * Every playable transcoding is tried in preference order, not just the best
   * one: SoundCloud regularly serves a 404 for one variant of a track whose
   * other variants work, so giving up after the first failure made playable
   * tracks look dead.
   */
  public async resolveStreamUrl(
    trackId: string,
    transcodings?: any[],
    trackAuthorization?: string
  ): Promise<SoundCloudStreamResult> {
    if (!trackId) {
      throw new Error('Missing SoundCloud trackId');
    }

    /*
     * Ключ доступа обновляется на месте, как в поиске.
     *
     * Здесь этого не было, и получалась ложная беда: `client_id` протухает или
     * упирается в предел частоты, все дорожки отвечают 401 — а человеку
     * показывалось «SoundCloud отказался отдавать эту загрузку, обычно это
     * ограничение лейбла или региона». То есть приговор треку вместо «ключ
     * устарел, сейчас возьмём новый». Отсюда «часть музыки с SoundCloud иногда
     * не грузится»: через час-другой ключ обновлялся сам по сроку, и та же
     * песня играла.
     */
    let lastError: Error | null = null;
    let discoveryTried = false;
    const tried = new Set<string>();

    for (let round = 0; round < MAX_CLIENT_IDS; round++) {
      let clientId: string;
      try {
        clientId = await this.getClientId();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        break;
      }
      if (tried.has(clientId)) {
        const spare = this.clientIds.find((id) => !tried.has(id));
        if (!spare) {
          if (discoveryTried) break;
          discoveryTried = true;
          const fresh = await this.discoverFreshClientId();
          if (!fresh || tried.has(fresh)) break;
          clientId = fresh;
        } else {
          clientId = spare;
        }
      }
      tried.add(clientId);

      try {
        const resolved = await this.resolveWithClientId(trackId, clientId, transcodings, trackAuthorization);
        // Ключ доказал, что он рабочий: запоминаем именно его.
        this.noteClientIdWorked(clientId);
        this.setClientId(clientId);
        return resolved;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!(err instanceof SoundCloudAuthError)) throw lastError;
        console.warn('[SoundCloudService] Ключ доступа не принят, пробую следующий...');
      }
    }

    throw lastError ?? new Error(`SoundCloud track ${trackId}: не удалось получить поток`);
  }

  /**
   * Одна попытка получить поток заданным ключом.
   *
   * Ключ передаётся аргументом, а не берётся из общего состояния, и это
   * главное здесь. Первая версия перебора звала `rotateClientId`, то есть
   * помечала ключ негодным и переводила на него **всё приложение** — а 401 на
   * конкретной загрузке говорит о загрузке, а не о ключе: так SoundCloud
   * отвечает и на закрытые лейблом записи. Из четырёх вшитых ключей живым был
   * один, поэтому один перекрытый трек ронял заодно и поиск на шесть часов.
   * Здесь перебор локальный: общее состояние меняется только при успехе.
   */
  private async resolveWithClientId(
    trackId: string,
    clientId: string,
    transcodings?: any[],
    trackAuthorization?: string
  ): Promise<SoundCloudStreamResult> {
    let mediaTranscodings = transcodings;
    let authorization = trackAuthorization;

    // If transcodings not provided, fetch track metadata first
    if (!mediaTranscodings || mediaTranscodings.length === 0) {
      const trackRes = await this.fetchWithTimeout(
        `https://api-v2.soundcloud.com/tracks/${encodeURIComponent(trackId)}?client_id=${clientId}`
      );
      if (trackRes.status === 401 || trackRes.status === 403) {
        throw new SoundCloudAuthError(
          `SoundCloud track metadata for ${trackId}: HTTP ${trackRes.status}`
        );
      }
      if (!trackRes.ok) {
        throw new Error(
          `Failed to fetch SoundCloud track metadata for ${trackId}: HTTP ${trackRes.status}`
        );
      }
      const trackData = await trackRes.json();
      mediaTranscodings = trackData?.media?.transcodings || [];
      authorization = authorization || trackData?.track_authorization;
    }

    if (!mediaTranscodings || mediaTranscodings.length === 0) {
      throw new Error(`No transcodings found for SoundCloud track ${trackId}`);
    }

    const candidates = rankTranscodings(mediaTranscodings);
    if (candidates.length === 0) {
      // Label uploads are often published as encrypted HLS only. Naming that is
      // far more useful than "no valid transcoding", because no retry will help.
      const protocols = [
        ...new Set(mediaTranscodings.map((t: any) => t?.format?.protocol).filter(Boolean))
      ];
      const drmOnly = protocols.every((p) => String(p).includes('encrypted'));
      throw new Error(
        drmOnly
          ? `SoundCloud track ${trackId} is only offered as DRM-protected audio (${protocols.join(', ')}), which cannot be played here`
          : `No valid stream transcoding available for SoundCloud track ${trackId} (offered: ${protocols.join(', ') || 'none'})`
      );
    }

    const hlsPlayable = await this.isHlsPlaybackSupported();
    const attempts: string[] = [];
    let sawHlsWeCannotPlay = false;
    /** Хоть одна дорожка ответила «ключ не тот» — значит дело в ключе, а не в треке. */
    let sawUnauthorized = false;

    for (const chosen of candidates) {
      const isHls = chosen.format?.protocol === 'hls';
      const label = `${chosen.format?.protocol}/${chosen.preset || chosen.quality || 'unknown'}`;

      // Skip rather than fail: a later candidate may be progressive.
      if (isHls && !hlsPlayable) {
        sawHlsWeCannotPlay = true;
        attempts.push(`${label}: HLS is not playable in this environment`);
        continue;
      }

      try {
        const authParam = authorization
          ? `&track_authorization=${encodeURIComponent(authorization)}`
          : '';
        const streamRes = await this.fetchWithTimeout(`${chosen.url}?client_id=${clientId}${authParam}`);
        if (streamRes.status === 401 || streamRes.status === 403) {
          sawUnauthorized = true;
          attempts.push(`${label}: HTTP ${streamRes.status}`);
          continue;
        }
        if (!streamRes.ok) {
          attempts.push(`${label}: HTTP ${streamRes.status}`);
          continue;
        }

        const streamData = await streamRes.json();
        if (!streamData?.url) {
          attempts.push(`${label}: response carried no stream URL`);
          continue;
        }

        const streamUrl: string = streamData.url;
        const looksLikeManifest = /\.m3u8?(\?|$)/i.test(streamUrl);

        // A progressive transcoding that hands back a manifest anyway still
        // needs hls.js; without it this URL would fail silently mid-playback.
        if (looksLikeManifest && !hlsPlayable) {
          sawHlsWeCannotPlay = true;
          attempts.push(`${label}: resolved to a manifest and HLS is not playable here`);
          continue;
        }

        return {
          streamUrl,
          format: isHls || looksLikeManifest ? 'hls' : 'mp3',
          bitrate: 128,
          expiresAt: getSoundCloudStreamExpiry(streamUrl),
          isPreview: chosen.snipped === true
        };
      } catch (err) {
        attempts.push(`${label}: ${(err as Error).message}`);
      }
    }

    const detail = `track ${trackId}: no transcoding produced a playable URL (${attempts.join('; ')})`;
    // Ключ важнее всего остального: с новым ключом те же дорожки, скорее всего,
    // отдадутся, и объявлять трек недоступным рано.
    if (sawUnauthorized) throw new SoundCloudAuthError(`SoundCloud ${detail}`);
    // The HLS prefix is what the UI keys on to explain the difference between
    // "this build cannot play HLS" and "SoundCloud refused the stream".
    throw new Error(sawHlsWeCannotPlay ? `${HLS_UNAVAILABLE}: ${detail}` : `SoundCloud ${detail}`);
  }
}

export const soundCloudService = new SoundCloudService();
