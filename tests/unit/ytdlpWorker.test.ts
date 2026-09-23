/**
 * Постоянный исполнитель yt-dlp (`electron/ytdlpWorker.ts`).
 *
 * Настоящий плагин проверен вручную на сборке yt-dlp «папкой»: десять разборов
 * за 1,7 с против 10 с по одному запуску. Здесь — то, что должно держаться без
 * сети и без Python: протокол, очередь, запасной путь и все способы умереть.
 * Процесс поддельный: EventEmitter с тремя потоками, который отвечает так же,
 * как плагин.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  YtDlpWorkerPool,
  ensureWorkerPlugin,
  asciiJson,
  WORKER_PLUGIN_SOURCE,
  WORKER_ENV
} from '../../electron/ytdlpWorker';
import { parseYtdlResult, jsRuntimeFlag, JS_RUNTIME_ENV } from '../../electron/main';

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  requests: Array<{ id: number; argv: string[] }>;
}

type Behaviour = (child: FakeChild, request: { id: number; argv: string[] }) => void;

/** Поддельный исполнитель: говорит «готов» и отвечает по `behaviour`. */
function fakeSpawn(options: { ready?: boolean; behaviour?: Behaviour } = {}) {
  const children: FakeChild[] = [];
  const calls: Array<{ exe: string; args: string[]; env: Record<string, string> }> = [];
  const spawn = vi.fn((exe: string, args: string[], opts: { env: Record<string, string> }) => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.requests = [];
    child.kill = vi.fn(() => {
      setImmediate(() => child.emit('exit', null));
      return true;
    });
    calls.push({ exe, args, env: opts.env });
    children.push(child);

    let pending = '';
    child.stdin.setEncoding('utf-8');
    child.stdin.on('data', (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const request = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
        child.requests.push(request);
        (options.behaviour ?? answer())(child, request);
      }
    });
    if (options.ready !== false) {
      setImmediate(() => child.stdout.write(`${JSON.stringify({ ready: true, version: '2026.09.16' })}\n`));
    }
    return child;
  });
  return { spawn, children, calls };
}

/** Ответ как у плагина: код, stdout и stderr. */
function answer(result: { code?: number; stdout?: string; stderr?: string } = {}): Behaviour {
  return (child, request) =>
    setImmediate(() =>
      child.stdout.write(
        `${JSON.stringify({ id: request.id, code: result.code ?? 0, stdout: result.stdout ?? '{"id":"x"}\n', stderr: result.stderr ?? '' })}\n`
      )
    );
}

const EXE = '/app/bin/yt-dlp-2026.09.16/yt-dlp_linux';

describe('electron/ytdlpWorker', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    vi.useRealTimers();
  });

  it('кладёт плагин туда, где его найдёт --plugin-dirs', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'wireon-worker-'));
    const root = ensureWorkerPlugin(dir);
    expect(root).toBe(path.join(dir, 'ytdlp-plugins'));
    const file = path.join(root as string, 'wireon', 'yt_dlp_plugins', 'extractor', 'wireon_worker.py');
    expect(readFileSync(file, 'utf-8')).toBe(WORKER_PLUGIN_SOURCE);
    // Плагин не должен ничего делать, если его не позвали исполнителем.
    expect(WORKER_PLUGIN_SOURCE).toContain(`os.environ.get('${WORKER_ENV}') == '1'`);
  });

  it('без папки данных исполнитель выключен, и вызывающий идёт обычным путём', async () => {
    expect(ensureWorkerPlugin(null)).toBeNull();
    const { spawn } = fakeSpawn();
    const pool = new YtDlpWorkerPool({ pluginDir: null, spawn: spawn as never });
    expect(await pool.run(EXE, ['--version'])).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('поднимает процесс один раз и гоняет через него запросы', async () => {
    const { spawn, calls, children } = fakeSpawn();
    const pool = new YtDlpWorkerPool({ pluginDir: '/plugins', size: 1, spawn: spawn as never, log: () => {} });

    const first = await pool.run(EXE, ['https://youtu.be/a', '--dump-single-json']);
    const second = await pool.run(EXE, ['https://youtu.be/b', '--dump-single-json']);

    expect(first).toEqual({ code: 0, stdout: '{"id":"x"}\n', stderr: '' });
    expect(second?.code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(calls[0].args).toEqual(['--plugin-dirs', '/plugins', '--ignore-config', '--simulate', 'wireon:worker']);
    expect(calls[0].env[WORKER_ENV]).toBe('1');
    expect(children[0].requests.map((r) => r.argv[0])).toEqual(['https://youtu.be/a', 'https://youtu.be/b']);
    pool.dispose();
  });

  it('параллельные запросы расходятся по исполнителям, а не ждут друг друга', async () => {
    const { spawn } = fakeSpawn();
    const pool = new YtDlpWorkerPool({ pluginDir: '/plugins', size: 2, spawn: spawn as never, log: () => {} });
    const results = await Promise.all([1, 2, 3, 4].map((n) => pool.run(EXE, [`https://youtu.be/${n}`])));
    expect(results.every((r) => r?.code === 0)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    pool.dispose();
  });

  it('новый бинарник — новые исполнители: старые держат прежний извлекатель', async () => {
    const { spawn, children } = fakeSpawn();
    const pool = new YtDlpWorkerPool({ pluginDir: '/plugins', size: 1, spawn: spawn as never, log: () => {} });
    await pool.run(EXE, ['--version']);
    await pool.run('/app/bin/yt-dlp-2026.09.17/yt-dlp_linux', ['--version']);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children[0].kill).toHaveBeenCalled();
    pool.dispose();
  });

  it('не дождался «готов» — дважды, и дальше для этого бинарника только обычный путь', async () => {
    const { spawn } = fakeSpawn({ ready: false });
    const logs: string[] = [];
    const pool = new YtDlpWorkerPool({
      pluginDir: '/plugins',
      spawn: spawn as never,
      log: (m) => logs.push(m),
      timeouts: { start: 20 }
    });
    expect(await pool.run(EXE, ['--version'])).toBeNull();
    expect(await pool.run(EXE, ['--version'])).toBeNull();
    expect(pool.isDisabledFor(EXE)).toBe(true);
    expect(await pool.run(EXE, ['--version'])).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(logs.join('\n')).toMatch(/как обычно/);
  });

  it('завис на запросе — процесс заменяется, запрос отклоняется, следующий идёт в новый', async () => {
    let hang = true;
    const { spawn, children } = fakeSpawn({
      behaviour: (child, request) => {
        if (hang) return;
        answer()(child, request);
      }
    });
    const pool = new YtDlpWorkerPool({
      pluginDir: '/plugins',
      size: 1,
      spawn: spawn as never,
      log: () => {},
      timeouts: { request: 30 }
    });

    await expect(pool.run(EXE, ['https://youtu.be/stuck'])).rejects.toThrow(/дольше/);
    expect(children[0].kill).toHaveBeenCalled();

    hang = false;
    expect((await pool.run(EXE, ['https://youtu.be/next']))?.code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    pool.dispose();
  });

  it('упал посреди запроса — запрос отклоняется, а не висит вечно', async () => {
    const { spawn } = fakeSpawn({ behaviour: (child) => setImmediate(() => child.emit('exit', 3)) });
    const pool = new YtDlpWorkerPool({ pluginDir: '/plugins', size: 1, spawn: spawn as never, log: () => {} });
    await expect(pool.run(EXE, ['https://youtu.be/x'])).rejects.toThrow(/завершился/);
    pool.dispose();
  });

  it('чужие строки до «готов» не ломают протокол', async () => {
    const { spawn } = fakeSpawn({ ready: false });
    const pool = new YtDlpWorkerPool({ pluginDir: '/plugins', spawn: spawn as never, log: () => {} });
    const pending = pool.run(EXE, ['--version']);
    const child = spawn.mock.results[0].value as FakeChild;
    child.stdout.write('WARNING: какой-то чужой плагин\n');
    child.stdout.write(`${JSON.stringify({ ready: true })}\n`);
    expect((await pending)?.code).toBe(0);
    pool.dispose();
  });

  it('отправляет только ASCII: русская Windows читает stdin в cp1251', () => {
    const line = asciiJson({ argv: ['--cookies-from-browser', 'chrome:Профиль 1'] });
    expect(/^[\x00-\x7f]*$/.test(line)).toBe(true);
    expect(JSON.parse(line).argv[1]).toBe('chrome:Профиль 1');
  });

  it('даёт yt-dlp Node из самого Electron — задачки YouTube без отдельного движка', async () => {
    expect(jsRuntimeFlag('/opt/Wireon/wireon', { electron: '43.4.0' } as NodeJS.ProcessVersions)).toBe('node:/opt/Wireon/wireon');
    // Вне Electron (тесты, обычный Node) подставлять нечего.
    expect(jsRuntimeFlag('/usr/bin/node', {} as NodeJS.ProcessVersions)).toBeNull();

    const { spawn, calls } = fakeSpawn();
    const pool = new YtDlpWorkerPool({ pluginDir: '/plugins', spawn: spawn as never, log: () => {}, env: { ...JS_RUNTIME_ENV } });
    await pool.run(EXE, ['--version']);
    // Без этой переменной Electron запустился бы окном, а не как Node.
    expect(calls[0].env.ELECTRON_RUN_AS_NODE).toBe('1');
    pool.dispose();
  });

  it('ответ разбирается так же, как у youtube-dl-exec', () => {
    expect(parseYtdlResult({ code: 0, stdout: '{"id":"abc"}\n', stderr: '' })).toEqual({ id: 'abc' });
    expect(parseYtdlResult({ code: 0, stdout: '2026.09.16\n', stderr: '' })).toBe('2026.09.16');
    try {
      parseYtdlResult({ code: 1, stdout: 'null\n', stderr: "ERROR: Sign in to confirm you're not a bot\n" });
      throw new Error('should have thrown');
    } catch (err) {
      const error = err as Error & { stderr: string; exitCode: number };
      // По тексту ошибки резолвер узнаёт проверку «вы не робот» — он должен дойти целым.
      expect(error.message).toBe("ERROR: Sign in to confirm you're not a bot");
      expect(error.stderr).toBe(error.message);
      expect(error.exitCode).toBe(1);
    }
  });
});
