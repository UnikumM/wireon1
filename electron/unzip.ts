/**
 * Распаковка zip-архива в папку — ровно столько, сколько нужно для yt-dlp.
 *
 * Зачем своя. yt-dlp «папкой» (`yt-dlp_win.zip`, `yt-dlp_linux.zip`) приходит
 * zip-архивом, а в Node распаковки zip нет. Тянуть ради одного архива
 * зависимость в установщик дороже, чем прочитать формат: оглавление в конце
 * файла, у каждой записи — смещение, метод (0 — как есть, 8 — deflate) и
 * размеры. Всё остальное из спецификации (шифрование, zip64, многотомные
 * архивы) в релизах yt-dlp не встречается, и такой архив честно отвергается.
 *
 * Целостность проверяет не этот модуль: архив сверяется по SHA-256 из релиза
 * до распаковки (см. ytdlp.ts), поэтому CRC отдельных файлов здесь не считаем.
 */

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { inflateRawSync } from 'zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Конец оглавления — 22 байта плюс комментарий до 64 КБ. */
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;

export interface UnzipFsLike {
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
}

export interface UnzipEntry {
  /** Путь внутри архива, всегда через `/`. */
  name: string;
  /** Права из архива (Unix), если они записаны: исполняемый бит нужен на Linux. */
  mode: number | null;
}

/**
 * Распаковывает `bytes` в `destDir` и возвращает список записанных файлов.
 *
 * Бросает на всём, что не похоже на обычный архив, и на путях, которые
 * выходят за пределы `destDir` (`../`, абсолютные) — архив из сети не должен
 * писать куда-то ещё.
 */
export function extractZip(bytes: Uint8Array, destDir: string, fs: UnzipFsLike = { mkdirSync, writeFileSync }): UnzipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('zip64 не поддерживается');

  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  const written: UnzipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error('оглавление архива повреждено');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const madeBy = view.getUint16(offset + 4, true) >> 8;
    const externalAttrs = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/g, '/');
    offset += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error(`зашифрованный файл в архиве: ${name}`);

    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`путь выходит за пределы папки: ${name}`);
    }

    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`запись повреждена: ${name}`);
    }
    // Длины имени и extra в локальном заголовке могут отличаться от оглавления.
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataStart + compressedSize > bytes.byteLength) throw new Error(`архив обрезан: ${name}`);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`неизвестный метод сжатия ${method}: ${name}`);
    if (data.byteLength !== size) throw new Error(`размер не сошёлся: ${name}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    // 3 — архив собран на Unix, и в старших битах лежат права файла.
    const mode = madeBy === 3 ? (externalAttrs >>> 16) & 0o777 : 0;
    written.push({ name, mode: mode || null });
  }

  return written;
}

function findEndOfCentralDirectory(view: DataView): number {
  const stop = Math.max(0, view.byteLength - EOCD_SEARCH);
  for (let at = view.byteLength - EOCD_MIN; at >= stop; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  throw new Error('это не zip-архив');
}
