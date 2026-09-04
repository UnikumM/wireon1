/**
 * Арифметика совместного прослушивания: часы, позиция, решение слушателя.
 *
 * Здесь нет ни сети, ни плеера, ни хранилища — только счёт. Так сделано потому,
 * что именно счёт и ломался незаметно: разъехавшиеся на секунды часы двух
 * компьютеров выглядят точно так же, как задержка сети, а «отстал» и «убежал
 * вперёд» лечатся по-разному. Пока это было размазано по обработчику сообщений,
 * проверить его без двух настоящих машин было нельзя.
 *
 * Договорённость о знаках, её легко перепутать:
 * - `offsetMs` — часы ведущего минус часы слушателя. Положительный, когда у
 *   ведущего на часах больше.
 * - `drift` — позиция слушателя минус позиция ведущего. Положительный, когда
 *   слушатель убежал вперёд, отрицательный — когда отстал.
 */

/** Расхождение, которое человек уже слышит как рассинхрон. */
export const DRIFT_THRESHOLD_SECONDS = 0.35;

/**
 * Насколько далеко вперёд разрешено доводить позицию из снимка.
 *
 * Снимок «играет с секунды 30», пришедший с часовым опозданием, без этой границы
 * превратился бы в «встань на секунду 3630». Такой снимок не поправка, а мусор.
 */
export const MAX_PROJECTION_SECONDS = 30;

/**
 * Насколько назад может прыгнуть отметка ведущего, чтобы это ещё считалось
 * порядком доставки, а не переводом часов.
 *
 * Сообщения одного ведущего нумерует его собственные часы, поэтому «отметка
 * меньше уже применённой» — это обычная перестановка в пути, и такое сообщение
 * надо выбросить. Но если часы ведущего подвела синхронизация времени, назад
 * уедет всё дальнейшее, и слушатель оглохнет навсегда. Прыжок больше минуты
 * считаем новой точкой отсчёта.
 */
export const CLOCK_REBASELINE_MS = 60000;

/** Как часто ведущий подтверждает позицию, даже когда ничего не произошло. */
export const BEACON_INTERVAL_MS = 5000;

/**
 * Насколько позиция ведущего может отличаться от предсказанной, прежде чем это
 * считается перемоткой, а не обычным ходом воспроизведения.
 */
export const SEEK_TOLERANCE_SECONDS = 1;

/** Сколько замеров часов держим: по ним выбирается самый чистый. */
export const CLOCK_SAMPLE_LIMIT = 8;

// ---------------------------------------------------------------------------
// Часы
// ---------------------------------------------------------------------------

export interface ClockSample {
  /** Полный оборот «запрос — ответ», мс. */
  rttMs: number;
  /** Часы ведущего минус часы слушателя, мс. */
  offsetMs: number;
  /** Когда замер сделан, по локальным часам. */
  at: number;
}

/**
 * Замер по четырём отметкам, как это делает NTP.
 *
 * `t0` — слушатель отправил запрос, `t1` — ведущий его получил, `t2` — ведущий
 * ответил, `t3` — слушатель получил ответ. Первая и последняя отметки сняты с
 * часов слушателя, две средние — с часов ведущего.
 */
export function clockSampleFromRoundTrip(t0: number, t1: number, t2: number, t3: number): ClockSample {
  const rttMs = Math.max(0, t3 - t0 - Math.max(0, t2 - t1));
  const offsetMs = (t1 - t0 + (t2 - t3)) / 2;
  return { rttMs, offsetMs, at: t3 };
}

/**
 * Выбирает замер, которому стоит верить.
 *
 * Не среднее: одна задержка в очереди маршрутизатора уводит среднее на десятки
 * миллисекунд и держит его там. У замера с наименьшим оборотом меньше всего
 * примеси ожидания в пути, поэтому его смещение и ближе к настоящему.
 */
export function estimateClock(samples: ReadonlyArray<ClockSample>): { offsetMs: number; rttMs: number } | null {
  let best: ClockSample | null = null;
  for (const sample of samples) {
    if (!Number.isFinite(sample.rttMs) || !Number.isFinite(sample.offsetMs)) continue;
    // При равном обороте берём свежий: часы расходятся со временем.
    if (!best || sample.rttMs < best.rttMs || (sample.rttMs === best.rttMs && sample.at >= best.at)) {
      best = sample;
    }
  }
  if (!best) return null;
  return { offsetMs: best.offsetMs, rttMs: best.rttMs };
}

/** Держит окно замеров ограниченным, выбрасывая самые старые. */
export function pushClockSample(
  samples: ReadonlyArray<ClockSample>,
  sample: ClockSample,
  limit: number = CLOCK_SAMPLE_LIMIT
): ClockSample[] {
  const next = [...samples, sample];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

// ---------------------------------------------------------------------------
// Позиция
// ---------------------------------------------------------------------------

export interface RemoteSnapshot {
  senderId: string;
  /** Отметка часов ведущего в момент отправки. */
  hostTimestamp: number;
  trackId?: string;
  isPlaying: boolean;
  currentTime: number;
}

/**
 * Где ведущий находится сейчас, а не где он был, когда отправлял снимок.
 *
 * Пока сообщение шло, музыка у ведущего продолжала играть, поэтому к позиции
 * добавляется время в пути. Оно считается по часам ведущего, приведённым к
 * локальным: вычесть смещение — единственный способ не принять расхождение
 * часов за задержку сети.
 */
export function projectHostPosition(remote: RemoteSnapshot, nowMs: number, clockOffsetMs: number): number {
  const base = Number.isFinite(remote.currentTime) ? remote.currentTime : 0;
  if (!remote.isPlaying) return base; // на паузе позиция не едет
  const hostNowOnLocalClock = remote.hostTimestamp - clockOffsetMs;
  const elapsedSeconds = (nowMs - hostNowOnLocalClock) / 1000;
  const bounded = Math.min(Math.max(elapsedSeconds, 0), MAX_PROJECTION_SECONDS);
  return base + bounded;
}

// ---------------------------------------------------------------------------
// Решение слушателя
// ---------------------------------------------------------------------------

export type FollowerAction =
  /** Прислал не ведущий — командовать в комнате может только он. */
  | 'ignore-foreign'
  /** Снимок старее уже применённого: обычная перестановка в пути. */
  | 'ignore-stale'
  /** У ведущего другой трек. */
  | 'load'
  | 'play'
  | 'pause'
  /** Тот же трек и то же состояние, но позиция разъехалась. */
  | 'seek'
  /** Всё совпадает, трогать нечего. */
  | 'hold';

export interface LocalPlayback {
  trackId?: string;
  isPlaying: boolean;
  currentTime: number;
}

export interface FollowerInput {
  remote: RemoteSnapshot;
  local: LocalPlayback;
  /** Кого комната считает ведущим. `null` — ведущий ещё неизвестен. */
  hostId: string | null;
  /** Отметка последнего применённого снимка, по часам ведущего. */
  lastAppliedAt: number;
  clockOffsetMs: number;
  /** Локальные часы в момент получения. */
  nowMs: number;
  driftThreshold?: number;
}

export interface FollowerDecision {
  action: FollowerAction;
  /** Где слушателю следует находиться, с. */
  targetTime: number;
  /** Позиция слушателя минус позиция ведущего: «+» — убежал, «−» — отстал. */
  drift: number;
  /** Нужно ли вместе с действием ещё и подтянуть позицию. */
  seekNeeded: boolean;
  /** Применён ли снимок: по нему обновляется `lastAppliedAt`. */
  applied: boolean;
}

/**
 * Что слушателю сделать с пришедшим снимком.
 *
 * Порядок проверок и есть смысл этой функции. Чужой снимок отбрасывается до
 * всего остального — иначе два слушателя, у каждого свой плеер, начинают
 * переключать трек друг у друга по кругу. Затем отбрасывается опоздавший:
 * применить его — значит откатить комнату назад тем же движением, которым её
 * только что подтянули вперёд.
 */
export function decideFollowerAction(input: FollowerInput): FollowerDecision {
  const threshold = input.driftThreshold ?? DRIFT_THRESHOLD_SECONDS;
  const targetTime = projectHostPosition(input.remote, input.nowMs, input.clockOffsetMs);
  const localTime = Number.isFinite(input.local.currentTime) ? input.local.currentTime : 0;
  const drift = localTime - targetTime;
  const driftExceeded = Math.abs(drift) > threshold;

  const ignored = (action: FollowerAction): FollowerDecision => ({
    action,
    targetTime,
    drift,
    seekNeeded: false,
    applied: false
  });

  if (input.hostId && input.remote.senderId !== input.hostId) {
    return ignored('ignore-foreign');
  }

  const backwardsMs = input.lastAppliedAt - input.remote.hostTimestamp;
  if (backwardsMs > 0 && backwardsMs < CLOCK_REBASELINE_MS) {
    return ignored('ignore-stale');
  }

  if (input.remote.trackId && input.remote.trackId !== input.local.trackId) {
    // Позицию внутри нового трека доводим, только если это не самое начало:
    // перемотка на 0,2 с ничего не исправляет, а перезапуск слышен.
    return { action: 'load', targetTime, drift, seekNeeded: targetTime > 0.5, applied: true };
  }

  if (input.remote.isPlaying !== input.local.isPlaying) {
    return {
      action: input.remote.isPlaying ? 'play' : 'pause',
      targetTime,
      drift,
      seekNeeded: driftExceeded,
      applied: true
    };
  }

  if (driftExceeded) {
    return { action: 'seek', targetTime, drift, seekNeeded: true, applied: true };
  }

  return { action: 'hold', targetTime, drift, seekNeeded: false, applied: true };
}

// ---------------------------------------------------------------------------
// Когда ведущему открывать рот
// ---------------------------------------------------------------------------

export interface HostSnapshot {
  trackId?: string;
  isPlaying: boolean;
  currentTime: number;
  /** Отпечаток очереди: сравнивать списки треков целиком незачем. */
  queueSignature: string;
  /** Локальные часы в момент снимка. */
  at: number;
}

export type PublishReason = 'first' | 'track' | 'transport' | 'seek' | 'queue' | 'beacon';

export function queueSignature(trackIds: ReadonlyArray<string>): string {
  return `${trackIds.length}:${trackIds.join(',')}`;
}

/**
 * Надо ли ведущему отправить снимок — и почему.
 *
 * Плеер сообщает о позиции четыре раза в секунду; отправлять всё это на брокер
 * нельзя, а отправлять только по нажатиям — мало: слушатель, зашедший между
 * нажатиями, останется без позиции, а расхождение накопится без единого
 * события. Поэтому событие важнее, а маячок раз в несколько секунд — страховка.
 *
 * `null` означает «ничего не случилось, молчим».
 */
export function publishReason(
  prev: HostSnapshot | null,
  next: HostSnapshot,
  beaconIntervalMs: number = BEACON_INTERVAL_MS
): PublishReason | null {
  if (!prev) return 'first';
  if ((prev.trackId ?? null) !== (next.trackId ?? null)) return 'track';
  if (prev.isPlaying !== next.isPlaying) return 'transport';
  if (prev.queueSignature !== next.queueSignature) return 'queue';

  const elapsedSeconds = Math.max(0, next.at - prev.at) / 1000;
  const expected = prev.isPlaying ? prev.currentTime + elapsedSeconds : prev.currentTime;
  if (Math.abs(next.currentTime - expected) > SEEK_TOLERANCE_SECONDS) return 'seek';

  if (next.at - prev.at >= beaconIntervalMs) return 'beacon';
  return null;
}
