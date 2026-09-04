import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SoundCloudService,
  upgradeSoundCloudArtwork,
  scoreTranscoding,
  pickBestTranscoding,
  rankTranscodings,
  getSoundCloudStreamExpiry,
  SoundCloudAuthError
} from '../../src/services/soundcloud';

const PROGRESSIVE_MP3 = {
  url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:987654/progressive',
  quality: 'sq',
  format: { protocol: 'progressive', mime_type: 'audio/mpeg' }
};

const HLS_AAC = {
  url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:987654/hls-aac',
  quality: 'sq',
  format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' }
};

const HLS_AAC_HQ = {
  url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:987654/hls-aac-hq',
  quality: 'hq',
  format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' }
};

const HLS_OPUS = {
  url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:987654/hls-opus',
  quality: 'sq',
  format: { protocol: 'hls', mime_type: 'audio/ogg; codecs="opus"' }
};

/**
 * SoundCloud's adaptive variant. Its mime type contains the substring "mpeg",
 * which is why it once outscored the concrete codecs — and it is the variant
 * most likely to answer 404.
 */
const HLS_ABR = {
  url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:987654/hls-abr',
  quality: 'sq',
  preset: 'abr_sq',
  format: { protocol: 'hls', mime_type: 'audio/mpegurl' }
};

/** A 30-second snippet: playable, but not the track the user asked for. */
const PROGRESSIVE_SNIPPED = {
  url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:987654/preview',
  quality: 'sq',
  preset: 'mp3_1_0',
  snipped: true,
  format: { protocol: 'progressive', mime_type: 'audio/mpeg' }
};

/** Label uploads are frequently published only as DRM-encrypted HLS. */
const DRM_HLS = {
  url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:987654/cbc',
  quality: 'sq',
  format: { protocol: 'cbc-encrypted-hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' }
};

describe('SoundCloud Service & Normalizer', () => {
  describe('Artwork Upgrader', () => {
    it('upgrades low res artwork to 500x500', () => {
      expect(upgradeSoundCloudArtwork('https://i1.sndcdn.com/artworks-12345-large.jpg'))
        .toBe('https://i1.sndcdn.com/artworks-12345-t500x500.jpg');

      expect(upgradeSoundCloudArtwork('https://i1.sndcdn.com/avatars-0001-t120x120.jpg'))
        .toBe('https://i1.sndcdn.com/avatars-0001-t500x500.jpg');

      expect(upgradeSoundCloudArtwork('')).toBe('');
    });
  });

  describe('Transcoding selection', () => {
    it('scores progressive above HLS and rejects unknown protocols', () => {
      expect(scoreTranscoding(PROGRESSIVE_MP3)).toBeGreaterThan(scoreTranscoding(HLS_AAC_HQ));
      expect(scoreTranscoding(HLS_AAC_HQ)).toBeGreaterThan(scoreTranscoding(HLS_AAC));
      expect(scoreTranscoding(HLS_AAC)).toBeGreaterThan(scoreTranscoding(HLS_OPUS));
      expect(scoreTranscoding({ url: 'x', format: { protocol: 'dash' } })).toBe(-1);
      expect(scoreTranscoding({ format: { protocol: 'progressive' } })).toBe(-1);
      expect(scoreTranscoding(null)).toBe(-1);
    });

    it('prefers a progressive transcoding when one exists', () => {
      expect(pickBestTranscoding([HLS_AAC, HLS_AAC_HQ, HLS_OPUS, PROGRESSIVE_MP3])).toBe(PROGRESSIVE_MP3);
    });

    it('falls back to the best HLS transcoding', () => {
      expect(pickBestTranscoding([HLS_OPUS, HLS_AAC, HLS_AAC_HQ])).toBe(HLS_AAC_HQ);
    });

    it('returns null when nothing is playable', () => {
      expect(pickBestTranscoding([])).toBeNull();
      expect(pickBestTranscoding([{ url: 'x', format: { protocol: 'dash' } }])).toBeNull();
    });

    it('does not mistake an adaptive manifest for an MP3 stream', () => {
      // "audio/mpegurl" contains "mpeg". Scored as MP3 it beat aac_160k, so the
      // one variant SoundCloud most often 404s was picked first.
      expect(scoreTranscoding(HLS_AAC)).toBeGreaterThan(scoreTranscoding(HLS_ABR));
      expect(pickBestTranscoding([HLS_ABR, HLS_AAC])).toBe(HLS_AAC);
    });

    it('ranks a snipped preview below every full transcoding', () => {
      // A preview is a tier, not a low score: it stays playable when it is all
      // SoundCloud offers.
      expect(rankTranscodings([PROGRESSIVE_SNIPPED, HLS_OPUS])).toEqual([
        HLS_OPUS,
        PROGRESSIVE_SNIPPED
      ]);
      expect(pickBestTranscoding([PROGRESSIVE_SNIPPED, HLS_OPUS])).toBe(HLS_OPUS);
      expect(pickBestTranscoding([PROGRESSIVE_SNIPPED])).toBe(PROGRESSIVE_SNIPPED);
    });

    it('rejects DRM-encrypted transcodings outright', () => {
      expect(scoreTranscoding(DRM_HLS)).toBe(-1);
      expect(
        scoreTranscoding({ ...DRM_HLS, format: { ...DRM_HLS.format, protocol: 'ctr-encrypted-hls' } })
      ).toBe(-1);
      expect(pickBestTranscoding([DRM_HLS])).toBeNull();
    });

    it('ranks every playable transcoding, best first', () => {
      expect(rankTranscodings([DRM_HLS, HLS_ABR, PROGRESSIVE_MP3, HLS_AAC_HQ])).toEqual([
        PROGRESSIVE_MP3,
        HLS_AAC_HQ,
        HLS_ABR
      ]);
    });
  });

  describe('Stream expiry', () => {
    it('reads the CloudFront Expires parameter when present', () => {
      expect(
        getSoundCloudStreamExpiry('https://cf-media.sndcdn.com/a.mp3?Expires=1893456000')
      ).toBe(1893456000 * 1000);
    });

    it('falls back to a fixed TTL for unsigned or unreadable URLs', () => {
      const before = Date.now();
      const expiry = getSoundCloudStreamExpiry('https://cf-media.sndcdn.com/stream/987654.128.mp3');
      expect(expiry).toBeGreaterThanOrEqual(before + 3600 * 1000 - 50);
      expect(getSoundCloudStreamExpiry('not-a-url')).toBeGreaterThan(before);
    });
  });

  describe('SoundCloudService API & Stream Resolution', () => {
    let service: SoundCloudService;

    beforeEach(() => {
      service = new SoundCloudService({ clientIds: ['mock_client_1', 'mock_client_2'] });
      vi.restoreAllMocks();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('перебор не возвращается к отвергнутому ключу', () => {
      /*
       * Раньше перебор шёл по кругу и через шаг снова приводил к тому ключу,
       * который только что ответил «не авторизован», — да ещё и кэшировал его на
       * шесть часов, отключая заодно поиск. Замерено 2026-09-01: из четырёх
       * вшитых ключей живым был один, так что круг означал полную неработающую
       * связь с SoundCloud.
       */
      expect(service.rotateClientId()).toBe('mock_client_2');
      // Первый помечен негодным и обратно не берётся. Второй при этом остаётся
      // в строю: последний живой ключ не помечается никогда, иначе один отказ
      // отключал бы SoundCloud целиком.
      expect(service.rotateClientId()).toBe('mock_client_2');
    });

    it('сработавший ключ снимает с себя отметку негодного', () => {
      // Иначе одна случайная неудача держала бы рабочий ключ в чёрном списке
      // полчаса, хотя следующий же запрос по нему прошёл.
      expect(service.rotateClientId()).toBe('mock_client_2');
      // Пока первый негоден, уходить с рабочего второго некуда.
      expect(service.rotateClientId()).toBe('mock_client_2');

      service.noteClientIdWorked('mock_client_1');
      expect(service.rotateClientId()).toBe('mock_client_1');
    });

    it('regression: rotation survives the next getClientId() call', async () => {
      await expect(service.getClientId()).resolves.toBe('mock_client_1');
      service.rotateClientId();
      await expect(service.getClientId()).resolves.toBe('mock_client_2');
      await expect(service.getClientId()).resolves.toBe('mock_client_2');
    });

    it('serves a client_id from the static pool without any network request', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      await expect(service.getClientId()).resolves.toBe('mock_client_1');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service.getCachedClientId()).toBe('mock_client_1');
    });

    it('exposes setClientId / getCachedClientId for reuse and invalidation', async () => {
      service.setClientId('cached_from_elsewhere');
      expect(service.getCachedClientId()).toBe('cached_from_elsewhere');
      await expect(service.getClientId()).resolves.toBe('cached_from_elsewhere');

      service.setClientId(null);
      expect(service.getCachedClientId()).toBeNull();
    });

    it('expires a cached client_id after its TTL', () => {
      service.setClientId('short_lived', 1000);
      expect(service.getCachedClientId()).toBe('short_lived');

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 5000);
      expect(service.getCachedClientId()).toBeNull();
    });

    it('caps and dedupes the client_id pool when a fresh id is discovered', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bundle = '<script src="https://a-v2.sndcdn.com/assets/app-1.js"></script>';
      const clientId = 'a'.repeat(32);

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url) === 'https://soundcloud.com') {
          return { ok: true, status: 200, text: async () => bundle } as any;
        }
        return { ok: true, status: 200, text: async () => `client_id:"${clientId}"` } as any;
      });

      vi.useFakeTimers();
      // Повторный поиск не растит набор. Между попытками время сдвигается:
      // подряд идущие походы за ключом отсекает ограничитель — из-за них
      // SoundCloud и отвечал «слишком часто».
      for (let i = 0; i < 5; i++) {
        await expect(service.discoverFreshClientId()).resolves.toBe(clientId);
        vi.advanceTimersByTime(61_000);
      }

      expect(service.getCachedClientId()).toBe(clientId);
      // 2 seeded ids + 1 discovered, deduped: набор не растёт от повторов, а
      // перебор обходит все три по разу и ни к кому не возвращается.
      const seen = [service.rotateClientId(), service.rotateClientId()];
      expect(seen).toEqual(['mock_client_1', 'mock_client_2']);
      // Больше живых нет — перебор не идёт по кругу к отвергнутым, а остаётся
      // на последнем.
      expect(service.rotateClientId()).toBe('mock_client_2');
    });

    it('подряд идущие походы за ключом отсекаются', async () => {
      // Поиск ключа — это загрузка страницы soundcloud.com и её сборок. Когда
      // все известные ключи разом переставали приниматься, такой поход тянулся
      // за каждым запросом приложения, и SoundCloud отвечал 429.
      vi.useFakeTimers();
      const bundle = '<script src="https://a-v2.sndcdn.com/assets/app-1.js"></script>';
      const requests: string[] = [];
      globalThis.fetch = vi.fn(async (url: any) => {
        requests.push(String(url));
        if (String(url) === 'https://soundcloud.com') {
          return { ok: true, status: 200, text: async () => bundle } as any;
        }
        return { ok: true, status: 200, text: async () => `client_id:"${'b'.repeat(32)}"` } as any;
      }) as any;

      await service.discoverFreshClientId();
      const afterFirst = requests.length;

      await expect(service.discoverFreshClientId()).resolves.toBeNull();
      expect(requests).toHaveLength(afterFirst);

      vi.advanceTimersByTime(61_000);
      await expect(service.discoverFreshClientId()).resolves.toBe('b'.repeat(32));
      expect(requests.length).toBeGreaterThan(afterFirst);
    });

    it('stops scanning bundles at the first client_id hit', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = [
        '<script src="https://a-v2.sndcdn.com/assets/0-a.js"></script>',
        '<script src="https://a-v2.sndcdn.com/assets/1-b.js"></script>',
        '<script src="https://a-v2.sndcdn.com/assets/2-c.js"></script>',
        '<script src="https://a-v2.sndcdn.com/assets/3-d.js"></script>',
        '<script src="https://a-v2.sndcdn.com/assets/4-e.js"></script>',
        '<script src="https://a-v2.sndcdn.com/assets/5-f.js"></script>'
      ].join('');

      const requested: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const target = String(url);
        if (target === 'https://soundcloud.com') {
          return { ok: true, status: 200, text: async () => html } as any;
        }
        requested.push(target);
        return { ok: true, status: 200, text: async () => `client_id:"${'b'.repeat(32)}"` } as any;
      });

      await expect(service.discoverFreshClientId()).resolves.toBe('b'.repeat(32));
      // Scans from the last bundle backwards and stops immediately
      expect(requested).toEqual(['https://a-v2.sndcdn.com/assets/5-f.js']);
    });

    it('shares a single scrape between concurrent discovery calls', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = '<script src="https://a-v2.sndcdn.com/assets/app.js"></script>';
      let htmlFetches = 0;

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url) === 'https://soundcloud.com') {
          htmlFetches++;
          return { ok: true, status: 200, text: async () => html } as any;
        }
        return { ok: true, status: 200, text: async () => `client_id:"${'c'.repeat(32)}"` } as any;
      });

      const [a, b, c] = await Promise.all([
        service.discoverFreshClientId(),
        service.discoverFreshClientId(),
        service.discoverFreshClientId()
      ]);

      expect([a, b, c]).toEqual(['c'.repeat(32), 'c'.repeat(32), 'c'.repeat(32)]);
      expect(htmlFetches).toBe(1);
    });

    it('parses SoundCloud track payload to UnifiedTrack format', () => {
      const mockCollection = {
        collection: [
          {
            id: 987654,
            title: 'Chill Synthwave Beats',
            duration: 184500, // ms -> ~185 s
            artwork_url: 'https://i1.sndcdn.com/artworks-001-large.jpg',
            permalink_url: 'https://soundcloud.com/chillartist/synthwave-beats',
            user: {
              username: 'Chill Artist'
            }
          }
        ]
      };

      const tracks = service.parseTracksResponse(mockCollection, 10);
      expect(tracks).toHaveLength(1);
      expect(tracks[0]).toEqual({
        id: 'sc_987654',
        source: 'soundcloud',
        originalId: '987654',
        title: 'Chill Synthwave Beats',
        artist: 'Chill Artist',
        duration: 185,
        durationFormatted: '3:05',
        artworkUrl: 'https://i1.sndcdn.com/artworks-001-t500x500.jpg',
        sourceUrl: 'https://soundcloud.com/chillartist/synthwave-beats',
        format: 'mp3',
        bitrate: 128
      });
    });

    it('never invents a duration for a malformed payload', () => {
      const tracks = service.parseTracksResponse(
        {
          collection: [
            { id: 1, title: 'No duration', user: { username: 'A' } },
            { id: 2, title: 'Negative', duration: -1, user: { username: 'A' } },
            { id: 3, title: 'Garbage', duration: 'soon', user: { username: 'A' } }
          ]
        },
        10
      );

      expect(tracks.map(t => t.duration)).toEqual([0, 0, 0]);
      expect(tracks.map(t => t.durationFormatted)).toEqual(['0:00', '0:00', '0:00']);
    });

    it('resolves progressive MP3 stream URL', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: 'https://cf-media.sndcdn.com/stream/987654.128.mp3'
        })
      } as any);

      const stream = await service.resolveStreamUrl('987654', [PROGRESSIVE_MP3, HLS_OPUS]);
      expect(stream.streamUrl).toBe('https://cf-media.sndcdn.com/stream/987654.128.mp3');
      expect(stream.format).toBe('mp3');
      expect(stream.bitrate).toBe(128);
      expect(stream.expiresAt).toBeGreaterThan(Date.now());
    });

    it('marks an HLS-only track as format hls when HLS can be played', async () => {
      const hlsCapable = new SoundCloudService({ clientIds: ['mock_client_1'], hlsSupported: true });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: 'https://playback.media-streaming.soundcloud.cloud/abc/aac_160k/x/playlist.m3u8'
        })
      } as any);

      const stream = await hlsCapable.resolveStreamUrl('987654', [HLS_AAC, HLS_AAC_HQ]);
      expect(stream.format).toBe('hls');
      expect(stream.streamUrl).toContain('.m3u8');
    });

    it('regression: refuses an HLS-only track when HLS cannot be played', async () => {
      const noHls = new SoundCloudService({ clientIds: ['mock_client_1'], hlsSupported: false });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      await expect(noHls.resolveStreamUrl('987654', [HLS_AAC, HLS_OPUS])).rejects.toThrow(
        /SoundCloud HLS playback unavailable/
      );
      // It must not even resolve the CDN URL it could never play
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses a manifest that arrives from a supposedly progressive transcoding', async () => {
      const noHls = new SoundCloudService({ clientIds: ['mock_client_1'], hlsSupported: false });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://playback.soundcloud.cloud/abc/playlist.m3u8?token=1' })
      } as any);

      await expect(noHls.resolveStreamUrl('987654', [PROGRESSIVE_MP3])).rejects.toThrow(
        /SoundCloud HLS playback unavailable/
      );
    });

    it('throws when a track has no usable transcoding', async () => {
      await expect(service.resolveStreamUrl('')).rejects.toThrow('Missing SoundCloud trackId');
      await expect(
        service.resolveStreamUrl('987654', [{ url: 'x', format: { protocol: 'dash' } }])
      ).rejects.toThrow(/No valid stream transcoding/);
    });

    it('берёт новый ключ, когда старый отвечает «не авторизован»', async () => {
      /*
       * Жалоба владельца от 2026-09-01: «часть музыки с SoundCloud иногда не
       * грузится, бывает ошибки выдаёт». `client_id` у SoundCloud не выдаётся,
       * а вычитывается из их же сборок и живёт недолго; протухший отвечает 401
       * на всё подряд. В поиске смена ключа была с самого начала, а здесь —
       * нет: все дорожки получали 401, и человеку показывалось «SoundCloud
       * отказался отдавать эту загрузку, обычно это ограничение лейбла или
       * региона», то есть приговор треку вместо «ключ устарел».
       */
      const rotating = new SoundCloudService({ clientIds: ['stale_key', 'fresh_key'] });
      const usedKeys: string[] = [];

      globalThis.fetch = vi.fn(async (url: any) => {
        const asText = String(url);
        usedKeys.push(asText.includes('fresh_key') ? 'fresh_key' : 'stale_key');
        if (asText.includes('stale_key')) {
          return { ok: false, status: 401, json: async () => ({}) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: 'https://cf-media.sndcdn.com/stream/987654.128.mp3' })
        } as any;
      }) as any;

      const stream = await rotating.resolveStreamUrl('987654', [PROGRESSIVE_MP3]);

      expect(stream.streamUrl).toContain('cf-media.sndcdn.com');
      expect(usedKeys).toContain('stale_key');
      expect(usedKeys).toContain('fresh_key');
    });

    it('отказ на одном треке не уносит рабочий ключ вместе с поиском', async () => {
      /*
       * Так выглядела беда после того, как в получение звука добавили смену
       * ключа: первый же отказ уводил приложение с рабочего ключа на следующий
       * и кэшировал его на шесть часов. А из четырёх вшитых ключей живым был
       * один (замерено 2026-09-01), так что следом переставал работать и поиск.
       * Владелец описал это как «SoundCloud выдаёт ошибку, слишком часто».
       */
      const live = new SoundCloudService({ clientIds: ['живой', 'мёртвый'] });
      globalThis.fetch = vi.fn(async (url: any) => {
        const asText = String(url);
        if (asText.includes('мёртвый')) {
          return { ok: false, status: 401, json: async () => ({}) } as any;
        }
        if (asText.includes('/search/tracks')) {
          return { ok: true, status: 200, json: async () => ({ collection: [] }) } as any;
        }
        // Эта конкретная загрузка перекрыта, хотя ключ в порядке.
        return { ok: false, status: 401, json: async () => ({}) } as any;
      }) as any;

      await expect(live.resolveStreamUrl('987654', [PROGRESSIVE_MP3])).rejects.toBeTruthy();

      // Ключ мог быть помечен негодным по дороге — но он рабочий, и поиск это
      // показывает, после чего отметка снимается.
      await live.search('что угодно');
      await expect(live.getClientId()).resolves.toBe('живой');
    });

    it('«не авторизован» не выдаётся за отсутствующую загрузку', async () => {
      // Даже когда ни один ключ не подошёл, причина остаётся про ключ: совет
      // «поищите другую версию» здесь просто неверен.
      const noKeys = new SoundCloudService({ clientIds: ['one_key'] });
      globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as any;

      await expect(noKeys.resolveStreamUrl('987654', [PROGRESSIVE_MP3])).rejects.toThrow(
        /no transcoding produced a playable URL/
      );
      await expect(noKeys.resolveStreamUrl('987654', [PROGRESSIVE_MP3])).rejects.toBeInstanceOf(
        SoundCloudAuthError
      );
    });

    it('regression: falls through to the next transcoding when one 404s', async () => {
      // SoundCloud answers 404 for a single variant of a track whose other
      // variants play fine. Giving up on the first failure made those tracks
      // look dead — four of the first six results for one query.
      const requested: string[] = [];
      globalThis.fetch = vi.fn(async (url: any) => {
        requested.push(String(url));
        if (String(url).includes('/progressive')) {
          return { ok: false, status: 404, json: async () => ({}) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: 'https://cf-media.sndcdn.com/stream/987654.128.mp3' })
        } as any;
      }) as any;

      const hlsCapable = new SoundCloudService({ clientIds: ['mock_client_1'], hlsSupported: true });
      const stream = await hlsCapable.resolveStreamUrl('987654', [PROGRESSIVE_MP3, HLS_AAC_HQ]);

      expect(stream.streamUrl).toBe('https://cf-media.sndcdn.com/stream/987654.128.mp3');
      // Best first, then the fallback — not the other way round.
      expect(requested).toHaveLength(2);
      expect(requested[0]).toContain('/progressive');
      expect(requested[1]).toContain('/hls-aac-hq');
    });

    it('reports every attempt when no transcoding works', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({})
      } as any);

      const hlsCapable = new SoundCloudService({ clientIds: ['mock_client_1'], hlsSupported: true });
      const failure = await hlsCapable
        .resolveStreamUrl('987654', [PROGRESSIVE_MP3, HLS_AAC_HQ])
        .catch((err: Error) => err);

      expect(failure).toBeInstanceOf(Error);
      // The message has to say which variants were tried, or a support report of
      // "it does not play" is unactionable.
      expect((failure as Error).message).toContain('progressive');
      expect((failure as Error).message).toContain('hls/hq');
      expect((failure as Error).message).toContain('404');
    });

    it('skips an unplayable HLS variant and still uses a later progressive one', async () => {
      const noHls = new SoundCloudService({ clientIds: ['mock_client_1'], hlsSupported: false });
      const requested: string[] = [];
      globalThis.fetch = vi.fn(async (url: any) => {
        requested.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: 'https://cf-media.sndcdn.com/stream/987654.128.mp3' })
        } as any;
      }) as any;

      // HLS scores higher than nothing, but it is unplayable here: the
      // progressive variant later in the list must still be found.
      const stream = await noHls.resolveStreamUrl('987654', [HLS_AAC_HQ, PROGRESSIVE_MP3]);

      expect(stream.format).toBe('mp3');
      expect(requested).toHaveLength(1);
      expect(requested[0]).toContain('/progressive');
    });

    it('says so plainly when a track is DRM-only', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      await expect(service.resolveStreamUrl('987654', [DRM_HLS])).rejects.toThrow(
        /DRM-protected audio \(cbc-encrypted-hls\)/
      );
      // No retry can help, so nothing is requested.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('flags a snipped preview so the UI can label it', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://cf-preview-media.sndcdn.com/preview/0/30/x.128.mp3' })
      } as any);

      const preview = await service.resolveStreamUrl('987654', [PROGRESSIVE_SNIPPED]);
      expect(preview.isPreview).toBe(true);

      const full = await service.resolveStreamUrl('987654', [PROGRESSIVE_MP3]);
      expect(full.isPreview).toBe(false);
    });

    it('handles empty search query', async () => {
      const results = await service.search('');
      expect(results).toEqual([]);
    });

    it('rotates the client_id on 401 and succeeds on the retry', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const usedClientIds: string[] = [];

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const clientId = new URL(String(url)).searchParams.get('client_id') || '';
        usedClientIds.push(clientId);
        if (usedClientIds.length === 1) {
          return { ok: false, status: 401, json: async () => ({}) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            collection: [{ id: 1, title: 'Retried', duration: 120000, user: { username: 'A' } }]
          })
        } as any;
      });

      const results = await service.search('synthwave', 5);
      expect(results).toHaveLength(1);
      expect(usedClientIds[0]).toBe('mock_client_1');
      expect(usedClientIds[1]).toBe('mock_client_2');
    });

    it('returns an empty list with a warning when every attempt fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      await expect(service.search('synthwave', 5)).resolves.toEqual([]);
      expect(warn).toHaveBeenCalled();
    });

    it('returns related tracks and never throws when the request fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          { id: 111, title: 'Related A', duration: 120000, user: { username: 'A' } },
          { id: 987654, title: 'The Seed', duration: 130000, user: { username: 'A' } }
        ]
      } as any);

      const related = await service.getRelatedTracks('987654', 10);
      expect(related.map(t => t.originalId)).toEqual(['111']);

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
      await expect(service.getRelatedTracks('987654', 10)).resolves.toEqual([]);
      await expect(service.getRelatedTracks('', 10)).resolves.toEqual([]);
    });

    it('aborts a search request that never settles once the timeout elapses', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();

      const timed = new SoundCloudService({ clientIds: ['mock_client_1'], requestTimeout: 1000 });
      const signals: AbortSignal[] = [];

      globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal);
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        });
      }) as any;

      const pending = timed.search('synthwave', 5);
      await vi.advanceTimersByTimeAsync(10000);

      await expect(pending).resolves.toEqual([]);
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every(s => s.aborted)).toBe(true);
    });
  });
});
