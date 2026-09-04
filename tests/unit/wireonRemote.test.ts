import { describe, it, expect, afterEach, vi } from 'vitest';
import '../setup';
import { WireonRemoteAdapter, createWireonRemote, stripDeviceFields } from '../../src/services/wireonRemote';
import { Playlist, UnifiedTrack } from '../../src/types/music';

/**
 * Удалённая сторона синхронизации.
 *
 * Проверяется здесь не «сходил по адресу» — а четыре вещи, каждая из которых
 * ломает синхронизацию тихо:
 *
 * 1. Личность в запросе. Токен сервера лежит внутри APK; если бы шкаф выдавался
 *    по нему, чужие плейлисты читал бы любой распаковавший сборку.
 * 2. Ссылка на поток не должна уезжать: она привязана к адресу и живёт часы, на
 *    другом устройстве это мусор, который вдобавок раздувает отправку.
 * 3. Одно чтение на заход. Движок спрашивает три раза подряд, и три обращения по
 *    мобильной сети — втрое больше поводов не дождаться.
 * 4. Гость не «синхронизируется в никуда»: без токена Discord серверу нечего
 *    сказать, чей это шкаф.
 */

const BASE = 'https://music.example';
const SERVER_TOKEN = 'серверный-токен';
const DISCORD_TOKEN = 'токен-discord';

function track(id: string, extra: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id,
    title: 'Трек',
    artist: 'Кто-то',
    duration: 100,
    artworkUrl: '',
    ...extra
  };
}

function playlist(id: string, tracks: UnifiedTrack[] = []): Playlist {
  return { id, title: 'Список', tracks, createdAt: 1, updatedAt: 2, isSynced: false };
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function fail(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

function adapter(fetchImpl: typeof fetch, discordToken: string | null = DISCORD_TOKEN) {
  return new WireonRemoteAdapter({
    getDiscordToken: () => discordToken,
    baseUrl: BASE,
    serverToken: SERVER_TOKEN,
    fetchImpl
  });
}

const EMPTY_BODY = { playlists: [], favorites: [], deleted: { playlists: [], favorites: [] } };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('wireonRemote: настроенность', () => {
  it('без токена Discord обмен не настроен', () => {
    // Гость. Серверу нечего сказать, чей это шкаф, — складывать некуда.
    expect(adapter(vi.fn() as unknown as typeof fetch, null).isConfigured()).toBe(false);
  });

  it('с адресом, токеном сервера и токеном Discord — настроен', () => {
    expect(adapter(vi.fn() as unknown as typeof fetch).isConfigured()).toBe(true);
  });

  it('без адреса сервера в сборке адаптер не создаётся вовсе', () => {
    vi.stubEnv('VITE_WIREON_SERVER_URL', '');
    vi.stubEnv('VITE_WIREON_SERVER_TOKEN', '');
    expect(createWireonRemote(() => DISCORD_TOKEN)).toBeNull();
  });
});

describe('wireonRemote: кто спрашивает', () => {
  it('в запрос уходят оба токена', async () => {
    const fetchSpy = vi.fn(async () => ok(EMPTY_BODY));
    await adapter(fetchSpy as unknown as typeof fetch).pullPlaylists();

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://music.example/v1/sync');
    expect(headers['X-Wireon-Token']).toBe(SERVER_TOKEN);
    expect(headers['X-Discord-Token']).toBe(DISCORD_TOKEN);
  });

  it('токены не попадают в адрес: он оседает в журналах прокси', async () => {
    const fetchSpy = vi.fn(async () => ok(EMPTY_BODY));
    await adapter(fetchSpy as unknown as typeof fetch).pullFavorites();

    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).not.toContain(SERVER_TOKEN);
    expect(url).not.toContain(DISCORD_TOKEN);
  });

  it('без токена Discord запрос не уходит вовсе', async () => {
    const fetchSpy = vi.fn(async () => ok(EMPTY_BODY));
    await expect(
      adapter(fetchSpy as unknown as typeof fetch, null).pullPlaylists()
    ).rejects.toThrow(/WIREON_SYNC_NOT_AUTHENTICATED/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('wireonRemote: одно чтение на заход', () => {
  it('три чтения подряд стоят одного запроса', async () => {
    const fetchSpy = vi.fn(async () => ok(EMPTY_BODY));
    const remote = adapter(fetchSpy as unknown as typeof fetch);

    await remote.pullPlaylists();
    await remote.pullFavorites();
    await remote.pullDeletions();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('совпавшие по времени чтения ждут один запрос, а не заводят свой', async () => {
    let resolveIt: (value: Response) => void = () => {};
    const fetchSpy = vi.fn(
      () => new Promise<Response>((resolve) => { resolveIt = resolve; })
    );
    const remote = adapter(fetchSpy as unknown as typeof fetch);

    const both = Promise.all([remote.pullPlaylists(), remote.pullFavorites()]);
    resolveIt(ok(EMPTY_BODY));
    await both;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('после отправки запомненный ответ выбрасывается', async () => {
    // Иначе следующее чтение отдаст картину мира, устаревшую на нашу же правку.
    const fetchSpy = vi.fn(async () => ok({ ...EMPTY_BODY, playlists: 1 }));
    const remote = adapter(fetchSpy as unknown as typeof fetch);

    await remote.pullPlaylists();
    await remote.pushPlaylists([playlist('p1')]);
    await remote.pullPlaylists();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe('wireonRemote: что уезжает наружу', () => {
  it('ссылка на поток и её срок остаются на устройстве', () => {
    const stripped = stripDeviceFields(
      track('yt_1', { streamUrl: 'https://googlevideo.com/videoplayback?ip=1.2.3.4', streamExpiry: 123 })
    );
    expect(stripped.streamUrl).toBeUndefined();
    expect(stripped.streamExpiry).toBeUndefined();
    expect(stripped.title).toBe('Трек');
  });

  it('внутри плейлиста дорожки тоже чистятся', async () => {
    const fetchSpy = vi.fn(async () => ok({ playlists: 1 }));
    const remote = adapter(fetchSpy as unknown as typeof fetch);

    await remote.pushPlaylists([
      playlist('p1', [track('yt_1', { streamUrl: 'https://googlevideo.com/x', streamExpiry: 5 })])
    ]);

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent.playlists[0].tracks[0].streamUrl).toBeUndefined();
    expect(sent.playlists[0].tracks[0].streamExpiry).toBeUndefined();
  });

  it('пустая отправка не тратит запрос', async () => {
    const fetchSpy = vi.fn(async () => ok({ playlists: 0 }));
    const remote = adapter(fetchSpy as unknown as typeof fetch);

    expect(await remote.pushPlaylists([])).toBe(0);
    expect(await remote.pushFavorites([])).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('отдаётся принятое сервером, а не отправленное', async () => {
    // Сервер отбрасывает записи старше уже лежащих. Соврать здесь — значит
    // пометить локально отправленным то, чего на сервере нет.
    const remote = adapter((async () => ok({ playlists: 1 })) as unknown as typeof fetch);
    expect(await remote.pushPlaylists([playlist('p1'), playlist('p2')])).toBe(1);
  });
});

describe('wireonRemote: удаления', () => {
  it('удаление плейлиста идёт своим адресом', async () => {
    const fetchSpy = vi.fn(async () => ok({ deleted: true }));
    const remote = adapter(fetchSpy as unknown as typeof fetch);

    expect(await remote.deletePlaylist('p 1')).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://music.example/v1/sync/playlists/p%201');
    expect(init.method).toBe('DELETE');
  });

  it('удалённое на других устройствах читается вместе с остальным', async () => {
    const remote = adapter(
      (async () =>
        ok({
          ...EMPTY_BODY,
          deleted: { playlists: ['p9'], favorites: ['yt_9'] },
          deletedAt: { playlists: { p9: 1700 }, favorites: { yt_9: 1800 } }
        })) as unknown as typeof fetch
    );
    expect(await remote.pullDeletions()).toEqual({
      playlists: ['p9'],
      favorites: ['yt_9'],
      deletedAt: { playlists: { p9: 1700 }, favorites: { yt_9: 1800 } }
    });
  });

  it('сервер без дат удаления читается как раньше', async () => {
    // Сборка приложения обновляется раньше сервера, и это обычное дело: пока
    // дат нет, удаление применяется по факту, как до их появления.
    const remote = adapter(
      (async () =>
        ok({ ...EMPTY_BODY, deleted: { playlists: ['p9'], favorites: [] } })) as unknown as typeof fetch
    );
    expect(await remote.pullDeletions()).toEqual({
      playlists: ['p9'],
      favorites: [],
      deletedAt: { playlists: {}, favorites: {} }
    });
  });

  it('мусор вместо даты удаления отбрасывается, а не ломает разбор', async () => {
    const remote = adapter(
      (async () =>
        ok({
          ...EMPTY_BODY,
          deleted: { playlists: ['p9', 'p10'], favorites: [] },
          deletedAt: { playlists: { p9: 'вчера', p10: 1700 } }
        })) as unknown as typeof fetch
    );
    expect((await remote.pullDeletions()).deletedAt?.playlists).toEqual({ p10: 1700 });
  });

  it('пустой идентификатор запросом не становится', async () => {
    const fetchSpy = vi.fn(async () => ok({ deleted: true }));
    expect(await adapter(fetchSpy as unknown as typeof fetch).deleteFavorite('')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('wireonRemote: отказы', () => {
  it('код сервера доносится, а не теряется', async () => {
    const remote = adapter(
      (async () => fail(401, { error: 'DISCORD_TOKEN_REJECTED', detail: 'Discord ответил 401' })) as unknown as typeof fetch
    );
    await expect(remote.pullPlaylists()).rejects.toThrow(/^DISCORD_TOKEN_REJECTED: Discord ответил 401/);
  });

  it('ответ не в JSON всё равно даёт код из статуса', async () => {
    const remote = adapter(
      (async () =>
        ({
          ok: false,
          status: 503,
          json: async () => {
            throw new Error('это не JSON');
          }
        }) as unknown as Response) as unknown as typeof fetch
    );
    await expect(remote.pullFavorites()).rejects.toThrow(/^HTTP_503:/);
  });

  /**
   * «Failed to fetch» — три слова, которыми браузер отвечает на любую сетевую
   * беду: выключенный сервер, обрыв сети, запрет источнику. Владелец видел их в
   * меню аккаунта как есть и не мог понять, у него ли пропал интернет. Здесь
   * они превращаются в код, по которому наверху уже подбирается фраза.
   */
  it('сетевой отказ доносится кодом, а не словами браузера', async () => {
    const remote = adapter(
      (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch
    );
    await expect(remote.pullPlaylists()).rejects.toThrow(/^WIREON_SYNC_UNREACHABLE:/);
    // Исходная строка остаётся внутри — она нужна отчёту об ошибке.
    await expect(remote.pullFavorites()).rejects.toThrow(/Failed to fetch/);
  });

  it('мусор вместо списков не роняет чтение', async () => {
    // Сервер может ответить чем угодно; падать на этом означало бы, что одна
    // кривая строка отменяет всю синхронизацию.
    const remote = adapter((async () => ok({ playlists: 'не список' })) as unknown as typeof fetch);
    expect(await remote.pullPlaylists()).toEqual([]);
    expect(await remote.pullDeletions()).toEqual({
      playlists: [],
      favorites: [],
      deletedAt: { playlists: {}, favorites: {} }
    });
  });
});

/**
 * Ожидание изменений обычным запросом.
 *
 * Появилось потому, что на Android слушать брокер нельзя вовсе: страница живёт
 * на `https`, а брокер отвечает по `ws://`, и браузер запрещает такое
 * соединение сам (замерено на устройстве 2026-09-02). Обычные запросы оттуда
 * проходят — на них ожидание и построено.
 */
describe('wireonRemote: ожидание изменений', () => {
  it('спрашивает про изменения после известной отметки', async () => {
    const fetchImpl = vi.fn(async () => ok({ revision: 42, changed: true })) as unknown as typeof fetch;

    const answer = await adapter(fetchImpl).waitForChange(17);

    expect(answer).toEqual({ revision: 42, changed: true });
    const url = String(vi.mocked(fetchImpl).mock.calls[0][0]);
    expect(url).toContain('/v1/sync/wait?since=17');
  });

  it('ждёт дольше обычного запроса — в этом его смысл', async () => {
    // Обычный запрос обрывается по сроку в 20 секунд, а этот обязан висеть
    // дольше: сервер сам отпускает его на двадцати пяти.
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = vi.fn((_url: any, init: any) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch;

      void adapter(fetchImpl).waitForChange(0).catch(() => {});
      await vi.advanceTimersByTimeAsync(21_000);
      expect(aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('невнятный ответ не сдвигает отметку', async () => {
    // Иначе клиент запомнил бы мусор и перестал бы получать изменения вовсе.
    const fetchImpl = vi.fn(async () => ok({ revision: 'непонятно' })) as unknown as typeof fetch;

    const answer = await adapter(fetchImpl).waitForChange(9);

    expect(answer).toEqual({ revision: 9, changed: false });
  });
});
