/**
 * Перенос плейлиста YouTube Music (`youtubeService.getPlaylistTracks`).
 *
 * Это единственный случай, где перенос обязан быть точным: плейлист уже состоит
 * из тех записей, которые мы играем, и подбирать по названию нечего. Поэтому
 * здесь проверяется не «похожесть», а что список приезжает целиком и с теми же
 * идентификаторами.
 */

import { describe, it, expect } from 'vitest';
import { YouTubeService } from '../../src/services/youtube';
import { playlistImporter } from '../../src/services/playlistImporter';

/** Запись плейлиста в том виде, в каком её отдаёт InnerTube. */
function playlistItem(videoId: string, title: string, artist: string, duration: string) {
  return {
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: artist }, { text: ' • ' }, { text: duration }] } } }
      ],
      thumbnail: {
        musicThumbnailRenderer: {
          thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/x/default.jpg', width: 120, height: 90 }] }
        }
      }
    }
  };
}

describe('ссылки на плейлисты', () => {
  it('YouTube Music узнаётся во всех привычных видах ссылки', () => {
    expect(playlistImporter.detectPlatform('https://music.youtube.com/playlist?list=PL123abc')).toBe('youtube');
    expect(playlistImporter.detectPlatform('https://www.youtube.com/playlist?list=PL123abc')).toBe('youtube');
    expect(playlistImporter.detectPlatform('https://music.youtube.com/watch?v=abc&list=PL123abc')).toBe('youtube');
    // Ссылка на один трек плейлистом не является.
    expect(playlistImporter.detectPlatform('https://music.youtube.com/watch?v=abc')).toBeNull();
  });

  it('идентификатор достаётся из ссылки', () => {
    expect(playlistImporter.extractYouTubePlaylistId('https://music.youtube.com/playlist?list=PLabc_123')).toBe(
      'PLabc_123'
    );
    expect(playlistImporter.extractYouTubePlaylistId('https://music.youtube.com/watch?v=x&list=OLAK5uy_k')).toBe(
      'OLAK5uy_k'
    );
    expect(playlistImporter.extractYouTubePlaylistId('https://music.youtube.com/watch?v=x')).toBeNull();
  });
});

describe('чтение плейлиста YouTube Music', () => {
  const service = new YouTubeService();

  it('разбирает одноколоночную раскладку', () => {
    const data = {
      contents: {
        singleColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  sectionListRenderer: {
                    contents: [
                      {
                        musicPlaylistShelfRenderer: {
                          contents: [
                            playlistItem('vid1', 'Первая', 'Артист А', '3:20'),
                            playlistItem('vid2', 'Вторая', 'Артист Б', '4:05')
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

    const tracks = service.parsePlaylistResponse(data);

    expect(tracks.map((t) => t.originalId)).toEqual(['vid1', 'vid2']);
    expect(tracks[0].title).toBe('Первая');
    expect(tracks[0].artist).toBe('Артист А');
    expect(tracks[0].duration).toBe(200);
    // Источник тот же, что у поиска, — значит трек играется без всякого подбора.
    expect(tracks[0].source).toBe('youtube');
  });

  it('разбирает двухколоночную раскладку — YouTube отдаёт то одну, то другую', () => {
    const data = {
      contents: {
        twoColumnBrowseResultsRenderer: {
          secondaryContents: {
            sectionListRenderer: {
              contents: [
                { musicPlaylistShelfRenderer: { contents: [playlistItem('vid9', 'Одна', 'Кто-то', '2:00')] } }
              ]
            }
          }
        }
      }
    };

    expect(service.parsePlaylistResponse(data).map((t) => t.originalId)).toEqual(['vid9']);
  });

  it('пустой или незнакомый ответ не роняет перенос', () => {
    expect(service.parsePlaylistResponse(null)).toEqual([]);
    expect(service.parsePlaylistResponse({})).toEqual([]);
    expect(service.parsePlaylistResponse({ contents: {} })).toEqual([]);
  });
});
