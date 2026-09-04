import { UnifiedTrack, PlaybackState } from '../types/music';
import { startBackgroundAudio, stopBackgroundAudio } from './backgroundAudio';

export interface MediaSessionCallbacks {
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeek: (position: number) => void;
  getCurrentPosition?: () => number;
  onStop?: () => void;
}

export class MediaSessionService {
  /**
   * Что сейчас играет — для уведомления фонового режима.
   *
   * Хранится здесь, а не передаётся вызывающими, потому что метаданные и
   * состояние приходят разными вызовами из разных мест плеера, а уведомлению
   * нужно и то и другое сразу. Иначе на смене трека уведомление показывало бы
   * прошлое название до первой смены состояния.
   */
  private static nowPlaying: { title: string; artist: string; artwork: string } | null = null;

  private static get isSupported(): boolean {
    return typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'mediaSession' in navigator;
  }

  /**
   * Updates OS media notification metadata (Title, Artist, Album, HD Artwork)
   */
  public static updateMetadata(track: UnifiedTrack | null): void {
    /*
     * Запоминаем раньше проверки поддержки, и это не перестановка ради
     * порядка. Проверено на эмуляторе 2026-08-28: в Android WebView
     * `navigator.mediaSession` отсутствует вовсе — это возможность Chrome, а
     * не WebView, — поэтому ранний выход оставлял `nowPlaying` пустым
     * навсегда. А раз пусто, `updatePlaybackState` каждый раз считал, что
     * играть нечего, и вместо включения фонового режима выключал его. Служба
     * при этом была полностью исправна: вызванная руками через мост, она
     * поднималась с уведомлением и тремя кнопками.
     *
     * Отсюда правило: `nowPlaying` — наше состояние для нашей же нативной
     * службы, и от наличия браузерного API оно зависеть не должно.
     */
    this.nowPlaying = track
      ? { title: track.title, artist: track.artist, artwork: track.artworkUrl || '' }
      : null;

    if (!this.isSupported) return;

    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }

    try {
      const artworkSrc = track.artworkUrl || '/icon.svg';
      const artworkList = [
        { src: artworkSrc, sizes: '96x96', type: 'image/png' },
        { src: artworkSrc, sizes: '128x128', type: 'image/png' },
        { src: artworkSrc, sizes: '256x256', type: 'image/png' },
        { src: artworkSrc, sizes: '512x512', type: 'image/png' }
      ];

      if (typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: track.album || 'Wireon Sounds',
          artwork: artworkList
        });
      }
    } catch (err) {
      console.warn('[MediaSession] Failed to update metadata:', err);
    }
  }

  /**
   * Updates playback state for OS controls ('none' | 'paused' | 'playing').
   * Loading and buffering are reported as 'paused': the OS must not claim the
   * track is playing while the stream is still being resolved.
   */
  public static updatePlaybackState(state: PlaybackState | 'none' | 'paused' | 'playing'): void {
    let mappedState: 'none' | 'paused' | 'playing' = 'none';

    if (state === 'playing') {
      mappedState = 'playing';
    } else if (state === 'paused' || state === 'loading' || state === 'buffering') {
      mappedState = 'paused';
    } else {
      mappedState = 'none';
    }

    /*
     * Фоновый режим Android живёт на том же переходе, что и системный пульт.
     *
     * Здесь, а не в сторе плеера, потому что этот метод уже зовут все переходы:
     * запуск, пауза, ошибка, конец очереди. Разложить те же вызовы по десятку
     * мест в сторе значило бы завести десяток мест, где о фоновом режиме можно
     * забыть.
     *
     * Уведомление держится на паузе тоже: снятое, оно уносит с собой и пульт на
     * экране блокировки — а пауза не значит, что слушать перестали.
     */
    if (mappedState === 'none' || !this.nowPlaying) {
      void stopBackgroundAudio();
    } else {
      void startBackgroundAudio({
        title: this.nowPlaying.title,
        artist: this.nowPlaying.artist,
        artwork: this.nowPlaying.artwork,
        playing: mappedState === 'playing'
      });
    }

    if (!this.isSupported) return;

    try {
      navigator.mediaSession.playbackState = mappedState;
    } catch (err) {
      console.warn('[MediaSession] Failed to update playback state:', err);
    }
  }

  /**
   * Updates position and duration state in OS timeline
   */
  public static updatePositionState(duration: number, currentTime: number, playbackRate = 1): void {
    if (!this.isSupported || typeof navigator.mediaSession.setPositionState !== 'function') {
      return;
    }

    if (Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime) && currentTime >= 0) {
      try {
        const clampedPos = Math.min(Math.max(0, currentTime), duration);
        navigator.mediaSession.setPositionState({
          duration: Math.max(0, duration),
          playbackRate: playbackRate,
          position: clampedPos
        });
      } catch (err) {
        console.warn('[MediaSession] Position state update ignored:', err);
      }
    }
  }

  /**
   * Registers OS action handlers for hardware media keys & OS overlays
   */
  public static registerActionHandlers(callbacks: MediaSessionCallbacks): void {
    if (!this.isSupported) return;

    const actionMap: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => callbacks.onPlay()],
      ['pause', () => callbacks.onPause()],
      ['previoustrack', () => callbacks.onPrev()],
      ['nexttrack', () => callbacks.onNext()],
      [
        'seekto',
        (details) => {
          if (details.seekTime !== undefined && Number.isFinite(details.seekTime)) {
            callbacks.onSeek(details.seekTime);
          }
        }
      ],
      [
        'seekbackward',
        (details) => {
          const offset = details.seekOffset || 10;
          const currentPos = callbacks.getCurrentPosition ? callbacks.getCurrentPosition() : 0;
          callbacks.onSeek(Math.max(0, currentPos - offset));
        }
      ],
      [
        'seekforward',
        (details) => {
          const offset = details.seekOffset || 10;
          const currentPos = callbacks.getCurrentPosition ? callbacks.getCurrentPosition() : 0;
          callbacks.onSeek(currentPos + offset);
        }
      ],
      [
        'stop',
        () => {
          if (callbacks.onStop) {
            callbacks.onStop();
          } else {
            callbacks.onPause();
          }
        }
      ]
    ];

    actionMap.forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (err) {
        // Platform may not support all actions
      }
    });
  }

  /**
   * Clears action handlers and resets media metadata
   */
  public static clear(): void {
    if (!this.isSupported) return;

    const actions: MediaSessionAction[] = [
      'play',
      'pause',
      'previoustrack',
      'nexttrack',
      'seekto',
      'seekbackward',
      'seekforward',
      'stop'
    ];

    actions.forEach((action) => {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        // Ignored
      }
    });

    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      if (typeof navigator.mediaSession.setPositionState === 'function') {
        navigator.mediaSession.setPositionState();
      }
    } catch {
      // Ignored
    }
  }
}
