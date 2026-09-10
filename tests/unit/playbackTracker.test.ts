/**
 * Счёт прозвучавших секунд (`src/services/playbackTracker.ts`).
 *
 * Здесь проверяется то, из-за чего статистика врала: время считалось как
 * длительность × число включений, а включение засчитывалось до первой секунды
 * звука. Каждая проверка ниже — отдельный способ снова начать врать.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  beginPlay,
  currentPlaySeconds,
  endPlay,
  flush,
  noteProgress,
  playThresholdSeconds,
  resetPlaybackTracker,
  FLUSH_INTERVAL_MS
} from '../../src/services/playbackTracker';
import * as dbService from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

function track(duration: number): UnifiedTrack {
  return {
    id: 'yt_tracker_1',
    source: 'youtube',
    originalId: 'tracker1',
    title: 'Get Lucky',
    artist: 'Daft Punk',
    duration,
    artworkUrl: ''
  };
}

const song = track(240);

describe('порог зачёта', () => {
  it('короче — половина трека, длиннее — тридцать секунд', () => {
    // У минутной зарисовки своя половина, у концерта — своя.
    expect(playThresholdSeconds(40)).toBe(20);
    expect(playThresholdSeconds(240)).toBe(30);
    // Длительность неизвестна — считаем по общему порогу.
    expect(playThresholdSeconds(undefined)).toBe(30);
  });
});

describe('счёт секунд', () => {
  let commitPlay: MockInstance<typeof dbService.commitPlay>;
  let updatePlaySeconds: MockInstance<typeof dbService.updatePlaySeconds>;
  let recordTrackSkip: MockInstance<typeof dbService.recordTrackSkip>;
  let recordAbandonedPlay: MockInstance<typeof dbService.recordAbandonedPlay>;

  beforeEach(() => {
    resetPlaybackTracker();
    commitPlay = vi.spyOn(dbService, 'commitPlay').mockResolvedValue(7);
    updatePlaySeconds = vi.spyOn(dbService, 'updatePlaySeconds').mockResolvedValue(undefined);
    recordTrackSkip = vi.spyOn(dbService, 'recordTrackSkip').mockResolvedValue(undefined);
    recordAbandonedPlay = vi.spyOn(dbService, 'recordAbandonedPlay').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('считает прозвучавшее, а не позицию ползунка', () => {
    beginPlay(song);
    noteProgress(1);
    noteProgress(2);
    noteProgress(3);

    expect(currentPlaySeconds()).toBeCloseTo(3, 5);
  });

  it('перемотка вперёд не добавляет секунд', () => {
    beginPlay(song);
    noteProgress(2);
    // Прыжок на две минуты вперёд — это не две минуты музыки.
    noteProgress(120);
    noteProgress(121);

    expect(currentPlaySeconds()).toBeCloseTo(3, 5);
  });

  it('перемотка назад и повтор не дают отрицательных секунд', () => {
    beginPlay(song);
    noteProgress(30);
    noteProgress(0);
    noteProgress(1);

    expect(currentPlaySeconds()).toBeGreaterThanOrEqual(0);
    expect(currentPlaySeconds()).toBeLessThan(5);
  });

  it('включение короче порога прослушиванием не считается', async () => {
    beginPlay(song);
    for (let i = 1; i <= 8; i += 1) noteProgress(i);
    await endPlay();

    expect(commitPlay).not.toHaveBeenCalled();
    // Зато это отказ — и он должен быть виден и подбору, и окну «за неделю».
    expect(recordTrackSkip).toHaveBeenCalledWith(song.id, 8);
    expect(recordAbandonedPlay).toHaveBeenCalled();
  });

  it('перевалив за порог, включение становится прослушиванием', async () => {
    beginPlay(song);
    for (let i = 1; i <= 35; i += 1) noteProgress(i);
    await endPlay();

    expect(commitPlay).toHaveBeenCalledTimes(1);
    expect(commitPlay.mock.calls[0][1]).toMatchObject({ seconds: 35, completed: false });
    expect(recordTrackSkip).not.toHaveBeenCalled();
  });

  it('пишет одно событие и правит его, а не по событию на каждый сброс', async () => {
    const start = Date.now();
    beginPlay(song);
    for (let i = 1; i <= 35; i += 1) noteProgress(i, start);

    await flush(start + FLUSH_INTERVAL_MS);
    await flush(start + FLUSH_INTERVAL_MS * 2);
    await flush(start + FLUSH_INTERVAL_MS * 3);

    expect(commitPlay).toHaveBeenCalledTimes(1);
    expect(updatePlaySeconds).not.toHaveBeenCalled();

    // Дальше секунды идут — и уже дописываются в то же событие.
    for (let i = 36; i <= 60; i += 1) noteProgress(i, start);
    await flush(start + FLUSH_INTERVAL_MS * 4);
    expect(updatePlaySeconds).toHaveBeenCalledWith(7, 60, false);
  });

  it('дослушивание считается по достигнутой точке, а не по концу трека', async () => {
    const short = track(60);
    beginPlay(short);
    for (let i = 1; i <= 55; i += 1) noteProgress(i);
    // Человек переключил на 55-й секунде минутного трека — это дослушано:
    // 55 из 60 больше порога в 85%. Событие «трек кончился» при этом не придёт
    // никогда, и при кроссфейде не приходило вовсе.
    await endPlay();

    expect(commitPlay.mock.calls[0][1]).toMatchObject({ completed: true });
  });

  it('новое включение закрывает предыдущее', async () => {
    beginPlay(song);
    for (let i = 1; i <= 35; i += 1) noteProgress(i);

    beginPlay(track(200));
    await Promise.resolve();

    expect(commitPlay).toHaveBeenCalledTimes(1);
    expect(currentPlaySeconds()).toBe(0);
  });

  it('без звука ничего не пишется', async () => {
    beginPlay(song);
    await endPlay();

    expect(commitPlay).not.toHaveBeenCalled();
    expect(recordTrackSkip).not.toHaveBeenCalled();
  });
});
