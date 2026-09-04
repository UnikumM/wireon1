/**
 * Offline mode: one switch instead of a download button per track.
 *
 * The old flow asked the user to press "скачать" on every song, which nobody
 * does, and left the library split between "downloaded" and "not". Offline mode
 * inverts it: turn it on, and whatever you actually listen to is kept on disk
 * automatically, oldest-unplayed copies making room for new ones once the size
 * cap is reached.
 *
 * Everything here is a no-op while the switch is off, so the player can call
 * {@link OfflineModeService.noteListened} unconditionally.
 */

import type { UnifiedTrack } from '../types/music';
import { db, getSetting, setSetting } from './db';
import { offlineStorage } from './offlineStorage';

export const OFFLINE_MODE_SETTING = 'offline.enabled';
export const OFFLINE_LIMIT_SETTING = 'offline.limitBytes';
export const OFFLINE_BITRATE_SETTING = 'offline.bitrateKbps';

const GIB = 1024 * 1024 * 1024;

/** `bytes: 0` means no cap — evict nothing, keep everything played. */
export const OFFLINE_LIMIT_OPTIONS: ReadonlyArray<{ label: string; bytes: number }> = [
  { label: '1 ГБ', bytes: GIB },
  { label: '5 ГБ', bytes: 5 * GIB },
  { label: '10 ГБ', bytes: 10 * GIB },
  { label: '20 ГБ', bytes: 20 * GIB },
  { label: 'Без ограничений', bytes: 0 }
];

/**
 * Во что пережимать сохранённое. `kbps: 0` — не пережимать вовсе.
 *
 * Значения совпадают со списком в electron/transcoder.ts — тот всё равно
 * проверяет пришедшее, но расходиться этим двум спискам незачем.
 */
export const OFFLINE_BITRATE_OPTIONS: ReadonlyArray<{ label: string; kbps: number; hint: string }> = [
  { label: 'Без сжатия', kbps: 0, hint: 'Как у источника, обычно ~128 кбит/с' },
  { label: '64 кбит/с', kbps: 64, hint: 'Втрое меньше места, для наушников в дороге' },
  { label: '96 кбит/с', kbps: 96, hint: 'Вдвое меньше места, разницу почти не слышно' },
  { label: '128 кбит/с', kbps: 128, hint: 'Немного меньше места, звук как у источника' },
  { label: '160 кбит/с', kbps: 160, hint: 'Максимум качества, экономия небольшая' }
];

export const DEFAULT_OFFLINE_LIMIT_BYTES = 5 * GIB;

/** Заметно экономит место, и на обычных наушниках разницы не слышно. */
export const DEFAULT_OFFLINE_BITRATE_KBPS = 96;

export interface OfflineModeState {
  enabled: boolean;
  limitBytes: number;
  /** Битрейт сжатия; `0` — сохранять как скачали. */
  bitrateKbps: number;
  /** Есть ли чем сжимать: в веб-сборке и старой оболочке — нет. */
  compressionAvailable: boolean;
  /** Track being cached right now, if any. */
  cachingTrackId: string | null;
  cachingProgress: number;
  /** Tracks waiting their turn. */
  pendingCount: number;
  /**
   * Прогресс ручной загрузки плейлиста: сколько уже сохранено из скольких.
   * Оба нуля — ручной загрузки сейчас нет.
   */
  batchDone: number;
  batchTotal: number;
  lastError: string | null;
}

/**
 * Заявка в очереди сохранения.
 *
 * `manual` — человек нажал «сохранить плейлист». Такие качаются, даже когда
 * автосохранение выключено, переживают его выключение и не помечаются
 * `autoCached`, то есть под лимит их никто не выселит.
 */
interface QueuedTrack {
  track: UnifiedTrack;
  manual: boolean;
}

type Listener = (state: OfflineModeState) => void;

class OfflineModeService {
  private enabled = false;
  private limitBytes = DEFAULT_OFFLINE_LIMIT_BYTES;
  private bitrateKbps = DEFAULT_OFFLINE_BITRATE_KBPS;
  private compressionAvailable = false;
  private readonly pending: QueuedTrack[] = [];
  private cachingTrackId: string | null = null;
  /** Скачивается ли прямо сейчас ручная заявка: от этого зависит, кто её отменяет. */
  private cachingManual = false;
  private cachingProgress = 0;
  private batchDone = 0;
  private batchTotal = 0;
  private lastError: string | null = null;
  private pumping = false;
  private initialised: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();

  /** Reads the persisted switch. Safe to call repeatedly; only the first reads. */
  public init(): Promise<void> {
    if (!this.initialised) {
      this.initialised = (async () => {
        const [enabled, limitBytes, bitrate] = await Promise.all([
          getSetting<boolean>(OFFLINE_MODE_SETTING, false),
          getSetting<number>(OFFLINE_LIMIT_SETTING, DEFAULT_OFFLINE_LIMIT_BYTES),
          getSetting<number>(OFFLINE_BITRATE_SETTING, DEFAULT_OFFLINE_BITRATE_KBPS)
        ]);
        this.enabled = enabled === true;
        this.limitBytes = this.sanitizeLimit(limitBytes);
        this.bitrateKbps = this.sanitizeBitrate(bitrate);
        this.notify();
        // Отдельно и не блокируя остальное: ответ нужен только чтобы настройки
        // не предлагали сжатие там, где его нет.
        this.compressionAvailable = await offlineStorage.isCompressionAvailable();
        this.notify();
      })().catch((err) => {
        console.error('[OfflineMode] Не удалось прочитать настройки:', err);
      });
    }
    return this.initialised;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getLimitBytes(): number {
    return this.limitBytes;
  }

  public getBitrateKbps(): number {
    return this.bitrateKbps;
  }

  public getState(): OfflineModeState {
    return {
      enabled: this.enabled,
      limitBytes: this.limitBytes,
      bitrateKbps: this.bitrateKbps,
      compressionAvailable: this.compressionAvailable,
      cachingTrackId: this.cachingTrackId,
      cachingProgress: this.cachingProgress,
      pendingCount: this.pending.length,
      batchDone: this.batchDone,
      batchTotal: this.batchTotal,
      lastError: this.lastError
    };
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) {
      // Turning it off stops future caching and drops the backlog, but keeps
      // what is already on disk: the user asked to stop growing, not to lose.
      //
      // Ручные заявки остаются: «сохранить плейлист» — отдельная просьба, и
      // выключение автосохранения её не отменяет.
      const manual = this.pending.filter((item) => item.manual);
      this.pending.length = 0;
      this.pending.push(...manual);
      if (this.cachingTrackId && !this.cachingManual) {
        offlineStorage.abortDownload(this.cachingTrackId);
      }
    }
    this.lastError = null;
    this.notify();
    await setSetting(OFFLINE_MODE_SETTING, enabled);
  }

  public async setLimitBytes(bytes: number): Promise<void> {
    this.limitBytes = this.sanitizeLimit(bytes);
    this.notify();
    await setSetting(OFFLINE_LIMIT_SETTING, this.limitBytes);
    // A lower cap has to bite immediately, otherwise the setting reads as a lie
    // until the next track happens to be cached.
    await this.enforceLimit();
  }

  /**
   * Меняет качество сжатия. Уже сохранённое не трогает: пережимать библиотеку
   * заново — это часы работы ради места, которое человек не просил освободить.
   */
  public async setBitrateKbps(kbps: number): Promise<void> {
    this.bitrateKbps = this.sanitizeBitrate(kbps);
    this.notify();
    await setSetting(OFFLINE_BITRATE_SETTING, this.bitrateKbps);
  }

  /**
   * Ставит в очередь то, что человек попросил сохранить целиком — плейлист,
   * альбом, избранное.
   *
   * Работает независимо от переключателя автосохранения: это отдельная просьба,
   * а не побочный эффект прослушивания. Возвращает, сколько заявок реально
   * добавилось, — уже сохранённое и повторы не считаются.
   */
  public async queueTracks(tracks: ReadonlyArray<UnifiedTrack>): Promise<number> {
    if (!Array.isArray(tracks) || tracks.length === 0) return 0;

    let added = 0;
    for (const track of tracks) {
      if (!track || !track.id) continue;
      if (track.isPreview) continue; // тридцатисекундный отрывок сохранять незачем
      if (this.cachingTrackId === track.id) continue;
      if (this.pending.some((queued) => queued.track.id === track.id)) continue;
      if (await offlineStorage.isDownloaded(track.id)) continue;

      this.pending.push({ track, manual: true });
      this.batchTotal += 1;
      added += 1;
    }

    if (added > 0) {
      this.lastError = null;
      this.notify();
      void this.pump();
    }
    return added;
  }

  /**
   * Отменяет незапущенные ручные заявки и то, что качается прямо сейчас.
   *
   * Автоматические заявки не трогает: человек останавливает свою загрузку
   * плейлиста, а не выключает офлайн-режим.
   */
  public cancelBatch(): void {
    const auto = this.pending.filter((item) => !item.manual);
    this.pending.length = 0;
    this.pending.push(...auto);
    if (this.cachingTrackId && this.cachingManual) {
      offlineStorage.abortDownload(this.cachingTrackId);
    }
    this.batchDone = 0;
    this.batchTotal = 0;
    this.notify();
  }

  /**
   * Called for every track that starts playing. Queues a copy for caching and
   * stamps the existing copy as used, which is what keeps LRU eviction honest.
   */
  public noteListened(track: UnifiedTrack | null | undefined): void {
    if (!track || !track.id) return;
    void this.touch(track.id);
    if (!this.enabled) return;
    if (track.isPreview) return; // a 30-second SoundCloud snippet is not worth disk
    if (this.cachingTrackId === track.id) return;
    if (this.pending.some((queued) => queued.track.id === track.id)) return;

    void (async () => {
      if (await offlineStorage.isDownloaded(track.id)) return;
      if (!this.enabled) return;
      // Ещё одна проверка после await: пока шёл запрос к базе, тот же трек мог
      // попасть в очередь ручной загрузкой плейлиста — иначе он скачается дважды.
      if (this.cachingTrackId === track.id) return;
      if (this.pending.some((queued) => queued.track.id === track.id)) return;
      this.pending.push({ track, manual: false });
      this.notify();
      void this.pump();
    })();
  }

  /** Records that a cached copy was played, for eviction order. */
  public async touch(trackId: string): Promise<void> {
    if (!trackId) return;
    try {
      const record = await db.offlineTracks.get(trackId);
      if (!record) return;
      await db.offlineTracks.put({ ...record, lastUsedAt: Date.now() });
    } catch (err) {
      console.warn('[OfflineMode] Не удалось отметить трек как прослушанный:', err);
    }
  }

  /**
   * Drops automatically cached copies, oldest-played first, until the cache fits
   * the cap. Copies saved on purpose (`autoCached !== true`) are never evicted —
   * the user asked for those by hand.
   */
  public async enforceLimit(protectTrackId?: string): Promise<number> {
    if (this.limitBytes <= 0) return 0;

    try {
      const records = await db.offlineTracks.toArray();
      let total = records.reduce((sum, record) => sum + this.recordSize(record), 0);
      if (total <= this.limitBytes) return 0;

      const evictable = records
        .filter((record) => record.autoCached === true && record.id !== protectTrackId)
        .sort((a, b) => (a.lastUsedAt ?? a.downloadedAt ?? 0) - (b.lastUsedAt ?? b.downloadedAt ?? 0));

      let evicted = 0;
      for (const record of evictable) {
        if (total <= this.limitBytes) break;
        await offlineStorage.deleteOfflineTrack(record.id);
        total -= this.recordSize(record);
        evicted += 1;
      }

      if (total > this.limitBytes) {
        // Only hand-saved copies are left, so the cap cannot be met without
        // deleting something the user chose to keep. Say so instead.
        this.lastError = 'Кэш больше лимита: остались только сохранённые вручную треки';
        this.notify();
      }
      return evicted;
    } catch (err) {
      console.error('[OfflineMode] Не удалось применить лимит хранилища:', err);
      return 0;
    }
  }

  // -- internals ------------------------------------------------------------

  private sanitizeLimit(bytes: unknown): number {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      return DEFAULT_OFFLINE_LIMIT_BYTES;
    }
    return Math.floor(bytes);
  }

  /** Только из предложенного списка: остальное — испорченная настройка. */
  private sanitizeBitrate(kbps: unknown): number {
    const numeric = typeof kbps === 'number' ? kbps : Number(kbps);
    if (!Number.isFinite(numeric)) return DEFAULT_OFFLINE_BITRATE_KBPS;
    return OFFLINE_BITRATE_OPTIONS.some((option) => option.kbps === numeric)
      ? numeric
      : DEFAULT_OFFLINE_BITRATE_KBPS;
  }

  private recordSize(record: { sizeBytes?: number; blob?: Blob }): number {
    return record.sizeBytes || record.blob?.size || 0;
  }

  /** One track at a time: caching must never compete with playback for bandwidth. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;

    try {
      // Ручные заявки идут и при выключенном автосохранении: очередь
      // останавливается только когда в ней нет ничего, что можно качать.
      while (this.pending.length > 0 && (this.enabled || this.pending.some((item) => item.manual))) {
        const at = this.enabled ? 0 : this.pending.findIndex((item) => item.manual);
        if (at < 0) break;
        const [queued] = this.pending.splice(at, 1);
        if (!queued) break;
        const { track, manual } = queued;

        this.cachingTrackId = track.id;
        this.cachingManual = manual;
        this.cachingProgress = 0;
        this.notify();

        try {
          await offlineStorage.downloadTrack(
            track,
            (pct) => {
              this.cachingProgress = pct;
              this.notify();
            },
            { compressBitrateKbps: this.bitrateKbps }
          );
          // Ручное сохранение не помечается автоматическим: под лимит выселяется
          // только то, что приложение решило скачать само.
          if (manual) {
            await this.touch(track.id);
          } else {
            await this.stampAutoCached(track.id);
          }
          await this.enforceLimit(track.id);
          this.lastError = null;
        } catch (err) {
          // A single unavailable stream must not stop the queue behind it.
          this.lastError = err instanceof Error ? err.message : 'Не удалось сохранить трек';
          console.warn(`[OfflineMode] Трек ${track.id} не сохранён:`, err);
        } finally {
          this.cachingTrackId = null;
          this.cachingManual = false;
          this.cachingProgress = 0;
          // Счётчик двигается и на ошибке: «3 из 10» должно доходить до конца,
          // иначе полоса замирает на первом же недоступном треке.
          if (manual) this.batchDone += 1;
          if (this.batchTotal > 0 && this.batchDone >= this.batchTotal) {
            this.batchDone = 0;
            this.batchTotal = 0;
          }
          this.notify();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async stampAutoCached(trackId: string): Promise<void> {
    try {
      const record = await db.offlineTracks.get(trackId);
      if (!record) return;
      await db.offlineTracks.put({ ...record, autoCached: true, lastUsedAt: Date.now() });
    } catch (err) {
      console.warn('[OfflineMode] Не удалось пометить автосохранённый трек:', err);
    }
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[OfflineMode] Ошибка в слушателе состояния:', err);
      }
    }
  }
}

export const offlineMode = new OfflineModeService();
