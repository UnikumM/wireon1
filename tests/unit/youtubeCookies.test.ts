/**
 * Источник cookies для YouTube (`src/services/youtubeCookies.ts`).
 *
 * Настройка живёт в renderer, а работает в main-процессе, и главное здесь —
 * стык между ними. Проверяется три вещи: выбор переживает перезапуск (main его
 * каждый раз забывает и должен услышать заново), в аргументы дочернего процесса
 * не уезжает ничего, кроме известных браузеров, и отсутствующий или сломанный
 * мост не мешает приложению работать — в браузерной сборке его нет вообще.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  YouTubeCookiesService,
  YOUTUBE_COOKIES_SETTING_KEY,
  COOKIE_BROWSER_OPTIONS,
  normalizeCookieBrowserChoice
} from '../../src/services/youtubeCookies';
import * as dbService from '../../src/services/db';

/** Мост, который просто записывает всё, что ему передали. */
function installBridge(
  impl?: (browser: string | null) => Promise<string | null>
): Array<string | null> {
  const pushed: Array<string | null> = [];
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    setYouTubeCookiesBrowser: async (browser: string | null) => {
      pushed.push(browser);
      return impl ? impl(browser) : browser;
    }
  };
  return pushed;
}

describe('youtubeCookies', () => {
  let originalElectronAPI: unknown;

  beforeEach(async () => {
    originalElectronAPI = (window as unknown as { electronAPI?: unknown }).electronAPI;
    await dbService.clearAllData();
  });

  afterEach(async () => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = originalElectronAPI;
    vi.restoreAllMocks();
    if (!dbService.db.isOpen()) await dbService.db.open();
    await dbService.clearAllData();
  });

  describe('normalizeCookieBrowserChoice', () => {
    it('принимает всё, что предлагает выпадающий список', () => {
      for (const { value } of COOKIE_BROWSER_OPTIONS) {
        expect(normalizeCookieBrowserChoice(value)).toBe(value);
      }
      expect(normalizeCookieBrowserChoice(' Firefox ')).toBe('firefox');
    });

    it('отбрасывает незнакомое и не-строки', () => {
      expect(normalizeCookieBrowserChoice('chrome --exec=calc')).toBeNull();
      expect(normalizeCookieBrowserChoice('netscape')).toBeNull();
      expect(normalizeCookieBrowserChoice('off')).toBeNull();
      expect(normalizeCookieBrowserChoice(undefined)).toBeNull();
      expect(normalizeCookieBrowserChoice(7)).toBeNull();
    });
  });

  describe('init', () => {
    it('поднимает сохранённый выбор и повторяет его main-процессу', async () => {
      await dbService.setSetting(YOUTUBE_COOKIES_SETTING_KEY, 'firefox');
      const pushed = installBridge();

      const service = new YouTubeCookiesService();
      await service.init();

      expect(service.get()).toBe('firefox');
      // Main начинает запуск без cookies, так что без этого вызова настройка
      // была бы включена в интерфейсе и выключена по факту.
      expect(pushed).toEqual(['firefox']);
    });

    it('сообщает и про выключенную настройку', async () => {
      const pushed = installBridge();

      await new YouTubeCookiesService().init();

      // `null` тоже надо передать: иначе прежнее значение жило бы до перезапуска.
      expect(pushed).toEqual([null]);
    });

    it('поднимается один раз, сколько бы её ни звали', async () => {
      const pushed = installBridge();
      const service = new YouTubeCookiesService();

      await Promise.all([service.init(), service.init()]);
      await service.init();

      expect(pushed).toEqual([null]);
    });

    it('игнорирует мусор, оказавшийся в настройках', async () => {
      await dbService.setSetting(YOUTUBE_COOKIES_SETTING_KEY, 'chrome; whoami');
      installBridge();

      const service = new YouTubeCookiesService();
      await service.init();

      expect(service.get()).toBeNull();
    });
  });

  describe('set', () => {
    it('сохраняет выбор и применяет его без перезапуска', async () => {
      const pushed = installBridge();
      const service = new YouTubeCookiesService();

      expect(await service.set('edge')).toBe('edge');

      expect(service.get()).toBe('edge');
      expect(pushed).toEqual(['edge']);
      expect(await dbService.getSetting(YOUTUBE_COOKIES_SETTING_KEY, null)).toBe('edge');
    });

    it('выключение стирает выбор и в базе, и в main', async () => {
      const pushed = installBridge();
      const service = new YouTubeCookiesService();
      await service.set('brave');

      expect(await service.set(null)).toBeNull();

      expect(pushed).toEqual(['brave', null]);
      expect(await dbService.getSetting(YOUTUBE_COOKIES_SETTING_KEY, null)).toBeNull();
    });

    it('незнакомый браузер не сохраняется и не уезжает в main', async () => {
      const pushed = installBridge();
      const service = new YouTubeCookiesService();

      expect(await service.set('chrome; rm -rf /')).toBeNull();

      expect(service.get()).toBeNull();
      expect(pushed).toEqual([null]);
    });

    it('после set() загрузка уже не перезатирает выбор', async () => {
      await dbService.setSetting(YOUTUBE_COOKIES_SETTING_KEY, 'opera');
      installBridge();
      const service = new YouTubeCookiesService();

      await service.set('vivaldi');
      await service.init();

      expect(service.get()).toBe('vivaldi');
    });
  });

  describe('без моста', () => {
    it('в браузерной сборке ничего не ломает и честно говорит, что не умеет', async () => {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
      const service = new YouTubeCookiesService();

      expect(service.isSupported()).toBe(false);
      await expect(service.init()).resolves.toBeUndefined();
      // Выбор всё равно запоминается: сборка могла запуститься и как десктопная.
      expect(await service.set('chrome')).toBe('chrome');
      expect(await dbService.getSetting(YOUTUBE_COOKIES_SETTING_KEY, null)).toBe('chrome');
    });

    it('переживает мост, который бросает', async () => {
      installBridge(async () => {
        throw new Error('main process gone');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = new YouTubeCookiesService();

      expect(await service.set('chrome')).toBe('chrome');

      expect(service.isSupported()).toBe(true);
      expect(warn).toHaveBeenCalled();
    });

    it('переживает базу, которая не пишет', async () => {
      installBridge();
      vi.spyOn(dbService, 'setSetting').mockRejectedValue(new Error('db closed'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = new YouTubeCookiesService();

      // Настройка применится, просто не переживёт перезапуск — это лучше, чем
      // отказ переключаться.
      expect(await service.set('chrome')).toBe('chrome');
      expect(warn).toHaveBeenCalled();
    });
  });
});
