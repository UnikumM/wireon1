import { describe, it, expect } from 'vitest';
import { pickCrossfadeSeconds, isSameAlbum, hasShortTrack, SHORT_TRACK_SECONDS } from '../../src/services/smartCrossfade';
import type { UnifiedTrack } from '../../src/types/music';

/** Трек с нужными полями; остальное — заглушки, они на решение не влияют. */
function track(over: Partial<UnifiedTrack>): UnifiedTrack {
  return {
    id: over.id ?? 'yt_x',
    source: 'youtube',
    originalId: 'x',
    title: 'Трек',
    artist: 'Исполнитель',
    duration: 240,
    artworkUrl: '',
    ...over
  };
}

describe('умный кроссфейд: выбор длины перехода', () => {
  it('разные альбомы, обычные длительности — базовая длина', () => {
    const a = track({ album: 'Discovery', artist: 'Daft Punk' });
    const b = track({ album: 'Random Access Memories', artist: 'Daft Punk' });
    expect(pickCrossfadeSeconds(a, b, 5)).toBe(5);
  });

  it('один альбом и исполнитель — встык, ноль', () => {
    const a = track({ album: 'Discovery', artist: 'Daft Punk', duration: 300 });
    const b = track({ album: 'Discovery', artist: 'Daft Punk', duration: 280 });
    expect(pickCrossfadeSeconds(a, b, 5)).toBe(0);
    expect(isSameAlbum(a, b)).toBe(true);
  });

  it('альбом сравнивается без учёта регистра и пробелов по краям', () => {
    const a = track({ album: ' Discovery', artist: 'daft punk' });
    const b = track({ album: 'discovery ', artist: 'Daft Punk' });
    expect(pickCrossfadeSeconds(a, b, 4)).toBe(0);
  });

  it('одинаковый альбом у разных исполнителей — не один альбом, базовая длина', () => {
    const a = track({ album: 'Greatest Hits', artist: 'Queen' });
    const b = track({ album: 'Greatest Hits', artist: 'ABBA' });
    expect(isSameAlbum(a, b)).toBe(false);
    expect(pickCrossfadeSeconds(a, b, 6)).toBe(6);
  });

  it('альбом не указан хотя бы у одного — не гадаем, базовая длина', () => {
    const a = track({ album: 'Discovery', artist: 'Daft Punk' });
    const b = track({ artist: 'Daft Punk' });
    expect(pickCrossfadeSeconds(a, b, 5)).toBe(5);
    expect(pickCrossfadeSeconds(b, a, 5)).toBe(5);
    expect(pickCrossfadeSeconds(track({ album: '' }), track({ album: '' }), 5)).toBe(5);
  });

  it('один и тот же исполнитель подряд без альбома — не повод склеивать', () => {
    const a = track({ artist: 'Daft Punk' });
    const b = track({ artist: 'Daft Punk' });
    expect(pickCrossfadeSeconds(a, b, 5)).toBe(5);
  });

  it('короткий трек с любой стороны — ноль', () => {
    const short = track({ duration: SHORT_TRACK_SECONDS - 1 });
    const long = track({ duration: 240 });
    expect(hasShortTrack(short, long)).toBe(true);
    expect(pickCrossfadeSeconds(short, long, 5)).toBe(0);
    expect(pickCrossfadeSeconds(long, short, 5)).toBe(0);
    expect(pickCrossfadeSeconds(track({ duration: SHORT_TRACK_SECONDS }), long, 5)).toBe(5);
  });

  it('длительность неизвестна у одного — короткость не решается, базовая длина', () => {
    const unknown = track({ duration: 0 });
    const nan = track({ duration: Number.NaN });
    const long = track({ duration: 240 });
    expect(hasShortTrack(unknown, long)).toBe(false);
    expect(pickCrossfadeSeconds(unknown, long, 5)).toBe(5);
    expect(pickCrossfadeSeconds(nan, long, 5)).toBe(5);
  });

  it('нет одного из треков — базовая длина', () => {
    const a = track({ album: 'Discovery', artist: 'Daft Punk' });
    expect(pickCrossfadeSeconds(null, a, 5)).toBe(5);
    expect(pickCrossfadeSeconds(a, undefined, 5)).toBe(5);
  });

  it('базовая длина приводится к целым секундам 0…12; ноль остаётся нулём', () => {
    const a = track({ album: 'A', artist: 'X' });
    const b = track({ album: 'B', artist: 'X' });
    expect(pickCrossfadeSeconds(a, b, 0)).toBe(0);
    expect(pickCrossfadeSeconds(a, b, -3)).toBe(0);
    expect(pickCrossfadeSeconds(a, b, 20)).toBe(12);
    expect(pickCrossfadeSeconds(a, b, 4.6)).toBe(5);
    expect(pickCrossfadeSeconds(a, b, Number.NaN)).toBe(0);
  });
});
