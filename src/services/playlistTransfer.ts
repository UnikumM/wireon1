/**
 * Вынос и приём отдельного плейлиста.
 *
 * Выгрузка медиатеки (`backup.ts`) — про «перенести всё на другой компьютер».
 * Здесь другая задача: один плейлист, которым делятся или который открывают в
 * другом плеере. Раньше её не было вовсе, и «экспорт» сводился к копированию
 * ссылок руками — отсюда и жалоба, что плейлисты переносятся криво.
 *
 * Три формата, потому что у них разные читатели:
 * - `wireon` — наш JSON. Единственный формат, который переживает круг
 *   «выгрузил → загрузил» без потерь: в нём остаются id, источник и обложка,
 *   поэтому треки не нужно искать заново.
 * - `m3u8` — плейлист для внешних плееров (VLC, foobar). Ссылки на источник, а
 *   не на поток: потоковые ссылки живут часы, файл должен жить дольше.
 * - `csv` — для таблиц и для переноса в сервисы, которые умеют читать список
 *   «исполнитель, название».
 */

import type { Playlist, UnifiedTrack, AudioSource } from '../types/music';
import { formatDuration } from '../utils/time';
import { UNKNOWN_ARTIST, UNKNOWN_TITLE, UNTITLED_PLAYLIST } from '../utils/placeholders';
import type { ParsedPlaylistItem } from './playlistImporter';

export type ExportFormat = 'wireon' | 'm3u8' | 'csv';

export interface ExportedFile {
  filename: string;
  mimeType: string;
  content: string;
}

/** Версия нашего формата. Растёт, только если старые файлы перестанут читаться. */
export const PLAYLIST_EXPORT_VERSION = 1;

export interface WireonPlaylistFile {
  format: 'wireon-playlist';
  version: number;
  exportedAt: number;
  title: string;
  description?: string;
  trackCount: number;
  tracks: Array<{
    id: string;
    source: AudioSource;
    originalId: string;
    title: string;
    artist: string;
    album?: string;
    duration: number;
    artworkUrl?: string;
    sourceUrl?: string;
  }>;
}

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  // Имя продукта, а не расширения: сам файл по-прежнему `.wireon.json`, но в
  // меню человек выбирает «формат Wireon Sounds», и старое имя тут читалось бы
  // как чужой формат.
  wireon: 'Wireon Sounds (.json)',
  m3u8: 'Плейлист (.m3u8)',
  csv: 'Таблица (.csv)'
};

export const EXPORT_FORMAT_HINTS: Record<ExportFormat, string> = {
  wireon: 'Переносится в Wireon Sounds без потерь — треки не придётся искать заново.',
  m3u8: 'Откроется в VLC, foobar2000 и других плеерах.',
  csv: 'Для таблиц и переноса в другие сервисы.'
};

/** `Ночная дорога` → `nochnaya-doroga`, чтобы имя файла не зависело от файловой системы. */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya'
};

export function slugifyTitle(title: string): string {
  const lower = (title || '').trim().toLowerCase();
  let out = '';
  for (const char of lower) {
    out += TRANSLIT[char] ?? char;
  }
  const slug = out
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'playlist';
}

/** `2026-08-18`, без времени: имя файла и так уникально по названию плейлиста. */
function dateStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Ссылка на трек в источнике. Ставим её, а не `streamUrl`: у потока короткий
 * срок жизни, и файл с ним через час превращается в список битых ссылок.
 */
function sourceLink(track: UnifiedTrack): string {
  if (track.sourceUrl) return track.sourceUrl;
  if (track.source === 'youtube') return `https://www.youtube.com/watch?v=${track.originalId}`;
  if (track.source === 'soundcloud') return `https://api.soundcloud.com/tracks/${track.originalId}`;
  return '';
}

/** Кавычки и переводы строк ломают CSV — заворачиваем поле целиком. */
function csvCell(value: string | number | undefined): string {
  const text = value === undefined || value === null ? '' : String(value);
  if (/[",;\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toWireonJson(playlist: Playlist, exportedAt: number = Date.now()): string {
  const file: WireonPlaylistFile = {
    format: 'wireon-playlist',
    version: PLAYLIST_EXPORT_VERSION,
    exportedAt,
    title: playlist.title || UNTITLED_PLAYLIST,
    description: playlist.description,
    trackCount: playlist.tracks.length,
    tracks: playlist.tracks.map((track) => ({
      id: track.id,
      source: track.source,
      originalId: track.originalId,
      title: track.title || UNKNOWN_TITLE,
      artist: track.artist || UNKNOWN_ARTIST,
      album: track.album,
      duration: Math.max(0, Math.round(track.duration || 0)),
      artworkUrl: track.artworkUrl || undefined,
      sourceUrl: sourceLink(track) || undefined
    }))
  };
  return JSON.stringify(file, null, 2);
}

export function toM3U8(playlist: Playlist): string {
  const lines: string[] = ['#EXTM3U', `#PLAYLIST:${playlist.title || UNTITLED_PLAYLIST}`];
  for (const track of playlist.tracks) {
    const duration = Math.max(0, Math.round(track.duration || 0));
    const artist = track.artist || UNKNOWN_ARTIST;
    const title = track.title || UNKNOWN_TITLE;
    // -1 — «длительность неизвестна», так это читают внешние плееры.
    lines.push(`#EXTINF:${duration > 0 ? duration : -1},${artist} - ${title}`);
    const link = sourceLink(track);
    // Плеер, который не сможет открыть ссылку, хотя бы покажет строку в списке.
    lines.push(link || `# ${artist} - ${title}`);
  }
  // Завершающий перевод строки: без него последняя строка теряется у части плееров.
  return lines.join('\n') + '\n';
}

export function toCsv(playlist: Playlist): string {
  const header = ['Исполнитель', 'Название', 'Альбом', 'Длительность', 'Источник', 'Ссылка'];
  const rows = playlist.tracks.map((track) =>
    [
      csvCell(track.artist || UNKNOWN_ARTIST),
      csvCell(track.title || UNKNOWN_TITLE),
      csvCell(track.album),
      csvCell(formatDuration(Math.max(0, Math.round(track.duration || 0)))),
      csvCell(track.source === 'youtube' ? 'YouTube' : 'SoundCloud'),
      csvCell(sourceLink(track))
    ].join(',')
  );
  // BOM — иначе Excel читает кириллицу как «Ð˜Ñ Ð¿Ð¾Ð»Ð½Ð¸Ñ‚ÐµÐ»ÑŒ».
  return '﻿' + [header.join(','), ...rows].join('\r\n') + '\r\n';
}

export function exportPlaylist(
  playlist: Playlist,
  format: ExportFormat,
  exportedAt: number = Date.now()
): ExportedFile {
  const base = `${slugifyTitle(playlist.title)}-${dateStamp(exportedAt)}`;
  if (format === 'm3u8') {
    return {
      filename: `${base}.m3u8`,
      mimeType: 'audio/x-mpegurl;charset=utf-8',
      content: toM3U8(playlist)
    };
  }
  if (format === 'csv') {
    return {
      filename: `${base}.csv`,
      mimeType: 'text/csv;charset=utf-8',
      content: toCsv(playlist)
    };
  }
  return {
    filename: `${base}.wireon.json`,
    mimeType: 'application/json;charset=utf-8',
    content: toWireonJson(playlist, exportedAt)
  };
}

// -----------------------------------------------------------------------------
// Приём файла обратно
// -----------------------------------------------------------------------------

export class PlaylistFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaylistFileError';
  }
}

/** Плейлист из файла: либо готовые треки (наш формат), либо строки для поиска. */
export interface ParsedPlaylistFile {
  title: string;
  description?: string;
  /** Готовые к добавлению треки — только для формата `wireon`. */
  tracks: UnifiedTrack[];
  /** Строки, которые придётся искать в источниках. */
  items: ParsedPlaylistItem[];
  source: ExportFormat;
}

function isKnownSource(value: unknown): value is AudioSource {
  return value === 'youtube' || value === 'soundcloud';
}

/**
 * Наш JSON. Треки восстанавливаются целиком, поиск не нужен — это и есть
 * «перенос без потерь».
 */
function parseWireonJson(text: string): ParsedPlaylistFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PlaylistFileError(
      `Файл не читается как JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlaylistFileError('В файле должен быть JSON-объект с плейлистом');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== 'wireon-playlist') {
    throw new PlaylistFileError('Это не файл плейлиста Wireon Sounds');
  }
  if (typeof obj.version !== 'number' || obj.version > PLAYLIST_EXPORT_VERSION) {
    throw new PlaylistFileError(
      `Файл сделан более новой версией приложения (формат ${String(obj.version)})`
    );
  }
  const rawTracks = Array.isArray(obj.tracks) ? obj.tracks : [];
  const tracks: UnifiedTrack[] = [];
  const items: ParsedPlaylistItem[] = [];

  for (const entry of rawTracks) {
    if (!entry || typeof entry !== 'object') continue;
    const t = entry as Record<string, unknown>;
    const title = typeof t.title === 'string' ? t.title : '';
    const artist = typeof t.artist === 'string' ? t.artist : '';
    if (!title) continue;

    const id = typeof t.id === 'string' ? t.id : '';
    const originalId = typeof t.originalId === 'string' ? t.originalId : '';
    const duration = typeof t.duration === 'number' && Number.isFinite(t.duration) ? Math.max(0, t.duration) : 0;

    // Строка без источника или id играть не сможет — она уходит в поиск,
    // а не в плейлист, иначе получится трек, который нельзя включить.
    if (id && originalId && isKnownSource(t.source)) {
      tracks.push({
        id,
        source: t.source,
        originalId,
        title,
        artist: artist || UNKNOWN_ARTIST,
        album: typeof t.album === 'string' ? t.album : undefined,
        duration,
        artworkUrl: typeof t.artworkUrl === 'string' ? t.artworkUrl : '',
        sourceUrl: typeof t.sourceUrl === 'string' ? t.sourceUrl : undefined
      });
    } else {
      items.push({ title, artist: artist || UNKNOWN_ARTIST, duration: duration || undefined });
    }
  }

  return {
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : UNTITLED_PLAYLIST,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    tracks,
    items,
    source: 'wireon'
  };
}

/**
 * M3U/M3U8 из другого плеера. Здесь есть только «Исполнитель - Название», так
 * что каждую строку придётся искать заново — зато переносится что угодно.
 */
function parseM3U(text: string): ParsedPlaylistFile {
  const lines = text.split(/\r?\n/);
  const items: ParsedPlaylistItem[] = [];
  let title = '';
  let pendingDuration: number | undefined;
  let pendingLabel: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^#PLAYLIST:/i.test(line)) {
      title = line.slice(line.indexOf(':') + 1).trim();
      continue;
    }

    if (/^#EXTINF:/i.test(line)) {
      const payload = line.slice(line.indexOf(':') + 1);
      const comma = payload.indexOf(',');
      const durationPart = comma >= 0 ? payload.slice(0, comma) : payload;
      const labelPart = comma >= 0 ? payload.slice(comma + 1).trim() : '';
      const seconds = parseInt(durationPart, 10);
      pendingDuration = Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
      pendingLabel = labelPart || undefined;
      continue;
    }

    // Прочие директивы (#EXTM3U, #EXT-X-*) не несут метаданных трека.
    if (line.startsWith('#')) {
      // Кроме нашей же заглушки для трека без ссылки: `# Исполнитель - Название`.
      const fallbackLabel = line.replace(/^#\s*/, '');
      if (pendingLabel && fallbackLabel === pendingLabel) {
        items.push({ ...splitLabel(pendingLabel), duration: pendingDuration });
        pendingLabel = undefined;
        pendingDuration = undefined;
      }
      continue;
    }

    // Строка с путём или ссылкой закрывает предыдущий #EXTINF.
    const label = pendingLabel || fileNameToLabel(line);
    if (label) {
      items.push({ ...splitLabel(label), duration: pendingDuration });
    }
    pendingLabel = undefined;
    pendingDuration = undefined;
  }

  if (items.length === 0) {
    throw new PlaylistFileError('В файле не нашлось ни одного трека');
  }

  return { title: title || UNTITLED_PLAYLIST, tracks: [], items, source: 'm3u8' };
}

/** `Artist - Title` → части. Без дефиса всё уходит в название: угадывать хуже, чем искать. */
function splitLabel(label: string): { title: string; artist: string } {
  const dash = label.indexOf(' - ');
  if (dash > 0) {
    return { artist: label.slice(0, dash).trim(), title: label.slice(dash + 3).trim() };
  }
  return { artist: '', title: label.trim() };
}

/** `04 - Artist - Title.mp3` → `Artist - Title`, когда #EXTINF в файле нет. */
function fileNameToLabel(pathOrUrl: string): string {
  const withoutQuery = pathOrUrl.split(/[?#]/)[0];
  const name = withoutQuery.split(/[\\/]/).pop() || '';
  const withoutExt = name.replace(/\.[a-z0-9]{2,5}$/i, '');
  const decoded = (() => {
    try {
      return decodeURIComponent(withoutExt);
    } catch {
      return withoutExt;
    }
  })();
  return decoded.replace(/^\d{1,3}[\s._-]+/, '').replace(/[_]+/g, ' ').trim();
}

/**
 * CSV из таблицы. Колонки ищем по заголовку — порядок у всех разный, а вот
 * слова «исполнитель/artist» и «название/title» встречаются почти всегда.
 */
function parseCsv(text: string): ParsedPlaylistFile {
  const rows = splitCsvRows(text.replace(/^﻿/, ''));
  if (rows.length === 0) {
    throw new PlaylistFileError('Файл пуст');
  }

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const findColumn = (...names: string[]) =>
    header.findIndex((cell) => names.some((name) => cell === name || cell.includes(name)));

  let artistIdx = findColumn('исполнитель', 'артист', 'artist');
  let titleIdx = findColumn('название', 'трек', 'title', 'track', 'name');
  const albumIdx = findColumn('альбом', 'album');

  // Файл без заголовка: считаем, что это «исполнитель, название».
  const hasHeader = artistIdx >= 0 || titleIdx >= 0;
  if (!hasHeader) {
    artistIdx = 0;
    titleIdx = 1;
  }

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const items: ParsedPlaylistItem[] = [];
  for (const row of dataRows) {
    const title = (row[titleIdx] || '').trim();
    const artist = (row[artistIdx] || '').trim();
    if (!title && !artist) continue;
    // Одна колонка на весь файл — почти всегда «Исполнитель - Название».
    if (title) {
      items.push({
        title,
        artist,
        album: albumIdx >= 0 ? (row[albumIdx] || '').trim() || undefined : undefined
      });
    } else {
      items.push(splitLabel(artist));
    }
  }

  if (items.length === 0) {
    throw new PlaylistFileError('В файле не нашлось ни одного трека');
  }

  return { title: UNTITLED_PLAYLIST, tracks: [], items, source: 'csv' };
}

/** Разбор CSV с учётом кавычек: внутри поля бывают и запятые, и переводы строк. */
function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',' || char === ';' || char === '\t') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

/**
 * Читает файл плейлиста, определяя формат по содержимому.
 *
 * По содержимому, а не по расширению: пользователи переименовывают файлы, а
 * `.txt` из мессенджера — обычный экспорт, который должен открыться.
 */
export function parsePlaylistFile(text: string, filename?: string): ParsedPlaylistFile {
  if (typeof text !== 'string' || !text.trim()) {
    throw new PlaylistFileError('Файл пуст');
  }
  const trimmed = text.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseWireonJson(trimmed);
  }
  if (/^#EXTM3U/i.test(trimmed) || /^#EXTINF:/im.test(trimmed)) {
    return parseM3U(text);
  }
  if (filename && /\.m3u8?$/i.test(filename)) {
    return parseM3U(text);
  }
  return parseCsv(text);
}
