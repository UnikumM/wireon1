/**
 * 1-Click Multi-Platform Playlist Importer Service
 *
 * Supports importing playlists and albums from:
 * - Spotify (open.spotify.com/playlist/{id}, open.spotify.com/album/{id}, spotify.link)
 * - Yandex Music (music.yandex.ru/users/{user}/playlists/{id}, music.yandex.ru/album/{id})
 * - VK Music (vk.com/music/playlist/{owner}_{id}, vk.com/audio?z=audio_playlist{owner}_{id})
 * - Apple Music (music.apple.com/{region}/playlist/{name}/{id}, music.apple.com/{region}/album/{name}/{id})
 *
 * Implements client-side HTML/JSON parsing, Schema.org metadata extraction,
 * parallel batch resolution (batch size 4–6) against YouTube Music & SoundCloud,
 * and direct persistence to Dexie IndexedDB custom playlists.
 */

import { UnifiedTrack } from '../types/music';
import { searchAggregator } from './aggregator';
import * as dbService from './db';
import { useLibraryStore } from '../store/useLibraryStore';
import { UNKNOWN_ARTIST, UNKNOWN_TITLE } from '../utils/placeholders';
import { pickBestMatch, rankCandidates, type MatchConfidence } from './trackMatching';

export type PlatformType = 'spotify' | 'yandex' | 'vk' | 'apple';

export interface ParsedPlaylistItem {
  title: string;
  artist: string;
  duration?: number; // duration in seconds
  album?: string;
  artworkUrl?: string;
}

export interface ParsedPlaylist {
  title: string;
  platform: PlatformType;
  items: ParsedPlaylistItem[];
  description?: string;
  coverUrl?: string;
}

export interface ImportResult {
  title: string;
  platform: PlatformType;
  tracks: Array<{ query: string; title: string; artist: string; duration?: number }>;
  resolvedTracks: UnifiedTrack[];
  /** Отчёт по каждой строке исходного плейлиста, в исходном порядке. */
  matches: ImportMatch[];
  /** Строки, которым уверенной пары не нашлось — их показывает экран переноса. */
  unmatched: ImportMatch[];
  playlistId: string;
}

export type ImportProgressCallback = (
  resolvedCount: number,
  totalCount: number,
  currentTrackTitle?: string
) => void;

/**
 * Что получилось из одной строки чужого плейлиста.
 *
 * Раньше перенос возвращал только массив найденных треков, поэтому «нашли 34 из
 * 50» превращалось в молчаливый плейлист на 34 трека: какие шестнадцать потеряли
 * — не знал никто. Теперь на каждую строку есть запись: что искали, что нашли,
 * насколько уверенно и какие ещё были варианты (их показывает ручной выбор).
 */
export interface ImportMatch {
  item: ParsedPlaylistItem;
  /** null — уверенного совпадения не нашлось, трек в плейлист не попадёт. */
  track: UnifiedTrack | null;
  score: number;
  confidence: MatchConfidence | null;
  /** Почему именно так — из `trackMatching`, показываем в отчёте. */
  notes: string[];
  /** Остальные кандидаты, лучший первым, для ручного выбора. */
  alternatives: UnifiedTrack[];
}

/**
 * Ниже этого счёта совпадение считается ненадёжным и трек уходит в «не нашли».
 * Лучше показать список из шести строк, чем подсунуть шесть чужих записей:
 * именно из-за автоматических «почти совпадений» переносы и выходили кривыми.
 */
const MIN_IMPORT_MATCH_SCORE = 62;

/**
 * Utility: unescapes standard HTML entities from scraped text or JSON snippets
 */
function unescapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .trim();
}

/**
 * Utility: parses ISO-8601 duration strings (e.g. "PT3M45S", "PT210S", "PT1H2M3S") to seconds
 */
export function parseIsoDuration(durationStr: string): number {
  if (!durationStr || typeof durationStr !== 'string') return 0;
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/i.exec(durationStr);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseFloat(match[3] || '0');
  return hours * 3600 + minutes * 60 + Math.round(seconds);
}

/**
 * Utility: parses "MM:SS" or "HH:MM:SS" time strings to seconds
 */
export function parseTimeString(timeStr: string): number {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => isNaN(p))) return 0;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

export class PlaylistImporterService {
  /**
   * Identifies platform from URL string
   */
  public detectPlatform(url: string): PlatformType | null {
    if (!url || typeof url !== 'string') return null;
    const clean = url.trim().toLowerCase();

    if (
      clean.includes('spotify.com/playlist') ||
      clean.includes('spotify.com/album') ||
      clean.includes('spotify.com/track') ||
      clean.includes('spotify.link') ||
      clean.startsWith('spotify:')
    ) {
      return 'spotify';
    }

    if (
      clean.includes('music.yandex.ru') ||
      clean.includes('music.yandex.com') ||
      clean.includes('music.yandex.kz') ||
      clean.includes('music.yandex.by')
    ) {
      return 'yandex';
    }

    if (
      clean.includes('vk.com/music/playlist') ||
      clean.includes('vk.com/audio') ||
      clean.includes('vk.com/audios') ||
      clean.includes('vk.ru/audio') ||
      clean.includes('vk.ru/music')
    ) {
      return 'vk';
    }

    if (
      clean.includes('music.apple.com') &&
      (clean.includes('/playlist/') || clean.includes('/album/'))
    ) {
      return 'apple';
    }

    return null;
  }

  /**
   * Fetches and parses playlist metadata and track listings from the platform URL.
   */
  public async parsePlaylistUrl(url: string): Promise<ParsedPlaylist> {
    const platform = this.detectPlatform(url);
    if (!platform) {
      throw new Error('Ссылка не подходит. Работают Spotify, Яндекс Музыка, VK Музыка и Apple Music.');
    }

    const trimmedUrl = url.trim();

    // For Spotify, transform web URL to embed URL to guarantee clean structured data
    let fetchUrl = trimmedUrl;
    if (platform === 'spotify') {
      const spotMatch = /(?:spotify\.com\/(?:intl-[a-z]+\/)?|spotify:)(playlist|album|track)[/:]([a-zA-Z0-9]+)/i.exec(trimmedUrl);
      if (spotMatch) {
        fetchUrl = `https://open.spotify.com/embed/${spotMatch[1]}/${spotMatch[2]}`;
      }
    }

    // Fetch webpage or API handler
    let res: Response;
    try {
      res = await fetch(fetchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8'
        }
      });
    } catch (err: any) {
      // If embed fetch failed and was transformed, fallback to original URL
      if (fetchUrl !== trimmedUrl) {
        try {
          res = await fetch(trimmedUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
          });
        } catch {
          throw new Error(`Не удалось открыть страницу плейлиста: ${err?.message || 'нет связи'}`);
        }
      } else {
        throw new Error(`Не удалось открыть страницу плейлиста: ${err?.message || 'нет связи'}`);
      }
    }

    if (!res.ok && fetchUrl !== trimmedUrl) {
      // Try original URL as fallback
      try {
        res = await fetch(trimmedUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
          }
        });
      } catch {}
    }

    if (!res.ok) {
      // Текст ошибки уходит прямо в баннер модального окна, поэтому он на
      // русском; код ответа оставляем — с ним понятнее, чья это беда.
      throw new Error(`Страница плейлиста не открылась (HTTP ${res.status})${res.statusText ? `: ${res.statusText}` : ''}`);
    }

    // Check if the response is JSON (e.g. API handler or test fixture)
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      return this.parseJsonResponse(data, platform, trimmedUrl);
    }

    const html = await res.text();

    // In case the response text is actually valid JSON despite content-type
    if (html.trim().startsWith('{') && html.trim().endsWith('}')) {
      try {
        const data = JSON.parse(html);
        if (data.items || data.tracks || data.title || data.playlist) {
          return this.parseJsonResponse(data, platform, trimmedUrl);
        }
      } catch {
        // Fall back to HTML parser
      }
    }

    switch (platform) {
      case 'spotify':
        return this.parseSpotifyHtml(html, trimmedUrl);
      case 'yandex':
        return this.parseYandexHtml(html, trimmedUrl);
      case 'vk':
        return this.parseVkHtml(html, trimmedUrl);
      case 'apple':
        return this.parseAppleHtml(html, trimmedUrl);
      default:
        throw new Error('Эта платформа пока не поддерживается');
    }
  }

  /**
   * Resolves raw JSON response objects (used by API handlers and test mocks)
   */
  private parseJsonResponse(data: any, platform: PlatformType, _url: string): ParsedPlaylist {
    let title = data.title || data.name || 'Перенесённый плейлист';
    let items: ParsedPlaylistItem[] = [];
    let description = data.description;
    let coverUrl = data.coverUrl || data.image || data.artworkUrl;

    if (Array.isArray(data.items)) {
      items = data.items.map((it: any) => ({
        title: it.title || it.name || UNKNOWN_TITLE,
        artist: it.artist || (Array.isArray(it.artists) ? it.artists.map((a: any) => (typeof a === 'string' ? a : a.name)).join(', ') : UNKNOWN_ARTIST),
        duration: typeof it.duration === 'number' ? it.duration : typeof it.duration_ms === 'number' ? Math.round(it.duration_ms / 1000) : undefined,
        album: it.album,
        artworkUrl: it.artworkUrl || it.coverUrl
      }));
    } else if (Array.isArray(data.tracks)) {
      items = data.tracks.map((it: any) => ({
        title: it.title || it.name || UNKNOWN_TITLE,
        artist: it.artist || (Array.isArray(it.artists) ? it.artists.map((a: any) => (typeof a === 'string' ? a : a.name)).join(', ') : UNKNOWN_ARTIST),
        duration: typeof it.duration === 'number' ? it.duration : typeof it.durationMs === 'number' ? Math.round(it.durationMs / 1000) : typeof it.duration_ms === 'number' ? Math.round(it.duration_ms / 1000) : undefined,
        album: it.album?.title || it.album,
        artworkUrl: it.coverUri ? `https://${it.coverUri.replace('%%', '400x400')}` : it.artworkUrl
      }));
    } else if (data.playlist) {
      title = data.playlist.title || data.playlist.name || title;
      description = data.playlist.description || description;
      if (Array.isArray(data.playlist.tracks)) {
        items = data.playlist.tracks.map((it: any) => ({
          title: it.title || it.name || UNKNOWN_TITLE,
          artist: it.artist || (Array.isArray(it.artists) ? it.artists.map((a: any) => (typeof a === 'string' ? a : a.name)).join(', ') : UNKNOWN_ARTIST),
          duration: typeof it.duration === 'number' ? it.duration : typeof it.durationMs === 'number' ? Math.round(it.durationMs / 1000) : undefined,
          album: it.album?.title || it.album
        }));
      }
    }

    return {
      title: unescapeHtml(title),
      platform,
      items,
      description: description ? unescapeHtml(description) : undefined,
      coverUrl
    };
  }

  /**
   * Parser: Spotify HTML (handles __NEXT_DATA__, initial-state, Schema.org LD+JSON, og:tags)
   */
  private parseSpotifyHtml(html: string, _url: string): ParsedPlaylist {
    let title = 'Плейлист Spotify';
    let description: string | undefined;
    let coverUrl: string | undefined;
    const items: ParsedPlaylistItem[] = [];

    // Extract title from og:title or <title>
    const ogTitleMatch = /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i.exec(html) ||
      /<title>([^<]+)<\/title>/i.exec(html);
    if (ogTitleMatch) {
      title = unescapeHtml(ogTitleMatch[1]).replace(/\s*\|\s*Spotify$/i, '').trim();
    }

    const ogDescMatch = /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i.exec(html);
    if (ogDescMatch) {
      description = unescapeHtml(ogDescMatch[1]);
    }

    const ogImageMatch = /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i.exec(html);
    if (ogImageMatch) {
      coverUrl = ogImageMatch[1];
    }

    // Try 1: __NEXT_DATA__
    const nextDataMatch = /<script\s+id=["']__NEXT_DATA__["']\s+type=["']application\/json["']>([^<]+)<\/script>/i.exec(html);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const entity =
          nextData.props?.pageProps?.state?.data?.entity ||
          nextData.props?.pageProps?.album ||
          nextData.props?.pageProps?.playlist ||
          nextData.props?.pageProps?.trackList;

        if (entity) {
          if (entity.name) title = entity.name;
          if (entity.description) description = entity.description;

          const trackList =
            entity.trackList ||
            entity.tracks?.items ||
            entity.trackRows ||
            entity.tracks ||
            [];

          if (Array.isArray(trackList)) {
            for (const item of trackList) {
              const tr = item.track || item;
              const trackTitle = tr.name || tr.title;
              if (trackTitle) {
                const artistName = Array.isArray(tr.artists)
                  ? tr.artists.map((a: any) => a.name || a).join(', ')
                  : tr.artist || tr.artists || UNKNOWN_ARTIST;
                const duration = tr.duration_ms
                  ? Math.round(tr.duration_ms / 1000)
                  : tr.duration
                  ? Math.round(tr.duration / 1000)
                  : undefined;
                items.push({
                  title: unescapeHtml(trackTitle),
                  artist: unescapeHtml(artistName),
                  duration
                });
              }
            }
          }
        }
      } catch (err) {
        console.warn('[PlaylistImporter] Spotify __NEXT_DATA__ parse warning:', err);
      }
    }

    // Try 2: Schema.org / JSON-LD
    if (items.length === 0) {
      const ldJsonRegex = /<script\s+type=["']application\/ld\+json["']>([^<]+)<\/script>/gi;
      let ldMatch: RegExpExecArray | null;
      while ((ldMatch = ldJsonRegex.exec(html)) !== null) {
        try {
          const ldData = JSON.parse(ldMatch[1]);
          const dataList = Array.isArray(ldData) ? ldData : [ldData];
          for (const item of dataList) {
            if (item['@type'] === 'MusicPlaylist' || item['@type'] === 'MusicAlbum') {
              if (item.name) title = item.name;
              if (item.numTracks && Array.isArray(item.track)) {
                for (const t of item.track) {
                  const tTitle = t.name;
                  const tArtist = Array.isArray(t.byArtist)
                    ? t.byArtist.map((a: any) => a.name).join(', ')
                    : t.byArtist?.name || t.byArtist || UNKNOWN_ARTIST;
                  const duration = t.duration ? parseIsoDuration(t.duration) : undefined;
                  if (tTitle) {
                    items.push({
                      title: unescapeHtml(tTitle),
                      artist: unescapeHtml(tArtist),
                      duration
                    });
                  }
                }
              }
            }
          }
        } catch {
          // Continue
        }
      }
    }

    // Try 3: Regex track extraction from HTML structure
    if (items.length === 0) {
      const trackRowRegex = /class=["'][^"']*track-name[^"']*["'][^>]*>([^<]+)<\/span>[\s\S]*?class=["'][^"']*artist-name[^"']*["'][^>]*>([^<]+)<\//gi;
      let trMatch: RegExpExecArray | null;
      while ((trMatch = trackRowRegex.exec(html)) !== null) {
        const tTitle = unescapeHtml(trMatch[1]).trim();
        const tArtist = unescapeHtml(trMatch[2]).trim();
        if (tTitle && !tTitle.startsWith('http') && !tTitle.startsWith('/')) {
          items.push({
            title: tTitle,
            artist: tArtist || UNKNOWN_ARTIST
          });
        }
      }
    }

    // Filter out any accidentally extracted URLs or blank titles
    const cleanItems = items.filter(
      (it) => it.title && !it.title.startsWith('http://') && !it.title.startsWith('https://') && !it.title.startsWith('spotify:')
    );

    return {
      title: unescapeHtml(title),
      platform: 'spotify',
      items: cleanItems,
      description,
      coverUrl
    };
  }

  /**
   * Parser: Yandex Music HTML (handles window.__DATA__, ld+json, og:tags, tracklist markup)
   */
  private parseYandexHtml(html: string, _url: string): ParsedPlaylist {
    let title = 'Плейлист Яндекс Музыки';
    let description: string | undefined;
    let coverUrl: string | undefined;
    const items: ParsedPlaylistItem[] = [];

    const ogTitleMatch = /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i.exec(html) ||
      /<title>([^<]+)<\/title>/i.exec(html);
    if (ogTitleMatch) {
      title = unescapeHtml(ogTitleMatch[1]).replace(/\s*—\s*Яндекс Музыка$/i, '').trim();
    }

    const ogDescMatch = /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i.exec(html);
    if (ogDescMatch) description = unescapeHtml(ogDescMatch[1]);

    const ogImageMatch = /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i.exec(html);
    if (ogImageMatch) coverUrl = ogImageMatch[1];

    // Try 1: Parse window.__DATA__ / window.__PRELOADED_STATE__
    const stateMatch = /window\.__DATA__\s*=\s*({[\s\S]+?});/i.exec(html) ||
      /window\.__PRELOADED_STATE__\s*=\s*({[\s\S]+?});/i.exec(html) ||
      /<script\s+id=["']store["'][^>]*>([\s\S]+?)<\/script>/i.exec(html);

    if (stateMatch) {
      try {
        const state = JSON.parse(stateMatch[1]);
        const playlistObj = state.playlist || state.album || state.pageData?.playlist || state.pageData?.album;
        if (playlistObj) {
          if (playlistObj.title) title = playlistObj.title;
          const tracks = playlistObj.tracks || [];
          for (const t of tracks) {
            const trackObj = t.track || t;
            if (trackObj.title) {
              const artistStr = Array.isArray(trackObj.artists)
                ? trackObj.artists.map((a: any) => a.name).join(', ')
                : trackObj.artist || UNKNOWN_ARTIST;
              const duration = trackObj.durationMs
                ? Math.round(trackObj.durationMs / 1000)
                : trackObj.duration
                ? Math.round(trackObj.duration / 1000)
                : undefined;
              items.push({
                title: unescapeHtml(trackObj.title),
                artist: unescapeHtml(artistStr),
                duration
              });
            }
          }
        }
      } catch (err) {
        console.warn('[PlaylistImporter] Yandex preloaded state parse warning:', err);
      }
    }

    // Try 2: JSON-LD Schema
    if (items.length === 0) {
      const ldRegex = /<script\s+type=["']application\/ld\+json["']>([^<]+)<\/script>/gi;
      let match: RegExpExecArray | null;
      while ((match = ldRegex.exec(html)) !== null) {
        try {
          const ld = JSON.parse(match[1]);
          if (ld['@type'] === 'MusicPlaylist' || ld['@type'] === 'MusicAlbum') {
            if (ld.name) title = ld.name;
            const tracks = ld.track || ld.itemListElement || [];
            for (const t of tracks) {
              const tr = t.item || t;
              if (tr.name) {
                const artistName = tr.byArtist?.name || (Array.isArray(tr.byArtist) ? tr.byArtist.map((a: any) => a.name).join(', ') : UNKNOWN_ARTIST);
                const duration = tr.duration ? parseIsoDuration(tr.duration) : undefined;
                items.push({
                  title: unescapeHtml(tr.name),
                  artist: unescapeHtml(artistName),
                  duration
                });
              }
            }
          }
        } catch {
          // Continue
        }
      }
    }

    // Try 3: Scrape HTML .d-track elements
    if (items.length === 0) {
      const trackRowRegex = /class=["'][^"']*d-track__name[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>[\s\S]*?class=["'][^"']*d-track__artists[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
      let trMatch: RegExpExecArray | null;
      while ((trMatch = trackRowRegex.exec(html)) !== null) {
        const trackTitle = trMatch[1].trim();
        const artistBlock = trMatch[2];
        const artistNames: string[] = [];
        const artistRegex = /<a[^>]*>([^<]+)<\/a>/gi;
        let artMatch: RegExpExecArray | null;
        while ((artMatch = artistRegex.exec(artistBlock)) !== null) {
          artistNames.push(artMatch[1].trim());
        }
        items.push({
          title: unescapeHtml(trackTitle),
          artist: artistNames.length > 0 ? unescapeHtml(artistNames.join(', ')) : UNKNOWN_ARTIST
        });
      }
    }

    return {
      title: unescapeHtml(title),
      platform: 'yandex',
      items,
      description,
      coverUrl
    };
  }

  /**
   * Parser: VK Music HTML (handles data-audio JSON attributes, audio_row classes, og:tags)
   */
  private parseVkHtml(html: string, _url: string): ParsedPlaylist {
    let title = 'Плейлист VK Музыки';
    let description: string | undefined;
    let coverUrl: string | undefined;
    const items: ParsedPlaylistItem[] = [];

    const ogTitleMatch = /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i.exec(html) ||
      /<title>([^<]+)<\/title>/i.exec(html);
    if (ogTitleMatch) {
      title = unescapeHtml(ogTitleMatch[1]).replace(/\s*\|\s*ВКонтакте$/i, '').trim();
    }

    const ogDescMatch = /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i.exec(html);
    if (ogDescMatch) description = unescapeHtml(ogDescMatch[1]);

    const ogImageMatch = /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i.exec(html);
    if (ogImageMatch) coverUrl = ogImageMatch[1];

    // Try 1: data-audio attribute parser (VK standard: data-audio='[id, owner_id, "url", "title", "artist", duration, ...]')
    const dataAudioRegex = /data-audio=(?:"(\[[^"]+\]|\{[^"]+\})"|'(\[[^']+\]|\{[^']+\})')/gi;
    let daMatch: RegExpExecArray | null;
    while ((daMatch = dataAudioRegex.exec(html)) !== null) {
      try {
        const rawJson = unescapeHtml(daMatch[1] || daMatch[2]);
        const parsed = JSON.parse(rawJson);
        if (Array.isArray(parsed) && parsed.length >= 5) {
          // Format: [id, owner, url, title, artist, duration, ...]
          const trackTitle = typeof parsed[3] === 'string' ? parsed[3] : '';
          const artistName = typeof parsed[4] === 'string' ? parsed[4] : '';
          const duration = typeof parsed[5] === 'number' ? parsed[5] : undefined;
          if (trackTitle) {
            items.push({
              title: unescapeHtml(trackTitle),
              artist: unescapeHtml(artistName || 'VK Artist'),
              duration
            });
          }
        } else if (typeof parsed === 'object' && parsed.title) {
          items.push({
            title: unescapeHtml(parsed.title),
            artist: unescapeHtml(parsed.artist || parsed.performer || 'VK Artist'),
            duration: typeof parsed.duration === 'number' ? parsed.duration : undefined
          });
        }
      } catch {
        // Skip malformed data-audio tag
      }
    }

    // Try 2: Scrape .audio_row markup if data-audio was not matched
    if (items.length === 0) {
      const audioRowRegex = /class=["'][^"']*audio_row__title_inner[^"']*["'][^>]*>([^<]+)<\/[\s\S]*?class=["'][^"']*audio_row__performers?[^"']*["'][^>]*>([\s\S]*?)<\//gi;
      let arMatch: RegExpExecArray | null;
      while ((arMatch = audioRowRegex.exec(html)) !== null) {
        const trackTitle = arMatch[1].trim();
        const artistRaw = arMatch[2].replace(/<[^>]+>/g, '').trim();
        if (trackTitle) {
          items.push({
            title: unescapeHtml(trackTitle),
            artist: unescapeHtml(artistRaw || 'VK Artist')
          });
        }
      }
    }

    return {
      title: unescapeHtml(title),
      platform: 'vk',
      items,
      description,
      coverUrl
    };
  }

  /**
   * Parser: Apple Music HTML (handles Schema.org LD+JSON MusicPlaylist, og:tags, songs-list markup)
   */
  private parseAppleHtml(html: string, _url: string): ParsedPlaylist {
    let title = 'Плейлист Apple Music';
    let description: string | undefined;
    let coverUrl: string | undefined;
    const items: ParsedPlaylistItem[] = [];

    const ogTitleMatch = /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i.exec(html) ||
      /<title>([^<]+)<\/title>/i.exec(html);
    if (ogTitleMatch) {
      title = unescapeHtml(ogTitleMatch[1]).replace(/\s*на\s*Apple\s*Music$/i, '').replace(/\s*on\s*Apple\s*Music$/i, '').trim();
    }

    const ogDescMatch = /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i.exec(html);
    if (ogDescMatch) description = unescapeHtml(ogDescMatch[1]);

    const ogImageMatch = /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i.exec(html);
    if (ogImageMatch) coverUrl = ogImageMatch[1];

    // Try 1: Schema.org JSON-LD
    const ldRegex = /<script\s+type=["']application\/ld\+json["']>([^<]+)<\/script>/gi;
    let ldMatch: RegExpExecArray | null;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        const entries = Array.isArray(ld) ? ld : ld['@graph'] ? ld['@graph'] : [ld];
        for (const entry of entries) {
          if (
            entry['@type'] === 'MusicPlaylist' ||
            entry['@type'] === 'MusicAlbum' ||
            entry['@type'] === 'MusicRelease'
          ) {
            if (entry.name) title = entry.name;
            const tracks = entry.track || entry.itemListElement || [];
            for (const t of tracks) {
              const tr = t.item || t;
              if (tr.name) {
                const artistName = Array.isArray(tr.byArtist)
                  ? tr.byArtist.map((a: any) => a.name || a).join(', ')
                  : tr.byArtist?.name || tr.byArtist || UNKNOWN_ARTIST;
                const duration = tr.duration ? parseIsoDuration(tr.duration) : undefined;
                items.push({
                  title: unescapeHtml(tr.name),
                  artist: unescapeHtml(artistName),
                  duration
                });
              }
            }
          }
        }
      } catch {
        // Continue
      }
    }

    // Try 2: HTML markup scraping (.songs-list-row__song-name, .songs-list-row__by-line)
    if (items.length === 0) {
      const songRowRegex = /class=["'][^"']*songs-list-row__song-name[^"']*["'][^>]*>([^<]+)<\/[\s\S]*?class=["'][^"']*songs-list-row__by-line[^"']*["'][^>]*>([\s\S]*?)<\//gi;
      let srMatch: RegExpExecArray | null;
      while ((srMatch = songRowRegex.exec(html)) !== null) {
        const trackTitle = srMatch[1].trim();
        const artistRaw = srMatch[2].replace(/<[^>]+>/g, '').trim();
        if (trackTitle) {
          items.push({
            title: unescapeHtml(trackTitle),
            artist: unescapeHtml(artistRaw || 'Apple Music Artist')
          });
        }
      }
    }

    return {
      title: unescapeHtml(title),
      platform: 'apple',
      items,
      description,
      coverUrl
    };
  }

  /**
   * Ищет каждой строке чужого плейлиста играбельную пару.
   *
   * Раньше здесь брался первый результат поиска (с поправкой на длительность), и
   * именно поэтому перенос выдавал ускоренные эдиты, часовые миксы и караоке:
   * YouTube сортирует по популярности, а самая популярная загрузка — часто не та
   * песня. Теперь кандидаты оцениваются в `trackMatching`, и если лучший из них
   * не дотянул до порога, строка честно уходит в «не нашли» вместо подмены.
   *
   * Запросы идут батчами: последовательно — это минуты ожидания на пятидесяти
   * треках, все сразу — источники начинают отвечать 429.
   */
  public async matchImportedTracks(
    items: ParsedPlaylistItem[],
    onProgress?: ImportProgressCallback,
    batchSize = 5
  ): Promise<ImportMatch[]> {
    if (!items || items.length === 0) {
      return [];
    }

    const total = items.length;
    const matches: Array<ImportMatch | null> = new Array(total).fill(null);
    let completedCount = 0;

    const emptyMatch = (item: ParsedPlaylistItem, notes: string[]): ImportMatch => ({
      item,
      track: null,
      score: 0,
      confidence: null,
      notes,
      alternatives: []
    });

    const resolveSingleItem = async (item: ParsedPlaylistItem, index: number): Promise<void> => {
      const artist = (item.artist || '').trim();
      const title = (item.title || '').trim();

      // Ссылка вместо названия — обычно битая строка чужого экспорта, искать нечего.
      if (!title || /^(?:https?:\/\/|spotify:)/i.test(title)) {
        matches[index] = emptyMatch(item, ['в строке нет названия трека']);
      } else {
        try {
          const cleanArtist = artist.replace(/\s*(?:feat\.|ft\.).*$/i, '').trim();
          const cleanTitle = title
            .replace(/\s*[\(\[][^()\[\]]*(?:official|music\s*video|audio|video|lyrics|hd|4k)[^()\[\]]*[\)\]]/gi, '')
            .trim();
          const cleanQuery =
            cleanArtist && !cleanTitle.toLowerCase().includes(cleanArtist.toLowerCase())
              ? `${cleanArtist} ${cleanTitle}`
              : cleanTitle;

          // Берём с запасом: оценщику нужен выбор, иначе он оценивает то же
          // самое, что раньше просто бралось первым.
          const primary = await searchAggregator.search(cleanQuery, { source: 'all', limit: 8 });
          let candidates: UnifiedTrack[] = primary?.results ?? [];

          // Ничего не нашлось по «исполнитель + название» — пробуем одно название:
          // у чужих экспортов исполнитель часто написан иначе или отсутствует.
          if (candidates.length === 0 && cleanTitle && cleanQuery !== cleanTitle) {
            const fallback = await searchAggregator.search(cleanTitle, { source: 'all', limit: 6 });
            candidates = fallback?.results ?? [];
          }

          if (candidates.length === 0) {
            matches[index] = emptyMatch(item, ['источники ничего не вернули']);
          } else {
            const ranked = rankCandidates(
              { title: cleanTitle || title, artist: cleanArtist || undefined, album: item.album, duration: item.duration },
              candidates
            );
            const best = pickBestMatch(
              { title: cleanTitle || title, artist: cleanArtist || undefined, album: item.album, duration: item.duration },
              candidates,
              MIN_IMPORT_MATCH_SCORE
            );

            matches[index] = {
              item,
              track: best ? best.candidate : null,
              score: ranked[0]?.score ?? 0,
              confidence: best ? best.confidence : null,
              // Когда уверенного совпадения нет, полезнее знать, чем именно
              // не подошёл лучший кандидат.
              notes: best ? best.notes : ranked[0]?.notes ?? [],
              // Лучший уже выбран — в альтернативы идут остальные.
              alternatives: ranked
                .filter((entry) => entry.candidate.id !== best?.candidate.id)
                .slice(0, 5)
                .map((entry) => entry.candidate)
            };
          }
        } catch (err) {
          console.warn('[PlaylistImporter] Track search resolution error for:', title, err);
          matches[index] = emptyMatch(item, ['поиск завершился ошибкой']);
        }
      }

      completedCount++;

      if (onProgress) {
        try {
          onProgress(completedCount, total, item.title);
        } catch (cbErr) {
          console.warn('[PlaylistImporter] onProgress callback threw:', cbErr);
        }
      }
    };

    const effectiveBatchSize = Math.max(1, Math.min(10, batchSize));
    for (let i = 0; i < total; i += effectiveBatchSize) {
      const batchIndices: number[] = [];
      for (let j = i; j < Math.min(i + effectiveBatchSize, total); j++) {
        batchIndices.push(j);
      }
      await Promise.all(batchIndices.map((idx) => resolveSingleItem(items[idx], idx)));
    }

    return matches.map((entry, index) => entry ?? emptyMatch(items[index], ['строка не обработана']));
  }

  /**
   * Только найденное, в порядке исходного плейлиста.
   *
   * Тонкая обёртка над `matchImportedTracks` для тех мест, которым отчёт не
   * нужен, — сам перенос показывает и ненайденное.
   */
  public async resolveImportedTracks(
    items: ParsedPlaylistItem[],
    onProgress?: ImportProgressCallback,
    batchSize = 5
  ): Promise<UnifiedTrack[]> {
    const matches = await this.matchImportedTracks(items, onProgress, batchSize);
    return matches
      .map((match) => match.track)
      .filter((track): track is UnifiedTrack => track !== null);
  }

  /**
   * Direct Save to Custom Playlists (F5.3)
   *
   * Creates a new playlist in Dexie IndexedDB with resolved tracks,
   * updates the library store, and returns the playlist ID.
   */
  public async saveToLibrary(
    title: string,
    tracks: UnifiedTrack[],
    description = 'Перенесено импортом плейлистов Wireon Sounds'
  ): Promise<string> {
    const cleanTitle = (title || 'Перенесённый плейлист').trim();

    // Create playlist via useLibraryStore or dbService
    const created = await useLibraryStore.getState().createPlaylist(cleanTitle, description);
    if (!created) {
      // Fallback directly to dbService if store failed
      const dbCreated = await dbService.createPlaylist(cleanTitle, description);
      for (const track of tracks) {
        await dbService.addTrackToPlaylist(dbCreated.id, track);
      }
      await useLibraryStore.getState().loadInitialData();
      return dbCreated.id;
    }

    for (const track of tracks) {
      await useLibraryStore.getState().addTrackToPlaylist(created.id, track);
    }

    return created.id;
  }

  /**
   * All-in-one import pipeline
   */
  public async importPlaylist(
    url: string,
    onProgress?: ImportProgressCallback
  ): Promise<ImportResult> {
    const parsed = await this.parsePlaylistUrl(url);
    const matches = await this.matchImportedTracks(parsed.items, onProgress);
    const resolvedTracks = matches
      .map((match) => match.track)
      .filter((track): track is UnifiedTrack => track !== null);
    const playlistId = await this.saveToLibrary(parsed.title, resolvedTracks, parsed.description);

    return {
      title: parsed.title,
      platform: parsed.platform,
      tracks: parsed.items.map((it) => ({
        query: `${it.artist} - ${it.title}`,
        title: it.title,
        artist: it.artist,
        duration: it.duration
      })),
      resolvedTracks,
      matches,
      unmatched: matches.filter((match) => match.track === null),
      playlistId
    };
  }
}

export const playlistImporter = new PlaylistImporterService();

// Standalone helper exports for interface compliance
export const detectPlatform = (url: string) => playlistImporter.detectPlatform(url);
export const parsePlaylistUrl = (url: string) => playlistImporter.parsePlaylistUrl(url);
export const resolveImportedTracks = (
  items: ParsedPlaylistItem[],
  onProgress?: ImportProgressCallback,
  batchSize = 5
) => playlistImporter.resolveImportedTracks(items, onProgress, batchSize);
export const matchImportedTracks = (
  items: ParsedPlaylistItem[],
  onProgress?: ImportProgressCallback,
  batchSize = 5
) => playlistImporter.matchImportedTracks(items, onProgress, batchSize);
export const saveToLibrary = (title: string, tracks: UnifiedTrack[], description?: string) =>
  playlistImporter.saveToLibrary(title, tracks, description);
export const importPlaylist = (url: string, onProgress?: ImportProgressCallback) =>
  playlistImporter.importPlaylist(url, onProgress);
