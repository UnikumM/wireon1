/**
 * Профиль вкуса — единственный источник правды о том, что человек любит.
 *
 * Здесь нет ни одного сетевого вызова: на входе выписки из Dexie, на выходе
 * веса. Поэтому весь подбор целиком проверяется тестами без сети, а «Поток»
 * перестаёт быть чёрным ящиком: любую подпись под треком можно вывести из чисел,
 * посчитанных этим файлом.
 *
 * Три вещи, которых в прежнем профиле не было и из-за которых «Поток» звучал
 * чужим:
 *
 * 1. **Затухание по времени.** Прослушивание годовой давности весило столько же,
 *    сколько вчерашнее, — профиль намертво замирал на том, что человек слушал,
 *    когда только поставил приложение.
 * 2. **Отрицательные сигналы на уровне артиста.** Пропуск увеличивал `playCount`
 *    и, значит, поднимал вес артиста: чем усерднее человек выключал, тем настойчивее
 *    ему это возвращали. Теперь пропуск — минус, а ранний пропуск — большой минус.
 * 3. **Разные имена одного артиста.** Веса лежали в одной карте и в нормализованном,
 *    и в исходном написании, и «топ-3 артиста» на деле оказывались одним артистом,
 *    посчитанным трижды.
 */

import { UnifiedTrack, Playlist } from '../types/music';
// Только типы: иначе получилось бы кольцо `db → tasteProfile → db`, ведь порог
// раннего пропуска нужен и записи в базу, и подсчёту весов.
import type { DislikeRecord, HistoryRecord } from './db';
import { isPlaceholderArtist } from '../utils/placeholders';

/** Нормализация имени артиста: регистр, пунктуация и лишние пробелы не значат ничего. */
export function normalizeArtistKey(artist: string | null | undefined): string {
  return (artist || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Полураспад интереса — 45 суток.
 *
 * Выбрано под живого слушателя, а не под красивую формулу: за полтора месяца
 * вкус успевает сдвинуться, но не обнулиться, поэтому прошлогодний период
 * влияет на «Поток» примерно в двадцать раз слабее последней недели
 * (0.5^(365/45) ≈ 0.0035 против почти единицы), а не наравне с ней.
 */
export const TASTE_HALF_LIFE_MS = 45 * 24 * 60 * 60 * 1000;

/** Треки, которых не было слышно дольше этого, считаются забытыми. */
export const FORGOTTEN_AFTER_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * Ранний пропуск — самый сильный отрицательный сигнал, какой вообще можно снять
 * без слов. Тридцать секунд — граница, на которой сходятся исследования
 * потоковых сессий: выключил до неё — значит не подошло, а не «не то
 * настроение».
 */
export const EARLY_SKIP_SECONDS = 30;

/**
 * Доля трека, после которой прослушивание считается зачтённым.
 *
 * Дослушивать до конца никто не обязан: последние секунды — это затухание,
 * аутро и тишина, и уход на 92% ничем не отличается от полного прослушивания.
 */
export const COMPLETION_RATIO = 0.85;

/** Веса сигналов. Всё, что человек сделал руками, весит больше того, что просто случилось. */
export const SIGNAL_WEIGHTS = {
  /** Трек доигран до конца. */
  completion: 1.6,
  /** Трек включали, но чем кончилось — неизвестно (старые записи без счётчиков). */
  neutralPlay: 0.5,
  /** «В избранное» — явное «да», поэтому без затухания. */
  favorite: 4.0,
  /** Трек лежит в плейлисте пользователя — тоже осознанный выбор. */
  playlist: 2.0,
  /** Выключили ближе к концу: скорее «не сейчас», чем «не надо». */
  lateSkip: -0.9,
  /** Выключили в первые 30 секунд. */
  earlySkip: -2.4,
  /** «Не нравится» по конкретному треку — минус и его артисту, но не приговор. */
  dislikedTrack: -2.0
} as const;

/** Вес артиста ниже этого — артист отвергнут, и в «Потоке» его быть не должно. */
export const REJECTED_ARTIST_WEIGHT = -1.5;

/** Со скольких пропусков подряд без единого доигранного раза трек считается отвергнутым. */
export const SKIPS_BEFORE_REJECT = 2;

/**
 * Жанровые и стилевые слова, которые действительно встречаются в названиях
 * треков и именах каналов на YouTube и SoundCloud.
 *
 * Свободные токены из названий брать нельзя: там «official», «video», «feat»,
 * «prod» и номера частей, то есть шум, который перетянул бы на себя весь вес.
 * Поэтому список закрытый — зато каждое попадание в него что-то значит.
 */
export const GENRE_TOKENS: readonly string[] = [
  'rock', 'metal', 'punk', 'hardcore', 'grunge', 'emo', 'shoegaze', 'postrock', 'industrial',
  'jazz', 'blues', 'funk', 'soul', 'rnb', 'disco', 'gospel',
  'hiphop', 'rap', 'trap', 'drill', 'phonk', 'boombap', 'grime',
  'house', 'techno', 'trance', 'dnb', 'dubstep', 'edm', 'electro', 'garage', 'breakbeat',
  'ambient', 'lofi', 'chillhop', 'downtempo', 'synthwave', 'vaporwave', 'darkwave', 'idm',
  'pop', 'kpop', 'jpop', 'indie', 'folk', 'country', 'americana', 'bluegrass',
  'classical', 'piano', 'orchestral', 'opera', 'soundtrack', 'ost', 'score',
  'reggae', 'ska', 'dancehall', 'afrobeat', 'latin', 'salsa', 'bossa', 'flamenco',
  'рок', 'метал', 'панк', 'рэп', 'поп', 'шансон', 'джаз', 'блюз', 'электроника', 'классика'
];

const GENRE_TOKEN_SET = new Set(GENRE_TOKENS);

/**
 * Слова, которые пишутся по-разному, а значат одно. Без этого «hip hop»,
 * «hip-hop» и «hiphop» были бы тремя разными жанрами с третью веса каждый.
 */
const TOKEN_ALIASES: Record<string, string> = {
  'hip': 'hiphop',
  'hop': 'hiphop',
  'hip hop': 'hiphop',
  'lo': 'lofi',
  'fi': 'lofi',
  'lo fi': 'lofi',
  'drum': 'dnb',
  'bass': 'dnb',
  'drum and bass': 'dnb',
  'r&b': 'rnb',
  'randb': 'rnb',
  'k': 'kpop',
  'post': 'postrock',
  'boom': 'boombap',
  'bap': 'boombap',
  'хип': 'hiphop',
  'хоп': 'hiphop',
  'металл': 'метал'
};

/** Стилевые слова из названия и имени артиста. Пустой набор — норма, а не сбой. */
export function extractGenreTokens(track: Pick<UnifiedTrack, 'title' | 'artist'>): string[] {
  const haystack = `${track?.title || ''} ${track?.artist || ''}`.toLowerCase();
  // Дефисы и амперсанды склеивают слова, поэтому сначала разрезаем по ним.
  const words = haystack.split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
  const found = new Set<string>();

  for (const word of words) {
    const alias = TOKEN_ALIASES[word];
    const token = alias || word;
    if (GENRE_TOKEN_SET.has(token)) found.add(token);
  }

  // Составные написания ловим по подстроке: «hip-hop» уже распалось на слова, а
  // «hiphop» одним куском мог и не попасть в список выше.
  for (const compound of ['hip hop', 'lo fi', 'drum and bass', 'post rock', 'boom bap']) {
    if (haystack.includes(compound)) {
      const canonical = TOKEN_ALIASES[compound];
      if (canonical) found.add(canonical);
    }
  }

  return Array.from(found);
}

export interface ArtistTaste {
  /** Нормализованный ключ — по нему всё и сходится. */
  key: string;
  /** Как имя писал источник: годится для запроса и для подписи. */
  name: string;
  /** Итоговый вес. Отрицательный — человек этого артиста отвергает. */
  weight: number;
  plays: number;
  completions: number;
  skips: number;
  earlySkips: number;
  favorites: number;
  playlistHits: number;
  /** Когда артиста слушали последний раз. 0 — никогда. */
  lastPlayedAt: number;
}

export interface TrackTaste {
  id: string;
  plays: number;
  completions: number;
  skips: number;
  earlySkips: number;
  lastPlayedAt: number;
  /** Пропускали и ни разу не дослушивали — тихое «не надо». */
  rejected: boolean;
}

export interface TasteProfile {
  artists: Map<string, ArtistTaste>;
  /** Различные нормализованные ключи по убыванию веса. Без дублей написаний. */
  topArtists: string[];
  /** Имена тех же артистов в исходном написании, позиция к позиции. */
  topArtistNames: string[];
  rejectedArtists: Set<string>;
  /** Стилевые слова с весами: во что человек попадает чаще всего. */
  tagWeights: Map<string, number>;
  topTags: string[];
  tracks: Map<string, TrackTaste>;
  favoriteTrackIds: Set<string>;
  dislikedTrackIds: Set<string>;
  /** Треки, отвергнутые молча: два пропуска и ни одного дослушивания. */
  rejectedTrackIds: Set<string>;
  recentTrackIds: Set<string>;
  lastPlayedAt: Map<string, number>;
  /**
   * Кто с кем лежит в одном плейлисте пользователя. Единственная доступная нам
   * замена матрице совместных прослушиваний: своих плейлистов мало, но они
   * собраны руками, поэтому связь в них честная.
   */
  coArtists: Map<string, Map<string, number>>;
  totalPlays: number;
  /** Наибольший положительный вес — им нормируются близости к профилю. */
  maxArtistWeight: number;
  /**
   * Насколько профилю можно верить, 0..1. Пустая библиотека — ноль, и тогда
   * «Поток» честно уходит в общедоступное, а не притворяется персональным.
   */
  strength: number;
  builtAt: number;
}

export interface TasteSignals {
  history?: HistoryRecord[];
  favorites?: UnifiedTrack[];
  playlists?: Playlist[];
  dislikes?: DislikeRecord[];
  /**
   * Живые поправки текущей сессии: «больше такого», лайк и пропуск должны быть
   * слышны сразу, а не после перезапуска.
   */
  artistBoosts?: Map<string, number> | Record<string, number>;
  now?: number;
}

/** Множитель затухания для события возраста `age`. */
export function decayFactor(ageMs: number, halfLifeMs: number = TASTE_HALF_LIFE_MS): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

function ensureArtist(map: Map<string, ArtistTaste>, key: string, name: string): ArtistTaste {
  const existing = map.get(key);
  if (existing) {
    // Имя без заглушки лучше заглушки, даже если пришло позже.
    if (isPlaceholderArtist(existing.name) && !isPlaceholderArtist(name)) existing.name = name;
    return existing;
  }
  const created: ArtistTaste = {
    key,
    name,
    weight: 0,
    plays: 0,
    completions: 0,
    skips: 0,
    earlySkips: 0,
    favorites: 0,
    playlistHits: 0,
    lastPlayedAt: 0
  };
  map.set(key, created);
  return created;
}

function addTag(tags: Map<string, number>, token: string, weight: number): void {
  if (!token || !Number.isFinite(weight)) return;
  tags.set(token, (tags.get(token) || 0) + weight);
}

function toBoostMap(input: TasteSignals['artistBoosts']): Map<string, number> {
  if (!input) return new Map();
  if (input instanceof Map) return input;
  return new Map(Object.entries(input));
}

/**
 * Сколько раз трек доигран, выключен рано и выключен поздно.
 *
 * История хранит счётчики, а не журнал событий, поэтому раскладку приходится
 * восстанавливать: `playCount` — сколько раз включали, из них известны
 * дослушивания и пропуски, остальное — «неизвестно чем кончилось». Ранние
 * пропуски пишутся отдельно и, значит, входят в общий `skipCount`.
 */
function splitPlays(record: HistoryRecord): {
  plays: number;
  completions: number;
  earlySkips: number;
  lateSkips: number;
  neutral: number;
} {
  const plays = Math.max(0, Math.round(record.playCount || 0));
  const completions = Math.max(0, Math.round(record.completedCount || 0));
  const skips = Math.max(0, Math.round(record.skipCount || 0));
  const earlySkips = Math.min(skips, Math.max(0, Math.round(record.earlySkipCount || 0)));
  const lateSkips = skips - earlySkips;
  const neutral = Math.max(0, plays - completions - skips);
  return { plays, completions, earlySkips, lateSkips, neutral };
}

/**
 * Считает профиль вкуса. Чистая функция: одни и те же выписки дают один и тот же
 * профиль, поэтому её можно и нужно проверять без сети и без базы.
 */
export function buildTasteProfile(signals: TasteSignals): TasteProfile {
  const now = signals.now ?? Date.now();
  const history = signals.history || [];
  const favorites = signals.favorites || [];
  const playlists = signals.playlists || [];
  const dislikes = signals.dislikes || [];
  const boosts = toBoostMap(signals.artistBoosts);

  const artists = new Map<string, ArtistTaste>();
  const tracks = new Map<string, TrackTaste>();
  const tagWeights = new Map<string, number>();
  const favoriteTrackIds = new Set<string>();
  const dislikedTrackIds = new Set<string>();
  const rejectedTrackIds = new Set<string>();
  const recentTrackIds = new Set<string>();
  const lastPlayedAt = new Map<string, number>();
  const coArtists = new Map<string, Map<string, number>>();
  let totalPlays = 0;

  // --- История: единственный источник, где есть и «за», и «против» ---
  const sortedHistory = [...history]
    .filter((record) => record && record.id)
    .sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0));

  for (const record of sortedHistory) {
    const playedAt = Number.isFinite(record.playedAt) ? record.playedAt : 0;
    const decay = decayFactor(now - playedAt);
    const { plays, completions, earlySkips, lateSkips, neutral } = splitPlays(record);
    totalPlays += plays;

    recentTrackIds.add(record.id);
    if (playedAt > 0 && !lastPlayedAt.has(record.id)) lastPlayedAt.set(record.id, playedAt);

    const rejected = completions === 0 && earlySkips + lateSkips >= SKIPS_BEFORE_REJECT;
    if (rejected) rejectedTrackIds.add(record.id);
    tracks.set(record.id, {
      id: record.id,
      plays,
      completions,
      skips: earlySkips + lateSkips,
      earlySkips,
      lastPlayedAt: playedAt,
      rejected
    });

    // Вес события считается до затухания, чтобы знак не зависел от давности:
    // старый пропуск остаётся пропуском, просто тише.
    const raw =
      completions * SIGNAL_WEIGHTS.completion +
      neutral * SIGNAL_WEIGHTS.neutralPlay +
      lateSkips * SIGNAL_WEIGHTS.lateSkip +
      earlySkips * SIGNAL_WEIGHTS.earlySkip;
    const contribution = raw * decay;

    const artistName = record.track?.artist || '';
    if (artistName && !isPlaceholderArtist(artistName)) {
      const key = normalizeArtistKey(artistName);
      if (key) {
        const taste = ensureArtist(artists, key, artistName.trim());
        taste.weight += contribution;
        taste.plays += plays;
        taste.completions += completions;
        taste.skips += earlySkips + lateSkips;
        taste.earlySkips += earlySkips;
        if (playedAt > taste.lastPlayedAt) taste.lastPlayedAt = playedAt;
      }
    }

    if (record.track && contribution !== 0) {
      for (const token of extractGenreTokens(record.track)) {
        addTag(tagWeights, token, contribution);
      }
    }
  }

  // --- Избранное: явное «да», поэтому без затухания ---
  for (const fav of favorites) {
    if (!fav || !fav.id) continue;
    favoriteTrackIds.add(fav.id);
    // Лайк отменяет тихий отказ: человек сказал словами, а не пропуском.
    rejectedTrackIds.delete(fav.id);
    if (fav.artist && !isPlaceholderArtist(fav.artist)) {
      const key = normalizeArtistKey(fav.artist);
      if (key) {
        const taste = ensureArtist(artists, key, fav.artist.trim());
        taste.weight += SIGNAL_WEIGHTS.favorite;
        taste.favorites += 1;
      }
    }
    for (const token of extractGenreTokens(fav)) {
      addTag(tagWeights, token, SIGNAL_WEIGHTS.favorite);
    }
  }

  // --- Плейлисты: и веса, и связи «кто с кем лежит рядом» ---
  for (const playlist of playlists) {
    const inPlaylist: string[] = [];
    for (const track of playlist?.tracks || []) {
      if (!track || !track.artist || isPlaceholderArtist(track.artist)) continue;
      const key = normalizeArtistKey(track.artist);
      if (!key) continue;
      const taste = ensureArtist(artists, key, track.artist.trim());
      taste.weight += SIGNAL_WEIGHTS.playlist;
      taste.playlistHits += 1;
      for (const token of extractGenreTokens(track)) {
        addTag(tagWeights, token, SIGNAL_WEIGHTS.playlist);
      }
      if (!inPlaylist.includes(key)) inPlaylist.push(key);
    }

    // Связь считается один раз на плейлист, а не на каждую пару треков: иначе
    // альбом из двадцати песен одного артиста перевесил бы всё остальное.
    for (const a of inPlaylist) {
      for (const b of inPlaylist) {
        if (a === b) continue;
        const row = coArtists.get(a) || new Map<string, number>();
        row.set(b, (row.get(b) || 0) + 1);
        coArtists.set(a, row);
      }
    }
  }

  // --- «Не нравится»: минус треку и его артисту ---
  for (const dislike of dislikes) {
    if (!dislike || !dislike.id) continue;
    dislikedTrackIds.add(dislike.id);
    if (dislike.artist && !isPlaceholderArtist(dislike.artist)) {
      const key = normalizeArtistKey(dislike.artist);
      if (key) {
        const taste = ensureArtist(artists, key, dislike.artist.trim());
        taste.weight += SIGNAL_WEIGHTS.dislikedTrack;
      }
    }
  }

  // --- Поправки сессии ---
  for (const [rawKey, delta] of boosts) {
    const key = normalizeArtistKey(rawKey);
    if (!key || !Number.isFinite(delta) || delta === 0) continue;
    const taste = ensureArtist(artists, key, rawKey);
    taste.weight += delta;
  }

  const ranked = Array.from(artists.values()).sort(
    (a, b) => b.weight - a.weight || b.plays - a.plays || a.key.localeCompare(b.key)
  );
  const liked = ranked.filter((taste) => taste.weight > 0);

  const rejectedArtists = new Set(
    ranked.filter((taste) => taste.weight <= REJECTED_ARTIST_WEIGHT).map((taste) => taste.key)
  );

  const topTags = Array.from(tagWeights.entries())
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token]) => token);

  const maxArtistWeight = liked.length > 0 ? liked[0].weight : 0;

  // Уверенность растёт с числом любимых артистов и упирается в единицу на шести:
  // на трёх артистах персональная подборка ещё натянута, на шести — уже нет.
  const strength = Math.max(0, Math.min(1, liked.length / 6));

  return {
    artists,
    topArtists: liked.map((taste) => taste.key),
    topArtistNames: liked.map((taste) => taste.name),
    rejectedArtists,
    tagWeights,
    topTags,
    tracks,
    favoriteTrackIds,
    dislikedTrackIds,
    rejectedTrackIds,
    recentTrackIds,
    lastPlayedAt,
    coArtists,
    totalPlays,
    maxArtistWeight,
    strength,
    builtAt: now
  };
}

/** Пустой профиль: нужен и на холодном старте, и там, где база недоступна. */
export function emptyTasteProfile(now: number = Date.now()): TasteProfile {
  return buildTasteProfile({ now });
}

/** Близость артиста к профилю, 0..1. Отвергнутый артист даёт ноль. */
export function artistAffinity(profile: TasteProfile, artist: string): number {
  const key = normalizeArtistKey(artist);
  if (!key) return 0;
  const taste = profile.artists.get(key);
  if (!taste || taste.weight <= 0) return 0;
  if (profile.maxArtistWeight <= 0) return 0;
  return Math.max(0, Math.min(1, taste.weight / profile.maxArtistWeight));
}

/** Насколько стилевые слова трека совпадают с профилем, 0..1. */
export function tagAffinity(profile: TasteProfile, track: Pick<UnifiedTrack, 'title' | 'artist'>): number {
  const tokens = extractGenreTokens(track);
  if (tokens.length === 0) return 0;
  let best = 0;
  for (const [, weight] of profile.tagWeights) {
    if (weight > best) best = weight;
  }
  if (best <= 0) return 0;
  let sum = 0;
  for (const token of tokens) {
    sum += Math.max(0, profile.tagWeights.get(token) || 0);
  }
  // Нормируем по лучшему тегу, а не по сумме: два попадания должны быть заметно
  // лучше одного, но не давать больше единицы.
  return Math.max(0, Math.min(1, sum / best));
}

/**
 * Артисты, которые лежат в одном плейлисте с любимыми. Отдельный источник
 * кандидатов: связь собрана руками человека, а не угадана.
 */
export function playlistNeighbours(profile: TasteProfile, limit: number = 10): string[] {
  const scores = new Map<string, number>();
  const seeds = profile.topArtists.slice(0, 8);
  const seedSet = new Set(seeds);

  for (const seed of seeds) {
    const row = profile.coArtists.get(seed);
    if (!row) continue;
    const seedWeight = profile.artists.get(seed)?.weight || 0;
    if (seedWeight <= 0) continue;
    for (const [neighbour, count] of row) {
      if (seedSet.has(neighbour)) continue;
      if (profile.rejectedArtists.has(neighbour)) continue;
      scores.set(neighbour, (scores.get(neighbour) || 0) + count * seedWeight);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([key]) => key);
}
