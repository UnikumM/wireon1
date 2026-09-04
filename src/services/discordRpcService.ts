/**
 * Discord Rich Presence (RPC) Renderer Service
 *
 * Synchronizes Wireon player store state (`usePlayerStore`) with
 * the Electron Discord Rich Presence IPC bridge (`window.electronAPI.discordRpcSetActivity`).
 *
 * Features:
 * - Subscribes to track, playbackState, and progress updates
 * - Formats activity payloads with title, artist, artwork, timestamps & play/pause state
 * - Debounces rapid progress events while immediately dispatching track changes & state flips
 * - Persists and respects user toggle preference from `WireonDB.settings` ('discordRpcEnabled')
 * - Safe for non-Electron / browser environments
 */

import { usePlayerStore } from '../store/usePlayerStore';
import { UnifiedTrack } from '../types/music';
import * as dbService from './db';
import { UNKNOWN_ARTIST, UNKNOWN_TITLE } from '../utils/placeholders';

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
  timestamps?: {
    start?: number;
    end?: number;
  };
  assets?: {
    large_image?: string;
    large_text?: string;
    small_image?: string;
    small_text?: string;
  };
}

export const DISCORD_RPC_SETTING_KEY = 'discordRpcEnabled';

export class DiscordRpcService {
  private enabled = true;
  private isInitialized = false;
  private unsubscribeStore: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTrackId: string | null = null;
  private lastIsPlaying: boolean | null = null;
  private lastSentPayload: DiscordActivityPayload | null = null;
  private lastSentTime = 0;
  private lastEstimatedPosition = 0;

  constructor() {
    // Initialized via init()
  }

  /**
   * Initializes the service, hydrates settings, and starts store subscription
   */
  public async init(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Hydrate enabled setting from IndexedDB
    try {
      const persisted = await dbService.getSetting<boolean>(DISCORD_RPC_SETTING_KEY, true);
      this.enabled = persisted !== false;
    } catch {
      this.enabled = true;
    }

    if (this.isDesktop()) {
      void window.electronAPI?.discordRpcSetEnabled(this.enabled);
    }

    // Subscribe to Player Store changes
    this.unsubscribeStore = usePlayerStore.subscribe((state) => {
      this.handleStoreUpdate(state.currentTrack, state.isPlaying, state.currentTime, state.duration);
    });

    // Initial sync
    const currentState = usePlayerStore.getState();
    if (currentState.currentTrack) {
      this.syncActivity(currentState.currentTrack, currentState.isPlaying, currentState.currentTime, currentState.duration);
    }
  }

  public isDesktop(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.electronAPI !== 'undefined' &&
      typeof window.electronAPI.discordRpcSetActivity === 'function'
    );
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getLastSentPayload(): DiscordActivityPayload | null {
    return this.lastSentPayload;
  }

  /**
   * Sets enabled state, updates DB, and updates Discord presence
   */
  public async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;

    try {
      await dbService.setSetting(DISCORD_RPC_SETTING_KEY, enabled);
    } catch (err) {
      console.warn('[DiscordRpcService] Failed to persist setting:', err);
    }

    if (this.isDesktop()) {
      try {
        await window.electronAPI?.discordRpcSetEnabled(enabled);
      } catch (err) {
        console.warn('[DiscordRpcService] Failed to forward setEnabled to Electron:', err);
      }
    }

    if (!enabled) {
      this.clearActivity();
    } else {
      const state = usePlayerStore.getState();
      if (state.currentTrack) {
        this.syncActivity(state.currentTrack, state.isPlaying, state.currentTime, state.duration, true);
      }
    }
  }

  /**
   * Builds formatted DiscordActivityPayload from track and playback state
   */
  public buildPayloadFromTrack(
    track: UnifiedTrack | null,
    isPlaying: boolean,
    currentTime: number = 0,
    durationOverride?: number
  ): DiscordActivityPayload | null {
    if (!track || !this.enabled) {
      return null;
    }

    const title = (track.title || UNKNOWN_TITLE).slice(0, 128);
    const rawArtist = track.artist || UNKNOWN_ARTIST;
    const state = rawArtist.slice(0, 128);

    const nowSec = Math.floor(Date.now() / 1000);
    const currentSec = Math.max(0, Math.floor(currentTime));
    const durationSec = Math.max(0, Math.floor(durationOverride ?? track.duration ?? 0));

    const payload: DiscordActivityPayload = {
      details: title,
      state,
      largeImageKey: track.artworkUrl || 'wireon_logo',
      largeImageText: (track.album || 'Wireon').slice(0, 128),
      // Значка «играет/пауза» здесь нет намеренно. В маленький слот идёт не
      // картинка, а **ключ** заранее загруженной в заявку картинки, и ключей
      // `play_icon`/`pause_icon` там никогда не было: Discord молча выбрасывал
      // их из каждой активности. Проверено вживую — в ответе `SET_ACTIVITY`
      // маленького значка нет, только подпись. Большая обложка проходит
      // потому, что это ссылка: её Discord перекладывает к себе сам
      // (`mp:external/…`).
      smallImageText: isPlaying ? 'Играет' : 'Пауза',
      instance: false,
      assets: {
        large_image: track.artworkUrl || 'wireon_logo',
        large_text: (track.album || 'Wireon').slice(0, 128),
        small_text: isPlaying ? 'Играет' : 'Пауза'
      }
    };

    if (isPlaying && durationSec > 0) {
      payload.startTimestamp = nowSec - currentSec;
      payload.endTimestamp = payload.startTimestamp + durationSec;
      payload.timestamps = {
        start: Date.now() - currentSec * 1000,
        end: Date.now() + (durationSec - currentSec) * 1000
      };
    } else if (isPlaying) {
      payload.startTimestamp = nowSec - currentSec;
      payload.timestamps = {
        start: Date.now() - currentSec * 1000
      };
    }

    return payload;
  }

  /**
   * Sends activity update to Electron preload IPC bridge
   */
  public async setActivity(payload: DiscordActivityPayload | null): Promise<boolean> {
    if (!this.enabled) {
      this.lastSentPayload = null;
      return false;
    }

    this.lastSentPayload = payload;
    this.lastSentTime = Date.now();

    if (!this.isDesktop()) {
      return false;
    }

    try {
      return (await window.electronAPI?.discordRpcSetActivity(payload)) ?? false;
    } catch (err) {
      console.warn('[DiscordRpcService] Failed to set activity:', err);
      return false;
    }
  }

  /**
   * Clears Discord presence
   */
  public async clearActivity(): Promise<boolean> {
    this.lastSentPayload = null;
    this.lastTrackId = null;
    this.lastIsPlaying = null;

    if (!this.isDesktop()) {
      return false;
    }

    try {
      return (await window.electronAPI?.discordRpcSetActivity(null)) ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Handles state changes from usePlayerStore
   */
  private handleStoreUpdate(
    track: UnifiedTrack | null,
    isPlaying: boolean,
    currentTime: number,
    duration: number
  ): void {
    if (!track) {
      if (this.lastTrackId !== null) {
        this.clearActivity();
      }
      return;
    }

    const trackChanged = track.id !== this.lastTrackId;
    const isPlayingChanged = isPlaying !== this.lastIsPlaying;

    // Check for manual seek jump (> 2.5 seconds difference from expected linear progression)
    const elapsedSinceLast = (Date.now() - this.lastSentTime) / 1000;
    const expectedPosition = isPlaying ? this.lastEstimatedPosition + elapsedSinceLast : this.lastEstimatedPosition;
    const isSignificantSeek = Math.abs(currentTime - expectedPosition) > 2.5;

    if (trackChanged || isPlayingChanged) {
      // Immediate update for critical transitions
      this.cancelDebounce();
      this.syncActivity(track, isPlaying, currentTime, duration, true);
    } else if (isSignificantSeek) {
      // Debounce seek updates slightly to avoid spamming slider drags
      this.scheduleDebounce(track, isPlaying, currentTime, duration, 300);
    }
  }

  private scheduleDebounce(
    track: UnifiedTrack,
    isPlaying: boolean,
    currentTime: number,
    duration: number,
    delayMs: number
  ): void {
    this.cancelDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.syncActivity(track, isPlaying, currentTime, duration);
    }, delayMs);
  }

  private cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private syncActivity(
    track: UnifiedTrack,
    isPlaying: boolean,
    currentTime: number,
    duration: number,
    force = false
  ): void {
    this.lastEstimatedPosition = currentTime;

    if (!this.enabled && !force) {
      this.lastTrackId = track.id;
      this.lastIsPlaying = isPlaying;
      return;
    }

    /*
     * На паузе статус снимается, а не остаётся висеть.
     *
     * Раньше сюда уходила та же активность, только без отметок времени, и
     * Discord честно показывал «слушает» у человека, который ничего не слушает.
     * Владелец сказал прямо: «когда вырубишь песню, пишется что слушаешь».
     *
     * `lastTrackId` при этом обнуляется намеренно: после снятия статуса
     * следующее нажатие play обязано выглядеть как смена трека, иначе
     * `handleStoreUpdate` посчитает, что ничего не изменилось, и статус не
     * вернётся вовсе.
     */
    if (!isPlaying) {
      this.lastIsPlaying = false;
      void this.clearActivity();
      return;
    }

    this.lastTrackId = track.id;
    this.lastIsPlaying = isPlaying;

    const payload = this.buildPayloadFromTrack(track, isPlaying, currentTime, duration);
    void this.setActivity(payload);
  }

  /**
   * Destroys store subscription and timers
   */
  public destroy(): void {
    this.cancelDebounce();
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    this.isInitialized = false;
  }
}

export const discordRpcService = new DiscordRpcService();

if (typeof window !== 'undefined') {
  void discordRpcService.init();
}

export default discordRpcService;
