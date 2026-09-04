/**
 * Проверяет, что вшитые бинарники подходят системе, под которую идёт сборка.
 *
 * Зачем. Внутрь сборки едут два чужих исполняемых файла: yt-dlp (им играет
 * YouTube) и ffmpeg (им сжимается офлайн-библиотека). Оба кладёт `npm install`,
 * и кладёт он их **под ту систему, где install выполнялся**. Значит собранный на
 * Windows AppImage унесёт внутрь `ffmpeg.exe` и `yt-dlp.exe`, спокойно
 * соберётся, спокойно запустится — и молча не сыграет ни одного трека с
 * YouTube. Ошибку человек увидит уже у себя, а выглядеть она будет как «плеер
 * сломан», а не как «сборка собрана не там».
 *
 * Поэтому проверка идёт до упаковки и валит сборку с объяснением, а не после.
 * Смотрим не только имя файла, но и первые байты: ELF у Linux, MZ у Windows —
 * файл с правильным именем и чужим содержимым тоже встречается.
 *
 *     node scripts/check-platform-binaries.mjs            # под текущую систему
 *     node scripts/check-platform-binaries.mjs --platform=linux
 */

import { existsSync, openSync, readSync, closeSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const argument = process.argv.slice(2).find((a) => a.startsWith('--platform='));
const target = argument ? argument.slice('--platform='.length) : process.platform;

/** Имя файла и подпись начала файла для каждой системы. */
const SHAPES = {
  win32: { suffix: '.exe', magic: [0x4d, 0x5a], magicName: 'MZ (Windows)' },
  linux: { suffix: '', magic: [0x7f, 0x45, 0x4c, 0x46], magicName: 'ELF (Linux)' },
  darwin: { suffix: '', magic: null, magicName: 'Mach-O (macOS)' }
};

const shape = SHAPES[target];
if (!shape) {
  console.error(`[binaries] Не знаю системы "${target}". Ожидаю win32, linux или darwin.`);
  process.exit(1);
}

/** yt-dlp для macOS называется иначе — как в релизе, откуда его берут. */
const ytDlpName = target === 'win32' ? 'yt-dlp.exe' : target === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';

const REQUIRED = [
  {
    what: 'yt-dlp',
    file: path.join(ROOT, 'node_modules', 'youtube-dl-exec', 'bin', ytDlpName)
  },
  {
    what: 'ffmpeg',
    file: path.join(ROOT, 'node_modules', 'ffmpeg-static', `ffmpeg${shape.suffix}`)
  }
];

/** Первые байты файла — чтобы поймать чужой бинарник под правильным именем. */
function startsWith(file, magic) {
  if (!magic) return true;
  let fd;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(magic.length);
    readSync(fd, head, 0, magic.length, 0);
    return magic.every((byte, index) => head[index] === byte);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const problems = [];
for (const { what, file } of REQUIRED) {
  const shown = path.relative(ROOT, file).split(path.sep).join('/');
  if (!existsSync(file)) {
    problems.push(`${what}: нет файла ${shown}`);
    continue;
  }
  if (!startsWith(file, shape.magic)) {
    problems.push(`${what}: ${shown} не похож на ${shape.magicName}`);
    continue;
  }
  console.log(`[binaries] ${what} на месте — ${shown}`);
}

if (problems.length === 0) {
  console.log(`[binaries] Всё подходит системе ${target}.`);
  process.exit(0);
}

console.error('');
console.error(`[binaries] Для системы ${target} сборка не готова:`);
for (const problem of problems) console.error(`  • ${problem}`);
console.error('');

if (target !== process.platform) {
  console.error(`Сейчас идёт сборка под ${target}, а зависимости ставились на ${process.platform}.`);
  console.error('Эти бинарники не переносятся между системами: их надо ставить там же,');
  console.error('где собираете. Для Linux это делает контейнер — см. раздел');
  console.error('«Сборка под Linux» в RELEASE.md.');
} else {
  console.error('Попробуйте `npm ci` — бинарники ставятся вместе с зависимостями.');
}
process.exit(1);
