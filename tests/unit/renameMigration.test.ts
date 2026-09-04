import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import Dexie from 'dexie';
import {
  LEGACY_DB_NAME,
  WireonDB,
  clearAllData,
  db,
  migrateLegacyDatabase
} from '../../src/services/db';
import {
  STORAGE_KEY_AUTH_TOKEN,
  STORAGE_KEY_AUTH_USER,
  STORAGE_KEY_TOKEN_EXPIRES,
  getStoredSession,
  migrateLegacySessionKeys
} from '../../src/services/discordAuth';
import { Playlist, UnifiedTrack, UserProfile } from '../../src/types/music';

/**
 * The rename from VireonMusic to Wireon moved the database, the userData folder
 * and the localStorage keys. Every one of those is a way to silently lose a
 * user's library or log them out on update, so each migration is pinned here.
 *
 * The Electron half (the userData folder itself) lives in `desktop.test.tsx`,
 * where the `electron` module is mocked.
 */

const legacyTrack: UnifiedTrack = {
  id: 'yt_legacy_01',
  source: 'youtube',
  originalId: 'legacy_01',
  title: 'Старая запись',
  artist: 'Довиреон',
  duration: 231,
  artworkUrl: 'https://example.test/legacy.jpg',
  addedAt: 1_600_000_000_000
};

const legacyPlaylist: Playlist = {
  id: 'pl_legacy',
  title: 'Сохранённое до переименования',
  tracks: [legacyTrack],
  createdAt: 1_600_000_000_000,
  updatedAt: 1_600_000_000_000,
  isSynced: false
};

const legacyUser: UserProfile = {
  id: '777777777777777777',
  username: 'СтарыйАккаунт',
  discriminator: '0',
  avatarUrl: 'https://cdn.discordapp.com/avatars/777777777777777777/old.png',
  provider: 'discord',
  status: 'online'
};

/** Writes a session the way builds released before the rename did. */
function seedLegacySession(expiresAt = Date.now() + 3_600_000) {
  localStorage.setItem('vireon_auth_user', JSON.stringify({ ...legacyUser, expiresAt }));
  localStorage.setItem('vireon_auth_token', 'legacy_token_abc');
  localStorage.setItem('vireon_auth_token_expires', String(expiresAt));
}

describe('Rename migration: localStorage session keys', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('carries a pre-rename session over instead of logging the user out', () => {
    seedLegacySession();

    migrateLegacySessionKeys();

    expect(localStorage.getItem(STORAGE_KEY_AUTH_TOKEN)).toBe('legacy_token_abc');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_AUTH_USER) || 'null').username).toBe('СтарыйАккаунт');
    expect(localStorage.getItem(STORAGE_KEY_TOKEN_EXPIRES)).not.toBeNull();

    // The old keys are gone, so this never runs twice.
    expect(localStorage.getItem('vireon_auth_user')).toBeNull();
    expect(localStorage.getItem('vireon_auth_token')).toBeNull();
    expect(localStorage.getItem('vireon_auth_token_expires')).toBeNull();
  });

  it('never overwrites a newer session, but still clears the old keys', () => {
    seedLegacySession();
    localStorage.setItem(STORAGE_KEY_AUTH_TOKEN, 'current_token_xyz');
    localStorage.setItem(STORAGE_KEY_AUTH_USER, JSON.stringify({ ...legacyUser, username: 'НовыйАккаунт' }));

    migrateLegacySessionKeys();

    expect(localStorage.getItem(STORAGE_KEY_AUTH_TOKEN)).toBe('current_token_xyz');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_AUTH_USER) || 'null').username).toBe('НовыйАккаунт');
    expect(localStorage.getItem('vireon_auth_token')).toBeNull();
  });

  it('is a no-op with nothing to migrate', () => {
    migrateLegacySessionKeys();
    expect(localStorage.length).toBe(0);

    seedLegacySession();
    migrateLegacySessionKeys();
    const after = localStorage.length;
    migrateLegacySessionKeys();
    expect(localStorage.length).toBe(after);
  });

  it('is what makes a pre-rename session readable at boot', () => {
    seedLegacySession();

    // `getStoredSession` migrates on the way in — this is the path App.tsx takes.
    const session = getStoredSession();

    expect(session.token).toBe('legacy_token_abc');
    expect(session.user?.username).toBe('СтарыйАккаунт');
    expect(session.isExpired).toBe(false);
  });

  it('survives storage that refuses to be written', () => {
    seedLegacySession();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => migrateLegacySessionKeys()).not.toThrow();

    vi.restoreAllMocks();
  });
});

describe('Rename migration: Dexie database', () => {
  beforeEach(async () => {
    await clearAllData();
    if (await Dexie.exists(LEGACY_DB_NAME)) await Dexie.delete(LEGACY_DB_NAME);
  });

  afterEach(async () => {
    await clearAllData();
    if (await Dexie.exists(LEGACY_DB_NAME)) await Dexie.delete(LEGACY_DB_NAME);
  });

  it('does nothing when there is no pre-rename database', async () => {
    expect(await migrateLegacyDatabase()).toBe(0);
  });

  it('moves a pre-rename library across and then deletes the old database', async () => {
    const legacy = new WireonDB(LEGACY_DB_NAME);
    await legacy.open();
    await legacy.tracks.put(legacyTrack);
    await legacy.playlists.put(legacyPlaylist);
    await legacy.favorites.put(legacyTrack);
    await legacy.settings.put({ key: 'volume', value: 0.42, updatedAt: 1_600_000_000_000 });
    legacy.close();

    const moved = await migrateLegacyDatabase();

    expect(moved).toBe(4);
    expect((await db.tracks.get('yt_legacy_01'))?.title).toBe('Старая запись');
    expect((await db.playlists.get('pl_legacy'))?.title).toBe('Сохранённое до переименования');
    expect(await db.favorites.get('yt_legacy_01')).toBeDefined();
    expect((await db.settings.get('volume'))?.value).toBe(0.42);

    // Migrated once: the old database is gone, so the next launch finds nothing.
    expect(await Dexie.exists(LEGACY_DB_NAME)).toBe(false);
    expect(await migrateLegacyDatabase()).toBe(0);
  });

  it('refuses to touch a library that already has data', async () => {
    const current: UnifiedTrack = { ...legacyTrack, id: 'yt_current_01', title: 'Уже здесь' };
    await db.tracks.put(current);

    const legacy = new WireonDB(LEGACY_DB_NAME);
    await legacy.open();
    await legacy.tracks.put(legacyTrack);
    legacy.close();

    expect(await migrateLegacyDatabase()).toBe(0);

    // Nothing was overwritten, and the legacy copy is left on disk untouched.
    expect(await db.tracks.get('yt_legacy_01')).toBeUndefined();
    expect((await db.tracks.get('yt_current_01'))?.title).toBe('Уже здесь');
    expect(await Dexie.exists(LEGACY_DB_NAME)).toBe(true);
  });

  it('an empty pre-rename database is not treated as a migration', async () => {
    const legacy = new WireonDB(LEGACY_DB_NAME);
    await legacy.open();
    legacy.close();

    expect(await migrateLegacyDatabase()).toBe(0);
    // Nothing moved means nothing was deleted either — no data was at risk.
    expect(await Dexie.exists(LEGACY_DB_NAME)).toBe(true);
  });

  it('reports 0 rather than throwing when IndexedDB is unavailable', async () => {
    const existsSpy = vi.spyOn(Dexie, 'exists').mockRejectedValue(new Error('IndexedDB is disabled'));

    await expect(migrateLegacyDatabase()).resolves.toBe(0);

    existsSpy.mockRestore();
  });
});
