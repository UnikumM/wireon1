/**
 * Значки для кнопок в миниатюре окна на панели задач Windows
 * (`win.setThumbarButtons`, см. refreshThumbarButtons в electron/main.ts).
 *
 * Почему готовые PNG, а не SVG на лету: `nativeImage` в Electron на Windows не
 * растрирует SVG, а тянуть ради четырёх пиктограмм растеризатор в зависимости —
 * лишнее. Фигуры простые (треугольник и прямоугольники), поэтому рисуются
 * здесь кодом с избыточной выборкой для гладких краёв и пишутся тем же
 * минимальным PNG-кодеком, что и в gen-icon.mjs (копия намеренно: тот скрипт
 * выполняется при импорте, а выносить общий модуль ради тридцати строк —
 * больше возни, чем пользы).
 *
 * Два набора: белый для тёмной панели задач и почти чёрный для светлой —
 * выбирается в main.ts по `nativeTheme.shouldUseDarkColors`. Один набор
 * не годится: белая стрелка на светлой панели просто не видна.
 *
 *   public/thumbar/<light|dark>/{prev,play,pause,next}.png  32×32 RGBA
 *
 * Запуск: `npm run gen:thumbar`. Результат лежит в репозитории, при сборке
 * перегенерировать не нужно.
 */
import { deflateSync } from 'zlib';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'thumbar');

/** Размер холста. Windows показывает 16 px при 100 % масштабе, 32 — запас на HiDPI. */
const SIZE = 32;
/** Подвыборок на сторону пикселя: 8×8 = 64 градации прозрачности на краю. */
const SUPERSAMPLE = 8;

// --------------------------------------------------------------------------
// PNG: минимальный кодек (см. gen-icon.mjs)
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

// --------------------------------------------------------------------------
// Фигуры: каждая — функция «точка внутри?» в координатах холста
// --------------------------------------------------------------------------
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;

/** Треугольник по трём вершинам: точка внутри, если по одну сторону от всех рёбер. */
function triangle([ax, ay], [bx, by], [cx, cy]) {
  const side = (px, py, qx, qy, x, y) => (qx - px) * (y - py) - (qy - py) * (x - px);
  return (x, y) => {
    const d1 = side(ax, ay, bx, by, x, y);
    const d2 = side(bx, by, cx, cy, x, y);
    const d3 = side(cx, cy, ax, ay, x, y);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
}

const union = (...shapes) => (x, y) => shapes.some((inside) => inside(x, y));

// Поле 7…25 по вертикали — чтобы на 16 px значок не упирался в края кнопки.
const TOP = 7;
const BOTTOM = 25;
const MID = (TOP + BOTTOM) / 2;

const SHAPES = {
  // Треугольник чуть сдвинут вправо: оптический центр у него левее геометрического.
  play: triangle([10, TOP], [10, BOTTOM], [25, MID]),
  pause: union(rect(9, TOP, 13.5, BOTTOM), rect(18.5, TOP, 23, BOTTOM)),
  next: union(triangle([7, TOP], [7, BOTTOM], [21, MID]), rect(22, TOP, 25.5, BOTTOM)),
  prev: union(rect(6.5, TOP, 10, BOTTOM), triangle([25, TOP], [25, BOTTOM], [11, MID]))
};

const COLORS = {
  light: [0xff, 0xff, 0xff], // на тёмной панели задач
  dark: [0x1f, 0x1f, 0x1f] // на светлой
};

/** Доля подвыборок пикселя внутри фигуры → прозрачность. Цвет один на весь значок. */
function render(inside, [r, g, b]) {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const step = 1 / SUPERSAMPLE;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          if (inside(x + (sx + 0.5) * step, y + (sy + 0.5) * step)) hits++;
        }
      }
      const i = (y * SIZE + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = Math.round((hits / (SUPERSAMPLE * SUPERSAMPLE)) * 255);
    }
  }
  return out;
}

for (const [theme, color] of Object.entries(COLORS)) {
  const dir = path.join(OUT_DIR, theme);
  mkdirSync(dir, { recursive: true });
  for (const [name, shape] of Object.entries(SHAPES)) {
    const file = path.join(dir, `${name}.png`);
    writeFileSync(file, encodePng(render(shape, color), SIZE));
    console.log(`→ ${path.relative(ROOT, file)}`);
  }
}
