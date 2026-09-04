/**
 * Похожие исполнители для страницы артиста.
 *
 * Почему этот файл вообще появился. Единственным источником блока была карусель
 * «Похожие исполнители» из InnerTube-запроса `browse` на канал артиста
 * (`artistService.browseArtistChannel`). Источник настоящий и данные отдаёт, но
 * из renderer до него не дойти: запрос уходит с `Content-Type: application/json`
 * и заголовком `X-YouTube-Client-Name`, поэтому Chromium обязан сделать
 * предзапрос CORS, а `OPTIONS https://music.youtube.com/youtubei/v1/browse`
 * отвечает 403 (или 400, если подставить Origin самого YouTube). Предзапрос с
 * неуспешным кодом заваливает весь запрос, и заголовки `Access-Control-*`,
 * которые main-процесс дописывает в ответ, тут не спасают — код ответа он
 * поменять не может. Остальное приложение обходит это через IPC в main
 * (`search-youtube`), а у профиля артиста такого пути нет.
 *
 * Поэтому здесь собраны источники, до которых renderer реально достаёт:
 *   1. карусель YouTube Music — если её всё-таки передали (например, когда
 *      появится IPC для `browse`): это готовый честный ответ, и он главнее всего;
 *   2. соавторы и ремиксеры из названий собственных треков артиста — без сети;
 *   3. соседи по своим плейлистам и по истории прослушивания (Dexie) — без сети;
 *   4. авторы связанных видео (Piped/Invidious — простой GET, без предзапроса);
 *   5. поиск по имени артиста с отбрасыванием его самого.
 *
 * Сеть опрашивается только пока кандидатов мало, и ни один отказ не выходит
 * наружу: любой сбой источника — это просто отсутствие его вклада.
 */

import { UnifiedTrack } from '../types/music';
import { searchAggregator } from './aggregator';
import { getHistory, getPlaylists } from './db';
import { youtubeService } from './youtube';

/** Откуда взялся кандидат — этим подписана карточка, чтобы не выдумывать связь. */
export type SimilarArtistOrigin = 'youtube-music' | 'collab' | 'library' | 'related' | 'search';

export interface SimilarArtistSuggestion {
  name: string;
  /** Обложка трека этого исполнителя, когда она была; портрета у нас нет. */
  imageUrl?: string;
  browseId?: string;
  origin: SimilarArtistOrigin;
  score: number;
}

/**
 * `empty` — источники ответили, похожих не нашлось.
 * `unavailable` — спросить не удалось ни у кого; это разные сообщения в интерфейсе.
 */
export type SimilarArtistsStatus = 'ok' | 'empty' | 'unavailable';

export interface SimilarArtistsResult {
  artists: SimilarArtistSuggestion[];
  status: SimilarArtistsStatus;
}

export interface SimilarArtistsRequest {
  artistName: string;
  /** Треки артиста со страницы: из них берутся соавторы и семена для связанных. */
  topTracks?: readonly UnifiedTrack[];
  /** Карусель YouTube Music, если её удалось получить. */
  fromProfile?: readonly { name: string; imageUrl?: string; browseId?: string }[];
}

const MAX_SIMILAR = 12;
/** Столько кандидатов уже достаточно, чтобы не тратить сеть на следующий источник. */
const ENOUGH_CANDIDATES = 8;
/** Больше двух семян связанных видео не окупаются: это по десятку запросов каждое. */
const RELATED_SEEDS = 2;
const RELATED_PER_SEED = 20;
const SEARCH_LIMIT = 25;
const HISTORY_DEPTH = 200;
/** Полчаса — граница «слушали в один присест», а не «когда-то тоже слушал». */
const SESSION_WINDOW_MS = 30 * 60 * 1000;
/** Сколько имён максимум читаем из одного плейлиста. */
const MAX_PER_PLAYLIST = 12;

/**
 * Вес источника. Карусель YouTube Music недосягаемо выше остальных, потому что
 * это прямой ответ на тот же вопрос; дальше — своя медиатека, она про вкус
 * конкретного человека, и только потом машинные догадки.
 */
const ORIGIN_WEIGHT: Record<SimilarArtistOrigin, number> = {
  'youtube-music': 100,
  collab: 30,
  library: 20,
  related: 8,
  search: 4
};

/** Служебные хвосты каналов YouTube: они не часть имени. */
const CHANNEL_SUFFIX =
  /\s*[-–—]?\s*(?:topic|vevo|official(?:\s+(?:channel|video|audio))?|music\s+channel)\s*$/i;

/**
 * Слова, которых не бывает в имени исполнителя, но полно в имени канала или в
 * разобранном названии трека. Сравнение по целым словам, а не по подстроке:
 * иначе «Radiohead» уедет за «radio», а «Radio Tapok» — настоящее имя, поэтому
 * самого «radio» в списке нет.
 */
const JUNK_WORDS = new Set([
  'various',
  'va',
  'unknown',
  'topic',
  'vevo',
  'karaoke',
  'караоке',
  'nightcore',
  'daycore',
  'lyrics',
  'lyric',
  'playlist',
  'плейлист',
  'сборник',
  'подборка',
  'megamix',
  'compilation',
  'tribute',
  'ost',
  'soundtrack',
  'instrumental',
  'минусовка',
  'минус',
  'reupload',
  'unofficial'
]);

/** Оборотами, а не словами: каждое из них по отдельности встречается в именах. */
const JUNK_PHRASES = [
  /\bfull album\b/i,
  /\bgreatest hits\b/i,
  /\bno copyright\b/i,
  /\bfree music\b/i,
  /\bmusic (?:channel|library|group)\b/i,
  /\bбез слов\b/i,
  /\bлучшие песни\b/i
];

const MAX_NAME_LENGTH = 40;
const MAX_NAME_WORDS = 5;

/**
 * Имя без служебных хвостов и краевой пунктуации. Дважды, потому что каналы
 * вроде «X - Topic Official» носят два хвоста подряд.
 */
export function cleanArtistName(raw: string): string {
  let name = (raw || '').replace(/\s+/g, ' ').trim();

  for (let pass = 0; pass < 2; pass += 1) {
    const shortened = name.replace(CHANNEL_SUFFIX, '').trim();
    if (shortened === name || shortened.length === 0) break;
    name = shortened;
  }

  return name
    .replace(/^["'«“(\[\s.,\-–—]+/, '')
    .replace(/["'»”)\]\s.,\-–—]+$/, '')
    .trim();
}

/** Ключ сравнения: регистр и пунктуация не должны разводить одного человека на двух. */
export function normalizeArtistKey(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(key: string): string[] {
  return key.length === 0 ? [] : key.split(' ');
}

/** Идёт ли `needle` подряд внутри `haystack` — сравнение целыми словами. */
function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let hit = true;
    for (let i = 0; i < needle.length; i += 1) {
      if (haystack[start + i] !== needle[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * Тот же артист, что и на странице. Сравнение по словам, а не `includes`:
 * иначе «Asia» окажется тем же, что «Sia», а «Nirvana Tribute Band» —
 * отдельным исполнителем.
 */
export function isSameArtist(candidateKey: string, targetKey: string): boolean {
  if (!candidateKey || !targetKey) return false;
  if (candidateKey === targetKey) return true;
  const candidate = words(candidateKey);
  const target = words(targetKey);
  return containsRun(candidate, target) || containsRun(target, candidate);
}

/** Похоже ли это на имя исполнителя, а не на обрывок названия или на канал. */
export function isPlausibleArtistName(name: string): boolean {
  const trimmed = (name || '').trim();
  if (trimmed.length < 2 || trimmed.length > MAX_NAME_LENGTH) return false;
  if (/https?:|@|[|"]|\s-\s/i.test(trimmed)) return false;
  if (!/\p{L}/u.test(trimmed)) return false;
  if (JUNK_PHRASES.some((phrase) => phrase.test(trimmed))) return false;

  const key = normalizeArtistKey(trimmed);
  if (!key) return false;
  const parts = words(key);
  if (parts.length > MAX_NAME_WORDS) return false;
  return !parts.some((part) => JUNK_WORDS.has(part));
}

/**
 * Соавторы, ремиксеры и продюсеры из названия трека.
 *
 * Это единственный источник, который не требует ни сети, ни базы: «feat.»,
 * «(X Remix)» и «prod. by X» — прямое указание на живого человека рядом с
 * артистом, и оно уже лежит в названиях, которые страница и так загрузила.
 */
export function extractCollaborators(title: string): string[] {
  const text = (title || '').trim();
  if (!text) return [];

  const captures: string[] = [];

  const feature = /(?:feat\.?|ft\.?|featuring|w\/|при участии|совместно с)\s+([^()\[\]]+)/gi;
  const remix = /[(\[]\s*([^()\[\]]+?)\s+(?:remix|rmx|ремикс|bootleg|flip|vip\s*mix)\s*[)\]]/gi;
  const produced = /\bprod\.?\s*(?:by\s+)?([^()\[\],]+)/gi;

  for (const pattern of [feature, remix, produced]) {
    let match = pattern.exec(text);
    while (match) {
      captures.push(match[1]);
      match = pattern.exec(text);
    }
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const capture of captures) {
    for (const piece of capture.split(/\s*(?:,|&|\+|\/|\bx\b|\bvs\.?\b|\band\b|\bи\b)\s*/i)) {
      const name = cleanArtistName(piece);
      if (!isPlausibleArtistName(name)) continue;
      const key = normalizeArtistKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

interface RawHit {
  name: string;
  origin: SimilarArtistOrigin;
  imageUrl?: string;
  browseId?: string;
}

interface SourceOutcome {
  /** Источник ответил хоть чем-то — отличает «ничего похожего» от «не спросили». */
  answered: boolean;
  hits: RawHit[];
}

const NOTHING: SourceOutcome = { answered: false, hits: [] };

/**
 * Складывает кандидатов, схлопывая одного исполнителя из разных источников в
 * одну карточку и суммируя вес: тот, кого назвали и плейлисты, и связанные
 * видео, стоит выше того, кто мелькнул один раз.
 */
class Collector {
  private readonly entries = new Map<string, { item: SimilarArtistSuggestion; order: number }>();
  private counter = 0;

  constructor(private readonly targetKey: string) {}

  public get size(): number {
    return this.entries.size;
  }

  public add(hit: RawHit): boolean {
    const name = cleanArtistName(hit.name);
    if (!isPlausibleArtistName(name)) return false;

    const key = normalizeArtistKey(name);
    if (isSameArtist(key, this.targetKey)) return false;

    const existing = this.entries.get(key);
    if (existing) {
      existing.item.score += ORIGIN_WEIGHT[hit.origin];
      // Подпись карточки — от самого надёжного источника, который её назвал.
      if (ORIGIN_WEIGHT[hit.origin] > ORIGIN_WEIGHT[existing.item.origin]) {
        existing.item.origin = hit.origin;
        existing.item.name = name;
      }
      existing.item.imageUrl = existing.item.imageUrl || hit.imageUrl;
      existing.item.browseId = existing.item.browseId || hit.browseId;
      return true;
    }

    this.counter += 1;
    this.entries.set(key, {
      order: this.counter,
      item: {
        name,
        imageUrl: hit.imageUrl,
        browseId: hit.browseId,
        origin: hit.origin,
        score: ORIGIN_WEIGHT[hit.origin]
      }
    });
    return true;
  }

  /** По весу, при равном весе — в порядке поступления, чтобы выдача не плавала. */
  public list(limit = MAX_SIMILAR): SimilarArtistSuggestion[] {
    return [...this.entries.values()]
      .sort((a, b) => b.item.score - a.item.score || a.order - b.order)
      .slice(0, limit)
      .map((entry) => entry.item);
  }
}

export class SimilarArtistsService {
  private cache = new Map<string, SimilarArtistsResult>();
  /** Один круг опроса на всех, кто спросил про то же имя одновременно. */
  private inFlight = new Map<string, Promise<SimilarArtistsResult>>();

  public clearCache(artistName?: string): void {
    if (!artistName) {
      this.cache.clear();
      this.inFlight.clear();
      return;
    }
    const key = artistName.trim().toLowerCase();
    this.cache.delete(key);
    this.inFlight.delete(key);
  }

  /**
   * Похожие на `artistName`. Никогда не бросает: неудача источника — это
   * отсутствие его вклада, а не ошибка страницы.
   */
  public async getSimilarArtists(request: SimilarArtistsRequest): Promise<SimilarArtistsResult> {
    const name = (request.artistName || '').trim();
    if (!name) return { artists: [], status: 'empty' };

    const cacheKey = name.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const task = this.collect(name, request)
      .catch((err) => {
        console.warn('[SimilarArtists] Подбор похожих не удался:', err);
        const failed: SimilarArtistsResult = { artists: [], status: 'unavailable' };
        return failed;
      })
      .then((result) => {
        // Недоступность не кешируется: связь вернётся, а ответ остался бы пустым.
        if (result.status !== 'unavailable') this.cache.set(cacheKey, result);
        return result;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });

    this.inFlight.set(cacheKey, task);
    return task;
  }

  private async collect(name: string, request: SimilarArtistsRequest): Promise<SimilarArtistsResult> {
    const targetKey = normalizeArtistKey(cleanArtistName(name));
    const collector = new Collector(targetKey);

    // 1. Готовый ответ YouTube Music. Смешивать с ним догадки нельзя — он про то
    //    же самое и точнее, поэтому при нём остальные источники не опрашиваются.
    for (const item of request.fromProfile ?? []) {
      collector.add({
        name: item.name,
        origin: 'youtube-music',
        imageUrl: item.imageUrl,
        browseId: item.browseId
      });
    }
    if (collector.size > 0) return { artists: collector.list(), status: 'ok' };

    const tracks = [...(request.topTracks ?? [])];
    let answered = false;

    // 2. Соавторы из названий — бесплатно и точно.
    for (const track of tracks) {
      for (const collaborator of extractCollaborators(track.title)) {
        collector.add({ name: collaborator, origin: 'collab' });
      }
    }

    // 3. Своя медиатека: кто стоит рядом в плейлистах и в истории.
    const library = await this.fromLibrary(targetKey);
    answered = answered || library.answered;
    for (const hit of library.hits) collector.add(hit);

    // 4. Авторы связанных видео.
    if (collector.size < ENOUGH_CANDIDATES) {
      const related = await this.fromRelated(tracks);
      answered = answered || related.answered;
      for (const hit of related.hits) collector.add(hit);
    }

    // 5. Поиск по имени: кто ещё попадает в выдачу рядом с артистом.
    if (collector.size < ENOUGH_CANDIDATES) {
      const found = await this.fromSearch(name);
      answered = answered || found.answered;
      for (const hit of found.hits) collector.add(hit);
    }

    const artists = collector.list();
    if (artists.length > 0) return { artists, status: 'ok' };
    return { artists: [], status: answered ? 'empty' : 'unavailable' };
  }

  /**
   * Совместная встречаемость в собственных данных человека: плейлист, в котором
   * есть этот артист, называет остальных своих; история — тех, кого слушали в тот
   * же присест.
   */
  private async fromLibrary(targetKey: string): Promise<SourceOutcome> {
    try {
      const [playlists, history] = await Promise.all([getPlaylists(), getHistory(HISTORY_DEPTH)]);
      const hits: RawHit[] = [];

      for (const playlist of playlists) {
        const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
        const mentionsTarget = tracks.some((track) =>
          isSameArtist(normalizeArtistKey(cleanArtistName(track?.artist || '')), targetKey)
        );
        if (!mentionsTarget) continue;

        const seen = new Set<string>();
        for (const track of tracks) {
          if (seen.size >= MAX_PER_PLAYLIST) break;
          const name = cleanArtistName(track?.artist || '');
          const key = normalizeArtistKey(name);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          hits.push({ name, origin: 'library', imageUrl: track?.artworkUrl || undefined });
        }
      }

      const targetPlays = history
        .filter((record) =>
          isSameArtist(normalizeArtistKey(cleanArtistName(record?.track?.artist || '')), targetKey)
        )
        .map((record) => record.playedAt);

      if (targetPlays.length > 0) {
        for (const record of history) {
          const name = cleanArtistName(record?.track?.artist || '');
          const key = normalizeArtistKey(name);
          if (!key || isSameArtist(key, targetKey)) continue;
          const nearby = targetPlays.some(
            (stamp) => Math.abs(stamp - record.playedAt) <= SESSION_WINDOW_MS
          );
          if (!nearby) continue;
          hits.push({ name, origin: 'library', imageUrl: record?.track?.artworkUrl || undefined });
        }
      }

      return { answered: playlists.length > 0 || history.length > 0, hits };
    } catch (err) {
      console.warn('[SimilarArtists] Медиатека недоступна:', err);
      return NOTHING;
    }
  }

  /**
   * Авторы связанных видео. Это единственный сетевой источник, который в
   * приложении уже работает: простой GET на зеркала Piped/Invidious, без
   * предзапроса CORS.
   */
  private async fromRelated(tracks: readonly UnifiedTrack[]): Promise<SourceOutcome> {
    const seeds = tracks
      .filter((track) => track?.source === 'youtube' && Boolean(track.originalId))
      .slice(0, RELATED_SEEDS);
    if (seeds.length === 0) return NOTHING;

    let answered = false;
    const hits: RawHit[] = [];

    for (const seed of seeds) {
      try {
        const related = await youtubeService.getRelatedVideos(seed.originalId, RELATED_PER_SEED);
        if (related.length > 0) answered = true;
        for (const track of related) {
          hits.push({
            name: cleanArtistName(track.artist || ''),
            origin: 'related',
            imageUrl: track.artworkUrl || undefined
          });
        }
      } catch (err) {
        console.warn('[SimilarArtists] Связанные видео недоступны:', err);
      }
    }

    return { answered, hits };
  }

  /** Поиск по имени артиста: в выдаче рядом с ним стоят его же соседи по сцене. */
  private async fromSearch(name: string): Promise<SourceOutcome> {
    try {
      const { results } = await searchAggregator.search(name, { limit: SEARCH_LIMIT, source: 'all' });
      return {
        answered: results.length > 0,
        hits: results.map((track) => ({
          name: cleanArtistName(track.artist || ''),
          origin: 'search' as const,
          imageUrl: track.artworkUrl || undefined
        }))
      };
    } catch (err) {
      console.warn('[SimilarArtists] Поиск по имени не ответил:', err);
      return NOTHING;
    }
  }
}

export const similarArtistsService = new SimilarArtistsService();
