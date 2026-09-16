/**
 * Память о том, какую запись мы уже однажды подтвердили.
 *
 * Подбор по названию — догадка: одинаковых названий много, у одного
 * исполнителя есть альбомная версия, сингловая и живая, а каталоги пишут одно и
 * то же по-разному. Догадка стоит запроса к источнику и иногда ошибается.
 *
 * Поэтому ответ, который однажды оказался верным, здесь запоминается:
 *
 *   • человек выбрал строку вручную при переносе плейлиста — выбор окончателен;
 *   • замена при отказе источника действительно сыграла — значит для этой
 *     записи известен рабочий запасной источник, и в следующий раз искать
 *     заново незачем.
 *
 * Ключ нарочно не идентификатор чужого сервиса, а нормализованная тройка
 * «исполнитель, название, длительность»: так одна таблица обслуживает перенос
 * из любого каталога и подмену при воспроизведении, и работает даже там, где
 * чужого идентификатора у нас нет вовсе (разбор публичной страницы его не даёт).
 */

import { db, MatchLinkRecord } from './db';
import { normalizeForMatch } from './trackMatching';
import { AudioSource, UnifiedTrack } from '../types/music';

/**
 * Огрубление длительности, в секундах.
 *
 * Длительность одной и той же записи расходится у источников на секунду-другую
 * (разные кодировки, тишина в хвосте), поэтому точное число ключом быть не
 * может. Пять секунд — шире расхождения и уже разницы между версиями: радио-
 * версия короче альбомной на десятки секунд.
 */
const DURATION_BUCKET_S = 5;

/** Сколько связей храним. Дальше чистим самые старые из неподтверждённых руками. */
const MAX_LINKS = 5000;

export interface LinkTarget {
  title: string;
  artist?: string;
  duration?: number;
}

/**
 * Ключ связи. Пустая строка означает «ключа нет» — связывать нечего.
 *
 * Длительность входит в ключ, но необязательна: у разбора публичных страниц её
 * часто нет, и без неё ключ всё равно осмысленный — просто чуть более общий.
 */
export function linkKey(target: LinkTarget): string {
  const title = normalizeForMatch(target.title);
  if (!title) return '';
  const artist = normalizeForMatch(target.artist);
  const bucket =
    typeof target.duration === 'number' && Number.isFinite(target.duration) && target.duration > 0
      ? String(Math.round(target.duration / DURATION_BUCKET_S))
      : '';
  return `${artist}:::${title}:::${bucket}`;
}

/** Подтверждённая запись для этой строки, или null. Никогда не бросает. */
export async function findLink(target: LinkTarget): Promise<MatchLinkRecord | null> {
  const key = linkKey(target);
  if (!key) return null;
  try {
    return (await db.matchLinks.get(key)) ?? null;
  } catch (err) {
    console.warn('[MatchLinks] чтение не удалось:', err);
    return null;
  }
}

/**
 * Запоминает подтверждённое соответствие.
 *
 * Ручной выбор не перебивается автоматическим: человек уже сказал, что верно, и
 * удачная замена при воспроизведении — не повод это пересматривать.
 */
export async function rememberLink(
  target: LinkTarget,
  track: UnifiedTrack,
  manual = false
): Promise<void> {
  const key = linkKey(target);
  if (!key || !track?.originalId) return;

  try {
    const existing = await db.matchLinks.get(key);
    if (existing?.manual && !manual) return;

    await db.matchLinks.put({
      key,
      source: track.source,
      originalId: track.originalId,
      title: track.title,
      artist: track.artist,
      confirmedAt: Date.now(),
      manual: manual || existing?.manual === true
    });
    await prune();
  } catch (err) {
    console.warn('[MatchLinks] запись не удалась:', err);
  }
}

/** Забывает связь — например, когда сохранённая запись перестала играть. */
export async function forgetLink(target: LinkTarget): Promise<void> {
  const key = linkKey(target);
  if (!key) return;
  try {
    await db.matchLinks.delete(key);
  } catch (err) {
    console.warn('[MatchLinks] удаление не удалось:', err);
  }
}

/**
 * Собирает трек из связи, дополняя его тем, что знаем о цели.
 *
 * Связь хранит только опознавательные данные: обложка и длительность берутся из
 * исходной строки, потому что играть всё равно будем по идентификатору.
 */
export function trackFromLink(link: MatchLinkRecord, target: LinkTarget & { artworkUrl?: string }): UnifiedTrack {
  return {
    id: `${link.source === 'youtube' ? 'yt' : 'sc'}_${link.originalId}`,
    source: link.source as AudioSource,
    originalId: link.originalId,
    title: link.title || target.title,
    artist: link.artist || target.artist || '',
    duration: target.duration || 0,
    artworkUrl: target.artworkUrl || ''
  };
}

/** Держит таблицу в берегах: лишние — самые старые из тех, что выбрали не руками. */
async function prune(): Promise<void> {
  try {
    const count = await db.matchLinks.count();
    if (count <= MAX_LINKS) return;
    const stale = await db.matchLinks.orderBy('confirmedAt').limit(count - MAX_LINKS).toArray();
    const removable = stale.filter((entry) => entry.manual !== true).map((entry) => entry.key);
    if (removable.length > 0) await db.matchLinks.bulkDelete(removable);
  } catch (err) {
    console.warn('[MatchLinks] чистка не удалась:', err);
  }
}
