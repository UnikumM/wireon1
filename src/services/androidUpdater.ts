/**
 * Обновление приложения на телефоне — то же самое, что делает electron-updater
 * на компьютере, но руками.
 *
 * Почему руками. Android не разрешает приложению подменить себя молча: файл
 * можно скачать, а установку показывает система, и человек подтверждает её сам.
 * Значит вся работа делится надвое: здесь — узнать, что вышло новое, и скачать;
 * в AppUpdaterPlugin — назвать установленную версию и открыть окно установки.
 *
 * Версии телефона живут своей линией номеров и с настольной не совпадают:
 * сравнивать надо с тем, что реально установлено, а не с числом из интерфейса.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

export interface AppUpdaterPlugin {
  getVersion(): Promise<{ versionName: string; versionCode: number }>;
  canInstall(): Promise<{ granted: boolean }>;
  requestInstallPermission(): Promise<void>;
  install(options: { path: string }): Promise<void>;
}

const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

/** Тот же релизный канал, что у настольной сборки. */
const RELEASES_URL = 'https://api.github.com/repos/UnikumM/wireon1/releases/latest';

/** Имя файла обновления в релизе: `Wireon-1.0.37.apk`. */
const APK_NAME = /^Wireon-(\d+\.\d+\.\d+)\.apk$/i;

export interface AvailableUpdate {
  version: string;
  url: string;
  size: number;
  name: string;
}

/**
 * Сравнивает версии по числам, а не по строке.
 *
 * Строкой «1.0.9» больше «1.0.37», и обновление на телефоне встало бы намертво
 * ровно тогда, когда его больше всего ждут.
 */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const parse = (value: string) => (value || '').split('.').map((part) => Number(part) || 0);
  const next = parse(candidate);
  const current = parse(installed);

  for (let i = 0; i < Math.max(next.length, current.length); i += 1) {
    const a = next[i] || 0;
    const b = current[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** Выбирает из файлов релиза наш APK — их там несколько, включая настольные. */
export function pickApkAsset(
  assets: ReadonlyArray<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>,
  installed: string
): AvailableUpdate | null {
  for (const asset of assets || []) {
    const name = typeof asset?.name === 'string' ? asset.name : '';
    const match = APK_NAME.exec(name);
    if (!match) continue;

    const version = match[1];
    if (!isNewerVersion(version, installed)) continue;

    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
    if (!url) continue;

    return { version, url, size: Number(asset.size) || 0, name };
  }
  return null;
}

/** Установленная версия — по данным системы, а не по числу из кода страницы. */
export async function getInstalledVersion(): Promise<string | null> {
  if (Capacitor.getPlatform() !== 'android') return null;
  try {
    const { versionName } = await AppUpdater.getVersion();
    return versionName || null;
  } catch {
    return null;
  }
}

/**
 * Есть ли обновление. `null` — обновляться нечем или незачем.
 *
 * Молчит при любой беде с сетью: проверка обновлений не тот повод, чтобы
 * показывать человеку ошибку поверх играющей музыки.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const installed = await getInstalledVersion();
  if (!installed) return null;

  try {
    const response = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return null;
    const release = (await response.json()) as { assets?: unknown[] };
    return pickApkAsset((release.assets || []) as any[], installed);
  } catch {
    return null;
  }
}

/**
 * Качает обновление в кэш приложения и открывает установку.
 *
 * В кэш, а не в загрузки: там файл не требует разрешений на чужие папки, а
 * система сама вычистит его, если место кончится. Проценты приходят в
 * `onProgress` — сорок мегабайт по мобильной сети идут заметно долго, и полоса
 * загрузки здесь не украшение.
 */
export async function downloadAndInstall(
  update: AvailableUpdate,
  onProgress?: (fraction: number) => void
): Promise<void> {
  const response = await fetch(update.url);
  if (!response.ok) throw new Error(`Не удалось скачать обновление: HTTP ${response.status}`);

  const total = Number(response.headers.get('Content-Length')) || update.size || 0;
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  if (reader) {
    // Читаем кусками ради процентов: `arrayBuffer()` отдал бы всё разом и
    // показывать было бы нечего.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        if (total > 0) onProgress?.(Math.min(1, received / total));
      }
    }
  } else {
    chunks.push(new Uint8Array(await response.arrayBuffer()));
    onProgress?.(1);
  }

  const blob = new Blob(chunks as BlobPart[], { type: 'application/vnd.android.package-archive' });
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader2 = new FileReader();
    reader2.onerror = () => reject(new Error('Не удалось прочитать скачанный файл'));
    reader2.onload = () => {
      const result = String(reader2.result || '');
      // `data:...;base64,XXXX` — плагину нужна только часть после запятой.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader2.readAsDataURL(blob);
  });

  await Filesystem.writeFile({ path: update.name, data: base64, directory: Directory.Cache });
  const { uri } = await Filesystem.getUri({ path: update.name, directory: Directory.Cache });

  const { granted } = await AppUpdater.canInstall();
  if (!granted) {
    // Разрешение спрашивается здесь, а не заранее: человек уже нажал
    // «обновить», и системное окно для него — продолжение его же действия.
    await AppUpdater.requestInstallPermission();
    throw new Error('Разрешите установку в открывшихся настройках и нажмите «Обновить» ещё раз');
  }

  await AppUpdater.install({ path: uri });
}
