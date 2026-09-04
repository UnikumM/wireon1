import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../setup';
import { MediaSessionService, MediaSessionCallbacks } from '../../src/services/mediaSession';
import { UnifiedTrack } from '../../src/types/music';

const mockTrack: UnifiedTrack = {
  id: 'yt_bohemian',
  source: 'youtube',
  originalId: 'bohemian',
  title: 'Bohemian Rhapsody',
  artist: 'Queen',
  album: 'A Night at the Opera',
  duration: 354,
  artworkUrl: 'https://example.com/bohemian.jpg'
};

describe('MediaSessionService (W3C MediaSession API)', () => {
  beforeEach(() => {
    MediaSessionService.clear();
  });

  it('updates metadata with track title, artist, album, and multi-resolution artwork', () => {
    MediaSessionService.updateMetadata(mockTrack);

    const metadata = navigator.mediaSession.metadata;
    expect(metadata).toBeDefined();
    expect(metadata?.title).toBe('Bohemian Rhapsody');
    expect(metadata?.artist).toBe('Queen');
    expect(metadata?.album).toBe('A Night at the Opera');
    expect(metadata?.artwork).toHaveLength(4);
    expect(metadata?.artwork[0].sizes).toBe('96x96');
    expect(metadata?.artwork[1].sizes).toBe('128x128');
    expect(metadata?.artwork[2].sizes).toBe('256x256');
    expect(metadata?.artwork[3].sizes).toBe('512x512');
  });

  it('resets metadata when track is null', () => {
    MediaSessionService.updateMetadata(mockTrack);
    expect(navigator.mediaSession.metadata).not.toBeNull();

    MediaSessionService.updateMetadata(null);
    expect(navigator.mediaSession.metadata).toBeNull();
  });

  it('updates playbackState correctly based on player state', () => {
    MediaSessionService.updatePlaybackState('playing');
    expect(navigator.mediaSession.playbackState).toBe('playing');

    // The OS must not claim the track is playing while the stream resolves
    MediaSessionService.updatePlaybackState('loading');
    expect(navigator.mediaSession.playbackState).toBe('paused');

    MediaSessionService.updatePlaybackState('buffering');
    expect(navigator.mediaSession.playbackState).toBe('paused');

    MediaSessionService.updatePlaybackState('paused');
    expect(navigator.mediaSession.playbackState).toBe('paused');

    MediaSessionService.updatePlaybackState('idle');
    expect(navigator.mediaSession.playbackState).toBe('none');

    MediaSessionService.updatePlaybackState('error');
    expect(navigator.mediaSession.playbackState).toBe('none');
  });

  it('only reports "playing" after the stream actually started', () => {
    // Typical commit sequence: loading -> playing
    MediaSessionService.updatePlaybackState('loading');
    expect(navigator.mediaSession.playbackState).not.toBe('playing');

    MediaSessionService.updatePlaybackState('playing');
    expect(navigator.mediaSession.playbackState).toBe('playing');

    // Failed stream sequence: loading -> error
    MediaSessionService.updatePlaybackState('loading');
    MediaSessionService.updatePlaybackState('error');
    expect(navigator.mediaSession.playbackState).toBe('none');
  });

  it('updates position state safely and clamps values', () => {
    MediaSessionService.updatePositionState(354, 45, 1);
    const posState = (navigator.mediaSession as any).positionState;
    expect(posState).toBeDefined();
    expect(posState?.duration).toBe(354);
    expect(posState?.position).toBe(45);
    expect(posState?.playbackRate).toBe(1);

    // Position exceeds duration -> clamped
    MediaSessionService.updatePositionState(200, 250);
    const clampedState = (navigator.mediaSession as any).positionState;
    expect(clampedState?.position).toBe(200);

    // Invalid numbers -> ignored safely
    MediaSessionService.updatePositionState(NaN, 10);
    expect((navigator.mediaSession as any).positionState?.duration).toBe(200);
  });

  it('registers action handlers and handles media key events', () => {
    const callbacks: MediaSessionCallbacks = {
      onPlay: vi.fn(),
      onPause: vi.fn(),
      onNext: vi.fn(),
      onPrev: vi.fn(),
      onSeek: vi.fn(),
      onStop: vi.fn()
    };

    MediaSessionService.registerActionHandlers(callbacks);

    const mockSession = navigator.mediaSession as any;
    mockSession.triggerAction('play');
    expect(callbacks.onPlay).toHaveBeenCalledTimes(1);

    mockSession.triggerAction('pause');
    expect(callbacks.onPause).toHaveBeenCalledTimes(1);

    mockSession.triggerAction('nexttrack');
    expect(callbacks.onNext).toHaveBeenCalledTimes(1);

    mockSession.triggerAction('previoustrack');
    expect(callbacks.onPrev).toHaveBeenCalledTimes(1);

    mockSession.triggerAction('seekto', { seekTime: 120 });
    expect(callbacks.onSeek).toHaveBeenCalledWith(120);

    mockSession.triggerAction('stop');
    expect(callbacks.onStop).toHaveBeenCalledTimes(1);
  });

  it('clears all handlers and state', () => {
    MediaSessionService.updateMetadata(mockTrack);
    MediaSessionService.updatePlaybackState('playing');
    MediaSessionService.clear();

    expect(navigator.mediaSession.metadata).toBeNull();
    expect(navigator.mediaSession.playbackState).toBe('none');
    expect((navigator.mediaSession as any).actionHandlers.size).toBe(0);
  });
});
