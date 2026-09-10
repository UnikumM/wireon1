/**
 * Сколько трека реально прозвучало.
 *
 * Прежде «время прослушивания» считалось как длительность × число включений, а
 * само включение засчитывалось в момент нажатия «играть» — до первой секунды
 * звука. Выключил на пятой секунде — в статистике оставалось три с половиной
 * минуты. Здесь считается то, что действительно прозвучало.
 *
 * Как считается. Не по позиции ползунка, а по её приросту: перемотка вперёд
 * даёт большой скачок, перемотка назад — отрицательный, и ни то ни другое
 * секундами не является. Поэтому в счёт идут только правдоподобные шаги.
 *
 * Как пишется. Не каждую секунду: одна вставка на прослушивание и правка раз в
 * пять секунд. Шестьдесят записей в минуту в IndexedDB ради числа, которое
 * нужно раз в день на экране статистики, — плохой обмен.
 *
 * Модуль намеренно ничего не знает о сторе: его вызывают снаружи, а он ходит
 * только в базу. Так он тестируется без интерфейса и без плеера.
 */

import { UnifiedTrack } from '../types/music';
import { commitPlay, recordAbandonedPlay, recordTrackSkip, updatePlaySeconds } from './db';
import { COMPLETION_RATIO, EARLY_SKIP_SECONDS } from './tasteProfile';

/** Как часто итог уходит в базу. Столько же ждёт запоминание сессии в плеере. */
export const FLUSH_INTERVAL_MS = 5000;

/**
 * Прирост больше этого — не звук, а перемотка.
 *
 * Обновления позиции приходят примерно четырежды в секунду; четыре секунды
 * разом не проигрываются никогда, зато именно так выглядит прыжок по полосе.
 */
const MAX_PLAUSIBLE_STEP_S = 4;

/**
 * Порог, с которого включение становится прослушиванием.
 *
 * Тридцать секунд или половина трека — что короче: у минутной зарисовки своя
 * половина, у десятиминутного концерта — своя. Ниже порога включения нет, зато
 * есть ранний пропуск: одно и то же событие, и рассогласовать их невозможно.
 */
export function playThresholdSeconds(duration?: number): number {
  const half = typeof duration === 'number' && duration > 0 ? duration / 2 : Infinity;
  return Math.min(EARLY_SKIP_SECONDS, half);
}

interface Session {
  track: UnifiedTrack;
  /** Сколько прозвучало. */
  seconds: number;
  /** Самая дальняя достигнутая точка — по ней решается «дослушано». */
  maxTime: number;
  /** Прошлая позиция, чтобы считать прирост. */
  lastTime: number;
  /** Ключ события в базе; появляется, когда прослушивание состоялось. */
  eventId: number | null;
  /** Сколько секунд уже записано — чтобы не писать одно и то же. */
  flushedSeconds: number;
  lastFlushAt: number;
  /** Уже отмечено дослушанным: второй раз считать нельзя. */
  completed: boolean;
}

let session: Session | null = null;

/** Только для тестов: забыть текущее прослушивание, ничего не записывая. */
export function resetPlaybackTracker(): void {
  session = null;
}

/** Прозвучавшие секунды текущего прослушивания — для тестов и диагностики. */
export function currentPlaySeconds(): number {
  return session ? session.seconds : 0;
}

/** Начинает новое прослушивание, закрывая предыдущее. */
export function beginPlay(track: UnifiedTrack): void {
  if (!track || !track.id) return;
  void endPlay();
  session = {
    track,
    seconds: 0,
    maxTime: 0,
    lastTime: 0,
    eventId: null,
    flushedSeconds: 0,
    lastFlushAt: Date.now(),
    completed: false
  };
}

/** Принимает позицию воспроизведения; сам решает, что из неё засчитать. */
export function noteProgress(currentTime: number, now: number = Date.now()): void {
  if (!session) return;
  if (typeof currentTime !== 'number' || !Number.isFinite(currentTime) || currentTime < 0) return;

  const delta = currentTime - session.lastTime;
  session.lastTime = currentTime;
  if (currentTime > session.maxTime) session.maxTime = currentTime;

  // Отрицательный шаг — перемотка назад или начало круга на повторе;
  // слишком большой — прыжок вперёд. Ни то, ни другое не звучало.
  if (delta > 0 && delta <= MAX_PLAUSIBLE_STEP_S) {
    session.seconds += delta;
  }

  if (now - session.lastFlushAt >= FLUSH_INTERVAL_MS) {
    void flush(now);
  }
}

/** Дослушан ли трек: по самой дальней достигнутой точке, а не по событию конца. */
function isCompleted(current: Session): boolean {
  const duration = current.track.duration;
  if (typeof duration !== 'number' || duration <= 0) return false;
  return current.maxTime >= duration * COMPLETION_RATIO;
}

/**
 * Уносит накопленное в базу.
 *
 * Первый сброс после порога заводит событие, следующие — дописывают его. Так на
 * прослушивание приходится одна вставка, а не по одной на каждые пять секунд.
 */
export async function flush(now: number = Date.now()): Promise<void> {
  const current = session;
  if (!current) return;

  current.lastFlushAt = now;
  const seconds = Math.round(current.seconds);
  if (seconds <= 0) return;
  if (seconds < playThresholdSeconds(current.track.duration) && current.eventId === null) return;
  if (seconds === current.flushedSeconds && !isCompleted(current)) return;

  const completed = isCompleted(current);

  if (current.eventId === null) {
    current.eventId = await commitPlay(current.track, { seconds, completed });
    current.completed = completed;
  } else {
    await updatePlaySeconds(current.eventId, seconds, completed && !current.completed);
    if (completed) current.completed = true;
  }
  current.flushedSeconds = seconds;
}

/**
 * Закрывает прослушивание и выносит вердикт.
 *
 * Три исхода: состоялось (событие уже есть или заводится здесь), не состоялось
 * — тогда это ранний пропуск, и он пишется в трек, — либо звука не было вовсе.
 */
export async function endPlay(): Promise<void> {
  const current = session;
  session = null;
  if (!current) return;

  const seconds = Math.round(current.seconds);
  if (seconds <= 0) return;

  if (seconds >= playThresholdSeconds(current.track.duration) || current.eventId !== null) {
    session = current;
    await flush(Date.now());
    session = null;
    return;
  }

  // Порога не набрали: прослушивания не было, был отказ. Пишется и в трек — для
  // подбора в «Потоке», — и событием, иначе окно «за неделю» о нём не узнает.
  await recordTrackSkip(current.track.id, seconds);
  await recordAbandonedPlay(current.track, seconds);
}
