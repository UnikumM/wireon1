/**
 * Build smoke check — proves the packaged artefacts are the ones the app can
 * actually boot from, without launching Electron.
 *
 * Every check here corresponds to a bug that shipped a silently broken build:
 * an ESM preload that never loads (so `window.electronAPI` is undefined and the
 * frameless window has no close button), absolute asset URLs that 404 over
 * file:// (white screen), paths resolved from `process.cwd()` (which is the
 * shortcut's directory once packaged), a load failure with no window and no
 * error, and an icon electron-builder refuses.
 *
 * Offline and read-only. Run it after `npm run electron:build`:
 *
 *     npm run smoke:build
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const notes = [];

/** Records a check. `detail` is printed either way, so a pass is auditable too. */
function check(label, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function note(message) {
  notes.push(message);
  console.log(`      ${message}`);
}

function read(relative) {
  const absolute = path.join(ROOT, relative);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute, 'utf-8');
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

// ---------------------------------------------------------------------------
section('Artefacts exist');
// ---------------------------------------------------------------------------

const REQUIRED = [
  'dist/index.html',
  'dist-electron/main.js',
  'dist-electron/preload.cjs',
  'build/icon.png'
];

for (const relative of REQUIRED) {
  const absolute = path.join(ROOT, relative);
  const ok = existsSync(absolute);
  check(relative, ok, ok ? `${statSync(absolute).size} bytes` : 'missing — run npm run electron:build');
}

const mainJs = read('dist-electron/main.js');
const preloadCjs = read('dist-electron/preload.cjs');
const indexHtml = read('dist/index.html');
const pkg = JSON.parse(read('package.json'));

if (!mainJs || !preloadCjs || !indexHtml) {
  console.error('\nNothing further can be checked without the build output.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
section('B1 — the preload script can load at all');
// ---------------------------------------------------------------------------

check('preload is CommonJS (has require)', preloadCjs.includes('require('));

const esmLines = preloadCjs
  .split(/\r?\n/)
  .map((line, i) => [i + 1, line])
  .filter(([, line]) => /^\s*(import\s.+\sfrom\s|export\s(const|function|class|default|\{))/.test(line));
check(
  'preload has no top-level ESM syntax',
  esmLines.length === 0,
  esmLines.length ? `line ${esmLines[0][0]}: ${esmLines[0][1].trim()}` : 'require-only'
);

check('main.js points the preload at the .cjs file', /preload\.cjs/.test(mainJs));

// A sandboxed renderer gives the preload a stub `require` that resolves only
// electron and a handful of node built-ins. That is fine — and safer than
// turning the sandbox off — as long as the preload asks for nothing else.
const SANDBOX_SAFE = new Set(['electron', 'events', 'timers', 'url', 'buffer', 'process']);
const required = [...preloadCjs.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
const unsafeRequires = required.filter((id) => !SANDBOX_SAFE.has(id));
const sandboxDisabled = /sandbox:\s*false/.test(mainJs);
check(
  'the preload can run under the renderer sandbox',
  unsafeRequires.length === 0 || sandboxDisabled,
  unsafeRequires.length === 0
    ? `requires only ${required.join(', ') || 'nothing'}`
    : `requires ${unsafeRequires.join(', ')} and sandbox is not disabled`
);

check('contextIsolation stays on', /contextIsolation:\s*true/.test(mainJs));
check('nodeIntegration stays off', !/nodeIntegration:\s*true/.test(mainJs));
check('bridge is exposed over contextBridge', preloadCjs.includes('exposeInMainWorld'));

// ---------------------------------------------------------------------------
section('B1 — preload and main agree on every channel');
// ---------------------------------------------------------------------------

/**
 * Channel names passed to a set of ipc functions.
 *
 * Both spellings that occur in this codebase are understood: a literal at the
 * call site, and a named constant (`ipc.handle(UPDATE_CHECK_CHANNEL, ...)`) —
 * the services that own a group of channels declare them once and export them.
 */
function channels(source, functions, constants = new Map()) {
  const found = new Set();
  for (const fn of functions) {
    const pattern = new RegExp(
      `${fn}\\(\\s*(?:['"\`]([a-zA-Z0-9:_-]+)['"\`]|([A-Za-z0-9_$]+))`,
      'g'
    );
    for (const match of source.matchAll(pattern)) {
      const channel = match[1] ?? constants.get(match[2]);
      if (channel) found.add(channel);
    }
  }
  return found;
}

/** `const UPDATE_STATE_CHANNEL = 'update:state'` — resolvable by name. */
function channelConstants(source) {
  const map = new Map();
  const pattern = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*['"`]([a-zA-Z0-9:_-]+)['"`]/g;
  for (const match of source.matchAll(pattern)) map.set(match[1], match[2]);
  return map;
}

// The main process is several modules, not just main.js: channels registered by
// a service (updates, the mini window) would look unhandled if only the entry
// file were read, and a missing handler would slip through unnoticed.
const mainSources = readdirSync(path.join(ROOT, 'dist-electron'))
  .filter((file) => file.endsWith('.js'))
  .map((file) => read(`dist-electron/${file}`) ?? '')
  .join('\n');
const mainConstants = channelConstants(mainSources);

// The handlers are registered on an injected `ipc` object (so a test can pass a
// fake), which is why both spellings are accepted here.
const handled = channels(
  mainSources,
  ['ipcMain\\.handle', 'ipcMain\\.on', 'ipc\\.handle', 'ipc\\.on'],
  mainConstants
);
const invoked = channels(preloadCjs, ['ipcRenderer\\.invoke', 'ipcRenderer\\.send']);
const sentToRenderer = channels(
  mainSources,
  ['webContents\\.send', 'win\\.webContents\\.send', 'send'],
  mainConstants
);
const listened = channels(preloadCjs, ['ipcRenderer\\.on', 'ipcRenderer\\.once']);

const orphanCalls = [...invoked].filter((c) => !handled.has(c));
check(
  'every channel the bridge calls is handled in main',
  orphanCalls.length === 0,
  orphanCalls.length ? `unhandled: ${orphanCalls.join(', ')}` : `${invoked.size} channels`
);

const orphanListeners = [...listened].filter((c) => !sentToRenderer.has(c));
check(
  'every channel the bridge listens on is sent by main',
  orphanListeners.length === 0,
  orphanListeners.length ? `never sent: ${orphanListeners.join(', ')}` : `${listened.size} channels`
);

const unusedHandlers = [...handled].filter((c) => !invoked.has(c));
if (unusedHandlers.length) note(`main handles channels the bridge never calls: ${unusedHandlers.join(', ')}`);

// ---------------------------------------------------------------------------
section('B2 — the renderer loads over file://');
// ---------------------------------------------------------------------------

const absoluteRefs = [...indexHtml.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1]);
check(
  'index.html has no absolute asset URLs',
  absoluteRefs.length === 0,
  absoluteRefs.length ? absoluteRefs.join(', ') : 'all relative'
);

const assetRefs = [...indexHtml.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
check('index.html references at least one bundled asset', assetRefs.length > 0, assetRefs.join(', '));

const missingAssets = assetRefs.filter((ref) => !existsSync(path.join(ROOT, 'dist', ref)));
check(
  'every referenced asset is present in dist/',
  missingAssets.length === 0,
  missingAssets.length ? `missing: ${missingAssets.join(', ')}` : `${assetRefs.length} files`
);

check(
  'no runtime font CDN in the packaged page',
  !/fonts\.(googleapis|gstatic)\.com/.test(indexHtml),
  'offline installs would silently lose their typeface'
);

check('main.js loads the bundle with loadFile', /loadFile\(/.test(mainJs));

// ---------------------------------------------------------------------------
section('B3 — paths do not depend on the launch directory');
// ---------------------------------------------------------------------------

// A last-resort `return process.cwd()` inside the app-directory helper is fine;
// what broke the packaged build was *building paths* from the launch directory.
const cwdPaths = mainJs
  .split(/\r?\n/)
  .filter((line) => /(?:join|resolve|dirname)\([^)]*process\.cwd\(\)/.test(line));
check(
  'main.js builds no path from process.cwd()',
  cwdPaths.length === 0,
  cwdPaths.length ? cwdPaths[0].trim() : 'app directory only'
);
check(
  'main.js resolves paths from its own location',
  /getAppDir|__dirname|import\.meta\.url|getAppPath/.test(mainJs)
);
check(
  'the preload path is built from the app directory',
  /getAppDir\(\)|__dirname/.test(mainJs) && /preload\.cjs/.test(mainJs)
);

// ---------------------------------------------------------------------------
section('B4 — a failed boot is visible and only one copy runs');
// ---------------------------------------------------------------------------

check('a did-fail-load handler exists', /did-fail-load/.test(mainJs));
check('the window is shown on ready-to-show', /ready-to-show/.test(mainJs));
check('a second instance cannot start', /requestSingleInstanceLock/.test(mainJs));
check('a second launch is handed to the first', /second-instance/.test(mainJs));
check('render-process crashes are reported', /render-process-gone|unresponsive/.test(mainJs));

// ---------------------------------------------------------------------------
section('B5 — electron-builder can package this');
// ---------------------------------------------------------------------------

const builder = JSON.parse(read('electron-builder.json') ?? '{}');
const winIcon = builder.win?.icon ?? '';
check(
  'the Windows icon is a raster format',
  /\.(ico|png)$/i.test(winIcon),
  winIcon || 'not set — SVG is rejected by the Windows target'
);
check('the Windows icon file exists', Boolean(winIcon) && existsSync(path.join(ROOT, winIcon)), winIcon);

if (winIcon.endsWith('.png') && existsSync(path.join(ROOT, winIcon))) {
  // PNG header: width and height are big-endian uint32 at bytes 16 and 20.
  const header = readFileSync(path.join(ROOT, winIcon)).subarray(0, 24);
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  check('the icon is at least 256×256', width >= 256 && height >= 256, `${width}×${height}`);
}

const buildResources = builder.directories?.buildResources ?? 'build';
check(
  `buildResources directory "${buildResources}" exists`,
  existsSync(path.join(ROOT, buildResources))
);

const nsisName = builder.nsis?.artifactName;
const portableName = builder.portable?.artifactName;
const targets = (builder.win?.target ?? []).map((t) => (typeof t === 'string' ? t : t.target));
if (targets.includes('nsis') && targets.includes('portable')) {
  check(
    'the installer and portable builds write different filenames',
    Boolean(nsisName) && Boolean(portableName) && nsisName !== portableName,
    `${nsisName ?? '<default>'} vs ${portableName ?? '<default>'}`
  );
}

// Linux ships as an AppImage: it is the only Linux format electron-updater can
// update in place, and the .desktop entry it generates is what makes `wireon://`
// (the Discord sign-in comes back through it) reach the app at all.
const linuxTargets = (builder.linux?.target ?? []).map((t) => (typeof t === 'string' ? t : t.target));
if (linuxTargets.length > 0) {
  check(
    'the Linux target is AppImage — the only one that self-updates',
    linuxTargets.includes('AppImage'),
    linuxTargets.join(', ')
  );

  const linuxIcon = builder.linux?.icon ?? '';
  check(
    'the Linux icon file exists',
    Boolean(linuxIcon) && existsSync(path.join(ROOT, linuxIcon)),
    linuxIcon || 'not set — the desktop entry would have no icon'
  );

  check(
    'the Linux build declares a menu category',
    Boolean(builder.linux?.category),
    builder.linux?.category ?? 'not set — the app lands nowhere in the menu'
  );

  const appImageName = builder.appImage?.artifactName;
  check(
    'the AppImage writes a filename of its own',
    Boolean(appImageName) && appImageName !== nsisName && appImageName !== portableName,
    appImageName ?? '<default>'
  );

  check(
    'the deep-link scheme is declared, so the desktop entry gets a MimeType',
    (builder.protocols ?? []).some((entry) => (entry.schemes ?? []).includes('wireon')),
    (builder.protocols ?? []).flatMap((entry) => entry.schemes ?? []).join(', ') || 'none'
  );
}

check(
  'package.json main points at the built entry',
  Boolean(pkg.main) && existsSync(path.join(ROOT, pkg.main)),
  pkg.main
);
for (const glob of ['dist/**/*', 'dist-electron/**/*', 'package.json']) {
  check(`electron-builder ships ${glob}`, (builder.files ?? []).includes(glob));
}

// ---------------------------------------------------------------------------
section('M22 — a content security policy is installed');
// ---------------------------------------------------------------------------

check('main.js sets a CSP on its own pages', /Content-Security-Policy/i.test(mainJs));
check("the CSP has a default-src", /default-src/.test(mainJs));
check("the CSP forbids plugins (object-src 'none')", /object-src 'none'/.test(mainJs));
check('the CSP is applied per-session, not globally', /onHeadersReceived/.test(mainJs));

// ---------------------------------------------------------------------------

console.log('');
if (failures.length) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`All build checks passed${notes.length ? ` (${notes.length} note(s) above)` : ''}.`);
