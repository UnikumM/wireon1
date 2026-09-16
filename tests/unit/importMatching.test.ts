/**
 * Перенос чужой библиотеки: разбор названий, ширина выдачи, память о выборе.
 *
 * Почему этот набор вообще появился. Замерено 2026-09-16 на живых запросах к
 * каталогу YouTube Music: из восемнадцати строк в стиле библиотеки Spotify
 * находились девять, и **ни один** из девяти провалов не был виной оценщика.
 * Все три причины лежали до поиска:
 *
 *   • «Bohemian Rhapsody - Remastered 2011» — в каталоге запись называется
 *     «Bohemian Rhapsody», слов «remastered» и «2011» у кандидата нет, и фильтр
 *     названия выбрасывал всех кандидатов до подсчёта очков;
 *   • «Save Your Tears (with Ariana Grande)» — то же самое со скобками: лучший
 *     кандидат набирал 140 из 140 и отбрасывался;
 *   • кандидатов приходило около четырёх на строку, и правильная запись,
 *     лежащая в выдаче шестой, не рассматривалась вовсе.
 *
 * Здесь проверяется, что все три починены и что цена починки не заплачена
 * молчаливой подменой версии: у «Numb - Live» обязана найтись именно живая.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PlaylistImporterService,
  fetchSpotifyPlaylistFull,
  spotifyEmbedToken,
  type ParsedPlaylistItem
} from '../../src/services/playlistImporter';
import { searchAggregator } from '../../src/services/aggregator';
import { detectVariants, splitCatalogTitle, scoreCandidate } from '../../src/services/trackMatching';
import { db } from '../../src/services/db';
import { findLink, forgetLink, linkKey, rememberLink } from '../../src/services/matchLinks';
import { UnifiedTrack } from '../../src/types/music';

function track(partial: Partial<UnifiedTrack> & { title: string }): UnifiedTrack {
  return {
    id: partial.id || `yt_${partial.title}`,
    source: partial.source || 'youtube',
    originalId: partial.originalId || partial.title,
    artist: partial.artist ?? 'The Weeknd',
    duration: partial.duration ?? 200,
    artworkUrl: '',
    ...partial
  } as UnifiedTrack;
}

describe('Разбор названия из чужого каталога', () => {
  it('отделяет хвост версии, оставляя название, по которому ищут', () => {
    expect(splitCatalogTitle('Bohemian Rhapsody - Remastered 2011')).toMatchObject({
      base: 'Bohemian Rhapsody',
      version: 'Remastered 2011'
    });
    expect(splitCatalogTitle('Hotel California - 2013 Remaster').base).toBe('Hotel California');
    expect(splitCatalogTitle('Wish You Were Here - 2011 Remastered Version').base).toBe(
      'Wish You Were Here'
    );
  });

  it('вынимает соавторов из скобок — у кандидата их в названии нет', () => {
    const split = splitCatalogTitle('Save Your Tears (with Ariana Grande) - Remix');
    expect(split.base).toBe('Save Your Tears');
    expect(split.version).toBe('Remix');
    expect(split.collaborators).toContain('Ariana Grande');

    expect(splitCatalogTitle('Levitating (feat. DaBaby)').base).toBe('Levitating');
    expect(splitCatalogTitle('STAY (with Justin Bieber)').base).toBe('STAY');
  });

  it('не трогает названия, где тире — часть имени', () => {
    // Иначе у «Смысловых галлюцинаций» от песни осталась бы половина.
    expect(splitCatalogTitle('Sunday Bloody Sunday').version).toBeNull();
    expect(splitCatalogTitle('Кино - Пачка сигарет').version).toBeNull();
    expect(splitCatalogTitle('Mr. Brightside - Jacques Lu Cont Mix').base).toBe('Mr. Brightside');
  });

  it('переделка, подписанная именем, — это ремикс', () => {
    expect(detectVariants('Hot Together (Seph Martin Vice City Mix)')).toContain('remix');
    expect(detectVariants('Hot Together (Daun Lou Edit) FREE DL')).toContain('remix');
    expect(detectVariants('Mr. Brightside - Jacques Lu Cont Mix')).toContain('remix');
    // А вот это — оригинал и радиоверсия, у них свои пометки.
    expect(detectVariants('Song (Original Mix)')).not.toContain('remix');
    expect(detectVariants('Song (Radio Edit)')).not.toContain('remix');
  });

  it('не съедает название целиком, если после тире стоит вся песня', () => {
    // «Live» одним словом — это название, а не пометка: отрезать нечего.
    const split = splitCatalogTitle('Live');
    expect(split.base).toBe('Live');
    expect(split.version).toBeNull();
  });

  it('совпавший альбом прибавляет очков, разошедшийся — не отнимает', () => {
    // Издания называются по-разному («After Hours» против «After Hours
    // (Deluxe)»), поэтому расхождение ничего не доказывает.
    const withAlbum = scoreCandidate(
      { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours' },
      track({ title: 'Blinding Lights', album: 'After Hours (Deluxe)' })
    );
    const without = scoreCandidate(
      { title: 'Blinding Lights', artist: 'The Weeknd' },
      track({ title: 'Blinding Lights', album: 'After Hours (Deluxe)' })
    );
    expect(withAlbum.score).toBeGreaterThan(without.score);

    const mismatched = scoreCandidate(
      { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours' },
      track({ title: 'Blinding Lights', album: 'Starboy' })
    );
    expect(mismatched.score).toBe(without.score);
  });
});

describe('Перенос: поиск пары для строки', () => {
  let service: PlaylistImporterService;

  beforeEach(async () => {
    service = new PlaylistImporterService();
    await db.matchLinks.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Перехватывает поиск и запоминает, что именно спрашивали. */
  function mockSearch(reply: (query: string) => UnifiedTrack[]) {
    const queries: string[] = [];
    const spy = vi.spyOn(searchAggregator, 'search').mockImplementation(async (query: string) => {
      queries.push(query);
      const results = reply(query);
      return { results, sources: { youtube: results.length, soundcloud: 0 } };
    });
    return { queries, spy };
  }

  it('находит ремастер по имени записи в каталоге', async () => {
    const { queries } = mockSearch(() => [
      track({ title: 'Bohemian Rhapsody', artist: 'Queen', duration: 355 })
    ]);

    const [match] = await service.matchImportedTracks([
      { title: 'Bohemian Rhapsody - Remastered 2011', artist: 'Queen', duration: 354 }
    ]);

    expect(queries[0]).toBe('Queen Bohemian Rhapsody');
    expect(match.track?.title).toBe('Bohemian Rhapsody');
  });

  it('находит запись, когда соавторы указаны в скобках', async () => {
    mockSearch(() => [track({ title: 'STAY', artist: 'The Kid LAROI', duration: 142 })]);

    const [match] = await service.matchImportedTracks([
      { title: 'STAY (with Justin Bieber)', artist: 'The Kid LAROI, Justin Bieber', duration: 141 }
    ]);

    expect(match.track?.title).toBe('STAY');
  });

  it('просит у каталога двадцать кандидатов, а не четыре', async () => {
    const { spy } = mockSearch(() => [track({ title: 'Numb', artist: 'Linkin Park', duration: 185 })]);

    await service.matchImportedTracks([{ title: 'Numb', artist: 'Linkin Park', duration: 185 }]);

    expect(spy).toHaveBeenCalledWith('Linkin Park Numb', { source: 'youtube', limit: 20 });
  });

  it('просили живую запись — студийная не подходит', async () => {
    // Цена отделения хвоста версии: без этой проверки «Numb - Live» нашёл бы
    // обычную студийную запись и подменил бы её молча.
    mockSearch(() => [track({ title: 'Numb', artist: 'Linkin Park', duration: 185 })]);

    const [match] = await service.matchImportedTracks([
      { title: 'Numb - Live', artist: 'Linkin Park', duration: 195 }
    ]);

    expect(match.track).toBeNull();
  });

  it('просили живую запись — живая подходит', async () => {
    const { queries } = mockSearch(() => [
      track({ title: 'Numb (Live In Texas)', artist: 'Linkin Park', duration: 195 })
    ]);

    const [match] = await service.matchImportedTracks([
      { title: 'Numb - Live', artist: 'Linkin Park', duration: 195 }
    ]);

    expect(queries[0]).toBe('Linkin Park Numb Live');
    expect(match.track?.title).toBe('Numb (Live In Texas)');
  });

  it('второй проход ищет по одному названию — и только у ненайденных', async () => {
    // В чужих выгрузках имя исполнителя пишут иначе («Kino» против «Кино»), и
    // запрос целиком уводит в сторону. Но платить вторым запросом за всю
    // библиотеку незачем — только за остаток.
    const { queries } = mockSearch((query) =>
      query === 'Пачка сигарет'
        ? [track({ title: 'Пачка сигарет', artist: 'Кино', duration: 267 })]
        : []
    );

    const matches = await service.matchImportedTracks([
      { title: 'Пачка сигарет', artist: 'Kino', duration: 267 }
    ]);

    // Первый запрос повторяется у SoundCloud: каталог не ответил ничем.
    expect(queries.slice(0, 2)).toEqual(['Kino Пачка сигарет', 'Kino Пачка сигарет']);
    expect(queries[queries.length - 1]).toBe('Пачка сигарет');
    expect(matches[0].track?.artist).toBe('Кино');
  });

  it('подтверждённую строку не ищет вовсе', async () => {
    const item: ParsedPlaylistItem = { title: 'Numb', artist: 'Linkin Park', duration: 185 };
    await rememberLink(item, track({ title: 'Numb', originalId: 'numb1', artist: 'Linkin Park' }), true);

    const { spy } = mockSearch(() => []);
    const [match] = await service.matchImportedTracks([item]);

    expect(spy).not.toHaveBeenCalled();
    expect(match.track?.originalId).toBe('numb1');
    expect(match.notes).toContain('выбрано вами раньше');
  });
});

describe('Память о подтверждённых соответствиях', () => {
  beforeEach(async () => {
    await db.matchLinks.clear();
  });

  it('ключ переживает разницу в написании и секунду длительности', () => {
    expect(linkKey({ title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 })).toBe(
      linkKey({ title: 'blinding  lights', artist: 'the weeknd', duration: 202 })
    );
  });

  it('ключ различает версии разной длины', () => {
    expect(linkKey({ title: 'Song', artist: 'X', duration: 180 })).not.toBe(
      linkKey({ title: 'Song', artist: 'X', duration: 240 })
    );
  });

  it('выбор человека не перебивается автоматическим', async () => {
    const target = { title: 'Song', artist: 'X', duration: 180 };
    await rememberLink(target, track({ title: 'Правильная', originalId: 'right' }), true);
    await rememberLink(target, track({ title: 'Угаданная', originalId: 'guessed' }));

    expect((await findLink(target))?.originalId).toBe('right');
  });

  it('строка без названия ключа не имеет', () => {
    expect(linkKey({ title: '   ' })).toBe('');
  });

  it('живая запись и студийная — разные связи', () => {
    // Иначе подтверждённая однажды студийная версия молча отвечала бы на
    // просьбу о живой: связь сама стала бы источником подмены.
    expect(linkKey({ title: 'Numb', artist: 'Linkin Park', duration: 185 })).not.toBe(
      linkKey({ title: 'Numb - Live', artist: 'Linkin Park', duration: 185 })
    );
  });

  it('ремастер и обычное издание — одна связь', () => {
    // «Remastered 2011» не делает запись другой: пометки версии у неё нет.
    expect(linkKey({ title: 'Bohemian Rhapsody - Remastered 2011', artist: 'Queen', duration: 354 })).toBe(
      linkKey({ title: 'Bohemian Rhapsody', artist: 'Queen', duration: 354 })
    );
  });

  it('идентификатор чужого каталога хранится рядом со связью', async () => {
    const target = {
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      duration: 200,
      sourceId: '0VjIjW4GlUZAMYd2vXMi3b',
      sourcePlatform: 'spotify'
    };
    await rememberLink(target, track({ title: 'Blinding Lights', originalId: 'bl1' }), true);

    const link = await findLink(target);
    expect(link?.foreignId).toBe('0VjIjW4GlUZAMYd2vXMi3b');
    expect(link?.foreignPlatform).toBe('spotify');
  });

  it('связь можно забыть', async () => {
    const target = { title: 'Song', artist: 'X', duration: 180 };
    await rememberLink(target, track({ title: 'Правильная', originalId: 'right' }), true);
    await forgetLink(target);
    expect(await findLink(target)).toBeNull();
  });
});

describe('Оценка идёт до отбора, а не после', () => {
  let service: PlaylistImporterService;

  beforeEach(async () => {
    service = new PlaylistImporterService();
    await db.matchLinks.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('чужой исполнитель не проходит, когда своего отсеял фильтр названия', async () => {
    /*
     * Поймано на живой выборке из 180 строк Spotify: строке «Do For Love» (LP
     * Giobbi и другие) подставлялась «Do For Love (feat. AMEE)» — B Ray.
     *
     * Механика: запись нужного исполнителя называлась иначе и отсеивалась по
     * названию, а вместе с ней исчезал повод для штрафа за чужого исполнителя —
     * штраф-то относительный. Оставшаяся чужая запись набирала проходной балл.
     */
    vi.spyOn(searchAggregator, 'search').mockImplementation(async () => {
      const results = [
        // Свой исполнитель, но название другое — отбор по названию его срежет.
        track({
          id: 'yt_right',
          title: 'Do For Love (Extended Mix)',
          artist: 'LP Giobbi',
          duration: 320
        }),
        // Чужой исполнитель, зато название подходит дословно.
        track({ id: 'yt_wrong', title: 'Do For Love (feat. AMEE)', artist: 'B Ray', duration: 190 })
      ];
      return { results, sources: { youtube: results.length, soundcloud: 0 } };
    });

    const [match] = await service.matchImportedTracks([
      { title: 'Do For Love', artist: 'LP Giobbi, Bruno Be, Carola', duration: 194 }
    ]);

    expect(match.track).toBeNull();
  });

  it('транслитерация — тот же исполнитель, и штраф его не трогает', async () => {
    /*
     * Пара к предыдущему случаю: два требования тянут в разные стороны, и тест
     * держит оба. Spotify пишет «Sharlot», каталог — «Шарлот». Рядом лежит
     * другая песня с полем «Sharlot», и если транслитерацию не узнать, она
     * включает штраф и сбивает верную запись ниже порога. Замерено на
     * реальном плейлисте владельца.
     */
    vi.spyOn(searchAggregator, 'search').mockImplementation(async () => {
      const results = [
        track({ id: 'yt_other', title: 'Другая песня', artist: 'Sharlot', duration: 190 }),
        track({ id: 'yt_right', title: 'Я не один', artist: 'Шарлот', duration: 160 })
      ];
      return { results, sources: { youtube: results.length, soundcloud: 0 } };
    });

    const [match] = await service.matchImportedTracks([
      { title: 'Я не один', artist: 'Sharlot', duration: 160 }
    ]);

    expect(match.track?.id).toBe('yt_right');
  });
});

describe('Страница плейлиста Spotify', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Встраиваемая страница в том виде, в каком её отдаёт Spotify. */
  function embedHtml(tracks: Array<{ title: string; subtitle: string; duration: number }>, token = 'anon-token') {
    const data = {
      props: {
        pageProps: {
          state: {
            settings: { session: { accessToken: token } },
            data: { entity: { name: 'заплуп', trackList: tracks } }
          }
        }
      }
    };
    return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
  }

  function page(names: string[], total: number) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        data: {
          playlistV2: {
            content: {
              totalCount: total,
              items: names.map((name) => ({
                itemV2: {
                  data: {
                    __typename: 'Track',
                    name,
                    uri: `spotify:track:${name}`,
                    artists: { items: [{ profile: { name: 'isq' } }] },
                    trackDuration: { totalMilliseconds: 96000 },
                    albumOfTrack: { name: 'pursuit', coverArt: { sources: [{ url: 'https://i.scdn.co/x' }] } }
                  }
                }
              }))
            }
          }
        }
      })
    };
  }

  it('исполнитель берётся из subtitle, а не теряется', async () => {
    /*
     * Все строки плейлиста приходили как «Неизвестный исполнитель»: страница
     * кладёт имя в subtitle, а разбор его не читал. Подбор шёл по одному
     * названию — отсюда «Pursuit» чужого автора.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('pathfinder')
          ? { ok: false, status: 400, headers: { get: (): string | null => null }, json: async () => ({}) }
          : {
              ok: true,
              status: 200,
              headers: { get: (): string | null => 'text/html' },
              text: async () => embedHtml([{ title: 'pursuit', subtitle: 'isq,\u00a0Kordhell', duration: 96000 }])
            }
      )
    );

    const parsed = await new PlaylistImporterService().parsePlaylistUrl(
      'https://open.spotify.com/playlist/1JlTGPhqOTeR9HTKGmUEVh'
    );

    expect(parsed.items[0]).toMatchObject({ title: 'pursuit', artist: 'isq, Kordhell', duration: 96 });
  });

  it('ключ веб-плеера достаётся из страницы', () => {
    expect(spotifyEmbedToken(embedHtml([], 'abc'))).toBe('abc');
    expect(spotifyEmbedToken('<html></html>')).toBeNull();
  });

  it('полный список читается постранично, дальше первой сотни', async () => {
    // Плейлист на 159 треков переносился как 100: страница больше не отдаёт.
    const first = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const second = Array.from({ length: 59 }, (_, i) => `u${i}`);
    const fetchMock = vi.fn().mockResolvedValueOnce(page(first, 159)).mockResolvedValueOnce(page(second, 159));
    vi.stubGlobal('fetch', fetchMock);

    const items = await fetchSpotifyPlaylistFull('5efT5CmBVPcKDrmLLI8zVw', 'anon-token');

    expect(items).toHaveLength(159);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(String(fetchMock.mock.calls[1][0]))).toContain('"offset":100');
    expect(items?.[0]).toMatchObject({ artist: 'isq', duration: 96, album: 'pursuit', sourceId: 't0' });
  });

  it('если внутренний API не ответил — остаётся страница, без ошибки', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }));
    expect(await fetchSpotifyPlaylistFull('x', 'anon-token')).toBeNull();
    expect(await fetchSpotifyPlaylistFull('x', null)).toBeNull();
  });

  it('«VAI DO TRAIR» — не «VAI VAI TRAIR»: короткие слова названия тоже сверяются', async () => {
    vi.spyOn(searchAggregator, 'search').mockImplementation(async () => {
      const results = [
        track({ id: 'yt_wrong', title: 'VAI VAI TRAIR (Ultra Slowed)', artist: 'DJ Asul', duration: 135 }),
        track({ id: 'yt_right', title: 'VAI DO TRAIR (Ultra Slowed)', artist: 'DJ Asul', duration: 136 })
      ];
      return { results, sources: { youtube: results.length, soundcloud: 0 } };
    });

    const [match] = await new PlaylistImporterService().matchImportedTracks([
      { title: 'VAI DO TRAIR - Ultra Slowed', artist: 'DJ Asul, DJ Javi26', duration: 135 }
    ]);

    expect(match.track?.id).toBe('yt_right');
  });
});
