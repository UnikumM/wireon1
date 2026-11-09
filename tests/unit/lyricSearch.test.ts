import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../setup';
import { db } from '../../src/services/db';
import { youtubeService } from '../../src/services/youtube';
import {
  findLyricFragment,
  looksLikeLyricLine,
  matchLibraryTrack,
  normalizeLine,
  searchByLyricLine,
  searchLocalLyrics,
  searchLyricsOnline
} from '../../src/services/lyricSearch';
import { installFetchMock, jsonResponse } from '../helpers/testUtils';
import { createMockTrack } from '../helpers/mockData';

const LINE = 'а свет в окне не гаснет';
const TEXT = 'Ночь. Дорога домой,\nА свет в окне не гаснет — ждут меня.\nИ снова в путь.';

function lyrics(key: string, plainLyrics: string | null, extra: Record<string, unknown> = {}) {
  return {
    key,
    fetchedAt: Date.now(),
    result: plainLyrics === null ? null : { synced: false, lines: [], plainLyrics, ...extra }
  };
}

describe('lyricSearch: эвристика и нормализация', () => {
  it('строчкой считается фраза от четырёх слов без ссылки и не из одних цифр', () => {
    expect(looksLikeLyricLine(LINE)).toBe(true);
    expect(looksLikeLyricLine('  А свет, в окне — не гаснет!  ')).toBe(true);
    expect(looksLikeLyricLine('кино группа крови')).toBe(false);
    expect(looksLikeLyricLine('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(looksLikeLyricLine('открой www.example.com и слушай там')).toBe(false);
    expect(looksLikeLyricLine('soundcloud.com/kto/chto и ещё слова тут')).toBe(false);
    expect(looksLikeLyricLine('1 2 3 4 5')).toBe(false);
    expect(looksLikeLyricLine('')).toBe(false);
    expect(looksLikeLyricLine(undefined)).toBe(false);
  });

  it('нормализация убирает регистр, знаки, диакритику и «ё»', () => {
    expect(normalizeLine('А Свет, в окне — не гаснет!')).toBe('а свет в окне не гаснет');
    expect(normalizeLine('Ещё  раз')).toBe('еще раз');
    expect(normalizeLine('Café déjà vu')).toBe('cafe deja vu');
  });

  it('фрагмент режется по строке и сохраняет написание текста', () => {
    const hit = findLyricFragment(TEXT, 'свет в окне не ГАСНЕТ');
    expect(hit).toEqual({ before: 'А ', line: 'свет в окне не гаснет', after: ' — ждут меня.' });
  });

  it('совпадение на стыке строк находится, цитата берёт обе строки', () => {
    const hit = findLyricFragment(TEXT, 'ждут меня и снова');
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe('ждут меня.\nИ снова');
    expect(hit!.before).toBe('А свет в окне не гаснет — ');
    expect(hit!.after).toBe(' в путь.');
  });

  it('нет строчки — нет фрагмента', () => {
    expect(findLyricFragment(TEXT, 'совсем другие слова здесь')).toBeNull();
    expect(findLyricFragment('', LINE)).toBeNull();
    expect(findLyricFragment(TEXT, '')).toBeNull();
  });
});

describe('lyricSearch: локальные тексты', () => {
  beforeEach(async () => {
    await db.lyrics.clear();
  });

  it('находит строчку в сохранённых текстах и подбирает трек медиатеки по ключу', async () => {
    const inLibrary = createMockTrack({ id: 'yt_lib1', title: 'Дорога домой (Official Video)', artist: 'Кино - Topic' });
    const manual = createMockTrack({ id: 'yt_manual1', title: 'Ручной выбор', artist: 'Кто-то' });
    await db.lyrics.bulkPut([
      lyrics('кино:::дорога домой', TEXT, { trackName: 'Дорога домой', artistName: 'Кино' }),
      lyrics('manual:::yt_manual1', 'Припев: а свет в окне не гаснет\nкуплет'),
      lyrics('другой:::трек', 'Совсем другие слова\nи ещё строка', { trackName: 'Другой', artistName: 'Трек' }),
      lyrics('пусто:::ничего', null)
    ]);

    const hits = await searchLocalLyrics(LINE, { tracks: [inLibrary, manual] });

    expect(hits.map((hit) => hit.track?.id).sort()).toEqual(['yt_lib1', 'yt_manual1']);
    const byKey = hits.find((hit) => hit.key === 'кино:::дорога домой')!;
    expect(byKey.origin).toBe('local');
    expect(byKey.title).toBe('Дорога домой');
    expect(byKey.artist).toBe('Кино');
    expect(byKey.line).toBe('А свет в окне не гаснет');
    expect(byKey.before).toBe('');
    expect(byKey.after).toBe(' — ждут меня.');

    const byId = hits.find((hit) => hit.trackId === 'yt_manual1')!;
    expect(byId.title).toBe('Ручной выбор');
    expect(byId.after).toBe('');
  });

  it('совпадение без трека в медиатеке всё равно возвращается — с названием из ключа', async () => {
    await db.lyrics.put(lyrics('земфира:::искала', 'А я искала тебя, искала везде'));
    const hits = await searchLocalLyrics('искала тебя искала везде', { tracks: [] });
    expect(hits).toHaveLength(1);
    expect(hits[0].track).toBeUndefined();
    expect(hits[0]).toMatchObject({ title: 'искала', artist: 'земфира' });
  });

  it('ручной выбор без трека и без названия не показывается', async () => {
    await db.lyrics.put(lyrics('manual:::yt_gone', TEXT));
    expect(await searchLocalLyrics(LINE, { tracks: [] })).toEqual([]);
  });

  it('matchLibraryTrack: сначала по id, потом по ключу «исполнитель:::название»', () => {
    const a = createMockTrack({ id: 'yt_a', title: 'Группа крови', artist: 'Кино' });
    const b = createMockTrack({ id: 'yt_b', title: 'Другое', artist: 'Кино' });
    expect(matchLibraryTrack({ key: 'кино:::группа крови' }, [b, a])?.id).toBe('yt_a');
    expect(matchLibraryTrack({ key: 'manual:::yt_b', trackId: 'yt_b' }, [a, b])?.id).toBe('yt_b');
    expect(matchLibraryTrack({ key: 'никто:::ничто' }, [a, b])).toBeUndefined();
  });
});

describe('lyricSearch: ступень LRCLIB', () => {
  beforeEach(async () => {
    await db.lyrics.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('оставляет только записи, где строчка действительно есть', async () => {
    const mock = installFetchMock([
      {
        match: 'lrclib.net/api/search',
        respond: () =>
          jsonResponse([
            { id: 1, trackName: 'Дорога домой', artistName: 'Кино', plainLyrics: TEXT },
            { id: 2, trackName: 'Чужая', artistName: 'Группа', plainLyrics: 'про свет и окна, но не так' },
            { id: 3, trackName: 'Дорога домой', artistName: 'Кино', plainLyrics: TEXT },
            { id: 4, trackName: 'Инструментал', artistName: 'Кто-то', instrumental: true }
          ])
      }
    ]);

    const hits = await searchLyricsOnline(LINE);

    expect(mock.calls[0]).toContain(`q=${encodeURIComponent(LINE)}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ origin: 'lrclib', key: 'lrclib:::1', title: 'Дорога домой', artist: 'Кино', line: 'А свет в окне не гаснет', before: '', after: ' — ждут меня.' });
  });

  it('короткий запрос в сеть не ходит', async () => {
    const mock = installFetchMock([]);
    expect(await searchLyricsOnline('группа крови')).toEqual([]);
    expect(mock.calls).toEqual([]);
  });

  it('searchByLyricLine: локальное сверху, LRCLIB без дублей, трек по названию через YouTube', async () => {
    const inLibrary = createMockTrack({ id: 'yt_lib1', title: 'Дорога домой', artist: 'Кино' });
    await db.lyrics.put(lyrics('кино:::дорога домой', TEXT, { trackName: 'Дорога домой', artistName: 'Кино' }));
    installFetchMock([
      {
        match: 'lrclib.net/api/search',
        respond: () =>
          jsonResponse([
            { id: 1, trackName: 'Дорога домой', artistName: 'Кино', plainLyrics: TEXT },
            { id: 5, trackName: 'Окно', artistName: 'Сплин', plainLyrics: 'а свет в окне не гаснет никогда' },
            { id: 6, trackName: 'Пропавшая', artistName: 'Никто', plainLyrics: 'а свет в окне не гаснет' }
          ])
      }
    ]);
    const found = createMockTrack({ id: 'yt_splin', title: 'Окно', artist: 'Сплин' });
    const search = vi.spyOn(youtubeService, 'search').mockImplementation(async (q) => (q.includes('Сплин') ? [found] : []));

    const result = await searchByLyricLine(LINE, { tracks: [inLibrary] });

    expect(result.local.map((hit) => hit.track.id)).toEqual(['yt_lib1']);
    expect(result.online.map((hit) => hit.track.id)).toEqual(['yt_splin']);
    expect(result.online[0].after).toBe(' никогда');
    // Для песни из медиатеки YouTube не спрашивали, для ненайденной — спросили и отпустили.
    expect(search).toHaveBeenCalledWith('Сплин Окно', 3);
    expect(search).toHaveBeenCalledWith('Никто Пропавшая', 3);
    expect(search).not.toHaveBeenCalledWith('Кино Дорога домой', 3);
  });

  it('обычный запрос и сбой сети не ломают поиск', async () => {
    installFetchMock([{ match: 'lrclib.net', respond: () => { throw new Error('сеть упала'); } }]);
    expect(await searchByLyricLine('группа крови', { tracks: [] })).toEqual({ local: [], online: [] });
    expect(await searchByLyricLine(LINE, { tracks: [] })).toEqual({ local: [], online: [] });
  });
});
