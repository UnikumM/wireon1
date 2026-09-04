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
export type BackgroundAudioCommand = 'play' | 'pause' | 'next' | 'prev';

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

/** Сброс отложенного выключения. Нужен тестам: таймер переживает тест. */
export function resetBackgroundAudio(): void {
  cancelPendingStop();
  lastSent = '';
}

/**
 * Подписка на кнопки уведомления и экрана блокировки.
 *
 * Возвращает функцию отписки — даже когда плагина нет, чтобы вызывающему не
 * приходилось об этом думать.
 */
export function onBackgroundAudioCommand(
  handler: (command: BackgroundAudioCommand) => void
): () => void {
  const native = plugin();
  if (!native || typeof native.addListener !== 'function') return () => {};

  let subscription: { remove: () => void } | null = null;
  let cancelled = false;

  const known: BackgroundAudioCommand[] = ['play', 'pause', 'next', 'prev'];
  const result = native.addListener('command', (payload) => {
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
