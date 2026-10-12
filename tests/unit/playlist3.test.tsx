import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup';
import { PlaylistView } from '../../src/components/library/PlaylistView';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import * as dbService from '../../src/services/db';
import { UnifiedTrack, Playlist } from '../../src/types/music';
import { resetLibraryStore, resetPlayerStore, resetUIStore, signInForTests, resetAuthStore } from '../helpers/testUtils';

const t = (id: string, title: string, artist: string, duration = 200): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title,
  artist,
  duration,
  artworkUrl: ''
});

const A = t('a', 'Zebra', 'Kino');
const B = t('b', 'Apple', 'Aria');
const C = t('c', 'Mango', 'Zemfira');

async function seed(tracks: UnifiedTrack[]): Promise<Playlist> {
  const playlist: Playlist = {
    id: 'pl_3',
    title: 'Тест',
    tracks,
    createdAt: 1,
    updatedAt: 1,
    isSynced: false
  };
  await dbService.savePlaylist(playlist);
  useLibraryStore.setState({ playlists: [playlist] });
  return playlist;
}

describe('3.0: пакетные операции медиатеки', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetLibraryStore();
    resetAuthStore();
    signInForTests();
  });

  it('добавляет пачку одной записью и пропускает повторы', async () => {
    await seed([A]);
    const result = await useLibraryStore.getState().addTracksToPlaylist('pl_3', [A, B, B, C]);
    expect(result).toEqual({ added: 2, skipped: 2 });
    const stored = await dbService.getPlaylistById('pl_3');
    expect(stored?.tracks.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(useLibraryStore.getState().playlists[0].tracks).toHaveLength(3);
  });

  it('может положить повтор, если попросить', async () => {
    await seed([A]);
    const result = await useLibraryStore.getState().addTracksToPlaylist('pl_3', [A], { allowDuplicates: true });
    expect(result).toEqual({ added: 1, skipped: 0 });
  });

  it('убирает повторы, оставляя первое вхождение', async () => {
    await seed([A, B, A, C, B]);
    expect(await useLibraryStore.getState().removeDuplicatesFromPlaylist('pl_3')).toBe(2);
    expect((await dbService.getPlaylistById('pl_3'))?.tracks.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(await useLibraryStore.getState().removeDuplicatesFromPlaylist('pl_3')).toBe(0);
  });

  it('создаёт плейлист сразу с составом', async () => {
    const created = await useLibraryStore.getState().createPlaylistWithTracks('Очередь', [A, B, A]);
    expect(created?.tracks.map((x) => x.id)).toEqual(['a', 'b']);
    expect(useLibraryStore.getState().playlists[0].id).toBe(created?.id);
  });

  it('без аккаунта пачку не кладёт', async () => {
    resetAuthStore();
    await seed([]);
    expect(await useLibraryStore.getState().addTracksToPlaylist('pl_3', [A])).toBeNull();
  });
});

describe('3.0: поиск и сортировка в плейлисте', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetLibraryStore();
    resetPlayerStore();
    resetUIStore();
    resetAuthStore();
    signInForTests();
  });

  it('ищет внутри плейлиста', async () => {
    await seed([A, B, C]);
    render(<PlaylistView playlistId="pl_3" />);
    fireEvent.change(screen.getByTestId('playlist-filter-input'), { target: { value: 'zem' } });
    expect(screen.getByTestId('playlist-track-row-2')).toBeInTheDocument();
    expect(screen.queryByTestId('playlist-track-row-0')).toBeNull();
    expect(screen.getByTestId('playlist-filter-count')).toHaveTextContent('1');
    fireEvent.change(screen.getByTestId('playlist-filter-input'), { target: { value: 'нет такого' } });
    expect(screen.getByTestId('playlist-filter-empty')).toBeInTheDocument();
  });

  it('сортировка прячет стрелки, а «сохранить порядок» пишет его в плейлист', async () => {
    await seed([A, B, C]);
    render(<PlaylistView playlistId="pl_3" />);
    expect(screen.getByTestId('reorder-up-1')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('playlist-sort-select'), { target: { value: 'title' } });
    expect(screen.queryByTestId('reorder-up-1')).toBeNull();
    fireEvent.click(screen.getByTestId('playlist-keep-order-btn'));
    await waitFor(async () =>
      expect((await dbService.getPlaylistById('pl_3'))?.tracks.map((x) => x.id)).toEqual(['b', 'c', 'a'])
    );
  });

  it('«Слушать» играет отсортированный вид', async () => {
    await seed([A, B, C]);
    const play = vi.spyOn(usePlayerStore.getState(), 'playTrack').mockResolvedValue();
    render(<PlaylistView playlistId="pl_3" />);
    fireEvent.change(screen.getByTestId('playlist-sort-select'), { target: { value: 'artist' } });
    fireEvent.click(screen.getByTestId('playlist-play-all-btn'));
    expect(play).toHaveBeenCalledWith(B, [B, A, C], 0);
  });

  it('кнопка «Убрать повторы» появляется только при повторах', async () => {
    await seed([A, B, A]);
    render(<PlaylistView playlistId="pl_3" />);
    const btn = screen.getByTestId('playlist-dedupe-btn');
    expect(btn).toHaveTextContent('(1)');
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByTestId('playlist-dedupe-btn')).toBeNull());
    expect(useLibraryStore.getState().playlists[0].tracks).toHaveLength(2);
  });
});

import { QueueDrawer } from '../../src/components/player/QueueDrawer';
import { useUIStore } from '../../src/store/useUIStore';

describe('3.0: очередь сохраняется плейлистом', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetLibraryStore();
    resetPlayerStore();
    resetUIStore();
    resetAuthStore();
    signInForTests();
  });

  it('играющий, «далее» и остаток списка — в новый плейлист по порядку', async () => {
    usePlayerStore.setState({
      currentTrack: A,
      userQueue: [C],
      sourceQueue: [A, B],
      currentIndex: 0
    });
    useUIStore.setState({ isQueueOpen: true });
    render(<QueueDrawer />);
    fireEvent.click(screen.getByTestId('queue-save-playlist-btn'));
    await waitFor(() => expect(useLibraryStore.getState().playlists).toHaveLength(1));
    const saved = useLibraryStore.getState().playlists[0];
    expect(saved.title).toMatch(/^Очередь · /);
    expect(saved.tracks.map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(useUIStore.getState().toastMessage?.type).toBe('success');
  });
});
