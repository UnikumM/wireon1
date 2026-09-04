/**
 * Свежий yt-dlp во время работы приложения.
 *
 * YouTube меняет защиту чаще, чем выходят наши релизы. Бинарник, уехавший в
 * установщик месяц назад, для части видео отдаёт ссылки, требующие
 * proof-of-origin: ссылка выглядит нормальной, отвечает на короткий запрос —
 * и ровно в момент воспроизведения возвращает 403. Человек видит «этот
 * аудиоформат здесь не воспроизводится» на каждой второй песне, хотя формат
 * самый обычный m4a. Никакая ротация клиентов внутри старого извлекателя это
 * не лечит: нужен новый извлекатель.
 *
 * Поэтому yt-dlp обновляется отдельно от приложения — ночная сборка кладётся в
 * `userData/bin` и используется вместо вшитой, пока не появится новее. Канал
 * именно nightly: стабильные релизы yt-dlp выходят раз в месяц, а починки
 * YouTube попадают в ночные в тот же день.
 *
 * Чего здесь сознательно нет — ни одного `throw` наружу. Нет сети, GitHub
 * ответил пятисоткой, файл занят антивирусом: во всех случаях играем на вшитой
 * версии, как раньше, и пробуем снова позже.
 *
 * Всё, что модуль трогает — сеть, диск, запуск процесса — инжектится, поэтому
 * он тестируется без Electron, без GitHub и без настоящего бинарника.
 */

import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

/** Что лежит рядом с управляемым бинарником, чтобы знать его происхождение. */
export interface YtDlpState {
  /** Тег ночной сборки, например `2026.08.18.122307`. */
  tag: string;
  /** Что бинарник ответил на `--version`. */
  version: string;
  installedAt: number;
  /** Когда последний раз спрашивали GitHub. С `installedAt` не совпадает. */
  checkedAt: number;
}

/** Итог одной попытки обновления. Ошибка — это тоже итог, а не исключение. */
export interface YtDlpUpdateResult {
  updated: boolean;
  tag: string | null;
  reason: string;
}

/** Что приложение показывает в диагностике. */
export interface YtDlpInfo {
  path: string;
  source: 'bundled' | 'managed';
  version: string | null;
}

/** Часть `fs`, которая нужна модулю. Отдельным типом — ради подмены в тестах. */
export interface YtDlpFsLike {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  chmodSync: typeof chmodSync;
}

export interface YtDlpManagerDeps {
  /** Бинарник из установщика: и запас, и то, что играет до первого обновления. */
  bundledPath: string;
  /** userData; управляемый бинарник живёт в `<stateDir>/bin`. */
  stateDir?: string | null;
  platform?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  /** Запуск `--version`: единственная настоящая проверка, что файл рабочий. */
  probeVersion?: (exe: string) => Promise<string>;
  /**
   * Позвать после успешной установки.
   *
   * Нужно, чтобы сбросить кэш ссылок: их выдал прежний извлекатель, и как раз
   * они могут не играть. Иначе починка доедет только через несколько часов,
   * когда ссылки истекут сами.
   */
  onUpdated?: (tag: string) => void;
  fs?: Partial<YtDlpFsLike>;
}

/** Ночной канал yt-dlp: почти все починки YouTube приходят сюда в день поломки. */
export const NIGHTLY_REPO = 'https://github.com/yt-dlp/yt-dlp-nightly-builds';

/** Первая проверка почти сразу: человек может включить музыку через десять секунд. */
export const FIRST_CHECK_DELAY_MS = 4_000;

/** Дальше — дважды в сутки. Ночные сборки выходят раз в день. */
export const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Одна короткая пересборка, если первая попытка не удалась (сеть поднялась позже). */
export const RETRY_DELAY_MS = 10 * 60 * 1000;

const TAG_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Пол размера. Ловит не «не тот бинарник», а страницу ошибки GitHub и обрыв на
 * середине: настоящий exe — восемнадцать мегабайт, python-сборка — около трёх.
 */
const MIN_BINARY_BYTES = 1024 * 1024;

/** Имя ассета в релизе для текущей платформы. */
export function getNightlyAssetName(platform: string = process.platform): string {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp';
}

/**
 * Вытаскивает тег из адреса, куда GitHub перенаправляет `latest/download/...`.
 *
 * Так тег узнаётся одним дешёвым запросом — без него пришлось бы качать
 * восемнадцать мегабайт только чтобы выяснить, что версия та же самая.
 */
export function parseTagFromLocation(location: string): string | null {
  const match = /\/download\/([^/?#]+)\//.exec(location || '');
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** `--version` через дочерний процесс. Вынесено, чтобы тесты ничего не запускали. */
function defaultProbeVersion(exe: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, ['--version'], { timeout: 20_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

export class YtDlpManager {
  private readonly bundledPath: string;
  private readonly binDir: string | null;
  private readonly assetName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly logLine: (message: string) => void;
  private readonly probeVersion: (exe: string) => Promise<string>;
  private readonly onUpdated: (tag: string) => void;
  private readonly fs: YtDlpFsLike;

  private cachedState: YtDlpState | null = null;
  private stateRead = false;
  private pending: Promise<YtDlpUpdateResult> | null = null;
  private firstCheck: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: YtDlpManagerDeps) {
    this.bundledPath = deps.bundledPath;
    this.binDir = deps.stateDir ? path.join(deps.stateDir, 'bin') : null;
    this.assetName = getNightlyAssetName(deps.platform ?? process.platform);
    this.fetchImpl = deps.fetchImpl || ((globalThis as { fetch?: typeof fetch }).fetch as typeof fetch);
    this.now = deps.now || (() => Date.now());
    this.logLine = deps.log || ((message: string) => console.log('[yt-dlp]', message));
    this.probeVersion = deps.probeVersion || defaultProbeVersion;
    this.onUpdated = deps.onUpdated || (() => {});
    this.fs = {
      existsSync,
      mkdirSync,
      readFileSync,
      writeFileSync,
      renameSync,
      rmSync,
      chmodSync,
      ...(deps.fs || {})
    } as YtDlpFsLike;
  }

  /** Путь к управляемому бинарнику, даже если его ещё нет на диске. */
  public getManagedPath(): string | null {
    return this.binDir ? path.join(this.binDir, this.assetName) : null;
  }

  /**
   * Чем извлекать прямо сейчас: обновлённым, если он есть, иначе вшитым.
   *
   * Вызывается на каждом извлечении, поэтому здесь только `existsSync` —
   * подмена бинарника подхватывается сама, перезапуск приложения не нужен.
   */
  public getBinaryPath(): string {
    const managed = this.getManagedPath();
    if (managed && this.fs.existsSync(managed)) return managed;
    return this.bundledPath;
  }

  /** Для диагностики: что за бинарник в деле и какой он версии. */
  public describe(): YtDlpInfo {
    const active = this.getBinaryPath();
    const managed = this.getManagedPath();
    const isManaged = Boolean(managed && active === managed);
    return {
      path: active,
      source: isManaged ? 'managed' : 'bundled',
      version: isManaged ? this.readState()?.version ?? null : null
    };
  }

  /** Маркер рядом с бинарником: тег, версия, когда поставили и когда проверяли. */
  public readState(): YtDlpState | null {
    if (this.stateRead) return this.cachedState;
    this.stateRead = true;
    const file = this.getStateFile();
    if (!file || !this.fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(String(this.fs.readFileSync(file, 'utf-8'))) as Partial<YtDlpState>;
      if (parsed && typeof parsed.tag === 'string' && parsed.tag) {
        this.cachedState = {
          tag: parsed.tag,
          version: typeof parsed.version === 'string' ? parsed.version : parsed.tag,
          installedAt: Number(parsed.installedAt) || 0,
          checkedAt: Number(parsed.checkedAt) || 0
        };
      }
    } catch {
      // Битый маркер — считаем, что обновлений не было. Перезапишется сам.
    }
    return this.cachedState;
  }

  /**
   * Проверяет канал и, если вышло новее, ставит. Никогда не бросает.
   *
   * @param force игнорировать «недавно проверяли» — для кнопки в настройках.
   */
  public async ensureCurrent(options: { force?: boolean } = {}): Promise<YtDlpUpdateResult> {
    if (this.pending) return this.pending;
    this.pending = this.runUpdate(Boolean(options.force)).catch((err) => {
      // Страховка: сюда попадать нечему, но остаться без ответа хуже.
      const reason = err instanceof Error ? err.message : String(err);
      return { updated: false, tag: null, reason };
    });
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async runUpdate(force: boolean): Promise<YtDlpUpdateResult> {
    const managed = this.getManagedPath();
    if (!managed) {
      return { updated: false, tag: null, reason: 'нет папки для данных приложения' };
    }

    const state = this.readState();
    const haveBinary = this.fs.existsSync(managed);
    if (!force && state && haveBinary && this.now() - state.checkedAt < CHECK_INTERVAL_MS) {
      return { updated: false, tag: state.tag, reason: 'проверяли недавно' };
    }

    let tag: string;
    try {
      tag = await this.fetchLatestTag();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logLine(`не удалось узнать последнюю версию: ${reason}`);
      return { updated: false, tag: state?.tag ?? null, reason };
    }

    if (state && haveBinary && state.tag === tag) {
      this.writeState({ ...state, checkedAt: this.now() });
      return { updated: false, tag, reason: `уже ${tag}` };
    }

    try {
      const version = await this.install(tag, managed);
      this.logLine(`обновлён до ${tag} (${version})`);
      try {
        this.onUpdated(tag);
      } catch {
        // Обновление уже состоялось — уронить его из-за уборки нельзя.
      }
      return { updated: true, tag, reason: `обновлён до ${tag}` };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logLine(`обновление до ${tag} не удалось: ${reason}`);
      return { updated: false, tag: state?.tag ?? null, reason };
    }
  }

  /** Один дешёвый запрос за тегом: читаем, куда указывает `latest/download`. */
  private async fetchLatestTag(): Promise<string> {
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch недоступен');
    const latestUrl = `${NIGHTLY_REPO}/releases/latest/download/${this.assetName}`;
    const res = await this.fetchImpl(latestUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(TAG_TIMEOUT_MS)
    });
    await cancelBody(res);

    const location = res.headers?.get?.('location') || '';
    // Если редирект всё-таки прошли за нас, тег остался в итоговом адресе.
    const tag = parseTagFromLocation(location) || parseTagFromLocation(res.url || '');
    if (!tag) throw new Error(`GitHub ответил HTTP ${res.status} без ссылки на релиз`);
    return tag;
  }

  /**
   * Качает, проверяет и только потом ставит на место.
   *
   * Сначала во временный `.part`: половина файла по рабочему пути — это
   * приложение, которое не умеет играть вообще ничего.
   */
  private async install(tag: string, target: string): Promise<string> {
    const url = `${NIGHTLY_REPO}/releases/download/${encodeURIComponent(tag)}/${this.assetName}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < MIN_BINARY_BYTES) {
      throw new Error(`подозрительно маленький файл: ${bytes.byteLength} байт`);
    }

    const part = `${target}.part`;
    this.fs.mkdirSync(path.dirname(target), { recursive: true });
    this.fs.writeFileSync(part, bytes);
    try {
      this.fs.chmodSync(part, 0o755);
    } catch {
      // На Windows права не нужны, на остальных — уже могли быть выставлены.
    }

    let version: string;
    try {
      version = await this.probeVersion(part);
    } catch (err) {
      this.discard(part);
      throw new Error(`не запускается: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!/^\d/.test(version)) {
      this.discard(part);
      throw new Error(`--version ответил не версией: ${version.slice(0, 80)}`);
    }

    try {
      this.fs.renameSync(part, target);
    } catch (err) {
      this.discard(part);
      throw new Error(`не удалось заменить файл: ${err instanceof Error ? err.message : String(err)}`);
    }

    const at = this.now();
    this.writeState({ tag, version, installedAt: at, checkedAt: at });
    return version;
  }

  private discard(file: string): void {
    try {
      this.fs.rmSync(file, { force: true });
    } catch {
      // Мусорный `.part` безвреден: следующая попытка его перезапишет.
    }
  }

  private getStateFile(): string | null {
    return this.binDir ? path.join(this.binDir, 'yt-dlp.json') : null;
  }

  private writeState(state: YtDlpState): void {
    this.cachedState = state;
    this.stateRead = true;
    const file = this.getStateFile();
    if (!file) return;
    try {
      this.fs.mkdirSync(path.dirname(file), { recursive: true });
      this.fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      // Без маркера обновление просто повторится — это дешевле, чем падать.
    }
  }

  /** Проверка при запуске и дальше по расписанию. */
  public start(): void {
    if (!this.getManagedPath() || this.firstCheck || this.interval) return;

    this.firstCheck = setTimeout(() => {
      this.firstCheck = null;
      void this.ensureCurrent().then((result) => {
        // Сеть после логина поднимается не мгновенно, а до первого обновления
        // часть песен не играет — одна короткая пересборка того стоит.
        if (!result.updated && !this.hasManagedBinary() && !this.retry) {
          this.retry = setTimeout(() => {
            this.retry = null;
            void this.ensureCurrent({ force: true });
          }, RETRY_DELAY_MS);
          this.retry.unref?.();
        }
      });
    }, FIRST_CHECK_DELAY_MS);
    this.interval = setInterval(() => {
      void this.ensureCurrent();
    }, CHECK_INTERVAL_MS);

    // Расписание — не повод держать процесс живым.
    this.firstCheck.unref?.();
    this.interval.unref?.();
  }

  private hasManagedBinary(): boolean {
    const managed = this.getManagedPath();
    return Boolean(managed && this.fs.existsSync(managed));
  }

  public dispose(): void {
    if (this.firstCheck) {
      clearTimeout(this.firstCheck);
      this.firstCheck = null;
    }
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

/** Тело ответа не нужно — но открытый сокет держит соединение. */
async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Уже прочитано или не поддерживается — освобождать нечего.
  }
}

export default YtDlpManager;
