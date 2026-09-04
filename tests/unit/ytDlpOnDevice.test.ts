import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';

import {
  isYtDlpAvailable,
  resetYtDlpAvailability,
  resolveWithYtDlp,
  updateYtDlp,
  YtDlpError
} from '../../src/services/ytDlpOnDevice';

/**
 * yt-dlp, работающий на самом телефоне.
 *
 * Ради чего он появился: у сервера адрес дата-центра, и YouTube требует у него
 * доказать, что он не робот, практически на каждый трек; обходится это чужими
 * cookies, которые протухают за недели. У телефона адрес домашний. Разбор
 * силами `youtubei.js` при этом не спасает — он получает только SABR, который
 * `<audio src>` не играет.
 *
 * Проверяется здесь не «плагин вызвался», а то, чем такой мост ломается:
 * молчаливым отказом на устройстве, где плагина нет, и потерей кода ошибки —
 * из-за которой человек вместо совета получает «что-то пошло не так».
 */

const REAL_ELECTRON = (window as unknown as { electronAPI?: unknown }).electronAPI;

/** Делает окно телефонным и кладёт в него заданный плагин. */
function pretendMobile(plugin: unknown): void {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: plugin === null ? {} : { YtDlp: plugin }
  };
}

const STREAM = 'https://rr3---sn-x.googlevideo.com/videoplayback?expire=1900000000&id=abc';

beforeEach(() => {
  resetYtDlpAvailability();
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  (window as unknown as { electronAPI?: unknown }).electronAPI = REAL_ELECTRON;
  resetYtDlpAvailability();
  vi.restoreAllMocks();
});

describe('ytDlpOnDevice: есть ли он вообще', () => {
  it('на десктопе и в браузере его нет, и это не отказ', async () => {
    // Плагин живёт только в APK. Спрашивать его в вебе — значит ждать ответа
    // от того, кого нет, на каждый трек.
    await expect(isYtDlpAvailable()).resolves.toBe(false);
  });

  it('в APK, выпущенном до этой работы, плагина тоже нет', async () => {
    pretendMobile(null);
    await expect(isYtDlpAvailable()).resolves.toBe(false);
  });

  it('распаковка Python спрашивается один раз за запуск, а не на каждый трек', async () => {
    const available = vi.fn(async () => ({ available: true }));
    pretendMobile({ available, resolve: vi.fn(), update: vi.fn() });

    await expect(isYtDlpAvailable()).resolves.toBe(true);
    await expect(isYtDlpAvailable()).resolves.toBe(true);

    expect(available).toHaveBeenCalledTimes(1);
  });

  it('провалившаяся распаковка — это «нет», а не исключение посреди трека', async () => {
    pretendMobile({
      available: vi.fn(async () => {
        throw new Error('распаковать не вышло');
      }),
      resolve: vi.fn(),
      update: vi.fn()
    });

    await expect(isYtDlpAvailable()).resolves.toBe(false);
  });
});

describe('ytDlpOnDevice: ссылка', () => {
  it('приводит ответ к той же форме, что отдаёт десктоп', async () => {
    pretendMobile({
      available: vi.fn(async () => ({ available: true })),
      resolve: vi.fn(async () => ({
        streamUrl: STREAM,
        format: 'm4a',
        bitrate: 129,
        expiresAt: 1900000000000
      })),
      update: vi.fn()
    });

    await expect(resolveWithYtDlp('dQw4w9WgXcQ')).resolves.toEqual({
      streamUrl: STREAM,
      format: 'm4a',
      bitrate: 129,
      expiresAt: 1900000000000
    });
  });

  it('подставляет разумное там, где нативная сторона промолчала', async () => {
    // Битрейт — это подпись под названием. Отказывать в треке из-за того, что
    // её не удалось разобрать, значило бы менять музыку на цифру.
    pretendMobile({
      available: vi.fn(async () => ({ available: true })),
      resolve: vi.fn(async () => ({ streamUrl: STREAM })),
      update: vi.fn()
    });

    const stream = await resolveWithYtDlp('dQw4w9WgXcQ');
    expect(stream.format).toBe('m4a');
    expect(stream.bitrate).toBe(0);
    expect(stream.expiresAt).toBe(0);
  });

  it('доносит код отказа, а не только текст', async () => {
    // `describePlaybackError` ищет `YT_*` в начале строки. Потерянный код — это
    // «что-то пошло не так» вместо «YouTube просит подтвердить, что вы не робот».
    pretendMobile({
      available: vi.fn(async () => ({ available: true })),
      resolve: vi.fn(async () => {
        throw new Error('YT_BOT_CHECK: YouTube просит подтвердить, что вы не робот');
      }),
      update: vi.fn()
    });

    await expect(resolveWithYtDlp('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'YT_BOT_CHECK'
    });
  });

  it('ответ без ссылки — это отказ, а не пустой трек', async () => {
    pretendMobile({
      available: vi.fn(async () => ({ available: true })),
      resolve: vi.fn(async () => ({ format: 'm4a' })),
      update: vi.fn()
    });

    await expect(resolveWithYtDlp('dQw4w9WgXcQ')).rejects.toBeInstanceOf(YtDlpError);
    await expect(resolveWithYtDlp('dQw4w9WgXcQ')).rejects.toMatchObject({ code: 'YT_NO_AUDIO' });
  });

  it('без плагина отказывает сразу и понятным кодом', async () => {
    await expect(resolveWithYtDlp('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'YT_BINARY_MISSING'
    });
  });
});

describe('ytDlpOnDevice: обновление', () => {
  it('чинится без выпуска новой версии приложения', async () => {
    // YouTube ломает разбор раз в несколько месяцев, yt-dlp чинит это за дни.
    // Ждать от человека установки новой сборки ради чужой починки — значит
    // держать его без музыки всё это время.
    pretendMobile({
      available: vi.fn(async () => ({ available: true })),
      resolve: vi.fn(),
      update: vi.fn(async () => ({ version: '2026.08.28' }))
    });

    await expect(updateYtDlp()).resolves.toBe('2026.08.28');
  });

  it('неудачное обновление молчит: осталась прежняя версия, а не беда', async () => {
    pretendMobile({
      available: vi.fn(async () => ({ available: true })),
      resolve: vi.fn(),
      update: vi.fn(async () => {
        throw new Error('сеть отвалилась');
      })
    });

    await expect(updateYtDlp()).resolves.toBeNull();
  });
});

describe('ytDlpOnDevice: обновление по расписанию', () => {
  /** Делает окно телефонным с плагином, считающим вызовы `update`. */
  function mobileWithUpdate() {
    const update = vi.fn(async () => ({ version: '2026.08.19' }));
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        YtDlp: { available: async () => ({ available: true }), resolve: vi.fn(), update }
      }
    };
    return update;
  }

  it('обновляется, когда давно не обновлялся', async () => {
    // В библиотеке лежит yt-dlp той версии, что была на момент её выпуска: на
    // устройстве это оказался бинарник девятимесячной давности.
    const update = mobileWithUpdate();
    const db = await import('../../src/services/db');
    vi.spyOn(db, 'getSetting').mockResolvedValue(0 as never);
    const setSetting = vi.spyOn(db, 'setSetting').mockResolvedValue(undefined);

    const { maybeUpdateYtDlp } = await import('../../src/services/ytDlpOnDevice');
    await maybeUpdateYtDlp();

    expect(update).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalled();
  });

  it('в тот же день второй раз не ходит', async () => {
    const update = mobileWithUpdate();
    const db = await import('../../src/services/db');
    vi.spyOn(db, 'getSetting').mockResolvedValue(Date.now() as never);

    const { maybeUpdateYtDlp } = await import('../../src/services/ytDlpOnDevice');
    await maybeUpdateYtDlp();

    expect(update).not.toHaveBeenCalled();
  });

  it('на десктопе и в браузере не делает ничего', async () => {
    const db = await import('../../src/services/db');
    const getSetting = vi.spyOn(db, 'getSetting');

    const { maybeUpdateYtDlp } = await import('../../src/services/ytDlpOnDevice');
    await maybeUpdateYtDlp();

    // Даже до базы не доходит: обновлять там нечего.
    expect(getSetting).not.toHaveBeenCalled();
  });
});

/**
 * Очередь на устройстве: у человека своя полоса, у прогрева своя.
 *
 * Дыра, из-за которой это дожило до людей: приоритет никуда не отправлялся, и
 * все разборы шли одной очередью по порядку. Плеер греет три следующих трека,
 * каждый разбор — секунды, и нажатие play вставало за ними: на эмуляторе
 * замерено 25,5 секунды ожидания при шести секундах самого разбора. Веб-часть
 * бросала попытку по сроку, человек видел ошибку — а через минуту тот же трек
 * играл, потому что прогрев к тому времени уже лёг в кэш.
 */
describe('ytDlpOnDevice: приоритет и отвергнутая ссылка', () => {
  function mobileWithResolve() {
    const resolve = vi.fn(
      async (_options: { videoId: string; priority?: string; rejectUrl?: string }) => ({
        streamUrl: STREAM,
        format: 'm4a',
        bitrate: 129
      })
    );
    const raisePriority = vi.fn(async () => ({ moved: true }));
    pretendMobile({ available: vi.fn(async () => ({ available: true })), resolve, raisePriority, update: vi.fn() });
    return { resolve, raisePriority };
  }

  it('прогрев уходит в фоновую полосу, а нажатие play — в полосу человека', async () => {
    const { resolve } = mobileWithResolve();

    await resolveWithYtDlp('abc', { priority: 'prefetch' });
    expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'prefetch' }));

    await resolveWithYtDlp('abc');
    expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'user' }));
  });

  it('адрес, который плеер не смог играть, доезжает до разбора', async () => {
    const { resolve } = mobileWithResolve();

    await resolveWithYtDlp('abc', { rejectUrl: 'https://old.example/stream' });
    expect(resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ rejectUrl: 'https://old.example/stream' })
    );
  });

  it('без отвергнутого адреса поле не отправляется вовсе', async () => {
    const { resolve } = mobileWithResolve();

    await resolveWithYtDlp('abc');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.lastCall?.[0]).not.toHaveProperty('rejectUrl');
  });

  it('поднимает приоритет уже поставленной заявки', async () => {
    const { raisePriority } = mobileWithResolve();
    const { raiseYtDlpPriority } = await import('../../src/services/ytDlpOnDevice');

    raiseYtDlpPriority('abc');
    expect(raisePriority).toHaveBeenCalledWith({ videoId: 'abc' });
  });

  it('в APK, собранном до двух полос, метода нет — и это не отказ', async () => {
    pretendMobile({ available: vi.fn(async () => ({ available: true })), resolve: vi.fn(), update: vi.fn() });
    const { raiseYtDlpPriority } = await import('../../src/services/ytDlpOnDevice');

    expect(() => raiseYtDlpPriority('abc')).not.toThrow();
  });
});
