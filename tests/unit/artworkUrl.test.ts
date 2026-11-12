/**
 * Обложка нужного размера (4.0.2).
 *
 * Замечание пользователя: на сцене плеера обложка мылится — туда шла та же
 * мелкая картинка, что и в список. Он сам поменял `mqdefault` на
 * `maxresdefault` и `w120-h120` на `w500-h500` — здесь то же, но по месту и
 * с запасными вариантами.
 */

import { describe, it, expect } from 'vitest';
import { artworkAt, artworkCandidates, isMissingFramePlaceholder, pickArtworkSize } from '../../src/utils/artworkUrl';

describe('pickArtworkSize', () => {
  it('берёт ступень под размер на экране и плотность', () => {
    expect(pickArtworkSize(48, { dpr: 1 })).toBe(120);
    expect(pickArtworkSize(48, { dpr: 2 })).toBe(120);
    expect(pickArtworkSize(300, { dpr: 1 })).toBe(320);
    expect(pickArtworkSize(300, { dpr: 2 })).toBe(720);
    expect(pickArtworkSize(460, { dpr: 2 })).toBe(1200);
    // Плотность выше двух не учитывается: разницы не видно, трафик растёт.
    expect(pickArtworkSize(300, { dpr: 3.5 })).toBe(720);
  });

  it('медленная сеть и экономия трафика ограничивают размер', () => {
    expect(pickArtworkSize(460, { dpr: 2, saveData: true })).toBe(320);
    expect(pickArtworkSize(460, { dpr: 2, effectiveType: '2g' })).toBe(320);
    expect(pickArtworkSize(460, { dpr: 2, effectiveType: '3g' })).toBe(500);
    expect(pickArtworkSize(460, { dpr: 2, effectiveType: '4g' })).toBe(1200);
  });
});

describe('artworkCandidates', () => {
  it('YouTube: крупные кадры первыми, мелкий гарантированный — последним', () => {
    const small = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg';
    expect(artworkCandidates(small, 720)).toEqual([
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg',
      small
    ]);
    // Для списка крупнее не нужно — адрес остаётся прежним, запросов не прибавляется.
    expect(artworkCandidates(small, 120)).toEqual([small]);
    // Кадров 4:3 с чёрными полями в списке нет никогда.
    expect(artworkCandidates(small, 1200).join(' ')).not.toMatch(/sddefault|hqdefault/);
  });

  it('YouTube Music и прокси Piped: размер в адресе Google переписывается', () => {
    expect(artworkAt('https://lh3.googleusercontent.com/abc=w120-h120-l90-rj', 500)).toBe(
      'https://lh3.googleusercontent.com/abc=w500-h500-l90-rj'
    );
    // Пример из сообщения пользователя: размер стоит в пути, хост — в запросе.
    expect(
      artworkAt('https://proxy.piped.private.coffee/XJ4f=w120-h120-l90-rw?host=yt3.googleusercontent.com', 500)
    ).toBe('https://proxy.piped.private.coffee/XJ4f=w500-h500-l90-rw?host=yt3.googleusercontent.com');
    expect(artworkAt('https://yt3.ggpht.com/abc=s88-c-k', 240)).toBe('https://yt3.ggpht.com/abc=s240-c-k');
  });

  it('SoundCloud: суффикс размера по месту', () => {
    const large = 'https://i1.sndcdn.com/artworks-000-abc-large.jpg';
    expect(artworkAt(large, 720)).toBe('https://i1.sndcdn.com/artworks-000-abc-t500x500.jpg');
    expect(artworkAt('https://i1.sndcdn.com/artworks-000-abc-t500x500.jpg', 240)).toBe(
      'https://i1.sndcdn.com/artworks-000-abc-t300x300.jpg'
    );
    expect(artworkCandidates(large, 720)).toEqual(['https://i1.sndcdn.com/artworks-000-abc-t500x500.jpg', large]);
  });

  it('незнакомые адреса, data: и пустота остаются как есть', () => {
    expect(artworkCandidates('https://example.com/cover.png', 720)).toEqual(['https://example.com/cover.png']);
    expect(artworkCandidates('data:image/png;base64,AAAA', 720)).toEqual(['data:image/png;base64,AAAA']);
    expect(artworkCandidates('blob:http://localhost/1', 720)).toEqual(['blob:http://localhost/1']);
    expect(artworkCandidates('', 720)).toEqual([]);
    expect(artworkCandidates(null, 720)).toEqual([]);
    expect(artworkAt(undefined, 720)).toBe('');
  });

  it('серая заглушка YouTube 120×90 распознаётся, настоящий кадр — нет', () => {
    expect(isMissingFramePlaceholder(120, 90)).toBe(true);
    expect(isMissingFramePlaceholder(320, 180)).toBe(false);
    expect(isMissingFramePlaceholder(1280, 720)).toBe(false);
    expect(isMissingFramePlaceholder(0, 0)).toBe(false);
  });
});

describe('artworkGuaranteed: адрес для уведомления и MediaSession', () => {
  it('у Google и SoundCloud — крупнее, у кадров YouTube — исходный (крупный может оказаться заглушкой)', async () => {
    const { artworkGuaranteed } = await import('../../src/utils/artworkUrl');
    expect(artworkGuaranteed('https://lh3.googleusercontent.com/abc=w120-h120-l90-rj', 500)).toContain('=w500-h500');
    expect(artworkGuaranteed('https://i1.sndcdn.com/artworks-abc-large.jpg', 500)).toContain('-t500x500.jpg');
    expect(artworkGuaranteed('https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', 500)).toBe(
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg'
    );
    expect(artworkGuaranteed('', 500)).toBe('');
  });
});
