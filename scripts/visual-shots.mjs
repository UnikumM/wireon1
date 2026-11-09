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
      ([t, depth]) => {
        window.__wireon.usePlayerStore.setState({ currentTrack: t, duration: t.duration, currentTime: 84, isPlaying: true });
        // Глубина темы — настройка приложения, а не системы: светлую включаем сами.
        window.__wireon.useThemeStore.getState().setDepth(depth);
      },
      [TRACK, scheme === 'light' ? 'light' : 'night']
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
