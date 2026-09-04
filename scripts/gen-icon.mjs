/**
 * Иконки приложения из фирменного знака — без единой зависимости.
 *
 * Раньше знак рисовался кодом: скруглённый квадрат, фиолетовое кольцо и
 * треугольник «play». Он был честной заглушкой, пока настоящего логотипа не
 * было. Теперь есть (`build/brand/logo.png`), и рисовать похожее вручную
 * незачем — надо взять его и разложить по размерам, которых требуют Windows и
 * Android.
 *
 * Почему свои кодек и масштабирование, а не библиотека: в проекте нет ни
 * `sharp`, ни `jimp`, а тянуть их ради одной операции при сборке — это
 * несколько десятков мегабайт зависимостей и нативный модуль, который придётся
 * пересобирать под каждую платформу. PNG без интерлейса читается и пишется
 * тремя десятками строк поверх `zlib`, который в Node уже есть.
 *
 * Что получается на выходе:
 *   build/icon.png            512  — electron-builder делает из него .ico
 *   public/icon.png           512  — значок окна
 *   android .../ic_launcher   48…192 — сам значок
 *   android .../ic_launcher_foreground 108…432 — слой адаптивной иконки
 */
import { deflateSync, inflateSync } from 'zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'build', 'brand', 'logo.png');

// --------------------------------------------------------------------------
// PNG: минимальный кодек
// --------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Кодирует RGBA-массив в PNG. Фильтр 0 на каждой строке: zlib и так сожмёт. */
function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const from = y * size * 4;
    const to = y * (size * 4 + 1);
    raw[to] = 0;
    rgba.copy(raw, to + 1, from, from + size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Читает PNG без интерлейса: 8 бит на канал, RGB или RGBA.
 *
 * Разбор фильтров — единственная содержательная часть: PNG хранит не пиксели, а
 * разницу с соседями, и без обратного хода получится шум.
 */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('это не PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('поддерживается только 8 бит на канал');
      colorType = data[9];
      if (colorType !== 2 && colorType !== 6) throw new Error('нужен RGB или RGBA');
      if (data[12] !== 0) throw new Error('интерлейс не поддерживается');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);

  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));

    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let value = line[i];

      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        // Paeth: выбирается сосед, ближайший к предсказанию.
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      line[i] = value & 0xff;
    }

    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4;
      const from = x * channels;
      out[to] = line[from];
      out[to + 1] = line[from + 1];
      out[to + 2] = line[from + 2];
      out[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    previous = line;
  }

  return { width, height, data: out };
}

// --------------------------------------------------------------------------
// Масштабирование
// --------------------------------------------------------------------------

/**
 * Усреднение по области, а не выборка ближайшего пикселя.
 *
 * Знак состоит из тонких дуг; при выборке ближайшего они на 48 px рассыпались бы
 * в пунктир. Цвет усредняется с учётом прозрачности — иначе по краю проступает
 * тёмная кайма от невидимых пикселей.
 */
function resize(source, size) {
  const { width, height, data } = source;
  const out = Buffer.alloc(size * size * 4);
  const scaleX = width / size;
  const scaleY = height / size;

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = y0; sy < y1 && sy < height; sy++) {
        for (let sx = x0; sx < x1 && sx < width; sx++) {
          const i = (sy * width + sx) * 4;
          const alpha = data[i + 3] / 255;
          r += data[i] * alpha;
          g += data[i + 1] * alpha;
          b += data[i + 2] * alpha;
          a += data[i + 3];
          count++;
        }
      }

      const to = (y * size + x) * 4;
      const alphaAvg = a / count;
      const weight = alphaAvg / 255;
      out[to] = weight > 0 ? Math.round(r / count / weight) : 0;
      out[to + 1] = weight > 0 ? Math.round(g / count / weight) : 0;
      out[to + 2] = weight > 0 ? Math.round(b / count / weight) : 0;
      out[to + 3] = Math.round(alphaAvg);
    }
  }

  return out;
}

/**
 * Кладёт знак в квадрат нужного размера с полями.
 *
 * Нужно слою адаптивной иконки Android: система обрезает его по своей маске —
 * кругу, квадрату со скруглением или капле, — и берёт при этом только
 * центральные две трети. Знак, положенный впритык, потерял бы края.
 */
function pad(scaled, size, inset) {
  const inner = Math.round(size * (1 - inset * 2));
  const small = resize({ width: size, height: size, data: scaled }, inner);
  const out = Buffer.alloc(size * size * 4);
  const offset = Math.round((size - inner) / 2);

  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const from = (y * inner + x) * 4;
      const to = ((y + offset) * size + (x + offset)) * 4;
      small.copy(out, to, from, from + 4);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Сборка
// --------------------------------------------------------------------------
const source = decodePng(readFileSync(SOURCE));

function write(file, rgba, size) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encodePng(rgba, size));
  return `${path.relative(ROOT, file).replace(/\\/g, '/')} — ${size}×${size}`;
}

const written = [];

// Windows и окно приложения.
const large = resize(source, 512);
written.push(write(path.join(ROOT, 'build', 'icon.png'), large, 512));
written.push(write(path.join(ROOT, 'public', 'icon.png'), large, 512));

// Android: сам значок и слой адаптивной иконки.
const DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432]
];

for (const [density, launcher, foreground] of DENSITIES) {
  const dir = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', `mipmap-${density}`);
  const icon = resize(source, launcher);
  written.push(write(path.join(dir, 'ic_launcher.png'), icon, launcher));
  written.push(write(path.join(dir, 'ic_launcher_round.png'), icon, launcher));
  // 25% полей: столько система оставляет под свою маску.
  written.push(
    write(path.join(dir, 'ic_launcher_foreground.png'), pad(resize(source, foreground), foreground, 0.25), foreground)
  );
}

/*
 * Экран запуска: знак по центру тёмного поля.
 *
 * Раньше здесь лежала заготовка Capacitor. Заменяется на тот же логотип, чтобы
 * первое, что видно при запуске, было приложением, а не чужой картинкой.
 * Размеры не выдуманы — ровно те, что Android ждёт для каждой плотности и
 * ориентации; знак занимает треть меньшей стороны, как принято на заставках.
 */
const SPLASH_BG = [0x0b, 0x22, 0x26];

function splash(width, height) {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = SPLASH_BG[0];
    out[i * 4 + 1] = SPLASH_BG[1];
    out[i * 4 + 2] = SPLASH_BG[2];
    out[i * 4 + 3] = 255;
  }

  const mark = Math.round(Math.min(width, height) / 3);
  const logo = resize(source, mark);
  const left = Math.round((width - mark) / 2);
  const top = Math.round((height - mark) / 2);

  for (let y = 0; y < mark; y++) {
    for (let x = 0; x < mark; x++) {
      const from = (y * mark + x) * 4;
      const alpha = logo[from + 3] / 255;
      if (alpha === 0) continue;
      const to = ((y + top) * width + (x + left)) * 4;
      // Смешиваем со фоном: у знака мягкие края, и вставка «как есть» дала бы
      // по кругу зубчатую кайму.
      for (let c = 0; c < 3; c++) {
        out[to + c] = Math.round(logo[from + c] * alpha + out[to + c] * (1 - alpha));
      }
      out[to + 3] = 255;
    }
  }
  return out;
}

function writeSplash(file, width, height) {
  mkdirSync(path.dirname(file), { recursive: true });
  const rgba = splash(width, height);
  // Кодировщик выше рассчитан на квадрат; заставки не квадратные, поэтому
  // здесь своя сборка тех же чанков.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const from = y * width * 4;
    const to = y * (width * 4 + 1);
    raw[to] = 0;
    rgba.copy(raw, to + 1, from, from + width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0))
    ])
  );
  return path.relative(ROOT, file).split(path.sep).join('/') + ` — ${width}×${height}`;
}

const SPLASHES = [
  ['drawable', 480, 320],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280]
];

for (const [dir, width, height] of SPLASHES) {
  written.push(
    writeSplash(path.join(ROOT, 'android', 'app', 'src', 'main', 'res', dir, 'splash.png'), width, height)
  );
}

console.log(`Иконки собраны из ${path.relative(ROOT, SOURCE).replace(/\\/g, '/')}:`);
for (const line of written) console.log('  ' + line);
