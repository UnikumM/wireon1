import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  YouTubeService,
  sanitizeYouTubeTitle,
  getYouTubeArtworkUrl,
  pickTimestampRun,
  splitMetadataRuns,
  toPositiveInt,
  getStreamExpiryFromUrl,
  ALL_BACKENDS_UNAVAILABLE_MESSAGE
} from '../../src/services/youtube';
import { formatDuration, parseDurationToSeconds } from '../../src/utils/time';

/** Builds a minimal musicResponsiveListItemRenderer search payload. */
function innerTubePayload(videoId: string, title: string, metaRuns: string[]) {
  return {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      musicShelfRenderer: {
                        contents: [
                          {
                            musicResponsiveListItemRenderer: {
                              playlistItemData: { videoId },
                              flexColumns: [
                                {
                                  musicResponsiveListItemFlexColumnRenderer: {
                                    text: { runs: [{ text: title }] }
                                  }
                                },
                                {
                                  musicResponsiveListItemFlexColumnRenderer: {
                                    text: { runs: metaRuns.map(text => ({ text })) }
                                  }
                                }
                              ],
                              thumbnail: {
                                musicThumbnailRenderer: {
                                  thumbnail: {
                                    thumbnails: [
                                      { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }
                                    ]
                                  }
                                }
                              }
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            }
          }
        ]
      }
    }
  };
}

describe('YouTube Service & Utilities', () => {
  describe('Helper Utilities', () => {
    it('parses duration strings strictly through utils/time', () => {
      expect(parseDurationToSeconds('3:45')).toBe(225);
      expect(parseDurationToSeconds('0:30')).toBe(30);
      expect(parseDurationToSeconds('1:02:15')).toBe(3735);
      // Strict: bare numbers, prose and out-of-range seconds are not durations
      expect(parseDurationToSeconds('45')).toBe(0);
      expect(parseDurationToSeconds('')).toBe(0);
      expect(parseDurationToSeconds('invalid')).toBe(0);
      expect(parseDurationToSeconds('1.2M plays')).toBe(0);
      expect(parseDurationToSeconds('99:99')).toBe(0);
    });

    it('formats seconds to duration strings correctly', () => {
      expect(formatDuration(225)).toBe('3:45');
      expect(formatDuration(30)).toBe('0:30');
      expect(formatDuration(3735)).toBe('1:02:15');
      expect(formatDuration(0)).toBe('0:00');
      expect(formatDuration(-10)).toBe('0:00');
    });

    it('sanitizes YouTube titles and splits artist correctly', () => {
      const res1 = sanitizeYouTubeTitle('Queen - Bohemian Rhapsody (Official Video)', 'Queen');
      expect(res1.title).toBe('Bohemian Rhapsody');
      expect(res1.artist).toBe('Queen');

      const res2 = sanitizeYouTubeTitle('Radio Ga Ga [Official Audio] | HD', 'Queen - Topic');
      expect(res2.title).toBe('Radio Ga Ga');
      expect(res2.artist).toBe('Queen');

      const res3 = sanitizeYouTubeTitle('The Weeknd - Blinding Lights (Lyrics)', 'The Weeknd');
      expect(res3.title).toBe('Blinding Lights');
      expect(res3.artist).toBe('The Weeknd');

      const res4 = sanitizeYouTubeTitle('Simple Title Without Dash', 'Artist Name');
      expect(res4.title).toBe('Simple Title Without Dash');
      expect(res4.artist).toBe('Artist Name');
    });

    it('берёт кадр без чёрных полей, а не самый крупный', () => {
      // `hqdefault` — это 480x360, то есть 4:3, и широкое видео YouTube
      // вписывает туда с чёрными полями, **запечёнными в саму картинку**.
      // Никакой `object-fit` их не уберёт, и на квадратной обложке плеера
      // получалась марка в рамке. `mqdefault` — 320x180 без полей.
      expect(getYouTubeArtworkUrl('dQw4w9WgXcQ')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
      expect(getYouTubeArtworkUrl('dQw4w9WgXcQ')).not.toContain('hqdefault');
      expect(getYouTubeArtworkUrl('', 'fallback.jpg')).toBe('fallback.jpg');
    });

    it('picks the run that looks like a timestamp, not the last run', () => {
      expect(pickTimestampRun(['Queen', 'A Night at the Opera', '5:55'])).toBe('5:55');
      expect(pickTimestampRun(['Queen', '3:21', '1.2M plays'])).toBe('3:21');
      expect(pickTimestampRun(['Queen', '1:02:15', '532 views'])).toBe('1:02:15');
      expect(pickTimestampRun(['Queen', '1.2M plays'])).toBe('');
      expect(pickTimestampRun([])).toBe('');
    });

    it('splits metadata runs into descriptive runs and the duration', () => {
      expect(splitMetadataRuns(['Queen', ' • ', 'A Night at the Opera', ' • ', '5:55'])).toEqual({
        meta: ['Queen', 'A Night at the Opera'],
        duration: '5:55'
      });

      // View/play counts never end up as the album or the duration
      expect(splitMetadataRuns(['Song', '•', 'Daft Punk', '•', '1.2M plays', '•', '5:21'])).toEqual({
        meta: ['Daft Punk'],
        duration: '5:21'
      });

      expect(splitMetadataRuns(['Queen', '1.2M plays'])).toEqual({
        meta: ['Queen'],
        duration: ''
      });
    });

    it('rejects non positive / non finite numeric fields', () => {
      expect(toPositiveInt(215)).toBe(215);
      expect(toPositiveInt('215')).toBe(215);
      expect(toPositiveInt(-1)).toBe(0);
      expect(toPositiveInt(0)).toBe(0);
      expect(toPositiveInt(NaN)).toBe(0);
      expect(toPositiveInt(Infinity)).toBe(0);
      expect(toPositiveInt('abc')).toBe(0);
      expect(toPositiveInt(undefined)).toBe(0);
      expect(toPositiveInt(null)).toBe(0);
    });

    it('reads the stream lifetime from the expire query parameter', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(
        getStreamExpiryFromUrl('https://rr3---sn-x.googlevideo.com/videoplayback?expire=1893456000&itag=140')
      ).toBe(1893456000 * 1000);

      const fallback = getStreamExpiryFromUrl('https://googlevideo.com/videoplayback?itag=140');
      expect(fallback).toBeGreaterThan(Date.now() + 5 * 3600 * 1000);

      const malformed = getStreamExpiryFromUrl('not-a-url');      expect(malformed).toBeGreaterThan(Date.now() + 5 * 3600 * 1000);
    });
  });

  describe('YouTubeService InnerTube & Search Parsing', () => {
    let service: YouTubeService;

    beforeEach(() => {
      service = new YouTubeService();
      vi.restoreAllMocks();
    });

    it('parses InnerTube JSON payload into UnifiedTrack items', () => {
      const tracks = service.parseInnerTubeResponse(
        innerTubePayload('abc12345', 'Queen - Bohemian Rhapsody', [
          'Queen',
          ' • ',
          'A Night at the Opera',
          ' • ',
          '5:55'
        ]),
        10
      );

      expect(tracks).toHaveLength(1);
      expect(tracks[0]).toEqual({
        id: 'yt_abc12345',
        source: 'youtube',
        originalId: 'abc12345',
        title: 'Bohemian Rhapsody',
        artist: 'Queen',
        album: 'A Night at the Opera',
        duration: 355,
        durationFormatted: '5:55',
        artworkUrl: 'https://i.ytimg.com/vi/abc12345/mqdefault.jpg',
        sourceUrl: 'https://www.youtube.com/watch?v=abc12345'
      });
    });

    it('regression: a "1.2M plays" metadata run yields duration 0, not 1', () => {
      const tracks = service.parseInnerTubeResponse(
        innerTubePayload('plays00001', 'Some Artist - Some Song', ['Some Artist', ' • ', '1.2M plays']),
        10
      );

      expect(tracks).toHaveLength(1);
      expect(tracks[0].duration).toBe(0);
      expect(tracks[0].durationFormatted).toBe('0:00');
      expect(tracks[0].artist).toBe('Some Artist');
    });

    it('regression: picks the timestamp run even when it is not last', () => {
      const tracks = service.parseInnerTubeResponse(
        innerTubePayload('mid00001abc', 'Daft Punk - One More Time', [
          'Daft Punk',
          ' • ',
          '5:21',
          ' • ',
          '1.2M plays'
        ]),
        10
      );

      expect(tracks[0].duration).toBe(321);
      expect(tracks[0].durationFormatted).toBe('5:21');
      // The play count must not be mistaken for an album either
      expect(tracks[0].album).toBeUndefined();
    });

    it('handles empty query gracefully', async () => {
      const results = await service.search('');
      expect(results).toEqual([]);
      const results2 = await service.search('   ');
      expect(results2).toEqual([]);
    });

    it('validates numeric durations from the Piped fallback', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const piped = new YouTubeService({
        pipedInstances: ['https://piped.test'],
        invidiousInstances: []
      });

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('music.youtube.com')) {
          return { ok: false, status: 500, json: async () => ({}) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { url: '/watch?v=live0000001', title: 'Live Stream', uploaderName: 'Somebody', duration: -1 },
              { url: '/watch?v=good0000001', title: 'Good Song', uploaderName: 'Somebody', duration: 215 },
              { url: '/watch?v=nodur000001', title: 'No Duration', uploaderName: 'Somebody' }
            ]
          })
        } as any;
      });

      const results = await piped.search('anything', 10);
      expect(results).toHaveLength(3);
      expect(results[0].duration).toBe(0);
      expect(results[1].duration).toBe(215);
      expect(results[1].durationFormatted).toBe('3:35');
      expect(results[2].duration).toBe(0);
    });

    it('validates numeric lengthSeconds from the Invidious fallback', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const invidious = new YouTubeService({
        pipedInstances: [],
        invidiousInstances: ['https://invidious.test']
      });

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('music.youtube.com')) {
          return { ok: false, status: 500, json: async () => ({}) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => [
            { videoId: 'inv00000001', title: 'Bad Length', author: 'Somebody', lengthSeconds: NaN },
            { videoId: 'inv00000002', title: 'Fine Length', author: 'Somebody', lengthSeconds: 190 }
          ]
        } as any;
      });

      const results = await invidious.search('anything', 10);
      expect(results).toHaveLength(2);
      expect(results[0].duration).toBe(0);
      expect(results[1].duration).toBe(190);
    });
  });

  describe('YouTubeService fallback pool health', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('throws a distinguishable error when no backend is reachable', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = new YouTubeService({
        pipedInstances: ['https://piped.dead'],
        invidiousInstances: ['https://invidious.dead']
      });

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

      await expect(service.search('anything', 10)).rejects.toThrow(
        ALL_BACKENDS_UNAVAILABLE_MESSAGE
      );
    });

    it('returns an empty array when a backend answers but has no matches', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = new YouTubeService({
        pipedInstances: ['https://piped.test'],
        invidiousInstances: []
      });

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('music.youtube.com')) {
          return { ok: false, status: 500, json: async () => ({}) } as any;
        }
        // Reachable, well-formed, simply nothing for this query.
        return { ok: true, status: 200, json: async () => ({ items: [] }) } as any;
      });

      await expect(service.search('zzzzz no such song', 10)).resolves.toEqual([]);
    });

    it('skips an instance for the session after two consecutive failures', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = new YouTubeService({
        pipedInstances: ['https://piped.flaky'],
        invidiousInstances: []
      });

      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('music.youtube.com')) {
          return { ok: false, status: 500, json: async () => ({}) } as any;
        }
        return { ok: false, status: 502, json: async () => ({}) } as any;
      });
      globalThis.fetch = fetchMock;

      const countPiped = () =>
        fetchMock.mock.calls.filter(call => String(call[0]).includes('piped.flaky')).length;

      await expect(service.search('one', 10)).rejects.toThrow();
      expect(countPiped()).toBe(1);

      await expect(service.search('two', 10)).rejects.toThrow();
      expect(countPiped()).toBe(2);

      // Budget exhausted: the third search must not touch the instance again.
      await expect(service.search('three', 10)).rejects.toThrow();
      expect(countPiped()).toBe(2);

      service.resetInstanceHealth();
      await expect(service.search('four', 10)).rejects.toThrow();
      expect(countPiped()).toBe(3);
    });

    it('recovers the failure budget once an instance answers again', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = new YouTubeService({
        pipedInstances: ['https://piped.flaky'],
        invidiousInstances: []
      });

      let failNext = true;
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('music.youtube.com')) {
          return { ok: false, status: 500, json: async () => ({}) } as any;
        }
        if (failNext) {
          return { ok: false, status: 502, json: async () => ({}) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { url: '/watch?v=good0000001', title: 'Good Song', uploaderName: 'Somebody', duration: 215 }
            ]
          })
        } as any;
      });
      globalThis.fetch = fetchMock;

      await expect(service.search('one', 10)).rejects.toThrow();

      failNext = false;
      const results = await service.search('two', 10);
      expect(results).toHaveLength(1);

      // The success cleared the strike, so a later failure still gets a turn.
      failNext = true;
      await expect(service.search('three', 10)).rejects.toThrow();
      const pipedCalls = fetchMock.mock.calls.filter(call =>
        String(call[0]).includes('piped.flaky')
      ).length;
      expect(pipedCalls).toBe(3);
    });

    it('aborts a hanging instance on the short per-instance timeout', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      const service = new YouTubeService({
        pipedInstances: ['https://piped.hangs'],
        invidiousInstances: [],
        requestTimeout: 60000
      });

      let capturedSignal: AbortSignal | undefined;
      globalThis.fetch = vi.fn().mockImplementation(
        (url: string, init: RequestInit = {}) =>
          new Promise((_resolve, reject) => {
            if (String(url).includes('music.youtube.com')) {
              reject(new Error('innertube down'));
              return;
            }
            capturedSignal = init.signal as AbortSignal;
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );

      const pending = service.search('anything', 10);
      const assertion = expect(pending).rejects.toThrow(ALL_BACKENDS_UNAVAILABLE_MESSAGE);

      // 4s instance budget, not the 60s requestTimeout.
      await vi.advanceTimersByTimeAsync(4100);
      await assertion;
      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  describe('YouTubeService stream resolution', () => {
    let service: YouTubeService;
    const originalElectronApi = (window as any).electronAPI;

    beforeEach(() => {
      service = new YouTubeService();
      vi.restoreAllMocks();
    });

    afterEach(() => {
      (window as any).electronAPI = originalElectronApi;
    });

    it('resolves stream URL with itag 140 priority', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          streamingData: {
            adaptiveFormats: [
              {
                itag: 251,
                mimeType: 'audio/webm; codecs="opus"',
                bitrate: 160000,
                url: 'https://googlevideo.com/videoplayback?itag=251'
              },
              {
                itag: 140,
                mimeType: 'audio/mp4; codecs="mp4a.40.2"',
                bitrate: 128000,
                url: 'https://googlevideo.com/videoplayback?itag=140'
              }
            ]
          }
        })
      } as any);

      const stream = await service.resolveStreamUrl('abc12345');
      expect(stream.streamUrl).toBe('https://googlevideo.com/videoplayback?itag=140');
      expect(stream.format).toBe('m4a');
      expect(stream.bitrate).toBe(128);
    });

    it('regression: expiresAt comes from the expire param, not approxDurationMs', async () => {
      const expireSeconds = Math.floor(Date.now() / 1000) + 5 * 3600;

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          streamingData: {
            adaptiveFormats: [
              {
                itag: 140,
                mimeType: 'audio/mp4; codecs="mp4a.40.2"',
                bitrate: 128000,
                approxDurationMs: '225000',
                url: `https://rr3---sn-x.googlevideo.com/videoplayback?expire=${expireSeconds}&itag=140`
              }
            ]
          }
        })
      } as any);

      const stream = await service.resolveStreamUrl('abc12345');
      expect(stream.expiresAt).toBe(expireSeconds * 1000);
      // The old behaviour expired the URL after the track length (~3.75 min)
      expect(stream.expiresAt).toBeGreaterThan(Date.now() + 4 * 3600 * 1000);
    });

    it('prefers the Electron IPC path and does not fall back to the web player endpoint', async () => {
      const ipcResolve = vi.fn().mockResolvedValue({
        streamUrl: 'https://googlevideo.com/videoplayback?expire=1893456000',
        format: 'm4a',
        bitrate: 160,
        expiresAt: 1893456000 * 1000
      });
      (window as any).electronAPI = { resolveYouTubeStream: ipcResolve };

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      const stream = await service.resolveStreamUrl('abc12345');
      // Второй аргумент — приоритет: у главного процесса для фона отдельный,
      // более узкий лимит процессов извлекателя.
      expect(ipcResolve).toHaveBeenCalledWith('abc12345', 'user', undefined);
      expect(stream.streamUrl).toBe('https://googlevideo.com/videoplayback?expire=1893456000');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('tells the main process when a resolution is only a background prefetch', async () => {
      const ipcResolve = vi.fn().mockResolvedValue({
        streamUrl: 'https://googlevideo.com/videoplayback?expire=1893456000',
        format: 'm4a',
        bitrate: 160,
        expiresAt: 1893456000 * 1000
      });
      (window as any).electronAPI = { resolveYouTubeStream: ipcResolve };

      await service.resolveStreamUrl('abc12345', 'prefetch');
      expect(ipcResolve).toHaveBeenCalledWith('abc12345', 'prefetch', undefined);

      // Повышение — отдельный вызов: склейка одинаковых запросов в главном
      // процессе найдёт заявку по id и поднимет её, не запустив второй yt-dlp.
      service.raiseStreamPriority('abc12345');
      expect(ipcResolve).toHaveBeenLastCalledWith('abc12345', 'user');
    });

    it('survives a missing bridge when raising priority', () => {
      delete (window as any).electronAPI;
      expect(() => service.raiseStreamPriority('abc12345')).not.toThrow();
      expect(() => service.raiseStreamPriority('')).not.toThrow();
    });

    it('на телефоне поднимает приоритет в очереди самого устройства', async () => {
      /*
       * Раньше здесь стояла обратная проверка: на телефоне вызов не делал
       * ничего. Тогда это было верно — ссылку добывал сервер, и его очередь
       * общая на всех слушателей, двигать в ней нечего. С тех пор ссылку
       * добывает сам телефон, и очередь у него своя, двухполосная.
       *
       * Цена прежнего молчания замерена на эмуляторе: нажатие play на треке,
       * который уже греется в фоне, ждало **25,5 секунды** за остальными
       * прогревами при шести секундах самого разбора — и обрывалось по сроку.
       */
      delete (window as any).electronAPI;
      const raisePriority = vi.fn(async () => ({ moved: true }));
      (window as any).Capacitor = {
        isNativePlatform: () => true,
        Plugins: { YtDlp: { resolve: vi.fn(), raisePriority } }
      };
      try {
        service.raiseStreamPriority('abc12345');
        // Плагин подтягивается динамически, поэтому вызов доедет не в этот тик.
        await vi.waitFor(() => expect(raisePriority).toHaveBeenCalledWith({ videoId: 'abc12345' }));
      } finally {
        delete (window as any).Capacitor;
      }
    });

    it('does not use the web player endpoint when IPC exists but fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      (window as any).electronAPI = {
        resolveYouTubeStream: vi.fn().mockRejectedValue(new Error('yt-dlp missing'))
      };

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      // The precise cause survives instead of being flattened into a generic
      // message: `describePlaybackError` maps yt-dlp's `YT_*` codes to real copy.
      await expect(service.resolveStreamUrl('abc12345')).rejects.toThrow(/yt-dlp missing/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('repairs a bogus expiry coming back over IPC', async () => {
      (window as any).electronAPI = {
        resolveYouTubeStream: vi.fn().mockResolvedValue({
          streamUrl: 'https://googlevideo.com/videoplayback?expire=1893456000',
          format: 'm4a',
          bitrate: 160,
          expiresAt: Date.now() - 1000
        })
      };

      const stream = await service.resolveStreamUrl('abc12345');
      expect(stream.expiresAt).toBe(1893456000 * 1000);
    });

    it('allows the web player endpoint when explicitly enabled', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const permissive = new YouTubeService({ allowWebPlayerFallback: true });
      (window as any).electronAPI = {
        resolveYouTubeStream: vi.fn().mockRejectedValue(new Error('yt-dlp missing'))
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          streamingData: {
            adaptiveFormats: [
              {
                itag: 140,
                mimeType: 'audio/mp4; codecs="mp4a.40.2"',
                bitrate: 128000,
                url: 'https://googlevideo.com/videoplayback?itag=140'
              }
            ]
          }
        })
      } as any);

      const stream = await permissive.resolveStreamUrl('abc12345');
      expect(stream.streamUrl).toBe('https://googlevideo.com/videoplayback?itag=140');
    });

    it('throws for a missing videoId', async () => {
      await expect(service.resolveStreamUrl('')).rejects.toThrow('Missing YouTube videoId');
    });
  });

  describe('YouTubeService suggestions & related tracks', () => {
    let service: YouTubeService;

    beforeEach(() => {
      service = new YouTubeService();
      vi.restoreAllMocks();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('fetches search suggestions', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ['queen', ['queen bohemian rhapsody', "queen don't stop me now", 'queen we will rock you']]
      } as any);

      const suggestions = await service.getSuggestions('queen');
      expect(suggestions).toHaveLength(3);
      expect(suggestions[0]).toBe('queen bohemian rhapsody');
    });

    it('parses the text/javascript suggestions body Google actually returns', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '["daft punk",["daft punk one more time","daft punk get lucky"]]'
      } as any);

      const suggestions = await service.getSuggestions('daft punk');
      expect(suggestions).toEqual(['daft punk one more time', 'daft punk get lucky']);
    });

    it('degrades to an empty list when suggestions fail', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      await expect(service.getSuggestions('queen')).resolves.toEqual([]);
      expect(warn).toHaveBeenCalled();
    });

    it('aborts a request that never settles once the timeout elapses', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();

      const timed = new YouTubeService({ requestTimeout: 1000 });
      let capturedSignal: AbortSignal | undefined;

      globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        });
      }) as any;

      const pending = timed.getSuggestions('queen');
      await vi.advanceTimersByTimeAsync(1500);

      await expect(pending).resolves.toEqual([]);
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('returns related videos from the Piped relatedStreams payload', async () => {
      const related = new YouTubeService({
        pipedInstances: ['https://piped.test'],
        invidiousInstances: []
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          relatedStreams: [
            { url: '/watch?v=rel00000001', title: 'Related One', uploaderName: 'Someone', duration: 200 },
            { url: '/watch?v=seed0000001', title: 'The Seed Itself', uploaderName: 'Someone', duration: 180 }
          ]
        })
      } as any);

      const results = await related.getRelatedVideos('seed0000001', 5);
      expect(results).toHaveLength(1);
      expect(results[0].originalId).toBe('rel00000001');
      expect(results[0].duration).toBe(200);
    });

    it('returns an empty list instead of throwing when every instance fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const related = new YouTubeService({
        pipedInstances: ['https://piped.test'],
        invidiousInstances: ['https://invidious.test']
      });

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      await expect(related.getRelatedVideos('seed0000001', 5)).resolves.toEqual([]);
      await expect(related.getRelatedVideos('', 5)).resolves.toEqual([]);
    });
  });

  describe('Радио YouTube Music от песни', () => {
    let service: YouTubeService;
    const originalElectronApi = (window as any).electronAPI;

    beforeEach(() => {
      service = new YouTubeService();
      vi.restoreAllMocks();
    });

    afterEach(() => {
      (window as any).electronAPI = originalElectronApi;
    });

    /**
     * Ответ InnerTube `next` в том виде, в каком он приходит на самом деле:
     * очередь лежит глубоко, а исполнитель отличается от альбома только
     * признаком страницы.
     */
    const radioPayload = (
      items: Array<{
        videoId: string;
        title: string;
        artist?: string;
        album?: string;
        channel?: string;
        length?: string;
      }>
    ) => ({
      contents: {
        singleColumnMusicWatchNextResultsRenderer: {
          tabbedRenderer: {
            watchNextTabbedResultsRenderer: {
              tabs: [
                {
                  tabRenderer: {
                    content: {
                      musicQueueRenderer: {
                        content: {
                          playlistPanelRenderer: {
                            contents: items.map((item) => ({
                              playlistPanelVideoRenderer: {
                                videoId: item.videoId,
                                title: { runs: [{ text: item.title }] },
                                lengthText: { runs: [{ text: item.length ?? '2:40' }] },
                                thumbnail: {
                                  thumbnails: [
                                    { url: `https://i.ytimg.com/vi/${item.videoId}/small.jpg` },
                                    { url: `https://lh3.googleusercontent.com/${item.videoId}` }
                                  ]
                                },
                                shortBylineText: item.channel
                                  ? { runs: [{ text: item.channel }] }
                                  : undefined,
                                longBylineText: {
                                  runs: [
                                    ...(item.artist
                                      ? [
                                          {
                                            text: item.artist,
                                            navigationEndpoint: {
                                              browseEndpoint: {
                                                browseEndpointContextSupportedConfigs: {
                                                  browseEndpointContextMusicConfig: {
                                                    pageType: 'MUSIC_PAGE_TYPE_ARTIST'
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        ]
                                      : []),
                                    { text: ' • ' },
                                    ...(item.album
                                      ? [
                                          {
                                            text: item.album,
                                            navigationEndpoint: {
                                              browseEndpoint: {
                                                browseEndpointContextSupportedConfigs: {
                                                  browseEndpointContextMusicConfig: {
                                                    pageType: 'MUSIC_PAGE_TYPE_ALBUM'
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        ]
                                      : [])
                                  ]
                                }
                              }
                            }))
                          }
                        }
                      }
                    }
                  }
                }
              ]
            }
          }
        }
      }
    });

    it('разбирает очередь радио в треки', () => {
      const tracks = service.parseRadioResponse(
        radioPayload([
          {
            videoId: 'phonk000001',
            title: 'Murder In My Mind',
            artist: 'Kordhell',
            album: 'Death Ambience',
            length: '2:47'
          }
        ]),
        10
      );

      expect(tracks).toHaveLength(1);
      expect(tracks[0]).toMatchObject({
        id: 'yt_phonk000001',
        source: 'youtube',
        originalId: 'phonk000001',
        title: 'Murder In My Mind',
        artist: 'Kordhell',
        album: 'Death Ambience',
        duration: 167,
        durationFormatted: '2:47',
        sourceUrl: 'https://www.youtube.com/watch?v=phonk000001'
      });
    });

    it('выбрасывает саму песню-семя из её же радио', () => {
      const tracks = service.parseRadioResponse(
        radioPayload([
          { videoId: 'seed0000001', title: 'The Seed', artist: 'Kordhell' },
          { videoId: 'next0000001', title: 'Next One', artist: 'DVRST' }
        ]),
        10,
        'seed0000001'
      );

      expect(tracks).toHaveLength(1);
      expect(tracks[0].originalId).toBe('next0000001');
    });

    it('берёт исполнителя по признаку страницы, а не по месту в строке', () => {
      // У канала вместо артиста вторым бежит счётчик просмотров: разбор по
      // позиции затащил бы «1,8 млрд просмотров» в имя исполнителя.
      const tracks = service.parseRadioResponse(
        radioPayload([
          {
            videoId: 'chan0000001',
            title: 'Some Channel Upload',
            channel: 'Some Channel',
            album: '1,8 млрд просмотров'
          }
        ]),
        10
      );

      expect(tracks).toHaveLength(1);
      expect(tracks[0].artist).toBe('Some Channel');
    });

    it('соблюдает лимит и молчит на мусорном ответе', () => {
      const many = service.parseRadioResponse(
        radioPayload(
          Array.from({ length: 12 }, (_, i) => ({
            videoId: `many000000${i}`,
            title: `Track ${i}`,
            artist: 'Someone'
          }))
        ),
        4
      );
      expect(many).toHaveLength(4);

      expect(service.parseRadioResponse(null, 10)).toEqual([]);
      expect(service.parseRadioResponse({}, 10)).toEqual([]);
      expect(service.parseRadioResponse({ contents: { nope: true } }, 10)).toEqual([]);
    });

    it('предпочитает радио через мост публичным зеркалам', async () => {
      const youtubeRadio = vi
        .fn()
        .mockResolvedValue(
          radioPayload([{ videoId: 'bridge00001', title: 'From Bridge', artist: 'Kordhell' }])
        );
      (window as any).electronAPI = { youtubeRadio };
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      const results = await service.getRelatedVideos('seed0000001', 5);

      expect(youtubeRadio).toHaveBeenCalledWith('seed0000001');
      expect(results).toHaveLength(1);
      expect(results[0].originalId).toBe('bridge00001');
      // Зеркала не трогаем вовсе: до них дело не дошло.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('падает на зеркала, когда мост отказал', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      (window as any).electronAPI = {
        youtubeRadio: vi.fn().mockRejectedValue(new Error('InnerTube next HTTP error: 403'))
      };

      const related = new YouTubeService({
        pipedInstances: ['https://piped.test'],
        invidiousInstances: []
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          relatedStreams: [
            {
              url: '/watch?v=mirror00001',
              title: 'From Mirror',
              uploaderName: 'Someone',
              duration: 200
            }
          ]
        })
      } as any);

      const results = await related.getRelatedVideos('seed0000001', 5);

      expect(results).toHaveLength(1);
      expect(results[0].originalId).toBe('mirror00001');
    });

    it('падает на зеркала, когда моста нет вовсе', async () => {
      delete (window as any).electronAPI;

      const related = new YouTubeService({
        pipedInstances: ['https://piped.test'],
        invidiousInstances: []
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          relatedStreams: [
            {
              url: '/watch?v=nobridge001',
              title: 'Browser Path',
              uploaderName: 'Someone',
              duration: 190
            }
          ]
        })
      } as any);

      const results = await related.getRelatedVideos('seed0000001', 5);

      expect(results).toHaveLength(1);
      expect(results[0].originalId).toBe('nobridge001');
    });
  });
});
