/**
 * Офлайн-режим: один тумблер вместо кнопки «скачать» у каждого трека.
 *
 * Проверяется главное обещание: включил — и прослушанное осело на диске; лимит
 * действительно ограничивает; вытесняется то, что дольше всех не включали, а
 * сохранённое вручную не трогается.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../setup';
import { db, clearAllData, getSetting } from '../../src/services/db';
import { offlineStorage } from '../../src/services/offlineStorage';
import {
  offlineMode,
  OFFLINE_MODE_SETTING,
  OFFLINE_LIMIT_SETTING,
  OFFLINE_BITRATE_SETTING,
  OFFLINE_LIMIT_OPTIONS,
  OFFLINE_BITRATE_OPTIONS,
  DEFAULT_OFFLINE_LIMIT_BYTES,
  DEFAULT_OFFLINE_BITRATE_KBPS
} from '../../src/services/offlineMode';
import { streamResolver } from '../../src/services/streamResolver';
import type { UnifiedTrack } from '../../src/types/music';

const KIB = 1024;

function makeTrack(id: string, overrides: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id.replace(/^yt_/, ''),
    title: `Трек ${id}`,
    artist: 'Исполнитель',
    duration: 200,
    artworkUrl: 'https://example.com/art.jpg',
    ...overrides
  };
}

/** Кладёт готовую копию в кэш, минуя загрузку. */
async function seedCached(
  id: string,
  options: { sizeBytes: number; lastUsedAt?: number; autoCached?: boolean; downloadedAt?: number }
): Promise<void> {
  await db.offlineTracks.put({
    id,
    track: makeTrack(id),
    blob: new Blob(['x'.repeat(Math.min(options.sizeBytes, 1024))], { type: 'audio/mpeg' }),
    sizeBytes: options.sizeBytes,
    downloadedAt: options.downloadedAt ?? 1_000,
    lastUsedAt: options.lastUsedAt,
    autoCached: options.autoCached ?? true
  });
}

/** Фиксированное число тиков — для проверок «ничего не должно произойти». */
async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Ждёт, пока очередь сохранения опустеет. Ограничение по числу тиков — чтобы
 * зависший сервис ронял тест, а не подвешивал прогон.
 */
async function idle(maxTurns = 200): Promise<void> {
  // Первые тики нужны, чтобы `noteListened` успел поставить трек в очередь:
  // проверка «уже лежит в кэше» внутри него асинхронная.
  await settle(3);
  for (let turn = 0; turn < maxTurns; turn++) {
    const state = offlineMode.getState();
    if (state.cachingTrackId === null && state.pendingCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Очередь офлайн-сохранения не опустела');
}

describe('Офлайн-режим (пункт 10: тумблер вместо скачивания)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearAllData();
    streamResolver.clearCache();

    // `init()` кэшируется внутри сервиса, поэтому между тестами состояние
    // сбрасывается напрямую — иначе первый тест решал бы судьбу остальных.
    (offlineMode as unknown as { initialised: Promise<void> | null }).initialised = null;
    (offlineMode as unknown as { enabled: boolean }).enabled = false;
    (offlineMode as unknown as { limitBytes: number }).limitBytes = DEFAULT_OFFLINE_LIMIT_BYTES;
    (offlineMode as unknown as { bitrateKbps: number }).bitrateKbps = DEFAULT_OFFLINE_BITRATE_KBPS;
    (offlineMode as unknown as { pending: unknown[] }).pending.length = 0;
    (offlineMode as unknown as { batchDone: number }).batchDone = 0;
    (offlineMode as unknown as { batchTotal: number }).batchTotal = 0;
    (offlineMode as unknown as { lastError: string | null }).lastError = null;

    vi.spyOn(streamResolver, 'resolve').mockResolvedValue({
      streamUrl: 'https://stream.example.com/audio.mp3',
      format: 'mp3',
      bitrate: 128,
      expiresAt: Date.now() + 3_600_000
    } as unknown as Awaited<ReturnType<typeof streamResolver.resolve>>);

    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      blob: async () => new Blob(['a'.repeat(4 * KIB)], { type: 'audio/mpeg' })
    })) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await clearAllData();
  });

  describe('Тумблер', () => {
    it('по умолчанию выключен и ничего не сохраняет', async () => {
      await offlineMode.init();
      expect(offlineMode.isEnabled()).toBe(false);

      offlineMode.noteListened(makeTrack('yt_quiet'));
      await settle();

      expect(await offlineStorage.isDownloaded('yt_quiet')).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('запоминает своё положение между запусками', async () => {
      await offlineMode.init();
      await offlineMode.setEnabled(true);

      expect(await getSetting<boolean>(OFFLINE_MODE_SETTING, false)).toBe(true);

      // Новый «запуск»: сервис читает настройку заново.
      (offlineMode as unknown as { initialised: Promise<void> | null }).initialised = null;
      (offlineMode as unknown as { enabled: boolean }).enabled = false;
      await offlineMode.init();

      expect(offlineMode.isEnabled()).toBe(true);
    });

    it('сохраняет выбранный лимит', async () => {
      await offlineMode.init();
      const tenGb = OFFLINE_LIMIT_OPTIONS.find((option) => option.label === '10 ГБ')!.bytes;

      await offlineMode.setLimitBytes(tenGb);

      expect(offlineMode.getLimitBytes()).toBe(tenGb);
      expect(await getSetting<number>(OFFLINE_LIMIT_SETTING, 0)).toBe(tenGb);
    });

    it('отбрасывает мусорный лимит вместо того, чтобы отключить ограничение', async () => {
      await offlineMode.init();

      await offlineMode.setLimitBytes(Number.NaN);
      expect(offlineMode.getLimitBytes()).toBe(DEFAULT_OFFLINE_LIMIT_BYTES);

      await offlineMode.setLimitBytes(-5);
      expect(offlineMode.getLimitBytes()).toBe(DEFAULT_OFFLINE_LIMIT_BYTES);
    });

    it('выключение не удаляет уже сохранённое', async () => {
      await seedCached('yt_kept', { sizeBytes: 2 * KIB });
      await offlineMode.init();
      await offlineMode.setEnabled(true);

      await offlineMode.setEnabled(false);

      expect(await offlineStorage.isDownloaded('yt_kept')).toBe(true);
    });
  });

  describe('Автосохранение прослушанного', () => {
    it('кладёт в кэш трек, который начали слушать', async () => {
      await offlineMode.init();
      await offlineMode.setEnabled(true);

      offlineMode.noteListened(makeTrack('yt_listened'));
      await idle();

      expect(await offlineStorage.isDownloaded('yt_listened')).toBe(true);
      const record = await db.offlineTracks.get('yt_listened');
      expect(record?.autoCached).toBe(true);
      expect(record?.lastUsedAt).toBeGreaterThan(0);
    });

    it('не скачивает то, что уже лежит в кэше', async () => {
      await seedCached('yt_again', { sizeBytes: 2 * KIB });
      await offlineMode.init();
      await offlineMode.setEnabled(true);

      offlineMode.noteListened(makeTrack('yt_again'));
      await settle();

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('пропускает 30-секундные обрезки SoundCloud', async () => {
      await offlineMode.init();
      await offlineMode.setEnabled(true);

      offlineMode.noteListened(makeTrack('sc_preview', { source: 'soundcloud', isPreview: true }));
      await settle();

      expect(await offlineStorage.isDownloaded('sc_preview')).toBe(false);
    });

    it('один недоступный трек не останавливает очередь за ним', async () => {
      await offlineMode.init();
      await offlineMode.setEnabled(true);

      let call = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) throw new Error('Сеть недоступна');
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          blob: async () => new Blob(['b'.repeat(2 * KIB)], { type: 'audio/mpeg' })
        };
      }) as unknown as typeof fetch;

      offlineMode.noteListened(makeTrack('yt_broken'));
      offlineMode.noteListened(makeTrack('yt_fine'));
      await idle();

      expect(await offlineStorage.isDownloaded('yt_broken')).toBe(false);
      expect(await offlineStorage.isDownloaded('yt_fine')).toBe(true);
    });

    it('отмечает время последнего прослушивания у уже сохранённой копии', async () => {
      await seedCached('yt_touch', { sizeBytes: 2 * KIB, lastUsedAt: 500 });
      await offlineMode.init();

      offlineMode.noteListened(makeTrack('yt_touch'));
      await idle();

      const record = await db.offlineTracks.get('yt_touch');
      expect(record?.lastUsedAt ?? 0).toBeGreaterThan(500);
    });
  });

  describe('Лимит и вытеснение', () => {
    it('вытесняет то, что дольше всех не включали', async () => {
      await offlineMode.init();
      await seedCached('yt_old', { sizeBytes: 6 * KIB, lastUsedAt: 100 });
      await seedCached('yt_middle', { sizeBytes: 6 * KIB, lastUsedAt: 5_000 });
      await seedCached('yt_fresh', { sizeBytes: 6 * KIB, lastUsedAt: 9_000 });

      await offlineMode.setLimitBytes(13 * KIB);

      expect(await offlineStorage.isDownloaded('yt_old')).toBe(false);
      expect(await offlineStorage.isDownloaded('yt_middle')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_fresh')).toBe(true);
    });

    it('без времени прослушивания опирается на дату сохранения', async () => {
      await offlineMode.init();
      await seedCached('yt_first', { sizeBytes: 6 * KIB, downloadedAt: 1_000 });
      await seedCached('yt_second', { sizeBytes: 6 * KIB, downloadedAt: 8_000 });

      await offlineMode.setLimitBytes(7 * KIB);

      expect(await offlineStorage.isDownloaded('yt_first')).toBe(false);
      expect(await offlineStorage.isDownloaded('yt_second')).toBe(true);
    });

    it('не трогает копии, сохранённые вручную, и честно об этом сообщает', async () => {
      await offlineMode.init();
      await seedCached('yt_manual_a', { sizeBytes: 8 * KIB, autoCached: false, lastUsedAt: 10 });
      await seedCached('yt_manual_b', { sizeBytes: 8 * KIB, autoCached: false, lastUsedAt: 20 });

      await offlineMode.setLimitBytes(4 * KIB);

      expect(await offlineStorage.isDownloaded('yt_manual_a')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_manual_b')).toBe(true);
      expect(offlineMode.getState().lastError).toMatch(/вручную/);
    });

    it('не вытесняет трек, который только что сохранили', async () => {
      await offlineMode.init();
      await offlineMode.setEnabled(true);
      await offlineMode.setLimitBytes(5 * KIB);
      await seedCached('yt_ancient', { sizeBytes: 4 * KIB, lastUsedAt: 1 });

      // Ответ на 4 КиБ: вместе с уже лежащими 4 КиБ лимит в 5 КиБ будет превышен.
      offlineMode.noteListened(makeTrack('yt_current'));
      await idle();

      expect(await offlineStorage.isDownloaded('yt_current')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_ancient')).toBe(false);
    });

    it('«без ограничений» ничего не вытесняет', async () => {
      await offlineMode.init();
      await seedCached('yt_a', { sizeBytes: 50 * KIB, lastUsedAt: 1 });
      await seedCached('yt_b', { sizeBytes: 50 * KIB, lastUsedAt: 2 });

      await offlineMode.setLimitBytes(0);
      const evicted = await offlineMode.enforceLimit();

      expect(evicted).toBe(0);
      expect(await offlineStorage.isDownloaded('yt_a')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_b')).toBe(true);
    });
  });

  describe('Состояние для интерфейса', () => {
    it('сообщает подписчикам о включении и о размере лимита', async () => {
      const seen: Array<{ enabled: boolean; limitBytes: number }> = [];
      const unsubscribe = offlineMode.subscribe((state) => {
        seen.push({ enabled: state.enabled, limitBytes: state.limitBytes });
      });

      await offlineMode.init();
      await offlineMode.setEnabled(true);
      await offlineMode.setLimitBytes(OFFLINE_LIMIT_OPTIONS[0].bytes);
      unsubscribe();

      expect(seen[0].enabled).toBe(false);
      expect(seen.some((state) => state.enabled)).toBe(true);
      expect(seen[seen.length - 1].limitBytes).toBe(OFFLINE_LIMIT_OPTIONS[0].bytes);
    });

    it('показывает прогресс сохранения и очищает его по завершении', async () => {
      await offlineMode.init();
      await offlineMode.setEnabled(true);

      const progressSeen: Array<string | null> = [];
      const unsubscribe = offlineMode.subscribe((state) => {
        progressSeen.push(state.cachingTrackId);
      });

      offlineMode.noteListened(makeTrack('yt_progress'));
      await idle();
      unsubscribe();

      expect(progressSeen).toContain('yt_progress');
      expect(offlineMode.getState().cachingTrackId).toBeNull();
      expect(offlineMode.getState().pendingCount).toBe(0);
    });

    it('игнорирует пустой трек, не падая', async () => {
      await offlineMode.init();
      await offlineMode.setEnabled(true);

      expect(() => offlineMode.noteListened(null)).not.toThrow();
      expect(() => offlineMode.noteListened(undefined)).not.toThrow();
      await settle();

      expect(offlineMode.getState().pendingCount).toBe(0);
    });
  });

  describe('Качество сохранённого', () => {
    it('по умолчанию жмёт, а не хранит как скачали', async () => {
      // Настройка по умолчанию — та, ради которой всё и делалось: место
      // экономится само, без похода в настройки.
      await offlineMode.init();

      expect(offlineMode.getBitrateKbps()).toBe(DEFAULT_OFFLINE_BITRATE_KBPS);
      expect(DEFAULT_OFFLINE_BITRATE_KBPS).toBeGreaterThan(0);
    });

    it('запоминает выбранный битрейт между запусками', async () => {
      await offlineMode.init();

      await offlineMode.setBitrateKbps(64);

      expect(offlineMode.getBitrateKbps()).toBe(64);
      expect(await getSetting<number>(OFFLINE_BITRATE_SETTING, 0)).toBe(64);
    });

    it('позволяет отказаться от сжатия совсем', async () => {
      await offlineMode.init();

      await offlineMode.setBitrateKbps(0);

      expect(offlineMode.getBitrateKbps()).toBe(0);
    });

    it('отбрасывает битрейт не из списка', async () => {
      // Значение уезжает в дочерний процесс, и главный процесс его тоже
      // проверяет; здесь важно, что испорченная настройка не переживёт запуск.
      await offlineMode.init();

      for (const bad of [320, -64, Number.NaN, 96.5]) {
        await offlineMode.setBitrateKbps(bad);
        expect(offlineMode.getBitrateKbps()).toBe(DEFAULT_OFFLINE_BITRATE_KBPS);
      }
    });

    it('передаёт выбранный битрейт в загрузку', async () => {
      await offlineMode.init();
      await offlineMode.setEnabled(true);
      await offlineMode.setBitrateKbps(64);
      const download = vi.spyOn(offlineStorage, 'downloadTrack').mockResolvedValue(undefined);

      offlineMode.noteListened(makeTrack('yt_bitrate'));
      await idle();

      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'yt_bitrate' }),
        expect.any(Function),
        { compressBitrateKbps: 64 }
      );
    });

    it('предлагает те же битрейты, что принимает главный процесс', () => {
      // Списки в двух процессах разъезжаться не должны: иначе настройка
      // предложит значение, которое там молча заменят на другое.
      expect(OFFLINE_BITRATE_OPTIONS.map((option) => option.kbps)).toEqual([0, 64, 96, 128, 160]);
    });
  });

  describe('Сохранить целиком (плейлист, избранное)', () => {
    it('сохраняет весь переданный список', async () => {
      await offlineMode.init();

      const added = await offlineMode.queueTracks([
        makeTrack('yt_batch_1'),
        makeTrack('yt_batch_2'),
        makeTrack('yt_batch_3')
      ]);
      await idle();

      expect(added).toBe(3);
      expect(await offlineStorage.isDownloaded('yt_batch_1')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_batch_2')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_batch_3')).toBe(true);
    });

    it('работает при выключенном автосохранении: это отдельная просьба', async () => {
      await offlineMode.init();
      expect(offlineMode.isEnabled()).toBe(false);

      await offlineMode.queueTracks([makeTrack('yt_manual_only')]);
      await idle();

      expect(await offlineStorage.isDownloaded('yt_manual_only')).toBe(true);
    });

    it('не помечает сохранённое вручную автоматическим — лимит его не выселит', async () => {
      await offlineMode.init();

      await offlineMode.queueTracks([makeTrack('yt_by_hand')]);
      await idle();

      const record = await db.offlineTracks.get('yt_by_hand');
      expect(record?.autoCached).not.toBe(true);

      // Лимит меньше сохранённого: выселять нечего, кроме этой копии, — и она
      // остаётся, потому что человек попросил её сам.
      await offlineMode.setLimitBytes(1);
      expect(await offlineStorage.isDownloaded('yt_by_hand')).toBe(true);
    });

    it('пропускает уже сохранённое и повторы в списке', async () => {
      await seedCached('yt_have', { sizeBytes: 2 * KIB });
      await offlineMode.init();

      const added = await offlineMode.queueTracks([
        makeTrack('yt_have'),
        makeTrack('yt_new'),
        makeTrack('yt_new')
      ]);
      await idle();

      expect(added).toBe(1);
    });

    it('пропускает обрезки и треки без id', async () => {
      await offlineMode.init();

      const added = await offlineMode.queueTracks([
        makeTrack('sc_snip', { source: 'soundcloud', isPreview: true }),
        { ...makeTrack('yt_nameless'), id: '' } as UnifiedTrack,
        null as unknown as UnifiedTrack
      ]);

      expect(added).toBe(0);
    });

    it('считает «N из M» и обнуляет счётчик, когда всё сохранено', async () => {
      await offlineMode.init();
      const totals: Array<{ done: number; total: number }> = [];
      const unsubscribe = offlineMode.subscribe((state) => {
        totals.push({ done: state.batchDone, total: state.batchTotal });
      });

      await offlineMode.queueTracks([makeTrack('yt_count_1'), makeTrack('yt_count_2')]);
      await idle();
      unsubscribe();

      expect(totals.some((entry) => entry.total === 2)).toBe(true);
      expect(totals.some((entry) => entry.done === 1 && entry.total === 2)).toBe(true);
      // Полоса исчезает только когда очередь дошла до конца.
      expect(offlineMode.getState().batchTotal).toBe(0);
      expect(offlineMode.getState().batchDone).toBe(0);
    });

    it('доводит счётчик до конца, даже если трек не скачался', async () => {
      // Иначе полоса замирает на первом недоступном треке и выглядит как
      // зависшая загрузка.
      await offlineMode.init();
      global.fetch = vi.fn().mockRejectedValue(new Error('Сеть недоступна')) as unknown as typeof fetch;

      await offlineMode.queueTracks([makeTrack('yt_dead_1'), makeTrack('yt_dead_2')]);
      await idle();

      expect(offlineMode.getState().batchTotal).toBe(0);
      expect(offlineMode.getState().lastError).toBeTruthy();
    });

    it('выключение автосохранения не отменяет загрузку плейлиста', async () => {
      await offlineMode.init();
      await offlineMode.setEnabled(true);

      await offlineMode.queueTracks([makeTrack('yt_survive_1'), makeTrack('yt_survive_2')]);
      await offlineMode.setEnabled(false);
      await idle();

      expect(await offlineStorage.isDownloaded('yt_survive_1')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_survive_2')).toBe(true);
    });

    it('выключение автосохранения по-прежнему выбрасывает автоматические заявки', async () => {
      await offlineMode.init();
      await offlineMode.setEnabled(true);
      // Загрузка встанет, пока её не отпустят: так очередь точно не успеет
      // разойтись до выключения.
      // Держим загрузку в объекте, а не в let: иначе TypeScript сужает
      // переменную до null — присваивание происходит в колбэке, которого он не
      // видит выполненным.
      const held: { release: (() => void) | null } = { release: null };
      vi.spyOn(offlineStorage, 'downloadTrack').mockImplementation(
        () => new Promise<void>((resolve) => {
          held.release = resolve;
        })
      );

      offlineMode.noteListened(makeTrack('yt_auto_1'));
      offlineMode.noteListened(makeTrack('yt_auto_2'));
      await settle(5);
      await offlineMode.setEnabled(false);

      expect(offlineMode.getState().pendingCount).toBe(0);
      held.release?.();
      await settle(5);
    });

    it('останавливается по просьбе человека', async () => {
      await offlineMode.init();
      const held: { release: (() => void) | null } = { release: null };
      vi.spyOn(offlineStorage, 'downloadTrack').mockImplementation(
        () => new Promise<void>((resolve) => {
          held.release = resolve;
        })
      );

      await offlineMode.queueTracks([makeTrack('yt_stop_1'), makeTrack('yt_stop_2'), makeTrack('yt_stop_3')]);
      await settle(5);
      offlineMode.cancelBatch();

      expect(offlineMode.getState().pendingCount).toBe(0);
      expect(offlineMode.getState().batchTotal).toBe(0);
      held.release?.();
      await settle(5);
    });

    it('на пустой список ничего не делает', async () => {
      await offlineMode.init();

      expect(await offlineMode.queueTracks([])).toBe(0);
      expect(await offlineMode.queueTracks(null as unknown as UnifiedTrack[])).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
