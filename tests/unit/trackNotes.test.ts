/**
 * Теги и заметки к трекам (идея 13 плана 4.0): сервис `trackNotes`.
 * Нормализация, частоты, подписка, удаление пустой записи, чтение из базы.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../setup';
import { db } from '../../src/services/db';
import {
  MAX_TAG_LENGTH,
  addTag,
  allTags,
  cleanTag,
  getNote,
  getTags,
  hydrateTrackNotes,
  normalizeTags,
  removeTag,
  resetTrackNotesForTests,
  setNote,
  setTags,
  subscribe,
  tagKey,
  tagsById,
  tracksWithTag
} from '../../src/services/trackNotes';

describe('trackNotes — нормализация', () => {
  it('cleanTag обрезает пробелы и решётку, схлопывает пробелы, режет до 24 знаков, регистр хранит', () => {
    expect(cleanTag('  #Для   бега ')).toBe('Для бега');
    expect(cleanTag('##бег')).toBe('бег');
    expect(cleanTag('   ')).toBe('');
    expect(cleanTag(null)).toBe('');
    const long = 'а'.repeat(40);
    expect(cleanTag(long)).toHaveLength(MAX_TAG_LENGTH);
    expect(cleanTag('Показать Диме')).toBe('Показать Диме');
  });

  it('tagKey сравнивает без регистра и без разницы «ё/е»', () => {
    expect(tagKey('Бег')).toBe(tagKey('#БЕГ'));
    expect(tagKey('Ёлка')).toBe('елка');
  });

  it('normalizeTags выбрасывает пустые и дубли, оставляя первое написание', () => {
    expect(normalizeTags(['Бег', ' бег', '', '#БЕГ', 'вечер'])).toEqual(['Бег', 'вечер']);
  });
});

describe('trackNotes — хранение', () => {
  beforeEach(async () => {
    resetTrackNotesForTests();
    await db.trackNotes.clear();
  });

  it('setTags/setNote пишут запись в кэш и в базу; getNote читает синхронно', async () => {
    await setTags('yt_1', ['Для бега', 'вечер']);
    await setNote('yt_1', '  припев в 1:12  ');
    const note = getNote('yt_1');
    expect(note?.tags).toEqual(['Для бега', 'вечер']);
    expect(note?.note).toBe('припев в 1:12');
    expect(note?.updatedAt).toBeGreaterThan(0);

    const stored = await db.trackNotes.get('yt_1');
    expect(stored?.tags).toEqual(['Для бега', 'вечер']);
    expect(stored?.note).toBe('припев в 1:12');
  });

  it('пустые теги и пустая заметка удаляют запись целиком', async () => {
    await setTags('yt_1', ['бег']);
    await setNote('yt_1', 'что-то');
    await setTags('yt_1', []);
    expect(getNote('yt_1')?.note).toBe('что-то');

    await setNote('yt_1', '   ');
    expect(getNote('yt_1')).toBeNull();
    expect(await db.trackNotes.get('yt_1')).toBeUndefined();
  });

  it('addTag не дублирует тег по ключу, removeTag снимает его без учёта регистра', async () => {
    await addTag('yt_1', 'Бег');
    await addTag('yt_1', '#бег');
    expect(getTags('yt_1')).toEqual(['Бег']);
    await removeTag('yt_1', 'БЕГ');
    expect(getNote('yt_1')).toBeNull();
  });

  it('allTags считает частоту по убыванию, tracksWithTag и tagsById — по ключу', async () => {
    await setTags('yt_1', ['бег', 'вечер']);
    await setTags('yt_2', ['Бег']);
    await setTags('yt_3', ['утро']);

    expect(allTags()).toEqual([
      { tag: 'бег', count: 2 },
      { tag: 'вечер', count: 1 },
      { tag: 'утро', count: 1 }
    ]);
    expect(tracksWithTag('#БЕГ').sort()).toEqual(['yt_1', 'yt_2']);
    expect(tracksWithTag('')).toEqual([]);
    expect(tagsById().get('yt_2')).toEqual(['Бег']);
    expect(tagsById().has('yt_9')).toBe(false);
  });

  it('подписчик зовётся на каждое изменение и отписывается', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    await setTags('yt_1', ['бег']);
    await setNote('yt_1', 'заметка');
    expect(listener).toHaveBeenCalledTimes(2);

    // Удаление отсутствующей записи — не изменение.
    await setTags('yt_404', []);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await setTags('yt_1', ['бег', 'вечер']);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('hydrate читает базу один раз и не перебивает то, что уже изменили в кэше', async () => {
    await db.trackNotes.bulkPut([
      { trackId: 'yt_old', tags: ['архив', 'архив'], note: 'из базы', updatedAt: 1 },
      { trackId: 'yt_fresh', tags: ['старое'], note: '', updatedAt: 1 }
    ]);
    resetTrackNotesForTests();

    await setTags('yt_fresh', ['новое']);
    const first = hydrateTrackNotes();
    expect(hydrateTrackNotes()).toBe(first);
    await first;

    expect(getTags('yt_old')).toEqual(['архив']);
    expect(getNote('yt_old')?.note).toBe('из базы');
    expect(getTags('yt_fresh')).toEqual(['новое']);
  });
});
