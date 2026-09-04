import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  createServerBridge,
  detectPlatform,
  getStreamBridge,
  normalizeBaseUrl,
  proxyStreamUrl,
  resetStreamBridge,
  resolveServerConfig
} from '../../src/services/nativeBridge';
import { resetInnertube, setInnertubeFactory } from '../../src/services/youtubeOnDevice';

/**
 * Мост решает один вопрос: кто добывает звук, когда главного процесса нет.
 *
 * Проверять здесь надо не «делает запрос» — это видно и глазами, — а три вещи,
 * которые молча ломают телефон: половинчатая настройка, потерянный код отказа и
 * подмена платформы. Первое даёт приложение, где ни один трек не играет без
 * объяснения; второе — «что-то пошло не так» вместо «YouTube просит
 * подтвердить, что вы не робот»; третье — веб-сборку, которая лезет на сервер,
 * которого у неё нет.
 */

const CONFIG = { baseUrl: 'https://music.example', token: 'секрет' };

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body
  } as unknown as Response;
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body
  } as unknown as Response;
}

describe('nativeBridge: адрес сервера', () => {
  it('лишние косые черты снимаются, иначе путь склеится с двойным слэшем', () => {
    expect(normalizeBaseUrl('https://music.example/')).toBe('https://music.example');
    expect(normalizeBaseUrl('https://music.example///')).toBe('https://music.example');
  });

  it('не адрес — это не адрес', () => {
    expect(normalizeBaseUrl('music.example')).toBeNull();
    expect(normalizeBaseUrl('wss://music.example')).toBeNull();
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl(undefined)).toBeNull();
    expect(normalizeBaseUrl(42)).toBeNull();
  });

  it('обычный http принимается: без своего домена сервер живёт на голом адресе', () => {
    expect(normalizeBaseUrl('http://203.0.113.10:8099')).toBe('http://203.0.113.10:8099');
  });
});

describe('nativeBridge: настройка целиком или никак', () => {
  it('адрес и токен вместе дают настройку', () => {
    expect(resolveServerConfig('https://music.example', 'секрет')).toEqual(CONFIG);
  });

  it('адрес без токена настройкой не считается', () => {
    // Сервер отвечает 401 на всё, кроме /health. Половина настройки означала бы
    // приложение, где каждый трек молча не играет.
    expect(resolveServerConfig('https://music.example', '')).toBeNull();
    expect(resolveServerConfig('https://music.example', '   ')).toBeNull();
  });

  it('токен без адреса настройкой не считается', () => {
    expect(resolveServerConfig('', 'секрет')).toBeNull();
  });
});

describe('nativeBridge: где мы запущены', () => {
  it('electronAPI в окне — это десктоп', () => {
    expect(detectPlatform({ electronAPI: {} })).toBe('electron');
  });

  it('Capacitor, назвавшийся нативным, — это телефон', () => {
    expect(detectPlatform({ Capacitor: { isNativePlatform: () => true } })).toBe('mobile');
  });

  it('Capacitor в вебе телефоном не считается', () => {
    expect(detectPlatform({ Capacitor: { isNativePlatform: () => false } })).toBe('browser');
  });

  it('сломанный Capacitor не роняет определение платформы', () => {
    const broken = {
      Capacitor: {
        isNativePlatform: () => {
          throw new Error('обёртка не в себе');
        }
      }
    };
    expect(detectPlatform(broken)).toBe('browser');
  });

  it('пустое окно — это браузер', () => {
    expect(detectPlatform({})).toBe('browser');
    // `null` — это «окна нет вовсе», серверный рендеринг или ранний вызов.
    // Именно `null`, а не `undefined`: пропущенный аргумент подставляет
    // настоящее окно, и под тестами там висит заглушка из `tests/setup.ts`.
    expect(detectPlatform(null)).toBe('browser');
  });

  it('десктоп важнее: в Electron мост берётся из главного процесса, а не с сервера', () => {
    expect(detectPlatform({ electronAPI: {}, Capacitor: { isNativePlatform: () => true } })).toBe(
      'electron'
    );
  });
});

describe('nativeBridge: запросы к серверу', () => {
  it('токен уходит заголовком, а не в адресе', async () => {
    const fetchSpy = vi.fn(async () => okResponse({ ok: true }));
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    await bridge.searchYouTube!('daft punk');

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://music.example/v1/search?q=daft%20punk');
    expect(url).not.toContain('секрет');
    expect((init.headers as Record<string, string>)['X-Wireon-Token']).toBe('секрет');
  });

  it('радио ходит своим путём', async () => {
    const fetchSpy = vi.fn(async () => okResponse({}));
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    await bridge.youtubeRadio!('dQw4w9WgXcQ');

    const calls = fetchSpy.mock.calls as unknown as [string][];
    expect(calls[0][0]).toBe('https://music.example/v1/radio?id=dQw4w9WgXcQ');
  });

  it('запрос уезжает как есть: разбирать ответ будет youtube.ts, а не мост', async () => {
    const payload = { contents: { singleColumnMusicWatchNextResultsRenderer: {} } };
    const bridge = createServerBridge(
      CONFIG,
      (async () => okResponse(payload)) as unknown as typeof fetch
    );
    await expect(bridge.youtubeRadio!('dQw4w9WgXcQ')).resolves.toEqual(payload);
  });

  it('строка запроса экранируется, а не склеивается', async () => {
    const fetchSpy = vi.fn(async () => okResponse({}));
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    await bridge.searchYouTube!('rock & roll?live=1');

    const calls = fetchSpy.mock.calls as unknown as [string][];
    expect(calls[0][0]).toBe('https://music.example/v1/search?q=rock%20%26%20roll%3Flive%3D1');
  });
});

describe('nativeBridge: отказы доносятся кодом', () => {
  it('код YouTube проходит насквозь в том виде, в каком его ждёт playbackErrors', async () => {
    // `describePlaybackError` ищет `YT_*` в начале сообщения. Потеряв код,
    // человек на телефоне увидел бы «что-то пошло не так» вместо совета.
    const bridge = createServerBridge(
      CONFIG,
      (async () =>
        errorResponse(403, {
          error: 'YT_BOT_CHECK',
          detail: 'Sign in to confirm you are not a bot'
        })) as unknown as typeof fetch
    );

    await expect(bridge.youtubeRadio!('dQw4w9WgXcQ')).rejects.toThrow(
      /^YT_BOT_CHECK: Sign in to confirm/
    );
  });

  it('ответ не в JSON всё равно даёт код из статуса', async () => {
    const bridge = createServerBridge(
      CONFIG,
      (async () =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            throw new Error('это не JSON');
          }
        }) as unknown as Response) as unknown as typeof fetch
    );

    await expect(bridge.youtubeRadio!('dQw4w9WgXcQ')).rejects.toThrow(/^HTTP_502:/);
  });

  it('недоступный сервер отличается от отказавшего', async () => {
    const bridge = createServerBridge(
      CONFIG,
      (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch
    );

    await expect(bridge.searchYouTube!('что угодно')).rejects.toThrow(
      /^WIREON_SERVER_UNREACHABLE:/
    );
  });

  it('обрыв по сроку получает свой код', async () => {
    const bridge = createServerBridge(
      CONFIG,
      (async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }) as unknown as typeof fetch
    );

    await expect(bridge.searchYouTube!('что угодно')).rejects.toThrow(
      /^WIREON_SERVER_TIMEOUT:/
    );
  });
});

describe('nativeBridge: две ступени за ссылкой', () => {
  const VIDEO_ID = 'dQw4w9WgXcQ';
  const DIRECT_URL = 'https://rr1---sn-x.googlevideo.com/videoplayback?expire=1900000000';

  /** Разбор на устройстве, который удался. */
  function deviceSucceeds(): void {
    setInnertubeFactory(async () => ({
      getBasicInfo: async () => ({
        playability_status: { status: 'OK' },
        streaming_data: {
          adaptive_formats: [
            { has_audio: true, has_video: false, bitrate: 130000, url: DIRECT_URL }
          ],
          formats: []
        }
      }),
      session: { player: {} }
    }));
  }

  /**
   * Разбор на устройстве, кончившийся заданным состоянием YouTube.
   *
   * По умолчанию — SABR: YouTube отвечает «всё в порядке» и не даёт ни одной
   * дорожки. Ради этого случая вторая ступень и появилась, поэтому он же и
   * заготовка по умолчанию.
   */
  function deviceFails(status = 'OK'): void {
    setInnertubeFactory(async () => ({
      getBasicInfo: async () => ({
        playability_status: { status, reason: 'в тесте' },
        streaming_data: { adaptive_formats: [], formats: [] }
      }),
      session: { player: {} }
    }));
  }

  function serverUrls(spy: { mock: { calls: unknown[][] } }): string[] {
    return (spy.mock.calls as unknown as [string][]).map((call) => call[0]);
  }

  afterEach(() => {
    resetInnertube();
    vi.restoreAllMocks();
  });

  it('удача на устройстве — к серверу не ходят вовсе', async () => {
    // Это и есть экономика всей затеи: прямая ссылка не стоит ни байта нашего
    // канала, а перелив идёт по той же полосе, что VPN.
    deviceSucceeds();
    const fetchSpy = vi.fn(async () => okResponse({}));
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    const resolved = (await bridge.resolveYouTubeStream!(VIDEO_ID)) as { streamUrl: string };

    expect(resolved.streamUrl).toBe(DIRECT_URL);
    expect(serverUrls(fetchSpy).some((u) => u.includes('/v1/resolve'))).toBe(false);
  });

  it('неудача на устройстве — вторая ступень спрашивает сервер', async () => {
    deviceFails();
    const fetchSpy = vi.fn(async () =>
      okResponse({ streamUrl: DIRECT_URL, format: 'm4a', bitrate: 128, expiresAt: 1, ipLocked: false })
    );
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    const resolved = (await bridge.resolveYouTubeStream!(VIDEO_ID)) as { streamUrl: string };

    // Ссылка сервера не привязана к его адресу — отдаём как есть, телефон
    // качает сам, и перелив не включается.
    expect(resolved.streamUrl).toBe(DIRECT_URL);
    expect(serverUrls(fetchSpy)[0]).toContain('/v1/resolve?id=dQw4w9WgXcQ');
  });

  const LOCKED_URL = `${DIRECT_URL}&ip=203.0.113.10`;
  const PROXY_URL =
    'https://music.example/v1/stream?id=dQw4w9WgXcQ&token=%D1%81%D0%B5%D0%BA%D1%80%D0%B5%D1%82';

  /**
   * Сервер отдаёт ссылку с `ip=`, а раздача отвечает на пробу как задано.
   * Разводить по адресу приходится потому, что обе ступени ходят одним и тем
   * же `fetch`.
   */
  function serverGivesLockedLink(probeOk: boolean) {
    return vi.fn(async (url: string) => {
      if (url.includes('/v1/resolve')) {
        return okResponse({
          streamUrl: LOCKED_URL,
          format: 'm4a',
          bitrate: 128,
          expiresAt: 1,
          ipLocked: true,
          proxyUrl: `/v1/stream?id=${VIDEO_ID}`
        });
      }
      if (!probeOk) throw new Error('403');
      return okResponse({});
    });
  }

  it('ссылка с чужим адресом внутри, которая всё-таки открылась, остаётся прямой', async () => {
    // Замерено 2026-08-28: `ip=` в ссылке — подпись, а не всегда запрет.
    // Погнать такой трек через перелив значило бы занять канал VPN зря.
    deviceFails();
    const fetchSpy = serverGivesLockedLink(true);
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    const resolved = (await bridge.resolveYouTubeStream!(VIDEO_ID)) as { streamUrl: string };

    expect(resolved.streamUrl).toBe(LOCKED_URL);
    expect(serverUrls(fetchSpy).some((u) => u.includes('/v1/stream'))).toBe(false);
  });

  it('не открывшаяся ссылка подменяется на перелив', async () => {
    deviceFails();
    const bridge = createServerBridge(
      CONFIG,
      serverGivesLockedLink(false) as unknown as typeof fetch
    );

    const resolved = (await bridge.resolveYouTubeStream!(VIDEO_ID)) as { streamUrl: string };

    expect(resolved.streamUrl).toBe(PROXY_URL);
  });

  it('проба просит два байта, а не трек целиком', async () => {
    deviceFails();
    const fetchSpy = serverGivesLockedLink(true);
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    await bridge.resolveYouTubeStream!(VIDEO_ID);

    const probe = (fetchSpy.mock.calls as unknown as [string, RequestInit][]).find(([url]) =>
      url.startsWith(DIRECT_URL)
    );
    expect((probe![1].headers as Record<string, string>).Range).toBe('bytes=0-1');
  });

  it('токен в адресе перелива экранируется, а не склеивается', () => {
    expect(proxyStreamUrl({ baseUrl: 'https://m.example', token: 'a b&c' }, 'x?y')).toBe(
      'https://m.example/v1/stream?id=x%3Fy&token=a%20b%26c'
    );
  });

  it('«видео нет» второй ступени не стоит: ответ будет тот же', async () => {
    // Полминуты ожидания ради заведомо одинакового ответа — это не
    // надёжность, а молчащий плеер.
    deviceFails('ERROR');
    const fetchSpy = vi.fn(async () => okResponse({}));
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    await expect(bridge.resolveYouTubeStream!(VIDEO_ID)).rejects.toThrow(/^YT_UNAVAILABLE:/);
    expect(serverUrls(fetchSpy).some((u) => u.includes('/v1/resolve'))).toBe(false);
  });

  it('возрастное ограничение — повод спросить сервер: у него cookies аккаунта', async () => {
    deviceFails('LOGIN_REQUIRED');
    const fetchSpy = vi.fn(async () =>
      okResponse({ streamUrl: DIRECT_URL, format: 'm4a', bitrate: 128, expiresAt: 1, ipLocked: false })
    );
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    await bridge.resolveYouTubeStream!(VIDEO_ID);

    expect(serverUrls(fetchSpy).some((u) => u.includes('/v1/resolve'))).toBe(true);
  });

  it('недоступный сервер не подменяет собой настоящую причину', async () => {
    // «Сервер недоступен» вместо ответа YouTube отправило бы человека чинить
    // не то: первая ступень отказала сама по себе, и сказать надо про неё.
    deviceFails('LIVE_STREAM_OFFLINE');
    const bridge = createServerBridge(CONFIG, (async () => {
      throw new Error('сети нет');
    }) as unknown as typeof fetch);

    await expect(bridge.resolveYouTubeStream!(VIDEO_ID)).rejects.toThrow(/^YT_LIVE:/);
  });

  it('отказ сервера показывается, когда сервер ответил, а не промолчал', async () => {
    deviceFails();
    const bridge = createServerBridge(
      CONFIG,
      (async () => errorResponse(403, { error: 'YT_BOT_CHECK', detail: 'проверка' })) as unknown as typeof fetch
    );

    await expect(bridge.resolveYouTubeStream!(VIDEO_ID)).rejects.toThrow(/^YT_BOT_CHECK:/);
  });

  it('названная телефоном причина сильнее серверной проверки «вы не робот»', async () => {
    /*
     * У сервера адрес дата-центра, и проверку «вы не робот» он получает почти
     * на каждый трек — его отказ говорит о нём, а не о песне. Человеку при этом
     * показывали именно его: «подтвердите, что вы не робот» вместо «возрастное
     * ограничение» (и точно так же вместо «заблокировано в вашем регионе»), то
     * есть совет чинить не то.
     */
    deviceFails('LOGIN_REQUIRED');
    const bridge = createServerBridge(
      CONFIG,
      (async () => errorResponse(403, { error: 'YT_BOT_CHECK', detail: 'проверка' })) as unknown as typeof fetch
    );

    await expect(bridge.resolveYouTubeStream!(VIDEO_ID)).rejects.toThrow(/^YT_AGE_RESTRICTED:/);
  });
});

describe('nativeBridge: выбор моста в окне', () => {
  const view = window as unknown as { electronAPI?: unknown; Capacitor?: unknown };

  beforeEach(() => {
    resetStreamBridge();
  });

  afterEach(() => {
    delete view.electronAPI;
    delete view.Capacitor;
    resetStreamBridge();
    vi.restoreAllMocks();
  });

  it('в Electron отдаётся сам electronAPI', () => {
    const api = { searchYouTube: async () => ({}) };
    view.electronAPI = api;
    expect(getStreamBridge()).toBe(api);
  });

  it('в браузере моста нет — youtube.ts пойдёт своим запросом', () => {
    expect(getStreamBridge()).toBeNull();
  });

  it('на телефоне без адреса сервера музыка остаётся, радио и поиск — нет', () => {
    // Отдать здесь null значило бы отнять и воспроизведение, хотя ссылку
    // телефон добывает сам и сервер ей не нужен. Теряются ровно радио и поиск,
    // и об этом сказано в журнале, иначе разбираться будет не с чем.
    vi.stubEnv('VITE_WIREON_SERVER_URL', '');
    vi.stubEnv('VITE_WIREON_SERVER_TOKEN', '');
    const complained = vi.spyOn(console, 'warn').mockImplementation(() => {});
    view.Capacitor = { isNativePlatform: () => true };

    const bridge = getStreamBridge();
    expect(bridge).not.toBeNull();
    expect(typeof bridge!.resolveYouTubeStream).toBe('function');
    expect(bridge!.youtubeRadio).toBeUndefined();
    expect(bridge!.searchYouTube).toBeUndefined();
    expect(complained).toHaveBeenCalledWith(expect.stringContaining('VITE_WIREON_SERVER_URL'));
    vi.unstubAllEnvs();
  });

  it('на телефоне с адресом сервера есть и радио, и поиск, и ссылка', () => {
    vi.stubEnv('VITE_WIREON_SERVER_URL', 'https://music.example');
    vi.stubEnv('VITE_WIREON_SERVER_TOKEN', 'секрет');
    view.Capacitor = { isNativePlatform: () => true };

    const bridge = getStreamBridge();
    expect(typeof bridge!.resolveYouTubeStream).toBe('function');
    expect(typeof bridge!.youtubeRadio).toBe('function');
    expect(typeof bridge!.searchYouTube).toBe('function');
    vi.unstubAllEnvs();
  });
});

/**
 * Три ступени за ссылкой: yt-dlp на устройстве, `youtubei.js`, сервер.
 *
 * Порядок здесь — не вкусовщина, и проверяется именно он. `youtubei.js`
 * отвечает за секунду-две, но сегодня не отдаёт ни ссылки, ни манифеста ни у
 * одного клиента: он получает только SABR, который `<audio src>` не играет.
 * Поставить быструю, но всегда отказывающую ступень первой — значит добавлять
 * эти секунды к каждому треку впустую.
 */
describe('nativeBridge: yt-dlp на самом устройстве', () => {
  const VIDEO_ID = 'dQw4w9WgXcQ';
  const YTDLP_URL = 'https://rr5---sn-x.googlevideo.com/videoplayback?expire=1900000000&src=ytdlp';
  const INNERTUBE_URL = 'https://rr1---sn-x.googlevideo.com/videoplayback?expire=1900000000';

  const realElectron = (window as unknown as { electronAPI?: unknown }).electronAPI;

  /** Кладёт в окно телефон с работающим плагином. */
  function withYtDlp(resolveImpl: () => Promise<unknown>) {
    const spy = vi.fn(resolveImpl);
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        YtDlp: {
          available: async () => ({ available: true }),
          resolve: spy,
          update: async () => ({})
        }
      }
    };
    return spy;
  }

  /** `youtubei.js`, который что-то отдал. Нужен, чтобы поймать лишний вызов. */
  function innertubeSucceeds(): void {
    setInnertubeFactory(async () => ({
      getBasicInfo: async () => ({
        playability_status: { status: 'OK' },
        streaming_data: {
          adaptive_formats: [
            { has_audio: true, has_video: false, bitrate: 130000, url: INNERTUBE_URL }
          ],
          formats: []
        }
      }),
      session: { player: {} }
    }));
  }

  beforeEach(async () => {
    const { resetYtDlpAvailability } = await import('../../src/services/ytDlpOnDevice');
    resetYtDlpAvailability();
  });

  afterEach(async () => {
    const { resetYtDlpAvailability } = await import('../../src/services/ytDlpOnDevice');
    resetYtDlpAvailability();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    (window as unknown as { electronAPI?: unknown }).electronAPI = realElectron;
    resetInnertube();
    vi.restoreAllMocks();
  });

  it('удача yt-dlp — ни `youtubei.js`, ни сервер не спрашиваются', async () => {
    // Ради этого всё и делалось: домашний адрес вместо адреса дата-центра, где
    // YouTube требует доказать, что мы не робот.
    withYtDlp(async () => ({ streamUrl: YTDLP_URL, format: 'm4a', bitrate: 129, expiresAt: 1 }));
    innertubeSucceeds();
    const fetchSpy = vi.fn(async () => okResponse({}));
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    const resolved = (await bridge.resolveYouTubeStream!(VIDEO_ID)) as { streamUrl: string };

    expect(resolved.streamUrl).toBe(YTDLP_URL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('после отказа yt-dlp очередь доходит до `youtubei.js`', async () => {
    withYtDlp(async () => {
      throw new Error('YT_ALL_ATTEMPTS_FAILED: yt-dlp не отдал ссылку');
    });
    innertubeSucceeds();
    const fetchSpy = vi.fn(async () => okResponse({}));
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    const resolved = (await bridge.resolveYouTubeStream!(VIDEO_ID)) as { streamUrl: string };

    expect(resolved.streamUrl).toBe(INNERTUBE_URL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('«видео удалено» останавливает лестницу на первой же ступени', async () => {
    // Этот ответ одинаков и у телефона, и у сервера. Продолжать — значит
    // добавить полминуты ожидания к тому же самому «его нет».
    const ytDlp = withYtDlp(async () => {
      throw new Error('YT_UNAVAILABLE: видео удалено или недоступно');
    });
    innertubeSucceeds();
    const fetchSpy = vi.fn(async () => okResponse({}));
    const bridge = createServerBridge(CONFIG, fetchSpy as unknown as typeof fetch);

    await expect(bridge.resolveYouTubeStream!(VIDEO_ID)).rejects.toMatchObject({
      code: 'YT_UNAVAILABLE'
    });
    expect(ytDlp).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('телефон без адреса сервера играет через yt-dlp', async () => {
    // Сервер нужен радио и поиску; звук телефон добывает сам, и это ровно то,
    // ради чего ступень появилась.
    withYtDlp(async () => ({ streamUrl: YTDLP_URL, format: 'm4a', bitrate: 129, expiresAt: 1 }));
    resetStreamBridge();

    const bridge = getStreamBridge();
    const resolved = (await bridge!.resolveYouTubeStream!(VIDEO_ID)) as { streamUrl: string };

    expect(resolved.streamUrl).toBe(YTDLP_URL);
    resetStreamBridge();
  });
});
