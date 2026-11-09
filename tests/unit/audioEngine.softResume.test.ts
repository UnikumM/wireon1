import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AudioEngine,
  SOFT_RESUME_PAUSE_MS,
  SOFT_RESUME_REWIND_SEC,
  SOFT_RESUME_FADE_MS
} from '../../src/services/audioEngine';
import { StreamResolver } from '../../src/services/streamResolver';
import { UnifiedTrack } from '../../src/types/music';

vi.mock('../../src/services/hls', () => ({
  isHlsUrl: () => false,
  isNativeHlsSupported: () => false,
  isHlsJsSupported: async () => false,
  isHlsSupported: async () => false,
  attachHls: vi.fn()
}));

/**
 * Фича 08 (4.0): «мягкое возвращение». Движок помнит момент паузы; если прошло
 * больше получаса, при возобновлении откатывает трек на три секунды и поднимает
 * громкость от нуля за ~700 мс. Короткая пауза и выключенная настройка ничего
 * не меняют. Громкость читаем с мастер-узла: в тестовой среде есть мок
 * AudioContext, и `applyGainVolume` ведёт именно его.
 */
describe('AudioEngine: мягкое возвращение после долгой паузы', () => {
  let engine: AudioEngine;
  let mockAudio: any;
  const MINUTE = 60_000;

  const track: UnifiedTrack = {
    id: 'yt_soft',
    source: 'youtube',
    originalId: 'soft',
    title: 'Долгая песня',
    artist: 'Кто-то',
    duration: 355,
    artworkUrl: ''
  };

  // Полная громкость по умолчанию 0.8 → на узле 0.64 (квадратичная кривая).
  const FULL_GAIN = 0.8 * 0.8;

  const gainValue = (): number => engine.getMasterGainNode()!.gain.value;

  beforeEach(async () => {
    vi.useFakeTimers();
    const resolver = new StreamResolver();
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      streamUrl: 'https://googlevideo.com/soft',
      format: 'm4a',
      bitrate: 128,
      expiresAt: Date.now() + 3600_000,
      cached: false
    });

    mockAudio = {
      src: '',
      currentTime: 0,
      duration: 355,
      volume: 1,
      muted: false,
      paused: false,
      buffered: { length: 1, end: () => 355 },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      load: vi.fn()
    };

    engine = new AudioEngine(resolver, mockAudio);
    await engine.load(track, true);
    expect(engine.getState()).toBe('playing');
    mockAudio.currentTime = 100;
  });

  afterEach(() => {
    engine.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('после 31 минуты паузы откатывает на 3 с и поднимает громкость от нуля', async () => {
    engine.pause();
    vi.advanceTimersByTime(31 * MINUTE);

    const playing = engine.play();
    // Ещё до разрешения play(): откат и тишина уже выставлены.
    expect(mockAudio.currentTime).toBe(100 - SOFT_RESUME_REWIND_SEC);
    expect(gainValue()).toBe(0);
    await playing;
    expect(engine.getState()).toBe('playing');

    await vi.advanceTimersByTimeAsync(SOFT_RESUME_FADE_MS / 2);
    const midway = gainValue();
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(FULL_GAIN);

    await vi.advanceTimersByTimeAsync(SOFT_RESUME_FADE_MS);
    expect(gainValue()).toBeCloseTo(FULL_GAIN, 6);
    // Пользовательская громкость не тронута — менялся только множитель.
    expect(engine.getVolume()).toBe(0.8);
  });

  it('не уходит ниже нуля, если пауза была в самом начале трека', async () => {
    mockAudio.currentTime = 1;
    engine.pause();
    vi.advanceTimersByTime(SOFT_RESUME_PAUSE_MS + MINUTE);

    await engine.play();
    expect(mockAudio.currentTime).toBe(0);
    await vi.advanceTimersByTimeAsync(SOFT_RESUME_FADE_MS + 200);
    expect(gainValue()).toBeCloseTo(FULL_GAIN, 6);
  });

  it('пять минут паузы — обычное продолжение без отката и затухания', async () => {
    engine.pause();
    vi.advanceTimersByTime(5 * MINUTE);

    await engine.play();
    expect(mockAudio.currentTime).toBe(100);
    expect(gainValue()).toBeCloseTo(FULL_GAIN, 6);
  });

  it('настройка выключена — долгая пауза ничего не меняет', async () => {
    engine.setSoftResume(false);
    expect(engine.isSoftResumeEnabled()).toBe(false);
    engine.pause();
    vi.advanceTimersByTime(2 * SOFT_RESUME_PAUSE_MS);

    await engine.play();
    expect(mockAudio.currentTime).toBe(100);
    expect(gainValue()).toBeCloseTo(FULL_GAIN, 6);
  });

  it('отметка паузы гасится возобновлением: вторая короткая пауза не считается долгой', async () => {
    engine.pause();
    vi.advanceTimersByTime(31 * MINUTE);
    await engine.play();
    await vi.advanceTimersByTimeAsync(SOFT_RESUME_FADE_MS + 200);
    mockAudio.currentTime = 200;

    engine.pause();
    vi.advanceTimersByTime(MINUTE);
    await engine.play();
    expect(mockAudio.currentTime).toBe(200);
    expect(gainValue()).toBeCloseTo(FULL_GAIN, 6);
  });

  it('новый трек после долгой паузы начинается как обычно', async () => {
    engine.pause();
    vi.advanceTimersByTime(31 * MINUTE);

    mockAudio.currentTime = 0;
    await engine.load({ ...track, id: 'yt_other', originalId: 'other' }, true);
    expect(engine.getState()).toBe('playing');
    expect(mockAudio.currentTime).toBe(0);
    expect(gainValue()).toBeCloseTo(FULL_GAIN, 6);
  });

  it('пауза посреди нарастания возвращает полную громкость, чтобы не играть приглушённо', async () => {
    engine.pause();
    vi.advanceTimersByTime(31 * MINUTE);
    await engine.play();
    await vi.advanceTimersByTimeAsync(200);
    expect(gainValue()).toBeLessThan(FULL_GAIN);

    engine.pause();
    expect(gainValue()).toBeCloseTo(FULL_GAIN, 6);
    vi.advanceTimersByTime(MINUTE);
    await engine.play();
    expect(gainValue()).toBeCloseTo(FULL_GAIN, 6);
  });
});
