/**
 * Своя обложка плейлиста.
 *
 * Раньше картинку считали из состава — мозаикой из четырёх обложек треков, — и
 * поставить свою было нельзя. Четыре плейлиста одного артиста от этого
 * различались хуже, чем по любой своей картинке.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '../setup';
import { PlaylistCover } from '../../src/components/library/PlaylistCover';
import { prepareCoverImage, MAX_SOURCE_BYTES } from '../../src/services/playlistCover';
import { clearAllData, createPlaylist, setPlaylistCover, getPlaylistById } from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

function track(id: string, art: string): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id,
    title: `Track ${id}`,
    artist: 'Daft Punk',
    duration: 200,
    artworkUrl: art
  };
}

describe('вид обложки', () => {
  afterEach(cleanup);

  it('своя картинка вытесняет мозаику', () => {
    render(
      <PlaylistCover
        tracks={[track('a', 'a.jpg'), track('b', 'b.jpg')]}
        coverUrl="data:image/jpeg;base64,AAAA"
      />
    );

    const cover = screen.getByTestId('playlist-cover');
    expect(cover.getAttribute('data-tiles')).toBe('custom');
    expect(cover.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
  });

  it('без своей картинки остаётся мозаика из состава', () => {
    render(<PlaylistCover tracks={[track('a', 'a.jpg'), track('b', 'b.jpg')]} />);

    expect(screen.getByTestId('playlist-cover').getAttribute('data-tiles')).toBe('2');
  });
});

describe('подготовка картинки', () => {
  it('не картинку и слишком большой файл не принимает', async () => {
    const notImage = new File(['x'], 'song.mp3', { type: 'audio/mpeg' });
    await expect(prepareCoverImage(notImage)).rejects.toThrow('Это не картинка');

    const huge = new File([new Uint8Array(8)], 'big.jpg', { type: 'image/jpeg' });
    Object.defineProperty(huge, 'size', { value: MAX_SOURCE_BYTES + 1 });
    await expect(prepareCoverImage(huge)).rejects.toThrow('слишком большая');
  });
});

describe('хранение обложки', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('обложка ставится и снимается', async () => {
    const playlist = await createPlaylist('Вечер');

    await setPlaylistCover(playlist.id, 'data:image/jpeg;base64,AAAA');
    expect((await getPlaylistById(playlist.id))?.coverUrl).toBe('data:image/jpeg;base64,AAAA');

    // `null` — это не «нет картинки», а «считать её из состава»: поле должно
    // исчезнуть, иначе мозаика не вернётся.
    await setPlaylistCover(playlist.id, null);
    const cleared = await getPlaylistById(playlist.id);
    expect(cleared?.coverUrl).toBeUndefined();
    expect('coverUrl' in (cleared ?? {})).toBe(false);
  });
});
