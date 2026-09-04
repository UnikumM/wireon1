/**
 * Flagship Features Test Doubles, Domain Models & Protocol Simulators
 * Shared across tests/e2e/ test suites for Wireon M8 Flagship Feature Upgrade.
 */

import { UnifiedTrack, PlaybackSettingsState } from '../../src/types/music';
import { useLibraryStore } from '../../src/store/useLibraryStore';

// ===========================================================================
// 1. Lyrics & LRC Types & Simulation (M2)
// ===========================================================================

export interface LyricsLine {
  time: number; // seconds
  text: string;
}

export interface LyricsResult {
  synced: boolean;
  lines: LyricsLine[];
  rawLrc?: string;
  plainLyrics?: string;
  source: 'lrclib' | 'cache' | 'fallback';
}

export function parseLRC(lrcText: string): LyricsLine[] {
  if (!lrcText || typeof lrcText !== 'string') return [];

  const lines: LyricsLine[] = [];
  const rawLines = lrcText.split(/\r?\n/);
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const timestamps: number[] = [];
    let match: RegExpExecArray | null;
    timeRegex.lastIndex = 0;

    while ((match = timeRegex.exec(trimmed)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const fracStr = match[3] || '0';
      const fraction = parseFloat(`0.${fracStr}`);
      timestamps.push(minutes * 60 + seconds + fraction);
    }

    const lyricText = trimmed.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();

    for (const time of timestamps) {
      lines.push({ time, text: lyricText });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

export function findActiveLyricIndex(lines: LyricsLine[], currentTime: number): number {
  if (!lines || lines.length === 0) return -1;
  if (currentTime < lines[0].time) return -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (currentTime >= lines[i].time) {
      return i;
    }
  }
  return -1;
}

export class MockLyricsService {
  private cache = new Map<string, LyricsResult>();

  clearCache(): void {
    this.cache.clear();
  }

  async fetchLyrics(track: UnifiedTrack): Promise<LyricsResult | null> {
    if (!track || !track.title) return null;

    const cacheKey = `${track.artist} - ${track.title}`.toLowerCase();
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    try {
      const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(
        track.title
      )}&artist_name=${encodeURIComponent(track.artist || '')}&duration=${Math.round(
        track.duration || 0
      )}`;

      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`LRCLIB error: ${res.status}`);
      }

      const data = await res.json();
      if (data.syncedLyrics) {
        const parsed = parseLRC(data.syncedLyrics);
        const result: LyricsResult = {
          synced: true,
          lines: parsed,
          rawLrc: data.syncedLyrics,
          source: 'lrclib'
        };
        this.cache.set(cacheKey, result);
        return result;
      } else if (data.plainLyrics) {
        const plainLines: LyricsLine[] = data.plainLyrics
          .split(/\r?\n/)
          .filter((l: string) => l.trim().length > 0)
          .map((text: string, idx: number) => ({ time: idx * 5, text: text.trim() }));
        const result: LyricsResult = {
          synced: false,
          lines: plainLines,
          plainLyrics: data.plainLyrics,
          source: 'lrclib'
        };
        this.cache.set(cacheKey, result);
        return result;
      }

      return null;
    } catch (err) {
      return null;
    }
  }
}

// ===========================================================================
// 2. Dual-Deck DSP & DJ Crossfade (M1)
// ===========================================================================

export interface DeckState {
  id: 'deckA' | 'deckB';
  element: HTMLAudioElement | null;
  gain: number;
  currentTrack: UnifiedTrack | null;
  isPlaying: boolean;
}

export class DualDeckEngineModel {
  deckA: DeckState = { id: 'deckA', element: null, gain: 1.0, currentTrack: null, isPlaying: false };
  deckB: DeckState = { id: 'deckB', element: null, gain: 0.0, currentTrack: null, isPlaying: false };
  activeDeck: 'deckA' | 'deckB' = 'deckA';

  crossfadeEnabled: boolean = true;
  crossfadeDuration: number = 4.0;
  loudnessNormalization: boolean = true;
  compressorEnabled: boolean = true;

  isTransitioning: boolean = false;
  scheduledRamps: Array<{ deck: 'deckA' | 'deckB'; startGain: number; endGain: number; duration: number }> = [];

  setCrossfade(enabled: boolean, durationSec: number): void {
    this.crossfadeEnabled = enabled;
    this.crossfadeDuration = Math.max(0, Math.min(12, durationSec));
  }

  setLoudnessNormalization(enabled: boolean): void {
    this.loudnessNormalization = enabled;
    this.compressorEnabled = enabled;
  }

  getSettings(): PlaybackSettingsState {
    return {
      crossfadeEnabled: this.crossfadeEnabled,
      crossfadeDuration: this.crossfadeDuration,
      loudnessNormalization: this.loudnessNormalization
    };
  }

  calculateCrossfadeGain(progressNormalized: number): { outgoingGain: number; incomingGain: number } {
    const clampedProgress = Math.max(0, Math.min(1, progressNormalized));
    return {
      outgoingGain: Math.max(0, 1 - clampedProgress),
      incomingGain: Math.min(1, clampedProgress)
    };
  }

  calculateEqualPowerGain(progressNormalized: number): { outgoingGain: number; incomingGain: number } {
    const p = Math.max(0, Math.min(1, progressNormalized));
    return {
      outgoingGain: Math.cos(p * (Math.PI / 2)),
      incomingGain: Math.sin(p * (Math.PI / 2))
    };
  }

  playTrack(track: UnifiedTrack): void {
    this.isTransitioning = false;
    this.scheduledRamps = [];
    if (this.activeDeck === 'deckA') {
      this.deckA.currentTrack = track;
      this.deckA.gain = 1.0;
      this.deckA.isPlaying = true;
      this.deckB.gain = 0.0;
      this.deckB.isPlaying = false;
    } else {
      this.deckB.currentTrack = track;
      this.deckB.gain = 1.0;
      this.deckB.isPlaying = true;
      this.deckA.gain = 0.0;
      this.deckA.isPlaying = false;
    }
  }

  transitionToTrack(nextTrack: UnifiedTrack): { transitionDuration: number } {
    const outgoing = this.activeDeck === 'deckA' ? this.deckA : this.deckB;
    const incoming = this.activeDeck === 'deckA' ? this.deckB : this.deckA;

    if (!this.crossfadeEnabled || this.crossfadeDuration <= 0) {
      outgoing.gain = 0.0;
      outgoing.isPlaying = false;
      incoming.currentTrack = nextTrack;
      incoming.gain = 1.0;
      incoming.isPlaying = true;
      this.activeDeck = incoming.id;
      this.isTransitioning = false;
      this.scheduledRamps = [];
      return { transitionDuration: 0 };
    }

    let effectiveDuration = this.crossfadeDuration;
    if (nextTrack.duration && nextTrack.duration < this.crossfadeDuration * 2) {
      effectiveDuration = Math.max(0.5, nextTrack.duration / 2);
    }

    this.isTransitioning = true;
    incoming.currentTrack = nextTrack;
    incoming.isPlaying = true;

    this.scheduledRamps = [
      { deck: outgoing.id, startGain: 1.0, endGain: 0.0, duration: effectiveDuration },
      { deck: incoming.id, startGain: 0.0, endGain: 1.0, duration: effectiveDuration }
    ];

    this.activeDeck = incoming.id;
    return { transitionDuration: effectiveDuration };
  }

  cancelTransition(): void {
    this.isTransitioning = false;
    this.scheduledRamps = [];
    const active = this.activeDeck === 'deckA' ? this.deckA : this.deckB;
    const inactive = this.activeDeck === 'deckA' ? this.deckB : this.deckA;
    active.gain = 1.0;
    inactive.gain = 0.0;
    inactive.isPlaying = false;
  }
}

// ===========================================================================
// 3. Offline Storage Service (M3)
// ===========================================================================

export interface OfflineTrackRecord {
  id: string;
  track: UnifiedTrack;
  blob: Blob;
  sizeBytes: number;
  downloadedAt: number;
}

export class MockOfflineStorageService {
  private records = new Map<string, OfflineTrackRecord>();
  private activeDownloads = new Map<string, AbortController>();

  clear(): void {
    this.records.clear();
    this.activeDownloads.clear();
  }

  async isDownloaded(trackId: string): Promise<boolean> {
    return this.records.has(trackId);
  }

  async getOfflineAudioUrl(trackId: string): Promise<string | null> {
    const record = this.records.get(trackId);
    if (!record) return null;
    return `blob:http://localhost/${trackId}-${record.downloadedAt}`;
  }

  async downloadTrack(
    track: UnifiedTrack,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    if (this.records.has(track.id)) {
      if (onProgress) onProgress(100);
      return;
    }

    const controller = new AbortController();
    this.activeDownloads.set(track.id, controller);

    try {
      const streamUrl = track.streamUrl || `https://mock-stream.wireon.io/${track.id}`;
      if (onProgress) onProgress(10);

      const res = await fetch(streamUrl, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Download failed with status: ${res.status}`);
      }

      if (onProgress) onProgress(50);
      const blob = await res.blob();
      if (onProgress) onProgress(90);

      const clHeader = res.headers.get('Content-Length');
      const sizeBytes = clHeader ? parseInt(clHeader, 10) : (blob.size > 100 ? blob.size : 1024 * 1024 * 4);

      const record: OfflineTrackRecord = {
        id: track.id,
        track,
        blob,
        sizeBytes,
        downloadedAt: Date.now()
      };

      this.records.set(track.id, record);
      if (onProgress) onProgress(100);
    } finally {
      this.activeDownloads.delete(track.id);
    }
  }

  cancelDownload(trackId: string): void {
    const controller = this.activeDownloads.get(trackId);
    if (controller) {
      controller.abort();
      this.activeDownloads.delete(trackId);
    }
  }

  async deleteOfflineTrack(trackId: string): Promise<void> {
    this.records.delete(trackId);
  }

  async getAllOfflineTracks(): Promise<UnifiedTrack[]> {
    return Array.from(this.records.values()).map((r) => r.track);
  }

  async getTotalStorageUsed(): Promise<{ trackCount: number; totalBytes: number; formattedSize: string }> {
    const trackCount = this.records.size;
    let totalBytes = 0;
    for (const record of this.records.values()) {
      totalBytes += record.sizeBytes;
    }

    const megabytes = (totalBytes / (1024 * 1024)).toFixed(1);
    return {
      trackCount,
      totalBytes,
      formattedSize: `${megabytes} MB`
    };
  }

  async resolvePlaybackStream(track: UnifiedTrack): Promise<{ url: string; isOffline: boolean }> {
    if (await this.isDownloaded(track.id)) {
      const offlineUrl = await this.getOfflineAudioUrl(track.id);
      return { url: offlineUrl!, isOffline: true };
    }
    return { url: track.streamUrl || 'https://network.stream.io/audio', isOffline: false };
  }
}

// ===========================================================================
// 4. Discord RPC Manager (M4)
// ===========================================================================

export interface DiscordActivityPayload {
  details: string;
  state: string;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  instance?: boolean;
}

export class MockDiscordRpcManager {
  enabled: boolean = true;
  connected: boolean = false;
  currentActivity: DiscordActivityPayload | null = null;
  broadcastHistory: DiscordActivityPayload[] = [];
  lastBroadcastTime: number = 0;

  connect(): boolean {
    this.connected = true;
    return true;
  }

  disconnect(): void {
    this.connected = false;
    this.currentActivity = null;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearActivity();
    }
  }

  clearActivity(): void {
    this.currentActivity = null;
  }

  buildPayloadFromTrack(
    track: UnifiedTrack | null,
    isPlaying: boolean,
    currentTime: number = 0
  ): DiscordActivityPayload | null {
    if (!track || !this.enabled) return null;

    const title = (track.title || 'Без названия').slice(0, 128);
    const rawArtist = track.artist || 'Неизвестный исполнитель';
    const state = rawArtist.slice(0, 128);

    const now = Math.floor(Date.now() / 1000);
    const duration = Math.floor(track.duration || 0);

    const payload: DiscordActivityPayload = {
      details: title,
      state,
      largeImageKey: track.artworkUrl || 'wireon_logo',
      largeImageText: track.album || 'Wireon',
      smallImageKey: isPlaying ? 'play_icon' : 'pause_icon',
      smallImageText: isPlaying ? 'Играет' : 'Пауза',
      instance: false
    };

    if (isPlaying && duration > 0) {
      payload.startTimestamp = now - Math.floor(currentTime);
      payload.endTimestamp = payload.startTimestamp + duration;
    }

    return payload;
  }

  setActivity(payload: DiscordActivityPayload | null): boolean {
    if (!this.enabled || !this.connected) {
      this.currentActivity = null;
      return false;
    }

    this.currentActivity = payload;
    if (payload) {
      this.broadcastHistory.push(payload);
      this.lastBroadcastTime = Date.now();
    }
    return true;
  }
}

// ===========================================================================
// 5. Playlist Importer (M5)
// ===========================================================================

export type PlatformType = 'spotify' | 'yandex' | 'vk' | 'apple';

export interface ParsedPlaylistItem {
  title: string;
  artist: string;
  duration?: number;
}

export interface ParsedPlaylist {
  title: string;
  platform: PlatformType;
  items: ParsedPlaylistItem[];
}

export class MockPlaylistImporterService {
  detectPlatform(url: string): PlatformType | null {
    if (!url || typeof url !== 'string') return null;
    const cleanUrl = url.trim().toLowerCase();

    if (cleanUrl.includes('spotify.com/playlist') || cleanUrl.includes('spotify.link')) {
      return 'spotify';
    }
    if (cleanUrl.includes('music.yandex.ru') || cleanUrl.includes('music.yandex.com')) {
      return 'yandex';
    }
    if (cleanUrl.includes('vk.com/music/playlist') || cleanUrl.includes('vk.com/audio')) {
      return 'vk';
    }
    if (cleanUrl.includes('music.apple.com') && cleanUrl.includes('/playlist/')) {
      return 'apple';
    }
    return null;
  }

  async parsePlaylistUrl(url: string): Promise<ParsedPlaylist> {
    const platform = this.detectPlatform(url);
    if (!platform) {
      throw new Error('Ссылка не подходит');
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch playlist webpage (HTTP ${res.status})`);
    }

    const data = await res.json();
    return {
      title: data.title || 'Imported Playlist',
      platform,
      items: data.items || []
    };
  }

  async resolveImportedTracks(
    items: ParsedPlaylistItem[],
    onProgress?: (resolved: number, total: number) => void
  ): Promise<UnifiedTrack[]> {
    const resolved: UnifiedTrack[] = [];
    const total = items.length;

    for (let i = 0; i < total; i++) {
      const item = items[i];
      const query = `${item.artist} - ${item.title}`.trim();

      try {
        const res = await fetch(`https://api.wireon.mock/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const trackData = await res.json();
          resolved.push({
            id: `yt_imp_${i}`,
            source: 'youtube',
            originalId: `imp_${i}`,
            title: item.title,
            artist: item.artist,
            duration: item.duration || 200,
            artworkUrl: 'https://cdn.art/default.jpg',
            streamUrl: `https://rr3---sn-test.googlevideo.com/videoplayback?id=imp_${i}&itag=140`,
            ...trackData
          });
        }
      } catch (err) {
        // Skip unresolvable
      }

      if (onProgress) {
        onProgress(i + 1, total);
      }
    }

    return resolved;
  }

  async saveToLibrary(title: string, tracks: UnifiedTrack[]): Promise<string> {
    const newPlaylist = await useLibraryStore.getState().createPlaylist(title, `Imported via 1-Click Multi-Platform Importer`);
    if (!newPlaylist) throw new Error('Failed to create playlist');

    for (const track of tracks) {
      await useLibraryStore.getState().addTrackToPlaylist(newPlaylist.id, track);
    }

    return newPlaylist.id;
  }
}

// ===========================================================================
// 6. Artist Hub Service (M6)
// ===========================================================================

export interface ArtistAlbum {
  id: string;
  title: string;
  year?: string;
  coverUrl?: string;
  trackCount?: number;
}

export interface SimilarArtist {
  name: string;
  imageUrl?: string;
}

export interface ArtistProfile {
  name: string;
  bannerUrl?: string;
  bio?: string;
  topTracks: UnifiedTrack[];
  albums: ArtistAlbum[];
  similarArtists: SimilarArtist[];
}

export class MockArtistService {
  private profileCache = new Map<string, ArtistProfile>();

  clearCache(): void {
    this.profileCache.clear();
  }

  async getArtistProfile(artistName: string): Promise<ArtistProfile> {
    if (!artistName || typeof artistName !== 'string') {
      throw new Error('Artist name is required');
    }

    const key = artistName.trim().toLowerCase();
    if (this.profileCache.has(key)) {
      return this.profileCache.get(key)!;
    }

    const url = `https://api.wireon.mock/artist/${encodeURIComponent(artistName)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch artist profile (HTTP ${res.status})`);
    }

    const data = await res.json();
    const profile: ArtistProfile = {
      name: data.name || artistName,
      bannerUrl: data.bannerUrl || 'https://cdn.art/default_banner.jpg',
      bio: data.bio || `Official artist profile for ${artistName}.`,
      topTracks: (data.topTracks || []).slice(0, 10),
      albums: data.albums || [],
      similarArtists: data.similarArtists || []
    };

    this.profileCache.set(key, profile);
    return profile;
  }
}

// ===========================================================================
// 7. Group Listen Protocol (M7)
// ===========================================================================

export type GroupMessageType = 'sync_state' | 'heartbeat' | 'chat' | 'queue_update';

export interface GroupState {
  trackId?: string;
  isPlaying: boolean;
  currentTime: number;
  queue: UnifiedTrack[];
}

export interface GroupListenMessage {
  type: GroupMessageType;
  roomId: string;
  senderId: string;
  hostTimestamp: number;
  state: GroupState;
}

export interface Participant {
  id: string;
  username: string;
  isHost: boolean;
  joinedAt: number;
}

export class MockGroupListenSession {
  roomId: string | null = null;
  userId: string;
  username: string;
  isHost: boolean = false;
  participants: Participant[] = [];
  connected: boolean = false;
  lastReceivedState: GroupState | null = null;
  messageLog: GroupListenMessage[] = [];

  constructor(userId: string, username: string) {
    this.userId = userId;
    this.username = username;
  }

  static generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  async createRoom(): Promise<string> {
    this.roomId = MockGroupListenSession.generateRoomCode();
    this.isHost = true;
    this.connected = true;
    this.participants = [
      { id: this.userId, username: this.username, isHost: true, joinedAt: Date.now() }
    ];
    return this.roomId;
  }

  async joinRoom(code: string): Promise<boolean> {
    const sanitized = (code || '').trim().toUpperCase();
    if (sanitized.length !== 6) {
      throw new Error('Код комнаты — ровно 6 символов');
    }

    this.roomId = sanitized;
    this.isHost = false;
    this.connected = true;
    this.participants.push({
      id: this.userId,
      username: this.username,
      isHost: false,
      joinedAt: Date.now()
    });
    return true;
  }

  leaveRoom(): void {
    this.roomId = null;
    this.isHost = false;
    this.connected = false;
    this.participants = [];
    this.lastReceivedState = null;
  }

  broadcastState(state: GroupState): GroupListenMessage | null {
    if (!this.connected || !this.roomId) return null;

    const message: GroupListenMessage = {
      type: 'sync_state',
      roomId: this.roomId,
      senderId: this.userId,
      hostTimestamp: Date.now(),
      state
    };

    this.messageLog.push(message);
    return message;
  }

  receiveMessage(message: GroupListenMessage): { adjustedTime: number; isPlaying: boolean } {
    if (message.roomId !== this.roomId) {
      throw new Error('Room ID mismatch');
    }

    this.messageLog.push(message);
    const now = Date.now();
    const networkDelaySec = Math.max(0, (now - message.hostTimestamp) / 1000);

    let adjustedTime = message.state.currentTime;
    if (message.state.isPlaying && networkDelaySec > 0.1) {
      adjustedTime += networkDelaySec;
    }

    this.lastReceivedState = {
      ...message.state,
      currentTime: adjustedTime
    };

    return {
      adjustedTime,
      isPlaying: message.state.isPlaying
    };
  }
}
