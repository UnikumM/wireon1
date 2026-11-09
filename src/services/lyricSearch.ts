/**
 * Поиск трека по строчке из песни.
 *
 * Человек помнит «а свет в окне не гаснет», но не помнит ни названия, ни
 * исполнителя. Обычный поиск по такой строке отдаёт случайные совпадения
 * по словам: источники ищут по названиям, а не по тексту. Здесь две ступени:
 *
 * 1. Тексты, которые уже лежат локально (`db.lyrics`): всё, что человек
 *    открывал в караоке, сохранено вместе со строками. Ищем фрагмент там,
 *    а трек берём из медиатеки — избранного, истории, плейлистов.
 * 2. LRCLIB: его `/api/search?q=` ищет и по тексту. У найденной записи есть
 *    название и исполнитель — по ним трек находится обычным поиском YouTube.
 *
 * Модуль чистый: сторы читаются только в точке входа, остальное проверяется
 * на массивах и фейковой базе.
 */

import type { LyricsRecord } from './db';
import { db } from './db';
import { getLyricsCacheKey, searchLyrics, type LyricsResult } from './lyricsService';
import { youtubeService } from './youtube';
import { useLibraryStore } from '../store/useLibraryStore';
import type { UnifiedTrack } from '../types/music';

/** Откуда пришло совпадение: своя база текстов или LRCLIB. */
export type LyricHitOrigin = 'local' | 'lrclib';

/** Фрагмент текста вокруг найденной строки — для цитаты с подсветкой. */
export interface LyricFragment {
  /** Текст до совпадения в той же строке (или строках). */
  before: string;
  /** Само совпадение — в написании текста, не запроса. */
  line: string;
  /** Текст после совпадения до конца строки. */
  after: string;
}

export interface LyricHit extends LyricFragment {
  /** Ключ записи в `db.lyrics`; у LRCLIB — `lrclib:::<id>`. */
  key: string;
  /** Для ручного выбора ключ хранит сам id трека. */
  trackId?: string;
  title: string;
  artist: string;
  origin: LyricHitOrigin;
  /** Трек, который можно сыграть: из медиатеки или найденный по названию. */
  track?: UnifiedTrack;
}

/** Совпадение, у которого точно есть трек, — такое можно показать и сыграть. */
export interface LyricTrackHit extends LyricHit {
  track: UnifiedTrack;
}

export interface LyricSearchResult {
  local: LyricTrackHit[];
  online: LyricTrackHit[];
}

/** Меньше четырёх слов — это название или имя, а не строчка. */
const MIN_WORDS = 4;

/** Сколько совпадений показывать с каждой ступени. */
export const LYRIC_HIT_LIMIT = 3;

/** Похоже на адрес: схема, `www.` или домен с путём. */
const LINK_LIKE = /(^|\s)(https?:\/\/|www\.)|\S+\.(com|ru|net|org|be|io|me|tv|fm)(\/|$|\s)/i;

const MANUAL_PREFIX = 'manual:::';

/**
 * Приводит строку к виду для сравнения: регистр, «ё», диакритика и знаки
 * препинания не важны — человек помнит слова, а не запятые.
 */
export function normalizeLine(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Похож ли запрос на строчку из песни.
 *
 * Не меньше четырёх слов, среди них есть буквы, и это не ссылка. Короткие
 * запросы остаются обычным поиском: «кино группа крови» — название, а не текст.
 */
export function looksLikeLyricLine(query: string | undefined | null): boolean {
  const raw = (query || '').trim();
  if (!raw || LINK_LIKE.test(raw)) return false;
  const normalized = normalizeLine(raw);
  if (!normalized || !/\p{L}/u.test(normalized)) return false;
  return normalized.split(' ').length >= MIN_WORDS;
}

/**
 * Нормализованный текст с картой «нормализованный символ → индекс в исходнике».
 *
 * Нужна, чтобы подсветить совпадение в тексте так, как он написан: с заглавными,
 * запятыми и буквой «ё», — а искать при этом по нормализованной строке.
 */
function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  let normalized = '';
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const piece = normalizeLine(text[i]);
    if (!piece) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) {
      normalized += ' ';
      map.push(i);
      pendingSpace = false;
    }
    for (const ch of piece) {
      normalized += ch;
      map.push(i);
    }
  }
  return { normalized, map };
}

/**
 * Ищет строчку в тексте песни и возвращает фрагмент для цитаты.
 *
 * Совпадение может лежать на стыке двух строк — текст сравнивается целиком,
 * а цитата обрезается по границам строк, в которые попало совпадение.
 */
export function findLyricFragment(text: string | undefined | null, query: string): LyricFragment | null {
  const needle = normalizeLine(query);
  if (!needle || !text) return null;

  const { normalized, map } = normalizeWithMap(text);
  const at = normalized.indexOf(needle);
  if (at < 0) return null;

  const start = map[at];
  const end = map[at + needle.length - 1] + 1;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEndRaw = text.indexOf('\n', end);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;

  return {
    before: text.slice(lineStart, start).replace(/^\s+/, ''),
    line: text.slice(start, end),
    after: text.slice(end, lineEnd).replace(/\s+$/, '')
  };
}

/** Текст из сохранённого результата: синхронные строки или простой текст. */
function lyricsText(result: LyricsResult | null | undefined): string {
  if (!result) return '';
  if (result.plainLyrics && result.plainLyrics.trim()) return result.plainLyrics;
  return (result.lines || []).map((line) => line.text).join('\n');
}

/** Название и исполнитель из записи: из ответа LRCLIB, иначе из ключа. */
function describeRecord(record: LyricsRecord, result: LyricsResult): { title: string; artist: string } {
  if (result.trackName) return { title: result.trackName, artist: result.artistName || '' };
  if (record.key.startsWith(MANUAL_PREFIX)) return { title: '', artist: '' };
  const [artist = '', title = ''] = record.key.split(':::');
  return { title, artist };
}

/** Треки медиатеки — избранное, история, плейлисты, без дублей по id. */
export function libraryTracks(): UnifiedTrack[] {
  const { favorites, history, playlists } = useLibraryStore.getState();
  const seen = new Set<string>();
  const result: UnifiedTrack[] = [];
  for (const track of [...favorites, ...history, ...playlists.flatMap((playlist) => playlist.tracks)]) {
    if (!track?.id || seen.has(track.id)) continue;
    seen.add(track.id);
    result.push(track);
  }
  return result;
}

/**
 * Трек медиатеки для записи текстов: по id для ручного выбора, иначе по тому
 * же ключу «исполнитель:::название», под которым текст и был сохранён.
 */
export function matchLibraryTrack(hit: Pick<LyricHit, 'key' | 'trackId'>, tracks: UnifiedTrack[]): UnifiedTrack | undefined {
  if (hit.trackId) {
    const byId = tracks.find((track) => track.id === hit.trackId);
    if (byId) return byId;
  }
  return tracks.find((track) => getLyricsCacheKey({ title: track.title, artist: track.artist || '' }) === hit.key);
}

/** Ключ для склейки дублей: одна песня могла сохраниться под двумя ключами. */
function songKey(hit: Pick<LyricHit, 'title' | 'artist'>): string {
  return `${normalizeLine(hit.artist)}:::${normalizeLine(hit.title)}`;
}

/**
 * Совпадения среди локально сохранённых текстов.
 *
 * `tracks` — медиатека, по которой подбирается трек; по умолчанию — стор.
 * Совпадение без трека тоже возвращается: вторая ступень дотянет его по
 * названию.
 */
export async function searchLocalLyrics(
  query: string,
  options: { tracks?: UnifiedTrack[]; limit?: number } = {}
): Promise<LyricHit[]> {
  const needle = normalizeLine(query);
  if (!needle) return [];
  const limit = options.limit ?? LYRIC_HIT_LIMIT;

  let records: LyricsRecord[];
  try {
    records = await db.lyrics.toArray();
  } catch {
    // База — удобство: нет её, нет и локальной ступени.
    return [];
  }

  const tracks = options.tracks ?? libraryTracks();
  const seen = new Set<string>();
  const hits: LyricHit[] = [];

  for (const record of records) {
    const result = record.result as LyricsResult | null;
    if (!result) continue;
    const fragment = findLyricFragment(lyricsText(result), query);
    if (!fragment) continue;

    const trackId = record.key.startsWith(MANUAL_PREFIX) ? record.key.slice(MANUAL_PREFIX.length) : undefined;
    const base: LyricHit = { ...fragment, key: record.key, trackId, ...describeRecord(record, result), origin: 'local' };
    const track = matchLibraryTrack(base, tracks);
    if (track) {
      base.track = track;
      if (!base.title) base.title = track.title;
      if (!base.artist) base.artist = track.artist || '';
    }
    if (!base.title && !base.track) continue;

    const dedupe = base.track ? `id:${base.track.id}` : songKey(base);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    hits.push(base);
    if (hits.length >= limit) break;
  }

  return hits;
}

/**
 * Вторая ступень: LRCLIB ищет по тексту, мы оставляем только те записи, где
 * строчка действительно есть, — поиск там нечёткий, а показывать чужую песню
 * хуже, чем не показать ничего.
 */
export async function searchLyricsOnline(query: string, limit: number = LYRIC_HIT_LIMIT): Promise<LyricHit[]> {
  if (!looksLikeLyricLine(query)) return [];
  const found = await searchLyrics(query);
  const seen = new Set<string>();
  const hits: LyricHit[] = [];
  for (const result of found) {
    if (!result.trackName) continue;
    const fragment = findLyricFragment(lyricsText(result), query);
    if (!fragment) continue;
    const hit: LyricHit = {
      ...fragment,
      key: `lrclib:::${result.id ?? ''}`,
      title: result.trackName,
      artist: result.artistName || '',
      origin: 'lrclib'
    };
    const dedupe = songKey(hit);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Трек по названию и исполнителю — первое совпадение поиска YouTube. */
export async function resolveLyricHitTrack(hit: LyricHit): Promise<UnifiedTrack | undefined> {
  if (hit.track) return hit.track;
  const query = `${hit.artist} ${hit.title}`.trim();
  if (!query) return undefined;
  try {
    const [first] = await youtubeService.search(query, 3);
    return first;
  } catch (err) {
    console.warn('[lyricSearch] Не нашли трек по названию:', err);
    return undefined;
  }
}

/**
 * Обе ступени разом: локальные совпадения, затем LRCLIB без тех песен, что
 * уже нашлись локально. Возвращаются только совпадения с треком — без него
 * показывать нечего.
 */
export async function searchByLyricLine(
  query: string,
  options: { tracks?: UnifiedTrack[]; online?: boolean } = {}
): Promise<LyricSearchResult> {
  if (!looksLikeLyricLine(query)) return { local: [], online: [] };

  const local = await searchLocalLyrics(query, { tracks: options.tracks });
  const online = options.online === false ? [] : await searchLyricsOnline(query).catch(() => []);

  const known = new Set(local.map(songKey));
  const fresh = online.filter((hit) => !known.has(songKey(hit)));

  const resolved = await Promise.all([...local, ...fresh].map(async (hit) => ({ ...hit, track: await resolveLyricHitTrack(hit) })));
  const withTrack = resolved.filter((hit): hit is LyricTrackHit => Boolean(hit.track));

  const seenIds = new Set<string>();
  const unique = withTrack.filter((hit) => {
    if (seenIds.has(hit.track.id)) return false;
    seenIds.add(hit.track.id);
    return true;
  });

  return {
    local: unique.filter((hit) => hit.origin === 'local'),
    online: unique.filter((hit) => hit.origin === 'lrclib')
  };
}
