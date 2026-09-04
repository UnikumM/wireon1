/**
 * Обновляет вшитый yt-dlp перед сборкой.
 *
 * В установщик едет тот бинарник, который лежит в `node_modules/youtube-dl-exec/bin`,
 * а `npm install` кладёт туда версию на момент выхода пакета. Для YouTube это
 * слишком старо: часть видео отдаёт ссылки, требующие proof-of-origin, и они не
 * играют. Приложение умеет обновлять извлекатель само (electron/ytdlp.ts), но
 * первые секунды после установки оно работает на вшитом — пусть он будет свежим.
 *
 * Скрипт не обязателен: нет сети или GitHub недоступен — сборка идёт дальше на
 * том, что есть. Падать из-за этого нельзя, иначе релиз нельзя выпустить офлайн.
 *
 *     npm run refresh:ytdlp
 */
import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = path.join(
  ROOT,
  'node_modules',
  'youtube-dl-exec',
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

function version() {
  try {
    return execFileSync(BINARY, ['--version'], { encoding: 'utf-8', timeout: 30_000 }).trim();
  } catch {
    return null;
  }
}

if (!existsSync(BINARY)) {
  console.log(`[yt-dlp] Бинарника нет (${BINARY}) — пропускаю обновление.`);
  process.exit(0);
}

const before = version();
console.log(`[yt-dlp] Сейчас в сборке: ${before ?? 'не удалось спросить'}`);

try {
  // --update-to nightly: починки YouTube выходят в ночных сборках в день поломки,
  // стабильные релизы ждут до месяца.
  const output = execFileSync(BINARY, ['--update-to', 'nightly'], {
    encoding: 'utf-8',
    timeout: 180_000
  });
  process.stdout.write(output);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  console.log(`[yt-dlp] Обновить не удалось (${detail}). Собираю с тем, что есть.`);
  process.exit(0);
}

const after = version();
if (!after) {
  // Такого быть не должно: yt-dlp откатывает себя сам, если новая версия не
  // запускается. Но собирать установщик с нерабочим извлекателем нельзя.
  console.error('[yt-dlp] После обновления бинарник не отвечает на --version.');
  process.exit(1);
}

const size = statSync(BINARY).size;
console.log(`[yt-dlp] Теперь в сборке: ${after} (${(size / 1024 / 1024).toFixed(1)} МБ)`);
if (before && before === after) {
  console.log('[yt-dlp] Версия не изменилась — уже была свежей.');
}
