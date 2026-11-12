/**
 * Фоновое воспроизведение на Android.
 *
 * Что здесь происходит и чего не происходит. Звук играет обычный элемент
 * `<audio>` внутри WebView — как и на десктопе, и в браузере. Пока приложение
 * на экране, система его не трогает; стоит свернуть — и Android вправе усыпить
 * процесс, потому что для него это окно, а не плеер. Слышно это как обрыв трека
 * через минуту-другую после сворачивания.
 *
 * Служба переднего плана — единственный способ сказать системе «здесь идёт
 * воспроизведение». Она ничего не проигрывает: очередь, кроссфейд, эквалайзер и
 * «Моя волна» остаются там, где были. Второй плеер на нативной стороне пришлось
 * бы согласовывать с первым, и разошлись бы они в первый же день.
 *
 * Отказ службы остаётся отказом фонового режима, а не отказом музыки: все
 * вызовы молчаливые, и приложение продолжает работать как раньше.
 */

import { detectPlatform } from './nativeBridge';

/** Команды с кнопок уведомления и с экрана блокировки. */
export type BackgroundAudioCommand = 'play' | 'pause' | 'next' | 'prev' | 'seek';

/** Где сейчас трек — для полосы в уведомлении. Секунды. */
export interface BackgroundAudioPosition {
  /** Длительность; 0 или меньше — неизвестна, полоса тогда не показывается. */
  duration: number;
  position: number;
  /** Скорость воспроизведения; на паузе система сама останавливает отсчёт. */
  rate: number;
  playing: boolean;
}

export interface BackgroundAudioTrack {
  title: string;
  artist: string;
  playing: boolean;
  /** Адрес обложки. Без неё пульт в шторке выглядит пустым. */
  artwork?: string;
}

interface NativePlugin {
  start: (options: {
    title: string;
    artist: string;
    playing: boolean;
    artwork: string;
  }) => Promise<unknown>;
  stop: () => Promise<unknown>;
  /** Появился в 4.0.2; в старых APK его нет — тогда полоса просто не обновляется. */
  setPosition?: (options: { duration: number; position: number; rate: number; playing: boolean }) => Promise<unknown>;
  addListener: (
    event: 'command',
    handler: (payload: { command?: string }) => void
  ) => Promise<{ remove: () => void }> | { remove: () => void };
}

function plugin(): NativePlugin | null {
  if (detectPlatform() !== 'mobile') return null;
  const registry = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  const found = registry?.Plugins?.BackgroundAudio as NativePlugin | undefined;
  return found && typeof found.start === 'function' ? found : null;
}

/**
 * Последнее отправленное состояние.
 *
 * Плеер зовёт это на каждое изменение, а уведомление перерисовывать на каждый
 * тик незачем: мигающее уведомление раздражает сильнее, чем его отсутствие.
 */
let lastSent = '';

/**
 * Отсрочка выключения.
 *
 * Замерено на эмуляторе 2026-08-28: за одну смену трека движок проходит через
 * `idle`, `loading` и `buffering`, и `idle` доходил сюда как «играть больше
 * нечего». В logcat это видно как чередование `addSession` / `removeSession`
 * по нескольку раз в секунду: служба переднего плана успевала подняться и
 * умереть на каждом переключении, а после последнего `idle` так и оставалась
 * мёртвой — то есть фонового режима не было вовсе, хотя музыка играла.
 *
 * Полторы секунды — заведомо больше промежутка между «трек кончился» и
 * «следующий пошёл» и заведомо меньше, чем человек заметит на настоящей
 * остановке.
 */
const STOP_GRACE_MS = 1500;

let stopTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingStop(): void {
  if (stopTimer !== null) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
}

async function stopNow(): Promise<void> {
  const native = plugin();
  lastSent = '';
  lastPosition = null;
  if (!native) return;
  try {
    await native.stop();
  } catch (err) {
    console.warn('[backgroundAudio] фоновый режим не выключился:', err);
  }
}

/** Включает фоновый режим и обновляет уведомление. Молча ничего не делает в вебе. */
export async function startBackgroundAudio(track: BackgroundAudioTrack): Promise<void> {
  // Отсрочку снимаем раньше всех проверок: даже когда состояние не изменилось
  // и отправлять нечего, сам факт «мы играем» отменяет остановку.
  cancelPendingStop();

  const native = plugin();
  if (!native) return;

  const signature = `${track.title} ${track.artist} ${track.playing} ${track.artwork || ''}`;
  if (signature === lastSent) return;
  lastSent = signature;

  try {
    await native.start({
      title: track.title,
      artist: track.artist,
      playing: track.playing,
      artwork: track.artwork || ''
    });
  } catch (err) {
    console.warn('[backgroundAudio] фоновый режим не включился:', err);
  }
}

/**
 * Выключает фоновый режим: играть больше нечего.
 *
 * По умолчанию с отсрочкой — см. {@link STOP_GRACE_MS}. `immediate` нужен
 * закрытию приложения: там ждать уже некому и незачем.
 */
export async function stopBackgroundAudio(options?: { immediate?: boolean }): Promise<void> {
  cancelPendingStop();

  if (options?.immediate) {
    await stopNow();
    return;
  }

  stopTimer = setTimeout(() => {
    stopTimer = null;
    void stopNow();
  }, STOP_GRACE_MS);
}

/**
 * Что система уже знает о позиции: по этому она сама двигает полосу, считая от
 * `position` со скоростью `rate` с момента `at`.
 */
let lastPosition: (BackgroundAudioPosition & { at: number }) | null = null;

/** На сколько секунд полоса может разойтись с плеером, прежде чем её поправят. */
const POSITION_DRIFT_SECONDS = 1.5;

/**
 * Длительность и позиция — в системное уведомление.
 *
 * До 4.0.2 туда не уходило ничего: служба сообщала «позиция неизвестна», а
 * длительности не называла вовсе, и полоса в шторке стояла на «00:00 / 00:00».
 *
 * Плеер зовёт это на каждый тик, а в систему уходит только существенное: новая
 * длительность, пуск или пауза, смена скорости, перемотка (позиция разошлась
 * с тем, что система насчитала сама). Обычное течение времени она считает без
 * нас — будить нативную сторону четыре раза в секунду незачем.
 */
export function updateBackgroundAudioPosition(next: BackgroundAudioPosition, now: number = Date.now()): void {
  const native = plugin();
  if (!native || typeof native.setPosition !== 'function') return;

  const duration = Number.isFinite(next.duration) && next.duration > 0 ? next.duration : 0;
  const rate = Number.isFinite(next.rate) && next.rate > 0 ? next.rate : 1;
  let position = Number.isFinite(next.position) && next.position > 0 ? next.position : 0;
  if (duration > 0) position = Math.min(position, duration);

  const last = lastPosition;
  if (last) {
    const expected = last.playing ? last.position + ((now - last.at) / 1000) * last.rate : last.position;
    const same =
      Math.abs(last.duration - duration) < 0.5 &&
      last.playing === next.playing &&
      last.rate === rate &&
      Math.abs(expected - position) < POSITION_DRIFT_SECONDS;
    if (same) return;
  }

  lastPosition = { duration, position, rate, playing: next.playing, at: now };
  void native.setPosition({ duration, position, rate, playing: next.playing }).catch((err: unknown) => {
    console.warn('[backgroundAudio] позиция не дошла до уведомления:', err);
  });
}

/** Сброс отложенного выключения. Нужен тестам: таймер переживает тест. */
export function resetBackgroundAudio(): void {
  cancelPendingStop();
  lastSent = '';
  lastPosition = null;
}

/**
 * Подписка на кнопки уведомления и экрана блокировки.
 *
 * Возвращает функцию отписки — даже когда плагина нет, чтобы вызывающему не
 * приходилось об этом думать.
 */
export function onBackgroundAudioCommand(
  handler: (command: BackgroundAudioCommand, seconds?: number) => void
): () => void {
  const native = plugin();
  if (!native || typeof native.addListener !== 'function') return () => {};

  let subscription: { remove: () => void } | null = null;
  let cancelled = false;

  const known: BackgroundAudioCommand[] = ['play', 'pause', 'next', 'prev'];
  const result = native.addListener('command', (payload) => {
    // Перемотка из шторки приходит как `seek:<миллисекунды>`.
    const seek = /^seek:(\d+)$/.exec(String(payload?.command ?? ''));
    if (seek) {
      handler('seek', Number(seek[1]) / 1000);
      return;
    }
    const command = payload?.command as BackgroundAudioCommand | undefined;
    // Незнакомую команду глотаем: пусть нативная сторона добавляет свои
    // кнопки, не ломая старую сборку приложения.
    if (command && known.includes(command)) handler(command);
  });

  if (result && typeof (result as Promise<unknown>).then === 'function') {
    void (result as Promise<{ remove: () => void }>).then((handle) => {
      subscription = handle;
      if (cancelled) handle.remove();
    });
  } else {
    subscription = result as { remove: () => void };
  }

  return () => {
    cancelled = true;
    try {
      subscription?.remove();
    } catch {
      // Отписка от уже снятого слушателя — не повод падать.
    }
  };
}
