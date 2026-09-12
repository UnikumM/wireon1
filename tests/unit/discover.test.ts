/**
 * Чарты и новинки (`src/services/discover.ts` + разбор полок в `youtube.ts`).
 *
 * Образцы ответов сняты с живых страниц YouTube Music и ужаты до формы: важно
 * не содержимое, а то, что одна и та же страница отдаёт записи двумя разными
 * формами сразу — карусель плиток и карусель строк, — и обе должны разбираться.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { youtubeService } from '../../src/services/youtube';
import { getCharts, getNewReleases, resetDiscoverCache } from '../../src/services/discover';

/** Плитка: так приходят альбомы в новинках и хит-парады в чартах. */
function tile(browseId: string, title: string, pageType: string) {
  return {
    musicTwoRowItemRenderer: {
      thumbnailRenderer: {
        musicThumbnailRenderer: {
          thumbnail: { thumbnails: [{ url: 'small.jpg' }, { url: 'big.jpg' }] }
        }
      },
      title: {
        runs: [
          {
            text: title,
            navigationEndpoint: {
              browseEndpoint: {
                browseId,
                browseEndpointContextSupportedConfigs: {
                  browseEndpointContextMusicConfig: { pageType }
                }
              }
            }
          }
        ]
      },
      subtitle: { runs: [{ text: 'Альбом' }, { text: ' • ' }, { text: 'ELITE' }] }
    }
  };
}

/** Строка: так на той же странице приходит «Топ исполнителей». */
function row(browseId: string, title: string, pageType: string) {
  return {
    musicResponsiveListItemRenderer: {
      thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'face.jpg' }] } } },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: '1,2 млн' }] } } }
      ],
      navigationEndpoint: {
        browseEndpoint: {
          browseId,
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: { pageType }
          }
        }
      }
    }
  };
}

/** Клип: у него `watchEndpoint`, и подборкой он не является. */
const video = {
  musicTwoRowItemRenderer: {
    title: { runs: [{ text: 'Клип', navigationEndpoint: { watchEndpoint: { videoId: 'abc' } } }] }
  }
};

function page(shelves: { title: string; contents: unknown[] }[]) {
  return {
    contents: {
      singleColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    // Пустая полка-разделитель приходит первой на обеих страницах.
                    { musicShelfRenderer: { subheaders: [] } },
                    ...shelves.map((shelf) => ({
                      musicCarouselShelfRenderer: {
                        header: {
                          musicCarouselShelfBasicHeaderRenderer: {
                            title: { runs: [{ text: shelf.title }] }
                          }
                        },
                        contents: shelf.contents
                      }
                    }))
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

describe('разбор полок', () => {
  it('плитки и строки разбираются одинаково', () => {
    const shelves = youtubeService.parseShelvesResponse(
      page([
        { title: 'Альбомы и синглы', contents: [tile('MPREb_x', 'Legend', 'MUSIC_PAGE_TYPE_ALBUM')] },
        { title: 'Топ исполнителей', contents: [row('UCabc', 'Daft Punk', 'MUSIC_PAGE_TYPE_ARTIST')] }
      ])
    );

    expect(shelves).toHaveLength(2);
    expect(shelves[0].items[0]).toMatchObject({
      kind: 'album',
      ref: 'MPREb_x',
      title: 'Legend',
      subtitle: 'Альбом • ELITE',
      // Берётся самая крупная картинка: в сетке мелкая мылится.
      artworkUrl: 'big.jpg'
    });
    expect(shelves[1].items[0]).toMatchObject({ kind: 'artist', ref: 'UCabc', title: 'Daft Punk' });
  });

  it('клипы отсеиваются, пустые полки не показываются', () => {
    const shelves = youtubeService.parseShelvesResponse(
      page([{ title: 'Видеоклипы', contents: [video, video] }])
    );

    // Полка была, а подборок в ней нет — показывать пустой заголовок не за что.
    expect(shelves).toEqual([]);
  });
});

describe('разбор поиска подборок', () => {
  /**
   * Форма снята с живого ответа поиска без фильтра.
   *
   * Там нет ни одной `musicShelfRenderer`: выдача приходит десятками
   * `itemSectionRenderer` по одной записи и одной `musicCardShelfRenderer` с
   * лучшим совпадением. Разбор искал только первую — и все три вкладки
   * подборок были пустыми всегда, на обеих платформах.
   */
  function searchItem(browseId: string, title: string, pageType: string) {
    return {
      musicResponsiveListItemRenderer: {
        thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'art.jpg' }] } } },
        flexColumns: [
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Альбом' }] } } }
        ],
        navigationEndpoint: {
          browseEndpoint: {
            browseId,
            browseEndpointContextSupportedConfigs: {
              browseEndpointContextMusicConfig: { pageType }
            }
          }
        }
      }
    };
  }

  /** Трек: у него `watchEndpoint`, подборкой он не является. */
  const watchItem = {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Песня' }] } } }
      ],
      navigationEndpoint: { watchEndpoint: { videoId: 'abc' } }
    }
  };

  it('находит подборки в itemSectionRenderer и musicCardShelfRenderer', () => {
    const response = {
      contents: {
        tabbedSearchResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  sectionListRenderer: {
                    contents: [
                      { itemSectionRenderer: { contents: [{ messageRenderer: {} }] } },
                      {
                        musicCardShelfRenderer: {
                          contents: [searchItem('UCdaft', 'Daft Punk', 'MUSIC_PAGE_TYPE_ARTIST')]
                        }
                      },
                      { itemSectionRenderer: { contents: [watchItem] } },
                      {
                        itemSectionRenderer: {
                          contents: [searchItem('MPREb_ram', 'Random Access Memories', 'MUSIC_PAGE_TYPE_ALBUM')]
                        }
                      },
                      {
                        itemSectionRenderer: {
                          contents: [searchItem('VLpl1', 'Лучшее', 'MUSIC_PAGE_TYPE_PLAYLIST')]
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

    const found = youtubeService.parseCollectionsResponse(response);

    expect(found.map((item) => `${item.kind}:${item.ref}`)).toEqual([
      'artist:UCdaft',
      'album:MPREb_ram',
      'playlist:VLpl1'
    ]);
    // Трек в подборки не попадает: у него нет страницы, которую можно открыть.
    expect(found.some((item) => item.title === 'Песня')).toBe(false);
  });

  it('один и тот же альбом не приезжает дважды', () => {
    // Лучшее совпадение дублируется ниже в общем списке — это норма ответа.
    const twice = {
      contents: {
        sectionListRenderer: {
          contents: [
            { musicCardShelfRenderer: { contents: [searchItem('MPREb_x', 'Альбом', 'MUSIC_PAGE_TYPE_ALBUM')] } },
            { itemSectionRenderer: { contents: [searchItem('MPREb_x', 'Альбом', 'MUSIC_PAGE_TYPE_ALBUM')] } }
          ]
        }
      }
    };

    expect(youtubeService.parseCollectionsResponse(twice)).toHaveLength(1);
  });
});

describe('кэш страниц', () => {
  beforeEach(() => {
    resetDiscoverCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('чарты и новинки — разные страницы, и каждая спрашивается один раз', async () => {
    const spy = vi
      .spyOn(youtubeService, 'browseShelves')
      .mockResolvedValue([{ title: 'Полка', items: [] as never[] }]);

    await getCharts();
    await getCharts();
    await getNewReleases();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toBe('FEmusic_charts');
    expect(spy.mock.calls[1][0]).toBe('FEmusic_new_releases');
  });

  it('пустой ответ не запоминается', async () => {
    // Пусто — это почти всегда отказ сети, а не «чартов нет»; запомнив его на
    // час, мы показывали бы пустоту до перезапуска приложения.
    const spy = vi.spyOn(youtubeService, 'browseShelves').mockResolvedValue([]);

    await getCharts();
    await getCharts();

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
