import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../setup';
import {
  clearQuality,
  describeQuality,
  getQuality,
  markLowBitrate,
  markPreview,
  noteStreamQuality,
  resetTrackQualityForTests,
  subscribe
} from '../../src/services/trackQuality';

/**
 * Карта «что известно о качестве записи»: пометки ставятся по факту разбора,
 * переживают перезапуск через localStorage и снимаются, когда трек сыграл
 * целиком. Подписчики узнают о каждой перемене — на этом стоит бейдж в списке.
 */

beforeEach(() => {
  resetTrackQualityForTests();
});

describe('trackQuality', () => {
  it('помечает отрывок и низкий битрейт, отрывок важнее', () => {
    markPreview('sc_1');
    markLowBitrate('sc_2');
    expect(getQuality('sc_1')).toBe('preview');
    expect(getQuality('sc_2')).toBe('low');
    expect(getQuality('sc_3')).toBeNull();

    markLowBitrate('sc_1');
    expect(getQuality('sc_1')).toBe('preview');
    markPreview('sc_2');
    expect(getQuality('sc_2')).toBe('preview');
  });

  it('из разобранного потока: отрывок, битрейт ниже 96, иначе пометка снимается', () => {
    noteStreamQuality('a', { isPreview: true, bitrate: 128 });
    expect(getQuality('a')).toBe('preview');
    noteStreamQuality('b', { bitrate: 64 });
    expect(getQuality('b')).toBe('low');
    noteStreamQuality('c', { bitrate: 0 });
    expect(getQuality('c')).toBeNull();
    noteStreamQuality('d', { bitrate: 128 });
    expect(getQuality('d')).toBeNull();

    // Трек однажды сыграл целиком и в нормальном качестве — предупреждать не о чем.
    noteStreamQuality('a', { bitrate: 128 });
    expect(getQuality('a')).toBeNull();
    noteStreamQuality('e', null);
    expect(getQuality('e')).toBeNull();
  });

  it('подписчик узнаёт о перемене и отписывается', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    markPreview('x');
    expect(listener).toHaveBeenCalledTimes(1);
    // Та же пометка повторно — не перемена.
    markPreview('x');
    expect(listener).toHaveBeenCalledTimes(1);
    clearQuality('x');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    markPreview('y');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('переживает перезапуск через localStorage и не падает на мусоре', () => {
    markPreview('sc_9');
    markLowBitrate('sc_8');
    expect(JSON.parse(localStorage.getItem('wireon_track_quality') ?? '{}')).toEqual({ sc_9: 'preview', sc_8: 'low' });

    // «Перезапуск»: память забыта, хранилище осталось.
    resetTrackQualityForTests();
    localStorage.setItem('wireon_track_quality', JSON.stringify({ sc_9: 'preview', junk: 'ultra', sc_8: 'low' }));
    expect(getQuality('sc_9')).toBe('preview');
    expect(getQuality('sc_8')).toBe('low');
    expect(getQuality('junk')).toBeNull();

    resetTrackQualityForTests();
    localStorage.setItem('wireon_track_quality', '{not json');
    expect(getQuality('sc_9')).toBeNull();
    markPreview('sc_1');
    expect(getQuality('sc_1')).toBe('preview');
  });

  it('держит не больше четырёхсот записей, вытесняя старые', () => {
    for (let i = 0; i < 405; i += 1) markLowBitrate(`t${i}`);
    expect(getQuality('t0')).toBeNull();
    expect(getQuality('t4')).toBeNull();
    expect(getQuality('t5')).toBe('low');
    expect(getQuality('t404')).toBe('low');
  });

  it('подписи по-русски и без капса', () => {
    expect(describeQuality('preview').label).toBe('отрывок');
    expect(describeQuality('low').label).toBe('низкое качество');
    expect(describeQuality('low').title).toMatch(/96/);
  });
});
