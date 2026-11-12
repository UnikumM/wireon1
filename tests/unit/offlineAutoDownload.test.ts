/**
 * Офлайн 2.0: избранное скачивается само.
 *
 * Проверяется обещание целиком: в очередь попадает только то избранное, чего
 * нет офлайн; лимит вытесняет самое давнее не из избранного, а любимое не
 * трогает; выключенная настройка ничего не качает; «только по Wi‑Fi» на
 * сотовой сети ждёт, а не падает.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../setup';
import { db, clearAllData, getSetting } from '../../src/services/db';
import { offlineStorage } from '../../src/services/offlineStorage';
import { offlineMode } from '../../src/services/offlineMode';
import {
  offlineAutoDownload,
  classifyConnection,
  formatRuBytes,
  FAVORITES_AUTO_SETTING,
  FAVORITES_WIFI_ONLY_SETTING,
  FAVORITES_LIMIT_SETTING,
  FAVORITES_LIMIT_OPTIONS,
  DEFAULT_FAVORITES_LIMIT_BYTES
} from '../../src/services/offlineAutoDownload';
import { streamResolver } from '../../src/services/streamResolver';
import { useLibraryStore } from '../../src/store/useLibraryStore';
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
  options: { sizeBytes: number; lastUsedAt?: number; downloadedAt?: number; autoCached?: boolean }
): Promise<void> {
  await db.offlineTracks.put({
    id,
    track: makeTrack(id),
    blob: new Blob(['x'.repeat(Math.min(options.sizeBytes, 1024))], { type: 'audio/mpeg' }),
    sizeBytes: options.sizeBytes,
    downloadedAt: options.downloadedAt ?? 1_000,
    lastUsedAt: options.lastUsedAt,
    autoCached: options.autoCached
  });
}

function setFavorites(tracks: UnifiedTrack[]): void {
  useLibraryStore.setState({ favorites: tracks });
}

type Internals = {
  initialised: Promise<void> | null;
  enabled: boolean;
  wifiOnly: boolean;
  limitBytes: number;
  lastError: string | null;
  storageFull: boolean;
  waitingForWifi: boolean;
};

/**
 * Включает службу, не запуская проход: `setEnabled(true)` сам зовёт `sync()`,
 * и в тестах он обгонял бы установку шпионов. Проход зовётся явно.
 */
function enable(): void {
  (offlineAutoDownload as unknown as Internals).enabled = true;
}

/** Сбрасывает службу к «первому запуску»: `init()` внутри кэшируется. */
function resetService(): void {
  const svc = offlineAutoDownload as unknown as Internals;
  svc.initialised = null;
  svc.enabled = false;
  svc.wifiOnly = true;
  svc.limitBytes = DEFAULT_FAVORITES_LIMIT_BYTES;
  svc.lastError = null;
  svc.storageFull = false;
  svc.waitingForWifi = false;
  offlineAutoDownload.deps.pauseBetweenTracksMs = 0;
  offlineAutoDownload.deps.startupDelayMs = 15_000;
  offlineAutoDownload.deps.platform = () => 'electron';
  offlineAutoDownload.deps.connection = () => 'wifi';
}

describe('Офлайн 2.0: избранное скачивается само', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearAllData();
    streamResolver.clearCache();
    resetService();
    setFavorites([]);
    // Офлайн-режим даёт битрейт сжатия; сжатия в тестах нет, но init должен быть чистым.
    (offlineMode as unknown as { initialised: Promise<void> | null }).initialised = null;

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
    setFavorites([]);
  });

  describe('Настройки', () => {
    it('по умолчанию выключено, только по Wi‑Fi, лимит 5 ГБ', async () => {
      await offlineAutoDownload.init();
      const state = offlineAutoDownload.getState();
      expect(state.enabled).toBe(false);
      expect(state.wifiOnly).toBe(true);
      expect(state.limitBytes).toBe(DEFAULT_FAVORITES_LIMIT_BYTES);
    });

    it('запоминает положение всех трёх настроек между запусками', async () => {
      await offlineAutoDownload.init();
      const twoGb = FAVORITES_LIMIT_OPTIONS.find((option) => option.label === '2 ГБ')!.bytes;
      await offlineAutoDownload.setEnabled(true);
      await offlineAutoDownload.setWifiOnly(false);
      await offlineAutoDownload.setLimitBytes(twoGb);

      expect(await getSetting<boolean>(FAVORITES_AUTO_SETTING, false)).toBe(true);
      expect(await getSetting<boolean>(FAVORITES_WIFI_ONLY_SETTING, true)).toBe(false);
      expect(await getSetting<number>(FAVORITES_LIMIT_SETTING, 0)).toBe(twoGb);

      resetService();
      await offlineAutoDownload.init();
      const state = offlineAutoDownload.getState();
      expect(state.enabled).toBe(true);
      expect(state.wifiOnly).toBe(false);
      expect(state.limitBytes).toBe(twoGb);
    });

    it('«только по Wi‑Fi» показывается только на телефоне', async () => {
      await offlineAutoDownload.init();
      expect(offlineAutoDownload.getState().wifiOnlyApplies).toBe(false);
      offlineAutoDownload.deps.platform = () => 'mobile';
      expect(offlineAutoDownload.getState().wifiOnlyApplies).toBe(true);
    });
  });

  describe('Очередь', () => {
    it('выключенная настройка ничего не делает, но цифры считает', async () => {
      setFavorites([makeTrack('yt_a'), makeTrack('yt_b')]);
      await seedCached('yt_a', { sizeBytes: 2 * KIB });

      await offlineAutoDownload.sync();

      expect(global.fetch).not.toHaveBeenCalled();
      expect(await offlineStorage.isDownloaded('yt_b')).toBe(false);
      const state = offlineAutoDownload.getState();
      expect(state.favoritesTotal).toBe(2);
      expect(state.favoritesOffline).toBe(1);
      expect(state.queued).toBe(1);
    });

    it('качает только то избранное, которого нет офлайн, и ничего лишнего', async () => {
      setFavorites([makeTrack('yt_have'), makeTrack('yt_need'), makeTrack('sc_clip', { isPreview: true })]);
      await seedCached('yt_have', { sizeBytes: 2 * KIB });
      await seedCached('yt_other', { sizeBytes: 2 * KIB });
      await offlineAutoDownload.init();
      enable();

      await offlineAutoDownload.sync();

      expect(await offlineStorage.isDownloaded('yt_need')).toBe(true);
      // Отрывок в 30 секунд не считается ни скачанным, ни ожидающим.
      expect(await offlineStorage.isDownloaded('sc_clip')).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      // Чужая копия на месте: выселять при незаполненном лимите нечего.
      expect(await offlineStorage.isDownloaded('yt_other')).toBe(true);

      const record = await db.offlineTracks.get('yt_need');
      // Не autoCached: офлайн-режим под своим лимитом избранное не выселяет.
      expect(record?.autoCached).toBeUndefined();
      expect(record?.lastUsedAt).toBeGreaterThan(0);

      const state = offlineAutoDownload.getState();
      expect(state.favoritesTotal).toBe(2);
      expect(state.favoritesOffline).toBe(2);
      expect(state.queued).toBe(0);
      expect(state.lastError).toBeNull();
    });

    it('качает по одному, а не всё сразу', async () => {
      setFavorites([makeTrack('yt_1'), makeTrack('yt_2'), makeTrack('yt_3')]);
      await offlineAutoDownload.init();
      enable();

      let concurrent = 0;
      let peak = 0;
      vi.spyOn(offlineStorage, 'downloadTrack').mockImplementation(async (track) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 1));
        await seedCached(track.id, { sizeBytes: KIB });
        concurrent -= 1;
      });

      await offlineAutoDownload.sync();

      expect(peak).toBe(1);
      expect(offlineAutoDownload.getState().favoritesOffline).toBe(3);
    });

    it('4.0.2: в «последней проблеме» — фраза для человека, а не вывод yt-dlp', async () => {
      setFavorites([makeTrack('yt_bot')]);
      await offlineAutoDownload.init();
      enable();
      vi.spyOn(offlineStorage, 'downloadTrack').mockRejectedValue(
        new Error(
          "YT_BOT_CHECK: YouTube просит подтвердить, что вы не робот; ios: WARNING: ffmpeg location /data/app/x/libffmpeg.so does not exist! ERROR: [youtube] abc: Sign in to confirm you're not a bot. See https://github.com/yt-dlp/yt-dlp/wiki/FAQ"
        )
      );

      await offlineAutoDownload.sync();

      const text = offlineAutoDownload.getState().lastError || '';
      expect(text).toBe('YouTube попросил подтвердить, что запросы идут не от робота. Попробуем позже.');
      expect(text).not.toMatch(/https?:|\/data\/|WARNING|ERROR|ffmpeg/);
    });

    it('4.0.2: источник не пускает три раза подряд — проход окончен, остальные не трогаем', async () => {
      setFavorites(['yt_a', 'yt_b', 'yt_c', 'yt_d', 'yt_e', 'yt_f'].map((id) => makeTrack(id)));
      await offlineAutoDownload.init();
      enable();
      const spy = vi
        .spyOn(offlineStorage, 'downloadTrack')
        .mockRejectedValue(new Error('YT_BOT_CHECK: YouTube просит подтвердить, что вы не робот'));

      await offlineAutoDownload.sync();

      // Восемьдесят запросов в ответ на «вы не робот» только продлили бы проверку.
      expect(spy).toHaveBeenCalledTimes(3);
      expect(offlineAutoDownload.getState().queued).toBe(6);
    });

    it('4.0.2: отказ конкретной песни серию не считает — очередь идёт до конца', async () => {
      setFavorites(['yt_a', 'yt_b', 'yt_c', 'yt_d', 'yt_e'].map((id) => makeTrack(id)));
      await offlineAutoDownload.init();
      enable();
      const spy = vi.spyOn(offlineStorage, 'downloadTrack').mockImplementation(async (track) => {
        if (track.id !== 'yt_e') throw new Error('YT_PRIVATE: это приватное видео');
        await seedCached(track.id, { sizeBytes: KIB });
      });

      await offlineAutoDownload.sync();

      expect(spy).toHaveBeenCalledTimes(5);
      expect(await offlineStorage.isDownloaded('yt_e')).toBe(true);
    });

    it('недоступный трек не останавливает остальные и попадает в «последнюю проблему»', async () => {
      setFavorites([makeTrack('yt_broken'), makeTrack('yt_fine')]);
      await offlineAutoDownload.init();
      enable();
      vi.spyOn(offlineStorage, 'downloadTrack').mockImplementation(async (track) => {
        if (track.id === 'yt_broken') throw new Error('Поток не отдали');
        await seedCached(track.id, { sizeBytes: KIB });
      });

      await offlineAutoDownload.sync();

      expect(await offlineStorage.isDownloaded('yt_fine')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_broken')).toBe(false);
      expect(offlineAutoDownload.getState().lastError).toContain('Поток не отдали');
      expect(offlineAutoDownload.getState().queued).toBe(1);
    });
  });

  describe('Лимит места', () => {
    it('вытесняет самое давно не слушанное не из избранного, а избранное оставляет', async () => {
      // Лимит 10 КиБ, занято 10 КиБ: три чужих копии и одна любимая.
      await seedCached('yt_old', { sizeBytes: 3 * KIB, lastUsedAt: 100 });
      await seedCached('yt_recent', { sizeBytes: 3 * KIB, lastUsedAt: 900 });
      await seedCached('yt_mid', { sizeBytes: 2 * KIB, lastUsedAt: 500 });
      await seedCached('yt_fav_have', { sizeBytes: 2 * KIB, lastUsedAt: 50 });
      setFavorites([makeTrack('yt_fav_have'), makeTrack('yt_fav_need')]);
      await offlineAutoDownload.init();
      enable();
      (offlineAutoDownload as unknown as Internals).limitBytes = 10 * KIB;

      await offlineAutoDownload.sync();

      // Хватило одного самого давнего: 10 − 3 = 7 < 10, место есть.
      expect(await offlineStorage.isDownloaded('yt_old')).toBe(false);
      expect(await offlineStorage.isDownloaded('yt_mid')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_recent')).toBe(true);
      // Любимое старше всех по времени, но его не трогаем.
      expect(await offlineStorage.isDownloaded('yt_fav_have')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_fav_need')).toBe(true);
      expect(offlineAutoDownload.getState().storageFull).toBe(false);
    });

    it('если место занято одним избранным — останавливается и говорит об этом', async () => {
      await seedCached('yt_fav_a', { sizeBytes: 6 * KIB });
      await seedCached('yt_fav_b', { sizeBytes: 6 * KIB });
      setFavorites([makeTrack('yt_fav_a'), makeTrack('yt_fav_b'), makeTrack('yt_fav_c')]);
      await offlineAutoDownload.init();
      enable();
      (offlineAutoDownload as unknown as Internals).limitBytes = 10 * KIB;

      await offlineAutoDownload.sync();

      expect(global.fetch).not.toHaveBeenCalled();
      expect(await offlineStorage.isDownloaded('yt_fav_a')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_fav_b')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_fav_c')).toBe(false);
      const state = offlineAutoDownload.getState();
      expect(state.storageFull).toBe(true);
      expect(state.queued).toBe(1);
    });

    it('без лимита ничего не вытесняет', async () => {
      await seedCached('yt_other', { sizeBytes: 50 * KIB, lastUsedAt: 1 });
      setFavorites([makeTrack('yt_fav')]);
      await offlineAutoDownload.init();
      enable();
      await offlineAutoDownload.setLimitBytes(0);

      await offlineAutoDownload.sync();

      expect(await offlineStorage.isDownloaded('yt_other')).toBe(true);
      expect(await offlineStorage.isDownloaded('yt_fav')).toBe(true);
    });
  });

  describe('Сеть', () => {
    it('«только по Wi‑Fi» на сотовой сети ждёт, а по Wi‑Fi продолжает', async () => {
      setFavorites([makeTrack('yt_wait')]);
      await offlineAutoDownload.init();
      enable();
      offlineAutoDownload.deps.platform = () => 'mobile';
      offlineAutoDownload.deps.connection = () => 'cellular';

      await offlineAutoDownload.sync();

      expect(global.fetch).not.toHaveBeenCalled();
      expect(offlineAutoDownload.getState().waitingForWifi).toBe(true);
      expect(offlineAutoDownload.getState().lastError).toBeNull();

      offlineAutoDownload.deps.connection = () => 'wifi';
      await offlineAutoDownload.sync();

      expect(await offlineStorage.isDownloaded('yt_wait')).toBe(true);
      expect(offlineAutoDownload.getState().waitingForWifi).toBe(false);
    });

    it('на ПК сотовая сеть не мешает: там этой настройки нет', async () => {
      setFavorites([makeTrack('yt_desktop')]);
      await offlineAutoDownload.init();
      enable();
      offlineAutoDownload.deps.platform = () => 'electron';
      offlineAutoDownload.deps.connection = () => 'cellular';

      await offlineAutoDownload.sync();

      expect(await offlineStorage.isDownloaded('yt_desktop')).toBe(true);
    });

    it('с выключенным «только по Wi‑Fi» качает и по сотовой', async () => {
      setFavorites([makeTrack('yt_cell')]);
      await offlineAutoDownload.init();
      enable();
      await offlineAutoDownload.setWifiOnly(false);
      offlineAutoDownload.deps.platform = () => 'mobile';
      offlineAutoDownload.deps.connection = () => 'cellular';

      await offlineAutoDownload.sync();

      expect(await offlineStorage.isDownloaded('yt_cell')).toBe(true);
    });

    it('тип сети читается из navigator.connection, а без него считается Wi‑Fi', () => {
      expect(classifyConnection(undefined)).toBe('wifi');
      expect(classifyConnection({})).toBe('wifi');
      expect(classifyConnection({ onLine: false })).toBe('offline');
      expect(classifyConnection({ connection: { type: 'cellular' } })).toBe('cellular');
      expect(classifyConnection({ connection: { type: 'wifi' } })).toBe('wifi');
      expect(classifyConnection({ connection: { type: 'none' } })).toBe('offline');
      expect(classifyConnection({ connection: { effectiveType: '3g' } })).toBe('cellular');
      expect(classifyConnection({ connection: { effectiveType: '4g' } })).toBe('wifi');
    });
  });

  describe('Запуск', () => {
    it('первый проход идёт с отсрочкой, а новое сердечко зовёт следующий', async () => {
      vi.useFakeTimers();
      try {
        offlineAutoDownload.deps.startupDelayMs = 1_000;
        offlineAutoDownload.deps.favoritesDebounceMs = 100;
        const sync = vi.spyOn(offlineAutoDownload, 'sync').mockResolvedValue();

        const stop = offlineAutoDownload.start();
        // До срабатывания таймера загрузка медиатеки проход не вызывает.
        setFavorites([makeTrack('yt_boot')]);
        await vi.advanceTimersByTimeAsync(500);
        expect(sync).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(600);
        expect(sync).toHaveBeenCalledTimes(1);

        setFavorites([makeTrack('yt_new'), makeTrack('yt_boot')]);
        await vi.advanceTimersByTimeAsync(150);
        expect(sync).toHaveBeenCalledTimes(2);

        // Удаление из избранного проход не зовёт: качать нечего.
        setFavorites([makeTrack('yt_boot')]);
        await vi.advanceTimersByTimeAsync(150);
        expect(sync).toHaveBeenCalledTimes(2);

        stop();
        setFavorites([makeTrack('yt_after'), makeTrack('yt_boot')]);
        await vi.advanceTimersByTimeAsync(150);
        expect(sync).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('повторный start не дублирует подписки', () => {
      const first = offlineAutoDownload.start();
      const second = offlineAutoDownload.start();
      expect(second).toBe(first);
      first();
    });
  });

  it('размер пишется по-русски и с запятой', () => {
    expect(formatRuBytes(0)).toBe('0 МБ');
    expect(formatRuBytes(640 * 1024 * 1024)).toBe('640 МБ');
    expect(formatRuBytes(1.3 * 1024 * 1024 * 1024)).toBe('1,3 ГБ');
    expect(formatRuBytes(5 * 1024 * 1024 * 1024)).toBe('5 ГБ');
    expect(formatRuBytes(12 * 1024 * 1024 * 1024)).toBe('12 ГБ');
  });
});
