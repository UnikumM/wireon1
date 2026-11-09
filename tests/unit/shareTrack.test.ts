import { describe, it, expect, afterEach, vi } from 'vitest';
import '../setup';
import { shareTrack, trackShareText, trackShareUrl } from '../../src/services/shareTrack';
import { UnifiedTrack } from '../../src/types/music';

const yt: UnifiedTrack = { id: 'yt_abc', source: 'youtube', originalId: 'abc', title: 'Кукушка', artist: 'Кино', duration: 400, artworkUrl: '' };
const sc: UnifiedTrack = { id: 'sc_1', source: 'soundcloud', originalId: '1', title: 'Song', artist: 'X', duration: 100, artworkUrl: '', sourceUrl: 'https://soundcloud.com/x/song' };

describe('3.0: поделиться треком', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ссылка: своя у источника, а без неё — YouTube Music по id', () => {
    expect(trackShareUrl(sc)).toBe('https://soundcloud.com/x/song');
    expect(trackShareUrl(yt)).toBe('https://music.youtube.com/watch?v=abc');
    expect(trackShareUrl({ ...sc, sourceUrl: undefined })).toBeNull();
    expect(trackShareText(yt)).toBe('Кино — Кукушка\nhttps://music.youtube.com/watch?v=abc');
  });

  it('на компьютере — в буфер обмена', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    expect(await shareTrack(yt)).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('Кино — Кукушка\nhttps://music.youtube.com/watch?v=abc');
  });

  it('без буфера — честный отказ', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    expect(await shareTrack(yt)).toBe('failed');
  });
});

describe('4.0: страница «поделиться» на своём сервере', () => {
  it('без сервера — ссылка на источник, с сервером — страница с названием, артистом и обложкой', async () => {
    const { trackSharePageUrl } = await import('../../src/services/shareTrack');
    expect(trackSharePageUrl(yt)).toBeNull();
    const page = trackSharePageUrl({ ...yt, artworkUrl: 'https://i.ytimg.com/vi/abc/hq.jpg' }, 'https://music.wireon.pro/');
    expect(page).toBe('https://music.wireon.pro/t/yt/abc?n=%D0%9A%D1%83%D0%BA%D1%83%D1%88%D0%BA%D0%B0&a=%D0%9A%D0%B8%D0%BD%D0%BE&img=https%3A%2F%2Fi.ytimg.com%2Fvi%2Fabc%2Fhq.jpg');
    // Для SoundCloud страница получает адрес записи: по числовому id у них ничего не открыть.
    expect(trackSharePageUrl(sc, 'https://music.wireon.pro')).toContain('/t/sc/1?n=Song&a=X&u=https%3A%2F%2Fsoundcloud.com%2Fx%2Fsong');
    // Обложка по http и id с мусором на страницу не попадают.
    expect(trackSharePageUrl({ ...yt, artworkUrl: 'http://x/y.jpg' }, 'https://s')).toBe('https://s/t/yt/abc?n=%D0%9A%D1%83%D0%BA%D1%83%D1%88%D0%BA%D0%B0&a=%D0%9A%D0%B8%D0%BD%D0%BE');
    expect(trackSharePageUrl({ ...yt, originalId: 'a/b' }, 'https://s')).toBeNull();
  });
});
