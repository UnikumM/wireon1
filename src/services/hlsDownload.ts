/**
 * Скачивание HLS-потока в один звуковой файл — для офлайна.
 *
 * Зачем: у части записей SoundCloud нет прямого файла, только HLS (плейлист и
 * куски по десять секунд). Офлайн-сохранение до 4.0.1 этого не различало и
 * клало на диск сам плейлист — пару килобайт текста со ссылками, которые
 * протухают за час. Такая «копия» потом перехватывала воспроизведение и не
 * играла никогда (замерено 09.11.2026: 74 из 228 сохранённых записей).
 *
 * Как: init-сегмент (`#EXT-X-MAP`) и все куски подряд — это и есть
 * фрагментированный MP4, который `<audio>` и ffmpeg читают как обычный файл.
 * У MP3-потока init нет, кадры просто идут друг за другом.
 */

export type HlsProgress = (done: number, total: number) => void;

async function fetchOk(url: string, signal: AbortSignal | undefined, what: string): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HLS: ${what} ответил ${response.status}`);
  return response;
}

export function isHlsPlaylistText(text: string): boolean {
  return text.trimStart().startsWith('#EXTM3U');
}

export async function downloadHlsAudio(
  playlistUrl: string,
  playlist: string,
  signal?: AbortSignal,
  onProgress?: HlsProgress,
  depth = 0
): Promise<Blob> {
  const lines = playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const uris = lines.filter((line) => !line.startsWith('#'));
  if (uris.length === 0) throw new Error('HLS: в плейлисте нет сегментов');

  // Список вариантов качества: берём первый и разбираем уже его.
  if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF'))) {
    if (depth > 0) throw new Error('HLS: вложенный список вариантов');
    const variantUrl = new URL(uris[0], playlistUrl).toString();
    const variant = await fetchOk(variantUrl, signal, 'вариант');
    return downloadHlsAudio(variantUrl, await variant.text(), signal, onProgress, depth + 1);
  }

  // Зашифрованные куски без ключа — шум; сохранять их незачем.
  if (lines.some((line) => line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/.test(line))) {
    throw new Error('HLS: поток зашифрован, сохранить нельзя');
  }

  const init = lines.map((line) => /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(line)?.[1]).find(Boolean);
  const parts = init ? [init, ...uris] : uris;
  const chunks: ArrayBuffer[] = [];
  for (let index = 0; index < parts.length; index++) {
    const url = new URL(parts[index], playlistUrl).toString();
    const response = await fetchOk(url, signal, `сегмент ${index + 1}/${parts.length}`);
    chunks.push(await response.arrayBuffer());
    onProgress?.(index + 1, parts.length);
  }

  // MPEG-TS (байт синхронизации 0x47) склейкой в играемый файл не превращается.
  if (!init && new Uint8Array(chunks[0])[0] === 0x47) {
    throw new Error('HLS: поток в MPEG-TS, сохранить нельзя');
  }

  return new Blob(chunks, { type: init ? 'audio/mp4' : 'audio/mpeg' });
}
