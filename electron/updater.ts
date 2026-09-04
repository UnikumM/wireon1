import { app } from 'electron';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

/**
 * Автообновление.
 *
 * Задача одна: человеку не нужно ничего скачивать руками. Приложение само
 * спрашивает канал обновлений, тихо тянет новую версию в фоне и говорит только
 * в самом конце — «готово, перезапустите». Если перезапускать сейчас не хочется,
 * обновление встанет при следующем выходе из приложения
 * (`autoInstallOnAppQuit`), так что нажать «Позже» ничего не ломает.
 *
 * Чего здесь сознательно нет — ни одного `throw` наружу. Пропавшая сеть, пустой
 * список релизов, портативная сборка, сборка без настроенного канала: всё это
 * состояния на экране, а не падение главного процесса.
 */

const requireCjs = createRequire(import.meta.url);

/** Канал, по которому состояние уходит во все окна. */
export const UPDATE_STATE_CHANNEL = 'update:state';
export const UPDATE_GET_STATE_CHANNEL = 'update:get-state';
export const UPDATE_CHECK_CHANNEL = 'update:check';
export const UPDATE_INSTALL_CHANNEL = 'update:install';

/** Первая проверка не в момент запуска: пусть окно сначала отрисуется. */
export const FIRST_CHECK_DELAY_MS = 12_000;

/** Дальше — раз в шесть часов. Чаще незачем: релизы выходят реже. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateStatus =
  /** Обновляться неоткуда: dev-режим, портативная сборка, нет канала. */
  | 'unsupported'
  /** Ещё ни разу не спрашивали. */
  | 'idle'
  | 'checking'
  /** Нашли новую версию; загрузка начинается сама. */
  | 'available'
  | 'downloading'
  /** Пакет на диске — ждём перезапуска. */
  | 'ready'
  | 'up-to-date'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** Версия, которая запущена сейчас. */
  currentVersion: string;
  /** Версия, которую нашли или уже скачали. */
  newVersion: string | null;
  /** Целые проценты загрузки, 0–100. */
  percent: number;
  /** Человеческое объяснение для `error` и `unsupported`. */
  message: string | null;
  /** Когда последний раз удалось поговорить с сервером обновлений. */
  checkedAt: number | null;
}

export type UpdateSupport = { supported: true } | { supported: false; reason: string };

/** Ровно то, что этому модулю нужно от `electron-updater`. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  on(event: string, listener: (...args: any[]) => void): void;
  removeAllListeners?(event?: string): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  setFeedURL?(options: unknown): void;
}

export interface UpdateEnvironment {
  isPackaged: boolean;
  /** Заполнен только в портативной сборке — её обновлять некуда. */
  portableDir?: string | null;
  /** Путь к `app-update.yml`, который electron-builder кладёт в ресурсы. */
  configPath?: string | null;
  /** Своя ссылка на фид вместо релизов на GitHub (`WIREON_UPDATE_URL`). */
  feedUrl?: string | null;
  /** Отдельно, чтобы тест не трогал диск. */
  fileExists?: (file: string) => boolean;
}

/**
 * Может ли эта сборка обновиться сама — и если нет, то что сказать человеку.
 *
 * Проверок три, и все три встречаются в жизни: dev-запуск (там обновлять нечего),
 * портативный exe (он лежит где угодно и установщика у него нет) и сборка,
 * собранная без `publish` в конфиге — тогда `app-update.yml` в ресурсы не попал
 * и спрашивать попросту некого.
 */
export function describeUpdateSupport(env: UpdateEnvironment): UpdateSupport {
  if (!env.isPackaged) {
    return {
      supported: false,
      reason: 'Обновления проверяются только в установленном приложении.'
    };
  }

  if (env.portableDir) {
    return {
      supported: false,
      reason: 'Портативная версия не обновляется сама — для автообновлений нужна установленная.'
    };
  }

  // Со своим фидом `app-update.yml` не нужен: адрес задаётся из кода.
  if (!env.feedUrl) {
    const exists = env.fileExists ?? existsSync;
    if (!env.configPath || !exists(env.configPath)) {
      return {
        supported: false,
        reason: 'В этой сборке не указано, откуда брать обновления.'
      };
    }
  }

  return { supported: true };
}

/**
 * Переводит ошибку обновления на человеческий.
 *
 * Последняя ветка отдаёт текст как есть: непонятная правда полезнее вежливого
 * «что-то пошло не так» — по ней хотя бы можно написать в поддержку.
 */
export function humanizeUpdateError(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err ?? '')).trim();
  if (!text) return 'Проверить обновления не удалось, причина неизвестна.';

  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|ECONNRESET|ECONNREFUSED|net::|network|getaddrinfo/i.test(text)) {
    return 'Нет связи с сервером обновлений — попробуем позже.';
  }
  if (/\b404\b|Cannot find channel|No published versions|latest\.yml/i.test(text)) {
    return 'На сервере обновлений пока нет ни одного релиза.';
  }
  if (/sha512|checksum|signature|integrity/i.test(text)) {
    return 'Файл обновления скачался повреждённым — попробуем ещё раз позже.';
  }
  if (/app-update\.yml|dev-app-update\.yml|provider|not configured/i.test(text)) {
    return 'В этой сборке не указано, откуда брать обновления.';
  }
  if (/EPERM|EACCES|permission/i.test(text)) {
    return 'Не хватило прав, чтобы установить обновление.';
  }

  return `Обновление не удалось: ${text}`;
}

function readVersion(info: unknown): string | null {
  const version = (info as { version?: unknown } | null | undefined)?.version;
  return typeof version === 'string' && version ? version : null;
}

function readPercent(progress: unknown): number {
  const percent = (progress as { percent?: unknown } | null | undefined)?.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

export interface UpdateServiceOptions {
  /** `null`, когда обновляться неоткуда: сервис тогда только рассказывает почему. */
  updater: UpdaterLike | null;
  currentVersion: string;
  support: UpdateSupport;
  broadcast: (state: UpdateState) => void;
  now?: () => number;
}

/**
 * Состояние обновления и его расписание.
 *
 * `electron-updater` приходит снаружи — поэтому весь этот автомат проверяется
 * тестами без сети, установщика и упакованной сборки.
 */
export class UpdateService {
  private readonly updater: UpdaterLike | null;
  private readonly broadcast: (state: UpdateState) => void;
  private readonly now: () => number;
  private state: UpdateState;
  private firstCheck: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<UpdateState> | null = null;

  constructor(options: UpdateServiceOptions) {
    this.updater = options.support.supported ? options.updater : null;
    this.broadcast = options.broadcast;
    this.now = options.now ?? (() => Date.now());
    this.state = {
      status: options.support.supported ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
      newVersion: null,
      percent: 0,
      message: options.support.supported ? null : options.support.reason,
      checkedAt: null
    };

    if (this.updater) {
      this.attach(this.updater);
    }
  }

  public getState(): UpdateState {
    return { ...this.state };
  }

  /** Работает ли автообновление в этой сборке. */
  public isSupported(): boolean {
    return this.updater !== null;
  }

  /**
   * Спрашивает сервер. Возвращает состояние после ответа, поэтому кнопка
   * «Проверить сейчас» в настройках может просто дождаться результата.
   */
  public async check(): Promise<UpdateState> {
    if (!this.updater) return this.getState();
    // Пакет уже на диске: проверять нечего, ответ не изменится.
    if (this.state.status === 'ready') return this.getState();
    if (this.pending) return this.pending;

    this.pending = this.runCheck(this.updater);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async runCheck(updater: UpdaterLike): Promise<UpdateState> {
    try {
      await updater.checkForUpdates();
    } catch (err) {
      // Обычно всё уже сказало событие 'error'. Но если его не было, статус
      // нельзя оставлять на «проверяем» — иначе настройки замрут навсегда.
      if (this.state.status === 'checking' || this.state.status === 'idle') {
        this.set({ status: 'error', message: humanizeUpdateError(err) });
      }
    }
    return this.getState();
  }

  /** Ставит скачанное обновление и поднимает приложение заново. */
  public install(): boolean {
    if (!this.updater || this.state.status !== 'ready') return false;
    try {
      // isSilent: мастер установки не нужен, человек уже согласился кнопкой.
      // isForceRunAfter: приложение должно вернуться само, а не остаться закрытым.
      this.updater.quitAndInstall(true, true);
      return true;
    } catch (err) {
      this.set({ status: 'error', message: humanizeUpdateError(err) });
      return false;
    }
  }

  /** Первая проверка с задержкой, дальше — по расписанию. */
  public start(): void {
    if (!this.updater || this.firstCheck || this.interval) return;

    this.firstCheck = setTimeout(() => {
      this.firstCheck = null;
      void this.check();
    }, FIRST_CHECK_DELAY_MS);
    this.interval = setInterval(() => {
      void this.check();
    }, CHECK_INTERVAL_MS);

    // Расписание обновлений — не повод держать процесс живым.
    this.firstCheck.unref?.();
    this.interval.unref?.();
  }

  public dispose(): void {
    this.stopSchedule();
    this.updater?.removeAllListeners?.();
  }

  private stopSchedule(): void {
    if (this.firstCheck) {
      clearTimeout(this.firstCheck);
      this.firstCheck = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private attach(updater: UpdaterLike): void {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.logger = {
      info: (...args: unknown[]) => console.log('[Updater]', ...args),
      warn: (...args: unknown[]) => console.warn('[Updater]', ...args),
      error: (...args: unknown[]) => console.error('[Updater]', ...args),
      debug: () => {
        // Слишком подробно даже для лога главного процесса.
      }
    };

    updater.on('checking-for-update', () => {
      this.set({ status: 'checking', message: null });
    });

    updater.on('update-available', (info: unknown) => {
      this.set({
        status: 'available',
        newVersion: readVersion(info),
        percent: 0,
        message: null,
        checkedAt: this.now()
      });
    });

    updater.on('update-not-available', () => {
      this.set({
        status: 'up-to-date',
        newVersion: null,
        percent: 0,
        message: null,
        checkedAt: this.now()
      });
    });

    updater.on('download-progress', (progress: unknown) => {
      this.set({ status: 'downloading', percent: readPercent(progress), message: null });
    });

    updater.on('update-downloaded', (info: unknown) => {
      // Дальше качать нечего, расписание больше не нужно: ждём перезапуска.
      this.stopSchedule();
      this.set({
        status: 'ready',
        newVersion: readVersion(info) ?? this.state.newVersion,
        percent: 100,
        message: null,
        checkedAt: this.now()
      });
    });

    updater.on('error', (err: unknown) => {
      // Уже скачанное обновление важнее свежей ошибки: если пакет лежит на
      // диске, совет «перезапустите» остаётся верным.
      if (this.state.status === 'ready') return;
      this.set({ status: 'error', message: humanizeUpdateError(err) });
    });
  }

  private set(patch: Partial<UpdateState>): void {
    const next: UpdateState = { ...this.state, ...patch };
    // Прогресс прилетает десятками событий в секунду. В окно уходит только то,
    // что человек реально увидит, — иначе IPC работает вместо приложения.
    const changed =
      next.status !== this.state.status ||
      next.newVersion !== this.state.newVersion ||
      next.percent !== this.state.percent ||
      next.message !== this.state.message;

    this.state = next;
    if (!changed) return;

    try {
      this.broadcast(this.getState());
    } catch (err) {
      console.warn('[Updater] Could not deliver the update state to a window:', err);
    }
  }
}

function readAppVersion(): string {
  try {
    return typeof app?.getVersion === 'function' ? app.getVersion() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readIsPackaged(): boolean {
  try {
    return Boolean(app?.isPackaged);
  } catch {
    return false;
  }
}

/** Где electron-builder оставляет описание канала обновлений. */
function updateConfigPath(): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resources ? path.join(resources, 'app-update.yml') : null;
}

function readFeedUrl(): string | null {
  const raw = process.env.WIREON_UPDATE_URL;
  return raw && raw.trim() ? raw.trim() : null;
}

function loadElectronUpdater(): UpdaterLike | null {
  try {
    // Через require, а не import: модуль нужен только упакованной сборке, а его
    // загрузка сама лезет в пути приложения — в тестах и dev-режиме это лишнее.
    const mod = requireCjs('electron-updater') as { autoUpdater?: UpdaterLike };
    return mod?.autoUpdater ?? null;
  } catch (err) {
    console.warn('[Updater] electron-updater is unavailable:', err);
    return null;
  }
}

export interface CreateUpdateServiceOptions {
  broadcast: (state: UpdateState) => void;
  /** Подменяется в тестах; по умолчанию — настоящий `electron-updater`. */
  loadUpdater?: () => UpdaterLike | null;
}

/** Собирает сервис под текущую сборку: сам решает, есть ли куда обновляться. */
export function createUpdateService(options: CreateUpdateServiceOptions): UpdateService {
  const currentVersion = readAppVersion();
  const feedUrl = readFeedUrl();
  const support = describeUpdateSupport({
    isPackaged: readIsPackaged(),
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR || null,
    configPath: updateConfigPath(),
    feedUrl
  });

  if (!support.supported) {
    console.info(`[Updater] Auto-updates are off: ${support.reason}`);
    return new UpdateService({ updater: null, currentVersion, support, broadcast: options.broadcast });
  }

  const updater = (options.loadUpdater ?? loadElectronUpdater)();
  if (!updater) {
    return new UpdateService({
      updater: null,
      currentVersion,
      support: {
        supported: false,
        reason: 'Модуль обновлений не загрузился — обновиться из приложения не получится.'
      },
      broadcast: options.broadcast
    });
  }

  if (feedUrl && typeof updater.setFeedURL === 'function') {
    try {
      updater.setFeedURL({ provider: 'generic', url: feedUrl });
      console.info(`[Updater] Using the feed from WIREON_UPDATE_URL: ${feedUrl}`);
    } catch (err) {
      console.warn('[Updater] Could not apply WIREON_UPDATE_URL:', err);
    }
  }

  return new UpdateService({ updater, currentVersion, support, broadcast: options.broadcast });
}

export interface UpdaterIpcLike {
  handle(channel: string, listener: (...args: any[]) => any): void;
}

/** Три канала: узнать состояние, проверить сейчас, поставить и перезапустить. */
export function setupUpdaterIpc(ipc: UpdaterIpcLike, service: UpdateService): void {
  ipc.handle(UPDATE_GET_STATE_CHANNEL, () => service.getState());
  ipc.handle(UPDATE_CHECK_CHANNEL, () => service.check());
  ipc.handle(UPDATE_INSTALL_CHANNEL, () => service.install());
}

export default {
  createUpdateService,
  setupUpdaterIpc,
  describeUpdateSupport,
  humanizeUpdateError,
  UpdateService
};
