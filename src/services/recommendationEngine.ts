import { UnifiedTrack } from '../types/music';
import { FEEDBACK_DELTA } from './waveMemory';
import {
  getFavorites,
  getHistory,
  getPlaylists,
  getDislikedTrackIds,
  getDislikes,
  addFavorite,
  addDislike,
  recordTrackSkip,
  recordTrackCompletion
} from './db';
import { youtubeService, YouTubeService } from './youtube';
import { soundCloudService, SoundCloudService } from './soundcloud';
import { isPlaceholderArtist } from '../utils/placeholders';

export type WaveMood = 'favorite' | 'discovery' | 'energy' | 'chill' | 'focus';
export type WaveSeedKind = 'library' | 'discovery' | 'artist' | 'forgotten' | 'track';

export interface WaveConfig {
  mood: WaveMood;
  genre?: string;
  seedTrack?: UnifiedTrack;
  /**
   * 0 — только знакомое, 1 — только незнакомое. Задан — значит, волну ведут
   * регуляторы, а `mood` остаётся лишь подписью.
   */
  novelty?: number;
  /** 0 — спокойное, 1 — бодрое. */
  energy?: number;
  seedKind?: WaveSeedKind;
  seedArtist?: string;
}

export type FeedbackAction = 'like' | 'dislike' | 'skip' | 'more_like_this' | 'complete';

export interface UserProfile {
  artistAffinities: Map<string, number>;
  genreAffinities?: Map<string, number>;
  topArtists: string[];
  dislikedTrackIds: Set<string>;
  recentTrackIds: Set<string>;
  favoriteTrackIds: Set<string>;
  /**
   * Треки, которые выключали и ни разу не дослушали. Тихий отказ: человек не
   * жал «не нравится», но каждый раз пропускал, и возвращать их — навязчивость.
   */
  skippedTrackIds?: Set<string>;
  totalPlays: number;
  artistPlayCounts: Map<string, number>;
  artistFavoriteCounts: Map<string, number>;
  artistPlaylistCounts: Map<string, number>;
  /** Когда трек слушали в последний раз. Нужно для «Забытого» и объяснений. */
  lastPlayedAt?: Map<string, number>;
}

export interface ScoredCandidate {
  track: UnifiedTrack;
  score: number;
  affinityScore: number;
  moodScore: number;
  noveltyScore: number;
  genreBonus: number;
  recencyPenalty: number;
  /** 1 — трек не пропускали; меньше — пропускали и не дослушивали. */
  skipPenalty?: number;
}

export interface RecommendationEngine {
  getRecommendationsForWave: (
    config: WaveConfig,
    limit?: number,
    excludeIds?: Set<string>
  ) => Promise<UnifiedTrack[]>;
  getTrackRadio: (
    seedTrack: UnifiedTrack,
    limit?: number,
    excludeIds?: Set<string>
  ) => Promise<UnifiedTrack[]>;
  recordFeedback: (
    track: UnifiedTrack,
    action: FeedbackAction
  ) => Promise<void>;
  buildUserProfile: () => Promise<UserProfile>;
}

/** Radio duration boundaries (30s to 15m) */
export const RADIO_MIN_DURATION = 30;
export const RADIO_MAX_DURATION = 900;
export const RADIO_TOPUP_MAX_DURATION = 1800;

/** Long-form uploads to exclude from music radio */
export const LONG_FORM_TITLE_PATTERN =
  /\b(?:full album|album completo|podcast|episode|ep\.?\s*\d+|compilation|megamix|dj set|liveset|live set|playlist|non[- ]stop|\d+\s*hours?)\b/i;

/**
 * Мусор, которым забита музыкальная поисковая выдача.
 *
 * Караоке, «8D audio», ускоренные и замедленные перезаливки, реакции и уроки
 * игры — формально это музыка с правильным названием и артистом, поэтому поиск
 * честно ставит их рядом с оригиналом, и в волну они попадали пачками. Для
 * человека это выглядит как поломка: просил музыку — получил минусовку.
 *
 * Кавер отсекается только когда сказано прямо («cover by», «acoustic cover»):
 * само слово `cover` встречается и в обычных названиях песен. По той же причине
 * здесь `reaction video`, а не `reaction` — иначе под нож уйдёт «Chain
 * Reaction».
 */
export const POLLUTION_TITLE_PATTERN =
  /\b(?:karaoke|8d\s*audio|nightcore|daycore|sped\s*up|spedup|slowed(?:\s*(?:down|and|\+))?\s*reverb|slowed\s*down|reverb\s*version|asmr|reaction\s+video|reacts\s+to|tutorial|how\s+to\s+play|guitar\s+(?:lesson|tabs?)|backing\s*track|instrumental\s+version|ringtone|(?:acoustic|piano|guitar|vocal|metal|rock|drum)\s+cover|cover\s+by|cover\s+version)\b/i;

/**
 * Разнообразие выдачи. Поток из десяти треков, где семь — один артист, звучит
 * как зажёванная пластинка, даже если каждый трек по отдельности подходит.
 */
/** Сколько треков одного артиста допустимо в одной выдаче. */
const MAX_TRACKS_PER_ARTIST = 2;
/** Столько же треков одного артиста, но для волны «от артиста» и радио трека. */
const MAX_TRACKS_PER_SEED_ARTIST = 3;
/** Минимальный разнос между треками одного артиста: два чужих трека между ними. */
const MIN_ARTIST_GAP = 3;
/** Сколько треков подряд может дать один источник. */
const MAX_SAME_SOURCE_RUN = 3;
/**
 * Со скольких годных треков радио от песни считается ответившим и поиск по
 * ключевым словам уже не запускается.
 *
 * Восемь, а не полный лимит: радио отдаёт пятьдесят позиций, но после отсева по
 * длительности и мусорным названиям остаётся заметно меньше, и по строгому
 * порогу поиск включался бы почти всегда — то есть починка бы не работала.
 */
const WAVE_SEED_RADIO_SUFFICIENT = 8;
/**
 * Сколько раз продлить радио, зацепившись за трек из уже полученных.
 *
 * Так пул добирается тем же способом, которым начался, вместо поиска по словам:
 * от фонка идёт фонк, а не «всё подряд».
 */
const RADIO_CHAIN_HOPS = 3;
/** Во столько раз падает счёт трека, который пропускали и не дослушивали. */
const SKIPPED_TRACK_PENALTY = 0.35;
/** Со скольких пропусков подряд трек считается отвергнутым. */
export const SKIPS_BEFORE_PENALTY = 2;

/** Mood keyword lexicons for content matching */
const MOOD_KEYWORDS: Record<WaveMood, string[]> = {
  favorite: ['hits', 'best', 'greatest', 'popular', 'top', 'favorites'],
  discovery: ['new', 'indie', 'discovery', 'fresh', 'emerging', 'underground', 'gems', 'unreleased'],
  energy: [
    'energy',
    'workout',
    'gym',
    'electronic',
    'rock',
    'dance',
    'bass',
    'edm',
    'dnb',
    'drum and bass',
    'phonk',
    'metal',
    'power',
    'pump',
    'upbeat',
    'fast',
    'banger',
    'party',
    'hype',
    'hard'
  ],
  chill: [
    'chill',
    'relax',
    'ambient',
    'acoustic',
    'calm',
    'sleep',
    'peaceful',
    'soft',
    'slow',
    'meditation',
    'lounge',
    'dream',
    'gentle',
    'downtempo',
    'mellow',
    'serene'
  ],
  focus: [
    'focus',
    'lofi',
    'lo-fi',
    'study',
    'instrumental',
    'work',
    'ambient',
    'beats',
    'coding',
    'deep focus',
    'piano',
    'concentration',
    'reading',
    'flow'
  ]
};

/** Default search seed fallbacks per mood */
const MOOD_DEFAULT_SEEDS: Record<WaveMood, string[]> = {
  favorite: ['top hits 2026', 'popular songs', 'greatest hits music'],
  discovery: ['indie music discovery', 'new emerging artists', 'fresh indie gems'],
  energy: ['high energy workout motivation', 'electronic dance bangers', 'upbeat pump gym music'],
  chill: ['chillout relax acoustic lounge', 'calm ambient meditation', 'peaceful relaxing melodies'],
  focus: ['lofi hip hop focus study beats', 'deep focus instrumental concentration', 'ambient coding beats']
};

/** Scoring weights per mood (alpha = affinity, beta = mood, gamma = novelty) */
const MOOD_WEIGHTS: Record<WaveMood, { alpha: number; beta: number; gamma: number }> = {
  favorite: { alpha: 0.55, beta: 0.30, gamma: 0.15 },
  discovery: { alpha: 0.15, beta: 0.35, gamma: 0.50 },
  energy: { alpha: 0.30, beta: 0.50, gamma: 0.20 },
  chill: { alpha: 0.30, beta: 0.50, gamma: 0.20 },
  focus: { alpha: 0.25, beta: 0.55, gamma: 0.20 }
};

/**
 * Формулировки для поиска по шкале энергии. Крайние значения дают выраженный
 * запрос, середина — нейтральный: если человек не двинул регулятор, незачем
 * навязывать волне ни воркаут, ни эмбиент.
 */
const ENERGY_PHRASES: Array<{ upTo: number; words: string[] }> = [
  { upTo: 0.2, words: ['calm ambient', 'slow acoustic', 'peaceful'] },
  { upTo: 0.4, words: ['chill', 'lofi', 'mellow'] },
  { upTo: 0.6, words: [] },
  { upTo: 0.8, words: ['upbeat', 'energetic'] },
  { upTo: 1.01, words: ['high energy', 'dance banger', 'workout'] }
];

/** Треки старше этого срока считаются забытыми. */
export const FORGOTTEN_AFTER_MS = 45 * 24 * 60 * 60 * 1000;

/** Приводит значение регулятора к 0..1; мусор превращается в середину. */
export function clampAxis(value: number | undefined, fallback = 0.5): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

/** Заданы ли регуляторы — то есть ведут ли они волну вместо ярлыка `mood`. */
export function hasAxes(config: WaveConfig): boolean {
  return typeof config.novelty === 'number' || typeof config.energy === 'number';
}

/**
 * Ярлык для шара и подписи. Регуляторы — это две независимые оси, а `mood`
 * один, поэтому здесь именно ярлык: побеждает та ось, которую сдвинули дальше
 * от середины.
 */
export function deriveWaveMood(novelty: number, energy: number): WaveMood {
  const n = clampAxis(novelty);
  const e = clampAxis(energy);
  const noveltyPull = Math.abs(n - 0.5);
  const energyPull = Math.abs(e - 0.5);

  if (noveltyPull >= energyPull) {
    return n > 0.5 ? 'discovery' : 'favorite';
  }
  if (e > 0.5) return 'energy';
  return e < 0.35 ? 'chill' : 'focus';
}

/**
 * Веса скоринга из регуляторов. Знакомость решает, чего в волне больше:
 * привычного (alpha) или неизвестного (gamma).
 */
export function resolveWaveWeights(config: WaveConfig): {
  alpha: number;
  beta: number;
  gamma: number;
} {
  if (!hasAxes(config)) {
    return MOOD_WEIGHTS[config.mood] || MOOD_WEIGHTS.favorite;
  }

  const novelty = clampAxis(config.novelty, 0.35);
  const alpha = 0.6 * (1 - novelty) + 0.1;
  const gamma = 0.1 + 0.5 * novelty;
  return { alpha, beta: Math.max(0.1, 1 - alpha - gamma), gamma };
}

/** Слова для поиска по текущему положению регулятора энергии. */
export function energyPhrases(energy: number | undefined): string[] {
  const value = clampAxis(energy);
  for (const band of ENERGY_PHRASES) {
    if (value < band.upTo) return band.words;
  }
  return [];
}

export function normalizeArtist(artist: string): string {
  return (artist || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupeKey(track: UnifiedTrack): string {
  const normArtist = normalizeArtist(track.artist);
  const normTitle = (track.title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${normArtist}::${normTitle}`;
}

export function isRadioFriendly(track: UnifiedTrack): boolean {
  if (!track || !track.id) return false;
  const dur = track.duration;
  if (dur !== undefined && dur !== null && Number.isFinite(dur) && dur > 0) {
    if (dur < RADIO_MIN_DURATION || dur > RADIO_MAX_DURATION) {
      return false;
    }
  }
  if (track.title && LONG_FORM_TITLE_PATTERN.test(track.title)) {
    return false;
  }
  if (track.title && POLLUTION_TITLE_PATTERN.test(track.title)) {
    return false;
  }
  return true;
}

export function isTopUpEligible(track: UnifiedTrack): boolean {
  if (!track || !track.id) return false;
  const dur = track.duration;
  if (dur !== undefined && dur !== null && Number.isFinite(dur) && dur > 0) {
    return dur < RADIO_TOPUP_MAX_DURATION;
  }
  return true;
}

/**
 * Караоке и перезаливка — не «почти подходит», а не то.
 *
 * Аварийный добор кандидатов ослабляет требования к длительности, когда иначе
 * волна окажется пустой, — и раньше вместе с длительностью он возвращал в пул
 * весь отфильтрованный мусор. Минусовка вместо песни выглядит как поломка даже
 * там, где выбирать больше нечего, поэтому этот фильтр не ослабляется никогда.
 */
export function hasPollutedTitle(track: UnifiedTrack): boolean {
  return Boolean(track?.title) && POLLUTION_TITLE_PATTERN.test(track.title);
}

/**
 * Производные от профиля величины, нужные каждому кандидату.
 *
 * Считались внутри `scoreCandidate`, то есть заново на каждый трек: `Math.max`
 * по всем артистам и `indexOf` по всей истории. На пятидесяти кандидатах это
 * тысячи лишних проходов ровно за теми же числами, а на большой библиотеке
 * `Math.max(...values)` ещё и рискует переполнить стек аргументов. Кэш висит на
 * самом объекте профиля: профиль пересобирается на каждую волну, поэтому
 * устареть он не может.
 */
interface ProfileIndex {
  maxAffinity: number;
  /** Позиция трека в истории: 0 — играл только что. */
  recencyRank: Map<string, number>;
}

const profileIndexCache = new WeakMap<UserProfile, ProfileIndex>();

function profileIndex(profile: UserProfile): ProfileIndex {
  const cached = profileIndexCache.get(profile);
  if (cached) return cached;

  let maxAffinity = 1;
  for (const value of profile.artistAffinities.values()) {
    if (Number.isFinite(value) && value > maxAffinity) maxAffinity = value;
  }

  const recencyRank = new Map<string, number>();
  let rank = 0;
  for (const id of profile.recentTrackIds) {
    recencyRank.set(id, rank++);
  }

  const index: ProfileIndex = { maxAffinity, recencyRank };
  profileIndexCache.set(profile, index);
  return index;
}

export type WavePickReasonKind =
  | 'seed'
  | 'favorite'
  | 'forgotten'
  | 'frequent'
  | 'known'
  | 'genre'
  | 'fresh';

export interface WavePickReason {
  kind: WavePickReasonKind;
  /** Короткая фраза для подписи под треком. */
  text: string;
}

/**
 * Почему трек оказался в Потоке.
 *
 * Считается из того же профиля, что и сам скоринг, поэтому подпись честная:
 * это не украшение, а причина, по которой трек обогнал остальных. Порядок
 * проверок — от самого содержательного к самому общему.
 */
export function explainWavePick(
  track: UnifiedTrack,
  profile: UserProfile,
  config?: WaveConfig,
  now: number = Date.now()
): WavePickReason {
  const normArtist = normalizeArtist(track?.artist || '');
  const seedArtist = normalizeArtist(config?.seedArtist || config?.seedTrack?.artist || '');

  if (seedArtist && normArtist && normArtist === seedArtist) {
    return { kind: 'seed', text: `Отсюда начался Поток: ${track.artist}` };
  }

  // Поток «от этой песни»: подпись честнее называет саму песню, а не артиста —
  // радио по ней приносит других исполнителей того же жанра.
  if (config?.seedKind === 'track' && config.seedTrack?.title) {
    return { kind: 'seed', text: `Похоже на «${config.seedTrack.title}»` };
  }

  if (profile.favoriteTrackIds.has(track.id)) {
    return { kind: 'favorite', text: 'Из вашего избранного' };
  }

  const lastPlayed = profile.lastPlayedAt?.get(track.id);
  if (typeof lastPlayed === 'number' && now - lastPlayed >= FORGOTTEN_AFTER_MS) {
    const months = Math.round((now - lastPlayed) / (30 * 24 * 60 * 60 * 1000));
    return {
      kind: 'forgotten',
      text: months >= 2 ? `Не включали ${months} мес.` : 'Давно не включали'
    };
  }

  if (normArtist && profile.topArtists.slice(0, 3).includes(normArtist)) {
    return { kind: 'frequent', text: `Вы часто слушаете ${track.artist}` };
  }

  if (normArtist && (profile.artistAffinities.get(normArtist) || 0) > 0) {
    return { kind: 'known', text: `Вы уже слушали ${track.artist}` };
  }

  if (config?.genre) {
    const genreLower = config.genre.toLowerCase();
    const haystack = `${track.title || ''} ${track.artist || ''}`.toLowerCase();
    if (haystack.includes(genreLower)) {
      return { kind: 'genre', text: `Жанр: ${config.genre}` };
    }
  }

  return { kind: 'fresh', text: 'Новое имя для вас' };
}

export class RecommendationEngineService implements RecommendationEngine {
  private ytService: YouTubeService;
  private scService: SoundCloudService;
  private sessionBoosts: Map<string, number> = new Map();

  constructor(
    ytService: YouTubeService = youtubeService,
    scService: SoundCloudService = soundCloudService
  ) {
    this.ytService = ytService;
    this.scService = scService;
  }

  /**
   * Clears in-memory session affinity boosts (useful for test resets).
   */
  public resetSessionBoosts(): void {
    this.sessionBoosts.clear();
  }

  /**
   * Computes dynamic user profile with artist affinity scores:
   * W_artist = playCount + 3.0 * isFavorite + 1.5 * inPlaylist + sessionBoost
   */
  public async buildUserProfile(): Promise<UserProfile> {
    const [history, favorites, playlists, dislikes] = await Promise.all([
      getHistory(200).catch(() => []),
      getFavorites().catch(() => []),
      getPlaylists().catch(() => []),
      // Не `getDislikedTrackIds`: нужны ещё и артисты, а это то же самое чтение.
      getDislikes().catch(() => [])
    ]);
    const dislikedTrackIds = new Set(dislikes.map((record) => record.id));

    const artistPlayCounts = new Map<string, number>();
    const artistFavoriteCounts = new Map<string, number>();
    const artistPlaylistCounts = new Map<string, number>();
    /** Сколько раз артиста выключали и сколько раз отвергали. См. штраф ниже. */
    const artistSkips = new Map<string, number>();
    const artistEarlySkips = new Map<string, number>();
    const artistDislikes = new Map<string, number>();
    const artistAffinities = new Map<string, number>();
    const genreAffinities = new Map<string, number>();
    const rawToNormArtist = new Map<string, string>();
    const recentTrackIds = new Set<string>();
    const favoriteTrackIds = new Set<string>();
    const skippedTrackIds = new Set<string>();
    const lastPlayedAt = new Map<string, number>();
    let totalPlays = 0;

    // 1. Process History (play counts and recent tracks)
    const sortedHistory = [...history].sort((a, b) => b.playedAt - a.playedAt);
    for (const record of sortedHistory) {
      if (!record || !record.id) continue;
      recentTrackIds.add(record.id);
      if (typeof record.playedAt === 'number' && Number.isFinite(record.playedAt)) {
        // История отсортирована от новых к старым, поэтому первая запись о треке
        // и есть последнее прослушивание.
        if (!lastPlayedAt.has(record.id)) lastPlayedAt.set(record.id, record.playedAt);
      }
      const count = record.playCount || 1;
      totalPlays += count;

      // Пропуски пишутся в историю с первого дня, но до сих пор их никто не
      // читал — волна упорно возвращала то, что человек дважды выключил. Один
      // пропуск не считается: с ним можно просто не угадать момент.
      const skips = record.skipCount || 0;
      const completions = record.completedCount || 0;
      if (skips >= SKIPS_BEFORE_PENALTY && skips > completions) {
        skippedTrackIds.add(record.id);
      }

      const artist = record.track?.artist;
      if (artist) {
        const norm = normalizeArtist(artist);
        if (norm) {
          rawToNormArtist.set(artist, norm);
          artistPlayCounts.set(norm, (artistPlayCounts.get(norm) || 0) + count);
          const early = record.earlySkipCount || 0;
          // Ранние пропуски считаются отдельно и строже: выключить на первых
          // секундах — это не «не угадал момент», а «убери это».
          if (early > 0) artistEarlySkips.set(norm, (artistEarlySkips.get(norm) || 0) + early);
          const plainSkips = Math.max(0, skips - early);
          if (plainSkips > 0) artistSkips.set(norm, (artistSkips.get(norm) || 0) + plainSkips);
        }
      }
    }

    for (const record of dislikes) {
      const norm = normalizeArtist(record.artist || '');
      if (!norm) continue;
      artistDislikes.set(norm, (artistDislikes.get(norm) || 0) + 1);
    }

    // 2. Process Favorites (3.0 weight)
    for (const fav of favorites) {
      if (!fav || !fav.id) continue;
      favoriteTrackIds.add(fav.id);
      const artist = fav.artist;
      if (artist) {
        const norm = normalizeArtist(artist);
        if (norm) {
          rawToNormArtist.set(artist, norm);
          artistFavoriteCounts.set(norm, (artistFavoriteCounts.get(norm) || 0) + 1);
        }
      }
    }

    // 3. Process Playlists (1.5 weight)
    for (const pl of playlists) {
      for (const t of pl.tracks || []) {
        if (!t) continue;
        const artist = t.artist;
        if (artist) {
          const norm = normalizeArtist(artist);
          if (norm) {
            rawToNormArtist.set(artist, norm);
            artistPlaylistCounts.set(norm, (artistPlaylistCounts.get(norm) || 0) + 1);
          }
        }
      }
    }

    // 4. Calculate total affinities: W = playCount + 3.0 * favoriteCount + 1.5 * playlistCount + sessionBoost
    const allArtists = new Set([
      ...artistPlayCounts.keys(),
      ...artistFavoriteCounts.keys(),
      ...artistPlaylistCounts.keys(),
      ...artistDislikes.keys(),
      ...this.sessionBoosts.keys()
    ]);

    for (const normArtist of allArtists) {
      const plays = artistPlayCounts.get(normArtist) || 0;
      const favs = artistFavoriteCounts.get(normArtist) || 0;
      const plCount = artistPlaylistCounts.get(normArtist) || 0;
      const boost = this.sessionBoosts.get(normArtist) || 0;

      /*
       * Отказы вычитаются, и до этой правки не вычитались нигде.
       *
       * Вес артиста складывался только из прослушиваний, избранного и
       * плейлистов, а в историю трек попадает в тот же миг, когда начал играть,
       * — то есть **каждая выдача поднимала вес**. Отказ при этом убирал ровно
       * один идентификатор из выдачи и на артиста не влиял никак. Получалась
       * петля наоборот: чем усерднее человек выключает подсунутое, тем выше
       * поднимается тот, кто это подсунул, — а `topArtists` как раз и порождает
       * запросы, которыми волна добирается. Жалоба звучала дословно так:
       * «говорю не суй мне это, а оно ещё больше хуярит».
       *
       * Числа взяты из `waveMemory.FEEDBACK_DELTA`, где они и были написаны под
       * эту задачу: −1 за пропуск, −2.5 за ранний, −4 за «не нравится». Отрицательный
       * итог не обрезается: артист обязан уметь опуститься ниже незнакомого.
       */
      const penalty =
        Math.abs(FEEDBACK_DELTA.skip) * (artistSkips.get(normArtist) || 0) +
        Math.abs(FEEDBACK_DELTA.early_skip) * (artistEarlySkips.get(normArtist) || 0) +
        Math.abs(FEEDBACK_DELTA.dislike) * (artistDislikes.get(normArtist) || 0);

      const score = plays + 3.0 * favs + 1.5 * plCount + boost - penalty;
      artistAffinities.set(normArtist, score);
    }

    // Mirror affinities to original casing keys for convenience
    for (const [rawArtist, norm] of rawToNormArtist.entries()) {
      if (artistAffinities.has(norm) && !artistAffinities.has(rawArtist)) {
        artistAffinities.set(rawArtist, artistAffinities.get(norm)!);
      }
    }

    // Отвергнутые в «топ» не попадают вовсе: список порождает поисковые запросы,
    // которыми волна добирает треки, и артист с отрицательным весом не должен
    // становиться семенем ни при каких обстоятельствах — даже если он
    // единственный, кого человек включал.
    const topArtists = Array.from(artistAffinities.entries())
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([art]) => art);

    return {
      artistAffinities,
      genreAffinities,
      topArtists,
      dislikedTrackIds,
      recentTrackIds,
      favoriteTrackIds,
      skippedTrackIds,
      totalPlays,
      artistPlayCounts,
      artistFavoriteCounts,
      artistPlaylistCounts,
      lastPlayedAt
    };
  }

  /**
   * От чего просить радио: очаги вкуса, а не одна песня.
   *
   * Порядок неслучаен. Первым идёт семя, которое назвал сам режим («от этой
   * песни» или играющее сейчас) — оно отвечает на заданный вопрос и обязано
   * прозвучать. Дальше добираются треки любимых артистов, которых человек
   * слушает чаще прочих, по одному на артиста: два трека одного исполнителя
   * дали бы два почти одинаковых радио и потратили бы очаг впустую.
   *
   * Чем выше «незнакомость» на регуляторе, тем больше очагов: узкий поток — это
   * один источник, широкий — несколько разных.
   *
   * «Открытия» и «Забытое» очагов не получают: у них своя логика, и радио от
   * знакомого увело бы их туда, откуда просили увести.
   */
  private async collectWaveSeeds(
    config: WaveConfig,
    profile: UserProfile,
    limit: number
  ): Promise<UnifiedTrack[]> {
    const primary = config.seedTrack;
    if (!primary || !primary.originalId) return [];
    if (config.seedKind === 'discovery' || config.seedKind === 'forgotten') return [];
    // «От этой песни» — это буквально просьба про одну песню.
    if (config.seedKind === 'track') return [primary];

    const novelty = clampAxis(config.novelty, 0.35);
    const wanted = novelty > 0.6 ? 4 : novelty > 0.3 ? 3 : 2;

    const seeds: UnifiedTrack[] = [primary];
    const usedArtists = new Set<string>([normalizeArtist(primary.artist)]);

    /*
     * Библиотека — то, что человек сложил сам. Избранное впереди истории:
     * «сохранил» — более сильный сигнал вкуса, чем «однажды включил».
     *
     * В профиле лежат только идентификаторы, а очагу нужен сам трек — у него
     * спрашивают радио по `originalId`. Поэтому читаем из базы, а не из
     * профиля.
     */
    const [favorites, history] = await Promise.all([
      getFavorites().catch(() => [] as UnifiedTrack[]),
      getHistory(60)
        .then((rows) => rows.map((row) => row.track))
        .catch(() => [] as UnifiedTrack[])
    ]);
    const pool = [...favorites, ...history];
    for (const track of pool) {
      if (seeds.length >= wanted) break;
      if (!track?.originalId) continue;
      const artist = normalizeArtist(track.artist);
      if (!artist || usedArtists.has(artist)) continue;
      // Слушают этого артиста заметно или нет — важнее, чем порядок в списке.
      if ((profile.artistPlayCounts.get(artist) ?? 0) < 1) continue;
      usedArtists.add(artist);
      seeds.push(track);
    }

    // Лимит меньше десятка — просят добор, а не новый поток: хватит одного очага.
    return limit < 10 ? seeds.slice(0, 1) : seeds;
  }

  /**
   * Generates dynamic recommendations for «Поток» based on mood, genre, and user profile.
   */
  public async getRecommendationsForWave(
    config: WaveConfig,
    limit: number = 20,
    excludeIds: Set<string> = new Set()
  ): Promise<UnifiedTrack[]> {
    const profile = await this.buildUserProfile();
    const effectiveExclude = new Set<string>([...excludeIds, ...profile.dislikedTrackIds]);

    // Build targeted query pool based on mood, genre, and top artists
    const queries = this.generateWaveQueries(config, profile);
    const candidates: UnifiedTrack[] = [];
    const seenIds = new Set<string>(effectiveExclude);
    const seenKeys = new Set<string>();

    const addTrack = (track: UnifiedTrack | undefined): void => {
      if (!track || !track.id) return;
      if (seenIds.has(track.id)) return;
      const key = dedupeKey(track);
      if (seenKeys.has(key)) return;
      seenIds.add(track.id);
      seenKeys.add(key);
      candidates.push(track);
    };

    /*
     * Радио от песни-семени — не «ещё один источник», а ответ на заданный вопрос.
     *
     * Раньше его добавляли в общий котёл, а потом поверх всегда сыпали поиск по
     * ключевым словам (`generateWaveQueries` строит запросы вида «phonk high
     * energy workout»). Пятнадцать связных треков растворялись в десятках
     * найденных по словам, и от фонка играло что попало — ровно то, на что
     * жаловались. Поэтому: если радио ответило, поиск не запускается вовсе, а
     * если ответило скупо — только добирает недостающее.
     */
    let seedRadioCount = 0;
    /*
     * Не одно семя, а несколько — так поток перестаёт быть радио одной песни.
     *
     * Как это устроено у больших сервисов: их «микс дня» и «радио» строятся не
     * от одного трека, а от нескольких очагов вкуса сразу — недавнее, любимые
     * артисты, соседи по прослушиваниям, — и результаты сплетаются. Один
     * источник даёт связный, но узкий поток: он час крутится вокруг той песни,
     * с которой начали.
     *
     * Считать похожесть самим нам нечем и незачем: радио YouTube Music — это и
     * есть совместная фильтрация, посчитанная на их масштабе. Наша работа —
     * выбрать, от чего его просить, и смешать ответы.
     */
    const seeds = await this.collectWaveSeeds(config, profile, limit);
    if (seeds.length > 0) {
      // Просим с запасом: часть отсеется по длительности и мусорным названиям.
      // Чем больше очагов, тем меньше просим у каждого — иначе первый займёт
      // всю очередь и остальные не прозвучат.
      const want = Math.max(Math.ceil((limit * 2) / seeds.length), 15);
      for (const seed of seeds) {
        try {
          if (seed.source === 'youtube') {
            const ytRelated = await this.ytService.getRelatedVideos(seed.originalId, want);
            ytRelated.forEach(addTrack);
          } else if (seed.source === 'soundcloud') {
            const scRelated = await this.scService.getRelatedTracks(seed.originalId, want);
            scRelated.forEach(addTrack);
          }
        } catch (err) {
          // Отказ одного очага не отменяет остальные: раньше единственный
          // источник ронял весь подбор в поиск по ключевым словам.
          console.warn(`[RecommendationEngine] радио от «${seed.title}» не ответило:`, err);
        }
      }
      seedRadioCount = candidates.filter(isRadioFriendly).length;
    }

    /*
     * Хватает ли радио, чтобы обойтись без поиска.
     *
     * Порог не «сколько попросили», а «сколько нужно, чтобы поток звучал связно»:
     * ждать полного лимита значило бы запускать поиск почти всегда — радио отдаёт
     * пятьдесят треков, но после отсева по длительности их остаётся меньше.
     */
    const enoughFromRadio = Math.min(limit, WAVE_SEED_RADIO_SUFFICIENT);

    // Скупое радио продлеваем радио же — зацепившись за трек из полученных.
    if (config.seedTrack && seedRadioCount > 0 && seedRadioCount < enoughFromRadio) {
      seedRadioCount = await this.extendPoolByRadio(
        candidates,
        addTrack,
        enoughFromRadio,
        new Set<string>([config.seedTrack.id])
      );
    }

    const seedRadioIsEnough = seedRadioCount >= enoughFromRadio;

    // «Забытое» берётся из собственной истории: искать в сети то, что уже
    // слушали, незачем — оно лежит локально вместе с датой прослушивания.
    if (config.seedKind === 'forgotten') {
      const forgotten = await this.collectForgottenTracks(limit * 2);
      forgotten.forEach(addTrack);
    }

    // Query candidate search streams across YouTube and SoundCloud.
    // Не запускается, когда радио от песни уже ответило: это и есть починка
    // «поток не даёт отталкиваться от конкретной песни».
    if (!seedRadioIsEnough) {
      const searchPromises = queries.map(async (query) => {
        const [ytRes, scRes] = await Promise.allSettled([
          this.ytService.search(query, 12),
          this.scService.search(query, 12)
        ]);

        if (ytRes.status === 'fulfilled' && Array.isArray(ytRes.value)) {
          ytRes.value.forEach(addTrack);
        }
        if (scRes.status === 'fulfilled' && Array.isArray(scRes.value)) {
          scRes.value.forEach(addTrack);
        }
      });

      await Promise.all(searchPromises);
    }

    // If candidate pool is too small, execute fallback searches.
    // При живом радио не запускается: лучше короткий связный поток, чем полный
    // лимит, добитый треками не из того жанра.
    if (!seedRadioIsEnough && candidates.filter(isRadioFriendly).length < limit) {
      const fallbackSeeds = MOOD_DEFAULT_SEEDS[config.mood] || MOOD_DEFAULT_SEEDS.favorite;
      const fallbackPromises = fallbackSeeds.map(async (fQuery) => {
        const queryWithGenre = config.genre ? `${config.genre} ${fQuery}` : fQuery;
        const [ytRes, scRes] = await Promise.allSettled([
          this.ytService.search(queryWithGenre, 15),
          this.scService.search(queryWithGenre, 15)
        ]);

        if (ytRes.status === 'fulfilled' && Array.isArray(ytRes.value)) {
          ytRes.value.forEach(addTrack);
        }
        if (scRes.status === 'fulfilled' && Array.isArray(scRes.value)) {
          scRes.value.forEach(addTrack);
        }
      });
      await Promise.all(fallbackPromises);
    }

    // Apply radio friendly duration and title filtering
    let filtered = candidates.filter(isRadioFriendly);
    if (filtered.length < Math.min(3, limit)) {
      // Relax duration band to top-up ceiling to prevent empty radio
      const topUpPool = candidates.filter((t) => isTopUpEligible(t) && !hasPollutedTitle(t));
      filtered = Array.from(new Set([...filtered, ...topUpPool]));
    }

    // Score all filtered candidates with scoring matrix
    const scoredCandidates = filtered.map((track) =>
      this.scoreCandidate(track, config, profile)
    );

    // Поток «от артиста» на то и заведён, чтобы его было слышно, поэтому лимит
    // на артиста там мягче, чем в обычном Потоке. То же и «от этой песни»: радио
    // по фонк-треку законно приносит того же артиста дважды.
    const seededByArtist =
      config.seedKind === 'artist' ||
      config.seedKind === 'track' ||
      Boolean(config.seedArtist);
    return this.arrangeCandidates(
      scoredCandidates,
      limit,
      seededByArtist ? MAX_TRACKS_PER_SEED_ARTIST : MAX_TRACKS_PER_ARTIST
    );
  }

  /**
   * Добирает пул радио же: берёт трек из уже полученных и просит радио от него.
   *
   * Нужно затем, чтобы скупой ответ не приходилось затыкать поиском по ключевым
   * словам. Радио от соседа по жанру остаётся в жанре, поиск по словам — нет.
   *
   * Зацепки берутся с начала пула: там лежат ближайшие к семени треки.
   * `usedSeeds` не даёт дважды сходить за одним и тем же списком.
   *
   * @returns сколько годных треков в пуле после попыток продления.
   */
  private async extendPoolByRadio(
    candidates: UnifiedTrack[],
    addTrack: (track: UnifiedTrack | undefined) => void,
    target: number,
    usedSeeds: Set<string>
  ): Promise<number> {
    let radioFriendly = candidates.filter(isRadioFriendly).length;

    for (let hop = 0; hop < RADIO_CHAIN_HOPS && radioFriendly < target; hop += 1) {
      const next = candidates.find(
        (track) =>
          !usedSeeds.has(track.id) && Boolean(track.originalId) && isRadioFriendly(track)
      );
      if (!next || !next.originalId) break;
      usedSeeds.add(next.id);

      try {
        if (next.source === 'youtube') {
          const related = await this.ytService.getRelatedVideos(next.originalId, target * 2);
          related.forEach(addTrack);
        } else if (next.source === 'soundcloud') {
          const related = await this.scService.getRelatedTracks(next.originalId, target * 2);
          related.forEach(addTrack);
        } else {
          continue;
        }
      } catch (err) {
        console.warn('[RecommendationEngine] Radio chain hop failed:', err);
        continue;
      }

      const grown = candidates.filter(isRadioFriendly).length;
      // Ответ без новых треков означает, что этот путь исчерпан.
      if (grown === radioFriendly) break;
      radioFriendly = grown;
    }

    return radioFriendly;
  }

  /**
   * Spotify-style Track Radio: generates infinite stream of related tracks chaining from any seed.
   */
  public async getTrackRadio(
    seedTrack: UnifiedTrack,
    limit: number = 20,
    excludeIds: Set<string> = new Set()
  ): Promise<UnifiedTrack[]> {
    if (!seedTrack) return [];
    const dislikedTrackIds = await getDislikedTrackIds().catch(() => new Set<string>());
    const effectiveExclude = new Set<string>([
      seedTrack.id,
      ...excludeIds,
      ...dislikedTrackIds
    ]);

    const candidates: UnifiedTrack[] = [];
    const seenIds = new Set<string>(effectiveExclude);
    const seenKeys = new Set<string>([dedupeKey(seedTrack)]);

    const addTrack = (track: UnifiedTrack | undefined): void => {
      if (!track || !track.id) return;
      if (seenIds.has(track.id)) return;
      const key = dedupeKey(track);
      if (seenKeys.has(key)) return;
      seenIds.add(track.id);
      seenKeys.add(key);
      candidates.push(track);
    };

    // 1. Fetch related tracks from the native source
    try {
      if (seedTrack.source === 'youtube' && seedTrack.originalId) {
        const relatedYt = await this.ytService.getRelatedVideos(seedTrack.originalId, limit * 2);
        relatedYt.forEach(addTrack);
      } else if (seedTrack.source === 'soundcloud' && seedTrack.originalId) {
        const relatedSc = await this.scService.getRelatedTracks(seedTrack.originalId, limit * 2);
        relatedSc.forEach(addTrack);
      }
    } catch (err) {
      console.warn(`[RecommendationEngine] Primary related tracks failed for ${seedTrack.id}:`, err);
    }

    /*
     * Скупое радио продлеваем радио, а не поиском.
     *
     * Здесь была та же беда, что и в Потоке: поверх связного списка всегда шёл
     * поиск по «артист + название», и в очередь попадали ремиксы, лайвы и просто
     * одноимённые чужие песни. Теперь поиск — последнее средство.
     */
    let radioFriendly = candidates.filter(isRadioFriendly).length;
    if (radioFriendly > 0 && radioFriendly < limit) {
      radioFriendly = await this.extendPoolByRadio(
        candidates,
        addTrack,
        limit,
        new Set<string>([seedTrack.id])
      );
    }

    const seedArtist = isPlaceholderArtist(seedTrack.artist) ? '' : seedTrack.artist;

    // 2. Fetch cross-platform search tracks by artist/title
    const searchQuery = seedArtist ? `${seedArtist} ${seedTrack.title}` : seedTrack.title;

    if (radioFriendly < Math.min(limit, WAVE_SEED_RADIO_SUFFICIENT) && searchQuery) {
      const [ytSearch, scSearch] = await Promise.allSettled([
        this.ytService.search(searchQuery, limit),
        this.scService.search(searchQuery, limit)
      ]);

      if (ytSearch.status === 'fulfilled' && Array.isArray(ytSearch.value)) {
        ytSearch.value.forEach(addTrack);
      }
      if (scSearch.status === 'fulfilled' && Array.isArray(scSearch.value)) {
        scSearch.value.forEach(addTrack);
      }
    }

    // 3. Fallback artist query if candidate pool is small
    if (candidates.filter(isRadioFriendly).length < limit && seedArtist) {
      const [ytArtist, scArtist] = await Promise.allSettled([
        this.ytService.search(`${seedArtist} best tracks`, limit),
        this.scService.search(`${seedArtist}`, limit)
      ]);

      if (ytArtist.status === 'fulfilled' && Array.isArray(ytArtist.value)) {
        ytArtist.value.forEach(addTrack);
      }
      if (scArtist.status === 'fulfilled' && Array.isArray(scArtist.value)) {
        scArtist.value.forEach(addTrack);
      }
    }

    // Filter candidates
    let filtered = candidates.filter(isRadioFriendly);
    if (filtered.length < Math.min(3, limit)) {
      const topUpPool = candidates.filter((t) => isTopUpEligible(t) && !hasPollutedTitle(t));
      filtered = Array.from(new Set([...filtered, ...topUpPool]));
    }

    // Score candidates relative to seed track
    const normSeedArtist = normalizeArtist(seedTrack.artist);
    const scoredCandidates: ScoredCandidate[] = filtered.map((track) => {
      const normArtist = normalizeArtist(track.artist);
      let score = 0.5;

      // Higher score if same or similar artist
      if (normArtist && normSeedArtist && normArtist === normSeedArtist) {
        score += 0.35;
      }
      // Higher score if track is not the exact seed track
      if (track.id !== seedTrack.id) {
        score += 0.15;
      }

      return {
        track,
        score,
        affinityScore: normArtist === normSeedArtist ? 1.0 : 0.2,
        moodScore: 0.5,
        noveltyScore: 0.5,
        genreBonus: 0,
        recencyPenalty: 1.0
      };
    });

    // Радио трека — это «похоже на вот это», поэтому исходному артисту здесь
    // позволено больше, чем в обычной волне, но не вся выдача целиком.
    return this.arrangeCandidates(scoredCandidates, limit, MAX_TRACKS_PER_SEED_ARTIST);
  }

  /**
   * Handles user feedback signals: like, dislike, skip, more_like_this, complete
   */
  public async recordFeedback(track: UnifiedTrack, action: FeedbackAction): Promise<void> {
    if (!track || !track.id) return;

    switch (action) {
      case 'like':
        await addFavorite(track);
        break;

      case 'dislike':
        await addDislike(track);
        await recordTrackSkip(track.id);
        break;

      case 'skip':
        await recordTrackSkip(track.id);
        break;

      case 'more_like_this': {
        const norm = normalizeArtist(track.artist);
        if (norm) {
          const current = this.sessionBoosts.get(norm) || 0;
          this.sessionBoosts.set(norm, current + 5.0);
        }
        break;
      }

      case 'complete':
        await recordTrackCompletion(track.id);
        break;
    }
  }

  /**
   * Generates targeted query strings based on wave mood, genre, and profile affinities.
   */
  private generateWaveQueries(config: WaveConfig, profile: UserProfile): string[] {
    if (hasAxes(config)) {
      return this.generateTunedQueries(config, profile);
    }

    const queries: string[] = [];
    const genre = config.genre ? config.genre.trim() : '';

    switch (config.mood) {
      case 'favorite': {
        // Use user's top artists if available
        if (profile.topArtists.length > 0) {
          const topSlice = profile.topArtists.slice(0, 3);
          for (const artist of topSlice) {
            queries.push(genre ? `${artist} ${genre}` : `${artist} best tracks`);
          }
        }
        if (queries.length === 0) {
          queries.push(genre ? `${genre} top hits` : 'top hits music');
        }
        break;
      }

      case 'discovery': {
        if (genre) {
          queries.push(`${genre} indie discovery`, `${genre} new music fresh`, `${genre} underground gems`);
        } else {
          queries.push('indie music discovery', 'new emerging artists', 'fresh indie tracks');
        }
        break;
      }

      case 'energy': {
        if (genre) {
          queries.push(`${genre} high energy workout`, `${genre} upbeat dance`, `${genre} pump workout`);
        } else {
          queries.push('high energy workout music', 'electronic pump workout', 'upbeat rock banger');
        }
        break;
      }

      case 'chill': {
        if (genre) {
          queries.push(`${genre} chill relax acoustic`, `${genre} calm ambient`, `${genre} peaceful melodies`);
        } else {
          queries.push('chillout relax lounge', 'ambient peaceful calm', 'acoustic chill guitar');
        }
        break;
      }

      case 'focus': {
        if (genre) {
          queries.push(`${genre} lofi focus study`, `${genre} instrumental deep work`, `${genre} ambient focus`);
        } else {
          queries.push('lofi hip hop focus study', 'deep focus instrumental beats', 'ambient study coding');
        }
        break;
      }
    }

    return queries;
  }

  /**
   * Треки из истории, которых давно не было слышно.
   *
   * Сортировка от самых давних: смысл источника — вернуть то, что действительно
   * успело забыться, а не то, что играло на прошлой неделе.
   */
  public async collectForgottenTracks(limit: number = 20): Promise<UnifiedTrack[]> {
    const history = await getHistory(300).catch(() => []);
    const threshold = Date.now() - FORGOTTEN_AFTER_MS;

    const stale = history
      .filter((record) => record?.track?.id && typeof record.playedAt === 'number')
      .filter((record) => record.playedAt <= threshold)
      .sort((a, b) => a.playedAt - b.playedAt);

    const seen = new Set<string>();
    const result: UnifiedTrack[] = [];
    for (const record of stale) {
      if (seen.has(record.track.id)) continue;
      seen.add(record.track.id);
      result.push(record.track);
      if (result.length >= limit) break;
    }

    return result;
  }

  /**
   * Запросы для волны, которую ведут регуляторы и источник.
   *
   * Знакомость решает, сколько запросов идёт от ваших артистов, а сколько — «в
   * сторону»; источник задаёт, от чего вообще отталкиваться. Поэтому две крайние
   * позиции регулятора дают заметно разные волны, а не один и тот же поток с
   * другой подписью.
   */
  private generateTunedQueries(config: WaveConfig, profile: UserProfile): string[] {
    const queries: string[] = [];
    const genre = config.genre ? config.genre.trim() : '';
    const novelty = clampAxis(config.novelty, 0.35);
    const energyWords = energyPhrases(config.energy);
    const seedKind: WaveSeedKind = config.seedKind || 'library';

    const decorate = (base: string): string => {
      const parts = [base];
      if (genre) parts.push(genre);
      // Слово об энергии добавляем только когда регулятор реально сдвинут.
      if (energyWords.length > 0) parts.push(energyWords[queries.length % energyWords.length]);
      return parts.join(' ');
    };

    /*
     * «От этой песни»: если дело дошло до поиска, значит радио не ответило.
     * Тогда держимся хотя бы её артиста, а не общих слов про жанр — от фонка
     * лучше пусть играет тот же артист, чем «high energy workout music».
     */
    if (seedKind === 'track' && config.seedTrack) {
      const seedArtistName = isPlaceholderArtist(config.seedTrack.artist)
        ? ''
        : config.seedTrack.artist.trim();
      if (seedArtistName) {
        queries.push(decorate(`${seedArtistName} best tracks`));
        queries.push(decorate(`artists similar to ${seedArtistName}`));
        return queries;
      }
    }

    if (seedKind === 'artist') {
      const artist = (config.seedArtist || config.seedTrack?.artist || '').trim();
      if (artist) {
        queries.push(decorate(`${artist} best tracks`));
        queries.push(decorate(`artists similar to ${artist}`));
        if (novelty > 0.5) queries.push(decorate(`${artist} type beat new artists`));
        return queries;
      }
    }

    if (seedKind === 'discovery') {
      queries.push(decorate('new music discovery'), decorate('underground gems'), decorate('emerging artists'));
      return queries;
    }

    // 'library' и 'forgotten' опираются на ваших артистов: чем ниже знакомость,
    // тем больше их в запросах.
    const artistCount = novelty > 0.75 ? 1 : novelty > 0.45 ? 2 : 3;
    const topSlice = profile.topArtists.slice(0, artistCount);
    for (const artist of topSlice) {
      queries.push(decorate(novelty > 0.5 ? `artists similar to ${artist}` : `${artist} best tracks`));
    }

    if (novelty > 0.45) {
      queries.push(decorate('new music discovery'));
    }

    if (queries.length === 0) {
      // Пустая библиотека: волне неоткуда взяться персонально, и честнее дать
      // нейтральный поток, чем притворяться, что он «ваш».
      queries.push(decorate(genre ? `${genre} music` : 'popular music'));
    }

    return queries;
  }

  /**
   * Scores a candidate track based on affinity, mood relevance, novelty, and recency penalty.
   */
  public scoreCandidate(
    track: UnifiedTrack,
    config: WaveConfig,
    profile: UserProfile
  ): ScoredCandidate {
    const normArtist = normalizeArtist(track.artist);
    const titleLower = (track.title || '').toLowerCase();
    const artistLower = (track.artist || '').toLowerCase();
    const { maxAffinity, recencyRank } = profileIndex(profile);

    // 1. Calculate Affinity Score (W_affinity in [0, 1])
    let affinityScore = 0;
    if (normArtist && profile.artistAffinities.has(normArtist)) {
      affinityScore = (profile.artistAffinities.get(normArtist) || 0) / maxAffinity;
    } else if (isPlaceholderArtist(normArtist)) {
      affinityScore = 0.1;
    }

    // 2. Calculate Mood Score (W_mood in [0, 1])
    let moodScore = 0.4;
    const moodKeywords = MOOD_KEYWORDS[config.mood] || [];
    const axisDriven = hasAxes(config);

    if (axisDriven) {
      // Одна шкала вместо пяти ярлыков: насколько трек «свой» и насколько он
      // попадает в выбранную энергию.
      const novelty = clampAxis(config.novelty, 0.35);
      const isKnownArtist = Boolean(normArtist) && profile.topArtists.slice(0, 5).includes(normArtist);
      const isPlayedTrack = profile.recentTrackIds.has(track.id) || profile.favoriteTrackIds.has(track.id);

      let familiarScore: number;
      if (profile.favoriteTrackIds.has(track.id)) familiarScore = 1.0;
      else if (isKnownArtist) familiarScore = 0.9;
      else if (affinityScore > 0.3) familiarScore = 0.7;
      else familiarScore = 0.3;

      let strangerScore: number;
      if (!isKnownArtist && !isPlayedTrack) strangerScore = 1.0;
      else if (!isPlayedTrack) strangerScore = 0.6;
      else strangerScore = 0.15;

      moodScore = familiarScore * (1 - novelty) + strangerScore * novelty;

      const words = energyPhrases(config.energy);
      if (words.length > 0) {
        const hit = words.some((word) => titleLower.includes(word) || artistLower.includes(word));
        // Совпадение по энергии — бонус, а не условие: слова в названии есть
        // далеко не у всех треков, и наказывать за это нечестно.
        if (hit) moodScore = Math.min(1, moodScore + 0.2);
      }
    } else if (config.mood === 'favorite') {
      if (profile.favoriteTrackIds.has(track.id)) {
        moodScore = 1.0;
      } else if (normArtist && profile.topArtists.includes(normArtist)) {
        moodScore = 0.9;
      } else if (affinityScore > 0.3) {
        moodScore = 0.7;
      } else {
        moodScore = 0.3;
      }
    } else if (config.mood === 'discovery') {
      const isKnownArtist = normArtist && profile.topArtists.slice(0, 5).includes(normArtist);
      const isPlayedTrack = profile.recentTrackIds.has(track.id) || profile.favoriteTrackIds.has(track.id);

      if (!isKnownArtist && !isPlayedTrack) {
        moodScore = 1.0; // High discovery value
      } else if (!isPlayedTrack) {
        moodScore = 0.6;
      } else {
        moodScore = 0.15; // Low discovery value for already known
      }
    } else {
      // Energy, Chill, Focus: match keyword occurrences
      let matchCount = 0;
      for (const kw of moodKeywords) {
        if (titleLower.includes(kw) || artistLower.includes(kw)) {
          matchCount++;
        }
      }
      moodScore = Math.min(1.0, 0.4 + matchCount * 0.25);
    }

    // 3. Calculate Novelty Score (W_novelty in [0, 1])
    let noveltyScore = 0.5;
    const isUnplayed = !profile.recentTrackIds.has(track.id) && !profile.favoriteTrackIds.has(track.id);
    if (axisDriven) {
      const novelty = clampAxis(config.novelty, 0.35);
      // При «только знакомое» неигранный трек проигрывает знакомому, при
      // «только новое» — наоборот.
      noveltyScore = isUnplayed ? 0.2 + 0.8 * novelty : 0.9 - 0.7 * novelty;
    } else if (config.mood === 'discovery') {
      noveltyScore = isUnplayed ? 1.0 : 0.1;
    } else if (config.mood === 'favorite') {
      noveltyScore = isUnplayed ? 0.3 : 0.9;
    } else {
      noveltyScore = isUnplayed ? 0.7 : 0.5;
    }

    // 4. Genre Bonus
    let genreBonus = 0;
    if (config.genre) {
      const gLower = config.genre.toLowerCase();
      if (titleLower.includes(gLower) || artistLower.includes(gLower)) {
        genreBonus = 0.25;
      }
    }

    // 5. Calculate Weighted Base Score
    const weights = resolveWaveWeights(config);
    let score =
      affinityScore * weights.alpha +
      moodScore * weights.beta +
      noveltyScore * weights.gamma +
      genreBonus;

    // 6. Recency Penalty
    let recencyPenalty = 1.0;
    const recencyPosition = recencyRank.get(track.id);
    if (recencyPosition !== undefined) {
      // Ближе к началу истории — значит играл совсем недавно.
      recencyPenalty = recencyPosition < 10 ? 0.2 : 0.6;
    }

    // 7. Штраф за пропуски: трек, который выключали и не дослушивали, — это
    // ответ «не надо», просто без нажатия на «не нравится».
    const skipPenalty = profile.skippedTrackIds?.has(track.id) ? SKIPPED_TRACK_PENALTY : 1.0;

    score *= recencyPenalty * skipPenalty;

    return {
      track,
      score,
      affinityScore,
      moodScore,
      noveltyScore,
      genreBonus,
      recencyPenalty,
      skipPenalty
    };
  }

  /**
   * Порядок выдачи: сначала качество, потом разнообразие.
   *
   * Раньше здесь было жёсткое чередование 1:1 между YouTube и SoundCloud. Оно
   * гарантировало, что ровно половину волны занимает SoundCloud — даже когда его
   * кандидаты набрали заметно меньше очков. То есть каждый второй трек попадал в
   * очередь не потому, что подходит, а потому что «его очередь»; ради этого
   * порядка выкидывались более подходящие треки другого источника.
   *
   * Теперь порядок задаёт счёт, а разнообразие обеспечивают три ограничения: не
   * больше `maxPerArtist` треков одного артиста, между ними не меньше
   * `MIN_ARTIST_GAP` позиций и не больше `MAX_SAME_SOURCE_RUN` подряд с одного
   * источника. Ограничения снимаются по одному, если иначе список окажется
   * короче запрошенного: короткая волна хуже однообразной, а пустая — хуже всех.
   */
  private arrangeCandidates(
    scoredCandidates: ScoredCandidate[],
    limit: number,
    maxPerArtist: number = MAX_TRACKS_PER_ARTIST
  ): UnifiedTrack[] {
    if (limit <= 0) return [];

    // Имя артиста нормализуется один раз на кандидата: дальше оно проверяется
    // до четырёх раз за каждую занятую позицию, и регулярка на этом месте
    // обходится дороже самого отбора.
    const sorted = scoredCandidates
      .filter((candidate) => candidate?.track?.id)
      .map((candidate) => ({ candidate, artist: normalizeArtist(candidate.track.artist) }))
      .sort((a, b) => b.candidate.score - a.candidate.score);

    const result: UnifiedTrack[] = [];
    const taken = new Set<number>();
    const artistCounts = new Map<string, number>();
    const artistLastAt = new Map<string, number>();
    let runSource: string | null = null;
    let runLength = 0;

    /**
     * Тир 0 — все правила. Дальше по одному отпускаем: серию одного источника,
     * разнос артиста, лимит на артиста. Тир 3 — чистый порядок по счёту, на нём
     * подходит любой оставшийся кандидат, поэтому цикл всегда завершается.
     */
    const eligible = (entry: { candidate: ScoredCandidate; artist: string }, tier: number): boolean => {
      if (tier < 1 && runSource === entry.candidate.track.source && runLength >= MAX_SAME_SOURCE_RUN) {
        return false;
      }
      // Без имени артиста ограничивать нечего: пустой ключ склеил бы в одного
      // «артиста» все треки без метаданных.
      if (!entry.artist) return true;
      if (tier < 2) {
        const lastAt = artistLastAt.get(entry.artist);
        if (lastAt !== undefined && result.length - lastAt < MIN_ARTIST_GAP) return false;
      }
      if (tier < 3 && (artistCounts.get(entry.artist) || 0) >= maxPerArtist) return false;
      return true;
    };

    while (result.length < limit && taken.size < sorted.length) {
      let picked = -1;
      for (let tier = 0; tier <= 3 && picked < 0; tier++) {
        for (let i = 0; i < sorted.length; i++) {
          if (taken.has(i)) continue;
          if (eligible(sorted[i], tier)) {
            picked = i;
            break;
          }
        }
      }
      if (picked < 0) break;

      const { candidate, artist } = sorted[picked];
      taken.add(picked);

      if (artist) {
        artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
        artistLastAt.set(artist, result.length);
      }
      runLength = runSource === candidate.track.source ? runLength + 1 : 1;
      runSource = candidate.track.source;

      result.push(candidate.track);
    }

    return result;
  }
}

export const recommendationEngine = new RecommendationEngineService();
