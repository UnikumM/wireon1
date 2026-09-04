/**
 * Packaged boot smoke check — starts the real Electron main process against the
 * built bundle and proves the window loads with a working context bridge.
 *
 * Deliberately launched from a different working directory: the packaged app is
 * started from a desktop shortcut, so `process.cwd()` is wherever the user was,
 * not the app folder. A build that resolves its preload or its index.html from
 * cwd works perfectly in development and shows a blank window in production —
 * which is exactly what happened.
 *
 *     npm run smoke:boot
 *
 * The main process cooperates: with WIREON_SMOKE=1 it prints the bridge surface
 * and the loaded URL, then quits by itself.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every member the renderer reaches for — the whole bridge surface. */
const REQUIRED_BRIDGE = [
  'minimize',
  'maximize',
  'close',
  'isMaximized',
  'onWindowStateChange',
  'getPlatform',
  'setMediaKeysEnabled',
  'onMediaKey',
  'openExternal',
  'onDeepLink',
  'resolveYouTubeStream',
  'searchYouTube',
  'searchSoundCloud',
  'getUpdateState',
  'checkForUpdates',
  'installUpdate',
  'onUpdateState'
];

const TIMEOUT_MS = 45_000;

for (const artefact of ['dist/index.html', 'dist-electron/main.js', 'dist-electron/preload.cjs']) {
  if (!existsSync(path.join(ROOT, artefact))) {
    console.error(`[smoke:boot] ${artefact} is missing — run npm run electron:build first.`);
    process.exit(1);
  }
}

let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.error('[smoke:boot] the electron package is not installed.');
  process.exit(1);
}

// Anywhere but the project: this is the whole point of the check.
const launchDir = os.tmpdir();
console.log(`[smoke:boot] launching from ${launchDir} (not the app directory)\n`);

// ELECTRON_RUN_AS_NODE turns electron.exe into a plain Node binary, and some
// editors (VS Code's extension host, for one) export it to every child process.
// Inherited here it would run dist-electron/main.js under Node, which fails on
// the first `import { app } from 'electron'` and looks exactly like a build bug.
const env = { ...process.env, WIREON_SMOKE: '1', NODE_ENV: 'production' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

// The app directory, not the entry file: Electron then reads package.json
// "main" exactly as it does from an installed shortcut.
//
// Its own profile directory, and not the real one, for two reasons. The app holds
// a single-instance lock, so with Wireon open this check used to exit before it
// booted anything and reported the whole bridge as missing — a failure that says
// nothing about the build. And a smoke run has no business touching the person's
// library, window bounds or session cookies. The path is fixed rather than unique
// per run so temp does not accumulate a profile per verify.
const SMOKE_PROFILE = path.join(os.tmpdir(), 'wireon-smoke-profile');

const child = spawn(electronPath, [ROOT, `--user-data-dir=${SMOKE_PROFILE}`], {
  cwd: launchDir,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
const capture = (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);

const killTimer = setTimeout(() => {
  console.error(`\n[smoke:boot] no verdict after ${TIMEOUT_MS / 1000}s — killing Electron.`);
  child.kill();
}, TIMEOUT_MS);

child.on('error', (err) => {
  clearTimeout(killTimer);
  console.error(`[smoke:boot] could not start Electron: ${err.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  clearTimeout(killTimer);

  const failures = [];
  const report = (label, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(label);
  };

  console.log('\nVerdict');
  console.log('-------');

  // 1. The bridge exists at all: this is the preload actually running.
  const bridgeType = /\[smoke\] electronAPI=(\S+)/.exec(output)?.[1];
  report('the preload ran and exposed electronAPI', bridgeType === 'object', bridgeType ?? 'no report');

  // 2. And it exposes everything the renderer looks for.
  const bridgeKeys = (/\[smoke\] bridge=(.*)/.exec(output)?.[1] ?? '').split(',').filter(Boolean);
  const missing = REQUIRED_BRIDGE.filter((key) => !bridgeKeys.includes(key));
  report(
    'the bridge exposes every channel the UI needs',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${bridgeKeys.length} members`
  );

  // 3. The window loaded the built bundle, over file://, from the app folder.
  const loaded = /\[smoke\] loaded=(\S+)/.exec(output)?.[1] ?? '';
  report('the window loaded the packaged bundle', loaded.startsWith('file:///') && loaded.endsWith('index.html'), loaded || 'nothing loaded');
  report(
    'it loaded from the app directory, not the launch directory',
    loaded.toLowerCase().includes('dist/index.html') || loaded.toLowerCase().includes('dist%5cindex.html'),
    loaded
  );

  // 4. Nothing failed on the way. code=-3 is ERR_ABORTED, which Chromium emits
  // for superseded navigations and reloads — not a load failure.
  const failLoad = [...output.matchAll(/\[Electron\] did-fail-load (.*)/g)]
    .map((m) => m[1])
    .find((line) => !line.startsWith('code=-3 '));
  report('no did-fail-load was reported', !failLoad, failLoad ?? 'clean load');

  const rendererErrors = [...output.matchAll(/\[smoke\]\[renderer:error\] (.*)/g)].map((m) => m[1]);
  report(
    'the renderer logged no errors',
    rendererErrors.length === 0,
    rendererErrors.length ? rendererErrors[0] : 'silent'
  );

  report('Electron exited cleanly', code === 0, `exit code ${code}`);

  console.log('');
  if (failures.length) {
    console.error(`${failures.length} check(s) failed. Full output above.`);
    process.exit(1);
  }
  console.log('The packaged build boots from an unrelated working directory with a live bridge.');
});
