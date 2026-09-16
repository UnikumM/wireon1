/**
 * Обработка звука на телефоне.
 *
 * Суть проверяемого: Web Audio не пропускает через себя «запятнанный» ресурс, а
 * ссылки YouTube приходят без заголовков CORS. Поэтому при включённой обработке
 * телефон играет файл из кэша — и только тогда эквалайзер что-то делает.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  isAudioProcessingEnabled,
  needsLocalSource,
  onAudioProcessingChange,
  setAudioProcessingEnabled,
  resetAudioProcessingForTests
} from '../../src/services/audioProcessing';
import { cacheFileName, extensionFor, STREAM_CACHE_LIMIT } from '../../src/services/streamCache';
import { StreamResolver, LOCAL_SOURCE_TTL_MS } from '../../src/services/streamResolver';
import { youtubeService } from '../../src/services/youtube';
import * as streamCache from '../../src/services/streamCache';
import * as nativeBridge from '../../src/services/nativeBridge';
import { UnifiedTrack } from '../../src/types/music';
import { usePlayerStore } from '../../src/store/usePlayerStore';

const track: UnifiedTrack = {
  id: 'yt_fx1',
  source: 'youtube',
  originalId: 'fx1',
  title: 'Басы',
  artist: 'Кто-то',
  duration: 180,
  artworkUrl: ''
};

describe('Обработка звука на телефоне', () => {
  describe('Полосы эквалайзера', () => {
    beforeEach(() => {
      resetAudioProcessingForTests();
      usePlayerStore.setState({ mobileAudioFx: false, eq: { bass: 0, mid: 0, treble: 0 }, currentTrack: null });
    });

    it('на телефоне первое же движение полосы включает обработку', () => {
      // Отдельный переключатель рядом не находили, и эквалайзер выглядел
      // сломанным: ползунки двигаются, звук прежний.
      vi.spyOn(nativeBridge, 'detectPlatform').mockReturnValue('mobile');

      usePlayerStore.getState().setEq({ bass: 6 });

      expect(usePlayerStore.getState().mobileAudioFx).toBe(true);
      expect(isAudioProcessingEnabled()).toBe(true);
    });

    it('возврат полос в ноль обработку сам не включает', () => {
      vi.spyOn(nativeBridge, 'detectPlatform').mockReturnValue('mobile');

      usePlayerStore.getState().setEq({ bass: 0, mid: 0, treble: 0 });

      expect(usePlayerStore.getState().mobileAudioFx).toBe(false);
    });

    it('на компьютере ничего включать не надо — граф там и так работает', () => {
      vi.spyOn(nativeBridge, 'detectPlatform').mockReturnValue('electron');

      usePlayerStore.getState().setEq({ treble: -4 });

      expect(usePlayerStore.getState().mobileAudioFx).toBe(false);
    });
  });

  beforeEach(() => {
    resetAudioProcessingForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetAudioProcessingForTests();
  });

  describe('Переключатель', () => {
    it('по умолчанию выключен и файла не требует', () => {
      expect(isAudioProcessingEnabled()).toBe(false);
      expect(needsLocalSource()).toBe(false);
    });

    it('после выключения источником остаётся файл — элемент уже в графе', () => {
      // Отвязать элемент от графа нельзя: прямой поток через него стал бы
      // тишиной. Поэтому «прилипает» именно источник, а не сама обработка.
      setAudioProcessingEnabled(true);
      expect(needsLocalSource()).toBe(true);

      setAudioProcessingEnabled(false);
      expect(isAudioProcessingEnabled()).toBe(false);
      expect(needsLocalSource()).toBe(true);
    });

    it('о переключении узнают подписчики, и упавший не мешает остальным', () => {
      const seen: boolean[] = [];
      onAudioProcessingChange(() => {
        throw new Error('подписчик упал');
      });
      onAudioProcessingChange((value) => seen.push(value));

      setAudioProcessingEnabled(true);
      setAudioProcessingEnabled(true); // повтор не считается
      setAudioProcessingEnabled(false);

      expect(seen).toEqual([true, false]);
    });
  });

  describe('Кэш звука', () => {
    it('расширение берётся из типа содержимого, иначе файл отдастся байтами', () => {
      expect(extensionFor('audio/mpeg')).toBe('mp3');
      expect(extensionFor('audio/mp4; codecs="mp4a.40.2"')).toBe('m4a');
      expect(extensionFor('audio/webm')).toBe('webm');
      expect(extensionFor('audio/ogg')).toBe('ogg');
      expect(extensionFor(null)).toBe('m4a');
    });

    it('имя файла не тащит в адрес то, чего там быть не может', () => {
      expect(cacheFileName('yt_a/b?c', 'm4a')).toBe('stream-cache/yt_a_b_c.m4a');
      expect(cacheFileName('', 'mp3')).toBe('stream-cache/track.mp3');
    });

    it('держим несколько файлов, а не один: назад тоже ходят', () => {
      expect(STREAM_CACHE_LIMIT).toBeGreaterThan(1);
    });
  });

  describe('Выбор источника', () => {
    let resolver: StreamResolver;

    beforeEach(() => {
      resolver = new StreamResolver();
      resolver.clearCache();
      vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
        streamUrl: 'https://googlevideo.com/stream',
        format: 'm4a',
        bitrate: 128,
        expiresAt: Date.now() + 3600_000
      });
    });

    it('на телефоне с обработкой играет файл из кэша, а не ссылка', async () => {
      vi.spyOn(nativeBridge, 'detectPlatform').mockReturnValue('mobile');
      const cache = vi
        .spyOn(streamCache, 'cacheStreamToFile')
        .mockResolvedValue('https://localhost/_capacitor_file_/cache/stream-cache/yt_fx1.m4a');
      setAudioProcessingEnabled(true);

      const result = await resolver.resolve(track);

      expect(cache).toHaveBeenCalledWith('yt_fx1', 'https://googlevideo.com/stream');
      expect(result.streamUrl).toContain('_capacitor_file_');
      // Файл живёт дольше ссылки, но не вечно: кэш вытесняется.
      expect(result.expiresAt).toBeGreaterThan(Date.now());
      expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + LOCAL_SOURCE_TTL_MS + 1000);
    });

    it('не смогли забрать в кэш — играем ссылку, звук важнее эффектов', async () => {
      vi.spyOn(nativeBridge, 'detectPlatform').mockReturnValue('mobile');
      vi.spyOn(streamCache, 'cacheStreamToFile').mockResolvedValue(null);
      setAudioProcessingEnabled(true);

      const result = await resolver.resolve(track);
      expect(result.streamUrl).toBe('https://googlevideo.com/stream');
    });

    it('на компьютере в кэш не ходим: там граф и так работает', async () => {
      vi.spyOn(nativeBridge, 'detectPlatform').mockReturnValue('electron');
      const cache = vi.spyOn(streamCache, 'cacheStreamToFile');
      setAudioProcessingEnabled(true);

      await resolver.resolve(track);
      expect(cache).not.toHaveBeenCalled();
    });

    it('без обработки телефон играет ссылку напрямую', async () => {
      vi.spyOn(nativeBridge, 'detectPlatform').mockReturnValue('mobile');
      const cache = vi.spyOn(streamCache, 'cacheStreamToFile');

      const result = await resolver.resolve(track);
      expect(cache).not.toHaveBeenCalled();
      expect(result.streamUrl).toBe('https://googlevideo.com/stream');
    });

    it('HLS в файл не забирается: по ссылке лежит список кусков, а не звук', async () => {
      vi.spyOn(nativeBridge, 'detectPlatform').mockReturnValue('mobile');
      const cache = vi.spyOn(streamCache, 'cacheStreamToFile');
      vi.spyOn(youtubeService, 'resolveStreamUrl').mockResolvedValue({
        streamUrl: 'https://example.com/playlist.m3u8',
        format: 'hls',
        bitrate: 128,
        expiresAt: Date.now() + 3600_000
      });
      setAudioProcessingEnabled(true);

      const result = await resolver.resolve(track);
      expect(cache).not.toHaveBeenCalled();
      expect(result.streamUrl).toContain('.m3u8');
    });
  });
});
