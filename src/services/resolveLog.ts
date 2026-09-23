/**
 * Журнал попыток открыть трек — на телефоне.
 *
 * На компьютере такой журнал ведёт главный процесс (`streams.log`, раздел
 * «Диагностика»). На телефоне его не было вовсе, и «треки с SoundCloud не
 * играют и грузятся очень долго» нельзя было разобрать ничем, кроме догадок:
 * какой источник отказал, с какой причиной, сколько секунд это заняло, сыграла
 * ли замена. Здесь последние попытки держатся в памяти и в `localStorage`,
 * а раздел «Диагностика» на телефоне показывает их с кнопкой «Скопировать».
 *
 * Ссылки на поток не записываются: в них подписи и адрес раздачи, человеку они
 * ничего не скажут, а в пересланном тексте лишние.
 */

export interface ResolveLogEntry {
  /** Когда закончилась попытка, мс эпохи. */
  at: number;
  source: string;
  title: string;
  /** Сколько заняла попытка. */
  ms: number;
  ok: boolean;
  /** Формат и замены при успехе, текст ошибки при отказе. */
  detail: string;
  /** Фоновая предзагрузка, а не нажатие. */
  prefetch?: boolean;
}

export const RESOLVE_LOG_KEY = 'wireon_resolve_log';
export const RESOLVE_LOG_LIMIT = 60;
/** Длинная ошибка yt-dlp или SoundCloud обрезается: суть всегда в начале. */
const DETAIL_LIMIT = 400;

type Listener = (entries: ReadonlyArray<ResolveLogEntry>) => void;

let entries: ResolveLogEntry[] | null = null;
const listeners = new Set<Listener>();

function load(): ResolveLogEntry[] {
  if (entries) return entries;
  entries = [];
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RESOLVE_LOG_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      entries = parsed
        .filter((item) => item && typeof item.at === 'number' && typeof item.title === 'string')
        .slice(-RESOLVE_LOG_LIMIT);
    }
  } catch {
    // Битая запись — начинаем журнал заново.
  }
  return entries;
}

function save(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(RESOLVE_LOG_KEY, JSON.stringify(entries ?? []));
  } catch {
    // Хранилище переполнено или закрыто — журнал останется в памяти.
  }
}

function notify(): void {
  const snapshot = [...load()];
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {
      // Сломанный подписчик не должен ронять запись.
    }
  });
}

export function recordResolve(entry: Omit<ResolveLogEntry, 'at'> & { at?: number }): void {
  const list = load();
  list.push({
    ...entry,
    at: entry.at ?? Date.now(),
    title: String(entry.title || '').slice(0, 120),
    detail: String(entry.detail || '').replace(/https?:\/\/\S+/g, '<ссылка>').slice(0, DETAIL_LIMIT)
  });
  if (list.length > RESOLVE_LOG_LIMIT) list.splice(0, list.length - RESOLVE_LOG_LIMIT);
  save();
  notify();
}

export function readResolveLog(): ReadonlyArray<ResolveLogEntry> {
  return [...load()];
}

export function clearResolveLog(): void {
  entries = [];
  save();
  notify();
}

export function onResolveLog(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Текст для пересылки: одна попытка — одна строка. */
export function formatResolveLog(list: ReadonlyArray<ResolveLogEntry>): string {
  return list
    .map((entry) => {
      const time = new Date(entry.at).toISOString().replace('T', ' ').slice(0, 19);
      const seconds = (entry.ms / 1000).toFixed(1);
      return `${time}  ${entry.ok ? 'OK  ' : 'FAIL'}  ${entry.source}${entry.prefetch ? ' (фон)' : ''}  ${seconds} с  «${entry.title}»  ${entry.detail}`;
    })
    .join('\n');
}

/** Для тестов. */
export function resetResolveLogForTests(): void {
  entries = null;
  listeners.clear();
}
