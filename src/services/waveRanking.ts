/**
 * Ранжирование «Потока»: чистые функции, ни одного сетевого вызова.
 *
 * Схема двухступенчатая, как у взрослых сервисов: сначала откуда-то берутся
 * кандидаты (это делает `recommendationEngine`, там нужна сеть), потом они
 * оцениваются и раскладываются — это делает здешний код. Разделение не
 * косметическое: именно оно позволяет проверить подбор целиком тестами, а не
 * «на слух после сборки».
 *
 * Почему признаки именно такие. Совместная фильтрация — то, на чём держатся
 * Discover Weekly и радио Spotify, — нам недоступна в принципе: нет ни матрицы
 * «человек × трек», ни десятков миллионов людей, чтобы её заполнить. Значит,
 * единственная честная замена — content-based подход на своих сигналах: граф
 * похожих артистов вместо матрицы, локальная история вместо чужих сессий.
 * Поэтому «близость к профилю» здесь — это близость по артисту и по стилю, а не
 * «люди, похожие на вас, слушали».
 */

import { UnifiedTrack } from '../types/music';
import {
  TasteProfile,
  artistAffinity,
  normalizeArtistKey,
  tagAffinity
} from './tasteProfile';

/** Откуда пришёл кандидат. Источник влияет и на доверие, и на разнообразие. */
export type CandidatePool =
  | 'seed_related'
  | 'artist_top'
  | 'similar_artist'
  | 'playlist_neighbour'
  | 'tag_search'
  | 'forgotten'
  | 'explore'
  | 'fallback';

/**
 * Доверие к источнику кандидата, 0..1.
 *
 * Топ-треки артиста с его страницы — это заведомо его песни; выдача текстового
 * поиска по стилю — уже гадание, а «просто что-нибудь популярное» — последняя
 * соломинка. Признак нужен, чтобы при равной близости к профилю побеждал более
 * надёжный путь, а не тот, чей запрос случайно оказался первым.
 */
export const POOL_TRUST: Record<CandidatePool, number> = {
  seed_related: 0.9,
  artist_top: 0.95,
  similar_artist: 0.72,
  playlist_neighbour: 0.7,
  tag_search: 0.55,
  forgotten: 0.85,
  explore: 0.5,
  fallback: 0.3
};

export interface WaveCandidate {
  track: UnifiedTrack;
  pool: CandidatePool;
  /** Через какого артиста профиля кандидат сюда попал — для подписи «почему». */
  via?: string;
  /**
   * Близость, посчитанная на этапе генерации: для похожего артиста это вес
   * родителя, помноженный на похожесть. Профиль о таком артисте ничего не знает,
   * поэтому без этого поля кандидат выглядел бы совершенно чужим.
   */
  seedAffinity?: number;
  /** Переопределение доверия, если у конкретного кандидата оно другое. */
  trust?: number;
}

export interface CandidateFeatures {
  /** Близость к профилю по артисту (и по родителю, через которого нашли). */
  affinity: number;
  /** Совпадение стиля с профилем или с выбранным жанром. */
  tagMatch: number;
  /** Насколько трек новый для человека. */
  novelty: number;
  /** Давно ли играло: только что — плохо, никогда или давно — хорошо. */
  freshness: number;
  /** Доверие к источнику. */
  trust: number;
  /** Попадание в выбранную энергию. */
  energyFit: number;
}

export interface RankedCandidate {
  track: UnifiedTrack;
  pool: CandidatePool;
  via?: string;
  /** Итоговый счёт после множителей-штрафов. */
  score: number;
  /** Счёт до штрафов — по нему видно, за что трек взяли. */
  baseScore: number;
  /** Произведение штрафов, 0..1. Единица — ни за что не наказан. */
  penalty: number;
  features: CandidateFeatures;
  /** Трек взят «в сторону», ради исследования, а не потому что похож. */
  isExploration: boolean;
}

/** Ниже этой близости кандидат считается исследованием, а не попаданием в вкус. */
export const EXPLORATION_AFFINITY_THRESHOLD = 0.15;

/** Сколько треков одного артиста допустимо в одной выдаче. */
export const MAX_TRACKS_PER_ARTIST = 2;
/** Столько же, но для «Потока от артиста» и радио трека. */
export const MAX_TRACKS_PER_SEED_ARTIST = 3;
/** Минимальный разнос между треками одного артиста. */
export const MIN_ARTIST_GAP = 3;
/** Сколько треков подряд может дать один источник (YouTube/SoundCloud). */
export const MAX_SAME_SOURCE_RUN = 3;
/** Сколько треков подряд может дать один пул кандидатов. */
export const MAX_SAME_POOL_RUN = 3;

/**
 * Доля исследования по краям регулятора знакомости.
 *
 * Ноль недопустим даже на «только знакомое»: подборка без единого нового трека
 * через неделю вырождается в один и тот же круг — ровно та жалоба, с которой всё
 * началось. Потолок тоже не единица: «Поток» без знакомого перестаёт быть своим.
 */
export const MIN_EXPLORATION_RATIO = 0.1;
export const MAX_EXPLORATION_RATIO = 0.35;

/** Насколько сильно счёт дрожит от сеялки: столько же волн, но не одна и та же. */
export const DEFAULT_JITTER = 0.12;

/**
 * Свежесть по времени последнего прослушивания.
 *
 * Штрафовать «знакомое» нельзя — за знакомым в «Поток» и приходят, — а вот
 * повтор того, что играло час назад, это поломка при любом положении
 * регуляторов. Поэтому здесь именно время, а не факт знакомства.
 */
export function freshnessScore(lastPlayedAt: number | undefined, now: number): number {
  if (!lastPlayedAt || !Number.isFinite(lastPlayedAt) || lastPlayedAt <= 0) return 1;
  const ageMs = Math.max(0, now - lastPlayedAt);
  const hours = ageMs / (60 * 60 * 1000);
  if (hours < 6) return 0.05;
  if (hours < 24) return 0.25;
  if (hours < 24 * 7) return 0.6;
  if (hours < 24 * 30) return 0.85;
  return 1;
}

/** Класс энергии: 0 — спокойное, 1 — среднее, 2 — бодрое. */
export type EnergyClass = 0 | 1 | 2;

const CALM_WORDS = [
  'ambient', 'lofi', 'lo-fi', 'chill', 'relax', 'calm', 'sleep', 'slow', 'acoustic',
  'piano', 'meditation', 'peaceful', 'soft', 'downtempo', 'mellow', 'nocturne', 'lullaby'
];
const HOT_WORDS = [
  'workout', 'gym', 'pump', 'banger', 'hard', 'rave', 'party', 'hype', 'energy',
  'dance', 'edm', 'bass', 'metal', 'punk', 'phonk', 'drill', 'hardstyle', 'anthem', 'power'
];

/**
 * Энергия трека по названию. Прямых замеров темпа и громкости у нас нет — ни
 * YouTube, ни SoundCloud их не отдают, — поэтому это заведомо приблизительная
 * оценка по словам, и она работает только как мягкое предпочтение, а не как
 * фильтр. Врать про точность не будем: у трека без говорящего названия энергия
 * «средняя».
 */
export function energyClass(track: Pick<UnifiedTrack, 'title' | 'artist'>): EnergyClass {
  const haystack = `${track?.title || ''} ${track?.artist || ''}`.toLowerCase();
  const calm = CALM_WORDS.some((word) => haystack.includes(word));
  const hot = HOT_WORDS.some((word) => haystack.includes(word));
  if (calm && !hot) return 0;
  if (hot && !calm) return 2;
  return 1;
}

/** Куда целимся по энергии при данном положении регулятора. */
export function targetEnergyClass(energy: number): EnergyClass {
  if (energy < 0.35) return 0;
  if (energy > 0.65) return 2;
  return 1;
}

export interface ScoreContext {
  profile: TasteProfile;
  /** 0 — только знакомое, 1 — только незнакомое. */
  novelty: number;
  /** 0 — спокойное, 1 — бодрое. */
  energy: number;
  /** Явно выбранный жанр, если человек его выбрал. */
  genre?: string;
  /** Треки, которые «Поток» уже отдавал за последнее время. */
  recentlyServed?: Set<string>;
  now: number;
}

/** Веса признаков при данном положении регулятора знакомости. */
export function resolveFeatureWeights(novelty: number): {
  affinity: number;
  tagMatch: number;
  novelty: number;
  freshness: number;
  trust: number;
  energyFit: number;
} {
  const n = Math.max(0, Math.min(1, Number.isFinite(novelty) ? novelty : 0.35));
  return {
    // Знакомость и новизна расходятся зеркально: регулятор перекладывает вес с
    // одной на другую, а не добавляет к обеим.
    affinity: 0.05 + 0.45 * (1 - n),
    novelty: 0.05 + 0.45 * n,
    tagMatch: 0.18,
    trust: 0.14,
    freshness: 0.1,
    energyFit: 0.08
  };
}

/** Оценивает одного кандидата. Чистая функция от профиля и контекста. */
export function scoreCandidate(candidate: WaveCandidate, ctx: ScoreContext): RankedCandidate {
  const { profile, now } = ctx;
  const track = candidate.track;
  const artistKey = normalizeArtistKey(track.artist);

  const ownAffinity = artistAffinity(profile, track.artist);
  const inherited = Math.max(0, Math.min(1, candidate.seedAffinity ?? 0));
  const affinity = Math.max(ownAffinity, inherited);

  let tagMatch = tagAffinity(profile, track);
  if (ctx.genre) {
    const genreLower = ctx.genre.trim().toLowerCase();
    const haystack = `${track.title || ''} ${track.artist || ''}`.toLowerCase();
    // Явно выбранный жанр весит больше угаданного: человек сказал словами.
    if (genreLower && haystack.includes(genreLower)) tagMatch = Math.min(1, tagMatch + 0.6);
  }

  const knownTrack = profile.tracks.has(track.id) || profile.favoriteTrackIds.has(track.id);
  const knownArtist = artistKey ? profile.artists.has(artistKey) : false;
  let novelty: number;
  if (!knownTrack && !knownArtist) novelty = 1;
  else if (!knownTrack) novelty = 0.55;
  else novelty = 0.1;

  const freshness = freshnessScore(profile.lastPlayedAt.get(track.id), now);
  const trust = candidate.trust ?? POOL_TRUST[candidate.pool] ?? 0.5;

  const target = targetEnergyClass(ctx.energy);
  const distance = Math.abs(energyClass(track) - target);
  const energyFit = distance === 0 ? 1 : distance === 1 ? 0.6 : 0.2;

  const weights = resolveFeatureWeights(ctx.novelty);
  const baseScore =
    affinity * weights.affinity +
    tagMatch * weights.tagMatch +
    novelty * weights.novelty +
    freshness * weights.freshness +
    trust * weights.trust +
    energyFit * weights.energyFit;

  // Штрафы множителями, а не вычитанием: отказ должен утопить трек независимо от
  // того, сколько очков он набрал на остальных признаках.
  let penalty = 1;
  const trackTaste = profile.tracks.get(track.id);
  if (trackTaste?.earlySkips && trackTaste.earlySkips > 0) penalty *= 0.12;
  else if (profile.rejectedTrackIds.has(track.id)) penalty *= 0.2;
  if (artistKey && profile.rejectedArtists.has(artistKey)) penalty *= 0.15;
  if (ctx.recentlyServed?.has(track.id)) penalty *= 0.25;

  const features: CandidateFeatures = { affinity, tagMatch, novelty, freshness, trust, energyFit };

  return {
    track,
    pool: candidate.pool,
    via: candidate.via,
    score: baseScore * penalty,
    baseScore,
    penalty,
    features,
    isExploration: candidate.pool === 'explore' || affinity < EXPLORATION_AFFINITY_THRESHOLD
  };
}

/**
 * Хэш от сеялки и строки. Дрожание счёта берётся отсюда, а не из
 * последовательного генератора: так значение зависит только от самого трека, а
 * не от того, каким по порядку он оказался в массиве. Иначе один добавленный
 * кандидат перетряхивал бы всю выдачу.
 */
export function seededUnit(seed: number, key: string): number {
  let hash = (seed | 0) ^ 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0x5bd1e995);
  hash ^= hash >>> 15;
  return (hash >>> 0) / 4294967296;
}

/** Доля исследования при данном положении регулятора знакомости. */
export function explorationRatio(novelty: number): number {
  const n = Math.max(0, Math.min(1, Number.isFinite(novelty) ? novelty : 0.35));
  return MIN_EXPLORATION_RATIO + (MAX_EXPLORATION_RATIO - MIN_EXPLORATION_RATIO) * n;
}

export interface ArrangeOptions {
  limit: number;
  maxPerArtist?: number;
  minArtistGap?: number;
  maxSameSourceRun?: number;
  maxSamePoolRun?: number;
  /** Доля слотов под исследование, 0..1. */
  explorationRatio?: number;
  /** Сеялка дрожания. `undefined` — без дрожания, порядок строго по счёту. */
  seed?: number;
  jitter?: number;
  /** Не ставить рядом треки с сильно разной энергией. */
  smoothEnergy?: boolean;
}

interface Slot {
  candidate: RankedCandidate;
  artist: string;
  /** Счёт с дрожанием — по нему и идёт отбор. */
  effective: number;
  energy: EnergyClass;
  dedupe: string;
}

function dedupeSignature(track: UnifiedTrack): string {
  const artist = normalizeArtistKey(track.artist);
  const title = (track.title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${artist}::${title}`;
}

/**
 * Раскладывает оценённых кандидатов в готовую подборку.
 *
 * Порядок задаёт счёт, но четыре ограничения не дают выдаче выродиться в
 * однообразие: лимит на артиста, разнос между его треками, длина серии с одного
 * сервиса и длина серии из одного пула. Ограничения снимаются по одному, если
 * иначе список окажется короче запрошенного, — короткая подборка хуже
 * однообразной, а пустая хуже всех.
 *
 * Отдельно резервируется доля слотов под исследование, и они расставляются
 * равномерно, а не сваливаются в хвост: пять новых треков подряд в конце — это
 * не «доля исследования», а отдельная подборка, приклеенная к первой.
 */
export function arrangeRanked(
  ranked: RankedCandidate[],
  options: ArrangeOptions
): RankedCandidate[] {
  const limit = Math.max(0, Math.floor(options.limit));
  if (limit === 0) return [];

  const maxPerArtist = options.maxPerArtist ?? MAX_TRACKS_PER_ARTIST;
  const minArtistGap = options.minArtistGap ?? MIN_ARTIST_GAP;
  const maxSourceRun = options.maxSameSourceRun ?? MAX_SAME_SOURCE_RUN;
  const maxPoolRun = options.maxSamePoolRun ?? MAX_SAME_POOL_RUN;
  const jitter = options.seed === undefined ? 0 : (options.jitter ?? DEFAULT_JITTER);
  const smoothEnergy = options.smoothEnergy !== false;

  const seenIds = new Set<string>();
  const seenDedupe = new Set<string>();
  const slots: Slot[] = [];

  for (const candidate of ranked) {
    const track = candidate?.track;
    if (!track || !track.id) continue;
    if (seenIds.has(track.id)) continue;
    const dedupe = dedupeSignature(track);
    // Одна и та же песня, залитая дважды, — это один трек. Пустая подпись
    // (нет ни артиста, ни названия) от склейки освобождается.
    if (dedupe !== '::' && seenDedupe.has(dedupe)) continue;
    seenIds.add(track.id);
    if (dedupe !== '::') seenDedupe.add(dedupe);

    const noise =
      jitter > 0 ? 1 + jitter * (seededUnit(options.seed as number, track.id) - 0.5) * 2 : 1;
    slots.push({
      candidate,
      artist: normalizeArtistKey(track.artist),
      effective: candidate.score * noise,
      energy: energyClass(track),
      dedupe
    });
  }

  slots.sort(
    (a, b) =>
      b.effective - a.effective || a.candidate.track.id.localeCompare(b.candidate.track.id)
  );

  const exploreSlots = slots.filter((slot) => slot.candidate.isExploration);
  const exploitSlots = slots.filter((slot) => !slot.candidate.isExploration);

  const ratio = Math.max(0, Math.min(1, options.explorationRatio ?? 0));
  const wantedExplore = Math.min(exploreSlots.length, Math.round(limit * ratio));

  const result: RankedCandidate[] = [];
  const taken = new Set<Slot>();
  const artistCounts = new Map<string, number>();
  const artistLastAt = new Map<string, number>();
  let sourceRun = { source: '', length: 0 };
  let poolRun = { pool: '', length: 0 };
  let exploreTaken = 0;
  let lastEnergy: EnergyClass | null = null;

  /**
   * Тир 0 — все правила. Дальше отпускаем по одному: серию пула, серию
   * источника, разнос артиста, лимит на артиста. Тир 4 — чистый счёт, на нём
   * подходит любой кандидат, поэтому цикл всегда завершается.
   */
  const eligible = (slot: Slot, tier: number): boolean => {
    if (tier < 1 && poolRun.pool === slot.candidate.pool && poolRun.length >= maxPoolRun) {
      return false;
    }
    if (tier < 2 && sourceRun.source === slot.candidate.track.source && sourceRun.length >= maxSourceRun) {
      return false;
    }
    // Без имени артиста ограничивать нечего: пустой ключ склеил бы в одного
    // «артиста» все треки без метаданных.
    if (!slot.artist) return true;
    if (tier < 3) {
      const lastAt = artistLastAt.get(slot.artist);
      if (lastAt !== undefined && result.length - lastAt < minArtistGap) return false;
    }
    if (tier < 4 && (artistCounts.get(slot.artist) || 0) >= maxPerArtist) return false;
    return true;
  };

  /** Лучший кандидат из набора с учётом плавности по энергии. */
  const pickFrom = (pool: Slot[]): Slot | null => {
    for (let tier = 0; tier <= 4; tier += 1) {
      let best: Slot | null = null;
      let bestValue = -Infinity;
      for (const slot of pool) {
        if (taken.has(slot)) continue;
        if (!eligible(slot, tier)) continue;
        // Плавность — надбавка, а не правило: она решает споры между близкими
        // по счёту треками и никогда не выкидывает заметно лучший.
        const smooth =
          smoothEnergy && lastEnergy !== null && Math.abs(slot.energy - lastEnergy) >= 2 ? 0.93 : 1;
        const value = slot.effective * smooth;
        if (value > bestValue) {
          bestValue = value;
          best = slot;
        }
      }
      if (best) return best;
    }
    return null;
  };

  while (result.length < limit && taken.size < slots.length) {
    // Слоты исследования расставляются равномерно: к позиции `i` их должно быть
    // отдано примерно `i * wantedExplore / limit`.
    const dueExplore =
      wantedExplore > 0 &&
      Math.floor(((result.length + 1) * wantedExplore) / limit) > exploreTaken;

    let picked = dueExplore ? pickFrom(exploreSlots) : pickFrom(exploitSlots);
    if (!picked) picked = dueExplore ? pickFrom(exploitSlots) : pickFrom(exploreSlots);
    if (!picked) break;

    taken.add(picked);
    if (picked.candidate.isExploration) exploreTaken += 1;

    if (picked.artist) {
      artistCounts.set(picked.artist, (artistCounts.get(picked.artist) || 0) + 1);
      artistLastAt.set(picked.artist, result.length);
    }
    sourceRun =
      sourceRun.source === picked.candidate.track.source
        ? { source: sourceRun.source, length: sourceRun.length + 1 }
        : { source: picked.candidate.track.source, length: 1 };
    poolRun =
      poolRun.pool === picked.candidate.pool
        ? { pool: poolRun.pool, length: poolRun.length + 1 }
        : { pool: picked.candidate.pool, length: 1 };
    lastEnergy = picked.energy;

    result.push(picked.candidate);
  }

  return result;
}

/**
 * Оценивает и раскладывает за один вызов — то, чем «Поток» пользуется в бою.
 * Всё, что здесь происходит, воспроизводимо: те же кандидаты, тот же профиль и
 * та же сеялка дают ту же подборку.
 */
export function rankWaveCandidates(
  candidates: WaveCandidate[],
  ctx: ScoreContext,
  options: ArrangeOptions
): RankedCandidate[] {
  const ranked = candidates
    .filter((candidate) => candidate?.track?.id)
    .filter((candidate) => !ctx.profile.dislikedTrackIds.has(candidate.track.id))
    .map((candidate) => scoreCandidate(candidate, ctx));

  return arrangeRanked(ranked, {
    explorationRatio: explorationRatio(ctx.novelty),
    ...options
  });
}
