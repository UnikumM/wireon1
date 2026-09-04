import { Playlist, UnifiedTrack } from './music';

export interface DiscordAuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface DiscordUserRaw {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  avatar: string | null;
  banner?: string | null;
  accent_color?: number | null;
  email?: string;
  verified?: boolean;
}

export interface DiscordAuthToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  expiresAt: number;
  scope: string;
}

/**
 * Every way the OAuth2 flow can fail. Surfaced to the UI through `AuthError.code`
 * so a blocked popup or a missing client id can be explained instead of silently
 * replaced by a fabricated session.
 */
export type AuthErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED_ENVIRONMENT'
  | 'POPUP_BLOCKED'
  | 'POPUP_CLOSED'
  | 'DEEP_LINK_UNAVAILABLE'
  | 'STATE_MISMATCH'
  | 'OAUTH_DENIED'
  | 'NO_TOKEN'
  | 'PROFILE_FETCH_FAILED'
  | 'TIMEOUT';

/**
 * `local-only` means: the library is consistent on this device and no remote
 * adapter is configured, so nothing was (or could be) uploaded.
 */
export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'local-only' | 'offline' | 'error';

export type MutationType =
  | 'create_playlist'
  | 'update_playlist'
  | 'delete_playlist'
  | 'add_favorite'
  | 'remove_favorite';

export interface SyncMutation {
  id: string;
  type: MutationType;
  entityId: string;
  data?: Playlist | UnifiedTrack;
  timestamp: number;
  retryCount?: number;
  /** Epoch ms before which the mutation must not be retried (exponential backoff). */
  nextAttemptAt?: number;
  lastError?: string;
}

/**
 * Remote persistence contract. Wireon ships without a backend, so the
 * default implementation is `NullRemoteAdapter` and `isConfigured()` is false.
 */
export interface RemoteSyncAdapter {
  readonly id: string;
  isConfigured(): boolean;
  /** Returns how many records the remote actually persisted. */
  pushPlaylists(playlists: Playlist[]): Promise<number>;
  pullPlaylists(): Promise<Playlist[]>;
  pushFavorites(tracks: UnifiedTrack[]): Promise<number>;
  pullFavorites(): Promise<UnifiedTrack[]>;
  deletePlaylist(playlistId: string): Promise<boolean>;
  deleteFavorite(trackId: string): Promise<boolean>;
  /**
   * Что удалили на других устройствах.
   *
   * Необязательный: адаптеру без своей памяти об удалениях сказать нечего.
   * Но без него удаление не доезжает вовсе — движок сливает пришедшее в
   * местное, а потом отправляет местное целиком, и запись, стёртая на телефоне,
   * возвращается с ПК, у которого не было причины её забыть.
   */
  pullDeletions?(): Promise<RemoteDeletions>;
}

/** Что удалено на удалённой стороне и когда. */
export interface RemoteDeletions {
  playlists: string[];
  favorites: string[];
  /**
   * Когда запись удалили, по идентификатору.
   *
   * Необязательно: сервер может быть старше приложения, а у адаптера без своей
   * памяти дат нет вовсе. Без даты удаление применяется как раньше — просто по
   * факту; с датой оно уступает более поздней правке, и «убрал, передумал,
   * вернул» перестаёт откатываться на ближайшей сверке.
   */
  deletedAt?: {
    playlists?: Record<string, number>;
    favorites?: Record<string, number>;
  };
}

export interface CloudSyncResult {
  success: boolean;
  /** Records accepted by a configured remote. Always 0 while remote is local-only. */
  syncedPlaylists: number;
  syncedFavorites: number;
  /** Records reconciled in the local IndexedDB. */
  localPlaylists: number;
  localFavorites: number;
  remoteConfigured: boolean;
  timestamp: number;
  message?: string;
  error?: string;
}

export interface CloudSyncConfig {
  endpoint?: string;
  autoSyncIntervalMs?: number;
  enableAutoSync?: boolean;
  /** Attempts per queued mutation before it is parked. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_DISCORD_CLIENT_ID?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
