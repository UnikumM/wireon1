#!/usr/bin/env node
/**
 * Снимки экранов приложения в браузере: три ширины, две темы, с треком в плеере.
 *
 * Не тест на прохождение, а глаза: после правок вида прогоняется один раз и
 * кладёт PNG в tests/visual/out, чтобы смотреть диффы глазами (и показывать
 * владельцу). Нужен запущенный `npm run dev` (порт 3000) и Playwright с
 * Chromium — в облачной сессии они уже стоят, локально `npx playwright install`.
 *
 *   node scripts/visual-shots.mjs [--url http://localhost:3000] [--only phone]
 *
 * Состояние сажается через `window.__wireon` — dev-only объект из src/devtools.ts.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/visual/out');
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const URL = argOf('--url', 'http://localhost:3000/');
const ONLY = argOf('--only', null);

const SIZES = {
  phone: { width: 390, height: 844 },
  narrow: { width: 900, height: 700 },
  desk: { width: 1280, height: 800 }
};

const ART = (a, b) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="280" cy="130" r="70" fill="#fff" fill-opacity=".25"/></svg>`
  );

const TRACK = {
  id: 'yt_demo',
  source: 'youtube',
  originalId: 'demo',
  title: 'Холодный свет',
  artist: 'Северный ветер',
  duration: 221,
  artworkUrl: ART('#3a5a8f', '#9bc8ff'),
  sourceUrl: 'https://youtube.com/watch?v=demo'
};

/** Медиатека для снимков: пустая главная выглядит плохо при любом дизайне. */
const PALETTES = [
  ['#8f3a3a', '#f0a875'], ['#2f6b55', '#b7e3c8'], ['#4a3a6b', '#c9b6f0'], ['#6b5a2f', '#e8c48f'],
  ['#223344', '#667788'], ['#8a2a52', '#f28ba0'], ['#1e4d5c', '#79c8d8'], ['#3a5a8f', '#9bc8ff'],
  ['#5a3a1e', '#d9a066'], ['#2a4d2a', '#9fd39f'], ['#4d2a4d', '#d39fd3'], ['#2a2a4d', '#9f9fd3']
];
const TITLES = ['Город спит', 'Пыль и неон', 'Тихий берег', 'Лампа', 'Северный ветер', 'Бег по кругу', 'Стекло', 'Полночь', 'Окраина', 'Шум дождя', 'Двое', 'Фонари'];
const ARTISTS = ['Лампа', 'Пыль и неон', 'Тихий берег', 'Северный ветер', 'Гидропоника', 'Окна'];
const LIBRARY = TITLES.map((title, i) => ({
  id: `yt_lib_${i}`,
  source: i % 3 === 0 ? 'soundcloud' : 'youtube',
  originalId: `lib_${i}`,
  title,
  artist: ARTISTS[i % ARTISTS.length],
  duration: 150 + i * 17,
  artworkUrl: ART(...PALETTES[i % PALETTES.length]),
  sourceUrl: `https://youtube.com/watch?v=lib_${i}`
}));
const PLAYLISTS = [
  { id: 'pl_night', title: 'Ночная', tracks: LIBRARY.slice(0, 8) },
  { id: 'pl_road', title: 'В дорогу', tracks: LIBRARY.slice(3, 11) },
  { id: 'pl_fav26', title: 'Любимое 2026', tracks: LIBRARY.slice(1, 12) },
  { id: 'pl_run', title: 'Бег', tracks: LIBRARY.slice(5, 9) }
].map((playlist, i) => ({ ...playlist, createdAt: 1_700_000_000_000 + i, updatedAt: 1_700_000_000_000 + i, isSynced: true }));

/** Экраны: разделы приложения и сцена плеера. */
const SCREENS = ['search', 'home', 'library', 'foryou', 'settings', 'stage'];

const browser = await chromium.launch();
let count = 0;
for (const [size, viewport] of Object.entries(SIZES)) {
  if (ONLY && ONLY !== size) continue;
  for (const scheme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      localStorage.setItem('wireon_auth_intro_seen', '1');
      localStorage.setItem('wireon_last_seen_version', '99.0.0');
    });
    await page.goto(URL, { waitUntil: 'networkidle' });
    // Заставка играет пару секунд; снимать поверх неё бессмысленно.
    await page.waitForTimeout(3500);
    await page.evaluate(
      ([t, depth, library, playlists]) => {
        const w = window.__wireon;
        w.usePlayerStore.setState({ currentTrack: t, duration: t.duration, currentTime: 84, isPlaying: true, resumePosition: 84 });
        w.useLibraryStore.setState({ history: library, favorites: library.slice(0, 7), playlists });
        w.usePinnedStore.setState({ pinnedIds: ['pl_night', 'pl_road', 'pl_fav26'] });
        // Глубина темы — настройка приложения, а не системы: светлую включаем сами.
        w.useThemeStore.getState().setDepth(depth);
      },
      [TRACK, scheme === 'light' ? 'light' : 'night', LIBRARY, PLAYLISTS]
    );
    for (const name of SCREENS) {
      await page.evaluate((view) => {
        const ui = window.__wireon.useUIStore.getState();
        if (view === 'stage') ui.setFullscreenPlayerOpen(true);
        else ui.setActiveView(view);
      }, name);
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(OUT, `${size}-${scheme}-${name}.png`) });
      count++;
      if (name === 'stage') await page.evaluate(() => window.__wireon.useUIStore.getState().setFullscreenPlayerOpen(false));
    }
    if (errors.length) console.error(`[${size}/${scheme}] ошибки страницы:\n  ${errors.slice(0, 5).join('\n  ')}`);
    await ctx.close();
  }
}
await browser.close();
console.log(`снимков: ${count} → ${path.relative(ROOT, OUT)}`);
