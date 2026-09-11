/**
 * Массовые действия над треками плейлиста на телефоне.
 *
 * Здесь охраняются две вещи, каждая из которых ломается незаметно:
 *
 * 1. **Удаление идёт с конца.** Удаление сдвигает всё, что после него; при
 *    проходе сверху вниз второй же номер указывал бы уже не на тот трек, и из
 *    плейлиста пропадало бы не то, что отметили.
 * 2. **Отчёт по удачам, а не по длине списка.** Пополнение плейлиста отказывает
 *    без аккаунта, и подсчёт по длине выдавал бы «перенесено пять треков» ровно
 *    там, где не перенёсся ни один.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '../setup';
import { MobilePlaylistView } from '../../src/components/mobile/MobilePlaylistView';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { Playlist, UnifiedTrack } from '../../src/types/music';

function track(id: string): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id,
    title: `Песня ${id}`,
    artist: 'Кто-то',
    duration: 200,
    artworkUrl: ''
  };
}

function playlist(id: string, title: string, tracks: UnifiedTrack[]): Playlist {
  return { id, title, tracks, createdAt: 1, updatedAt: 1, isSynced: false };
}

const source = playlist('pl_a', 'Вечерний', ['1', '2', '3', '4'].map(track));
const target = playlist('pl_b', 'Дорога', []);

/** Входит в режим выбора и отмечает названные треки. */
async function selectTracks(ids: string[]): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('mobile-playlist-menu'));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('mobile-playlist-select-mode'));
  });
  for (const id of ids) {
    await act(async () => {
      fireEvent.click(screen.getByTestId(`mobile-playlist-track-${id}-play`));
    });
  }
}

describe('выбор треков на телефоне', () => {
  let removeTrackFromPlaylist: ReturnType<typeof vi.fn>;
  let addTrackToPlaylist: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    removeTrackFromPlaylist = vi.fn().mockResolvedValue(true);
    addTrackToPlaylist = vi.fn().mockResolvedValue(true);

    useLibraryStore.setState({
      playlists: [source, target],
      removeTrackFromPlaylist,
      addTrackToPlaylist
    } as never);
    useUIStore.setState({ activePlaylistId: 'pl_a', accountPrompt: null, toastMessage: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('пока не выбирают, нажатие на строку играет', async () => {
    render(<MobilePlaylistView />);

    expect(screen.queryByTestId('mobile-playlist-selection-bar')).toBeNull();
    expect(screen.getByTestId('mobile-playlist-play')).toBeTruthy();
  });

  it('отмеченное видно и считается', async () => {
    render(<MobilePlaylistView />);
    await selectTracks(['2', '4']);

    expect(screen.getByTestId('mobile-playlist-selection-count').textContent).toBe('Выбрано 2 из 4');
    expect(screen.getByTestId('mobile-playlist-track-2-play').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('mobile-playlist-track-1-play').getAttribute('aria-pressed')).toBe('false');
  });

  it('снятие последней отметки не выкидывает из режима', async () => {
    render(<MobilePlaylistView />);
    await selectTracks(['2']);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-playlist-track-2-play'));
    });

    // Пустой выбор — законное состояние внутри режима, а не выход из него.
    expect(screen.getByTestId('mobile-playlist-selection-count').textContent).toBe('Выберите треки');
  });

  it('убирает отмеченное с конца, а не сверху вниз', async () => {
    render(<MobilePlaylistView />);
    await selectTracks(['2', '3']);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-playlist-selection-remove'));
    });

    await waitFor(() => expect(removeTrackFromPlaylist).toHaveBeenCalledTimes(2));
    // Номера 1 и 2 (нумерация с нуля), и именно в таком порядке: сначала
    // дальний. Обратный порядок стёр бы «Песня 4» вместо «Песня 3».
    expect(removeTrackFromPlaylist.mock.calls.map((call) => call[1])).toEqual([2, 1]);
  });

  it('перенос отчитывается по удачам, а не по длине списка', async () => {
    // Пополнять плейлисты нельзя — стор отвечает отказом на каждый трек.
    addTrackToPlaylist.mockResolvedValue(false);
    render(<MobilePlaylistView />);
    await selectTracks(['1', '2']);

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-playlist-selection-move'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-playlist-move-pl_b'));
    });

    await waitFor(() => expect(addTrackToPlaylist).toHaveBeenCalledTimes(2));
    expect(useUIStore.getState().toastMessage?.type).toBe('error');
    expect(useUIStore.getState().toastMessage?.text).not.toContain('2');
  });

  it('удачный перенос называет настоящее число', async () => {
    render(<MobilePlaylistView />);
    await selectTracks(['1', '2']);

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-playlist-selection-move'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-playlist-move-pl_b'));
    });

    await waitFor(() => {
      expect(useUIStore.getState().toastMessage?.text).toBe('2 трека в «Дорога»');
    });
  });
});
