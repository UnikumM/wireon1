import { db, OfflineTrackRecord } from './db';
import { UnifiedTrack } from '../types/music';
import { streamResolver } from './streamResolver';

export type { OfflineTrackRecord };

export interface StorageUsage {
  count: number;
  trackCount: number;
  totalBytes: number;
  formattedSize: string;
}

export interface DownloadOptions {
  /**
   * Битрейт opus для сжатия; `0` или пропуск — сохранить как скачали.
   *
   * Решение принимает вызывающий (офлайн-режим читает настройку), а не это
   * хранилище: оно не должно знать про настройки.
   */
  compressBitrateKbps?: number;
}

/** Контейнер сжатого результата: только в Ogg его играет Chromium. */
const OPUS_MIME = 'audio/ogg; codecs=opus';

/** Расширение источника для ffmpeg — по MIME того, что отдал сервер. */
function guessSourceExt(mime: string | null | undefined, track: UnifiedTrack): string {
  const type = String(mime || '').toLowerCase();
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg') || type.includes('opus')) return 'opus';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  return track.format === 'opus' ? 'opus' : 'm4a';
}

type OfflineChangeListener = () => void;

class OfflineStorageService {
  private activeDownloads: Map<string, { controller: AbortController; progress: number }> = new Map();
  private objectUrlCache: Map<string, string> = new Map();
  private listeners: Set<OfflineChangeListener> = new Set();
  /** Ответ на «есть ли ffmpeg»: не меняется за время работы, спрашиваем раз. */
  private compressionAvailable: boolean | null = null;

  /**
   * Subscribes to storage changes (downloads, deletions, clears)
   */
  public subscribe(listener: OfflineChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        console.error('[OfflineStorage] Error in change listener:', err);
      }
    });
  }

  /**
   * Formats bytes into a human-readable string (e.g., "84.5 MB")
   */
  public formatBytes(bytes: number, decimals = 1): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const index = Math.min(i, sizes.length - 1);
    const value = parseFloat((bytes / Math.pow(k, index)).toFixed(dm));
    return `${value} ${sizes[index]}`;
  }

  /**
   * Checks if a track download is currently in progress
   */
  public isDownloading(trackId: string): boolean {
    return this.activeDownloads.has(trackId);
  }

  /**
   * Returns the current download progress (0-100) for a track
   */
  public getDownloadProgress(trackId: string): number {
    return this.activeDownloads.get(trackId)?.progress ?? 0;
  }

  /**
   * Aborts an active download
   */
  public abortDownload(trackId: string): void {
    const active = this.activeDownloads.get(trackId);
    if (active) {
      active.controller.abort();
      this.activeDownloads.delete(trackId);
      this.notify();
    }
  }

  /**
   * Checks if a track is downloaded and available in offline storage
   */
  public async isDownloaded(trackId: string): Promise<boolean> {
    if (!trackId) return false;
    try {
      const record = await db.offlineTracks.get(trackId);
      return !!record;
    } catch (err) {
      console.error('[OfflineStorage] isDownloaded error:', err);
      return false;
    }
  }

  /**
   * Downloads an audio stream for a track, computes its size, and stores it in Dexie
   */
  public async downloadTrack(
    track: UnifiedTrack,
    onProgress?: (pct: number) => void,
    options?: DownloadOptions
  ): Promise<void> {
    if (!track || !track.id) {
      throw new Error('Invalid track provided to downloadTrack');
    }

    if (this.activeDownloads.has(track.id)) {
      console.warn(`[OfflineStorage] Download already in progress for ${track.id}`);
      return;
    }

    const controller = new AbortController();
    const downloadState = { controller, progress: 0 };
    this.activeDownloads.set(track.id, downloadState);
    this.notify();

    const reportProgress = (pct: number) => {
      downloadState.progress = pct;
      if (onProgress) {
        try {
          onProgress(pct);
        } catch (err) {
          console.error('[OfflineStorage] Progress callback error:', err);
        }
      }
    };

    try {
      reportProgress(5);

      // 1. Resolve direct stream URL
      // Фоновым приоритетом: сохранение идёт само и может длиться минутами, а
      // нажатие play в это время ждать очереди извлекателя не должно.
      const streamInfo = await streamResolver.resolve(track, false, 'prefetch');
      if (!streamInfo || !streamInfo.streamUrl) {
        // Это сообщение доходит до настроек офлайна как «последняя проблема»,
        // поэтому оно по-русски.
        throw new Error(`Не удалось получить поток для «${track.title || track.id}»`);
      }

      reportProgress(15);

      /*
       * 2. Забираем звук.
       *
       * `Range` здесь не украшение и не осторожность. Замерено на живой ссылке
       * googlevideo с этой же машины: без него отдача идёт **30 КБ/с**, и
       * соединение вдобавок рвётся, не докачав; с `Range: bytes=0-` та же
       * ссылка отдаётся на **1–3 МБ/с**. Разница в тридцать раз — это разница
       * между «трек сохранился за пару секунд» и «сохранение идёт дольше, чем
       * играет песня», а сохраняется у нас каждый прослушанный трек.
       *
       * Открытый конец, а не куски: нам нужен файл целиком, и один запрос
       * проще, чем сборка из частей.
       */
      const response = await fetch(streamInfo.streamUrl, {
        headers: { Range: 'bytes=0-' },
        signal: controller.signal
      });

      // 206 на запрос с `Range` — такой же успех, как 200; `response.ok`
      // покрывает оба, но подпись отказа должна называть код честно.
      if (!response.ok) {
        throw new Error(
          `Failed to fetch audio stream: ${response.status} ${response.statusText}`
        );
      }

      const contentLengthHeader = response.headers?.get?.('content-length');
      const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
      const contentType = response.headers?.get?.('content-type') || null;
      let blob: Blob;

      // 3. Process stream chunks if readable body is available
      if (
        response.body &&
        typeof response.body.getReader === 'function' &&
        totalBytes > 0
      ) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let receivedBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            receivedBytes += value.length;
            // До 90, а не до 95: остаток шкалы забирает сжатие, см. ниже.
            const pct = Math.min(
              90,
              Math.max(15, Math.round((receivedBytes / totalBytes) * 75) + 15)
            );
            reportProgress(pct);
          }
        }

        blob = new Blob(chunks as BlobPart[], {
          type: contentType || (track.format === 'opus' ? 'audio/ogg' : 'audio/mpeg')
        });
      } else {
        // Fallback for mock/simple fetch environments
        blob = await response.blob();
        reportProgress(90);
      }

      // 3.5. Сжать, если попросили и есть чем
      let format = track.format || streamInfo.format;
      let bitrate = track.bitrate || streamInfo.bitrate;
      const wantedBitrate = options?.compressBitrateKbps || 0;
      if (wantedBitrate > 0) {
        const compressed = await this.compress(blob, wantedBitrate, guessSourceExt(contentType, track));
        if (compressed) {
          blob = compressed;
          // Формат записывается по факту: от него зависит и MIME при
          // воспроизведении, и то, что покажет библиотека.
          format = 'opus';
          bitrate = wantedBitrate;
        }
        reportProgress(98);
      }

      const sizeBytes = blob.size || totalBytes || 0;

      // 4. Save record to Dexie IndexedDB
      const record: OfflineTrackRecord = {
        id: track.id,
        track: {
          ...track,
          format,
          bitrate
        },
        blob,
        sizeBytes,
        downloadedAt: Date.now()
      };

      await db.offlineTracks.put(record);
      reportProgress(100);
    } catch (err) {
      if (controller.signal.aborted) {
        console.warn(`[OfflineStorage] Download cancelled for ${track.id}`);
        return;
      }
      console.error(`[OfflineStorage] Failed to download track ${track.id}:`, err);
      throw err;
    } finally {
      this.activeDownloads.delete(track.id);
      this.notify();
    }
  }

  /**
   * Есть ли в этой сборке чем сжимать.
   *
   * Спрашивается один раз и запоминается: ответ за время работы не меняется, а
   * настройки офлайна его читают на каждый рендер.
   */
  public async isCompressionAvailable(): Promise<boolean> {
    if (this.compressionAvailable !== null) return this.compressionAvailable;
    const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!bridge || typeof bridge.transcodeAvailable !== 'function' || typeof bridge.transcodeAudio !== 'function') {
      // Веб-сборка или старая версия оболочки: сжимать нечем, но сохранять можно.
      this.compressionAvailable = false;
      return false;
    }
    try {
      this.compressionAvailable = (await bridge.transcodeAvailable()) === true;
    } catch {
      this.compressionAvailable = false;
    }
    return this.compressionAvailable;
  }

  /**
   * Пережимает скачанное в opus.
   *
   * `null` — «оставь как было»: сжатия нет, оно не удалось или не уменьшило
   * файл. Ошибку наружу не отдаём — потерять трек из-за неудачного сжатия
   * хуже, чем сохранить его исходным размером.
   */
  private async compress(blob: Blob, bitrateKbps: number, sourceExt: string): Promise<Blob | null> {
    if (!(await this.isCompressionAvailable())) return null;
    const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!bridge?.transcodeAudio) return null;

    try {
      const buffer = await blob.arrayBuffer();
      const result = await bridge.transcodeAudio({
        data: new Uint8Array(buffer),
        bitrateKbps,
        sourceExt
      });
      if (!result || !result.compressed || !result.data || result.data.byteLength === 0) {
        if (result?.reason) {
          console.info(`[OfflineStorage] Сохраняем без сжатия: ${result.reason}`);
        }
        return null;
      }
      // Копия, а не сама пришедшая через IPC структура: у неё может быть свой
      // байтовый отступ, а Blob обязан получить ровно эти байты.
      return new Blob([new Uint8Array(result.data)], { type: OPUS_MIME });
    } catch (err) {
      console.warn('[OfflineStorage] Сжатие не удалось, сохраняем как есть:', err);
      return null;
    }
  }

  /**
   * Retrieves the offline blob object URL for instant playback
   */
  public async getOfflineAudioUrl(trackId: string): Promise<string | null> {
    if (!trackId) return null;
    try {
      const record = await db.offlineTracks.get(trackId);
      if (!record || !record.blob) return null;

      let url = this.objectUrlCache.get(trackId);
      if (!url) {
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          url = URL.createObjectURL(record.blob);
        } else {
          url = `blob:offline-${trackId}`;
        }
        this.objectUrlCache.set(trackId, url);
      }
      return url;
    } catch (err) {
      console.error('[OfflineStorage] getOfflineAudioUrl error:', err);
      return null;
    }
  }

  /**
   * Retrieves a single offline track record
   */
  public async getOfflineTrack(trackId: string): Promise<OfflineTrackRecord | undefined> {
    if (!trackId) return undefined;
    try {
      return await db.offlineTracks.get(trackId);
    } catch (err) {
      console.error('[OfflineStorage] getOfflineTrack error:', err);
      return undefined;
    }
  }

  /**
   * Returns all offline tracks ordered by downloadedAt descending
   */
  public async getOfflineTracks(): Promise<OfflineTrackRecord[]> {
    try {
      return await db.offlineTracks.orderBy('downloadedAt').reverse().toArray();
    } catch (err) {
      console.error('[OfflineStorage] getOfflineTracks error:', err);
      return [];
    }
  }

  /**
   * Deletes a downloaded track from offline storage and revokes its object URL
   */
  public async deleteOfflineTrack(trackId: string): Promise<void> {
    if (!trackId) return;
    try {
      const cachedUrl = this.objectUrlCache.get(trackId);
      if (cachedUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        try {
          URL.revokeObjectURL(cachedUrl);
        } catch {
          // ignore revocation errors
        }
      }
      this.objectUrlCache.delete(trackId);
      await db.offlineTracks.delete(trackId);
      this.notify();
    } catch (err) {
      console.error('[OfflineStorage] deleteOfflineTrack error:', err);
      throw err;
    }
  }

  /**
   * Clears all offline tracks and revokes all cached object URLs
   */
  public async clearAllOffline(): Promise<void> {
    try {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        for (const url of this.objectUrlCache.values()) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore revocation errors
          }
        }
      }
      this.objectUrlCache.clear();
      await db.offlineTracks.clear();
      this.notify();
    } catch (err) {
      console.error('[OfflineStorage] clearAllOffline error:', err);
      throw err;
    }
  }

  /**
   * Computes the total number of downloaded tracks and total storage bytes used
   */
  public async getTotalStorageUsed(): Promise<StorageUsage> {
    try {
      const records = await db.offlineTracks.toArray();
      const count = records.length;
      const totalBytes = records.reduce((acc, r) => {
        const size = r.sizeBytes || (r.blob ? r.blob.size : 0) || 0;
        return acc + size;
      }, 0);

      return {
        count,
        trackCount: count,
        totalBytes,
        formattedSize: this.formatBytes(totalBytes)
      };
    } catch (err) {
      console.error('[OfflineStorage] getTotalStorageUsed error:', err);
      return {
        count: 0,
        trackCount: 0,
        totalBytes: 0,
        formattedSize: '0 B'
      };
    }
  }
}

export const offlineStorage = new OfflineStorageService();
export const offlineStorageService = offlineStorage;

// Export direct standalone functions for convenience
export const downloadTrack = (
  track: UnifiedTrack,
  onProgress?: (pct: number) => void,
  options?: DownloadOptions
) => offlineStorage.downloadTrack(track, onProgress, options);
export const isDownloaded = (trackId: string) => offlineStorage.isDownloaded(trackId);
export const getOfflineAudioUrl = (trackId: string) => offlineStorage.getOfflineAudioUrl(trackId);
export const getOfflineTrack = (trackId: string) => offlineStorage.getOfflineTrack(trackId);
export const getOfflineTracks = () => offlineStorage.getOfflineTracks();
export const deleteOfflineTrack = (trackId: string) => offlineStorage.deleteOfflineTrack(trackId);
export const clearAllOffline = () => offlineStorage.clearAllOffline();
export const getTotalStorageUsed = () => offlineStorage.getTotalStorageUsed();
export const formatStorageSize = (bytes: number) => offlineStorage.formatBytes(bytes);
