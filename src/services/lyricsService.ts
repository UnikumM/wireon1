/**
 * Поиск текстов песен в LRCLIB (https://lrclib.net).
 *
 * Прошлая версия брала первый результат поиска — из-за этого к песне часто
 * прилипал чужой текст, а иногда не находилось вообще ничего. Здесь другая
 * логика: несколько попыток с разными формулировками запроса, каждый кандидат
 * оценивается по названию, исполнителю и длительности, и слабое совпадение
 * отбрасывается вместо того, чтобы показать не тот текст.
 *
 * Дополнительно:
 * - результат (в том числе «ничего нет») кэшируется в IndexedDB, поэтому после
 *   перезапуска не приходится ходить в сеть заново;
 * - пользователь может выбрать другой текст руками — такой выбор сохраняется
 *   навсегда и всегда побеждает автоматический;
 * - сдвиг тайминга хранится рядом с текстом, отдельно для каждого трека.
 */

import { UnifiedTrack } from '../types/music';
import { LyricsLine, parseLRC, parsePlainLyrics } from './lrcParser';
import { normalizeForMatch, stripNoise, splitArtistTitle } from './trackMatching';
import { db, type LyricsRecord } from './db';

export type { LyricsLine } from './lrcParser';

export interface LyricsResult {
  synced: boolean;
  lines: LyricsLine[];
  rawLrc?: string;
  plainLyrics?: string;
  id?: number | string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  /** Насколько уверенно текст сопоставлен с треком — показывается в интерфейсе. */
  confidence?: LyricsConfidence;
  /** Выбран пользователем вручную, а не подобран автоматически. */
  manual?: boolean;
}

export type LyricsConfidence = 'high' | 'medium' | 'low';

export interface TrackLyricsQuery {
  id?: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number; // В секундах
}

export interface LrclibApiResponse {
  id: number;
  name?: string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
}

/** Оценённый вариант текста — то, из чего пользователь выбирает руками. */
export interface LyricsCandidate {
  result: LyricsResult;
  score: number;
  confidence: LyricsConfidence;
  /** Человеческое объяснение, почему вариант такой: «длительность отличается на 12 с». */
  notes: string[];
}

const LRCLIB_BASE_URL = 'https://lrclib.net/api';
const FETCH_TIMEOUT_MS = 6000;
const USER_AGENT = 'Wireon/1.0.0 (https://github.com/wireon-music)';

/**
 * Ниже этого — текст не показывается вообще.
 *
 * Лучше признаться «не нашли», чем показать текст другой песни: именно это
 * выглядело как «криво работает».
 */
const MIN_ACCEPTABLE_SCORE = 55;

/** Достаточно хорошо, чтобы прекратить перебор запросов. */
const GOOD_ENOUGH_SCORE = 95;

/** Отрицательный ответ перепроверяется через неделю: база LRCLIB пополняется. */
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Положительный ответ живёт долго — текст песни не меняется. */
const POSITIVE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// Кэш в памяти: чтобы одна и та же песня в рамках сессии не ходила даже в IndexedDB.
const lyricsCache = new Map<string, LyricsResult | null>();

/**
 * Потолок кэша в памяти.
 *
 * Без него словарь растёт всю сессию: «Моя волна» за ночь проигрывает сотни
 * треков, и текст каждого остаётся в памяти навсегда. Диск при этом ничего не
 * теряет — в IndexedDB тексты лежат отдельно и надолго, память здесь только
 * чтобы не ходить туда дважды за одну песню.
 *
 * Двести записей — это заведомо больше, чем человек успевает послушать подряд,
 * и всё ещё единицы мегабайт.
 */
const LYRICS_CACHE_LIMIT = 200;

/** Кладёт в кэш, вытесняя самую давнюю запись, когда упёрлись в потолок. */
function rememberInMemory(key: string, value: LyricsResult | null): void {
  // Переустановка двигает ключ в конец очереди: так вытесняется именно то, к
  // чему дольше всего не обращались, а не то, что первым попало в кэш.
  if (lyricsCache.has(key)) lyricsCache.delete(key);
  lyricsCache.set(key, value);
  while (lyricsCache.size > LYRICS_CACHE_LIMIT) {
    const oldest = lyricsCache.keys().next();
    if (oldest.done) break;
    lyricsCache.delete(oldest.value);
  }
}

// Уже выполняющиеся запросы, чтобы два открытия текста не удваивали трафик.
const pendingRequests = new Map<string, Promise<LyricsResult | null>>();

/**
 * Убирает из названия мусор загрузок YouTube.
 *
 * Примеры:
 * - "Song Title (Official Music Video)" → "Song Title"
 * - "Song Title [HD / 4K]" → "Song Title"
 * - "Artist - Track (feat. Someone) [Lyric Video]" → "Track"
 */
export function cleanTrackTitle(title: string): string {
  if (!title) return '';

  let clean = title;

  // «Исполнитель - Название»: для поиска текста нужна вторая часть.
  if (clean.includes(' - ')) {
    const parts = clean.split(' - ');
    if (parts.length >= 2) {
      clean = parts.slice(1).join(' - ');
    }
  }

  // Скобки с типовыми пометками о видео и качестве.
  clean = clean.replace(
    /\s*[\(\[][^()\[\]]*(?:official|music\s*video|lyric|video|audio|visualizer|lyrics|hd|4k|hq|remaster|live|clip|version|explicit)[^()\[\]]*[\)\]]/gi,
    ''
  );

  // Хвост с приглашёнными исполнителями только мешает поиску.
  clean = clean.replace(/\s*[\(\[]\s*(?:feat\.|ft\.|featuring)\s+[^)\]]+[\)\]]/gi, '');
  clean = clean.replace(/\s+(?:feat\.|ft\.|featuring)\s+.+$/i, '');

  // Кавычки, пустые скобки, двойные пробелы.
  clean = clean.replace(/["“”«»]/g, '').trim();
  clean = clean.replace(/\s*[\(\[]\s*[\)\]]/g, '').trim();
  clean = clean.replace(/\s{2,}/g, ' ');

  return clean || title.trim();
}

/** Убирает из имени исполнителя пометки каналов: « - Topic», «VEVO». */
export function cleanArtistName(artist: string): string {
  if (!artist) return '';

  let clean = artist;
  clean = clean.replace(/\s*-\s*Topic$/i, '');
  clean = clean.replace(/VEVO$/i, '');
  clean = clean.replace(/\s*[-–—]\s*Official(?:\s+Channel)?$/i, '');
  clean = clean.replace(/\s*\bOfficial\s+(?:Channel|Music)\b\s*$/i, '');
  clean = clean.replace(/\s{2,}/g, ' ');

  return clean.trim() || artist.trim();
}

/** Нормализованный ключ кэша для трека. */
export function getLyricsCacheKey(query: TrackLyricsQuery): string {
  const cleanTitle = cleanTrackTitle(query.title).toLowerCase();
  const cleanArtist = cleanArtistName(query.artist).toLowerCase();
  return `${cleanArtist}:::${cleanTitle}`;
}

/** Ключ ручного выбора: он привязан к конкретному треку, а не к паре имён. */
function manualKey(trackId: string): string {
  return `manual:::${trackId}`;
}

/** Fetch с таймаутом и User-Agent, как просит LRCLIB. */
async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT
      }
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/** Приводит ответ LRCLIB к внутреннему виду. */
export function formatLrclibResponse(data: LrclibApiResponse): LyricsResult {
  const isInstrumental = Boolean(data.instrumental);
  const rawLrc = data.syncedLyrics ? data.syncedLyrics.trim() : undefined;
  const rawPlain = data.plainLyrics ? data.plainLyrics.trim() : undefined;

  const common = {
    id: data.id,
    trackName: data.trackName || data.name,
    artistName: data.artistName,
    albumName: data.albumName,
    duration: data.duration,
    instrumental: isInstrumental
  };

  if (rawLrc && rawLrc.length > 0) {
    const lines = parseLRC(rawLrc);
    if (lines.length > 0) {
      return { ...common, synced: true, lines, rawLrc, plainLyrics: rawPlain };
    }
  }

  if (rawPlain && rawPlain.length > 0) {
    return { ...common, synced: false, lines: parsePlainLyrics(rawPlain), plainLyrics: rawPlain };
  }

  // Инструментал или пустой ответ.
  return { ...common, synced: false, lines: [] };
}

/** Пересечение слов относительно более короткой стороны. */
function overlap(a: string, b: string): number {
  const left = new Set(normalizeForMatch(a).split(' ').filter(Boolean));
  const right = new Set(normalizeForMatch(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.min(left.size, right.size);
}

/**
 * Насколько правдоподобно, что этот текст — от нужной песни.
 *
 * Веса подобраны под то, что реально путается: название важнее всего, но
 * разошедшийся исполнитель почти всегда означает чужую песню, а длительность —
 * единственный признак, который отличает оригинал от ремикса и живой версии.
 */
export function scoreLyricsCandidate(
  query: TrackLyricsQuery,
  candidate: LrclibApiResponse
): { score: number; confidence: LyricsConfidence; notes: string[] } {
  const notes: string[] = [];
  let score = 0;

  const fromTitle = splitArtistTitle(query.title);
  const wantedTitle = cleanTrackTitle(query.title) || stripNoise(query.title);
  // Название канала бывает «Название - Topic» или лейблом, поэтому исполнитель
  // из самого заголовка обычно точнее.
  const wantedArtist = cleanArtistName(query.artist) || fromTitle.artist || '';

  const candidateTitle = candidate.trackName || candidate.name || '';
  const candidateArtist = candidate.artistName || '';

  // --- Название -------------------------------------------------------------
  const titleRatio = Math.max(
    overlap(wantedTitle, candidateTitle),
    overlap(fromTitle.title, candidateTitle)
  );
  score += titleRatio * 55;
  if (titleRatio < 0.5) notes.push('название совпадает слабо');

  // --- Исполнитель ----------------------------------------------------------
  if (wantedArtist) {
    const artistRatio = Math.max(
      overlap(wantedArtist, candidateArtist),
      overlap(fromTitle.artist || '', candidateArtist),
      // Исполнитель нередко зашит в заголовок загрузки целиком.
      overlap(query.title, candidateArtist)
    );
    score += artistRatio * 35;
    if (artistRatio < 0.34) notes.push('исполнитель не совпадает');
  } else {
    // Без имени исполнителя судить можно только по названию, и это ненадёжно.
    notes.push('исполнитель неизвестен');
  }

  // --- Длительность ---------------------------------------------------------
  if (query.duration && candidate.duration) {
    const delta = Math.abs(candidate.duration - query.duration);
    if (delta <= 2) score += 30;
    else if (delta <= 5) score += 22;
    else if (delta <= 12) score += 8;
    else if (delta <= 30) {
      score -= 12;
      notes.push(`длительность отличается на ${Math.round(delta)} с`);
    } else {
      score -= 40;
      notes.push(`длительность отличается на ${Math.round(delta)} с`);
    }
  }

  // --- Есть ли что показывать ----------------------------------------------
  if (candidate.syncedLyrics) score += 12;
  else if (candidate.plainLyrics) score += 4;
  else if (!candidate.instrumental) {
    score -= 60;
    notes.push('в этом варианте нет текста');
  }

  const confidence: LyricsConfidence = score >= GOOD_ENOUGH_SCORE ? 'high' : score >= 75 ? 'medium' : 'low';
  return { score, confidence, notes };
}

/** Выбирает лучший вариант из ответа поиска, либо ничего. */
function pickBest(
  query: TrackLyricsQuery,
  items: LrclibApiResponse[]
): { item: LrclibApiResponse; score: number; confidence: LyricsConfidence } | null {
  let best: { item: LrclibApiResponse; score: number; confidence: LyricsConfidence } | null = null;

  for (const item of items) {
    if (!item) continue;
    // Пустой вариант не спасёт: показывать всё равно нечего.
    if (!item.syncedLyrics && !item.plainLyrics && !item.instrumental) continue;

    const { score, confidence } = scoreLyricsCandidate(query, item);
    if (!best || score > best.score) best = { item, score, confidence };
  }

  return best && best.score >= MIN_ACCEPTABLE_SCORE ? best : null;
}

/** Один шаг перебора: как спросить у LRCLIB. */
interface Attempt {
  url: string;
  /** `get` возвращает объект, `search` — массив. */
  kind: 'get' | 'search';
}

/**
 * Порядок попыток — от самого точного запроса к самому широкому.
 *
 * Первым идёт `/get` с длительностью: LRCLIB сам сверяет её и отдаёт ровно то,
 * что нужно. Дальше ограничения снимаются по одному, и в конце остаётся поиск
 * по одному названию — он находит больше всего, но и ошибается чаще, поэтому
 * его результат всё равно проходит через оценку.
 */
function buildAttempts(query: TrackLyricsQuery): Attempt[] {
  const attempts: Attempt[] = [];
  const cleanTitle = cleanTrackTitle(query.title);
  const cleanArtist = cleanArtistName(query.artist);
  const fromTitle = splitArtistTitle(query.title);

  const seen = new Set<string>();
  const push = (url: string, kind: Attempt['kind']) => {
    if (seen.has(url)) return;
    seen.add(url);
    attempts.push({ url, kind });
  };

  const getUrl = (title: string, artist: string, withDuration: boolean, withAlbum: boolean): string => {
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    if (withAlbum && query.album) params.set('album_name', query.album);
    if (withDuration && query.duration && Number.isFinite(query.duration) && query.duration > 0) {
      params.set('duration', Math.round(query.duration).toString());
    }
    return `${LRCLIB_BASE_URL}/get?${params.toString()}`;
  };

  if (cleanTitle && cleanArtist) {
    push(getUrl(cleanTitle, cleanArtist, true, true), 'get');
    // Альбом у загрузок YouTube почти всегда выдуман, а LRCLIB сверяет его строго.
    push(getUrl(cleanTitle, cleanArtist, true, false), 'get');
    push(getUrl(cleanTitle, cleanArtist, false, false), 'get');
  }

  // Исполнитель из заголовка: канал часто называется лейблом или «… - Topic».
  if (fromTitle.artist && fromTitle.title && normalizeForMatch(fromTitle.artist) !== normalizeForMatch(cleanArtist)) {
    push(getUrl(fromTitle.title, fromTitle.artist, false, false), 'get');
  }

  if (cleanTitle && cleanArtist) {
    const params = new URLSearchParams({ track_name: cleanTitle, artist_name: cleanArtist });
    push(`${LRCLIB_BASE_URL}/search?${params.toString()}`, 'search');
  }

  const generic = `${cleanArtist} ${cleanTitle}`.trim();
  if (generic) push(`${LRCLIB_BASE_URL}/search?q=${encodeURIComponent(generic)}`, 'search');

  // Последняя попытка: только название. Находит больше всего и ошибается чаще —
  // но оценка кандидатов не даст принять чужую песню.
  if (cleanTitle) push(`${LRCLIB_BASE_URL}/search?q=${encodeURIComponent(cleanTitle)}`, 'search');

  return attempts;
}

/** Читает запись кэша из IndexedDB, уважая срок годности. */
async function readStored(key: string): Promise<{ result: LyricsResult | null; manual: boolean } | undefined> {
  try {
    const record = await db.lyrics.get(key);
    if (!record) return undefined;
    if (record.manual) return { result: (record.result as LyricsResult) ?? null, manual: true };

    const ttl = record.result ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - record.fetchedAt > ttl) return undefined;
    return { result: (record.result as LyricsResult) ?? null, manual: false };
  } catch {
    // Кэш — удобство, а не источник истины: сломался, значит идём в сеть.
    return undefined;
  }
}

async function writeStored(key: string, result: LyricsResult | null, manual = false): Promise<void> {
  try {
    const previous = await db.lyrics.get(key);
    const record: LyricsRecord = {
      key,
      fetchedAt: Date.now(),
      result,
      manual,
      // Сдвиг тайминга задан пользователем и не должен пропадать при обновлении текста.
      offsetSeconds: previous?.offsetSeconds
    };
    await db.lyrics.put(record);
  } catch {
    // Не смогли сохранить — не повод терять уже полученный текст.
  }
}

/**
 * Ищет текст для трека: сначала ручной выбор, потом кэш, потом LRCLIB.
 *
 * @returns текст или `null`, если ничего достаточно похожего не нашлось
 */
export async function fetchLyrics(
  track: UnifiedTrack | TrackLyricsQuery
): Promise<LyricsResult | null> {
  if (!track || !track.title) {
    return null;
  }

  const query: TrackLyricsQuery = {
    id: track.id,
    title: track.title,
    artist: track.artist || '',
    album: (track as UnifiedTrack).album,
    duration: track.duration
  };

  const cacheKey = getLyricsCacheKey(query);

  if (lyricsCache.has(cacheKey)) {
    return lyricsCache.get(cacheKey) || null;
  }

  if (query.id && lyricsCache.has(query.id)) {
    return lyricsCache.get(query.id) || null;
  }

  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey)!;
  }

  const requestPromise = (async (): Promise<LyricsResult | null> => {
    try {
      // Ручной выбор пользователя сильнее любого автоматического подбора.
      if (query.id) {
        const manual = await readStored(manualKey(query.id));
        if (manual?.result) {
          const chosen = { ...manual.result, manual: true };
          remember(cacheKey, query.id, chosen);
          return chosen;
        }
      }

      const stored = await readStored(cacheKey);
      if (stored) {
        remember(cacheKey, query.id, stored.result);
        return stored.result;
      }

      let best: { item: LrclibApiResponse; score: number; confidence: LyricsConfidence } | null = null;

      for (const attempt of buildAttempts(query)) {
        try {
          const response = await fetchWithTimeout(attempt.url);
          if (!response.ok) continue;
          const payload = await response.json();

          const items: LrclibApiResponse[] = attempt.kind === 'get'
            ? (payload ? [payload as LrclibApiResponse] : [])
            : (Array.isArray(payload) ? payload : []);
          if (items.length === 0) continue;

          const candidate = pickBest(query, items);
          if (candidate && (!best || candidate.score > best.score)) best = candidate;

          // Достаточно хорошо — дальше искать нечего.
          if (best && best.score >= GOOD_ENOUGH_SCORE) break;
        } catch {
          // Одна неудачная формулировка не должна прекращать перебор.
        }
      }

      const result = best
        ? { ...formatLrclibResponse(best.item), confidence: best.confidence }
        : null;

      remember(cacheKey, query.id, result);
      await writeStored(cacheKey, result);
      return result;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/** Кладёт результат в кэш памяти под обоими ключами. */
function remember(cacheKey: string, trackId: string | undefined, result: LyricsResult | null): void {
  rememberInMemory(cacheKey, result);
  if (trackId) rememberInMemory(trackId, result);
}

/** Свободный поиск текста по строке. */
export async function searchLyrics(queryText: string): Promise<LyricsResult[]> {
  if (!queryText || !queryText.trim()) return [];

  try {
    const url = `${LRCLIB_BASE_URL}/search?q=${encodeURIComponent(queryText.trim())}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];

    const data: LrclibApiResponse[] = await res.json();
    if (!Array.isArray(data)) return [];

    return data
      .filter((item) => item.syncedLyrics || item.plainLyrics)
      .map((item) => formatLrclibResponse(item));
  } catch (err) {
    console.warn('[lyricsService] searchLyrics error:', err);
    return [];
  }
}

/**
 * Варианты текста для ручного выбора — с оценкой, чтобы было видно, какой
 * ближе к тому, что играет.
 *
 * Именно то, что нужно, когда автоподбор промахнулся: пользователь видит
 * несколько текстов с пояснениями и выбирает правильный сам.
 */
export async function findLyricsCandidates(
  track: UnifiedTrack | TrackLyricsQuery,
  overrideQuery?: string
): Promise<LyricsCandidate[]> {
  if (!track?.title && !overrideQuery) return [];

  const query: TrackLyricsQuery = {
    id: track?.id,
    title: track?.title || '',
    artist: track?.artist || '',
    album: (track as UnifiedTrack)?.album,
    duration: track?.duration
  };

  const searchText = overrideQuery?.trim()
    ? overrideQuery.trim()
    : `${cleanArtistName(query.artist)} ${cleanTrackTitle(query.title)}`.trim();
  if (!searchText) return [];

  let items: LrclibApiResponse[] = [];
  try {
    const res = await fetchWithTimeout(`${LRCLIB_BASE_URL}/search?q=${encodeURIComponent(searchText)}`);
    if (res.ok) {
      const payload = await res.json();
      if (Array.isArray(payload)) items = payload;
    }
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const candidates: LyricsCandidate[] = [];

  for (const item of items) {
    if (!item || (!item.syncedLyrics && !item.plainLyrics && !item.instrumental)) continue;
    // Один и тот же текст приходит из базы по нескольку раз под разными id.
    const identity = `${normalizeForMatch(item.trackName || item.name)}:::${normalizeForMatch(item.artistName)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    const { score, confidence, notes } = scoreLyricsCandidate(query, item);
    candidates.push({ result: { ...formatLrclibResponse(item), confidence }, score, confidence, notes });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Запоминает текст, выбранный пользователем вручную.
 *
 * Хранится по id трека и не имеет срока годности: если человек однажды сказал,
 * какой текст правильный, переспрашивать незачем.
 */
export async function setManualLyrics(
  track: UnifiedTrack | TrackLyricsQuery,
  result: LyricsResult | null
): Promise<void> {
  const trackId = track?.id;
  if (!trackId) return;

  const chosen = result ? { ...result, manual: true } : null;
  await writeStored(manualKey(trackId), chosen, true);

  // Оба ключа памяти: `fetchLyrics` сначала смотрит на «исполнитель:::название»,
  // поэтому без этого сразу после выбора вернулся бы прежний неверный текст.
  rememberInMemory(trackId, chosen);
  if (track.title) {
    rememberInMemory(getLyricsCacheKey({ title: track.title, artist: track.artist || '' }), chosen);
  }
}

/** Убирает ручной выбор, возвращая трек к автоматическому подбору. */
export async function clearManualLyrics(track: UnifiedTrack | TrackLyricsQuery): Promise<void> {
  const trackId = track?.id;
  if (!trackId) return;
  try {
    await db.lyrics.delete(manualKey(trackId));
  } catch {
    // Нечего удалять — уже нужное состояние.
  }
  lyricsCache.delete(trackId);
  if (track.title) {
    // Автоподбор должен начаться заново, а не отдать запомненный ручной текст.
    lyricsCache.delete(getLyricsCacheKey({ title: track.title, artist: track.artist || '' }));
  }
}

/**
 * Сдвиг тайминга для трека, в секундах.
 *
 * Записи в LRCLIB нередко сделаны по другому мастерингу: текст уезжает на
 * полсекунды-секунду. Один ползунок решает это, и решение запоминается.
 */
export async function getLyricsOffset(trackId: string | undefined): Promise<number> {
  if (!trackId) return 0;
  try {
    const manual = await db.lyrics.get(manualKey(trackId));
    if (typeof manual?.offsetSeconds === 'number') return manual.offsetSeconds;
    const byTrack = await db.lyrics.get(trackId);
    return typeof byTrack?.offsetSeconds === 'number' ? byTrack.offsetSeconds : 0;
  } catch {
    return 0;
  }
}

export async function setLyricsOffset(trackId: string | undefined, offsetSeconds: number): Promise<void> {
  if (!trackId) return;
  const safe = Number.isFinite(offsetSeconds) ? Math.max(-30, Math.min(30, offsetSeconds)) : 0;
  try {
    // Сдвиг живёт под ключом трека, чтобы не зависеть от того, ручной текст или нет.
    const key = (await db.lyrics.get(manualKey(trackId))) ? manualKey(trackId) : trackId;
    const previous = await db.lyrics.get(key);
    await db.lyrics.put({
      key,
      fetchedAt: previous?.fetchedAt ?? Date.now(),
      result: previous?.result ?? null,
      manual: previous?.manual,
      offsetSeconds: safe
    });
  } catch {
    // Не сохранилось — сдвиг всё равно применён в текущем сеансе.
  }
}

/** Очищает кэш текстов в памяти. */
export function clearLyricsCache(): void {
  lyricsCache.clear();
  pendingRequests.clear();
}

/** Полностью забывает всё про тексты, включая ручной выбор и сдвиги. */
export async function clearStoredLyrics(): Promise<void> {
  clearLyricsCache();
  try {
    await db.lyrics.clear();
  } catch {
    // Таблицы может не быть в старой базе — это не ошибка.
  }
}

/** Отдаёт текст из кэша, не обращаясь к сети. */
export function getCachedLyrics(track: UnifiedTrack | TrackLyricsQuery): LyricsResult | null | undefined {
  const query: TrackLyricsQuery = {
    id: track.id,
    title: track.title,
    artist: track.artist || '',
    album: (track as UnifiedTrack).album,
    duration: track.duration
  };

  const key = getLyricsCacheKey(query);
  if (lyricsCache.has(key)) {
    return lyricsCache.get(key);
  }
  if (query.id && lyricsCache.has(query.id)) {
    return lyricsCache.get(query.id);
  }
  return undefined;
}

export const lyricsService = {
  fetchLyrics,
  getLyrics: fetchLyrics,
  searchLyrics,
  findLyricsCandidates,
  setManualLyrics,
  clearManualLyrics,
  getLyricsOffset,
  setLyricsOffset,
  cleanTrackTitle,
  cleanArtistName,
  getLyricsCacheKey,
  formatLrclibResponse,
  scoreLyricsCandidate,
  getCachedLyrics,
  clearCache: clearLyricsCache,
  clearStored: clearStoredLyrics
};
