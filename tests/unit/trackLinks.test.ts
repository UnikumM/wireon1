import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseTrackLink, resolveTrackLink, trackSearchQuery } from '../../src/services/trackLinks';
import { YouTubeService, youtubeService } from '../../src/services/youtube';
import { SoundCloudService, soundCloudService } from '../../src/services/soundcloud';
import { UNKNOWN_ARTIST } from '../../src/utils/placeholders';
import type { UnifiedTrack } from '../../src/types/music';

const ID = 'dQw4w9WgXcQ';

function track(overrides: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return {
    id: `yt_${ID}`,
    source: 'youtube',
    originalId: ID,
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    duration: 213,
    artworkUrl: '',
    ...overrides
  };
}

/** Ответ поиска InnerTube с одной песней. */
function innerTubePayload(videoId: string, title: string) {
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
                                { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
                                { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Artist' }, { text: ' • ' }, { text: '3:33' }] } } }
                              ],
                              thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/x.jpg' }] } } }
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

/** Ответ радио (`next`): первым стоит сама песня-семя. */
function radioPayload(items: Array<{ videoId: string; title: string }>) {
  return {
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
                              lengthText: { runs: [{ text: '3:33' }] },
                              shortBylineText: { runs: [{ text: 'Rick Astley' }] },
                              thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/x.jpg' }] }
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
  };
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('ссылка на трек: разбор', () => {
  it('все формы YouTube дают идентификатор видео', () => {
    const yt = { source: 'youtube', videoId: ID };
    expect(parseTrackLink(`https://www.youtube.com/watch?v=${ID}`)).toEqual(yt);
    expect(parseTrackLink(`https://youtube.com/watch?v=${ID}&t=42s`)).toEqual(yt);
    expect(parseTrackLink(`https://youtu.be/${ID}`)).toEqual(yt);
    expect(parseTrackLink(`https://youtu.be/${ID}?t=10`)).toEqual(yt);
    expect(parseTrackLink(`https://music.youtube.com/watch?v=${ID}&feature=share`)).toEqual(yt);
    expect(parseTrackLink(`https://m.youtube.com/watch?v=${ID}`)).toEqual(yt);
    expect(parseTrackLink(`https://www.youtube.com/shorts/${ID}`)).toEqual(yt);
    expect(parseTrackLink(`youtu.be/${ID}`)).toEqual(yt);
    expect(parseTrackLink(`  https://youtu.be/${ID}  `)).toEqual(yt);
  });

  it('трек внутри плейлиста — это трек', () => {
    expect(parseTrackLink(`https://www.youtube.com/watch?v=${ID}&list=PLabcdefghijKLMN&index=3`)).toEqual({
      source: 'youtube',
      videoId: ID
    });
    expect(parseTrackLink(`https://music.youtube.com/watch?v=${ID}&list=OLAK5uy_abcdefghijk`)?.source).toBe('youtube');
  });

  it('SoundCloud: страница трека и короткая ссылка', () => {
    expect(parseTrackLink('https://soundcloud.com/kordhell/murder-in-my-mind?si=abc&utm_source=clipboard')).toEqual({
      source: 'soundcloud',
      url: 'https://soundcloud.com/kordhell/murder-in-my-mind'
    });
    expect(parseTrackLink('https://m.soundcloud.com/kordhell/murder-in-my-mind')).toEqual({
      source: 'soundcloud',
      url: 'https://soundcloud.com/kordhell/murder-in-my-mind'
    });
    expect(parseTrackLink('soundcloud.com/kordhell/murder-in-my-mind')?.source).toBe('soundcloud');
    expect(parseTrackLink('https://soundcloud.com/artist/private-track/s-AbCdEf')).toEqual({
      source: 'soundcloud',
      url: 'https://soundcloud.com/artist/private-track/s-AbCdEf'
    });
    expect(parseTrackLink('https://on.soundcloud.com/xYz12')).toEqual({
      source: 'soundcloud',
      url: 'https://on.soundcloud.com/xYz12'
    });
  });

  it('мусор, подборки и профили — не треки', () => {
    expect(parseTrackLink('')).toBeNull();
    expect(parseTrackLink('кино кукушка')).toBeNull();
    expect(parseTrackLink('rick astley never gonna give you up')).toBeNull();
    expect(parseTrackLink('https://example.com/watch?v=' + ID)).toBeNull();
    expect(parseTrackLink('https://www.youtube.com/playlist?list=PLabcdefghijKLMN')).toBeNull();
    expect(parseTrackLink('https://music.youtube.com/browse/MPREb_abc123')).toBeNull();
    expect(parseTrackLink('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(parseTrackLink('https://www.youtube.com/@channel')).toBeNull();
    expect(parseTrackLink('https://soundcloud.com/artist/sets/night-drive')).toBeNull();
    expect(parseTrackLink('https://soundcloud.com/artist')).toBeNull();
    expect(parseTrackLink('https://soundcloud.com/search/sounds?q=x')).toBeNull();
    expect(parseTrackLink('https://soundcloud.com/discover/sets/charts-top')).toBeNull();
    expect(parseTrackLink('https://on.soundcloud.com/')).toBeNull();
    expect(parseTrackLink('https://youtu.be/')).toBeNull();
    expect(parseTrackLink('http://[bad')).toBeNull();
  });

  it('запрос под треком — исполнитель и название, без заглушки', () => {
    expect(trackSearchQuery(track())).toBe('Rick Astley Never Gonna Give You Up');
    expect(trackSearchQuery(track({ artist: UNKNOWN_ARTIST }))).toBe('Never Gonna Give You Up');
    expect(trackSearchQuery(track({ artist: '  ' }))).toBe('Never Gonna Give You Up');
  });
});

describe('ссылка на трек: резолв', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as any).electronAPI;
  });

  it('YouTube — через youtubeService.getTrackById', async () => {
    const found = track();
    const spy = vi.spyOn(youtubeService, 'getTrackById').mockResolvedValue(found);
    await expect(resolveTrackLink({ source: 'youtube', videoId: ID })).resolves.toBe(found);
    expect(spy).toHaveBeenCalledWith(ID);
  });

  it('SoundCloud — через soundCloudService.resolveTrackUrl', async () => {
    const found = track({ id: 'sc_1', source: 'soundcloud', originalId: '1' });
    const spy = vi.spyOn(soundCloudService, 'resolveTrackUrl').mockResolvedValue(found);
    await expect(resolveTrackLink({ source: 'soundcloud', url: 'https://soundcloud.com/a/b' })).resolves.toBe(found);
    expect(spy).toHaveBeenCalledWith('https://soundcloud.com/a/b');
  });

  it('отказ источника и пустой разбор — null, не ошибка', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(youtubeService, 'getTrackById').mockRejectedValue(new Error('boom'));
    await expect(resolveTrackLink({ source: 'youtube', videoId: ID })).resolves.toBeNull();
    vi.spyOn(soundCloudService, 'resolveTrackUrl').mockResolvedValue(null);
    await expect(resolveTrackLink({ source: 'soundcloud', url: 'https://soundcloud.com/a/b' })).resolves.toBeNull();
    await expect(resolveTrackLink(null)).resolves.toBeNull();
  });

  describe('YouTubeService.getTrackById', () => {
    it('с мостом берёт песню-семя из радио, не ходя в поиск', async () => {
      const youtubeRadio = vi.fn().mockResolvedValue(
        radioPayload([
          { videoId: ID, title: 'Never Gonna Give You Up' },
          { videoId: 'other000001', title: 'Other' }
        ])
      );
      (window as any).electronAPI = { youtubeRadio };
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      const service = new YouTubeService({ pipedInstances: [], invidiousInstances: [] });
      const found = await service.getTrackById(ID);

      expect(youtubeRadio).toHaveBeenCalledWith(ID);
      expect(found).toMatchObject({ id: `yt_${ID}`, originalId: ID, title: 'Never Gonna Give You Up', artist: 'Rick Astley' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('без моста ищет по идентификатору и берёт только точное совпадение', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Первый ответ (песни) — чужой трек, второй (клипы) — наш.
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(json(innerTubePayload('other000001', 'Something Else')))
        .mockResolvedValueOnce(json(innerTubePayload(ID, 'Never Gonna Give You Up (Video)'))) as any;

      const service = new YouTubeService({ pipedInstances: [], invidiousInstances: [] });
      const found = await service.getTrackById(ID);

      expect(found?.originalId).toBe(ID);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('ничего не совпало — null', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockResolvedValue(json(innerTubePayload('other000001', 'Something Else'))) as any;
      const service = new YouTubeService({ pipedInstances: [], invidiousInstances: [] });
      await expect(service.getTrackById(ID)).resolves.toBeNull();
      await expect(service.getTrackById('')).resolves.toBeNull();
    });
  });

  describe('SoundCloudService.resolveTrackUrl', () => {
    it('трек из /resolve нормализуется как обычный', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        json({
          kind: 'track',
          id: 987654,
          title: 'Murder In My Mind',
          duration: 165000,
          permalink_url: 'https://soundcloud.com/kordhell/murder-in-my-mind',
          artwork_url: 'https://i1.sndcdn.com/artworks-x-large.jpg',
          user: { username: 'Kordhell' }
        })
      );
      globalThis.fetch = fetchMock as any;
      const service = new SoundCloudService({ clientIds: ['mock_client'] });

      const found = await service.resolveTrackUrl('https://soundcloud.com/kordhell/murder-in-my-mind');

      expect(found).toMatchObject({ id: 'sc_987654', source: 'soundcloud', title: 'Murder In My Mind', artist: 'Kordhell', duration: 165 });
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('/resolve?');
      expect(url).toContain(encodeURIComponent('https://soundcloud.com/kordhell/murder-in-my-mind'));
    });

    it('плейлист, пустой ответ и пустая ссылка — null', async () => {
      const service = new SoundCloudService({ clientIds: ['mock_client'] });
      globalThis.fetch = vi.fn().mockResolvedValue(json({ kind: 'playlist', id: 1, title: 'Set', tracks: [] })) as any;
      await expect(service.resolveTrackUrl('https://soundcloud.com/a/sets/b')).resolves.toBeNull();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }) as any;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(service.resolveTrackUrl('https://soundcloud.com/a/b')).resolves.toBeNull();
      await expect(service.resolveTrackUrl('')).resolves.toBeNull();
    });
  });
});
