import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../setup';
import { LibraryView } from '../../src/components/library/LibraryView';
import { MobileLibraryView } from '../../src/components/mobile/MobileLibraryView';
import { useFolderStore } from '../../src/store/useFolderStore';
import { usePinnedStore } from '../../src/store/usePinnedStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import * as dbService from '../../src/services/db';
import { resetLibraryStore, resetUIStore } from '../helpers/testUtils';
import type { Playlist } from '../../src/types/music';

const pl = (id: string, title: string): Playlist => ({
  id,
  title,
  tracks: [],
  createdAt: 1,
  updatedAt: 1,
  isSynced: false
});

const PLAYLISTS = [pl('p1', 'Утро'), pl('p2', 'Вечер'), pl('p3', 'Бег'), pl('p4', 'Без папки')];

function seedFolders() {
  useFolderStore.setState({
    hydrated: true,
    folders: [
      { id: 'f_day', title: 'День', playlistIds: ['p1', 'p2'] },
      { id: 'f_sport', title: 'Спорт', playlistIds: ['p3'] }
    ]
  });
}

describe('4.0: папки плейлистов в медиатеке', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetLibraryStore();
    resetUIStore();
    usePinnedStore.setState({ pinnedIds: [], hydrated: true });
    useFolderStore.setState({ folders: [], hydrated: true });
    useLibraryStore.setState({ playlists: PLAYLISTS });
    useUIStore.setState({ activeView: 'playlists' });
  });

  it('ряд папок виден, клик открывает папку, «Все плейлисты» возвращает', () => {
    seedFolders();
    render(<LibraryView />);

    const shelf = screen.getByTestId('folder-shelf');
    expect(within(shelf).getByTestId('folder-card-f_day')).toBeInTheDocument();
    expect(within(shelf).getByTestId('folder-card-f_sport')).toBeInTheDocument();
    // Под папками — «Остальные»: только тот, что ни в одной папке.
    expect(screen.getByTestId('playlists-loose-heading')).toBeInTheDocument();
    expect(screen.getByTestId('playlist-card-p4')).toBeInTheDocument();
    expect(screen.queryByTestId('playlist-card-p1')).toBeNull();

    fireEvent.click(screen.getByTestId('folder-card-f_day'));
    expect(screen.queryByTestId('folder-shelf')).toBeNull();
    expect(screen.getByTestId('folder-title')).toHaveTextContent('День');
    expect(screen.getByTestId('playlist-card-p1')).toBeInTheDocument();
    expect(screen.getByTestId('playlist-card-p2')).toBeInTheDocument();
    expect(screen.queryByTestId('playlist-card-p3')).toBeNull();
    expect(screen.queryByTestId('playlist-card-p4')).toBeNull();
    expect(screen.queryByTestId('playlists-loose-heading')).toBeNull();

    fireEvent.click(screen.getByTestId('folder-back-btn'));
    expect(screen.getByTestId('folder-shelf')).toBeInTheDocument();
    expect(screen.getByTestId('playlist-card-p4')).toBeInTheDocument();
  });

  it('без папок нет ни ряда, ни «Остальных», ни меню «В папку…»', () => {
    render(<LibraryView />);
    expect(screen.queryByTestId('folder-shelf')).toBeNull();
    expect(screen.queryByTestId('playlists-loose-heading')).toBeNull();
    expect(screen.queryByTestId('playlist-folder-btn-p1')).toBeNull();
    // Плейлистов четыре — кнопка «Новая папка» есть.
    expect(screen.getByTestId('library-create-folder-btn')).toBeInTheDocument();
  });

  it('«Новая папка» создаёт папку через окно с именем', () => {
    render(<LibraryView />);
    fireEvent.click(screen.getByTestId('library-create-folder-btn'));
    fireEvent.change(screen.getByTestId('folder-name-input'), { target: { value: 'Ночь' } });
    fireEvent.click(screen.getByTestId('folder-name-submit'));
    const folders = useFolderStore.getState().folders;
    expect(folders).toHaveLength(1);
    expect(folders[0].title).toBe('Ночь');
    expect(screen.getByTestId(`folder-card-${folders[0].id}`)).toBeInTheDocument();
  });

  it('меню «…» на карточке переносит плейлист в папку и обратно', () => {
    seedFolders();
    render(<LibraryView />);
    fireEvent.click(screen.getByTestId('playlist-folder-btn-p4'));
    const menu = screen.getByTestId('playlist-folder-menu-p4');
    fireEvent.click(within(menu).getByTestId('playlist-folder-option-f_sport'));
    expect(useFolderStore.getState().folders[1].playlistIds).toEqual(['p3', 'p4']);
    // p4 ушёл из «Остальных» — заголовок пропал вместе с последним плейлистом.
    expect(screen.queryByTestId('playlist-card-p4')).toBeNull();
    expect(screen.queryByTestId('playlists-loose-heading')).toBeNull();

    fireEvent.click(screen.getByTestId('folder-card-f_sport'));
    fireEvent.click(screen.getByTestId('playlist-folder-btn-p4'));
    fireEvent.click(screen.getByTestId('playlist-folder-option-none'));
    expect(useFolderStore.getState().folders[1].playlistIds).toEqual(['p3']);
  });

  it('переименование и удаление папки из её шапки', () => {
    seedFolders();
    render(<LibraryView />);
    fireEvent.click(screen.getByTestId('folder-card-f_sport'));

    fireEvent.click(screen.getByTestId('folder-rename-btn'));
    const input = screen.getByTestId('folder-name-input') as HTMLInputElement;
    expect(input.value).toBe('Спорт');
    fireEvent.change(input, { target: { value: 'Бег и зал' } });
    fireEvent.click(screen.getByTestId('folder-name-submit'));
    expect(screen.getByTestId('folder-title')).toHaveTextContent('Бег и зал');

    fireEvent.click(screen.getByTestId('folder-delete-btn'));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(useFolderStore.getState().folders.map((f) => f.id)).toEqual(['f_day']);
    // Папки нет — открытая закрылась, p3 остался в медиатеке и вернулся в «Остальные».
    expect(screen.getByTestId('folder-shelf')).toBeInTheDocument();
    expect(screen.getByTestId('playlist-card-p3')).toBeInTheDocument();
    expect(useLibraryStore.getState().playlists).toHaveLength(4);
  });

  it('поиск показывает плоский список поверх папок', () => {
    seedFolders();
    render(<LibraryView />);
    fireEvent.change(screen.getByLabelText('Поиск по плейлистам'), { target: { value: 'утро' } });
    expect(screen.queryByTestId('folder-shelf')).toBeNull();
    expect(screen.getByTestId('playlist-card-p1')).toBeInTheDocument();
  });

  it('телефон: та же полка, открытие папки и лист «В папку…»', () => {
    seedFolders();
    render(<MobileLibraryView />);
    const shelf = screen.getByTestId('folder-shelf');
    expect(shelf).toHaveClass('folder-shelf-compact');
    expect(screen.getByTestId('mobile-library-playlist-p4')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-library-playlist-p1')).toBeNull();

    fireEvent.click(within(shelf).getByTestId('folder-card-f_day'));
    expect(screen.getByTestId('folder-title')).toHaveTextContent('День');
    expect(screen.getByTestId('mobile-library-playlist-p1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('folder-back-btn'));

    fireEvent.click(screen.getByTestId('mobile-playlist-folder-btn-p4'));
    fireEvent.click(screen.getByTestId('mobile-folder-pick-f_day'));
    expect(useFolderStore.getState().folders[0].playlistIds).toEqual(['p1', 'p2', 'p4']);
    expect(screen.queryByTestId('mobile-library-playlist-p4')).toBeNull();
  });
});
