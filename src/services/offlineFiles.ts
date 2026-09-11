/**
 * Сохранённые треки — файлами, а не внутри базы.
 *
 * На телефоне офлайн лежал целыми `Blob` внутри записей IndexedDB, и это давало
 * три беды сразу. Во-первых, квота: WebView отводит базе долю свободного места,
 * и десяток альбомов в неё просто не помещается. Во-вторых, Android вправе
 * вычистить базу при нехватке места — сохранённое исчезало без единого слова.
 * В-третьих, каждое включение создавало object URL и ни один не освобождался.
 *
 * Файл ничего из этого не имеет: он лежит в личной папке приложения, считается
 * обычными данными приложения и отдаётся проигрывателю ссылкой, которую не надо
 * освобождать.
 *
 * Модуль нарочно молчалив: на десктопе и в браузере нет ни Capacitor, ни
 * файловой системы, поэтому каждая функция честно отвечает «не здесь», а
 * вызывающий откатывается на прежнее хранение в базе.
 */

import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

/** Папка внутри личных данных приложения. */
const OFFLINE_DIR = 'offline';

/** Где лежат файлы. `Data` — личная папка приложения: не требует разрешений. */
const OFFLINE_DIRECTORY = Directory.Data;

/** Есть ли вообще файловая система. На десктопе и в вебе — нет. */
export function isFileStorageAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Имя файла для трека.
 *
 * Идентификатор трека — это `yt_dQw4w9WgXcQ` и подобное, но у SoundCloud и у
 * ссылок туда попадают символы, которые файловая система не примет. Заменяем
 * всё сомнительное, а расширение берём от формата: по нему Android выбирает
 * декодер, когда MIME не пришёл.
 */
export function offlineFileName(trackId: string, format?: string): string {
  const safe = (trackId || 'track').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ext = format === 'opus' ? 'opus' : format === 'm4a' ? 'm4a' : 'mp3';
  return `${OFFLINE_DIR}/${safe}.${ext}`;
}

/** Двоичные данные в base64: плагин принимает только строку. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать сохранённый трек'));
    reader.onload = () => {
      const result = String(reader.result || '');
      // `data:...;base64,XXXX` — нужна только часть после запятой.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Кладёт трек файлом и возвращает путь для записи в базе.
 *
 * `null` означает «здесь так нельзя» — вызывающий сохранит по-старому.
 */
export async function writeTrackFile(
  trackId: string,
  blob: Blob,
  format?: string
): Promise<string | null> {
  if (!isFileStorageAvailable() || !blob) return null;
  const path = offlineFileName(trackId, format);
  try {
    await Filesystem.mkdir({ path: OFFLINE_DIR, directory: OFFLINE_DIRECTORY, recursive: true });
  } catch {
    // Папка уже есть — обычное дело, а не отказ.
  }
  try {
    const data = await toBase64(blob);
    await Filesystem.writeFile({ path, data, directory: OFFLINE_DIRECTORY, recursive: true });
    return path;
  } catch (err) {
    console.error('[OfflineFiles] write error:', err);
    return null;
  }
}

/**
 * Ссылка, которую можно отдать проигрывателю.
 *
 * `convertFileSrc` превращает `file:///…` в адрес на внутренней схеме WebView:
 * напрямую `file://` из страницы не открывается.
 */
export async function trackFileUrl(path: string): Promise<string | null> {
  if (!isFileStorageAvailable() || !path) return null;
  try {
    const { uri } = await Filesystem.getUri({ path, directory: OFFLINE_DIRECTORY });
    return Capacitor.convertFileSrc(uri);
  } catch (err) {
    console.warn('[OfflineFiles] uri error:', err);
    return null;
  }
}

/** Убирает файл. Отсутствие файла отказом не считается: цель достигнута. */
export async function deleteTrackFile(path: string | undefined): Promise<void> {
  if (!isFileStorageAvailable() || !path) return;
  try {
    await Filesystem.deleteFile({ path, directory: OFFLINE_DIRECTORY });
  } catch {
    // Уже удалён — так и надо.
  }
}

/** Убирает всю папку разом: по файлу это заняло бы сотни вызовов через мост. */
export async function clearTrackFiles(): Promise<void> {
  if (!isFileStorageAvailable()) return;
  try {
    await Filesystem.rmdir({ path: OFFLINE_DIR, directory: OFFLINE_DIRECTORY, recursive: true });
  } catch {
    // Папки нет — значит, и чистить нечего.
  }
}

/**
 * Просит систему не вычищать наше хранилище при нехватке места.
 *
 * Без этого Android и браузер вправе стереть сохранённое молча — человек
 * скачал альбом в дорогу, а в дороге его нет. Спрашивается один раз за запуск:
 * ответ за время работы не меняется, а само окно система показывает по своему
 * усмотрению и чаще не показывает вовсе.
 */
let persistAsked = false;
export async function requestPersistentStorage(): Promise<boolean> {
  if (persistAsked) return true;
  persistAsked = true;
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage || typeof storage.persist !== 'function') return false;
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}

// --- Прежнее хранение: `Blob` в базе ------------------------------------------

/**
 * Ссылки на сохранённые `Blob`, по одной на трек.
 *
 * Кэш, а не просто вызов `createObjectURL`: раньше ссылка создавалась на каждое
 * включение и не освобождалась ни разу, поэтому за вечер прослушивания
 * приложение удерживало в памяти все проигранные треки целиком. Кэш живёт здесь,
 * а не в `offlineStorage`, потому что читают сохранённое двое — настройки
 * офлайна и сам проигрыватель, — и вторым путём утечка возвращалась бы.
 */
const objectUrls = new Map<string, string>();

/** Ссылка на `Blob`, одна и та же при повторных включениях. */
export function objectUrlFor(trackId: string, blob: Blob): string {
  const cached = objectUrls.get(trackId);
  if (cached) return cached;
  const url =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(blob)
      : `blob:offline-${trackId}`;
  objectUrls.set(trackId, url);
  return url;
}

/** Освобождает ссылку одного трека. */
export function revokeObjectUrl(trackId: string): void {
  const url = objectUrls.get(trackId);
  objectUrls.delete(trackId);
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Отзывать нечего — не беда.
  }
}

/** Освобождает все ссылки разом. */
export function revokeAllObjectUrls(): void {
  for (const trackId of Array.from(objectUrls.keys())) revokeObjectUrl(trackId);
}
