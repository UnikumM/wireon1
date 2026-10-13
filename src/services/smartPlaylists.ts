/**
 * Умные плейлисты — списки по правилам, которые пересобираются сами.
 *
 * Идея из iTunes/Apple Music и MusicBee: не «положить треки», а описать, какие
 * нужны — «из избранного, слушал больше пяти раз, не звучало месяц» — и список
 * сам следит за медиатекой. Здесь правила проверяются по тому, что уже есть на
 * устройстве: избранное, треки плейлистов и вся история со счётчиками. В сеть
 * ничего не ходит, поэтому списки работают и офлайн.
 *
 * Хранятся они в настройках, а не в таблице плейлистов: синхронизация считает
 * плейлисты наборами треков, а у умного набора нет — есть только правила.
 */

import { UnifiedTrack } from '../types/music';
import { HistoryRecord } from './db';
import { normalizeSearchText } from './playlistTools';

export type SmartField =
  | 'artist'
  | 'title'
  | 'source'
  | 'plays'
  | 'skips'
  | 'lastPlayed'
  | 'added'
  | 'duration'
  | 'favorite';

export type SmartOp =
  | 'contains'
  | 'not_contains'
  | 'is'
  | 'is_not'
  | 'gte'
  | 'lte'
  | 'within_days'
  | 'not_within_days'
  | 'never';

export interface SmartRule {
  field: SmartField;
  op: SmartOp;
  /** Текст для строк, число для счётчиков (дни, разы, минуты), да/нет для избранного. */
  value: string | number | boolean;
}

export type SmartSort = 'plays' | 'recent' | 'added' | 'title' | 'artist' | 'random';

export interface SmartPlaylist {
  id: string;
  title: string;
  match: 'all' | 'any';
  rules: SmartRule[];
  sort: SmartSort;
  /** 0 — без ограничения. */
  limit: number;
  createdAt: number;
  updatedAt: number;
}

export interface SmartTrackFacts {
  track: UnifiedTrack;
  plays: number;
  skips: number;
  /** Последнее включение; `null` — ни разу. */
  lastPlayed: number | null;
  /** Когда положили в медиатеку (избранное или плейлист); `null` — неизвестно. */
  added: number | null;
  favorite: boolean;
}

export const SMART_FIELD_LABELS: Record<SmartField, string> = {
  artist: 'Исполнитель',
  title: 'Название',
  source: 'Источник',
  plays: 'Прослушиваний',
  skips: 'Пропусков',
  lastPlayed: 'Последнее прослушивание',
  added: 'Добавлен',
  duration: 'Длительность, мин',
  favorite: 'В избранном'
};

export const SMART_OP_LABELS: Record<SmartOp, string> = {
  contains: 'содержит',
  not_contains: 'не содержит',
  is: 'это',
  is_not: 'не',
  gte: 'не меньше',
  lte: 'не больше',
  within_days: 'за последние, дней',
  not_within_days: 'не было дней',
  never: 'никогда'
};

/** Какие сравнения имеют смысл для поля — по ним строится редактор. */
export const SMART_FIELD_OPS: Record<SmartField, SmartOp[]> = {
  artist: ['contains', 'not_contains', 'is', 'is_not'],
  title: ['contains', 'not_contains'],
  source: ['is', 'is_not'],
  plays: ['gte', 'lte'],
  skips: ['gte', 'lte'],
  lastPlayed: ['within_days', 'not_within_days', 'never'],
  added: ['within_days', 'not_within_days'],
  duration: ['gte', 'lte'],
  favorite: ['is']
};

export const SMART_SORT_LABELS: Record<SmartSort, string> = {
  plays: 'Чаще всего слушали',
  recent: 'Недавно слушали',
  added: 'Недавно добавили',
  title: 'По названию',
  artist: 'По исполнителю',
  random: 'Вперемешку'
};

/** Значение по умолчанию для нового правила этого поля. */
export function defaultRule(field: SmartField): SmartRule {
  const op = SMART_FIELD_OPS[field][0];
  switch (field) {
    case 'source':
      return { field, op, value: 'youtube' };
    case 'plays':
      return { field, op, value: 5 };
    case 'skips':
      return { field, op: 'lte', value: 0 };
    case 'lastPlayed':
      return { field, op: 'not_within_days', value: 30 };
    case 'added':
      return { field, op, value: 30 };
    case 'duration':
      return { field, op: 'lte', value: 4 };
    case 'favorite':
      return { field, op, value: true };
    default:
      return { field, op, value: '' };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function asNumber(value: SmartRule['value']): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Одно правило против одного трека. Пустой текст в правиле — правило не мешает. */
export function matchesRule(facts: SmartTrackFacts, rule: SmartRule, now: number): boolean {
  const { track } = facts;
  switch (rule.field) {
    case 'artist':
    case 'title': {
      const needle = normalizeSearchText(String(rule.value ?? ''));
      if (!needle) return true;
      const hay = normalizeSearchText(rule.field === 'artist' ? track.artist : track.title);
      if (rule.op === 'contains') return hay.includes(needle);
      if (rule.op === 'not_contains') return !hay.includes(needle);
      if (rule.op === 'is') return hay === needle;
      if (rule.op === 'is_not') return hay !== needle;
      return true;
    }
    case 'source':
      return rule.op === 'is_not' ? track.source !== rule.value : track.source === rule.value;
    case 'plays':
    case 'skips': {
      const actual = rule.field === 'plays' ? facts.plays : facts.skips;
      const target = asNumber(rule.value);
      return rule.op === 'lte' ? actual <= target : actual >= target;
    }
    case 'duration': {
      const minutes = (track.duration || 0) / 60;
      const target = asNumber(rule.value);
      // Неизвестная длительность не проходит ни «не больше», ни «не меньше».
      if (!track.duration) return false;
      return rule.op === 'lte' ? minutes <= target : minutes >= target;
    }
    case 'lastPlayed': {
      if (rule.op === 'never') return facts.lastPlayed === null;
      const since = now - asNumber(rule.value) * DAY_MS;
      if (rule.op === 'within_days') return facts.lastPlayed !== null && facts.lastPlayed >= since;
      // «Не было N дней» включает и никогда не игравшие.
      return facts.lastPlayed === null || facts.lastPlayed < since;
    }
    case 'added': {
      if (facts.added === null) return false;
      const since = now - asNumber(rule.value) * DAY_MS;
      return rule.op === 'within_days' ? facts.added >= since : facts.added < since;
    }
    case 'favorite':
      return facts.favorite === Boolean(rule.value);
    default:
      return true;
  }
}

export function matchesPlaylist(facts: SmartTrackFacts, playlist: Pick<SmartPlaylist, 'rules' | 'match'>, now: number): boolean {
  const rules = playlist.rules.filter(Boolean);
  if (rules.length === 0) return true;
  return playlist.match === 'any'
    ? rules.some((rule) => matchesRule(facts, rule, now))
    : rules.every((rule) => matchesRule(facts, rule, now));
}

/**
 * Всё, что известно о треках на устройстве, — одним списком без повторов.
 */
export function collectTrackFacts(input: {
  favorites: ReadonlyArray<UnifiedTrack>;
  playlistTracks: ReadonlyArray<UnifiedTrack>;
  history: ReadonlyArray<HistoryRecord>;
}): SmartTrackFacts[] {
  const map = new Map<string, SmartTrackFacts>();
  const ensure = (track: UnifiedTrack): SmartTrackFacts => {
    let facts = map.get(track.id);
    if (!facts) {
      facts = { track, plays: 0, skips: 0, lastPlayed: null, added: null, favorite: false };
      map.set(track.id, facts);
    }
    return facts;
  };
  const noteAdded = (facts: SmartTrackFacts, at?: number) => {
    if (typeof at === 'number' && at > 0) facts.added = facts.added === null ? at : Math.min(facts.added, at);
  };

  for (const track of input.favorites) {
    if (!track?.id) continue;
    const facts = ensure(track);
    facts.favorite = true;
    noteAdded(facts, track.addedAt);
  }
  for (const track of input.playlistTracks) {
    if (!track?.id) continue;
    noteAdded(ensure(track), track.addedAt);
  }
  for (const record of input.history) {
    if (!record?.track?.id) continue;
    const facts = ensure(record.track);
    facts.plays = Math.max(facts.plays, record.playCount || 0);
    facts.skips = Math.max(facts.skips, record.skipCount || 0);
    if (record.playCount > 0 || record.lastPlayedSeconds) {
      facts.lastPlayed = Math.max(facts.lastPlayed ?? 0, record.playedAt || 0) || null;
    }
  }
  return [...map.values()];
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0 || 1;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const collator =
  typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
    ? new Intl.Collator(['ru', 'en'], { sensitivity: 'base', numeric: true })
    : null;
const compareText = (a: string, b: string) => (collator ? collator.compare(a || '', b || '') : (a || '').localeCompare(b || ''));

/** Треки умного плейлиста. «Вперемешку» стабильно внутри суток, как миксы дня. */
export function evaluateSmartPlaylist(
  playlist: SmartPlaylist,
  facts: ReadonlyArray<SmartTrackFacts>,
  now: number
): UnifiedTrack[] {
  const matched = facts.filter((f) => matchesPlaylist(f, playlist, now));
  let sorted: SmartTrackFacts[];
  switch (playlist.sort) {
    case 'plays':
      sorted = [...matched].sort((a, b) => b.plays - a.plays || (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
      break;
    case 'recent':
      sorted = [...matched].sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
      break;
    case 'added':
      sorted = [...matched].sort((a, b) => (b.added ?? 0) - (a.added ?? 0));
      break;
    case 'title':
      sorted = [...matched].sort((a, b) => compareText(a.track.title, b.track.title));
      break;
    case 'artist':
      sorted = [...matched].sort(
        (a, b) => compareText(a.track.artist, b.track.artist) || compareText(a.track.title, b.track.title)
      );
      break;
    case 'random': {
      const day = Math.floor(now / DAY_MS);
      let seed = day;
      for (const ch of playlist.id) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
      sorted = seededShuffle(matched, seed);
      break;
    }
    default:
      sorted = matched;
  }
  const tracks = sorted.map((f) => f.track);
  return playlist.limit > 0 ? tracks.slice(0, playlist.limit) : tracks;
}

/** Правила одной строкой — подпись под карточкой. */
export function describeRules(playlist: Pick<SmartPlaylist, 'rules' | 'match'>): string {
  if (playlist.rules.length === 0) return 'Все треки медиатеки';
  const parts = playlist.rules.map((rule) => {
    const field = SMART_FIELD_LABELS[rule.field].toLowerCase();
    if (rule.field === 'favorite') return rule.value ? 'в избранном' : 'не в избранном';
    if (rule.op === 'never') return 'ни разу не слушали';
    if (rule.field === 'source') {
      const name = rule.value === 'soundcloud' ? 'SoundCloud' : 'YouTube';
      return rule.op === 'is_not' ? `не ${name}` : name;
    }
    if (rule.field === 'lastPlayed') {
      return rule.op === 'within_days' ? `слушали за ${rule.value} дн.` : `не слушали ${rule.value} дн.`;
    }
    if (rule.field === 'added') {
      return rule.op === 'within_days' ? `добавлены за ${rule.value} дн.` : `добавлены раньше ${rule.value} дн.`;
    }
    const value = typeof rule.value === 'string' ? `«${rule.value}»` : String(rule.value);
    return `${field} ${SMART_OP_LABELS[rule.op]} ${value}`;
  });
  return parts.join(playlist.match === 'any' ? ' или ' : ' · ');
}

export function newSmartPlaylistId(): string {
  return `smart_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Готовые заготовки — чтобы первый умный плейлист собирался в одно касание. */
export const SMART_PRESETS: ReadonlyArray<Omit<SmartPlaylist, 'id' | 'createdAt' | 'updatedAt'>> = [
  {
    title: 'Любимое, но забытое',
    match: 'all',
    rules: [
      { field: 'favorite', op: 'is', value: true },
      { field: 'lastPlayed', op: 'not_within_days', value: 30 }
    ],
    sort: 'random',
    limit: 50
  },
  {
    title: 'Топ-50 всех времён',
    match: 'all',
    rules: [{ field: 'plays', op: 'gte', value: 3 }],
    sort: 'plays',
    limit: 50
  },
  {
    title: 'Ещё не слушал',
    match: 'all',
    rules: [{ field: 'lastPlayed', op: 'never', value: 0 }],
    sort: 'added',
    limit: 0
  },
  {
    title: 'Короткие — до трёх минут',
    match: 'all',
    rules: [{ field: 'duration', op: 'lte', value: 3 }],
    sort: 'random',
    limit: 100
  }
];

/** Мягкая проверка того, что прочитано из настроек. */
export function sanitizeSmartPlaylists(value: unknown): SmartPlaylist[] {
  if (!Array.isArray(value)) return [];
  const fields = new Set(Object.keys(SMART_FIELD_LABELS));
  const sorts = new Set(Object.keys(SMART_SORT_LABELS));
  return value
    .filter((item): item is SmartPlaylist => Boolean(item && typeof item === 'object' && typeof (item as SmartPlaylist).id === 'string'))
    .map((item) => ({
      id: item.id,
      title: typeof item.title === 'string' && item.title.trim() ? item.title : 'Умный плейлист',
      match: item.match === 'any' ? 'any' : 'all',
      rules: Array.isArray(item.rules)
        ? item.rules.filter(
            (rule) => rule && fields.has(rule.field) && SMART_FIELD_OPS[rule.field].includes(rule.op)
          )
        : [],
      sort: sorts.has(item.sort) ? item.sort : 'plays',
      limit: typeof item.limit === 'number' && item.limit >= 0 ? Math.floor(item.limit) : 0,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now()
    }));
}
