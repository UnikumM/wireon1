/**
 * Окно входа Discord внутри приложения — запасной путь к согласию.
 *
 * Основной идёт через системный браузер: там человек уже вошёл в Discord, и
 * пароль заново вводить не приходится. Это окно нужно, когда ответ оттуда
 * вернуться не может — схему обслуживает реестр Windows, и запись может быть не
 * нашей. Здесь же зависимостей нет никаких: окно принадлежит приложению, и
 * адрес возврата читается прямо из перехода, отменяя его.
 *
 * Ответ приходит кодом, а не токеном: собственная схема требует PKCE, а он с
 * неявным потоком не сочетается. Обмен кода на токен делает renderer.
 */

import type { BrowserWindow as BrowserWindowType } from 'electron';

/**
 * Идентификатор нашей заявки в Discord. Дублирует `DEFAULT_DISCORD_CLIENT_ID`
 * из `src/services/discordAuth.ts` — главный процесс до модулей renderer не
 * дотягивается. Совпадение сторожит тест.
 */
export const DISCORD_CLIENT_ID = '1539037027633332234';

/**
 * Схема, по которой Discord возвращает ответ в приложение.
 *
 * Произвольную схему он не принимает. `wireon://auth/callback` был прописан в
 * панели разработчика — и всё равно отвергался с «Redirect URI … is not
 * supported by client», хоть с выключенным переключателем «общедоступный
 * клиент», хоть с включённым. Discord разрешает ровно одну собственную схему —
 * `discord-{идентификатор заявки}`, и никакую другую.
 */
export const DISCORD_AUTH_SCHEME = `discord-${DISCORD_CLIENT_ID}`;
export const DISCORD_AUTH_REDIRECT = `${DISCORD_AUTH_SCHEME}:/authorize/callback`;

/**
 * Адреса возврата, зарегистрированные для Wireon в панели Discord.
 *
 * `wireon://` здесь остаётся не для входа, а для распознавания: сборки до 1.0.12
 * просили именно его, и их ответ надо уметь принять, если он вдруг придёт.
 */
export const AUTH_REDIRECT_PREFIXES = [
  DISCORD_AUTH_REDIRECT,
  'wireon://auth/callback',
  'http://localhost:3000/auth/callback',
  'http://127.0.0.1:3000/auth/callback',
] as const;

/** Only Discord may be reached from inside the auth window. */
const ALLOWED_NAVIGATION_HOSTS = ['discord.com', 'discordapp.com', 'discord.gg'];

/** Discord's consent screen can sit unanswered for a while; five minutes is plenty. */
export const AUTH_WINDOW_TIMEOUT_MS = 5 * 60 * 1000;

export type AuthWindowFailureCode =
  | 'WINDOW_CLOSED'
  | 'TIMEOUT'
  | 'NAVIGATION_BLOCKED'
  | 'LOAD_FAILED'
  | 'UNSUPPORTED';

export interface AuthWindowResult {
  ok: boolean;
  /** The full redirect URL, fragment included, when `ok`. */
  url?: string;
  error?: string;
  code?: AuthWindowFailureCode;
}

/** True when `url` is the OAuth redirect coming back to us. */
export function isAuthRedirectUrl(
  url: string,
  prefixes: ReadonlyArray<string> = AUTH_REDIRECT_PREFIXES
): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  return prefixes.some((prefix) => url.startsWith(prefix));
}

/**
 * True when the auth window may navigate to `url`.
 *
 * A compromised or phished consent page must not be able to steer this window
 * anywhere else, so the allow-list is checked by hostname suffix rather than by
 * substring — `discord.com.evil.tld` fails.
 */
export function isAllowedAuthNavigation(url: string): boolean {
  if (isAuthRedirectUrl(url)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_NAVIGATION_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

/** Strips the fragment so a URL can be logged without leaking the token. */
export function redactAuthUrl(url: string): string {
  const hashIndex = url.indexOf('#');
  return hashIndex === -1 ? url : `${url.slice(0, hashIndex)}#<redacted>`;
}

export interface RunDiscordLoginDeps {
  /** Injected so the flow is testable without Electron. */
  createWindow: () => BrowserWindowType;
  timeoutMs?: number;
  redirectPrefixes?: ReadonlyArray<string>;
}

/**
 * Opens `authUrl`, waits for the redirect back and resolves with it.
 *
 * Always resolves — a closed window, a timeout and a blocked navigation are
 * ordinary outcomes of a login attempt, not exceptions.
 */
export function runDiscordLogin(authUrl: string, deps: RunDiscordLoginDeps): Promise<AuthWindowResult> {
  const { createWindow, timeoutMs = AUTH_WINDOW_TIMEOUT_MS, redirectPrefixes = AUTH_REDIRECT_PREFIXES } = deps;

  return new Promise<AuthWindowResult>((resolve) => {
    let settled = false;
    let win: BrowserWindowType | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: AuthWindowResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const target = win;
      win = null;
      if (target && !target.isDestroyed()) {
        // Destroy rather than close: `closed` must not report a cancellation
        // after the token has already been captured.
        target.destroy();
      }
      resolve(result);
    };

    try {
      win = createWindow();
    } catch (err) {
      finish({
        ok: false,
        code: 'UNSUPPORTED',
        error: `Не удалось открыть окно входа: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const contents = win.webContents;

    const handleNavigation = (event: { preventDefault: () => void } | null, url: string): void => {
      if (isAuthRedirectUrl(url, redirectPrefixes)) {
        // The redirect target is not a real page — cancel it and take the URL.
        event?.preventDefault();
        finish({ ok: true, url });
        return;
      }
      if (!isAllowedAuthNavigation(url)) {
        event?.preventDefault();
        console.warn('[Auth] Blocked navigation to', redactAuthUrl(url));
        finish({
          ok: false,
          code: 'NAVIGATION_BLOCKED',
          error: 'Окно входа попыталось уйти на посторонний сайт. Вход отменён.',
        });
      }
    };

    contents.on('will-redirect', (event, url) => handleNavigation(event, url));
    contents.on('will-navigate', (event, url) => handleNavigation(event, url));

    // A custom scheme cannot actually load, so the interesting URL often arrives
    // here instead of on `will-redirect`.
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (isAuthRedirectUrl(validatedURL, redirectPrefixes)) {
        finish({ ok: true, url: validatedURL });
        return;
      }
      // -3 is ERR_ABORTED, which every cancelled navigation reports.
      if (errorCode === -3) return;
      finish({
        ok: false,
        code: 'LOAD_FAILED',
        error: `Не удалось загрузить страницу входа Discord (${errorCode} ${errorDescription}).`,
      });
    });

    // Discord opens its own popups (e.g. QR-code login help); keep them inside.
    contents.setWindowOpenHandler(({ url }) => {
      if (isAuthRedirectUrl(url, redirectPrefixes)) {
        finish({ ok: true, url });
        return { action: 'deny' };
      }
      return { action: 'deny' };
    });

    win.on('closed', () => {
      finish({
        ok: false,
        code: 'WINDOW_CLOSED',
        error: 'Окно входа закрыто до завершения авторизации.',
      });
    });

    timer = setTimeout(() => {
      finish({
        ok: false,
        code: 'TIMEOUT',
        error: `Вход не завершён за ${Math.round(timeoutMs / 60000)} мин.`,
      });
    }, timeoutMs);

    void contents.loadURL(authUrl).catch((err: unknown) => {
      // A cancelled load is how a successful redirect interception looks.
      if (settled) return;
      finish({
        ok: false,
        code: 'LOAD_FAILED',
        error: `Не удалось открыть страницу входа Discord: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  });
}
