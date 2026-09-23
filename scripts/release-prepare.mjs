/**
 * Release preparation — bumps the version everywhere it is written down, then
 * proves the tree is releasable before anything reaches GitHub.
 *
 * The version lives in `package.json` (and its lockfile), `src/utils/appInfo.ts`
 * (the built renderer cannot read the manifest) and `android/app/build.gradle`
 * (the APK's versionName/versionCode), and every release so far has meant
 * editing them by hand. That is the step that silently does nothing
 * when forgotten: the installer builds, the release publishes, and no installed
 * copy sees an update because `latest.yml` still names the old version.
 *
 * Usage:
 *
 *     node scripts/release-prepare.mjs 1.0.3     # explicit version
 *     node scripts/release-prepare.mjs patch     # 1.0.2 -> 1.0.3
 *     node scripts/release-prepare.mjs minor     # 1.0.2 -> 1.1.0
 *     node scripts/release-prepare.mjs major     # 1.0.2 -> 2.0.0
 *     node scripts/release-prepare.mjs 1.0.3 --skip-verify
 *
 * It writes files but never touches git and never publishes: `npm run release`
 * stays a separate, deliberate step that needs GH_TOKEN in the environment.
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const APP_INFO = path.join(ROOT, 'src/utils/appInfo.ts');
const CHANGELOG = path.join(ROOT, 'src/data/changelog.ts');
const PACKAGE_LOCK = path.join(ROOT, 'package-lock.json');
const GRADLE = path.join(ROOT, 'android/app/build.gradle');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function currentVersion() {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  if (!SEMVER.test(manifest.version)) {
    fail(`package.json holds "${manifest.version}", which is not a plain x.y.z version.`);
  }
  return manifest.version;
}

function bump(version, kind) {
  const [, major, minor, patch] = version.match(SEMVER).map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Android's versionCode, derived from the version: 2.2.5 -> 2205.
 *
 * Android refuses to install an APK whose versionCode is not above the installed
 * one, and the phone updater compares versionName — so a forgotten versionCode
 * means an update that downloads and then will not install. The formula only
 * stays monotonic while minor < 10 and patch < 100; past that it would collide
 * with the next major, so we stop instead of guessing.
 */
function androidVersionCode(version) {
  const [, major, minor, patch] = version.match(SEMVER).map(Number);
  if (minor > 9 || patch > 99) {
    fail(
      `${version} does not fit versionCode = major*1000 + minor*100 + patch.\n` +
        '  Pick a new scheme in android/app/build.gradle and in scripts/release-prepare.mjs.'
    );
  }
  return major * 1000 + minor * 100 + patch;
}

/** Higher means newer. Guards against bumping downwards by accident. */
function isNewer(next, previous) {
  const a = next.match(SEMVER).slice(1).map(Number);
  const b = previous.match(SEMVER).slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

const args = process.argv.slice(2);
const skipVerify = args.includes('--skip-verify');
const target = args.find((arg) => !arg.startsWith('--'));

if (!target) {
  fail('Give a version or a bump: release-prepare.mjs <1.2.3|patch|minor|major> [--skip-verify]');
}

const from = currentVersion();
const to = ['major', 'minor', 'patch'].includes(target) ? bump(from, target) : target;

if (!SEMVER.test(to)) {
  fail(`"${to}" is not a plain x.y.z version. electron-updater compares these literally.`);
}
if (to === from) {
  fail(`Already at ${to}. An update needs a version people do not have yet.`);
}
if (!isNewer(to, from)) {
  // A lower version publishes fine and then nobody updates, because
  // electron-updater only moves forward. Easier to catch here than in the wild.
  fail(`${to} is older than the current ${from}. Updates only ever move forward.`);
}

// The in-app "what's new" sheet reads its list from the build, not from the
// GitHub release body, so a missing entry is invisible here and then shows up as
// an empty sheet on every machine that updates. Checked before anything is
// written, so a forgotten entry costs nothing to fix.
const changelogRaw = readFileSync(CHANGELOG, 'utf8');
if (!changelogRaw.includes(`version: '${to}'`)) {
  fail(
    `src/data/changelog.ts has no entry for ${to}.\n` +
      `  Add one at the top of CHANGELOG (newest first) — version, date, headline, items —\n` +
      `  otherwise everyone who updates to ${to} gets an empty "Что нового" screen.`
  );
}

console.log(`\nWireon release: ${from} -> ${to}\n`);

// --- write the version everywhere -------------------------------------------
//
// Every file is read and checked before any is written, so a file that does not
// look as expected stops the script with the tree untouched.

function replaceOrFail(raw, from, to, where) {
  const next = raw.replace(from, to);
  if (next === raw) fail(`Could not find ${from} in ${where}.`);
  return next;
}

const manifestNext = replaceOrFail(
  readFileSync(PACKAGE_JSON, 'utf8'),
  `"version": "${from}"`,
  `"version": "${to}"`,
  'package.json'
);

// The lockfile repeats the version twice: at the top and for the root package.
const lockRaw = readFileSync(PACKAGE_LOCK, 'utf8');
const lockHead = `"name": "wireon",\n  "version": "${from}"`;
const lockRoot = `"name": "wireon",\n      "version": "${from}"`;
const lockNext = replaceOrFail(
  replaceOrFail(lockRaw, lockHead, lockHead.replace(from, to), 'package-lock.json'),
  lockRoot,
  lockRoot.replace(from, to),
  'package-lock.json'
);

const appInfoNext = replaceOrFail(
  readFileSync(APP_INFO, 'utf8'),
  `APP_VERSION = '${from}'`,
  `APP_VERSION = '${to}'`,
  'src/utils/appInfo.ts'
);

const gradleRaw = readFileSync(GRADLE, 'utf8');
const codeMatch = gradleRaw.match(/versionCode (\d+)/);
if (!codeMatch) fail('Could not find versionCode in android/app/build.gradle.');
const codeFrom = Number(codeMatch[1]);
const codeTo = androidVersionCode(to);
if (codeTo <= codeFrom) {
  fail(`Android versionCode ${codeTo} for ${to} is not above the current ${codeFrom}; phones would refuse the APK.`);
}
const gradleNext = replaceOrFail(
  replaceOrFail(gradleRaw, `versionCode ${codeFrom}`, `versionCode ${codeTo}`, 'android/app/build.gradle'),
  `versionName "${from}"`,
  `versionName "${to}"`,
  'android/app/build.gradle'
);

writeFileSync(PACKAGE_JSON, manifestNext);
console.log(`  package.json              version -> ${to}`);
writeFileSync(PACKAGE_LOCK, lockNext);
console.log(`  package-lock.json         version -> ${to}`);
writeFileSync(APP_INFO, appInfoNext);
console.log(`  src/utils/appInfo.ts      APP_VERSION -> ${to}`);
writeFileSync(GRADLE, gradleNext);
console.log(`  android/app/build.gradle  versionName -> ${to}, versionCode -> ${codeTo}`);

// --- report where the release would land -------------------------------------

function releaseTarget() {
  const owner = process.env.WIREON_GH_OWNER;
  const repo = process.env.WIREON_GH_REPO;
  if (owner && repo) return `${owner}/${repo} (from WIREON_GH_OWNER/WIREON_GH_REPO)`;
  try {
    const url = execSync('git remote get-url origin', { cwd: ROOT, encoding: 'utf8' }).trim();
    const match = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
    return match ? `${match[1]}/${match[2]} (from git remote origin)` : `${url} (unrecognised host)`;
  } catch {
    return null;
  }
}

const targetRepo = releaseTarget();
console.log(`\n  release channel           ${targetRepo ?? 'NOT CONFIGURED — see RELEASE.md'}`);
console.log(`  GH_TOKEN                  ${process.env.GH_TOKEN ? 'present' : 'missing — needed to publish'}`);

// --- prove it builds ---------------------------------------------------------

if (skipVerify) {
  console.log('\n  verify                    skipped (--skip-verify)');
} else {
  console.log('\nRunning npm run verify (typecheck + tests + build + smoke, ~6-8 min)...\n');
  try {
    execSync('npm run verify', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    fail(
      'verify failed. The version bump is written to disk; fix the failure and re-run\n' +
        '  npm run verify\n  before publishing.'
    );
  }
}

console.log(`
Ready to publish ${to}. The remaining step needs a token, so it is yours:

  export GH_TOKEN=ghp_...        # never commit this
  npm run release

That builds the installer and uploads it with latest.yml and the .blockmap.
Installed copies pick it up within six hours, or immediately via
Settings -> About -> Check for updates.
`);
