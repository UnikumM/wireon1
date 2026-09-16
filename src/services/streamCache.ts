/**
 * Кэш звука на телефоне: ссылка → файл рядом с приложением.
 *
 * Нужен обработке звука (`audioProcessing.ts`): через Web Audio можно пропустить
 * только «чистый» источник, а чистый на телефоне один — свой файл.
 *
 * Отличается от офлайна (`offlineFiles.ts`) намерением, а не техникой: офлайн —
 * это выбор человека «пусть лежит», а здесь временные копии последних треков,
 * которые система вправе вычистить сама. Поэтому каталог — `Cache`, а не
 * `Data`, и старые файлы вытесняются по числу.
 */

import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

const CACHE_DIR = 'stream-cache';
const CACHE_DIRECTORY = Directory.Cache;

/** Сколько файлов держим. Шесть — это текущий трек и ближайшая история. */
export const STREAM_CACHE_LIMIT = 6;

/** Расширение по типу содержимого: без него WebView отдаёт файл как поток байт. */
export function extensionFor(contentType: string | null | undefined): string {
  const type = (contentType || '').toLowerCase();
  if (type.includes('mpeg')) return 'mp3';
  if (type.includes('ogg') || type.includes('opus')) return 'ogg';
  if (type.includes('webm')) return 'webm';
  if (type.includes('wav')) return 'wav';
  return 'm4a';
}

/** Имя файла: только буквы, цифры и дефис — остальное в адресах не живёт. */
export function cacheFileName(trackId: string, extension: string): string {
  const safe = (trackId || 'track').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `${CACHE_DIR}/${safe}.${extension}`;
}

function available(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

async function toBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Кусками: `String.fromCharCode(...buffer)` на пятимегабайтном треке
  // переполняет стек аргументов.
  const CHUNK = 0x8000;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Оставляет в кэше только самые свежие файлы.
 *
 * Свежесть — по времени изменения, которое отдаёт сам `readdir`: своего
 * порядка у каталога нет, а сортировка по имени выбросила бы то, что играет.
 */
export async function pruneStreamCache(keep: number = STREAM_CACHE_LIMIT): Promise<void> {
  if (!available()) return;
  try {
    const { files } = await Filesystem.readdir({ path: CACHE_DIR, directory: CACHE_DIRECTORY });
    const ordered = [...files].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    for (const file of ordered.slice(keep)) {
      await Filesystem.deleteFile({
        path: `${CACHE_DIR}/${file.name}`,
        directory: CACHE_DIRECTORY
      }).catch(() => undefined);
    }
  } catch {
    // Каталога ещё нет — вычищать нечего.
  }
}

/**
 * Забирает поток в файл и отдаёт ссылку, которую можно дать проигрывателю.
 *
 * `null` — сюда попадать не надо: не телефон, нечего кэшировать или сеть
 * отказала. Вызывающий тогда играет прямую ссылку, как раньше.
 */
export async function cacheStreamToFile(
  trackId: string,
  url: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!available() || !url || !trackId) return null;

  try {
    /*
     * `Range: bytes=0-` — не осторожность. Замерено на живой ссылке
     * googlevideo: без него отдача идёт 30 КБ/с и рвётся, с ним — мегабайтами
     * в секунду. Тот же приём и по той же причине стоит в сохранении офлайн.
     */
    const response = await fetch(url, { headers: { Range: 'bytes=0-' }, signal });
    if (!response.ok) return null;

    const blob = await response.blob();
    if (!blob.size) return null;

    const path = cacheFileName(trackId, extensionFor(response.headers?.get?.('content-type') || blob.type));
    await Filesystem.mkdir({ path: CACHE_DIR, directory: CACHE_DIRECTORY, recursive: true }).catch(
      () => undefined
    );
    await Filesystem.writeFile({
      path,
      data: await toBase64(blob),
      directory: CACHE_DIRECTORY,
      recursive: true
    });

    const { uri } = await Filesystem.getUri({ path, directory: CACHE_DIRECTORY });
    void pruneStreamCache();
    return Capacitor.convertFileSrc(uri);
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      console.warn('[StreamCache] не удалось положить трек в кэш:', err);
    }
    return null;
  }
}

/** Убирает весь кэш — вызывается вместе с очисткой данных приложения. */
export async function clearStreamCache(): Promise<void> {
  if (!available()) return;
  await Filesystem.rmdir({ path: CACHE_DIR, directory: CACHE_DIRECTORY, recursive: true }).catch(
    () => undefined
  );
}
