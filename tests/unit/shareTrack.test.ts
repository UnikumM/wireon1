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
