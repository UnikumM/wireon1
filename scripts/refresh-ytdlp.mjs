/**
 * Обновляет вшитый yt-dlp перед сборкой.
 *
 * В установщик едет тот бинарник, который лежит в `node_modules/youtube-dl-exec/bin`,
 * а `npm install` кладёт туда версию на момент выхода пакета. Для YouTube это
 * слишком старо: часть видео отдаёт ссылки, требующие proof-of-origin, и они не
 * играют. Приложение умеет обновлять извлекатель само (electron/ytdlp.ts), но
 * первые секунды после установки оно работает на вшитом — пусть он будет свежим.
 *
 * Путей два, и они разные не от хорошей жизни:
 *
 * - **Windows.** Вшитый `yt-dlp.exe` самодостаточен, и он умеет обновлять себя
 *   сам — `--update-to nightly`, одна команда.
 * - **Linux и macOS.** `npm install` кладёт туда `yt-dlp` — питоновский zipapp,
 *   который без python3 в системе не запускается. Внутри AppImage питона нет,
 *   поэтому вместо обновления на месте скачивается самодостаточная сборка
 *   (`yt-dlp_linux`, `yt-dlp_macos`) и кладётся под тем же именем. Обновить
 *   zipapp «в себя же» нельзя: yt-dlp обновляется в свою разновидность, а нам
 *   нужна другая.
 *
 * Скрипт не обязателен: нет сети или GitHub недоступен — сборка идёт дальше на
 * том, что есть. Падать из-за этого нельзя, иначе релиз нельзя выпустить офлайн.
 *
 *     npm run refresh:ytdlp
 */
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';
const BINARY = path.join(
  ROOT,
  'node_modules',
  'youtube-dl-exec',
  'bin',
  IS_WINDOWS ? 'yt-dlp.exe' : 'yt-dlp'
);

/** Тот же канал, что у самообновления в приложении (electron/ytdlp.ts). */
const NIGHTLY_REPO = 'https://github.com/yt-dlp/yt-dlp-nightly-builds';

/** Самодостаточная сборка под систему — та, которой не нужен python3. */
const STANDALONE_ASSET = process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';

/** Пол размера: страница ошибки GitHub весит килобайты, настоящая сборка — мегабайты. */
const MIN_BINARY_BYTES = 1024 * 1024;

function version() {
  try {
    return execFileSync(BINARY, ['--version'], { encoding: 'utf-8', timeout: 30_000 }).trim();
  } catch {
    return null;
  }
}

/** Обновление на месте — для сборок, которые умеют обновлять сами себя. */
function updateInPlace() {
  // --update-to nightly: починки YouTube выходят в ночных сборках в день поломки,
  // стабильные релизы ждут до месяца.
  const output = execFileSync(BINARY, ['--update-to', 'nightly'], {
    encoding: 'utf-8',
    timeout: 180_000
  });
  process.stdout.write(output);
}

/** Замена файла целиком — когда нужна другая разновидность сборки, а не версия. */
async function downloadStandalone() {
  const url = `${NIGHTLY_REPO}/releases/latest/download/${STANDALONE_ASSET}`;
  console.log(`[yt-dlp] Качаю самодостаточную сборку: ${STANDALONE_ASSET}`);

  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < MIN_BINARY_BYTES) {
    throw new Error(`подозрительно маленький файл: ${bytes.byteLength} байт`);
  }

  // Сначала рядом, потом на место: оборванная закачка не должна оставить
  // сборку без работающего извлекателя.
  const part = `${BINARY}.part`;
  writeFileSync(part, bytes);
  chmodSync(part, 0o755);
  try {
    execFileSync(part, ['--version'], { encoding: 'utf-8', timeout: 60_000 });
  } catch (err) {
    rmSync(part, { force: true });
    throw new Error(`скачанный файл не запускается: ${err instanceof Error ? err.message : err}`);
  }
  renameSync(part, BINARY);
}

if (!existsSync(BINARY)) {
  console.log(`[yt-dlp] Бинарника нет (${BINARY}) — пропускаю обновление.`);
  process.exit(0);
}

const before = version();
console.log(`[yt-dlp] Сейчас в сборке: ${before ?? 'не удалось спросить'}`);

try {
  if (IS_WINDOWS) {
    updateInPlace();
  } else {
    await downloadStandalone();
  }
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  console.log(`[yt-dlp] Обновить не удалось (${detail}). Собираю с тем, что есть.`);
  process.exit(0);
}

const after = version();
if (!after) {
  // Такого быть не должно: yt-dlp откатывает себя сам, если новая версия не
  // запускается, а скачанную мы проверяем до подмены. Но собирать установщик с
  // нерабочим извлекателем нельзя.
  console.error('[yt-dlp] После обновления бинарник не отвечает на --version.');
  process.exit(1);
}

const size = statSync(BINARY).size;
console.log(`[yt-dlp] Теперь в сборке: ${after} (${(size / 1024 / 1024).toFixed(1)} МБ)`);
if (before && before === after) {
  console.log('[yt-dlp] Версия не изменилась — уже была свежей.');
}
