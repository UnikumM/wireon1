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
import { useGroupListenStore } from '../store/useGroupListenStore';
import { GroupListenService } from './groupListenService';
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
  /** Кнопки под активностью. Их видят друзья, а не сам владелец статуса. */
  buttons?: { label: string; url: string }[];
  statusDisplayType?: 0 | 1 | 2;
  detailsUrl?: string;
  stateUrl?: string;
  largeUrl?: string;
  smallUrl?: string;
  party?: { id: string; size?: [number, number] };
  joinSecret?: string;
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
export const DISCORD_PRESENCE_OPTIONS_KEY = 'discordPresenceOptions';

/** Что видно в списке участников сервера рядом с вашим именем. */
export type DiscordStatusDisplay = 'app' | 'artist' | 'track';

/**
 * Настройки подробной активности — как у Spotify.
 *
 * Кнопок Discord разрешает две, и обе здесь: «Слушать» ведёт на сам трек,
 * «Скачать Wireon» — на страницу последнего выпуска, чтобы друг мог поставить
 * себе то же приложение.
 */
export interface DiscordPresenceOptions {
  listenButton: boolean;
  downloadButton: boolean;
  /** Полоса «сколько отыграно из скольких». */
  showProgress: boolean;
  statusDisplay: DiscordStatusDisplay;
  /**
   * В комнате совместного прослушивания — приглашение вместо кнопок: друзья
   * видят «Присоединиться», а в чате Discord можно позвать послушать вместе.
   */
  listenTogether: boolean;
}

export const DEFAULT_PRESENCE_OPTIONS: DiscordPresenceOptions = {
  listenButton: true,
  downloadButton: true,
  showProgress: true,
  statusDisplay: 'track',
  listenTogether: true
};

/** Приставка секрета присоединения — чтобы не принять чужой секрет за код. */
const JOIN_SECRET_PREFIX = 'wireon-room:';

/** Сколько мест показывать в комнате. Discord требует число, больше него не пустит. */
const ROOM_CAPACITY = 16;

/** Код комнаты из секрета, или null, если секрет не наш. */
export function roomCodeFromJoinSecret(secret: string): string | null {
  if (typeof secret !== 'string' || !secret.startsWith(JOIN_SECRET_PREFIX)) return null;
  try {
    return GroupListenService.sanitizeRoomCode(secret.slice(JOIN_SECRET_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

/** Куда ведёт «Скачать Wireon». */
export const WIREON_DOWNLOAD_URL = 'https://github.com/UnikumM/wireon1/releases/latest';

/**
 * Маленький значок у обложки — значок Wireon по прямой ссылке.
 *
 * Ссылкой, а не ключом: ключ работает только для картинок, заранее
 * загруженных в заявку Discord, а ссылку Discord забирает к себе сам — так же,
 * как обложку.
 */
export const WIREON_ICON_URL = 'https://raw.githubusercontent.com/UnikumM/wireon1/main/public/icon.png';

const STATUS_DISPLAY_CODE: Record<DiscordStatusDisplay, 0 | 1 | 2> = { app: 0, artist: 1, track: 2 };

/** Страница поиска исполнителя у того же источника — для щелчка по имени. */
function artistSearchUrl(track: UnifiedTrack): string | undefined {
  const artist = (track.artist || '').trim();
  if (!artist || artist === UNKNOWN_ARTIST) return undefined;
  const q = encodeURIComponent(artist);
  return track.source === 'soundcloud'
    ? `https://soundcloud.com/search/people?q=${q}`
    : `https://music.youtube.com/search?q=${q}`;
}

export class DiscordRpcService {
  private enabled = true;
  private options: DiscordPresenceOptions = { ...DEFAULT_PRESENCE_OPTIONS };
  private isInitialized = false;
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeGroup: (() => void) | null = null;
  private unsubscribeJoin: (() => void) | null = null;
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

    try {
      const saved = await dbService.getSetting<Partial<DiscordPresenceOptions>>(DISCORD_PRESENCE_OPTIONS_KEY, {});
      this.options = { ...DEFAULT_PRESENCE_OPTIONS, ...(saved || {}) };
    } catch {
      this.options = { ...DEFAULT_PRESENCE_OPTIONS };
    }

    if (this.isDesktop()) {
      void window.electronAPI?.discordRpcSetEnabled(this.enabled);
    }

    // Subscribe to Player Store changes
    this.unsubscribeStore = usePlayerStore.subscribe((state, previous) => {
      // Сменили скорость — отметки времени в статусе пересчитываются сразу.
      if (state.playbackRate !== previous?.playbackRate && state.currentTrack && state.isPlaying) {
        this.syncActivity(state.currentTrack, true, state.currentTime, state.duration, true);
        return;
      }
      this.handleStoreUpdate(state.currentTrack, state.isPlaying, state.currentTime, state.duration);
    });

    // Вошли в комнату или вышли из неё — приглашение в статусе меняется.
    this.unsubscribeGroup = useGroupListenStore.subscribe((group, previous) => {
      if (
        group.roomId === previous.roomId &&
        group.connectionStatus === previous.connectionStatus &&
        group.participants.length === previous.participants.length
      ) {
        return;
      }
      const player = usePlayerStore.getState();
      if (player.currentTrack && player.isPlaying) {
        this.syncActivity(player.currentTrack, true, player.currentTime, player.duration, true);
      }
    });

    // Друг нажал «Присоединиться» у вас в статусе — входим в вашу комнату.
    this.unsubscribeJoin =
      window.electronAPI?.onDiscordJoin?.((secret) => {
        const code = roomCodeFromJoinSecret(secret);
        if (!code) return;
        const group = useGroupListenStore.getState();
        group.setModalOpen(true);
        if (group.roomId === code) return;
        if (group.roomId) group.leaveRoom();
        void group.joinRoom(code);
      }) ?? null;

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

  public getOptions(): DiscordPresenceOptions {
    return { ...this.options };
  }

  /** Меняет вид активности и сразу показывает его в Discord. */
  public async setOptions(partial: Partial<DiscordPresenceOptions>): Promise<void> {
    this.options = { ...this.options, ...partial };
    try {
      await dbService.setSetting(DISCORD_PRESENCE_OPTIONS_KEY, this.options);
    } catch (err) {
      console.warn('[DiscordRpcService] Failed to persist presence options:', err);
    }
    const state = usePlayerStore.getState();
    if (this.enabled && state.currentTrack && state.isPlaying) {
      this.syncActivity(state.currentTrack, state.isPlaying, state.currentTime, state.duration, true);
    }
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

    /*
     * Отметки времени — в настоящих секундах, а не в секундах трека.
     *
     * Discord отсчитывает их по часам и замедлить не умеет. При скорости 0,8
     * («slowed» кнопкой темпа) секунды в статусе бежали быстрее песни, и полоса
     * доходила до конца раньше неё. Поэтому позиция и длина делятся на
     * скорость: трек на 3:12 при 0,8 показывается как 4:00 и заканчивается
     * вместе с музыкой.
     */
    const rawRate = Number(usePlayerStore.getState().playbackRate);
    const rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
    const nowSec = Math.floor(Date.now() / 1000);
    const currentSec = Math.max(0, Math.floor(currentTime / rate));
    const durationSec = Math.max(0, Math.floor((durationOverride ?? track.duration ?? 0) / rate));

    /*
     * Кнопки — то, чем статус Spotify отличается от простой подписи: с них
     * можно послушать то же самое. «Слушать» ведёт на трек у источника (если
     * ссылки нет, кнопки не будет), «Скачать Wireon» — на последний выпуск.
     */
    const options = this.options;
    const sourceUrl = /^https?:\/\//i.test((track.sourceUrl || '').trim()) ? track.sourceUrl!.trim() : undefined;
    const buttons: { label: string; url: string }[] = [];
    if (options.listenButton && sourceUrl) buttons.push({ label: 'Слушать', url: sourceUrl });
    if (options.downloadButton) buttons.push({ label: 'Скачать Wireon', url: WIREON_DOWNLOAD_URL });
    const sourceName = track.source === 'soundcloud' ? 'SoundCloud' : 'YouTube';

    const payload: DiscordActivityPayload = {
      details: title,
      state,
      ...(buttons.length > 0 ? { buttons } : {}),
      statusDisplayType: STATUS_DISPLAY_CODE[options.statusDisplay] ?? 2,
      ...(sourceUrl ? { detailsUrl: sourceUrl, largeUrl: sourceUrl } : {}),
      ...(artistSearchUrl(track) ? { stateUrl: artistSearchUrl(track) } : {}),
      largeImageKey: track.artworkUrl || 'wireon_logo',
      largeImageText: (track.album || 'Wireon').slice(0, 128),
      smallImageKey: WIREON_ICON_URL,
      // Значок Wireon ведёт на скачивание — его, в отличие от кнопок, видит
      // и сам владелец статуса.
      smallUrl: WIREON_DOWNLOAD_URL,
      // Значка «играет/пауза» здесь нет намеренно. В маленький слот идёт не
      // картинка, а **ключ** заранее загруженной в заявку картинки, и ключей
      // `play_icon`/`pause_icon` там никогда не было: Discord молча выбрасывал
      // их из каждой активности. Проверено вживую — в ответе `SET_ACTIVITY`
      // маленького значка нет, только подпись. Большая обложка проходит
      // потому, что это ссылка: её Discord перекладывает к себе сам
      // (`mp:external/…`).
      smallImageText: `Wireon Sounds · ${sourceName} · скачать бесплатно`,
      instance: false,
      assets: {
        large_image: track.artworkUrl || 'wireon_logo',
        large_text: (track.album || 'Wireon').slice(0, 128),
        small_image: WIREON_ICON_URL,
        small_text: `Wireon Sounds · ${sourceName} · скачать бесплатно`
      }
    };

    /*
     * В комнате — приглашение. Discord не принимает его вместе с кнопками,
     * поэтому кнопки на это время уходят (форматирование в главном процессе
     * отбрасывает их само), а «Скачать» остаётся на значке.
     */
    const group = useGroupListenStore.getState();
    if (options.listenTogether && group.roomId && group.connectionStatus === 'online') {
      payload.party = {
        id: `wireon-${group.roomId}`,
        size: [Math.max(1, group.participants.length), Math.max(ROOM_CAPACITY, group.participants.length)]
      };
      payload.joinSecret = `${JOIN_SECRET_PREFIX}${group.roomId}`;
    }

    if (!options.showProgress) return payload;

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
    // Позиция трека идёт со скоростью воспроизведения, а не секунда в секунду.
    const rate = Number(usePlayerStore.getState().playbackRate) || 1;
    const expectedPosition = isPlaying
      ? this.lastEstimatedPosition + elapsedSinceLast * rate
      : this.lastEstimatedPosition;
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
    this.unsubscribeGroup?.();
    this.unsubscribeGroup = null;
    this.unsubscribeJoin?.();
    this.unsubscribeJoin = null;
    this.isInitialized = false;
  }
}

export const discordRpcService = new DiscordRpcService();

if (typeof window !== 'undefined') {
  void discordRpcService.init();
}

export default discordRpcService;
