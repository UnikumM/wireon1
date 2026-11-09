/**
 * Умный кроссфейд: длина перехода выбирается по паре треков, а не одним числом
 * на все случаи.
 *
 * Зачем. Один и тот же ползунок «5 секунд» хорош между случайными треками
 * плейлиста и портит альбом, где треки склеены автором: пять секунд наложения
 * размазывают переход, который задуман встык. И наоборот — короткой заставке
 * на минуту кроссфейд съедает заметную долю звучания.
 *
 * Правила, сверху вниз, первое подошедшее решает:
 *
 *   1. Базовая длина нулевая или кроссфейд выключен — 0. Умный режим ничего
 *      не включает сам, он только укорачивает.
 *   2. Оба трека из одного альбома — 0, склейка без зазора. «Один альбом» —
 *      это одинаковое название альбома и одинаковый исполнитель у обоих,
 *      после приведения к одному регистру и обрезки пробелов. Альбом без
 *      исполнителя не сравниваем: «Greatest Hits» бывает у кого угодно.
 *   3. У обоих известна длительность и хотя бы один короче 90 секунд — 0:
 *      интро, скиты и заставки звучат целиком.
 *   4. Иначе — базовая длина из настройки.
 *
 * Чего правила не делают нарочно: не угадывают по названию («Intro», «Pt. 2»),
 * не считают, что треки одного исполнителя подряд — из одного альбома, и не
 * пытаются определить плавный хвост по звуку. Если данных для решения нет
 * (альбом не указан, длительность неизвестна) — берётся базовая длина:
 * ошибиться в сторону привычного поведения дешевле, чем в сторону сюрприза.
 *
 * Модуль чистый: ни состояния, ни импорта плеера, чтобы его было просто
 * проверить и позвать откуда угодно.
 */

import type { UnifiedTrack } from '../types/music';

/** Короче этого — трек считается коротким, и ему кроссфейд не полагается. */
export const SHORT_TRACK_SECONDS = 90;

/** Верхняя граница длины перехода, та же, что у ползунка в настройках. */
const MAX_CROSSFADE_SECONDS = 12;

/** Пара треков, между которыми решается длина перехода. Любой может быть неизвестен. */
type MaybeTrack = Pick<UnifiedTrack, 'album' | 'artist' | 'duration'> | null | undefined;

/** Приведение подписи к виду для сравнения: регистр и пробелы по краям не считаются. */
function normalizeLabel(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Конечная положительная длительность, иначе `null` — «неизвестно». */
function knownDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Оба трека из одного альбома: совпали и альбом, и исполнитель.
 * Пустой альбом или пустой исполнитель хотя бы у одного — не «один альбом», а «неизвестно».
 */
export function isSameAlbum(current: MaybeTrack, next: MaybeTrack): boolean {
  if (!current || !next) return false;
  const album = normalizeLabel(current.album);
  const artist = normalizeLabel(current.artist);
  if (!album || !artist) return false;
  return album === normalizeLabel(next.album) && artist === normalizeLabel(next.artist);
}

/**
 * Хотя бы один из двух треков короткий. Решается только когда длительность
 * известна у обоих: про трек без длительности мы не знаем ничего.
 */
export function hasShortTrack(current: MaybeTrack, next: MaybeTrack): boolean {
  if (!current || !next) return false;
  const a = knownDuration(current.duration);
  const b = knownDuration(next.duration);
  if (a === null || b === null) return false;
  return a < SHORT_TRACK_SECONDS || b < SHORT_TRACK_SECONDS;
}

/**
 * Сколько секунд должен длиться переход от `current` к `next`, если в настройке
 * стоит `base`. Возвращает целое число секунд в пределах 0…12.
 */
export function pickCrossfadeSeconds(current: MaybeTrack, next: MaybeTrack, base: number): number {
  const baseSeconds =
    typeof base === 'number' && Number.isFinite(base) ? Math.max(0, Math.min(MAX_CROSSFADE_SECONDS, Math.round(base))) : 0;
  if (baseSeconds === 0) return 0;
  if (isSameAlbum(current, next)) return 0;
  if (hasShortTrack(current, next)) return 0;
  return baseSeconds;
}
