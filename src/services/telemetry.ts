/**
 * Статистика и ошибки — на наш сервер, чтобы видеть, у кого что не играет, не
 * дожидаясь, пока человек пришлёт файл диагностики.
 *
 * Что уходит: случайный идентификатор установки (придуман здесь, ни с чем не
 * связан), версия, платформа, имя и id Discord, если человек вошёл, и события
 * загрузки треков. У удачных — только источник и время; у неудачных ещё код,
 * текст и id трека. Ссылки и IP-адреса из текста вырезаются: в ссылке
 * googlevideo зашит адрес человека (`ip=…`). Сервер адресов не хранит.
 *
 * Выключается в настройках («Диагностика»).
 */

import { APP_VERSION } from '../utils/appInfo';
import { detectPlatform, resolveServerConfig, type ServerConfig } from './nativeBridge';

const INSTALL_KEY = 'wireon_install_id';
const OFF_KEY = 'wireon_telemetry_off';
const FLUSH_DELAY_MS = 30_000;
const HEARTBEAT_MS = 6 * 60 * 60 * 1000;
const MAX_QUEUE = 200;
const MAX_BATCH = 100;

export interface TelemetryEvent {
  at: number;
  kind: 'resolve' | 'playback';
  ok: boolean;
  source: string;
  ms: number;
  code?: string;
  detail?: string;
  videoId?: string;
}

let queue: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function isTelemetryEnabled(): boolean {
  return storage()?.getItem(OFF_KEY) !== '1';
}

export function setTelemetryEnabled(enabled: boolean): void {
  const store = storage();
  if (enabled) store?.removeItem(OFF_KEY);
  else {
    store?.setItem(OFF_KEY, '1');
    queue = [];
  }
}

function installId(): string {
  const store = storage();
  let id = store?.getItem(INSTALL_KEY);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    store?.setItem(INSTALL_KEY, id);
  }
  return id;
}

function platformName(): string {
  const kind = detectPlatform();
  if (kind === 'mobile') return 'android';
  if (kind === 'browser') return 'browser';
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS/i.test(ua)) return 'mac';
  return 'linux';
}

/** Текст ошибки без ссылок и адресов: в ссылке googlevideo зашит IP человека. */
export function scrubDetail(detail: string): string {
  return detail
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<ссылка>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<адрес>')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '<адрес>')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '<папка>')
    .slice(0, 300);
}

/** Код отказа из текста вида `YT_BOT_CHECK: …`. */
function codeOf(detail: string): string | undefined {
  return /^([A-Z][A-Z0-9_]{2,}):/.exec(detail.trim())?.[1];
}

export function trackResolve(event: {
  kind?: TelemetryEvent['kind'];
  ok: boolean;
  source: string;
  ms: number;
  detail?: string;
  videoId?: string;
}): void {
  if (!isTelemetryEnabled()) return;
  const detail = event.ok ? undefined : scrubDetail(String(event.detail || ''));
  queue.push({
    at: Date.now(),
    kind: event.kind || 'resolve',
    ok: event.ok,
    source: event.source,
    ms: Math.max(0, Math.round(event.ms)),
    code: detail ? codeOf(detail) : undefined,
    detail,
    videoId: event.ok ? undefined : event.videoId
  });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (!flushTimer) flushTimer = setTimeout(() => void flushTelemetry(), FLUSH_DELAY_MS);
}

async function discordUser(): Promise<{ id?: string; username?: string } | null> {
  try {
    const { useAuthStore } = await import('../store/useAuthStore');
    const user = useAuthStore.getState().user as { id?: string; username?: string } | null;
    return user && !user.id?.startsWith('guest') ? user : null;
  } catch {
    return null;
  }
}

/** Отправляет накопленное. Без адреса сервера или при выключенной статистике — ничего. */
export async function flushTelemetry(
  fetchImpl: typeof fetch = fetch,
  config: ServerConfig | null = resolveServerConfig()
): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!config || !isTelemetryEnabled()) return;

  const events = queue.splice(0, MAX_BATCH);
  const user = await discordUser();
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Wireon-Token': config.token },
      body: JSON.stringify({
        install: installId(),
        version: APP_VERSION,
        platform: platformName(),
        discordId: user?.id,
        discordName: user?.username,
        events
      })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    // Сервер недоступен — события вернутся в очередь и уйдут со следующей отправкой.
    queue = [...events, ...queue].slice(-MAX_QUEUE);
  }
  if (queue.length > 0 && !flushTimer) flushTimer = setTimeout(() => void flushTelemetry(), FLUSH_DELAY_MS);
}

/** Отметка «приложение живо» при запуске и раз в шесть часов. */
export function startTelemetry(): void {
  if (started) return;
  started = true;
  setTimeout(() => void flushTelemetry(), 10_000);
  setInterval(() => void flushTelemetry(), HEARTBEAT_MS);
}

export function resetTelemetryForTests(): void {
  queue = [];
  started = false;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

export function pendingTelemetryForTests(): ReadonlyArray<TelemetryEvent> {
  return queue;
}
