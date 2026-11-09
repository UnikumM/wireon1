import { describe, it, expect, vi, afterEach } from 'vitest';
import { downloadHlsAudio, isHlsPlaylistText } from '../../src/services/hlsDownload';

/**
 * Сборка HLS в один файл для офлайна. Ломается молча: перепутанный порядок
 * кусков или забытый init дают файл, который «сохранился», но не играет.
 */

const BASE = 'https://cdn.example/track/aac/playlist.m3u8?sig=abc';

function serve(routes: Record<string, string | number>) {
  const calls: string[] = [];
  global.fetch = vi.fn().mockImplementation(async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((name) => new URL(url).pathname.endsWith(name));
    const body = key ? routes[key] : 404;
    return typeof body === 'number' ? new Response('', { status: body }) : new Response(body);
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('downloadHlsAudio', () => {
  it('fMP4: init и куски подряд, адреса — относительно плейлиста', async () => {
    const calls = serve({ 'init.mp4': 'I', 'a.m4s': 'A', 'b.m4s': 'B' });
    const progress = vi.fn();

    const blob = await downloadHlsAudio(
      BASE,
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?k=1"\n#EXTINF:10,\na.m4s?k=2\n#EXTINF:9.9,\nb.m4s?k=3\n#EXT-X-ENDLIST',
      undefined,
      progress
    );

    expect(await blob.text()).toBe('IAB');
    expect(blob.type).toBe('audio/mp4');
    expect(calls[0]).toBe('https://cdn.example/track/aac/init.mp4?k=1');
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });

  it('MP3 без init — просто кадры подряд', async () => {
    serve({ '1.mp3': 'ID3-one', '2.mp3': '-two' });
    const blob = await downloadHlsAudio(BASE, '#EXTM3U\n#EXTINF:10,\n1.mp3\n#EXTINF:10,\n2.mp3\n');
    expect(await blob.text()).toBe('ID3-one-two');
    expect(blob.type).toBe('audio/mpeg');
  });

  it('список вариантов: идёт в первый вариант', async () => {
    serve({ 'hi.m3u8': '#EXTM3U\n#EXTINF:10,\nseg.mp3\n', 'seg.mp3': 'ID3!' });
    const blob = await downloadHlsAudio(BASE, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=160000\nhi/hi.m3u8\n');
    expect(await blob.text()).toBe('ID3!');
  });

  it('зашифрованный поток, MPEG-TS и отказ сегмента — ошибка, а не битый файл', async () => {
    serve({ 'a.ts': 'G-ts', 'gone.m4s': 403, 'init.mp4': 'I' });
    await expect(
      downloadHlsAudio(BASE, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:10,\na.ts\n')
    ).rejects.toThrow(/зашифрован/);
    await expect(downloadHlsAudio(BASE, '#EXTM3U\n#EXTINF:10,\na.ts\n')).rejects.toThrow(/MPEG-TS/);
    await expect(
      downloadHlsAudio(BASE, '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\ngone.m4s\n')
    ).rejects.toThrow(/сегмент 2\/2 ответил 403/);
    await expect(downloadHlsAudio(BASE, '#EXTM3U\n#EXT-X-ENDLIST\n')).rejects.toThrow(/нет сегментов/);
  });

  it('узнаёт плейлист по первой строке', () => {
    expect(isHlsPlaylistText('#EXTM3U\n#EXT-X-VERSION:6')).toBe(true);
    expect(isHlsPlaylistText('{"error":"gone"}')).toBe(false);
  });
});
