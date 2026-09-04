import { UnifiedTrack } from '../types/music';
import { pluralize } from '../utils/plural';
import { HistoryRecord } from './db';
import { dedupeKey, isTopUpEligible, normalizeArtist } from './recommendationEngine';

/**
 * Миксы дня — несколько готовых подборок, собранных из того, что у человека
 * уже есть: медиатека, избранное, история.
 *
 * Отличие от «Потока»: Поток бесконечен и лезет в сеть, а микс это
 * фиксированный список, который целиком известен заранее и работает офлайн.
 * Состав меняется раз в сутки и внутри суток не пляшет — порядок задаёт сеялка
 * от даты, а не `Math.random()`, иначе список бы перетасовывался на каждом
 * перерисовывании.
 */

export interface DailyMix {
  /** Стабильный внутри суток: `mix_<дата>_<индекс>`. */
  id: string;
  title: string;
  /** Кем набит микс — человеческим языком. */
  subtitle: string;
  artworkUrl: string;
  tracks: UnifiedTrack[];
}

export const DAILY_MIX_SIZE = 20;
export const DAILY_MIX_COUNT = 3;
/** Меньше этого набирать нечего: «микс» из пяти треков — просто список. */
export const DAILY_MIX_MIN_TRACKS = 8;
export const DAILY_MIX_MIN_ARTISTS = 2;

/** `2026-08-18` по местному времени: сутки должны кончаться в полночь у человека. */
export function dailyMixDateKey(now: number = Date.now()): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Сеяный генератор: одна и та же дата — один и тот же порядок треков. */
function seededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleSeeded<T>(items: T[], seed: number): T[] {
  const result = [...items];
  const random = seededRandom(seed);
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export interface DailyMixInput {
  history?: HistoryRecord[];
  library?: UnifiedTrack[];
  favorites?: UnifiedTrack[];
  /** Обычно `dailyMixDateKey()`; в тестах — фиксированная строка. */
  dateKey: string;
  count?: number;
  size?: number;
}

interface ArtistGroup {
  key: string;
  name: string;
  /** Насколько человек любит этого артиста: прослушивания + избранное. */
  weight: number;
  tracks: UnifiedTrack[];
}

/**
 * Собирает подборки. Возвращает пустой массив, когда набирать не из чего —
 * пусть лучше раздела не будет, чем он покажет три случайных трека и назовёт
 * это миксом.
 */
export function buildDailyMixes(input: DailyMixInput): DailyMix[] {
  const size = Math.max(1, input.size ?? DAILY_MIX_SIZE);
  const count = Math.max(1, input.count ?? DAILY_MIX_COUNT);

  const favoriteKeys = new Set(
    (input.favorites || []).filter((track) => track && track.id).map((track) => dedupeKey(track))
  );

  const playsByArtist = new Map<string, number>();
  for (const record of input.history || []) {
    if (!record?.track?.id) continue;
    const key = normalizeArtist(record.track.artist);
    if (!key) continue;
    const plays = Math.max(1, Math.round(record.playCount || 1));
    playsByArtist.set(key, (playsByArtist.get(key) ?? 0) + plays);
  }

  // Пул: медиатека, избранное и то, что играли. Один и тот же трек с двух
  // сервисов — это один трек, иначе микс будет дублировать сам себя.
  const pool = new Map<string, UnifiedTrack>();
  const candidates: UnifiedTrack[] = [
    ...(input.library || []),
    ...(input.favorites || []),
    ...(input.history || []).flatMap((record) => (record?.track ? [record.track] : []))
  ];
  for (const track of candidates) {
    if (!track?.id || !isTopUpEligible(track)) continue;
    const key = dedupeKey(track);
    if (!pool.has(key)) pool.set(key, track);
  }

  if (pool.size < DAILY_MIX_MIN_TRACKS) return [];

  const groups = new Map<string, ArtistGroup>();
  for (const [key, track] of pool) {
    const artistKey = normalizeArtist(track.artist) || ' unknown';
    const group =
      groups.get(artistKey) ??
      ({
        key: artistKey,
        name: (track.artist || '').trim() || 'Неизвестный исполнитель',
        weight: playsByArtist.get(artistKey) ?? 0,
        tracks: []
      } satisfies ArtistGroup);
    group.tracks.push(track);
    if (favoriteKeys.has(key)) group.weight += 1;
    groups.set(artistKey, group);
  }

  if (groups.size < DAILY_MIX_MIN_ARTISTS) return [];

  const ranked = [...groups.values()].sort(
    (a, b) => b.weight - a.weight || b.tracks.length - a.tracks.length || a.name.localeCompare(b.name)
  );

  // Артистов раздаём по кругу: так в каждом миксе оказывается и любимое, и то,
  // что слушали пореже, а не один микс из фаворитов и два из остатков.
  const mixCount = Math.min(count, Math.max(1, Math.floor(groups.size / DAILY_MIX_MIN_ARTISTS)));
  const buckets: ArtistGroup[][] = Array.from({ length: mixCount }, () => []);
  ranked.forEach((group, index) => {
    buckets[index % mixCount].push(group);
  });

  const mixes: DailyMix[] = [];

  buckets.forEach((bucket, index) => {
    const seed = hashString(`${input.dateKey}:${index}:${bucket.map((g) => g.key).join('|')}`);

    // Внутри артиста порядок тоже сеяный, иначе микс всегда начинался бы с
    // одного и того же трека.
    const queues = bucket
      .map((group) => ({ name: group.name, tracks: shuffleSeeded(group.tracks, seed + hashString(group.key)) }))
      .filter((queue) => queue.tracks.length > 0);

    const picked: UnifiedTrack[] = [];
    let round = 0;
    while (picked.length < size) {
      const before = picked.length;
      for (const queue of queues) {
        if (picked.length >= size) break;
        const track = queue.tracks[round];
        if (track) picked.push(track);
      }
      if (picked.length === before) break; // очереди кончились
      round += 1;
    }

    if (picked.length < DAILY_MIX_MIN_TRACKS) return;

    const names = queues.map((queue) => queue.name);
    const lead = names[0];
    const others = names.length - 1;

    mixes.push({
      id: `mix_${input.dateKey}_${index + 1}`,
      title: `Микс дня · ${lead}`,
      subtitle:
        others > 0
          ? `${lead} и ещё ${pluralize(others, 'исполнитель', 'исполнителя', 'исполнителей')}`
          : lead,
      artworkUrl: picked[0]?.artworkUrl || '',
      tracks: picked
    });
  });

  return mixes;
}
