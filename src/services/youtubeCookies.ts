/**
 * Источник cookies для YouTube.
 *
 * YouTube время от времени отвечает «Sign in to confirm you're not a bot» —
 * причём не на конкретное видео, а на адрес целиком. Ни один анонимный клиент
 * извлекателя это не обходит: единственное лечение, которое рекомендует сам
 * yt-dlp, — отдать ему cookies браузера, в котором человек уже вошёл в YouTube.
 *
 * Поэтому настройка выключена по умолчанию и включается руками: приложение
 * начинает пользоваться аккаунтом человека, и он должен об этом знать. Пока
 * YouTube отдаёт аудио анонимно, сессия не используется даже при включённой
 * настройке — попытки с cookies стоят в конце лестницы, см. `buildAttempts`
 * в electron/streamResolver.ts.
 *
 * Хранится здесь, а не в player-store: к воспроизведению это не относится,
 * значение нужно только main-процессу.
 */

import * as dbService from './db';

export const YOUTUBE_COOKIES_SETTING_KEY = 'youtubeCookiesBrowser';

/**
 * Что показывать в выпадающем списке.
 *
 * Значения должны совпадать с `COOKIE_BROWSERS` в electron/streamResolver.ts —
 * там они проверяются заново, потому что уезжают в аргументы процесса.
 */
export const COOKIE_BROWSER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'firefox', label: 'Firefox' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'edge', label: 'Edge' },
  { value: 'brave', label: 'Brave' },
  { value: 'opera', label: 'Opera' },
  { value: 'vivaldi', label: 'Vivaldi' },
  { value: 'chromium', label: 'Chromium' },
  { value: 'whale', label: 'Whale' },
  { value: 'safari', label: 'Safari' }
];

/** Отсеивает мусор и незнакомые браузеры, чтобы в main не уехало лишнее. */
export function normalizeCookieBrowserChoice(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  return COOKIE_BROWSER_OPTIONS.some((option) => option.value === name) ? name : null;
}

function getBridge(): ((browser: string | null) => Promise<string | null>) | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.electronAPI?.setYouTubeCookiesBrowser;
  return typeof bridge === 'function' ? bridge : null;
}

export class YouTubeCookiesService {
  private browser: string | null = null;
  private hydrated = false;

  /** Поднимает сохранённый выбор и повторяет его main-процессу. */
  public async init(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;

    try {
      const persisted = await dbService.getSetting<string | null>(YOUTUBE_COOKIES_SETTING_KEY, null);
      this.browser = normalizeCookieBrowserChoice(persisted);
    } catch {
      this.browser = null;
    }

    // Main-процесс каждый запуск начинает без cookies, поэтому сообщать надо
    // даже про `null` — иначе после выключения настройки прежнее значение
    // осталось бы жить до перезапуска.
    await this.push();
  }

  public get(): string | null {
    return this.browser;
  }

  public isSupported(): boolean {
    return getBridge() !== null;
  }

  /** Меняет источник: сохраняет и сразу применяет, перезапуск не нужен. */
  public async set(browser: string | null): Promise<string | null> {
    this.browser = normalizeCookieBrowserChoice(browser);
    this.hydrated = true;

    try {
      await dbService.setSetting(YOUTUBE_COOKIES_SETTING_KEY, this.browser);
    } catch (err) {
      console.warn('[YouTubeCookies] Не удалось сохранить выбор браузера:', err);
    }

    return this.push();
  }

  private async push(): Promise<string | null> {
    const bridge = getBridge();
    if (!bridge) return this.browser;
    try {
      return await bridge(this.browser);
    } catch (err) {
      console.warn('[YouTubeCookies] Не удалось передать выбор в main-процесс:', err);
      return this.browser;
    }
  }
}

export const youtubeCookiesService = new YouTubeCookiesService();

export default youtubeCookiesService;
