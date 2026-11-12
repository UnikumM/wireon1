/**
 * Обложка сохранённого трека (4.0.2): лучшая из доступных, и её отсутствие не
 * мешает сохранить звук.
 */

import { describe, it, expect, vi } from 'vitest';
import '../setup';
import { fetchBestArtwork } from '../../src/services/offlineArtwork';

function image(bytes: number, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

function respond(blob: Blob | null, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, blob: async () => blob ?? new Blob([]) } as unknown as Response;
}

const SMALL = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg';

describe('fetchBestArtwork', () => {
  it('берёт самый крупный кадр, если он есть', async () => {
    const fetchSpy = vi.fn(async (_url: string) => respond(image(65_000)));
    const blob = await fetchBestArtwork(SMALL, fetchSpy as unknown as typeof fetch);

    expect(blob?.size).toBe(65_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/maxresdefault.jpg');
  });

  it('крупного кадра нет (404 или серая заглушка) — идёт к следующему варианту', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('maxresdefault')) return respond(image(1_100), 404);
      // Заглушка 120×90 приходит картинкой около килобайта — с любым статусом.
      if (url.includes('hq720')) return respond(image(1_100), 200);
      return respond(image(12_000));
    });
    const blob = await fetchBestArtwork(SMALL, fetchSpy as unknown as typeof fetch);

    expect(blob?.size).toBe(12_000);
    expect(fetchSpy.mock.calls.map((call) => String(call[0]).split('/').pop())).toEqual([
      'maxresdefault.jpg',
      'hq720.jpg',
      'mqdefault.jpg'
    ]);
  });

  it('SoundCloud и Google: просит крупный размер', async () => {
    const fetchSpy = vi.fn(async (_url: string) => respond(image(40_000)));
    await fetchBestArtwork('https://i1.sndcdn.com/artworks-abc-large.jpg', fetchSpy as unknown as typeof fetch);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('-t500x500.jpg');

    await fetchBestArtwork('https://lh3.googleusercontent.com/abc=w120-h120-l90-rj', fetchSpy as unknown as typeof fetch);
    expect(String(fetchSpy.mock.calls[1][0])).toContain('=w1200-h1200-l90-rj');
  });

  it('сеть упала, пришла не картинка или адреса нет — null, без исключений', async () => {
    const down = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    await expect(fetchBestArtwork(SMALL, down as unknown as typeof fetch)).resolves.toBeNull();

    const html = vi.fn(async () => respond(image(50_000, 'text/html')));
    await expect(fetchBestArtwork(SMALL, html as unknown as typeof fetch)).resolves.toBeNull();

    const never = vi.fn();
    await expect(fetchBestArtwork('', never as unknown as typeof fetch)).resolves.toBeNull();
    await expect(fetchBestArtwork('data:image/png;base64,AAAA', never as unknown as typeof fetch)).resolves.toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});
