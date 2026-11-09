/**
 * Теги и заметки к трекам (идея 13 плана 4.0).
 *
 * Своя пометка к песне: «для бега», «показать Диме», «припев в 1:12». Теги —
 * короткие слова, по которым ищут и фильтруют; заметка — свободный текст,
 * который читают, открыв трек.
 *
 * Хранится ТОЛЬКО на устройстве: ни на сервер, ни между устройствами пометки
 * не ходят. Синхронизация запланирована на 4.1 — для неё в записи уже лежит
 * `updatedAt`, чтобы сливать по «что новее». Сейчас же это личный блокнот
 * внутри приложения, и терять его при смене телефона — известное ограничение.
 *
 * Устройство: все записи держатся в памяти (их немного — пометок у человека
 * десятки, не тысячи) и читаются синхронно, чтобы `useSyncExternalStore` в
 * карточках мог спросить «есть ли у этого трека теги» на каждом рендере без
 * обращения к базе. База — хранилище между запусками: при старте кэш
 * наполняется из неё, каждое изменение пишется в неё же.
 */

import { db, type TrackNoteRecord } from './db';

export type { TrackNoteRecord } from './db';

/** Длиннее — уже не тег, а заметка. */
export const MAX_TAG_LENGTH = 24;

/** Чтобы карточка не превращалась в облако тегов. */
export const MAX_TAGS_PER_TRACK = 12;

export interface TagCount {
  tag: string;
  count: number;
}

const cache = new Map<string, TrackNoteRecord>();
const listeners = new Set<() => void>();
let version = 0;
let hydration: Promise<void> | null = null;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Приводит ввод к виду, в котором тег хранится: без краевых пробелов и
 * решётки впереди, пробелы внутри схлопнуты, не длиннее {@link MAX_TAG_LENGTH}.
 * Регистр сохраняется — человек написал «Диме» и хочет видеть «Диме»;
 * сравнивать надо через {@link tagKey}. Пустая строка — «тега нет».
 */
export function cleanTag(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/^[\s#]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TAG_LENGTH)
    .trim();
}

/** Ключ сравнения: «Бег», «бег» и «БЕГ» — один тег; «ё» и «е» тоже не спорят. */
export function tagKey(tag: string): string {
  return cleanTag(tag).toLowerCase().replace(/ё/g, 'е');
}

/** Чистит список: пустые выбрасывает, дубли по ключу схлопывает, первое написание остаётся. */
export function normalizeTags(tags: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = cleanTag(raw);
    const key = tagKey(tag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS_PER_TRACK) break;
  }
  return result;
}

/**
 * Читает все пометки из базы в кэш. Идемпотентно: второй вызов возвращает тот
 * же промис. Записи, уже изменённые в кэше до окончания чтения, не
 * затираются — иначе тег, поставленный на первой секунде после запуска,
 * исчезал бы, когда дочитается база.
 */
export function hydrateTrackNotes(): Promise<void> {
  if (hydration) return hydration;
  hydration = db.trackNotes
    .toArray()
    .then((rows) => {
      let changed = false;
      for (const row of rows) {
        if (!row?.trackId || cache.has(row.trackId)) continue;
        cache.set(row.trackId, {
          trackId: row.trackId,
          tags: normalizeTags(Array.isArray(row.tags) ? row.tags : []),
          note: typeof row.note === 'string' ? row.note : '',
          updatedAt: row.updatedAt ?? 0
        });
        changed = true;
      }
      if (changed) notify();
    })
    .catch((err) => {
      console.warn('[trackNotes] Не удалось прочитать пометки:', err);
    });
  return hydration;
}

/** Пометка трека из кэша; `null` — пометки нет. Синхронно, для хуков. */
export function getNote(trackId: string): TrackNoteRecord | null {
  return cache.get(trackId) ?? null;
}

/** Теги трека; пустой массив, если пометки нет. */
export function getTags(trackId: string): string[] {
  return cache.get(trackId)?.tags ?? [];
}

/** Номер изменения кэша — для `useSyncExternalStore` там, где снимок считается. */
export function getVersion(): number {
  return version;
}

async function persist(trackId: string, next: { tags: string[]; note: string }): Promise<void> {
  const tags = normalizeTags(next.tags);
  const note = next.note.trim();

  // Пустая пометка — не пометка: запись удаляется, а не остаётся висеть пустой,
  // иначе «все теги» и фильтры тащили бы за собой мусорные строки.
  if (tags.length === 0 && note.length === 0) {
    const existed = cache.delete(trackId);
    if (existed) notify();
    try {
      await db.trackNotes.delete(trackId);
    } catch (err) {
      console.warn('[trackNotes] Не удалось удалить пометку:', err);
    }
    return;
  }

  const record: TrackNoteRecord = { trackId, tags, note, updatedAt: Date.now() };
  cache.set(trackId, record);
  notify();
  try {
    await db.trackNotes.put(record);
  } catch (err) {
    console.warn('[trackNotes] Не удалось сохранить пометку:', err);
  }
}

/** Заменяет теги трека; заметка остаётся. */
export function setTags(trackId: string, tags: ReadonlyArray<string>): Promise<void> {
  const current = cache.get(trackId);
  return persist(trackId, { tags: [...tags], note: current?.note ?? '' });
}

/** Добавляет один тег, если такого (по ключу) ещё нет. */
export function addTag(trackId: string, tag: string): Promise<void> {
  const clean = cleanTag(tag);
  if (!clean) return Promise.resolve();
  const current = getTags(trackId);
  if (current.some((t) => tagKey(t) === tagKey(clean))) return Promise.resolve();
  return setTags(trackId, [...current, clean]);
}

/** Убирает тег по ключу — регистр не важен. */
export function removeTag(trackId: string, tag: string): Promise<void> {
  const key = tagKey(tag);
  return setTags(
    trackId,
    getTags(trackId).filter((t) => tagKey(t) !== key)
  );
}

/** Заменяет заметку трека; теги остаются. */
export function setNote(trackId: string, note: string): Promise<void> {
  const current = cache.get(trackId);
  return persist(trackId, { tags: current?.tags ?? [], note });
}

/**
 * Все теги с частотой, по убыванию; при равной — по алфавиту. Написание
 * берётся то, что встретилось первым: «Бег» и «бег» — одна строка.
 */
export function allTags(): TagCount[] {
  const counts = new Map<string, TagCount>();
  for (const record of cache.values()) {
    for (const tag of record.tags) {
      const key = tagKey(tag);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ru')
  );
}

/** Id треков с этим тегом (сравнение по ключу). */
export function tracksWithTag(tag: string): string[] {
  const key = tagKey(tag);
  if (!key) return [];
  const result: string[] = [];
  for (const record of cache.values()) {
    if (record.tags.some((t) => tagKey(t) === key)) result.push(record.trackId);
  }
  return result;
}

/** Теги по id трека — для фильтров и поиска, где треков много, а пометок мало. */
export function tagsById(): ReadonlyMap<string, ReadonlyArray<string>> {
  const map = new Map<string, ReadonlyArray<string>>();
  for (const record of cache.values()) {
    if (record.tags.length > 0) map.set(record.trackId, record.tags);
  }
  return map;
}

/** Живые обновления: слушатель зовётся после каждого изменения кэша. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Сброс для тестов: кэш, подписчики и состояние чтения базы. */
export function resetTrackNotesForTests(): void {
  cache.clear();
  listeners.clear();
  version = 0;
  hydration = null;
}
