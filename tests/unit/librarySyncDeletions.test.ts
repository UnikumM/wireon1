/**
 * Удаление должно переживать синхронизацию.
 *
 * Жалоба владельца 2026-09-02: «не могу удалить ничего из плейлиста, из
 * любимых треков — при перезаходе во вкладку трек снова там». Проверки на этот
 * счёт были, но все они звали движок напрямую (`engine.deleteFavorite`), а
 * приложение зовёт медиатеку (`useLibraryStore.toggleFavorite`) — и та писала
 * прямо в местную базу, минуя движок. Надгробие не ставилось, сервер продолжал
 * отдавать запись, и следующая же сверка возвращала её обратно.
 *
 * Поэтому здесь проверяется путь целиком: действие медиатеки → движок →
 * удалённая сторона → следующая сверка. Поддельный сервер повторяет правила
 * настоящего (`server/wireon_music/sync.py`): надгробие с датой, победа более
 * поздней отметки, «строго новее» при равных датах.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { cloudSyncEngine } from '../../src/services/cloudSync';
import { NullRemoteAdapter } from '../../src/services/cloudSync';
import * as dbService from '../../src/services/db';
import { clearAllData, db } from '../../src/services/db';
import { Playlist, UnifiedTrack } from '../../src/types/music';
import { RemoteDeletions, RemoteSyncAdapter } from '../../src/types/auth';
import { resetAuthStore, signInForTests } from '../helpers/testUtils';

interface Row {
  updatedAt: number;
  deleted: boolean;
  payload: Playlist | UnifiedTrack | null;
}

/**
 * Сервер синхронизации в памяти, с теми же правилами, что у настоящего.
 *
 * Именно поддельный сервер, а не набор `vi.fn()`: беда, ради которой написан
 * этот файл, живёт не в одном вызове, а в порядке — «стёрли местно, отправили
 * местное целиком, приняли чужое обратно». Заглушка, отвечающая `true`, такое
 * пропускает; хранилище с надгробиями — нет.
 */
class FakeSyncServer implements RemoteSyncAdapter {
  public readonly id = 'fake';
  public playlists = new Map<string, Row>();
  public favorites = new Map<string, Row>();
  /** Сколько раз спросили картину мира. Для проверок про лишние походы. */
  public pulls = 0;

  constructor(private clock: () => number = Date.now) {}

  public isConfigured(): boolean {
    return true;
  }

  private stampOf(record: Playlist | UnifiedTrack): number {
    const any = record as { updatedAt?: number; addedAt?: number; createdAt?: number };
    return any.updatedAt || any.addedAt || any.createdAt || this.clock();
  }

  private put(table: Map<string, Row>, records: Array<Playlist | UnifiedTrack>): number {
    let stored = 0;
    for (const record of records) {
      const known = table.get(record.id);
      const stamp = this.stampOf(record);
      // Правило сервера: строго новее. Надгробие тем самым переживает
      // повторную отправку той же записи.
      if (known && stamp <= known.updatedAt) continue;
      table.set(record.id, { updatedAt: stamp, deleted: false, payload: record });
      stored++;
    }
    return stored;
  }

  private tombstone(table: Map<string, Row>, id: string): boolean {
    table.set(id, { updatedAt: this.clock(), deleted: true, payload: null });
    return true;
  }

  private alive<T>(table: Map<string, Row>): T[] {
    return Array.from(table.values())
      .filter((row) => !row.deleted && row.payload)
      .map((row) => row.payload as T);
  }

  public async pushPlaylists(playlists: Playlist[]): Promise<number> {
    return this.put(this.playlists, playlists);
  }

  public async pushFavorites(tracks: UnifiedTrack[]): Promise<number> {
    return this.put(this.favorites, tracks);
  }

  public async pullPlaylists(): Promise<Playlist[]> {
    this.pulls++;
    return this.alive<Playlist>(this.playlists);
  }

  public async pullFavorites(): Promise<UnifiedTrack[]> {
    return this.alive<UnifiedTrack>(this.favorites);
  }

  public async pullDeletions(): Promise<RemoteDeletions> {
    const dead = (table: Map<string, Row>) =>
      Array.from(table.entries()).filter(([, row]) => row.deleted);
    const ids = (table: Map<string, Row>) => dead(table).map(([id]) => id);
    const stamps = (table: Map<string, Row>) =>
      Object.fromEntries(dead(table).map(([id, row]) => [id, row.updatedAt]));
    return {
      playlists: ids(this.playlists),
      favorites: ids(this.favorites),
      deletedAt: { playlists: stamps(this.playlists), favorites: stamps(this.favorites) }
    };
  }

  public async deletePlaylist(playlistId: string): Promise<boolean> {
    return this.tombstone(this.playlists, playlistId);
  }

  public async deleteFavorite(trackId: string): Promise<boolean> {
    return this.tombstone(this.favorites, trackId);
  }
}

const track = (id: string, title: string): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title,
  artist: 'Тестовый исполнитель',
  duration: 200,
  artworkUrl: 'https://example.com/a.png',
  addedAt: 1_700_000_000_000
});

const library = () => useLibraryStore.getState();

/**
 * Пауза между действиями человека.
 *
 * Сервер принимает запись, только если она **строго новее** лежащей: при
 * равных отметках побеждает то, что уже там, иначе два устройства с
 * одинаковой датой переписывали бы друг друга по кругу. Шаги, уложенные в одну
 * миллисекунду, дают эту ничью — а между «убрал» и «вернул» у человека
 * проходят секунды. Настоящая пауза, а не подмена часов: `Date` подменяется в
 * этом окружении не полностью, и проверка молча теряла бы смысл.
 */
const moment = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('Удаления в медиатеке доезжают до сервера', () => {
  let server: FakeSyncServer;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearAllData();
    useLibraryStore.setState({
      favorites: [],
      playlists: [],
      history: [],
      isLoading: false,
      error: null
    });
    signInForTests();

    server = new FakeSyncServer();
    cloudSyncEngine.setRemoteAdapter(server);
    cloudSyncEngine.setOnlineStatus(true);
    await cloudSyncEngine.clearParkedMutations();
    cloudSyncEngine.pendingLocalMutations = [];
  });

  afterEach(async () => {
    cloudSyncEngine.stopPeriodicSync();
    cloudSyncEngine.setRemoteAdapter(new NullRemoteAdapter());
    resetAuthStore();
    if (!db.isOpen()) await db.open();
    await clearAllData();
  });

  it('снятое сердечко не возвращается следующей сверкой', async () => {
    const song = track('yt_fav_1', 'Песня, которую убрали');

    expect(await library().toggleFavorite(song)).toBe(true);
    await cloudSyncEngine.syncAll();
    expect(server.favorites.get(song.id)?.deleted).toBe(false);

    // Снимаем сердечко — так, как это делает любая кнопка в приложении.
    expect(await library().toggleFavorite(song)).toBe(true);
    expect(library().favorites).toHaveLength(0);

    await cloudSyncEngine.syncAll();

    expect(server.favorites.get(song.id)?.deleted).toBe(true);
    expect(await dbService.isFavorite(song.id)).toBe(false);
    await library().loadInitialData();
    expect(library().favorites.map((t) => t.id)).not.toContain(song.id);
  });

  it('удалённый плейлист не возвращается следующей сверкой', async () => {
    const created = await library().createPlaylist('Плейлист на удаление');
    expect(created).not.toBeNull();
    await cloudSyncEngine.syncAll();
    expect(server.playlists.has(created!.id)).toBe(true);

    expect(await library().deletePlaylist(created!.id)).toBe(true);
    await cloudSyncEngine.syncAll();

    expect(server.playlists.get(created!.id)?.deleted).toBe(true);
    await library().loadInitialData();
    expect(library().playlists.map((p) => p.id)).not.toContain(created!.id);
  });

  it('удаление доезжает и тогда, когда сервер в этот момент недоступен', async () => {
    const song = track('yt_fav_2', 'Песня, убранная без сети');
    expect(await library().toggleFavorite(song)).toBe(true);
    await cloudSyncEngine.syncAll();

    const refuse = vi
      .spyOn(server, 'deleteFavorite')
      .mockRejectedValueOnce(new Error('WIREON_SYNC_UNREACHABLE'));

    expect(await library().toggleFavorite(song)).toBe(true);
    await cloudSyncEngine.syncAll();
    // Отказ отправки не повод забыть про удаление: оно ждёт своей очереди.
    expect(refuse).toHaveBeenCalled();

    await cloudSyncEngine.syncAll();
    expect(server.favorites.get(song.id)?.deleted).toBe(true);
    expect(await dbService.isFavorite(song.id)).toBe(false);
  });

  it('удаление, не доехавшее до сервера, не возвращается на экран', async () => {
    const song = track('yt_fav_3', 'Песня, пережившая обрыв');
    expect(await library().toggleFavorite(song)).toBe(true);
    await cloudSyncEngine.syncAll();

    vi.spyOn(server, 'deleteFavorite').mockRejectedValue(new Error('WIREON_SYNC_UNREACHABLE'));

    expect(await library().toggleFavorite(song)).toBe(true);
    await cloudSyncEngine.syncAll();

    // Сервер по-прежнему считает запись живой — и присылает её обратно. Пока
    // наше удаление не подтверждено, местная сторона главнее: человек стёр
    // запись здесь, и видеть её снова он не должен.
    expect(await dbService.isFavorite(song.id)).toBe(false);
    await library().loadInitialData();
    expect(library().favorites.map((t) => t.id)).not.toContain(song.id);
  });

  it('вернуть сердечко на место можно, и оно остаётся', async () => {
    // Треку год: столько он и пролежал в избранном, пока его не убрали. Объект
    // с этой отметкой живёт дальше — в очереди, в результатах поиска, в плеере,
    // — и именно его получает кнопка при повторном нажатии.
    const song = track('yt_fav_again', 'Песня, возвращённая обратно');

    expect(await library().toggleFavorite(song)).toBe(true);
    await cloudSyncEngine.syncAll();

    await moment();
    expect(await library().toggleFavorite(song)).toBe(true);
    await cloudSyncEngine.syncAll();
    expect(server.favorites.get(song.id)?.deleted).toBe(true);

    // Передумали. Надгробие свежее самого трека, и без новой отметки сервер
    // отказался бы принять возврат — а следующая сверка стёрла бы его снова.
    await moment();
    expect(await library().toggleFavorite(song)).toBe(true);
    await cloudSyncEngine.syncAll();

    expect(server.favorites.get(song.id)?.deleted).toBe(false);
    await cloudSyncEngine.syncAll();
    expect(await dbService.isFavorite(song.id)).toBe(true);
    await library().loadInitialData();
    expect(library().favorites.map((t) => t.id)).toContain(song.id);
  });

  it('удаление не сдаётся после долгого отказа сервера', async () => {
    const song = track('yt_fav_4', 'Песня, пережившая долгий обрыв');
    expect(await library().toggleFavorite(song)).toBe(true);
    await cloudSyncEngine.syncAll();

    const refuse = vi
      .spyOn(server, 'deleteFavorite')
      .mockRejectedValue(new Error('WIREON_SYNC_UNREACHABLE'));
    expect(await library().toggleFavorite(song)).toBe(true);

    // Столько попыток, что обычная правка давно была бы отложена насовсем.
    for (let attempt = 0; attempt < 8; attempt++) {
      cloudSyncEngine.pendingLocalMutations = cloudSyncEngine.pendingLocalMutations.map((m) => ({
        ...m,
        nextAttemptAt: undefined
      }));
      await cloudSyncEngine.syncPending();
    }
    expect(cloudSyncEngine.parkedMutations).toHaveLength(0);
    expect(cloudSyncEngine.pendingLocalMutations).toHaveLength(1);

    refuse.mockRestore();
    cloudSyncEngine.pendingLocalMutations = cloudSyncEngine.pendingLocalMutations.map((m) => ({
      ...m,
      nextAttemptAt: undefined
    }));
    await cloudSyncEngine.syncAll();
    expect(server.favorites.get(song.id)?.deleted).toBe(true);
  });

  it('убранный из плейлиста трек не приезжает обратно', async () => {
    const created = await library().createPlaylist('Плейлист с треком');
    const song = track('yt_pl_1', 'Трек в плейлисте');
    expect(await library().addTrackToPlaylist(created!.id, song)).toBe(true);
    await cloudSyncEngine.syncAll();
    expect((server.playlists.get(created!.id)?.payload as Playlist).tracks).toHaveLength(1);

    expect(await library().removeTrackFromPlaylist(created!.id, 0)).toBe(true);
    await cloudSyncEngine.syncAll();

    expect((server.playlists.get(created!.id)?.payload as Playlist).tracks).toHaveLength(0);
    await library().loadInitialData();
    expect(library().playlists.find((p) => p.id === created!.id)?.tracks).toHaveLength(0);
  });
});
