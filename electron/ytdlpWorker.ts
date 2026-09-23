/**
 * Постоянно работающий yt-dlp.
 *
 * Каждый трек с YouTube — это запуск yt-dlp, а запуск стоит дорого: поднять
 * Python, загрузить сотню модулей, поискать JS-движок. Замер на одном разборе
 * ссылки: больше половины времени уходит на запуск, а не на сеть. Здесь
 * процесс поднимается один раз и дальше разбирает ссылки по запросу — на
 * локальном тесте десять разборов заняли 1,7 с против 10 с по одному запуску.
 *
 * Своего Python для этого не нужно. Сборка yt-dlp умеет подключать плагины
 * (`--plugin-dirs`), а плагин — это код на Python, который исполняется внутри
 * той же сборки. Наш плагин, если его попросили переменной окружения,
 * превращает процесс в исполнителя: читает из stdin строки JSON с аргументами
 * командной строки и прогоняет каждую через `yt_dlp.main` — тот же вход, что у
 * обычного запуска, поэтому и флаги, и коды выхода, и тексты ошибок те же.
 *
 * Обычный запуск никуда не делся и остаётся запасным путём: исполнитель не
 * поднялся (старая сборка без `--plugin-dirs`, антивирус, что угодно) — модуль
 * возвращает `null`, и вызывающий запускает yt-dlp как раньше.
 *
 * Всё внешнее — запуск процесса и диск — инжектится ради тестов.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

/** Итог одного запроса — как у обычного запуска процесса. */
export interface YtDlpRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Плагин-исполнитель. Кладётся на диск при запуске (см. {@link ensureWorkerPlugin}):
 * внутри asar его yt-dlp не увидит.
 *
 * Ответы уходят в `sys.__stdout__` (JSON с `ensure_ascii`, то есть чистый ASCII —
 * кодировка консоли Windows его не испортит), а вывод самого yt-dlp на время
 * запроса перехватывается в память. Запросы идут строго по одному: перехват
 * вывода общий на весь процесс.
 */
export const WORKER_PLUGIN_SOURCE = `# Wireon: постоянный исполнитель yt-dlp. Файл пишет приложение, правки перезапишутся.
import io, json, os, sys, traceback
from contextlib import redirect_stderr, redirect_stdout

if os.environ.get('WIREON_YTDLP_WORKER') == '1' and not getattr(sys, '_wireon_worker', False):
    sys._wireon_worker = True

    def _capture():
        return io.TextIOWrapper(io.BytesIO(), encoding='utf-8', errors='replace', write_through=True)

    def _text(stream):
        stream.flush()
        return stream.buffer.getvalue().decode('utf-8', 'replace')

    def _serve():
        import yt_dlp
        channel = sys.__stdout__
        channel.write(json.dumps({'ready': True, 'version': yt_dlp.version.__version__}) + '\\n')
        channel.flush()
        for line in sys.__stdin__:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except ValueError:
                continue
            out, err = _capture(), _capture()
            code = 0
            with redirect_stdout(out), redirect_stderr(err):
                try:
                    yt_dlp.main([str(arg) for arg in request.get('argv', [])])
                except SystemExit as exit_:
                    code = exit_.code if isinstance(exit_.code, int) else (0 if exit_.code is None else 1)
                except BaseException:
                    code = 1
                    err.write(traceback.format_exc())
            channel.write(json.dumps({'id': request.get('id'), 'code': code, 'stdout': _text(out), 'stderr': _text(err)}) + '\\n')
            channel.flush()
        os._exit(0)

    _serve()
`;

/** Переменная, по которой плагин понимает, что его позвали исполнителем. */
export const WORKER_ENV = 'WIREON_YTDLP_WORKER';

/** Сколько ждать строки «готов». Первый запуск на Windows проверяет антивирус. */
export const START_TIMEOUT_MS = 20_000;
/** Потолок одного разбора. Дольше — процесс завис, его проще заменить. */
export const REQUEST_TIMEOUT_MS = 90_000;
/** Простаивающий исполнитель занимает ~60 МБ; через десять минут тишины уходит. */
export const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
/** После стольких неудачных запусков подряд для этого бинарника — только обычный путь. */
const MAX_START_FAILURES = 2;

export interface WorkerFsLike {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
}

/**
 * Кладёт плагин в `<stateDir>/ytdlp-plugins` и возвращает папку для
 * `--plugin-dirs`. Файл перезаписывается, только если текст изменился.
 * Не вышло — `null`: исполнитель просто не включится.
 */
export function ensureWorkerPlugin(
  stateDir: string | null | undefined,
  fs: WorkerFsLike = { existsSync, mkdirSync, readFileSync, writeFileSync }
): string | null {
  if (!stateDir) return null;
  const root = path.join(stateDir, 'ytdlp-plugins');
  const file = path.join(root, 'wireon', 'yt_dlp_plugins', 'extractor', 'wireon_worker.py');
  try {
    const current = fs.existsSync(file) ? String(fs.readFileSync(file, 'utf-8')) : null;
    if (current !== WORKER_PLUGIN_SOURCE) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, WORKER_PLUGIN_SOURCE, 'utf-8');
    }
    return root;
  } catch {
    return null;
  }
}

/**
 * JSON только из ASCII. Python читает stdin в кодировке системы, и на
 * русской Windows это cp1251: кириллица в пути к cookies пришла бы кашей.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

type SpawnFn = (command: string, args: string[], options: Record<string, unknown>) => ChildProcessWithoutNullStreams;

interface Pending {
  id: number;
  argv: string[];
  resolve: (result: YtDlpRunResult) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Один процесс-исполнитель со своей очередью. */
class Worker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Строка «готов» получена: до неё запросы копятся в очереди. */
  private ready = false;
  public dead = false;

  constructor(
    private readonly exe: string,
    private readonly pluginDir: string,
    private readonly spawnImpl: SpawnFn,
    private readonly log: (message: string) => void,
    private readonly timeouts: { start: number; request: number; idle: number },
    private readonly extraEnv: Record<string, string>
  ) {}

  public get load(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  /** Поднимает процесс и ждёт строки «готов». Бросает, если не дождались. */
  public start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        this.kill(reason);
        reject(new Error(reason));
      };
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnImpl(
          this.exe,
          // Последний аргумент — просто повод дойти до загрузки плагинов:
          // дальше разбора аргументов первый вызов не продвинется.
          ['--plugin-dirs', this.pluginDir, '--ignore-config', '--simulate', 'wireon:worker'],
          {
            env: { ...process.env, ...this.extraEnv, [WORKER_ENV]: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
          }
        );
      } catch (err) {
        fail(`не запустился: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.child = child;
      const startTimer = setTimeout(() => fail('не ответил «готов» вовремя'), this.timeouts.start);
      startTimer.unref?.();

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          newline = this.buffer.indexOf('\n');
          if (!line) continue;
          let message: { ready?: boolean; version?: string; id?: number; code?: number; stdout?: string; stderr?: string };
          try {
            message = JSON.parse(line);
          } catch {
            // Сторонний вывод до строки «готов» (чужой плагин, предупреждение) — не наш.
            continue;
          }
          if (message.ready && !settled) {
            settled = true;
            this.ready = true;
            clearTimeout(startTimer);
            this.log(`исполнитель готов (${message.version ?? '?'})`);
            resolve();
            this.pump();
            continue;
          }
          this.finish(message);
        }
      });
      // Поток ошибок процесса читаем, иначе заполненный канал его остановит.
      child.stderr.on('data', () => {});
      child.on('error', (err) => fail(`ошибка процесса: ${err.message}`));
      child.on('exit', (code) => {
        const reason = `исполнитель завершился (код ${code})`;
        if (!settled) fail(reason);
        else this.kill(reason);
      });
    });
    return this.readyPromise;
  }

  public run(argv: string[]): Promise<YtDlpRunResult> {
    return new Promise<YtDlpRunResult>((resolve, reject) => {
      if (this.dead) {
        reject(new Error('исполнитель остановлен'));
        return;
      }
      this.queue.push({ id: this.nextId++, argv, resolve, reject });
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      this.pump();
    });
  }

  private pump(): void {
    if (this.dead || !this.ready || this.active || !this.child || this.queue.length === 0) return;
    const next = this.queue.shift() as Pending;
    this.active = next;
    next.timer = setTimeout(() => {
      // Завис — заменяем процесс целиком: снять один запрос внутри Python нельзя.
      this.kill(`разбор дольше ${Math.round(this.timeouts.request / 1000)} с`);
    }, this.timeouts.request);
    next.timer.unref?.();
    try {
      this.child.stdin.write(`${asciiJson({ id: next.id, argv: next.argv })}\n`);
    } catch (err) {
      this.kill(`не удалось отправить запрос: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private finish(message: { id?: number; code?: number; stdout?: string; stderr?: string }): void {
    const active = this.active;
    if (!active || message.id !== active.id) return;
    clearTimeout(active.timer);
    this.active = null;
    active.resolve({
      code: typeof message.code === 'number' ? message.code : 1,
      stdout: String(message.stdout ?? ''),
      stderr: String(message.stderr ?? '')
    });
    if (this.load === 0) this.armIdle();
    this.pump();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill('простаивал'), this.timeouts.idle);
    this.idleTimer.unref?.();
  }

  public kill(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const error = new Error(`yt-dlp: ${reason}`);
    const waiting = [...(this.active ? [this.active] : []), ...this.queue.splice(0)];
    this.active = null;
    waiting.forEach((item) => {
      clearTimeout(item.timer);
      item.reject(error);
    });
    if (reason !== 'простаивал') this.log(`исполнитель остановлен: ${reason}`);
    try {
      this.child?.kill();
    } catch {
      // Уже завершился.
    }
    this.child = null;
  }
}

export interface YtDlpWorkerPoolDeps {
  /** Папка для `--plugin-dirs`; `null` — исполнитель выключен. */
  pluginDir: string | null;
  size?: number;
  spawn?: SpawnFn;
  log?: (message: string) => void;
  timeouts?: Partial<{ start: number; request: number; idle: number }>;
  /** Добавка к окружению исполнителя — например, чтобы Electron работал как Node. */
  env?: Record<string, string>;
}

/**
 * Несколько исполнителей для одного бинарника: пока один разбирает трек,
 * соседний может заранее разобрать следующий.
 */
export class YtDlpWorkerPool {
  private readonly pluginDir: string | null;
  private readonly size: number;
  private readonly spawnImpl: SpawnFn;
  private readonly log: (message: string) => void;
  private readonly timeouts: { start: number; request: number; idle: number };
  private readonly extraEnv: Record<string, string>;
  private exe: string | null = null;
  private workers: Worker[] = [];
  private readonly startFailures = new Map<string, number>();

  constructor(deps: YtDlpWorkerPoolDeps) {
    this.pluginDir = deps.pluginDir;
    this.size = Math.max(1, deps.size ?? 2);
    this.spawnImpl = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.log = deps.log ?? ((message) => console.log('[yt-dlp worker]', message));
    this.timeouts = {
      start: deps.timeouts?.start ?? START_TIMEOUT_MS,
      request: deps.timeouts?.request ?? REQUEST_TIMEOUT_MS,
      idle: deps.timeouts?.idle ?? IDLE_SHUTDOWN_MS
    };
    this.extraEnv = deps.env ?? {};
  }

  /** Для этого бинарника исполнитель уже дважды не поднялся — не мучаем. */
  public isDisabledFor(exe: string): boolean {
    return !this.pluginDir || (this.startFailures.get(exe) ?? 0) >= MAX_START_FAILURES;
  }

  /**
   * Прогоняет аргументы через исполнитель.
   *
   * `null` — исполнитель недоступен, и вызывающий должен запустить yt-dlp
   * обычным способом. Ошибка — запрос ушёл, но процесс умер или завис на нём:
   * повторять тот же запрос обычным путём тогда тоже разумно, и это решает
   * вызывающий.
   */
  public async run(exe: string, argv: string[]): Promise<YtDlpRunResult | null> {
    if (this.isDisabledFor(exe)) return null;
    // Бинарник обновился — прежние исполнители держат старый извлекатель.
    if (this.exe !== exe) {
      this.dispose();
      this.exe = exe;
    }
    this.workers = this.workers.filter((worker) => !worker.dead);
    let worker = this.workers.find((candidate) => candidate.load === 0);
    if (!worker && this.workers.length < this.size) {
      worker = new Worker(exe, this.pluginDir as string, this.spawnImpl, this.log, this.timeouts, this.extraEnv);
      this.workers.push(worker);
    }
    if (!worker) {
      worker = this.workers.reduce((best, candidate) => (candidate.load < best.load ? candidate : best));
    }

    // Запрос встаёт в очередь сразу, до ожидания запуска: иначе параллельные
    // вызовы видели бы нового исполнителя свободным и все сваливались в него.
    const started = worker.start();
    const result = worker.run(argv);
    try {
      await started;
      this.startFailures.delete(exe);
    } catch (err) {
      // Запрос уже отклонён вместе с процессом; вызывающий пойдёт обычным путём.
      result.catch(() => {});
      const failures = (this.startFailures.get(exe) ?? 0) + 1;
      this.startFailures.set(exe, failures);
      this.log(
        `исполнитель не поднялся (${err instanceof Error ? err.message : String(err)})` +
          (failures >= MAX_START_FAILURES ? ' — дальше запускаем yt-dlp как обычно' : '')
      );
      return null;
    }
    return result;
  }

  public dispose(): void {
    this.workers.forEach((worker) => worker.kill('остановлен приложением'));
    this.workers = [];
  }
}
