/**
 * Ссылки на музыку, открытые в Wireon с телефона.
 *
 * Человек нажал ссылку YouTube, YouTube Music или SoundCloud в мессенджере и
 * выбрал Wireon в системном окне «чем открыть» (фильтры — в `AndroidManifest.xml`).
 * Capacitor отдаёт такой переход событием `appUrlOpen` — тем же, которым
 * возвращается согласие Discord. Разводятся они по схеме: свои `wireon://` и
 * `discord-…://` этот модуль не трогает, их ждёт `capacitorAuthBridge`.
 *
 * Ссылка кладётся в строку поиска, а не разбирается здесь: поиск уже умеет
 * открывать плейлисты по адресу (`parseCollectionLink`), и второй разбор рядом
 * означал бы два места, которые надо чинить, когда YouTube меняет адреса.
 *
 * Переход может прийти раньше, чем приложение готово его показать: при
 * холодном запуске по ссылке сессия ещё восстанавливается, и поменять экран в
 * эту секунду — значит, что `restoreSession` и приглашение войти перерисуют
 * всё обратно. Поэтому до готовности ссылки лежат в очереди и уезжают в поиск,
 * как только стор входа определится.
 */

import { useAuthStore } from '../store/useAuthStore';
import { useUIStore } from '../store/useUIStore';
import { detectPlatform } from './nativeBridge';

/** Хосты, которые объявлены в манифесте. Список тут и там обязан совпадать. */
export const INCOMING_LINK_HOSTS: readonly string[] = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'soundcloud.com',
  'm.soundcloud.com',
  'on.soundcloud.com'
];

/**
 * Одна и та же ссылка приходит дважды при холодном запуске: раз как адрес
 * запуска (`getLaunchUrl`), раз событием `appUrlOpen`. Повтор в это окно —
 * тот же переход, а не второе нажатие.
 */
const DUPLICATE_WINDOW_MS = 5000;

/**
 * Ссылка ли это на музыку, которую приложение берётся открыть.
 *
 * Только `http(s)` и только хосты из манифеста: всё остальное — либо чужая
 * схема (возврат из Discord), либо адрес, который система нам отдавать не
 * должна была вовсе.
 */
export function isIncomingMusicLink(url: string): boolean {
  const raw = (url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  // Хвостовая точка — законная форма того же имени, а регистр хоста ничего не значит.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return INCOMING_LINK_HOSTS.includes(host);
}

/**
 * Готово ли приложение показать ссылку.
 *
 * Признак — определившийся стор входа: `idle` значит, что загрузка ещё не
 * началась, `authenticating` — что сессия восстанавливается, и в обоих
 * случаях экран вот-вот перерисуется без нас.
 */
export function isAppReadyForLinks(): boolean {
  const status = useAuthStore.getState().authStatus;
  return status !== 'idle' && status !== 'authenticating';
}

const pending: string[] = [];
let unsubscribeReady: (() => void) | null = null;
let lastUrl: string | null = null;
let lastAt = 0;
let started: Promise<() => void> | null = null;

/** Ссылка уезжает в поиск; всё, что лежало поверх него, закрывается. */
function openInSearch(url: string): void {
  const ui = useUIStore.getState();
  // Запрос — первым: экран поиска при монтировании берёт черновик строки из
  // стора, и при обратном порядке он успел бы родиться с пустой строкой.
  ui.setSearchQuery(url);
  ui.setFullscreenPlayerOpen(false);
  ui.setQueueOpen(false);
  ui.setActiveView('search');
}

/** Отдаёт накопленные ссылки поиску. Открывается последняя: она и есть «та, что нажали». */
export function flushIncomingLinks(): void {
  if (unsubscribeReady) {
    unsubscribeReady();
    unsubscribeReady = null;
  }
  if (pending.length === 0) return;
  const last = pending[pending.length - 1];
  pending.length = 0;
  openInSearch(last);
}

/**
 * Принимает входящий адрес. `true` — ссылка наша и будет открыта (сразу или
 * когда приложение будет готово); `false` — не наша, пусть идёт своим путём.
 */
export function handleIncomingLink(url: string): boolean {
  if (!isIncomingMusicLink(url)) return false;
  const clean = url.trim();

  if (isAppReadyForLinks()) {
    openInSearch(clean);
    return true;
  }

  // Повтор того же адреса в очередь не кладётся: открывать его всё равно один раз.
  if (!pending.includes(clean)) pending.push(clean);
  if (!unsubscribeReady) {
    unsubscribeReady = useAuthStore.subscribe(() => {
      if (isAppReadyForLinks()) flushIncomingLinks();
    });
  }
  return true;
}

/** Сколько ссылок ждёт готовности. Нужно проверкам и ничему больше. */
export function pendingIncomingLinks(): number {
  return pending.length;
}

/** Забыть очередь и подписки — между проверками. */
export function resetIncomingLinks(): void {
  pending.length = 0;
  if (unsubscribeReady) {
    unsubscribeReady();
    unsubscribeReady = null;
  }
  lastUrl = null;
  lastAt = 0;
  started = null;
}

function isDuplicate(url: string, now: number): boolean {
  if (url === lastUrl && now - lastAt < DUPLICATE_WINDOW_MS) return true;
  lastUrl = url;
  lastAt = now;
  return false;
}

/**
 * Подписывается на переходы Capacitor. Вызывается один раз при запуске;
 * повторный вызов отдаёт ту же подписку. Вне телефона — пустышка: на ПК ссылки
 * сюда не приходят, а плагин вне нативной оболочки бросает исключение.
 *
 * Возвращает отписку, но жить подписка должна столько же, сколько приложение:
 * ссылку могут нажать в любую минуту.
 */
export function startIncomingLinks(): Promise<() => void> {
  if (started) return started;
  started = (async () => {
    if (detectPlatform() !== 'mobile') return () => {};

    let App: any;
    try {
      App = (await import('@capacitor/app')).App;
    } catch {
      return () => {};
    }
    if (!App?.addListener) return () => {};

    const receive = (url: unknown) => {
      if (typeof url !== 'string' || !url) return;
      if (isDuplicate(url, Date.now())) return;
      handleIncomingLink(url);
    };

    let cancelled = false;
    let handle: any = null;
    void App.addListener('appUrlOpen', (event: { url?: string }) => {
      if (!cancelled) receive(event?.url);
    }).then((registered: any) => {
      handle = registered;
      if (cancelled) void handle?.remove?.();
    });

    // Холодный запуск по ссылке: событие могло прозвучать до того, как страница
    // успела подписаться, поэтому адрес запуска спрашивается отдельно.
    try {
      const launch = await App.getLaunchUrl?.();
      if (!cancelled) receive(launch?.url);
    } catch {
      // Плагин без этого метода — просто нет адреса запуска.
    }

    return () => {
      cancelled = true;
      void handle?.remove?.();
    };
  })();
  return started;
}
