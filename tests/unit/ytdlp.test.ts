/**
 * Runtime yt-dlp updates (`electron/ytdlp.ts`).
 *
 * This module exists because of a bug the user hit in a shipped build: about half
 * the YouTube tracks refused to play with «этот аудиоформат здесь не
 * воспроизводится», and the cause was the extractor bundled into the installer
 * being a few weeks old — YouTube had started handing it URLs that need a
 * proof-of-origin token, and those answer 403 the moment the media element asks
 * for the file. A newer yt-dlp extracts URLs that play, so the binary has to be
 * able to move without waiting for an app release.
 *
 * What is asserted here is everything that can go wrong quietly: a half-written
 * binary landing on the working path, a downloaded file that cannot run, an
 * unchanged version costing an 18 MB download, and any failure at all reaching
 * the main process as an exception. Every dependency is injected, so no test
 * touches GitHub or a child process; the disk is a throwaway temp directory.
 *
 * On Windows and Linux the nightly arrives as a zip with a one-folder build
 * (it starts about twice as fast as the one-file build), so the download in
 * these tests is a real zip archive built by `makeZip`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { deflateRawSync } from 'zlib';

import {
  YtDlpManager,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  RETRY_DELAY_MS,
  getNightlyAssetName,
  getNightlyLayout,
  parseTagFromLocation
} from '../../electron/ytdlp';
import { extractZip } from '../../electron/unzip';

const NOW = 1_700_000_000_000;
const TAG = '2026.08.18.122307';
const BUNDLED = path.join('C:', 'app', 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');

/** A payload big enough to pass the size floor. */
const BINARY_BYTES = new Uint8Array(2 * 1024 * 1024).fill(7);

/**
 * A minimal zip writer — just enough of the format for `extractZip`.
 *
 * CRCs are left at zero: the archive as a whole is checked by SHA-256 before
 * it is unpacked, so the extractor does not read them.
 */
function makeZip(
  entries: Record<string, Uint8Array | string>,
  options: { deflate?: boolean; unixMode?: number } = {}
): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const raw = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    const isDir = name.endsWith('/');
    const method = options.deflate && !isDir ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(options.unixMode ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(options.unixMode && !isDir ? (options.unixMode << 16) >>> 0 : 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

/** What `yt-dlp_win.zip` looks like: the exe plus its `_internal` folder. */
const WIN_ZIP = makeZip({
  '_internal/': '',
  '_internal/python3.dll': 'python',
  'yt-dlp.exe': BINARY_BYTES
});

/** Where a folder build of `tag` lands inside `<stateDir>/bin`. */
function folderExe(stateDir: string, tag = TAG): string {
  return path.join(stateDir, 'bin', `yt-dlp-${tag}`, 'yt-dlp.exe');
}

/** An installed folder build plus its marker, as a previous run left them. */
function seedInstalled(stateDir: string, state: { tag: string; installedAt: number; checkedAt: number }): void {
  const exe = folderExe(stateDir, state.tag);
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, 'existing');
  writeFileSync(
    path.join(stateDir, 'bin', 'yt-dlp.json'),
    JSON.stringify({ ...state, version: state.tag, folder: `yt-dlp-${state.tag}` })
  );
}

/** Совпадающая пара «сумма из релиза» и «сумма скачанного» для тестов. */
const FAKE_HASH = 'a'.repeat(64);

/** The redirect GitHub answers `latest/download/...` with. */
function tagResponse(tag = TAG, status = 302): Response {
  return {
    status,
    url: `https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe`,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'location'
          ? `https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/${tag}/yt-dlp.exe`
          : null
    },
    body: null
  } as unknown as Response;
}

function downloadResponse(bytes: Uint8Array = WIN_ZIP, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    body: null
  } as unknown as Response;
}

/** Список контрольных сумм релиза — его модуль просит после загрузки. */
function sumsResponse(hash = FAKE_HASH, asset = 'yt-dlp_win.zip', ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => `${hash}  ${asset}
0000000000000000000000000000000000000000000000000000000000000000  yt-dlp
`,
    body: null
  } as unknown as Response;
}

/** A fetch that answers the tag lookup, then the download, then the checksums. */
function fetchSequence(...responses: Response[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return next;
  }) as unknown as typeof fetch;
}

interface Harness {
  manager: YtDlpManager;
  managed: string;
  logs: string[];
  fetchImpl: ReturnType<typeof vi.fn>;
  probeVersion: ReturnType<typeof vi.fn>;
}

describe('electron/ytdlp', () => {
  let stateDir: string;

  const build = (options: {
    responses?: Response[];
    version?: string;
    probe?: () => Promise<string>;
    now?: () => number;
    platform?: string;
    stateDir?: string | null;
    sha256?: (bytes: Uint8Array) => string;
  } = {}): Harness => {
    const logs: string[] = [];
    const fetchImpl = fetchSequence(...(options.responses ?? [tagResponse(), downloadResponse(), sumsResponse()]));
    const probeVersion = vi.fn(options.probe ?? (async () => options.version ?? TAG));
    const manager = new YtDlpManager({
      bundledPath: BUNDLED,
      stateDir: options.stateDir === undefined ? stateDir : options.stateDir,
      platform: options.platform ?? 'win32',
      fetchImpl,
      now: options.now ?? (() => NOW),
      log: (message) => logs.push(message),
      sha256: options.sha256 ?? (() => FAKE_HASH),
      probeVersion
    });
    return {
      manager,
      managed: folderExe(stateDir),
      logs,
      fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
      probeVersion: probeVersion as unknown as ReturnType<typeof vi.fn>
    };
  };

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'wireon-ytdlp-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ==========================================================================
  // Helpers
  // ==========================================================================
  describe('asset names and tags', () => {
    it('asks for the artefact the platform can actually run', () => {
      // Папкой: однофайловая сборка распаковывает Python на каждый запуск.
      expect(getNightlyLayout('win32')).toEqual({ asset: 'yt-dlp_win.zip', exe: 'yt-dlp.exe', folder: true });
      // Не `yt-dlp`: тот ассет — питоновский zipapp, а внутри AppImage питона нет.
      expect(getNightlyLayout('linux')).toEqual({ asset: 'yt-dlp_linux.zip', exe: 'yt-dlp_linux', folder: true });
      expect(getNightlyAssetName('darwin')).toBe('yt-dlp_macos');
    });

    it('reads the version out of the release redirect', () => {
      expect(
        parseTagFromLocation(
          'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/2026.08.18.122307/yt-dlp.exe'
        )
      ).toBe('2026.08.18.122307');
      expect(parseTagFromLocation('https://github.com/whatever')).toBeNull();
      expect(parseTagFromLocation('')).toBeNull();
    });
  });

  // ==========================================================================
  // Unpacking the folder build
  // ==========================================================================
  describe('extractZip', () => {
    it('unpacks stored and deflated entries and keeps the Linux exec bit', () => {
      const dest = path.join(stateDir, 'out');
      const entries = extractZip(
        makeZip({ '_internal/': '', '_internal/lib.so': 'lib', 'yt-dlp_linux': 'elf' }, { deflate: true, unixMode: 0o755 }),
        dest
      );

      expect(readFileSync(path.join(dest, '_internal', 'lib.so'), 'utf-8')).toBe('lib');
      expect(readFileSync(path.join(dest, 'yt-dlp_linux'), 'utf-8')).toBe('elf');
      expect(entries.find((entry) => entry.name === 'yt-dlp_linux')?.mode).toBe(0o755);
    });

    it('refuses entries that climb out of the target folder', () => {
      const dest = path.join(stateDir, 'out');
      expect(() => extractZip(makeZip({ '../escaped.txt': 'x' }), dest)).toThrow(/за пределы/);
      expect(existsSync(path.join(stateDir, 'escaped.txt'))).toBe(false);
    });

    it('refuses bytes that are not a zip archive', () => {
      expect(() => extractZip(new Uint8Array(100), path.join(stateDir, 'out'))).toThrow(/не zip/);
      expect(() => extractZip(new Uint8Array(0), path.join(stateDir, 'out'))).toThrow(/не zip/);
    });

    it('refuses an archive cut off in the middle', () => {
      const whole = makeZip({ 'yt-dlp.exe': BINARY_BYTES });
      // Keep the table of contents, drop the file body it points at.
      const tail = whole.subarray(whole.byteLength - 100);
      const cut = new Uint8Array(1000 + tail.byteLength);
      cut.set(tail, 1000);
      expect(() => extractZip(cut, path.join(stateDir, 'out'))).toThrow();
    });
  });

  // ==========================================================================
  // Which binary is in use
  // ==========================================================================
  describe('getBinaryPath', () => {
    it('plays on the bundled binary until an update actually lands', () => {
      const { manager } = build();
      expect(manager.getBinaryPath()).toBe(BUNDLED);
      expect(manager.describe()).toEqual({ path: BUNDLED, source: 'bundled', version: null });
    });

    it('prefers the updated binary the moment it exists — no restart', async () => {
      const { manager, managed } = build();
      expect(manager.getBinaryPath()).toBe(BUNDLED);

      await manager.ensureCurrent();

      expect(existsSync(managed)).toBe(true);
      expect(manager.getBinaryPath()).toBe(managed);
      expect(manager.describe()).toEqual({ path: managed, source: 'managed', version: TAG });
    });

    it('has nowhere to put anything without a state directory', async () => {
      const { manager } = build({ stateDir: null });
      expect(manager.getManagedPath()).toBeNull();
      expect(manager.getBinaryPath()).toBe(BUNDLED);

      const result = await manager.ensureCurrent();
      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/папки для данных/);
    });
  });

  // ==========================================================================
  // Installing
  // ==========================================================================
  describe('ensureCurrent', () => {
    it('downloads the nightly, checks it runs, and records what it installed', async () => {
      const { manager, managed, fetchImpl, probeVersion, logs } = build({ version: TAG });

      const result = await manager.ensureCurrent();

      expect(result).toEqual({ updated: true, tag: TAG, reason: `обновлён до ${TAG}` });
      expect(readFileSync(managed).byteLength).toBe(BINARY_BYTES.byteLength);
      // The whole folder came along — the exe does not start without it.
      expect(readFileSync(path.join(path.dirname(managed), '_internal', 'python3.dll'), 'utf-8')).toBe('python');
      // The `.part` folder must not survive: a stray one confuses the next run.
      expect(existsSync(`${path.dirname(managed)}.part`)).toBe(false);
      // Verified before it was promoted, not after.
      expect(probeVersion).toHaveBeenCalledWith(path.join(`${path.dirname(managed)}.part`, 'yt-dlp.exe'));

      const state = JSON.parse(readFileSync(path.join(stateDir, 'bin', 'yt-dlp.json'), 'utf-8'));
      expect(state).toEqual({
        tag: TAG,
        version: TAG,
        installedAt: NOW,
        checkedAt: NOW,
        folder: `yt-dlp-${TAG}`
      });

      const [tagUrl] = fetchImpl.mock.calls[0];
      const [downloadUrl] = fetchImpl.mock.calls[1];
      expect(String(tagUrl)).toContain('yt-dlp-nightly-builds/releases/latest/download/yt-dlp_win.zip');
      expect(String(downloadUrl)).toContain(`/releases/download/${TAG}/yt-dlp_win.zip`);
      expect(logs.join(' ')).toContain(`обновлён до ${TAG}`);
    });

    it('never overwrites the working binary with a file that cannot run', async () => {
      const { manager, managed, logs } = build({
        probe: async () => {
          throw new Error('spawn EACCES');
        }
      });

      const result = await manager.ensureCurrent();

      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/не запускается/);
      expect(existsSync(managed)).toBe(false);
      expect(existsSync(`${path.dirname(managed)}.part`)).toBe(false);
      expect(manager.getBinaryPath()).toBe(BUNDLED);
      expect(logs.join(' ')).toMatch(/не удалось/);
    });

    it('rejects a file that answers --version with anything but a version', async () => {
      const { manager, managed } = build({ version: '<!DOCTYPE html>' });

      const result = await manager.ensureCurrent();

      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/не версией/);
      expect(existsSync(managed)).toBe(false);
    });

    it('rejects a truncated download instead of installing half a binary', async () => {
      const { manager, managed } = build({
        responses: [tagResponse(), downloadResponse(new Uint8Array(4096))]
      });

      const result = await manager.ensureCurrent();

      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/маленький файл/);
      expect(existsSync(managed)).toBe(false);
    });

    it('gives up quietly when GitHub does not answer', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND github.com')) as unknown as typeof fetch;
      const manager = new YtDlpManager({
        bundledPath: BUNDLED,
        stateDir,
        platform: 'win32',
        fetchImpl,
        now: () => NOW,
        log: () => {},
        probeVersion: vi.fn()
      });

      const result = await manager.ensureCurrent();

      expect(result).toEqual({ updated: false, tag: null, reason: 'ENOTFOUND github.com' });
      expect(manager.getBinaryPath()).toBe(BUNDLED);
    });

    it('reports a release that carries no version instead of guessing one', async () => {
      const noLocation = { status: 200, url: 'https://github.com/', headers: { get: () => null }, body: null };
      const { manager } = build({ responses: [noLocation as unknown as Response] });

      const result = await manager.ensureCurrent();
      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/без ссылки на релиз/);
    });

    it('turns a rejected download into a reason, not a crashed main process', async () => {
      const { manager, managed } = build({
        responses: [tagResponse(), downloadResponse(BINARY_BYTES, false, 503)]
      });

      const result = await manager.ensureCurrent();
      expect(result).toMatchObject({ updated: false, reason: 'HTTP 503' });
      expect(existsSync(managed)).toBe(false);
    });

    it('не ставит файл, у которого не сошлась контрольная сумма', async () => {
      const { manager, managed, logs } = build({ sha256: () => 'b'.repeat(64) });

      const result = await manager.ensureCurrent();

      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/контрольная сумма/i);
      // Ни на рабочем пути, ни во временном: подменённый файл не запускался.
      expect(existsSync(managed)).toBe(false);
      expect(existsSync(`${path.dirname(managed)}.part`)).toBe(false);
      expect(logs.join(' ')).toMatch(/контрольная сумма/i);
    });

    it('не ставит ничего, когда списка сумм в релизе нет', async () => {
      const { manager, managed } = build({
        responses: [tagResponse(), downloadResponse(), sumsResponse(FAKE_HASH, 'yt-dlp.exe', false, 404)]
      });

      const result = await manager.ensureCurrent();

      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/контрольных сумм/i);
      expect(existsSync(managed)).toBe(false);
    });

    it('не ставит ничего, когда в списке нет строки про наш файл', async () => {
      const { manager, managed } = build({
        responses: [tagResponse(), downloadResponse(), sumsResponse(FAKE_HASH, 'yt-dlp_linux.zip')]
      });

      const result = await manager.ensureCurrent();

      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/нет строки/i);
      expect(existsSync(managed)).toBe(false);
    });

    it('announces the update so the stream cache can be dropped', async () => {
      const onUpdated = vi.fn();
      const manager = new YtDlpManager({
        bundledPath: BUNDLED,
        stateDir,
        platform: 'win32',
        fetchImpl: fetchSequence(tagResponse(), downloadResponse(), sumsResponse()),
        now: () => NOW,
        log: () => {},
        sha256: () => FAKE_HASH,
        probeVersion: async () => TAG,
        onUpdated
      });

      // Ссылки, выданные прежним извлекателем, — как раз те, что не играют.
      expect((await manager.ensureCurrent()).updated).toBe(true);
      expect(onUpdated).toHaveBeenCalledWith(TAG);
    });

    it('keeps the update even when dropping the cache throws', async () => {
      const manager = new YtDlpManager({
        bundledPath: BUNDLED,
        stateDir,
        platform: 'win32',
        fetchImpl: fetchSequence(tagResponse(), downloadResponse(), sumsResponse()),
        now: () => NOW,
        log: () => {},
        sha256: () => FAKE_HASH,
        probeVersion: async () => TAG,
        onUpdated: () => {
          throw new Error('EPERM');
        }
      });

      expect((await manager.ensureCurrent()).updated).toBe(true);
      expect(manager.getBinaryPath()).toBe(folderExe(stateDir));
    });
  });

  // ==========================================================================
  // Not re-downloading
  // ==========================================================================
  describe('staying put', () => {
    it('does not spend 18 MB on a version it already has', async () => {
      seedInstalled(stateDir, { tag: TAG, installedAt: NOW - 1000, checkedAt: NOW - 1000 });

      const { manager, fetchImpl } = build({ responses: [tagResponse()], now: () => NOW + CHECK_INTERVAL_MS });

      const result = await manager.ensureCurrent();

      expect(result).toEqual({ updated: false, tag: TAG, reason: `уже ${TAG}` });
      // Only the cheap tag lookup ran.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // The check itself is recorded, or the next launch would ask again.
      const state = JSON.parse(readFileSync(path.join(stateDir, 'bin', 'yt-dlp.json'), 'utf-8'));
      expect(state.checkedAt).toBe(NOW + CHECK_INTERVAL_MS);
      expect(state.installedAt).toBe(NOW - 1000);
    });

    it('does not ask GitHub on every launch', async () => {
      seedInstalled(stateDir, { tag: TAG, installedAt: NOW, checkedAt: NOW });

      const { manager, fetchImpl } = build({ responses: [], now: () => NOW + 60_000 });

      expect(await manager.ensureCurrent()).toEqual({
        updated: false,
        tag: TAG,
        reason: 'проверяли недавно'
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('asks anyway when the user presses the button', async () => {
      seedInstalled(stateDir, { tag: '2026.01.01', installedAt: NOW, checkedAt: NOW });

      const { manager, managed, fetchImpl } = build({ now: () => NOW + 60_000 });

      const result = await manager.ensureCurrent({ force: true });
      expect(result.updated).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(manager.getBinaryPath()).toBe(managed);
      // The old folder stays for now: an extraction may still be running from it.
      expect(existsSync(folderExe(stateDir, '2026.01.01'))).toBe(true);

      // The next launch clears it away.
      vi.useFakeTimers();
      const next = build({ responses: [], now: () => NOW + 60_000 }).manager;
      next.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 10);
      next.dispose();
      expect(readdirSync(path.join(stateDir, 'bin')).sort()).toEqual([`yt-dlp-${TAG}`, 'yt-dlp.json']);
    });

    it('moves a 2.2.5 single-file install to the folder build, even on the same tag', async () => {
      // What 2.2.5 left behind: `bin/yt-dlp.exe` and a marker without `folder`.
      mkdirSync(path.join(stateDir, 'bin'), { recursive: true });
      const legacy = path.join(stateDir, 'bin', 'yt-dlp.exe');
      writeFileSync(legacy, 'one-file build');
      writeFileSync(
        path.join(stateDir, 'bin', 'yt-dlp.json'),
        JSON.stringify({ tag: TAG, version: TAG, installedAt: NOW, checkedAt: NOW })
      );

      const { manager, managed, fetchImpl } = build({ now: () => NOW + 60_000 });
      // Until the folder lands, the old file still beats the bundled binary.
      expect(manager.getBinaryPath()).toBe(legacy);
      expect(manager.describe().source).toBe('managed');

      const result = await manager.ensureCurrent();

      expect(result.updated).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(manager.getBinaryPath()).toBe(managed);

      // The one-file build goes on the next launch, like any old version.
      vi.useFakeTimers();
      const next = build({ responses: [], now: () => NOW + 60_000 }).manager;
      next.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 10);
      next.dispose();
      expect(existsSync(legacy)).toBe(false);
      expect(next.getBinaryPath()).toBe(managed);
    });

    it('keeps macOS on the single-file build', async () => {
      const { manager } = build({
        platform: 'darwin',
        responses: [tagResponse(), downloadResponse(BINARY_BYTES), sumsResponse(FAKE_HASH, 'yt-dlp_macos')]
      });

      const result = await manager.ensureCurrent();

      expect(result.updated).toBe(true);
      expect(manager.getBinaryPath()).toBe(path.join(stateDir, 'bin', 'yt-dlp_macos'));
      expect(readFileSync(manager.getBinaryPath()).byteLength).toBe(BINARY_BYTES.byteLength);
    });

    it('does not install an archive without the exe in it', async () => {
      const { manager, managed, logs } = build({
        responses: [tagResponse(), downloadResponse(makeZip({ 'readme.txt': BINARY_BYTES })), sumsResponse()]
      });

      const result = await manager.ensureCurrent();

      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/нет yt-dlp\.exe/);
      expect(existsSync(path.dirname(managed))).toBe(false);
      expect(existsSync(`${path.dirname(managed)}.part`)).toBe(false);
      expect(logs.join('\n')).toMatch(/не удалось/);
    });

    it('does not install something that is not a zip at all', async () => {
      const { manager, managed } = build({
        responses: [tagResponse(), downloadResponse(BINARY_BYTES), sumsResponse()]
      });

      const result = await manager.ensureCurrent();

      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/архив не распаковался/);
      expect(existsSync(managed)).toBe(false);
    });

    it('re-downloads when the marker is there but the binary is gone', async () => {
      mkdirSync(path.join(stateDir, 'bin'), { recursive: true });
      writeFileSync(
        path.join(stateDir, 'bin', 'yt-dlp.json'),
        JSON.stringify({ tag: TAG, version: TAG, installedAt: NOW, checkedAt: NOW })
      );

      const { manager, managed, fetchImpl } = build({ now: () => NOW + 1000 });

      const result = await manager.ensureCurrent();
      expect(result.updated).toBe(true);
      expect(existsSync(managed)).toBe(true);
      // Тег, бинарник и список контрольных сумм.
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('treats a corrupted marker as "never updated"', async () => {
      mkdirSync(path.join(stateDir, 'bin'), { recursive: true });
      writeFileSync(path.join(stateDir, 'bin', 'yt-dlp.json'), '{ not json');

      const { manager } = build();
      expect(manager.readState()).toBeNull();
      expect((await manager.ensureCurrent()).updated).toBe(true);
    });

    it('collapses parallel callers onto one download', async () => {
      const { manager, fetchImpl } = build();

      const [a, b] = await Promise.all([manager.ensureCurrent(), manager.ensureCurrent()]);

      expect(a).toEqual(b);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
  });

  // ==========================================================================
  // Schedule
  // ==========================================================================
  describe('start', () => {
    it('checks shortly after launch, then twice a day', async () => {
      vi.useFakeTimers();
      const { manager, managed } = build();

      manager.start();
      expect(existsSync(managed)).toBe(false);

      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 10);
      expect(existsSync(managed)).toBe(true);

      manager.dispose();
    });

    it('retries once when the first attempt failed and nothing is installed yet', async () => {
      vi.useFakeTimers();
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new Error('ENETUNREACH'))
        .mockResolvedValueOnce(tagResponse())
        .mockResolvedValueOnce(downloadResponse())
        .mockResolvedValueOnce(sumsResponse()) as unknown as typeof fetch;
      const manager = new YtDlpManager({
        bundledPath: BUNDLED,
        stateDir,
        platform: 'win32',
        fetchImpl,
        now: () => NOW,
        log: () => {},
        sha256: () => FAKE_HASH,
        probeVersion: async () => TAG
      });

      manager.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 10);
      expect(manager.getBinaryPath()).toBe(BUNDLED);

      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 10);
      expect(manager.getBinaryPath()).toBe(folderExe(stateDir));

      manager.dispose();
    });

    it('stops asking once the app is quitting', async () => {
      vi.useFakeTimers();
      const { manager, fetchImpl } = build({ responses: [] });

      manager.start();
      manager.dispose();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('does nothing at all without a place to store the binary', () => {
      vi.useFakeTimers();
      const { manager, fetchImpl } = build({ stateDir: null, responses: [] });

      manager.start();
      vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);

      expect(fetchImpl).not.toHaveBeenCalled();
      manager.dispose();
    });
  });
});
