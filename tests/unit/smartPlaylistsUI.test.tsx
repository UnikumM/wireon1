import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '../setup';
import { SmartPlaylistsShelf } from '../../src/components/smart/SmartPlaylistsShelf';
import { SmartPlaylistView } from '../../src/components/smart/SmartPlaylistView';
import { useSmartPlaylistStore } from '../../src/store/useSmartPlaylistStore';
import { useUIStore } from '../../src/store/useUIStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import * as dbService from '../../src/services/db';
import { resetLibraryStore, resetUIStore, resetAuthStore, signInForTests, resetPlayerStore } from '../helpers/testUtils';
import { UnifiedTrack } from '../../src/types/music';

const t = (n: number, duration = 200): UnifiedTrack => ({
  id: `yt_smart_${n}`,
  source: 'youtube',
  originalId: String(n),
  title: `Smart ${n}`,
  artist: `Artist ${n}`,
  duration,
  artworkUrl: '',
  addedAt: Date.now() - n * 1000
});

describe('3.0: умные плейлисты — интерфейс', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetLibraryStore();
    resetUIStore();
    resetPlayerStore();
    resetAuthStore();
    signInForTests();
    useSmartPlaylistStore.setState({ playlists: [], hydrated: false });
    useLibraryStore.setState({ favorites: [t(1, 100), t(2, 400), t(3, 150)] });
  });

  it('создаёт из заготовки и открывает', async () => {
    render(<SmartPlaylistsShelf />);
    expect(await screen.findByTestId('smart-shelf-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('smart-create-btn'));
    fireEvent.click(await screen.findByTestId('smart-preset-3')); // «Короткие — до трёх минут»
    await waitFor(() => expect(screen.getByTestId('smart-preview-count')).toHaveTextContent('2 трека'));
    fireEvent.click(screen.getByTestId('smart-save'));
    const created = useSmartPlaylistStore.getState().playlists[0];
    expect(created.title).toBe('Короткие — до трёх минут');
    expect(useUIStore.getState().activeView).toBe('smart');
    expect(useUIStore.getState().activeSmartPlaylistId).toBe(created.id);
  });

  it('правила меняют живой счётчик', async () => {
    render(<SmartPlaylistsShelf />);
    fireEvent.click(screen.getByTestId('smart-create-btn'));
    // По умолчанию: «в избранном — да» → все три.
    await waitFor(() => expect(screen.getByTestId('smart-preview-count')).toHaveTextContent('3 трека'));
    fireEvent.click(screen.getByTestId('smart-add-rule'));
    fireEvent.change(screen.getByTestId('smart-rule-field-1'), { target: { value: 'duration' } });
    fireEvent.change(screen.getByTestId('smart-rule-op-1'), { target: { value: 'gte' } });
    fireEvent.change(screen.getByTestId('smart-rule-value-1'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByTestId('smart-preview-count')).toHaveTextContent('1 трек'));
    fireEvent.change(screen.getByTestId('smart-match-select'), { target: { value: 'any' } });
    await waitFor(() => expect(screen.getByTestId('smart-preview-count')).toHaveTextContent('3 трека'));
  });

  it('экран показывает состав и сохраняет копию обычным плейлистом', async () => {
    const created = useSmartPlaylistStore.getState().create({
      title: 'Длинные',
      match: 'all',
      rules: [{ field: 'duration', op: 'gte', value: 3 }],
      sort: 'title',
      limit: 0
    });
    act(() => useUIStore.getState().openSmartPlaylist(created.id));
    render(<SmartPlaylistView />);
    expect(await screen.findByTestId('smart-title')).toHaveTextContent('Длинные');
    await waitFor(() => expect(screen.getByTestId('smart-track-list').children).toHaveLength(1));
    fireEvent.click(screen.getByTestId('smart-save-copy'));
    await waitFor(() => expect(useLibraryStore.getState().playlists).toHaveLength(1));
    expect(useLibraryStore.getState().playlists[0].tracks.map((x) => x.id)).toEqual(['yt_smart_2']);
  });

  it('удаление возвращает к плейлистам', async () => {
    const created = useSmartPlaylistStore.getState().create({ title: 'X', match: 'all', rules: [], sort: 'title', limit: 0 });
    act(() => useUIStore.getState().openSmartPlaylist(created.id));
    render(<SmartPlaylistView />);
    fireEvent.click(await screen.findByTestId('smart-delete'));
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить' }));
    expect(useSmartPlaylistStore.getState().playlists).toHaveLength(0);
    expect(useUIStore.getState().activeView).toBe('playlists');
  });
});
