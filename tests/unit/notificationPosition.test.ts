/**
 * Полоса в системном уведомлении Android (4.0.2).
 *
 * Жалоба: в шторке «00:00 / 00:00», полоса стоит. До системы не доходили ни
 * длительность, ни позиция: нативная сессия сообщала «позиция неизвестна», а
 * JS-обновление выходило раньше времени, потому что в Android WebView нет
 * `navigator.mediaSession`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  onBackgroundAudioCommand,
  resetBackgroundAudio,
  updateBackgroundAudioPosition
} from '../../src/services/backgroundAudio';
import { MediaSessionService } from '../../src/services/mediaSession';
import type { UnifiedTrack } from '../../src/types/music';

const REAL_ELECTRON = (window as unknown as { electronAPI?: unknown }).electronAPI;

function pretendPhone() {
  const listeners: Array<(payload: { command?: string }) => void> = [];
  const native = {
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    setPosition: vi.fn(async () => ({ ok: true })),
    addListener: (_event: string, handler: (payload: { command?: string }) => void) => {
      listeners.push(handler);
      return { remove: () => undefined };
    }
  };
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: { BackgroundAudio: native }
  };
  return { native, emit: (command: string) => listeners.forEach((handler) => handler({ command })) };
}

const sc: UnifiedTrack = { id: 'sc_1', source: 'soundcloud', originalId: '1', title: 'Эгоизм', artist: 'Noize MC', duration: 215, artworkUrl: '' };

beforeEach(() => {
  resetBackgroundAudio();
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  (window as unknown as { electronAPI?: unknown }).electronAPI = REAL_ELECTRON;
  resetBackgroundAudio();
  vi.restoreAllMocks();
});

describe('позиция для уведомления', () => {
  it('первое сообщение уходит, обычное течение времени — нет', () => {
    const { native } = pretendPhone();
    const t0 = 1_000_000;
    updateBackgroundAudioPosition({ duration: 215, position: 10, rate: 1, playing: true }, t0);
    // Четыре тика в секунду, плеер идёт ровно — системе говорить нечего.
    updateBackgroundAudioPosition({ duration: 215, position: 10.25, rate: 1, playing: true }, t0 + 250);
    updateBackgroundAudioPosition({ duration: 215, position: 12.0, rate: 1, playing: true }, t0 + 2000);
    updateBackgroundAudioPosition({ duration: 215, position: 40.1, rate: 1, playing: true }, t0 + 30_000);

    expect(native.setPosition).toHaveBeenCalledTimes(1);
    expect(native.setPosition).toHaveBeenCalledWith({ duration: 215, position: 10, rate: 1, playing: true });
  });

  it('перемотка, пауза, скорость и новая длительность уходят сразу', () => {
    const { native } = pretendPhone();
    const t0 = 2_000_000;
    updateBackgroundAudioPosition({ duration: 215, position: 10, rate: 1, playing: true }, t0);

    updateBackgroundAudioPosition({ duration: 215, position: 120, rate: 1, playing: true }, t0 + 1000);
    expect(native.setPosition).toHaveBeenLastCalledWith({ duration: 215, position: 120, rate: 1, playing: true });

    updateBackgroundAudioPosition({ duration: 215, position: 121, rate: 1, playing: false }, t0 + 2000);
    expect(native.setPosition).toHaveBeenLastCalledWith({ duration: 215, position: 121, rate: 1, playing: false });

    // На паузе время не идёт: та же позиция через минуту — не новость.
    updateBackgroundAudioPosition({ duration: 215, position: 121, rate: 1, playing: false }, t0 + 62_000);
    expect(native.setPosition).toHaveBeenCalledTimes(3);

    updateBackgroundAudioPosition({ duration: 215, position: 121, rate: 1.5, playing: false }, t0 + 63_000);
    updateBackgroundAudioPosition({ duration: 218, position: 121, rate: 1.5, playing: false }, t0 + 64_000);
    expect(native.setPosition).toHaveBeenCalledTimes(5);
  });

  it('неизвестная длительность уходит нулём (полоса скрыта), позиция не обгоняет длительность', () => {
    const { native } = pretendPhone();
    updateBackgroundAudioPosition({ duration: Infinity, position: 5, rate: 1, playing: true }, 1);
    expect(native.setPosition).toHaveBeenLastCalledWith({ duration: 0, position: 5, rate: 1, playing: true });

    updateBackgroundAudioPosition({ duration: 100, position: 500, rate: 1, playing: true }, 2);
    expect(native.setPosition).toHaveBeenLastCalledWith({ duration: 100, position: 100, rate: 1, playing: true });

    updateBackgroundAudioPosition({ duration: NaN, position: -3, rate: 0, playing: false }, 3);
    expect(native.setPosition).toHaveBeenLastCalledWith({ duration: 0, position: 0, rate: 1, playing: false });
  });

  it('вне телефона и на старом APK без setPosition — молча ничего', () => {
    expect(() => updateBackgroundAudioPosition({ duration: 10, position: 1, rate: 1, playing: true })).not.toThrow();

    const { native } = pretendPhone();
    delete (native as { setPosition?: unknown }).setPosition;
    expect(() => updateBackgroundAudioPosition({ duration: 10, position: 1, rate: 1, playing: true })).not.toThrow();
  });

  it('перемотка из шторки приходит секундами', () => {
    const { emit } = pretendPhone();
    const handler = vi.fn();
    onBackgroundAudioCommand(handler);

    emit('seek:93500');
    emit('next');
    emit('seek:мусор');

    expect(handler).toHaveBeenNthCalledWith(1, 'seek', 93.5);
    expect(handler).toHaveBeenNthCalledWith(2, 'next');
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('плеер доводит позицию до нативной службы', () => {
  it('без navigator.mediaSession (Android WebView) позиция всё равно уходит', () => {
    const { native } = pretendPhone();
    const real = Object.getOwnPropertyDescriptor(navigator, 'mediaSession');
    Object.defineProperty(navigator, 'mediaSession', { value: undefined, configurable: true });
    try {
      MediaSessionService.updateMetadata(sc);
      // Новый трек: длительность из сведений о треке, позиция ноль, ещё не играет.
      expect(native.setPosition).toHaveBeenLastCalledWith({ duration: 215, position: 0, rate: 1, playing: false });

      MediaSessionService.updatePlaybackState('playing');
      expect(native.setPosition).toHaveBeenLastCalledWith({ duration: 215, position: 0, rate: 1, playing: true });

      // Поток HLS: у аудио длительности ещё нет — стор подставляет известную.
      MediaSessionService.updatePositionState(215, 64, 1);
      expect(native.setPosition).toHaveBeenLastCalledWith({ duration: 215, position: 64, rate: 1, playing: true });

      MediaSessionService.updatePlaybackState('paused');
      expect(native.setPosition).toHaveBeenLastCalledWith({ duration: 215, position: 64, rate: 1, playing: false });
    } finally {
      if (real) Object.defineProperty(navigator, 'mediaSession', real);
      MediaSessionService.updateMetadata(null);
      MediaSessionService.updatePlaybackState('idle');
    }
  });
});
