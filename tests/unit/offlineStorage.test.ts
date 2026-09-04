import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../setup';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { db, clearAllData, WireonDB, OfflineTrackRecord } from '../../src/services/db';
import {
  offlineStorage,
  downloadTrack,
  isDownloaded,
  getOfflineAudioUrl,
  getOfflineTrack,
  getOfflineTracks,
  deleteOfflineTrack,
  clearAllOffline,
  getTotalStorageUsed,
  formatStorageSize
} from '../../src/services/offlineStorage';
import { streamResolver } from '../../src/services/streamResolver';
import { youtubeService } from '../../src/services/youtube';
import { soundCloudService } from '../../src/services/soundcloud';
import { UnifiedTrack } from '../../src/types/music';
import { OfflineSection } from '../../src/components/library/OfflineSection';
import { LibraryView } from '../../src/components/library/LibraryView';
import { TrackCard } from '../../src/components/search/TrackCard';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';

const mockTrack1: UnifiedTrack = {
  id: 'yt_off123',
  source: 'youtube',
  originalId: 'off123',
  title: 'Offline Song 1',
  artist: 'Offline Artist A',
  duration: 240,
  artworkUrl: 'https://example.com/art1.jpg'
};

const mockTrack2: UnifiedTrack = {
  id: 'sc_off456',
  source: 'soundcloud',
  originalId: 'off456',
  title: 'Offline Song 2',
  artist: 'Offline Artist B',
  duration: 180,
  artworkUrl: 'https://example.com/art2.jpg'
};

describe('Milestone 3 — In-App Desktop Offline Storage & Downloads', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearAllData();
    streamResolver.clearCache();
    usePlayerStore.setState({ currentTrack: null, isPlaying: false, userQueue: [], sourceQueue: [] });
    useUIStore.setState({ activeView: 'library', toastMessage: null });
    useLibraryStore.setState({ favorites: [], playlists: [], history: [] });

    // Mock global fetch for audio streams
    global.fetch = vi.fn().mockImplementation(async (_url: string) => {
      const mockAudioData = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00]); // ID3 header
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (header: string) => {
            if (header.toLowerCase() === 'content-length') return String(mockAudioData.byteLength);
            if (header.toLowerCase() === 'content-type') return 'audio/mpeg';
            return null;
          }
        },
        blob: async () => new Blob([mockAudioData], { type: 'audio/mpeg' }),
        arrayBuffer: async () => mockAudioData.buffer
      };
    });
  });

  afterEach(async () => {
    await clearAllData();
  });

  describe('1. Dexie v3 Schema & Binary Blob Storage', () => {
    it('creates offlineTracks table with id, downloadedAt, sizeBytes schema', () => {
      expect(db.offlineTracks).toBeDefined();
      expect(db.offlineTracks.name).toBe('offlineTracks');

      const customDb = new WireonDB('TestCustomV3DB');
      expect(customDb.offlineTracks).toBeDefined();
    });

    it('stores binary audio Blob alongside track metadata and duration', async () => {
      const audioBlob = new Blob(['sample-mp3-binary-data'], { type: 'audio/mpeg' });
      const record: OfflineTrackRecord = {
        id: mockTrack1.id,
        track: mockTrack1,
        blob: audioBlob,
        sizeBytes: audioBlob.size,
        downloadedAt: 1700000000000
      };

      await db.offlineTracks.put(record);

      const retrieved = await db.offlineTracks.get(mockTrack1.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('yt_off123');
      expect(retrieved?.track.title).toBe('Offline Song 1');
      expect(retrieved?.track.duration).toBe(240);
      expect(retrieved?.sizeBytes).toBe(audioBlob.size);
      expect(retrieved?.blob).toBeDefined();
    });

    it('clears offline tracks when clearAllData() is invoked', async () => {
      const audioBlob = new Blob(['test-audio'], { type: 'audio/mpeg' });
      await db.offlineTracks.put({
        id: mockTrack1.id,
        track: mockTrack1,
        blob: audioBlob,
        sizeBytes: audioBlob.size,
        downloadedAt: Date.now()
      });

      expect(await db.offlineTracks.count()).toBe(1);
      await clearAllData();
      expect(await db.offlineTracks.count()).toBe(0);
    });
  });

  describe('2. Download Pipeline (offlineStorage.ts)', () => {
    it('downloads track, resolves stream, stores blob, and reports progress', async () => {
      vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
        streamUrl: 'https://googlevideo.com/mock-stream-off123',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 3600000
      });

      const progressValues: number[] = [];
      await downloadTrack(mockTrack1, (pct) => progressValues.push(pct));

      expect(progressValues.length).toBeGreaterThan(0);
      expect(progressValues[progressValues.length - 1]).toBe(100);

      const isSaved = await isDownloaded(mockTrack1.id);
      expect(isSaved).toBe(true);

      const record = await getOfflineTrack(mockTrack1.id);
      expect(record).toBeDefined();
      expect(record?.id).toBe(mockTrack1.id);
      expect(record?.sizeBytes).toBeGreaterThan(0);
      expect(record?.track.title).toBe('Offline Song 1');
    });

    it('checks isDownloaded correctly for missing and existing tracks', async () => {
      expect(await isDownloaded('yt_nonexistent')).toBe(false);
      expect(await isDownloaded('')).toBe(false);

      const blob = new Blob(['audio'], { type: 'audio/mpeg' });
      await db.offlineTracks.put({
        id: mockTrack2.id,
        track: mockTrack2,
        blob,
        sizeBytes: blob.size,
        downloadedAt: Date.now()
      });

      expect(await isDownloaded(mockTrack2.id)).toBe(true);
    });

    it('returns valid offline audio object URL for downloaded tracks', async () => {
      const blob = new Blob(['audio-blob-data'], { type: 'audio/mpeg' });
      await db.offlineTracks.put({
        id: mockTrack1.id,
        track: mockTrack1,
        blob,
        sizeBytes: blob.size,
        downloadedAt: Date.now()
      });

      const url = await getOfflineAudioUrl(mockTrack1.id);
      expect(url).toBeDefined();
      expect(typeof url).toBe('string');
      expect(url?.startsWith('blob:')).toBe(true);

      const nonExistentUrl = await getOfflineAudioUrl('nonexistent');
      expect(nonExistentUrl).toBeNull();
    });

    it('deletes an offline track and updates storage count', async () => {
      const blob = new Blob(['audio-data'], { type: 'audio/mpeg' });
      await db.offlineTracks.put({
        id: mockTrack1.id,
        track: mockTrack1,
        blob,
        sizeBytes: blob.size,
        downloadedAt: Date.now()
      });

      expect(await isDownloaded(mockTrack1.id)).toBe(true);
      await deleteOfflineTrack(mockTrack1.id);
      expect(await isDownloaded(mockTrack1.id)).toBe(false);
    });

    it('clears all offline tracks with clearAllOffline()', async () => {
      const blob = new Blob(['audio-data-12345'], { type: 'audio/mpeg' });
      await db.offlineTracks.put({
        id: mockTrack1.id,
        track: mockTrack1,
        blob,
        sizeBytes: 1000,
        downloadedAt: Date.now()
      });
      await db.offlineTracks.put({
        id: mockTrack2.id,
        track: mockTrack2,
        blob,
        sizeBytes: 2000,
        downloadedAt: Date.now()
      });

      let tracks = await getOfflineTracks();
      expect(tracks.length).toBe(2);

      await clearAllOffline();
      tracks = await getOfflineTracks();
      expect(tracks.length).toBe(0);
    });

    it('calculates total storage used accurately', async () => {
      const blob1 = new Blob(['12345'], { type: 'audio/mpeg' });
      const blob2 = new Blob(['1234567890'], { type: 'audio/mpeg' });

      await db.offlineTracks.put({
        id: mockTrack1.id,
        track: mockTrack1,
        blob: blob1,
        sizeBytes: 5000000, // 5 MB
        downloadedAt: Date.now()
      });
      await db.offlineTracks.put({
        id: mockTrack2.id,
        track: mockTrack2,
        blob: blob2,
        sizeBytes: 15000000, // 15 MB
        downloadedAt: Date.now()
      });

      const usage = await getTotalStorageUsed();
      expect(usage.count).toBe(2);
      expect(usage.trackCount).toBe(2);
      expect(usage.totalBytes).toBe(20000000);
      expect(usage.formattedSize).toMatch(/19\.\d MB|20 MB/);
    });

    it('formats bytes correctly with formatStorageSize / formatBytes', () => {
      expect(formatStorageSize(0)).toBe('0 B');
      expect(formatStorageSize(1024)).toBe('1 KB');
      expect(formatStorageSize(1024 * 1024)).toBe('1 MB');
      expect(formatStorageSize(84.5 * 1024 * 1024)).toBe('84.5 MB');
    });

    it('notifies subscribers on storage change events', async () => {
      const listener = vi.fn();
      const unsubscribe = offlineStorage.subscribe(listener);

      const blob = new Blob(['test'], { type: 'audio/mpeg' });
      await db.offlineTracks.put({
        id: mockTrack1.id,
        track: mockTrack1,
        blob,
        sizeBytes: 100,
        downloadedAt: Date.now()
      });

      await deleteOfflineTrack(mockTrack1.id);
      expect(listener).toHaveBeenCalled();

      unsubscribe();
    });
  });

  describe('3. Deterministic Offline Stream Resolution (streamResolver.ts)', () => {
    it('returns offline blob URL immediately without calling remote network services', async () => {
      const ytSpy = vi.spyOn(youtubeService, 'resolveStreamUrl');
      const scSpy = vi.spyOn(soundCloudService, 'resolveStreamUrl');

      // Put track into offline storage
      const audioBlob = new Blob(['offline-audio-stream'], { type: 'audio/mpeg' });
      await db.offlineTracks.put({
        id: mockTrack1.id,
        track: mockTrack1,
        blob: audioBlob,
        sizeBytes: audioBlob.size,
        downloadedAt: Date.now()
      });

      const streamInfo = await streamResolver.resolve(mockTrack1);
      expect(streamInfo).toBeDefined();
      expect(streamInfo.streamUrl.startsWith('blob:')).toBe(true);
      expect(streamInfo.cached).toBe(true);

      // Verify 0 remote network calls were made
      expect(ytSpy).not.toHaveBeenCalled();
      expect(scSpy).not.toHaveBeenCalled();
    });

    it('falls back to remote resolution when track is not in offline storage', async () => {
      const ytSpy = vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
        streamUrl: 'https://googlevideo.com/remote-stream-123',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 3600000
      });

      const streamInfo = await streamResolver.resolve(mockTrack1);
      expect(streamInfo.streamUrl).toBe('https://googlevideo.com/remote-stream-123');
      expect(ytSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('4. Library Offline UI & Indicators', () => {
    it('renders OfflineSection with empty state when no tracks downloaded', async () => {
      render(React.createElement(OfflineSection, null));

      expect(screen.getByRole('heading', { name: 'Офлайн' })).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('offline-empty-state')).toBeInTheDocument();
      });
      expect(screen.getByTestId('offline-open-settings')).toBeInTheDocument();
    });

    it('renders OfflineSection with storage indicator and list of offline tracks', async () => {
      const blob = new Blob(['track-audio-content'], { type: 'audio/mpeg' });
      await db.offlineTracks.put({
        id: mockTrack1.id,
        track: mockTrack1,
        blob,
        sizeBytes: 84.5 * 1024 * 1024,
        downloadedAt: Date.now()
      });

      render(React.createElement(OfflineSection, null));

      await waitFor(() => {
        expect(screen.getByTestId('offline-storage-indicator')).toHaveTextContent(/1 трек · занято 84\.5 MB/i);
      });
      expect(screen.getByText('Offline Song 1')).toBeInTheDocument();
      expect(screen.getByTestId('offline-play-all-btn')).toBeInTheDocument();
      expect(screen.getByTestId('offline-clear-all-btn')).toBeInTheDocument();
    });

    it('plays all offline tracks starting from first on "Play all" click', async () => {
      const blob = new Blob(['audio'], { type: 'audio/mpeg' });
      await db.offlineTracks.put({
        id: mockTrack1.id,
        track: mockTrack1,
        blob,
        sizeBytes: 1000,
        downloadedAt: Date.now()
      });

      const playTrackSpy = vi.spyOn(usePlayerStore.getState(), 'playTrack');

      render(React.createElement(OfflineSection, null));

      await waitFor(() => {
        expect(screen.getByTestId('offline-play-all-btn')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('offline-play-all-btn'));
      expect(playTrackSpy).toHaveBeenCalledWith(mockTrack1, [mockTrack1], 0);
    });

    it('integrates Downloaded tab into LibraryView and switches between tabs', async () => {
      render(React.createElement(LibraryView, null));

      const offlineTab = screen.getByTestId('tab-offline');
      expect(offlineTab).toBeInTheDocument();
      expect(offlineTab).toHaveTextContent(/Офлайн/i);

      fireEvent.click(offlineTab);

      await waitFor(() => {
        expect(screen.getByTestId('offline-section')).toBeInTheDocument();
      });
    });

    it('renders offline indicator badge on TrackCard when track is downloaded', async () => {
      const blob = new Blob(['audio'], { type: 'audio/mpeg' });
      await db.offlineTracks.put({
        id: mockTrack1.id,
        track: mockTrack1,
        blob,
        sizeBytes: 1000,
        downloadedAt: Date.now()
      });

      render(React.createElement(TrackCard, { track: mockTrack1 }));

      await waitFor(() => {
        expect(screen.getByTestId(`track-offline-badge-${mockTrack1.id}`)).toBeInTheDocument();
      });
    });

    /**
     * Скачивание по одному треку убрано намеренно: офлайн включается одним
     * тумблером в настройках, а кэш наполняется тем, что действительно слушают.
     */
    it('не предлагает скачивание в контекстном меню трека', async () => {
      render(React.createElement(TrackCard, { track: mockTrack2 }));

      const moreBtn = screen.getByTestId(`track-more-btn-${mockTrack2.id}`);
      fireEvent.click(moreBtn);

      expect(screen.getByTestId('track-context-menu')).toBeInTheDocument();
      expect(screen.queryByTestId(`menu-download-${mockTrack2.id}`)).not.toBeInTheDocument();
      expect(screen.queryByText(/скачать|download/i)).not.toBeInTheDocument();
    });
  });

  /**
   * Сжатие сохранённого.
   *
   * Смысл в том, чтобы библиотека влезала: без сжатия пятигигабайтный лимит —
   * это примерно восемьсот песен. Поэтому здесь проверяется не «вызвался ли
   * мост», а что на диск легли именно сжатые байты с правильным форматом, и что
   * ни один вид отказа моста не мешает треку сохраниться вообще.
   */
  describe('5. Сжатие в Opus перед сохранением', () => {
    /** Второй ютубовский трек: sc-трек пошёл бы резолвиться через SoundCloud. */
    const mockTrack1b: UnifiedTrack = {
      ...mockTrack1,
      id: 'yt_off789',
      originalId: 'off789',
      title: 'Offline Song 3'
    };

    /** Что стояло в window.electronAPI до нас — глобальный мок из setup.ts. */
    let savedBridge: unknown;

    /** Мост оболочки, который «сжимает» до фиксированного размера. */
    function installBridge(
      overrides: {
        available?: boolean;
        compressed?: boolean;
        outSize?: number;
        reason?: string;
        throwOnTranscode?: boolean;
        missingMethods?: boolean;
      } = {}
    ) {
      const transcodeAudio = vi.fn(async (payload: { data: Uint8Array; bitrateKbps?: number; sourceExt?: string }) => {
        if (overrides.throwOnTranscode) throw new Error('IPC оборвался');
        const compressed = overrides.compressed !== false;
        return {
          data: compressed ? new Uint8Array(overrides.outSize ?? 3).fill(9) : payload.data,
          format: compressed ? 'opus' : (payload.sourceExt || 'm4a'),
          bitrate: payload.bitrateKbps ?? 0,
          compressed,
          reason: overrides.reason
        };
      });
      const transcodeAvailable = vi.fn(async () => overrides.available !== false);

      (window as unknown as { electronAPI: unknown }).electronAPI = overrides.missingMethods
        ? {}
        : { transcodeAvailable, transcodeAudio };
      // Ответ про доступность кэшируется на весь сеанс — сбрасываем, иначе
      // первый тест решал бы судьбу остальных.
      (offlineStorage as unknown as { compressionAvailable: boolean | null }).compressionAvailable = null;

      return { transcodeAudio, transcodeAvailable };
    }

    /**
     * Запись такой, какой она уходит в Dexie.
     *
     * Читать Blob обратно из базы нельзя: fake-indexeddb не умеет клонировать
     * jsdom-овский Blob и возвращает вместо него пустой объект. Поэтому сами
     * байты проверяются на входе в put(), а факт сохранения — по sizeBytes,
     * который обычное число и переживает клонирование.
     */
    function captureSavedRecord(): { get: () => OfflineTrackRecord | null } {
      let saved: OfflineTrackRecord | null = null;
      const passThrough = db.offlineTracks.put.bind(db.offlineTracks);
      vi.spyOn(db.offlineTracks, 'put').mockImplementation((record) => {
        saved = record as OfflineTrackRecord;
        return passThrough(record);
      });
      return { get: () => saved };
    }

    beforeEach(() => {
      savedBridge = (window as unknown as { electronAPI?: unknown }).electronAPI;
      vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
        streamUrl: 'https://googlevideo.com/mock-stream-off123',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 3600000
      });
    });

    afterEach(() => {
      // Возвращаем глобальный мок оболочки: он нужен остальным тестам файла.
      (window as unknown as { electronAPI?: unknown }).electronAPI = savedBridge;
      (offlineStorage as unknown as { compressionAvailable: boolean | null }).compressionAvailable = null;
    });

    it('кладёт на диск сжатые байты, а не скачанные', async () => {
      const { transcodeAudio } = installBridge({ outSize: 3 });
      const written = captureSavedRecord();

      await downloadTrack(mockTrack1, undefined, { compressBitrateKbps: 96 });

      expect(transcodeAudio).toHaveBeenCalledWith(
        expect.objectContaining({ bitrateKbps: 96, sourceExt: 'mp3' })
      );
      const saved = written.get();
      expect(saved?.blob.size).toBe(3);
      expect(saved?.sizeBytes).toBe(3);
      // Ogg, а не сырой opus — иначе Chromium это не сыграет.
      expect(saved?.blob.type).toContain('audio/ogg');

      const record = await getOfflineTrack(mockTrack1.id);
      expect(record?.sizeBytes).toBe(3);
      // Формат записан по факту: от него зависит MIME при воспроизведении.
      expect(record?.track.format).toBe('opus');
      expect(record?.track.bitrate).toBe(96);
    });

    it('не жмёт, когда выбрано «без сжатия»', async () => {
      const { transcodeAudio } = installBridge();

      await downloadTrack(mockTrack1, undefined, { compressBitrateKbps: 0 });

      expect(transcodeAudio).not.toHaveBeenCalled();
      expect(await isDownloaded(mockTrack1.id)).toBe(true);
    });

    it('не жмёт, когда параметр вообще не передали', async () => {
      const { transcodeAudio } = installBridge();

      await downloadTrack(mockTrack1);

      expect(transcodeAudio).not.toHaveBeenCalled();
    });

    it('сохраняет трек как есть, если ffmpeg в сборке нет', async () => {
      const { transcodeAudio } = installBridge({ available: false });

      await downloadTrack(mockTrack1, undefined, { compressBitrateKbps: 96 });

      expect(transcodeAudio).not.toHaveBeenCalled();
      expect(await isDownloaded(mockTrack1.id)).toBe(true);
      const record = await getOfflineTrack(mockTrack1.id);
      expect(record?.track.format).not.toBe('opus');
    });

    it('сохраняет трек как есть в веб-сборке, где моста нет совсем', async () => {
      installBridge({ missingMethods: true });

      await downloadTrack(mockTrack1, undefined, { compressBitrateKbps: 96 });

      expect(await isDownloaded(mockTrack1.id)).toBe(true);
    });

    it('сохраняет трек как есть, когда сжатие отказалось', async () => {
      // Битый файл или отсутствующий кодек: потерять трек из-за сжатия нельзя.
      installBridge({ compressed: false, reason: 'ffmpeg вернул ошибку' });

      await downloadTrack(mockTrack1, undefined, { compressBitrateKbps: 96 });

      const record = await getOfflineTrack(mockTrack1.id);
      expect(record).toBeDefined();
      expect(record?.track.format).not.toBe('opus');
    });

    it('сохраняет трек как есть, когда мост бросил исключение', async () => {
      installBridge({ throwOnTranscode: true });

      await downloadTrack(mockTrack1, undefined, { compressBitrateKbps: 96 });

      expect(await isDownloaded(mockTrack1.id)).toBe(true);
    });

    it('сохраняет трек как есть, когда пришли пустые байты', async () => {
      installBridge({ outSize: 0 });
      const written = captureSavedRecord();

      await downloadTrack(mockTrack1, undefined, { compressBitrateKbps: 96 });

      // Ушли скачанные семь байт ID3-заготовки, а не нулевой выхлоп сжатия.
      expect(written.get()?.blob.size).toBe(7);
      const record = await getOfflineTrack(mockTrack1.id);
      expect(record?.sizeBytes).toBe(7);
      expect(record?.track.format).not.toBe('opus');
    });

    it('доводит прогресс до 100 и со сжатием тоже', async () => {
      installBridge();
      const seen: number[] = [];

      await downloadTrack(mockTrack1, (pct) => seen.push(pct), { compressBitrateKbps: 96 });

      expect(seen[seen.length - 1]).toBe(100);
      // Шкала не должна прыгать назад: сжатие занимает хвост, а не начало.
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
    });

    it('спрашивает про ffmpeg один раз, а не на каждый трек', async () => {
      const { transcodeAvailable } = installBridge();

      await downloadTrack(mockTrack1, undefined, { compressBitrateKbps: 96 });
      await downloadTrack(mockTrack1b, undefined, { compressBitrateKbps: 96 });

      expect(transcodeAvailable).toHaveBeenCalledTimes(1);
    });
  });
});
