import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/**
 * Автообновление, главный процесс.
 *
 * `electron-updater` приходит в сервис снаружи, поэтому весь путь — «нашли →
 * качаем → готово → перезапуск» — проверяется без сети, без установщика и без
 * упакованной сборки. Настоящий модуль здесь не загружается ни разу.
 */

// Мутируемый двойник: часть проверок должна выглядеть как упакованная сборка.
const electronMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getVersion: () => '1.2.3'
  }
}));

vi.mock('electron', () => electronMock);

import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  UPDATE_CHECK_CHANNEL,
  UPDATE_GET_STATE_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UpdateService,
  UpdateState,
  createUpdateService,
  describeUpdateSupport,
  humanizeUpdateError,
  setupUpdaterIpc
} from '../../electron/updater';

/** Двойник `autoUpdater`: те же события, но их посылает тест. */
function makeUpdater() {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>();

  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null as unknown,
    on(event: string, listener: (payload?: unknown) => void): void {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    removeAllListeners: vi.fn(() => {
      listeners.clear();
    }),
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    /** Как это делает electron-updater. */
    emit(event: string, payload?: unknown): void {
      (listeners.get(event) ?? []).forEach((listener) => listener(payload));
    },
    listenerCount(event: string): number {
      return (listeners.get(event) ?? []).length;
    }
  };
}

type FakeUpdater = ReturnType<typeof makeUpdater>;

function makeService(updater: FakeUpdater, supported = true) {
  const states: UpdateState[] = [];
  const service = new UpdateService({
    updater,
    currentVersion: '1.0.0',
    support: supported ? { supported: true } : { supported: false, reason: 'Нет канала обновлений.' },
    broadcast: (state) => states.push(state),
    now: () => 1_700_000_000_000
  });
  return { service, states };
}

describe('Автообновление: можно ли обновляться', () => {
  it('в dev-режиме — нет, и это не ошибка', () => {
    const support = describeUpdateSupport({ isPackaged: false });
    expect(support.supported).toBe(false);
    expect(support.supported === false && support.reason).toMatch(/установленном приложении/i);
  });

  it('портативная сборка честно говорит, что сама не обновится', () => {
    const support = describeUpdateSupport({
      isPackaged: true,
      portableDir: 'C:\\Users\\me\\Downloads',
      configPath: 'C:\\app\\app-update.yml',
      fileExists: () => true
    });
    expect(support.supported).toBe(false);
    expect(support.supported === false && support.reason).toMatch(/Портативная/i);
  });

  it('без app-update.yml спрашивать некого', () => {
    const support = describeUpdateSupport({
      isPackaged: true,
      configPath: 'C:\\app\\app-update.yml',
      fileExists: () => false
    });
    expect(support.supported).toBe(false);
    expect(support.supported === false && support.reason).toMatch(/откуда брать обновления/i);
  });

  it('со своим адресом фида app-update.yml не нужен', () => {
    expect(
      describeUpdateSupport({
        isPackaged: true,
        feedUrl: 'https://example.test/updates',
        fileExists: () => false
      })
    ).toEqual({ supported: true });
  });

  it('установленная сборка с настроенным каналом обновляется', () => {
    expect(
      describeUpdateSupport({
        isPackaged: true,
        configPath: 'C:\\app\\app-update.yml',
        fileExists: () => true
      })
    ).toEqual({ supported: true });
  });
});

describe('Автообновление: ошибки на человеческом', () => {
  it('пропавшую сеть не выдаёт за поломку приложения', () => {
    expect(humanizeUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toMatch(/Нет связи/);
    expect(humanizeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toMatch(/Нет связи/);
  });

  it('пустой список релизов — это не ошибка обновления', () => {
    expect(
      humanizeUpdateError(new Error('Cannot find channel "latest.yml" update info: HttpError: 404'))
    ).toMatch(/нет ни одного релиза/i);
  });

  it('битую загрузку объясняет и обещает повтор', () => {
    expect(humanizeUpdateError(new Error('sha512 checksum mismatch'))).toMatch(/повреждённым/i);
  });

  it('нехватку прав называет прямо', () => {
    expect(humanizeUpdateError(new Error('EPERM: operation not permitted'))).toMatch(/прав/i);
  });

  it('незнакомую ошибку показывает как есть — по ней хоть можно написать в поддержку', () => {
    expect(humanizeUpdateError(new Error('Something odd happened'))).toBe(
      'Обновление не удалось: Something odd happened'
    );
    expect(humanizeUpdateError(undefined)).toMatch(/причина неизвестна/i);
  });
});

describe('Автообновление: состояние', () => {
  it('ведёт от «проверяем» до «готово», ничего не спрашивая у человека', () => {
    const updater = makeUpdater();
    const { service, states } = makeService(updater);

    expect(service.getState().status).toBe('idle');
    // Главное во всей затее: качать самому и ставить при выходе.
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);

    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.1.0' });
    updater.emit('download-progress', { percent: 42.7 });
    updater.emit('update-downloaded', { version: '1.1.0' });

    expect(service.getState()).toMatchObject({
      status: 'ready',
      currentVersion: '1.0.0',
      newVersion: '1.1.0',
      percent: 100,
      message: null,
      checkedAt: 1_700_000_000_000
    });
    expect(states.map((state) => state.status)).toEqual([
      'checking',
      'available',
      'downloading',
      'ready'
    ]);
    // 42.7% → 43%: доли процента человеку ни о чём не говорят.
    expect(states[2].percent).toBe(43);
  });

  it('не гоняет по IPC одни и те же проценты', () => {
    const updater = makeUpdater();
    const { service, states } = makeService(updater);

    updater.emit('download-progress', { percent: 12.2 });
    updater.emit('download-progress', { percent: 12.4 });
    updater.emit('download-progress', { percent: 13.1 });

    expect(states.map((state) => state.percent)).toEqual([12, 13]);
    expect(service.getState().percent).toBe(13);
  });

  it('«нет новой версии» — это спокойный ответ, а не пустота', () => {
    const updater = makeUpdater();
    const { service } = makeService(updater);

    updater.emit('checking-for-update');
    updater.emit('update-not-available', { version: '1.0.0' });

    expect(service.getState()).toMatchObject({
      status: 'up-to-date',
      newVersion: null,
      checkedAt: 1_700_000_000_000
    });
  });

  it('ошибку переводит на человеческий и не роняет процесс', () => {
    const updater = makeUpdater();
    const { service } = makeService(updater);

    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));

    expect(service.getState()).toMatchObject({
      status: 'error',
      message: 'Нет связи с сервером обновлений — попробуем позже.'
    });
  });

  it('уже скачанное обновление важнее поздней ошибки', () => {
    const updater = makeUpdater();
    const { service } = makeService(updater);

    updater.emit('update-downloaded', { version: '2.0.0' });
    updater.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));

    // Пакет лежит на диске, так что совет «перезапустите» остаётся верным.
    expect(service.getState().status).toBe('ready');
  });

  it('падение окна на приёме состояния не ломает обновление', () => {
    const updater = makeUpdater();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new UpdateService({
      updater,
      currentVersion: '1.0.0',
      support: { supported: true },
      broadcast: () => {
        throw new Error('window is gone');
      }
    });

    expect(() => updater.emit('update-downloaded', { version: '1.1.0' })).not.toThrow();
    expect(service.getState().status).toBe('ready');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Автообновление: проверка и установка', () => {
  it('две одновременные проверки стучатся в сервер один раз', async () => {
    const updater = makeUpdater();
    const { service } = makeService(updater);

    let release: () => void = () => {};
    updater.checkForUpdates.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        })
    );

    const first = service.check();
    const second = service.check();
    release();
    await Promise.all([first, second]);

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('когда пакет уже скачан, проверять нечего', async () => {
    const updater = makeUpdater();
    const { service } = makeService(updater);

    updater.emit('update-downloaded', { version: '1.1.0' });
    const state = await service.check();

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(state.status).toBe('ready');
  });

  it('провал проверки без события ошибки всё равно не оставляет «проверяем» навсегда', async () => {
    const updater = makeUpdater();
    const { service } = makeService(updater);
    updater.checkForUpdates.mockRejectedValue(
      new Error('Cannot find channel "latest.yml" update info: HttpError: 404')
    );

    const state = await service.check();

    expect(state.status).toBe('error');
    expect(state.message).toBe('На сервере обновлений пока нет ни одного релиза.');
  });

  it('«перезапустить» ставит обновление молча и поднимает приложение само', () => {
    const updater = makeUpdater();
    const { service } = makeService(updater);

    // Ставить пока нечего — кнопки в этот момент и нет.
    expect(service.install()).toBe(false);

    updater.emit('update-downloaded', { version: '1.1.0' });
    expect(service.install()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('если установка не запустилась, это видно в состоянии', () => {
    const updater = makeUpdater();
    const { service } = makeService(updater);
    updater.quitAndInstall.mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });

    updater.emit('update-downloaded', { version: '1.1.0' });

    expect(service.install()).toBe(false);
    expect(service.getState()).toMatchObject({
      status: 'error',
      message: 'Не хватило прав, чтобы установить обновление.'
    });
  });
});

describe('Автообновление: расписание', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('первая проверка не в момент запуска, дальше — по кругу', async () => {
    const updater = makeUpdater();
    const { service } = makeService(updater);

    service.start();
    // Запуск и без того занят: окно, медиатека, восстановление сессии.
    expect(updater.checkForUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);

    service.dispose();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.removeAllListeners).toHaveBeenCalled();
  });

  it('после скачивания расписание останавливается — ждать больше нечего', async () => {
    const updater = makeUpdater();
    const { service } = makeService(updater);

    service.start();
    updater.emit('update-downloaded', { version: '1.1.0' });
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('когда обновляться неоткуда, сеть не трогается вообще', async () => {
    const updater = makeUpdater();
    const { service, states } = makeService(updater, false);

    expect(service.isSupported()).toBe(false);
    expect(service.getState()).toMatchObject({
      status: 'unsupported',
      message: 'Нет канала обновлений.'
    });

    service.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);
    await service.check();

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(service.install()).toBe(false);
    expect(states).toEqual([]);
    // На события такого апдейтера никто не подписывался.
    expect(updater.listenerCount('update-downloaded')).toBe(0);
    updater.emit('update-downloaded', { version: '9.9.9' });
    expect(service.getState().status).toBe('unsupported');
  });
});

describe('Автообновление: каналы IPC', () => {
  it('наружу выходят ровно три канала', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const updater = makeUpdater();
    const { service } = makeService(updater);

    setupUpdaterIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, service);

    expect([...handlers.keys()].sort()).toEqual(
      [UPDATE_CHECK_CHANNEL, UPDATE_GET_STATE_CHANNEL, UPDATE_INSTALL_CHANNEL].sort()
    );
    expect(handlers.get(UPDATE_GET_STATE_CHANNEL)?.()).toMatchObject({
      status: 'idle',
      currentVersion: '1.0.0'
    });

    await handlers.get(UPDATE_CHECK_CHANNEL)?.();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    // Ставить нечего — канал отвечает «нет», а не падает.
    expect(handlers.get(UPDATE_INSTALL_CHANNEL)?.()).toBe(false);
  });
});

describe('Автообновление: сборка сервиса под текущую сборку приложения', () => {
  let logs: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    logs = [
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    ];
  });

  afterEach(() => {
    logs.forEach((spy) => spy.mockRestore());
    electronMock.app.isPackaged = false;
    delete process.env.WIREON_UPDATE_URL;
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  });

  it('в dev-режиме модуль обновлений даже не загружается', () => {
    const load = vi.fn();
    const service = createUpdateService({ broadcast: () => {}, loadUpdater: load });

    expect(load).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ status: 'unsupported', currentVersion: '1.2.3' });
  });

  it('WIREON_UPDATE_URL заменяет канал обновлений', () => {
    electronMock.app.isPackaged = true;
    process.env.WIREON_UPDATE_URL = 'https://example.test/updates';
    const updater = makeUpdater();

    const service = createUpdateService({ broadcast: () => {}, loadUpdater: () => updater });

    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://example.test/updates'
    });
    expect(service.getState().status).toBe('idle');
    expect(service.isSupported()).toBe(true);
  });

  it('если модуль обновлений не загрузился, приложение всё равно работает', () => {
    electronMock.app.isPackaged = true;
    process.env.WIREON_UPDATE_URL = 'https://example.test/updates';

    const service = createUpdateService({ broadcast: () => {}, loadUpdater: () => null });

    expect(service.isSupported()).toBe(false);
    expect(service.getState()).toMatchObject({ status: 'unsupported' });
    expect(service.getState().message).toMatch(/не загрузился/i);
  });
});
