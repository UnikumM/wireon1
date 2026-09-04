/**
 * Ссылка на аудио от yt-dlp, работающего **внутри приложения** на телефоне.
 *
 * Почему это появилось. Разбор силами `youtubei.js` (`youtubeOnDevice.ts`)
 * упирается в SABR: замерено 2026-08-28 — ни один клиент не отдаёт ни прямой
 * ссылки, ни манифеста, только `server_abr_streaming_url`, а `<audio src>`
 * такое не играет. Разбор силами сервера упирается в другое: у него адрес
 * дата-центра, и YouTube требует у него доказать, что он не робот, на каждый
 * трек. Обходится это чужими cookies, которые протухают за недели — и уже
 * протухли.
 *
 * yt-dlp не упирается ни в то, ни в другое: прямую ссылку он получать умеет, а
 * адрес у телефона домашний. Ровно поэтому настольная сборка работает без
 * единой cookie с самого начала — здесь тот же механизм, просто перенесённый
 * туда, где он нужнее.
 *
 * Цена честная: разбор идёт секунды, а не мгновенно, потому что поднимается
 * настоящий Python. Поэтому ступень стоит первой только там, где вторая заведомо
 * не работает, — см. лестницу в `nativeBridge.ts`.
 */

import { detectPlatform } from './nativeBridge';

/** Ответ в той же форме, что отдаёт главный процесс на десктопе. */
export interface YtDlpStream {
  streamUrl: string;
  format: string;
  bitrate: number;
  expiresAt: number;
}

interface NativePlugin {
  available: () => Promise<{ available?: boolean }>;
  resolve: (options: {
    videoId: string;
    priority?: ResolvePriority;
    rejectUrl?: string;
  }) => Promise<Record<string, unknown>>;
  /** Появился вместе с двумя полосами разбора; в старых APK его нет. */
  raisePriority?: (options: { videoId: string }) => Promise<{ moved?: boolean }>;
  update: () => Promise<{ version?: string }>;
}

/**
 * Кто ждёт ссылку. У нативной стороны под это две полосы: заявка человека не
 * стоит за прогревом следующих треков очереди — на эмуляторе такое ожидание
 * замерено в 25,5 секунды при шести секундах самого разбора.
 */
export type ResolvePriority = 'user' | 'prefetch';

/** Что ещё известно о заявке, кроме самого видео. */
export interface ResolveOnDeviceOptions {
  priority?: ResolvePriority;
  /**
   * Ссылка, которую плеер уже получил и играть не смог. Нативная сторона
   * пропустит ступень, выдавшую ровно её, и пойдёт к следующему клиенту.
   */
  rejectUrl?: string;
}

/** Ошибка в форме `КОД: подробности` — её ждёт `describePlaybackError`. */
export class YtDlpError extends Error {
  public readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = 'YtDlpError';
    this.code = message.split(':', 1)[0].trim();
  }
}

function plugin(): NativePlugin | null {
  if (typeof window === 'undefined') return null;
  if (detectPlatform() !== 'mobile') return null;
  const registry = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  const found = registry?.Plugins?.YtDlp as NativePlugin | undefined;
  return found && typeof found.resolve === 'function' ? found : null;
}

/**
 * Итог первой проверки. Спрашивать нативную сторону на каждый трек незачем:
 * распаковка Python либо прошла при первом запросе, либо не пройдёт вовсе.
 */
let readiness: Promise<boolean> | null = null;

/**
 * Есть ли на этом устройстве работающий yt-dlp.
 *
 * Нужно **до** первого трека: в сборке для браузера и в APK, выпущенных до
 * этой работы, плагина нет вовсе, и лестница обязана это знать заранее, а не
 * узнавать по отказу первого нажатия.
 */
export function isYtDlpAvailable(): Promise<boolean> {
  if (readiness) return readiness;
  const native = plugin();
  if (!native) {
    readiness = Promise.resolve(false);
    return readiness;
  }
  readiness = native
    .available()
    .then((result) => result?.available === true)
    .catch(() => false);
  return readiness;
}

/** Сброс запомненного ответа. Нужен тестам: проверка идёт один раз за запуск. */
export function resetYtDlpAvailability(): void {
  readiness = null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Прямая ссылка на аудиодорожку трека.
 *
 * Бросает `YtDlpError` с кодом `YT_*` — тем же, что и обе другие ступени,
 * потому что человеку показывается совет, а не название неудачи.
 */
export async function resolveWithYtDlp(
  videoId: string,
  options: ResolveOnDeviceOptions = {}
): Promise<YtDlpStream> {
  const native = plugin();
  if (!native) throw new YtDlpError('YT_BINARY_MISSING: yt-dlp на этом устройстве недоступен');

  let payload: Record<string, unknown>;
  try {
    payload = await native.resolve({
      videoId,
      priority: options.priority ?? 'user',
      ...(options.rejectUrl ? { rejectUrl: options.rejectUrl } : {})
    });
  } catch (error) {
    // Capacitor отдаёт сообщение отказа как есть — а нативная сторона пишет
    // его в форме `КОД: подробности` именно для этого.
    throw new YtDlpError(error instanceof Error ? error.message : String(error));
  }

  const streamUrl = typeof payload?.streamUrl === 'string' ? payload.streamUrl : '';
  if (!streamUrl) throw new YtDlpError('YT_NO_AUDIO: yt-dlp не вернул ссылку');

  return {
    streamUrl,
    format: typeof payload.format === 'string' && payload.format ? payload.format : 'm4a',
    bitrate: asNumber(payload.bitrate),
    expiresAt: asNumber(payload.expiresAt)
  };
}

/**
 * Переносит уже поставленную заявку в полосу человека.
 *
 * Нужно из-за склейки одинаковых запросов в `StreamResolver`: если ссылку уже
 * греет фон, второй вызов до нативной стороны не доходит вовсе — и заявка так
 * и осталась бы фоновой, за спиной у остальных прогревов. Молчаливая: это
 * подсказка очереди, а не само получение ссылки, и в APK, собранных до двух
 * полос, метода просто нет.
 */
export function raiseYtDlpPriority(videoId: string): void {
  const native = plugin();
  if (!native || typeof native.raisePriority !== 'function') return;
  void native.raisePriority({ videoId }).catch(() => {});
}

/** Когда yt-dlp обновлялся в последний раз. Ключ живёт в той же базе настроек. */
export const YTDLP_UPDATED_SETTING = 'ytdlp.lastUpdateAt';

/** Раз в сутки. Чаще — трата трафика, реже — лишние дни без музыки. */
export const YTDLP_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Обновляет yt-dlp, если давно не обновлялся.
 *
 * Зачем это вообще нужно: в библиотеке лежит yt-dlp той версии, что была на
 * момент её выпуска, — при первой проверке на устройстве это оказался
 * **2025.11.12**, то есть девятимесячной давности, и он сам об этом
 * предупреждает. YouTube ломает разбор раз в несколько месяцев; ждать от
 * человека установки новой сборки ради чужой починки — значит держать его без
 * музыки всё это время. Обновление заняло шесть секунд и подняло версию до
 * `2026.08.19`.
 *
 * Молчаливое и не блокирующее: это фон, а не шаг запуска. Отказ означает
 * «осталась прежняя версия», и она, скорее всего, ещё работает.
 */
export async function maybeUpdateYtDlp(): Promise<void> {
  if (!(await isYtDlpAvailable())) return;
  try {
    const { getSetting, setSetting } = await import('./db');
    const last = await getSetting<number>(YTDLP_UPDATED_SETTING, 0);
    if (typeof last === 'number' && Date.now() - last < YTDLP_UPDATE_INTERVAL_MS) return;

    const version = await updateYtDlp();
    // Отметка ставится и после неудачи: иначе телефон без сети пытался бы
    // обновиться на каждом запуске.
    await setSetting(YTDLP_UPDATED_SETTING, Date.now());
    if (version) console.info(`[ytDlpOnDevice] yt-dlp обновлён: ${version}`);
  } catch (error) {
    console.warn('[ytDlpOnDevice] проверка обновления не удалась:', error);
  }
}

/**
 * Обновление самого yt-dlp.
 *
 * Единственная часть приложения, которая чинится без выпуска новой версии:
 * YouTube ломает разбор раз в несколько месяцев, а yt-dlp чинит это за дни.
 * Молчаливое: отказ обновления — это «осталась прежняя версия», а не беда,
 * о которой надо сообщать посреди прослушивания.
 */
export async function updateYtDlp(): Promise<string | null> {
  const native = plugin();
  if (!native || typeof native.update !== 'function') return null;
  try {
    const result = await native.update();
    return typeof result?.version === 'string' ? result.version : null;
  } catch (error) {
    console.warn('[ytDlpOnDevice] обновить yt-dlp не удалось:', error);
    return null;
  }
}
