/**
 * Что известно о качестве записи у источника — до того, как её включили.
 *
 * SoundCloud для части загрузок отдаёт только 30-секундный отрывок, а
 * некоторые потоки идут ниже 96 кбит/с. Плеер узнаёт это в момент разбора
 * ссылки и показывает бейдж в полосе, но человек, листающий список, видит
 * обычную строку и удивляется, когда песня обрывается на куплете. Здесь эти
 * сведения запоминаются по id трека и переживают перезапуск, чтобы строка
 * списка предупреждала заранее.
 *
 * Хранилище маленькое и честное: пометка ставится по факту разобранного
 * потока и снимается, когда тот же трек однажды сыграл целиком и в нормальном
 * битрейте (например, с запасного источника).
 */

export type TrackQuality = 'preview' | 'low';

const STORAGE_KEY = 'wireon_track_quality';
/** Ниже этого битрейта поток считается низким качеством. */
export const LOW_BITRATE_KBPS = 96;
/** Больше записей не держим: список нужен для подсказок, а не как архив. */
const MAX_ENTRIES = 400;

let entries: Map<string, TrackQuality> | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function load(): Map<string, TrackQuality> {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (parsed && typeof parsed === 'object') {
      for (const [id, quality] of Object.entries(parsed)) {
        if (quality === 'preview' || quality === 'low') entries.set(id, quality);
      }
    }
  } catch {
    // Повреждённая запись — не повод падать: карта просто начнётся заново.
  }
  return entries;
}

function persist(map: Map<string, TrackQuality>): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Нет места или приватный режим — работаем из памяти.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function write(trackId: string, quality: TrackQuality | null): void {
  if (!trackId) return;
  const map = load();
  const previous = map.get(trackId) ?? null;
  if (previous === quality) return;
  if (quality === null) {
    map.delete(trackId);
  } else {
    // Удаляем и ставим заново, чтобы запись стала самой свежей в порядке Map.
    map.delete(trackId);
    map.set(trackId, quality);
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  persist(map);
  notify();
}

/** Источник отдаёт только отрывок этой записи. */
export function markPreview(trackId: string): void {
  write(trackId, 'preview');
}

/** Поток идёт в низком битрейте. Отрывок важнее — его пометку не перекрываем. */
export function markLowBitrate(trackId: string): void {
  if (load().get(trackId) === 'preview') return;
  write(trackId, 'low');
}

/** Запись сыграла целиком и в нормальном качестве — предупреждать больше не о чем. */
export function clearQuality(trackId: string): void {
  write(trackId, null);
}

export function getQuality(trackId: string): TrackQuality | null {
  return load().get(trackId) ?? null;
}

/**
 * Одна точка для стора: ему известен разобранный поток, и он не должен сам
 * решать, что из этого считать предупреждением.
 */
export function noteStreamQuality(
  trackId: string,
  stream: { isPreview?: boolean; bitrate?: number } | null | undefined
): void {
  if (!stream) return;
  if (stream.isPreview) {
    markPreview(trackId);
    return;
  }
  const bitrate = stream.bitrate ?? 0;
  if (bitrate > 0 && bitrate < LOW_BITRATE_KBPS) {
    markLowBitrate(trackId);
    return;
  }
  clearQuality(trackId);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Подпись и объяснение для бейджа в списке. */
export function describeQuality(quality: TrackQuality): { label: string; title: string } {
  return quality === 'preview'
    ? { label: 'отрывок', title: 'Источник отдаёт только 30-секундный отрывок этой записи' }
    : { label: 'низкое качество', title: `Источник отдаёт поток ниже ${LOW_BITRATE_KBPS} кбит/с` };
}

export function resetTrackQualityForTests(): void {
  entries = null;
  listeners.clear();
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
