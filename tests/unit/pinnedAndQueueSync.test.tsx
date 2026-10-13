import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup';
import { usePinnedStore, orderPinned, MAX_PINNED, PINNED_PLAYLISTS_KEY } from '../../src/store/usePinnedStore';
import { isQueueOfTracks, usePlayerStore } from '../../src/store/usePlayerStore';
import { PlaylistView } from '../../src/components/library/PlaylistView';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import * as dbService from '../../src/services/db';
import { resetLibraryStore, resetPlayerStore, resetUIStore, resetAuthStore, signInForTests } from '../helpers/testUtils';
import { UnifiedTrack, Playlist } from '../../src/types/music';

const t = (id: string): UnifiedTrack => ({ id, source: 'youtube', originalId: id, title: id, artist: 'A', duration: 200, artworkUrl: '' });
const pl = (id: string, tracks: UnifiedTrack[]): Playlist => ({ id, title: id, tracks, createdAt: 1, updatedAt: 1, isSynced: false });

describe('3.0: закреплённые плейлисты', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    usePinnedStore.setState({ pinnedIds: [], hydrated: false });
  });

  it('закреплённые первыми, в порядке закрепления', () => {
    const list = [pl('a', []), pl('b', []), pl('c', [])];
    expect(orderPinned(list, ['c', 'b']).map((p) => p.id)).toEqual(['c', 'b', 'a']);
    expect(orderPinned(list, []).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('предел и запоминание', async () => {
    for (let i = 0; i < MAX_PINNED; i++) expect(usePinnedStore.getState().toggle(`p${i}`)).toBe(true);
    expect(usePinnedStore.getState().toggle('extra')).toBe(false);
    expect(usePinnedStore.getState().toggle('p0')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    const saved = await dbService.getSetting<string[]>(PINNED_PLAYLISTS_KEY, []);
    expect(saved).toHaveLength(MAX_PINNED - 1);
    usePinnedStore.setState({ pinnedIds: [], hydrated: false });
    await usePinnedStore.getState().hydrate();
    expect(usePinnedStore.getState().pinnedIds).toEqual(saved);
  });
});

describe('3.0: правка плейлиста не трогает чужую очередь', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetLibraryStore();
    resetPlayerStore();
    resetUIStore();
    resetAuthStore();
    signInForTests();
  });

  it('isQueueOfTracks сравнивает состав, а не порядок', () => {
    expect(isQueueOfTracks([t('b'), t('a')], [t('a'), t('b')])).toBe(true);
    expect(isQueueOfTracks([t('a'), t('a')], [t('a'), t('b')])).toBe(false);
    expect(isQueueOfTracks([], [])).toBe(false);
  });

  it('перенос трека в неиграющем плейлисте не подменяет очередь', async () => {
    const playlist = pl('pl_edit', [t('x'), t('y'), t('z')]);
    await dbService.savePlaylist(playlist);
    useLibraryStore.setState({ playlists: [playlist] });
    const album = [t('album1'), t('album2')];
    usePlayerStore.setState({ sourceQueue: album, currentIndex: 0, currentTrack: album[0] });
    render(<PlaylistView playlistId="pl_edit" />);
    fireEvent.click(screen.getByTestId('reorder-down-0'));
    await waitFor(async () => expect((await dbService.getPlaylistById('pl_edit'))?.tracks[0].id).toBe('y'));
    expect(usePlayerStore.getState().sourceQueue.map((x) => x.id)).toEqual(['album1', 'album2']);
  });

  it('а в играющем — сверяет', async () => {
    const playlist = pl('pl_edit', [t('x'), t('y'), t('z')]);
    await dbService.savePlaylist(playlist);
    useLibraryStore.setState({ playlists: [playlist] });
    usePlayerStore.setState({ sourceQueue: playlist.tracks, currentIndex: 0, currentTrack: playlist.tracks[0] });
    render(<PlaylistView playlistId="pl_edit" />);
    fireEvent.click(screen.getByTestId('reorder-down-0'));
    await waitFor(() => expect(usePlayerStore.getState().sourceQueue.map((x) => x.id)).toEqual(['y', 'x', 'z']));
    expect(usePlayerStore.getState().currentIndex).toBe(1);
  });

  it('кнопка закрепления на экране плейлиста', async () => {
    usePinnedStore.setState({ pinnedIds: [], hydrated: true });
    const playlist = pl('pl_pin', [t('x')]);
    useLibraryStore.setState({ playlists: [playlist] });
    render(<PlaylistView playlistId="pl_pin" />);
    fireEvent.click(screen.getByTestId('playlist-pin-btn'));
    expect(usePinnedStore.getState().pinnedIds).toEqual(['pl_pin']);
    expect(screen.getByTestId('playlist-pin-btn').getAttribute('aria-pressed')).toBe('true');
  });
});
