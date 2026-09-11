/**
 * Экран подборки (`src/components/collection/CollectionView.tsx`).
 *
 * До него альбом можно было только включить: состав человек узнавал очередью,
 * уже начав слушать. Здесь проверяется, что состав виден до нажатия и что
 * пустой ответ источника выглядит как ответ, а не как пустой экран.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import { CollectionView } from '../../src/components/collection/CollectionView';
import * as collections from '../../src/services/collections';
import { useUIStore } from '../../src/store/useUIStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { SearchCollection, UnifiedTrack } from '../../src/types/music';

const album: SearchCollection = {
  id: 'ytc_MPREb_dsotm',
  kind: 'album',
  source: 'youtube',
  ref: 'MPREb_dsotm',
  title: 'The Dark Side of the Moon',
  subtitle: 'Pink Floyd • 1973',
  artworkUrl: ''
};

function track(id: string): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id,
    title: `Track ${id}`,
    artist: 'Pink Floyd',
    duration: 200,
    artworkUrl: ''
  };
}

describe('экран подборки', () => {
  beforeEach(() => {
    useUIStore.setState({ activeCollection: album, activeView: 'collection' });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('показывает состав до того, как что-то зазвучало', async () => {
    const tracks = [track('yt_a'), track('yt_b')];
    vi.spyOn(collections, 'collectionTracks').mockResolvedValue(tracks);
    const playTrack = vi.fn().mockResolvedValue(undefined);
    usePlayerStore.setState({ playTrack: playTrack as never });

    await act(async () => {
      render(<CollectionView />);
    });

    await waitFor(() => expect(screen.getByTestId('collection-track-list')).toBeTruthy());
    expect(screen.getByTestId('collection-title').textContent).toContain('Dark Side');
    // Ничего не играет, пока не нажали.
    expect(playTrack).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('collection-play'));
    });
    expect(playTrack).toHaveBeenCalledWith(tracks[0], tracks, 0);
  });

  it('пустой ответ источника — это ответ, а не пустой экран', async () => {
    vi.spyOn(collections, 'collectionTracks').mockResolvedValue([]);

    await act(async () => {
      render(<CollectionView />);
    });

    await waitFor(() => expect(screen.getByTestId('collection-empty')).toBeTruthy());
    // Кнопка есть, но нажимать её не на что — и это видно.
    expect(screen.getByTestId('collection-play')).toHaveProperty('disabled', true);
  });

  it('без выбранной подборки экран не падает', async () => {
    useUIStore.setState({ activeCollection: null });

    await act(async () => {
      render(<CollectionView />);
    });

    expect(screen.queryByTestId('collection-view')).toBeNull();
  });
});
