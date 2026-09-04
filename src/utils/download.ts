/**
 * Сохранение файла из окна приложения.
 *
 * Один способ на всё приложение: выгрузка медиатеки и вынос отдельного
 * плейлиста делали это по-разному, и в одном из мест забывали освободить
 * object URL — браузер держал файл в памяти до перезапуска.
 *
 * **На телефоне это работает иначе, и молча.** Замерено на устройстве: клик по
 * `<a download>` в Android WebView не бросает исключения и ничего не сохраняет —
 * файл просто не появляется ни в «Загрузках», ни где-либо ещё. То есть кнопка
 * отчитывалась об успехе, которого не было. Поэтому на телефоне файл пишется
 * через файловую систему устройства и сразу предлагается «поделиться»: на
 * телефоне выгруженный плейлист обычно и нужен для того, чтобы куда-то его
 * отправить, а не чтобы он лежал в папке.
 */

import { detectPlatform } from '../services/nativeBridge';

/** Отдаёт пользователю текстовый файл. Возвращает `false`, если сохранять некуда. */
export function downloadTextFile(filename: string, mimeType: string, content: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return false;
  }

  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Освобождаем на следующем тике — к этому моменту загрузка уже началась.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

/**
 * Сохраняет текстовый файл там, где это работает на текущей платформе.
 *
 * На ПК и в браузере — обычная загрузка. На телефоне — запись в «Документы»
 * устройства и системный лист «Поделиться». Возвращает описание того, что
 * произошло, чтобы вызывающий сказал человеку правду, а не «сохранено» в обоих
 * случаях.
 */
export async function saveTextFile(
  filename: string,
  mimeType: string,
  content: string
): Promise<{ ok: boolean; where: 'download' | 'shared' | 'documents'; detail?: string }> {
  if (detectPlatform() !== 'mobile') {
    return { ok: downloadTextFile(filename, mimeType, content), where: 'download' };
  }

  try {
    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
      import('@capacitor/filesystem'),
      import('@capacitor/share')
    ]);

    const written = await Filesystem.writeFile({
      path: filename,
      data: content,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true
    });

    try {
      await Share.share({ title: filename, url: written.uri, dialogTitle: 'Куда отправить плейлист' });
      return { ok: true, where: 'shared' };
    } catch {
      // Лист «поделиться» закрыли или его нет — файл всё равно записан, и это
      // не отказ: сказать про папку честнее, чем показать ошибку.
      return { ok: true, where: 'documents' };
    }
  } catch (err) {
    return {
      ok: false,
      where: 'documents',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}
