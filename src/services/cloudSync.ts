/**
 * Local-first sync engine for Wireon.
 *
 * Every mutation is committed to the local IndexedDB (Dexie) immediately — that is
 * the source of truth. A remote is optional and reached through a pluggable
 * `RemoteSyncAdapter`; the shipped default is `NullRemoteAdapter`, so
 * `isRemoteConfigured()` is false and nothing is ever uploaded. Conflicts between
 * an incoming record and the stored one are resolved Last-Write-Wins on
 * `updatedAt`, and queued remote pushes are retried with exponential backoff
 * until they are parked.
 */

import { Playlist, UnifiedTrack } from '../types/music';
import {
  CloudSyncConfig,
  CloudSyncResult,
  RemoteDeletions,
  RemoteSyncAdapter,
  SyncMutation,
  SyncStatus
} from '../types/auth';
import * as dbService from './db';

export const PENDING_MUTATIONS_SETTING = 'pending_sync_mutations';
export const PARKED_MUTATIONS_SETTING = 'parked_sync_mutations';

export interface SyncCommitResult<T> {
  /** The record was committed to the local database. */
  success: boolean;
  /** The record as it is now stored locally (after conflict resolution). */
  resolved: T;
  /** A newer stored record won over the incoming one. */
  isConflict?: boolean;
  /** True only when a configured remote confirmed the write. */
  remoteAccepted: boolean;
  /** The write is queued for a configured remote that could not be reached. */
  queuedForRemote?: boolean;
}

export interface SyncDeleteResult {
  success: boolean;
  remoteAccepted: boolean;
  queuedForRemote?: boolean;
}

/**
 * The default adapter: Wireon ships without a backend. It accepts nothing and
 * returns nothing, which keeps every "synced" counter honestly at zero.
 */
export class NullRemoteAdapter implements RemoteSyncAdapter {
  public readonly id = 'null';

  public isConfigured(): boolean {
    return false;
  }

  public async pushPlaylists(_playlists: Playlist[]): Promise<number> {
    return 0;
  }

  public async pullPlaylists(): Promise<Playlist[]> {
    return [];
  }

  public async pushFavorites(_tracks: UnifiedTrack[]): Promise<number> {
    return 0;
  }

  public async pullFavorites(): Promise<UnifiedTrack[]> {
    return [];
  }

  public async deletePlaylist(_playlistId: string): Promise<boolean> {
    return false;
  }

  public async deleteFavorite(_trackId: string): Promise<boolean> {
    return false;
  }
}

const LOCAL_ONLY_MESSAGE =
  'Сервер синхронизации не настроен, поэтому медиатека хранится только на этом устройстве. ' +
  'Для переносимой копии используйте «Настройки → Экспорт медиатеки».';

function isPlaylistPayload(data: SyncMutation['data']): data is Playlist {
  return !!data && Array.isArray((data as Playlist).tracks);
}

function isTrackPayload(data: SyncMutation['data']): data is UnifiedTrack {
  return !!data && typeof (data as UnifiedTrack).source === 'string';
}

export class LocalFirstSyncEngine {
  public syncStatus: SyncStatus = 'idle';
  public isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  public lastSyncedAt: number | null = null;
  /** Remote pushes waiting for a retry. Empty while no remote is configured. */
  public pendingLocalMutations: SyncMutation[] = [];
  /** Mutations that exhausted `maxRetries`. They are already stored locally. */
  public parkedMutations: SyncMutation[] = [];

  /** Кому сказать, что местная база пополнилась чужими правками. */
  private remoteChangeListeners: Set<() => void> = new Set();

  /** Начатые, но ещё не завершённые удаления. См. {@link rememberDeletion}. */
  private deletionsInFlight: Set<Promise<unknown>> = new Set();

  private remote: RemoteSyncAdapter;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private statusListeners: Array<(status: SyncStatus) => void> = [];
  private userId: string | null = null;
  private config: Required<Omit<CloudSyncConfig, 'endpoint'>> & Pick<CloudSyncConfig, 'endpoint'> = {
    autoSyncIntervalMs: 30000,
    enableAutoSync: true,
    maxRetries: 5,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 60000
  };

  constructor(config?: Partial<CloudSyncConfig>, adapter?: RemoteSyncAdapter) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    this.remote = adapter || new NullRemoteAdapter();

    this.initNetworkListeners();
    this.loadPersistedMutations().catch(() => {});
  }

  /**
   * Initializes browser online/offline event listeners
   */
  private initNetworkListeners() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.setOnlineStatus(true);
        this.syncPending().catch((err) => {
          console.warn('[SyncEngine] Retry of queued mutations on reconnect failed:', err);
        });
      });

      window.addEventListener('offline', () => {
        this.setOnlineStatus(false);
      });
    }
  }

  // --- Remote adapter -------------------------------------------------------

  /** Installs a real backend. Until then every push is a local-only commit. */
  public setRemoteAdapter(adapter: RemoteSyncAdapter): void {
    this.remote = adapter;
  }

  public getRemoteAdapter(): RemoteSyncAdapter {
    return this.remote;
  }

  /** False with the shipped configuration: there is no remote to sync with. */
  public isRemoteConfigured(): boolean {
    try {
      return this.remote.isConfigured();
    } catch {
      return false;
    }
  }

  // --- Status ---------------------------------------------------------------

  /**
   * Subscribes to sync status changes
   */
  public onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.push(listener);
    listener(this.syncStatus);
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Подписка на «с сервера приехало что-то новое».
   *
   * Отдельно от {@link onStatusChange}, и это не дублирование. Статус говорит,
   * **чем занят** движок, — он меняется на каждой сверке, в том числе когда
   * ничего не изменилось. Здесь же сообщается ровно о том, ради чего сверка
   * затевалась: местная база только что пополнилась чужими правками, и то, что
   * человек видит на экране, устарело.
   *
   * Почему это понадобилось. Сверка раз в минуту работала и писала в базу, но
   * `useLibraryStore` про эти записи не знал, и до перезапуска приложения
   * экран показывал прежнее. Снаружи это выглядело как «синхронизация не
   * работает, пока не нажмёшь Проверить» — хотя она работала, просто молча.
   */
  public onRemoteChange(listener: () => void): () => void {
    this.remoteChangeListeners.add(listener);
    return () => {
      this.remoteChangeListeners.delete(listener);
    };
  }

  private notifyRemoteChange(): void {
    for (const listener of this.remoteChangeListeners) {
      try {
        listener();
      } catch (err) {
        console.error('[SyncEngine] Remote change listener error:', err);
      }
    }
  }

  private notifyStatus(status: SyncStatus) {
    this.syncStatus = status;
    this.statusListeners.forEach((listener) => {
      try {
        listener(status);
      } catch (err) {
        console.error('[SyncEngine] Status listener error:', err);
      }
    });
  }

  /** Resting status: offline, `local-only` without a remote, `synced` with one. */
  private settleStatus(): void {
    if (!this.isOnline) {
      this.notifyStatus('offline');
      return;
    }
    this.notifyStatus(this.isRemoteConfigured() ? 'synced' : 'local-only');
  }

  /**
   * Sets online/offline status manually or from network events
   */
  public setOnlineStatus(online: boolean) {
    this.isOnline = online;
    if (!online) {
      this.notifyStatus('offline');
    } else if (this.syncStatus === 'offline') {
      this.settleStatus();
    }
  }

  /**
   * Sets the account the local change journal belongs to.
   *
   * Switching owner drops the pending upload queue: those writes were made under
   * a different account and must not be pushed as this one's. Nothing is lost —
   * the records themselves live in the local database; the queue is only about
   * uploading. With no remote configured the queue is always empty, so this is a
   * no-op in the shipped app.
   */
  public setUserId(userId: string | null) {
    const previous = this.userId;
    this.userId = userId;
    if (previous === userId || this.pendingLocalMutations.length === 0) return;

    this.pendingLocalMutations = [];
    void this.persistPendingMutations();
  }

  public getUserId(): string | null {
    return this.userId;
  }

  // --- Mutation queue -------------------------------------------------------

  private async loadPersistedMutations(): Promise<void> {
    try {
      const [pending, parked] = await Promise.all([
        dbService.getSetting<SyncMutation[]>(PENDING_MUTATIONS_SETTING, []),
        dbService.getSetting<SyncMutation[]>(PARKED_MUTATIONS_SETTING, [])
      ]);

      if (Array.isArray(pending) && pending.length > 0) {
        const existingIds = new Set(this.pendingLocalMutations.map((m) => m.id));
        this.pendingLocalMutations = [
          ...pending.filter((m) => !existingIds.has(m.id)),
          ...this.pendingLocalMutations
        ];
      }
      if (Array.isArray(parked) && parked.length > 0) {
        this.parkedMutations = [...parked, ...this.parkedMutations];
      }
    } catch {
      // A missing queue is not an error: nothing was pending.
    }
  }

  private async persistPendingMutations(): Promise<void> {
    try {
      await dbService.setSetting(PENDING_MUTATIONS_SETTING, this.pendingLocalMutations);
    } catch (err) {
      console.warn('[SyncEngine] Could not persist the pending mutation queue:', err);
    }
  }

  private async persistParkedMutations(): Promise<void> {
    try {
      await dbService.setSetting(PARKED_MUTATIONS_SETTING, this.parkedMutations);
    } catch (err) {
      console.warn('[SyncEngine] Could not persist the parked mutation queue:', err);
    }
  }

  /**
   * Queues a remote push for later. Returns null when there is no remote to send
   * to — a local-only install never accumulates a queue.
   */
  public async queueMutation(mutation: Omit<SyncMutation, 'id' | 'timestamp'>): Promise<SyncMutation | null> {
    if (!this.isRemoteConfigured()) {
      return null;
    }

    const entry: SyncMutation = {
      ...mutation,
      id: `mut_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp: Date.now(),
      retryCount: mutation.retryCount || 0
    };

    this.pendingLocalMutations.push(entry);
    await this.persistPendingMutations();
    return entry;
  }

  /** Discards parked mutations (their data is already in the local database). */
  public async clearParkedMutations(): Promise<void> {
    this.parkedMutations = [];
    await this.persistParkedMutations();
  }

  private backoffDelay(retryCount: number): number {
    const base = this.config.retryBaseDelayMs;
    const max = this.config.retryMaxDelayMs;
    return Math.min(base * Math.pow(2, Math.max(0, retryCount - 1)), max);
  }

  // --- Conflict resolution --------------------------------------------------

  private timestampOf(item: { updatedAt?: number; addedAt?: number }): number {
    return item.updatedAt || item.addedAt || 0;
  }

  /**
   * Last-Write-Wins on `updatedAt` (falling back to `addedAt`). The first
   * argument wins ties, so re-applying the caller's own write is never a
   * conflict.
   */
  public resolveConflict<T extends { updatedAt?: number; addedAt?: number; tracks?: UnifiedTrack[] }>(
    localItem: T,
    remoteItem: T
  ): T {
    return this.timestampOf(localItem) >= this.timestampOf(remoteItem)
      ? { ...localItem }
      : { ...remoteItem };
  }

  // --- Writes ---------------------------------------------------------------

  /**
   * Commits a playlist locally (LWW against the stored copy) and forwards it to a
   * configured remote. A stale write never clobbers a newer stored record.
   */
  public async pushPlaylist(playlist: Playlist): Promise<SyncCommitResult<Playlist>> {
    const incoming: Playlist = { ...playlist, updatedAt: playlist.updatedAt || Date.now() };
    this.notifyStatus('syncing');

    try {
      const stored = await dbService.getPlaylistById(incoming.id);
      const isConflict = !!stored && this.timestampOf(stored) > this.timestampOf(incoming);
      const resolved = stored ? this.resolveConflict(incoming, stored) : { ...incoming };

      const remote = await this.pushToRemote(
        () => this.remote.pushPlaylists([resolved]),
        { type: 'update_playlist', entityId: resolved.id, data: resolved }
      );

      const committed: Playlist = { ...resolved, isSynced: remote.accepted };
      await dbService.savePlaylist(committed);

      this.lastSyncedAt = Date.now();
      this.settleStatus();

      return {
        success: true,
        resolved: committed,
        isConflict,
        remoteAccepted: remote.accepted,
        queuedForRemote: remote.queued
      };
    } catch (err) {
      console.error('[SyncEngine] Failed to commit playlist:', err);
      this.notifyStatus('error');
      return {
        success: false,
        resolved: { ...incoming, isSynced: false },
        remoteAccepted: false
      };
    }
  }

  /**
   * Commits a favourite locally and forwards it to a configured remote.
   */
  public async pushFavorite(track: UnifiedTrack): Promise<SyncCommitResult<UnifiedTrack>> {
    const entry: UnifiedTrack = { ...track, addedAt: track.addedAt || Date.now() };
    this.notifyStatus('syncing');

    try {
      const remote = await this.pushToRemote(
        () => this.remote.pushFavorites([entry]),
        { type: 'add_favorite', entityId: entry.id, data: entry }
      );

      await dbService.addFavorite(entry);

      this.lastSyncedAt = Date.now();
      this.settleStatus();

      return {
        success: true,
        resolved: entry,
        isConflict: false,
        remoteAccepted: remote.accepted,
        queuedForRemote: remote.queued
      };
    } catch (err) {
      console.error('[SyncEngine] Failed to commit favorite:', err);
      this.notifyStatus('error');
      return { success: false, resolved: entry, remoteAccepted: false };
    }
  }

  /**
   * Deletes a playlist locally and on a configured remote.
   *
   * Местное удаление идёт **первым**, и это не мелочь. Раньше сначала ждали
   * сервер: на плохой связи запись оставалась на экране до двадцати секунд, а
   * при обрыве не удалялась вовсе. Местная база здесь источник правды, сервер —
   * вторая сторона; порядок обязан это отражать.
   */
  public async deletePlaylist(playlistId: string): Promise<SyncDeleteResult> {
    try {
      await dbService.deletePlaylist(playlistId);
      const remote = await this.rememberDeletion('playlist', playlistId);
      return { success: true, remoteAccepted: remote.accepted, queuedForRemote: remote.queued };
    } catch (err) {
      console.error('[SyncEngine] Failed to delete playlist:', err);
      this.notifyStatus('error');
      return { success: false, remoteAccepted: false };
    }
  }

  /**
   * Removes a favourite locally and on a configured remote.
   */
  public async deleteFavorite(trackId: string): Promise<SyncDeleteResult> {
    try {
      await dbService.removeFavorite(trackId);
      const remote = await this.rememberDeletion('favorite', trackId);
      return { success: true, remoteAccepted: remote.accepted, queuedForRemote: remote.queued };
    } catch (err) {
      console.error('[SyncEngine] Failed to remove favorite:', err);
      this.notifyStatus('error');
      return { success: false, remoteAccepted: false };
    }
  }

  /**
   * Сообщает серверу, что записи больше нет. Местное удаление к этому моменту
   * уже сделано вызывающим.
   *
   * Отдельно от {@link deleteFavorite} ради экрана. Медиатека убирает запись из
   * базы и со списка сама и ждать сеть при этом не должна — иначе снятое
   * сердечко висит, пока идёт запрос. Ей нужна ровно эта половина: поставить
   * надгробие, а если не вышло — не потерять его.
   *
   * Почему без надгробия нельзя. Движок сливает пришедшее с сервера в местное и
   * следом отправляет местное целиком. Запись, стёртая здесь, у сервера
   * остаётся живой, приезжает обратно ближайшей сверкой — и человек видит, что
   * удаление «не сработало». Ровно эта жалоба и привела к этому коду.
   *
   * Никогда не бросает: неудачная отправка становится записью в очереди, а
   * очередь переживает перезапуск приложения.
   */
  public rememberDeletion(
    entity: 'playlist' | 'favorite',
    id: string
  ): Promise<{ accepted: boolean; queued: boolean }> {
    const mutation: Omit<SyncMutation, 'id' | 'timestamp'> =
      entity === 'playlist'
        ? { type: 'delete_playlist', entityId: id }
        : { type: 'remove_favorite', entityId: id };

    const attempt = async () =>
      (entity === 'playlist'
      ? await this.remote.deletePlaylist(id)
      : await this.remote.deleteFavorite(id))
        ? 1
        : 0;

    /*
     * Заход обязан дождаться начатых удалений, прежде чем спрашивать сервер.
     *
     * Иначе получается гонка, которую видно глазами: удаление ещё в пути, а
     * сверка уже забрала картину мира, где запись жива, — и вернула её на
     * экран до следующей минуты. Надгробие потом всё равно победит, но человек
     * успеет увидеть, что «удаление отменилось само».
     */
    const flight = this.pushToRemote(attempt, mutation).finally(() => {
      this.deletionsInFlight.delete(flight);
    });
    this.deletionsInFlight.add(flight);
    return flight;
  }

  /** Идентификаторы, чьё удаление сервер ещё не подтвердил. */
  private unconfirmedDeletions(entity: 'playlist' | 'favorite'): Set<string> {
    const type = entity === 'playlist' ? 'delete_playlist' : 'remove_favorite';
    const ids = new Set<string>();
    for (const mutation of this.pendingLocalMutations) {
      if (mutation.type === type) ids.add(mutation.entityId);
    }
    for (const mutation of this.parkedMutations) {
      if (mutation.type === type) ids.add(mutation.entityId);
    }
    return ids;
  }

  /**
   * Runs `attempt` against the remote when one is configured and reachable, and
   * queues the mutation for retry otherwise. Never throws: a remote problem must
   * not fail a local commit.
   */
  private async pushToRemote(
    attempt: () => Promise<number>,
    mutation: Omit<SyncMutation, 'id' | 'timestamp'>
  ): Promise<{ accepted: boolean; queued: boolean }> {
    if (!this.isRemoteConfigured()) {
      return { accepted: false, queued: false };
    }

    if (this.isOnline) {
      try {
        if ((await attempt()) > 0) {
          return { accepted: true, queued: false };
        }
      } catch (err) {
        console.warn(`[SyncEngine] Remote rejected ${mutation.type}, queued for retry:`, err);
      }
    }

    const queued = await this.queueMutation(mutation);
    return { accepted: false, queued: !!queued };
  }

  // --- Queue flush ----------------------------------------------------------

  /**
   * Retries queued remote pushes that are past their backoff deadline. Mutations
   * that exhaust `maxRetries` are parked with a warning instead of being retried
   * forever. Returns how many were accepted by the remote.
   */
  public async syncPending(): Promise<number> {
    if (this.pendingLocalMutations.length === 0) return 0;
    if (!this.isOnline || !this.isRemoteConfigured()) return 0;

    this.notifyStatus('syncing');

    const now = Date.now();
    const remaining: SyncMutation[] = [];
    const newlyParked: SyncMutation[] = [];
    let processedCount = 0;
    let failures = 0;

    for (const mutation of this.pendingLocalMutations) {
      if (mutation.nextAttemptAt && mutation.nextAttemptAt > now) {
        remaining.push(mutation);
        continue;
      }

      try {
        await this.applyMutationToRemote(mutation);
        processedCount++;
      } catch (err) {
        failures++;
        const retryCount = (mutation.retryCount || 0) + 1;
        const lastError = err instanceof Error ? err.message : String(err);

        /*
         * Удаление не паркуется никогда.
         *
         * Парковка означает «лежит местно, отправлять больше не будем», и для
         * правки это разумно: запись цела, разойдутся только устройства. Для
         * удаления это ловушка — местно записи уже нет, а на сервере она жива,
         * и запрет на повторы делает расхождение вечным. Отправить надо один
         * идентификатор, поэтому цена бесконечных попыток здесь никакая:
         * задержка упирается в `retryMaxDelayMs`, то есть минуту.
         */
        const isDeletion = mutation.type === 'delete_playlist' || mutation.type === 'remove_favorite';

        if (!isDeletion && retryCount >= this.config.maxRetries) {
          console.warn(
            `[SyncEngine] Parking mutation ${mutation.id} (${mutation.type}) after ${retryCount} failed attempts: ${lastError}. ` +
              'The change is stored locally; it will not be retried automatically.'
          );
          newlyParked.push({ ...mutation, retryCount, lastError, nextAttemptAt: undefined });
        } else {
          remaining.push({
            ...mutation,
            retryCount,
            lastError,
            nextAttemptAt: now + this.backoffDelay(retryCount)
          });
        }
      }
    }

    this.pendingLocalMutations = remaining;
    await this.persistPendingMutations();

    if (newlyParked.length > 0) {
      this.parkedMutations = [...this.parkedMutations, ...newlyParked];
      await this.persistParkedMutations();
    }

    if (processedCount > 0) {
      this.lastSyncedAt = Date.now();
    }

    if (failures > 0) {
      this.notifyStatus('error');
    } else {
      this.settleStatus();
    }

    return processedCount;
  }

  private async applyMutationToRemote(mutation: SyncMutation): Promise<void> {
    switch (mutation.type) {
      case 'create_playlist':
      case 'update_playlist': {
        if (!isPlaylistPayload(mutation.data)) {
          throw new Error(`Mutation ${mutation.id} has no playlist payload`);
        }
        const accepted = await this.remote.pushPlaylists([mutation.data]);
        if (accepted < 1) throw new Error('Remote did not accept the playlist');
        break;
      }
      case 'delete_playlist': {
        if (!(await this.remote.deletePlaylist(mutation.entityId))) {
          throw new Error('Remote did not accept the playlist deletion');
        }
        break;
      }
      case 'add_favorite': {
        if (!isTrackPayload(mutation.data)) {
          throw new Error(`Mutation ${mutation.id} has no track payload`);
        }
        const accepted = await this.remote.pushFavorites([mutation.data]);
        if (accepted < 1) throw new Error('Remote did not accept the favorite');
        break;
      }
      case 'remove_favorite': {
        if (!(await this.remote.deleteFavorite(mutation.entityId))) {
          throw new Error('Remote did not accept the favorite removal');
        }
        break;
      }
    }
  }

  // --- Full reconciliation --------------------------------------------------

  /**
   * Reconciles the local library with the remote when one is configured. Without
   * a remote it only reports the local record counts — `syncedPlaylists` and
   * `syncedFavorites` stay 0 because nothing left the device.
   */
  /**
   * Стирает локально то, что удалили на другом устройстве.
   *
   * Возвращает, тронули ли что-нибудь: если да, местные списки надо перечитать,
   * иначе в отправку уйдут записи, которые мы только что стёрли, и они вернутся.
   *
   * Отказ здесь не валит заход целиком. Не удалить чужое удаление — это
   * рассинхрон до следующего раза; уронить синхронизацию из-за него — это
   * потерять и правки, которые уже готовы уехать.
   */
  private async applyRemoteDeletions(): Promise<boolean> {
    const pull = this.remote.pullDeletions;
    if (typeof pull !== 'function') return false;

    let deletions: RemoteDeletions;
    try {
      deletions = await pull.call(this.remote);
    } catch (err) {
      console.warn('[CloudSync] не удалось прочитать удаления:', err);
      return false;
    }

    let touched = false;

    for (const playlistId of deletions?.playlists ?? []) {
      try {
        // Проверка перед удалением, а не слепое `delete`: без неё счётчик
        // тронутого рос бы на каждом заходе, и списки перечитывались бы вечно.
        const stored = await dbService.getPlaylistById(playlistId);
        if (stored && !this.outlivesDeletion(stored, deletions.deletedAt?.playlists?.[playlistId])) {
          await dbService.deletePlaylist(playlistId);
          touched = true;
        }
      } catch (err) {
        console.warn(`[CloudSync] не удалось убрать плейлист ${playlistId}:`, err);
      }
    }

    for (const trackId of deletions?.favorites ?? []) {
      try {
        const stored = await dbService.getFavoriteById(trackId);
        if (stored && !this.outlivesDeletion(stored, deletions.deletedAt?.favorites?.[trackId])) {
          await dbService.removeFavorite(trackId);
          touched = true;
        }
      } catch (err) {
        console.warn(`[CloudSync] не удалось убрать из избранного ${trackId}:`, err);
      }
    }

    return touched;
  }

  /**
   * Пережила ли местная запись это удаление.
   *
   * Удаление — такая же правка, как остальные, и подчиняется тому же правилу:
   * побеждает более поздняя. Без этого сравнения обратное действие было
   * невозможно — человек убирал трек, передумывал, возвращал сердечко, и
   * ближайшая сверка снимала его снова, потому что надгробие «просто есть».
   * Именно так это и выглядело: «удалить нельзя, вернуть тоже нельзя».
   *
   * Когда даты нет (сервер старее приложения, или у адаптера её просто не
   * бывает), удаление применяется как раньше — по факту. Это хуже, чем со
   * сравнением, но лучше, чем возвращать удалённое.
   */
  private outlivesDeletion(
    stored: { updatedAt?: number; addedAt?: number },
    deletedAt: number | undefined
  ): boolean {
    if (typeof deletedAt !== 'number' || !Number.isFinite(deletedAt)) return false;
    return this.timestampOf(stored) > deletedAt;
  }

  public async syncAll(): Promise<CloudSyncResult> {
    const remoteConfigured = this.isRemoteConfigured();

    if (!this.isOnline) {
      this.notifyStatus('offline');
      return {
        success: false,
        syncedPlaylists: 0,
        syncedFavorites: 0,
        localPlaylists: 0,
        localFavorites: 0,
        remoteConfigured,
        timestamp: Date.now(),
        error: 'Нет подключения к сети.'
      };
    }

    this.notifyStatus('syncing');

    try {
      // Сначала дождаться удалений, начатых прямо сейчас: спрашивать сервер,
      // пока они в пути, значит получить в ответ то, что вот-вот исчезнет.
      if (this.deletionsInFlight.size > 0) {
        await Promise.allSettled(Array.from(this.deletionsInFlight));
      }
      await this.syncPending();

      const localPlaylistsBefore = await dbService.getPlaylists();
      const localFavoritesBefore = await dbService.getFavorites();

      if (!remoteConfigured) {
        this.lastSyncedAt = Date.now();
        this.notifyStatus('local-only');
        return {
          success: true,
          syncedPlaylists: 0,
          syncedFavorites: 0,
          localPlaylists: localPlaylistsBefore.length,
          localFavorites: localFavoritesBefore.length,
          remoteConfigured: false,
          timestamp: this.lastSyncedAt,
          message: LOCAL_ONLY_MESSAGE
        };
      }

      // Удаления применяются ДО слияния и отправки. После — бессмысленно: мы
      // бы отправили на сервер ровно то, что он только что просил забыть.
      const dropped = await this.applyRemoteDeletions();

      const localPlaylists = dropped
        ? await dbService.getPlaylists()
        : localPlaylistsBefore;
      const localFavorites = dropped ? await dbService.getFavorites() : localFavoritesBefore;

      const playlists = await this.mergeRemotePlaylists(localPlaylists);
      const favorites = await this.mergeRemoteFavorites(localFavorites);
      const mergedPlaylists = playlists.merged;
      const mergedFavorites = favorites.merged;

      const pushedPlaylists = await this.remote.pushPlaylists(mergedPlaylists);
      const pushedFavorites = await this.remote.pushFavorites(mergedFavorites);

      // Экран показывает не базу, а свою копию её содержимого. Если в базу
      // только что легло чужое, копию надо перечитать — иначе человек увидит
      // новое только после перезапуска.
      if (dropped || playlists.changed || favorites.changed) {
        this.notifyRemoteChange();
      }

      if (pushedPlaylists >= mergedPlaylists.length) {
        for (const playlist of mergedPlaylists) {
          if (!playlist.isSynced) {
            await dbService.savePlaylist({ ...playlist, isSynced: true });
          }
        }
      }

      this.lastSyncedAt = Date.now();
      this.notifyStatus('synced');

      return {
        success: true,
        syncedPlaylists: pushedPlaylists,
        syncedFavorites: pushedFavorites,
        localPlaylists: mergedPlaylists.length,
        localFavorites: mergedFavorites.length,
        remoteConfigured: true,
        timestamp: this.lastSyncedAt
      };
    } catch (err) {
      console.error('[SyncEngine] syncAll error:', err);
      this.notifyStatus('error');
      return {
        success: false,
        syncedPlaylists: 0,
        syncedFavorites: 0,
        localPlaylists: 0,
        localFavorites: 0,
        remoteConfigured,
        timestamp: Date.now(),
        error: err instanceof Error ? err.message : 'Синхронизация не удалась.'
      };
    }
  }

  /**
   * LWW-merges remote playlists into the local database. A merge write keeps the
   * winner's `updatedAt`, so it is not mistaken for a user edit next time.
   */
  private async mergeRemotePlaylists(
    localPlaylists: Playlist[]
  ): Promise<{ merged: Playlist[]; changed: boolean }> {
    const remotePlaylists = await this.remote.pullPlaylists();
    const localById = new Map(localPlaylists.map((pl) => [pl.id, pl]));
    const merged = new Map<string, Playlist>(localById);
    const deleting = this.unconfirmedDeletions('playlist');
    let changed = false;

    for (const remotePl of remotePlaylists) {
      // Здесь его удалили, а сервер ещё не в курсе — своё удаление главнее его
      // копии. Без этого запись возвращалась бы на экран на каждой сверке,
      // пока не пройдёт отправка, а при парковке — навсегда.
      if (deleting.has(remotePl.id)) continue;
      const localPl = localById.get(remotePl.id);
      const winner = localPl ? this.resolveConflict(localPl, remotePl) : { ...remotePl };
      merged.set(remotePl.id, winner);

      const isNewLocally = !localPl || this.timestampOf(winner) > this.timestampOf(localPl);
      if (isNewLocally) {
        await dbService.savePlaylist(winner);
        changed = true;
      }
    }

    return { merged: Array.from(merged.values()), changed };
  }

  private async mergeRemoteFavorites(
    localFavorites: UnifiedTrack[]
  ): Promise<{ merged: UnifiedTrack[]; changed: boolean }> {
    const remoteFavorites = await this.remote.pullFavorites();
    const merged = new Map<string, UnifiedTrack>(localFavorites.map((track) => [track.id, track]));
    const deleting = this.unconfirmedDeletions('favorite');
    let changed = false;

    for (const remoteTrack of remoteFavorites) {
      if (deleting.has(remoteTrack.id)) continue;
      if (merged.has(remoteTrack.id)) continue;
      merged.set(remoteTrack.id, remoteTrack);
      await dbService.addFavorite(remoteTrack);
      changed = true;
    }

    return { merged: Array.from(merged.values()), changed };
  }

  // --- Periodic sync --------------------------------------------------------

  /**
   * Starts periodic reconciliation. Does nothing (and says so) without a remote,
   * because re-writing the local database on a timer helps nobody.
   */
  public startPeriodicSync(intervalMs?: number): boolean {
    this.stopPeriodicSync();

    if (!this.config.enableAutoSync) return false;
    if (!this.isRemoteConfigured()) {
      console.info('[SyncEngine] Periodic sync not started: no remote adapter is configured (local-only mode).');
      return false;
    }

    const ms = intervalMs || this.config.autoSyncIntervalMs || 30000;
    this.periodicTimer = setInterval(() => {
      if (this.isOnline) {
        this.syncAll().catch((err) => {
          console.warn('[SyncEngine] Periodic sync failed:', err);
        });
      }
    }, ms);
    return true;
  }

  /**
   * Stops periodic background synchronization
   */
  public stopPeriodicSync(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }
}

/** Kept as `cloudSyncEngine` because the app imports that name. */
export const cloudSyncEngine = new LocalFirstSyncEngine();
