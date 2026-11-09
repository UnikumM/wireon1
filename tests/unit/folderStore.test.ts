import { describe, it, expect, beforeEach } from 'vitest';
import '../setup';
import {
  useFolderStore,
  PLAYLIST_FOLDERS_KEY,
  flushFolderWrites,
  groupByFolders,
  folderOfPlaylist,
  sanitizeFolders,
  type PlaylistFolder
} from '../../src/store/useFolderStore';
import * as dbService from '../../src/services/db';

function reset() {
  useFolderStore.setState({ folders: [], hydrated: false });
}

describe('4.0: папки плейлистов — стор', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    reset();
  });

  it('создание возвращает id, пустое имя — ничего не создаёт', () => {
    const id = useFolderStore.getState().createFolder('  Дорога  ');
    expect(id).toBeTruthy();
    expect(useFolderStore.getState().folders).toEqual([{ id, title: 'Дорога', playlistIds: [] }]);
    expect(useFolderStore.getState().createFolder('   ')).toBeNull();
    expect(useFolderStore.getState().folders).toHaveLength(1);
  });

  it('плейлист лежит не больше чем в одной папке', () => {
    const a = useFolderStore.getState().createFolder('A')!;
    const b = useFolderStore.getState().createFolder('B')!;
    const { moveToFolder } = useFolderStore.getState();
    moveToFolder('p1', a);
    moveToFolder('p2', a);
    moveToFolder('p1', b);
    const folders = useFolderStore.getState().folders;
    expect(folders.find((f) => f.id === a)!.playlistIds).toEqual(['p2']);
    expect(folders.find((f) => f.id === b)!.playlistIds).toEqual(['p1']);
    expect(folderOfPlaylist(folders, 'p1')?.id).toBe(b);

    moveToFolder('p1', null);
    expect(folderOfPlaylist(useFolderStore.getState().folders, 'p1')).toBeNull();
  });

  it('переименование и порядок внутри папки', () => {
    const a = useFolderStore.getState().createFolder('A')!;
    const { moveToFolder, renameFolder, reorder } = useFolderStore.getState();
    moveToFolder('p1', a);
    moveToFolder('p2', a);
    moveToFolder('p3', a);
    renameFolder(a, 'Вечер');
    // Чужой id не попадает, забытый свой — дописывается в конец.
    reorder(a, ['p3', 'p1', 'чужой']);
    const folder = useFolderStore.getState().folders[0];
    expect(folder.title).toBe('Вечер');
    expect(folder.playlistIds).toEqual(['p3', 'p1', 'p2']);
  });

  it('удаление папки оставляет плейлисты в медиатеке', () => {
    const a = useFolderStore.getState().createFolder('A')!;
    useFolderStore.getState().moveToFolder('p1', a);
    useFolderStore.getState().deleteFolder(a);
    expect(useFolderStore.getState().folders).toEqual([]);
    const grouped = groupByFolders([{ id: 'p1' }, { id: 'p2' }], []);
    expect(grouped.groups).toEqual([]);
    expect(grouped.loose.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('каждое изменение ложится в базу под ключом playlistFolders и читается при hydrate', async () => {
    const a = useFolderStore.getState().createFolder('A')!;
    useFolderStore.getState().moveToFolder('p1', a);
    useFolderStore.getState().renameFolder(a, 'A2');
    await flushFolderWrites();

    const saved = await dbService.getSetting<PlaylistFolder[]>(PLAYLIST_FOLDERS_KEY, []);
    expect(saved).toEqual([{ id: a, title: 'A2', playlistIds: ['p1'] }]);

    reset();
    await useFolderStore.getState().hydrate();
    expect(useFolderStore.getState().folders).toEqual(saved);
    expect(useFolderStore.getState().hydrated).toBe(true);
  });

  it('hydrate не теряет созданное до чтения базы и терпит мусор в настройке', async () => {
    await dbService.setSetting(PLAYLIST_FOLDERS_KEY, [
      { id: 'f_db', title: 'Из базы', playlistIds: ['x', 7, 'x', 'y'] },
      'мусор',
      { id: 'f_dup', title: 'Дубль', playlistIds: ['y'] }
    ]);
    const local = useFolderStore.getState().createFolder('Локальная')!;
    await useFolderStore.getState().hydrate();
    const folders = useFolderStore.getState().folders;
    expect(folders.map((f) => f.id)).toEqual([local, 'f_db', 'f_dup']);
    // Плейлист «y» был в двух папках — остался в первой.
    expect(folders[1].playlistIds).toEqual(['x', 'y']);
    expect(folders[2].playlistIds).toEqual([]);
    expect(sanitizeFolders(null)).toEqual([]);
  });

  it('groupByFolders сверяет папки с живой медиатекой', () => {
    const folders: PlaylistFolder[] = [{ id: 'f', title: 'F', playlistIds: ['удалён', 'p2', 'p1'] }];
    const grouped = groupByFolders([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], folders);
    expect(grouped.groups[0].playlists.map((p) => p.id)).toEqual(['p2', 'p1']);
    expect(grouped.loose.map((p) => p.id)).toEqual(['p3']);
  });
});
