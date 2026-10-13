import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup, act } from '@testing-library/react';
import '../setup';
import { parseCollectionLink, collectionDetails, LINK_COLLECTION_TITLE } from '../../src/services/collections';
import { youtubeService } from '../../src/services/youtube';
import { soundCloudService } from '../../src/services/soundcloud';
import { playlistImporter } from '../../src/services/playlistImporter';
import { SearchResults } from '../../src/components/search/SearchResults';
import { useUIStore } from '../../src/store/useUIStore';
import { searchAggregator } from '../../src/services/aggregator';
import { resetUIStore } from '../helpers/testUtils';

describe('3.0.1: чужой плейлист по ссылке', () => {
  it('понимает плейлисты YouTube и YouTube Music', () => {
    const a = parseCollectionLink('https://music.youtube.com/playlist?list=PLabcdefghijKLMN');
    expect(a).toMatchObject({ kind: 'playlist', source: 'youtube', ref: 'PLabcdefghijKLMN', title: LINK_COLLECTION_TITLE });
    expect(parseCollectionLink('https://www.youtube.com/watch?v=x&list=PLabcdefghijKLMN')?.ref).toBe('PLabcdefghijKLMN');
    expect(parseCollectionLink('youtube.com/playlist?list=OLAK5uy_abcdefghijk')?.ref).toBe('OLAK5uy_abcdefghijk');
  });

  it('альбомы YouTube Music и плейлисты SoundCloud', () => {
    expect(parseCollectionLink('https://music.youtube.com/browse/MPREb_abc123')).toMatchObject({ kind: 'album', ref: 'MPREb_abc123' });
    expect(parseCollectionLink('https://soundcloud.com/artist/sets/night-drive?si=123')).toMatchObject({
      source: 'soundcloud',
      ref: 'https://soundcloud.com/artist/sets/night-drive'
    });
  });

  it('обычный текст, одиночный трек и миксы YouTube — не ссылки на подборку', () => {
    expect(parseCollectionLink('кино кукушка')).toBeNull();
    expect(parseCollectionLink('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(parseCollectionLink('https://www.youtube.com/watch?v=abc&list=RDabcdefghijk')).toBeNull();
    expect(parseCollectionLink('https://soundcloud.com/artist/track-name')).toBeNull();
    expect(parseCollectionLink('https://example.com/?list=PLabcdefghijKLMN')).toBeNull();
  });

  it('импорт тоже знает SoundCloud', () => {
    expect(playlistImporter.detectPlatform('https://soundcloud.com/a/sets/b')).toBe('soundcloud');
  });

  it('по ссылке приезжает и настоящее название', async () => {
    vi.spyOn(youtubeService, 'getPlaylistWithTitle').mockResolvedValue({ title: 'Друзья рекомендуют', tracks: [] });
    const link = parseCollectionLink('https://music.youtube.com/playlist?list=PLabcdefghijKLMN')!;
    expect((await collectionDetails(link)).title).toBe('Друзья рекомендуют');
    vi.spyOn(soundCloudService, 'getPlaylistWithTitle').mockResolvedValue({ title: 'SC сет', tracks: [] });
    const sc = parseCollectionLink('https://soundcloud.com/a/sets/b')!;
    expect((await collectionDetails(sc)).title).toBe('SC сет');
    vi.restoreAllMocks();
  });
});

describe('3.0.1: ссылка в поиске открывает плейлист', () => {
  beforeEach(() => resetUIStore());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('вставленная ссылка уводит на экран подборки, а не ищет её текст', async () => {
    const search = vi.spyOn(searchAggregator, 'search');
    render(<SearchResults />);
    act(() => useUIStore.getState().setSearchQuery('https://music.youtube.com/playlist?list=PLabcdefghijKLMN'));
    await waitFor(() => expect(useUIStore.getState().activeView).toBe('collection'));
    expect(useUIStore.getState().activeCollection?.ref).toBe('PLabcdefghijKLMN');
    expect(useUIStore.getState().searchQuery).toBe('');
    expect(search).not.toHaveBeenCalledWith(expect.stringContaining('youtube.com'), expect.anything());
  });
});
