import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import '../setup';

import { WaveVisualizerOrb } from '../../src/components/wave/WaveVisualizerOrb';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { audioEngine } from '../../src/services/audioEngine';
import { UnifiedTrack } from '../../src/types/music';
import { resetPlayerStore, resetLibraryStore, resetUIStore } from '../helpers/testUtils';

// Component wrapper to mount keyboard shortcuts
function ShortcutHarness({ children }: { children?: React.ReactNode }) {
  useKeyboardShortcuts();
  return <div data-testid="shortcut-harness">{children}</div>;
}

const mockTrack: UnifiedTrack = {
  id: 'yt_adv_test_01',
  source: 'youtube',
  originalId: 'adv_test_01',
  title: 'Adversarial Challenge Track',
  artist: 'Stress Tester',
  duration: 240,
  durationFormatted: '4:00',
  artworkUrl: 'https://example.com/art.jpg',
  streamUrl: 'https://example.com/stream.mp3'
};

describe('Adversarial Empirical Stress Suite: WaveVisualizerOrb & useKeyboardShortcuts', () => {
  let mockCtx: any;

  beforeEach(() => {
    resetPlayerStore();
    resetLibraryStore();
    resetUIStore();

    mockCtx = {
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      getImageData: vi.fn(),
      putImageData: vi.fn(),
      createImageData: vi.fn(),
      setTransform: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      fillText: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      // Контур орба ведётся дугами, а не отрезками: без этого метода заглушка
      // падает «not a function», то есть ошибкой холста, а не картинки.
      quadraticCurveTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      ellipse: vi.fn(),
      roundRect: vi.fn(),
      fill: vi.fn(),
      scale: vi.fn(),
      createLinearGradient: vi.fn().mockReturnValue({
        addColorStop: vi.fn()
      }),
      createRadialGradient: vi.fn().mockReturnValue({
        addColorStop: vi.fn()
      })
    };

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);
    HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      width: 320,
      height: 320,
      top: 0,
      left: 0,
      bottom: 320,
      right: 320
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // SECTION 1: WaveVisualizerOrb Degenerate Audio Spectrum Stress Tests
  // ==========================================================================
  describe('1. WaveVisualizerOrb Audio Spectrum Adversarial Testing', () => {
    it('handles all-zero audio spectrum (total silence) without DivisionByZero, NaN, or canvas errors', () => {
      vi.spyOn(audioEngine, 'getFrequencyData').mockReturnValue(new Uint8Array(128).fill(0));

      let rafCallback: FrameRequestCallback | null = null;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallback = cb;
        return 1;
      });

      const { unmount } = render(<WaveVisualizerOrb mood="energy" isPlaying={true} />);

      expect(rafCallback).not.toBeNull();
      // Execute render frame
      act(() => {
        if (rafCallback) rafCallback(1000);
      });

      // Verify canvas drew without throwing
      expect(mockCtx.save).toHaveBeenCalled();
      expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 320, 320);
      expect(mockCtx.createRadialGradient).toHaveBeenCalled();
      expect(mockCtx.fill).toHaveBeenCalled();
      expect(mockCtx.restore).toHaveBeenCalled();

      // Verify gradient calls did not receive NaN
      const radialCalls = mockCtx.createRadialGradient.mock.calls;
      for (const call of radialCalls) {
        for (const arg of call) {
          expect(Number.isFinite(arg)).toBe(true);
          expect(Number.isNaN(arg)).toBe(false);
        }
      }

      unmount();
    });

    it('handles all-255 audio spectrum (maximum saturation / clipping) cleanly', () => {
      vi.spyOn(audioEngine, 'getFrequencyData').mockReturnValue(new Uint8Array(128).fill(255));

      let rafCallback: FrameRequestCallback | null = null;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallback = cb;
        return 1;
      });

      const { unmount } = render(<WaveVisualizerOrb mood="favorite" isPlaying={true} />);

      // Execute render frame
      act(() => {
        if (rafCallback) rafCallback(2000);
      });

      expect(mockCtx.fill).toHaveBeenCalled();
      expect(mockCtx.stroke).toHaveBeenCalled();

      // Check arc radius is positive finite number
      const arcCalls = mockCtx.arc.mock.calls;
      expect(arcCalls.length).toBeGreaterThan(0);
      for (const call of arcCalls) {
        const radius = call[2];
        expect(Number.isFinite(radius)).toBe(true);
        expect(radius).toBeGreaterThan(0);
      }

      unmount();
    });

    it('handles Float32 / custom array with NaN, Infinity, negative values safely', () => {
      // Create a mocked frequency spectrum containing NaN, Infinity, -Infinity
      const degenerateData = new Array(128).fill(0);
      degenerateData[0] = NaN;
      degenerateData[1] = Infinity;
      degenerateData[2] = -Infinity;
      degenerateData[10] = -50;
      degenerateData[50] = 999999;

      vi.spyOn(audioEngine, 'getFrequencyData').mockReturnValue(degenerateData as any);

      let rafCallback: FrameRequestCallback | null = null;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallback = cb;
        return 1;
      });

      const { unmount } = render(<WaveVisualizerOrb mood="discovery" isPlaying={true} />);

      expect(() => {
        act(() => {
          if (rafCallback) rafCallback(2500);
        });
      }).not.toThrow();

      unmount();
    });

    it('handles undersized spectrum array (< 128 elements) gracefully without out-of-bounds exceptions', () => {
      const smallArrays = [
        new Uint8Array(0),
        new Uint8Array(1),
        new Uint8Array(16),
        new Uint8Array(64),
        new Uint8Array(127)
      ];

      for (const smallArr of smallArrays) {
        vi.spyOn(audioEngine, 'getFrequencyData').mockReturnValue(smallArr);

        let rafCallback: FrameRequestCallback | null = null;
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
          rafCallback = cb;
          return 1;
        });

        const { unmount } = render(<WaveVisualizerOrb mood="chill" isPlaying={true} />);

        act(() => {
          if (rafCallback) rafCallback(500);
        });

        expect(mockCtx.save).toHaveBeenCalled();
        unmount();
      }
    });

    it('handles oversized spectrum array (2048/4096 bins) without index overflow', () => {
      vi.spyOn(audioEngine, 'getFrequencyData').mockReturnValue(new Uint8Array(4096).fill(180));

      let rafCallback: FrameRequestCallback | null = null;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallback = cb;
        return 1;
      });

      const { unmount } = render(<WaveVisualizerOrb mood="focus" isPlaying={true} />);

      act(() => {
        if (rafCallback) rafCallback(3000);
      });

      expect(mockCtx.save).toHaveBeenCalled();
      expect(mockCtx.fill).toHaveBeenCalled();
      unmount();
    });

    it('handles null / undefined return from getFrequencyData', () => {
      vi.spyOn(audioEngine, 'getFrequencyData').mockReturnValue(null as any);

      let rafCallback: FrameRequestCallback | null = null;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallback = cb;
        return 1;
      });

      const { unmount } = render(<WaveVisualizerOrb mood="discovery" isPlaying={true} />);

      expect(() => {
        act(() => {
          if (rafCallback) rafCallback(1500);
        });
      }).not.toThrow();

      unmount();
    });

    it('survives rapid mount / unmount stress (100 rapid cycles) and cleans up animation frame handles', () => {
      const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
      const reqSpy = vi.spyOn(window, 'requestAnimationFrame');

      for (let i = 0; i < 100; i++) {
        const { unmount } = render(<WaveVisualizerOrb mood="energy" isPlaying={i % 2 === 0} />);
        unmount();
      }

      expect(reqSpy).toHaveBeenCalled();
      expect(cancelSpy).toHaveBeenCalled();
      expect(cancelSpy.mock.calls.length).toBeGreaterThanOrEqual(100);
    });

    it('survives rapid prop thrashing (mood switching, isPlaying flipping, dimension morphing)', () => {
      const moods: Array<'favorite' | 'discovery' | 'energy' | 'chill' | 'focus'> = [
        'favorite',
        'discovery',
        'energy',
        'chill',
        'focus'
      ];

      const { rerender, unmount } = render(
        <WaveVisualizerOrb mood="favorite" isPlaying={false} width={100} height={100} />
      );

      for (let i = 0; i < 50; i++) {
        const currentMood = moods[i % moods.length];
        const isPlaying = i % 2 === 0;
        const size = 100 + (i % 10) * 30;

        expect(() => {
          rerender(
            <WaveVisualizerOrb mood={currentMood} isPlaying={isPlaying} width={size} height={size} />
          );
        }).not.toThrow();
      }

      unmount();
    });

    it('handles degenerate / zero container dimensions gracefully', () => {
      HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        bottom: 0,
        right: 0
      });

      let rafCallback: FrameRequestCallback | null = null;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallback = cb;
        return 1;
      });

      const { unmount } = render(<WaveVisualizerOrb width={0} height={0} isPlaying={true} />);

      expect(() => {
        act(() => {
          if (rafCallback) rafCallback(1000);
        });
      }).not.toThrow();

      unmount();
    });

    it('falls back safely to default palette when given unrecognized mood', () => {
      let rafCallback: FrameRequestCallback | null = null;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallback = cb;
        return 1;
      });

      const { unmount } = render(<WaveVisualizerOrb mood={'unknown_mood' as any} isPlaying={true} />);

      expect(() => {
        act(() => {
          if (rafCallback) rafCallback(1000);
        });
      }).not.toThrow();

      unmount();
    });
  });

  // ==========================================================================
  // SECTION 2: useKeyboardShortcuts Adversarial & Chording Stress Tests
  // ==========================================================================
  describe('2. useKeyboardShortcuts Adversarial Chording & Input Isolation', () => {
    it('NEVER triggers shortcuts when typing inside <input type="text">', () => {
      const togglePlaySpy = vi.spyOn(usePlayerStore.getState(), 'togglePlayPause');
      const toggleMuteSpy = vi.spyOn(usePlayerStore.getState(), 'toggleMute');
      const seekSpy = vi.spyOn(usePlayerStore.getState(), 'seekTo');
      const favSpy = vi.spyOn(useLibraryStore.getState(), 'toggleFavorite');
      const dislikeSpy = vi.spyOn(usePlayerStore.getState(), 'dislikeAndSkipCurrentTrack');

      render(
        <ShortcutHarness>
          <input data-testid="test-input-text" type="text" />
        </ShortcutHarness>
      );

      const input = screen.getByTestId('test-input-text');
      input.focus();

      // Dispatch all hotkeys into the focused text input
      const hotkeys = [' ', 'm', 'M', 'f', 'F', 'q', 'Q', 'l', 'L', 'd', 'D', '/', 'ArrowLeft', 'ArrowRight'];
      for (const key of hotkeys) {
        fireEvent.keyDown(input, { key, code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}` });
      }

      expect(togglePlaySpy).not.toHaveBeenCalled();
      expect(toggleMuteSpy).not.toHaveBeenCalled();
      expect(seekSpy).not.toHaveBeenCalled();
      expect(favSpy).not.toHaveBeenCalled();
      expect(dislikeSpy).not.toHaveBeenCalled();
    });

    it('NEVER triggers shortcuts when typing inside <textarea>', () => {
      const togglePlaySpy = vi.spyOn(usePlayerStore.getState(), 'togglePlayPause');
      const toggleQueueSpy = vi.spyOn(useUIStore.getState(), 'toggleQueue');

      render(
        <ShortcutHarness>
          <textarea data-testid="test-textarea" />
        </ShortcutHarness>
      );

      const textarea = screen.getByTestId('test-textarea');
      textarea.focus();

      fireEvent.keyDown(textarea, { key: ' ', code: 'Space' });
      fireEvent.keyDown(textarea, { key: 'q', code: 'KeyQ' });
      fireEvent.keyDown(textarea, { key: 'd', code: 'KeyD' });

      expect(togglePlaySpy).not.toHaveBeenCalled();
      expect(toggleQueueSpy).not.toHaveBeenCalled();
    });

    it('NEVER triggers shortcuts when typing inside [contenteditable="true"]', () => {
      const togglePlaySpy = vi.spyOn(usePlayerStore.getState(), 'togglePlayPause');
      const startWaveSpy = vi.spyOn(usePlayerStore.getState(), 'startMyWave');

      render(
        <ShortcutHarness>
          <div data-testid="test-editable" contentEditable={true} suppressContentEditableWarning={true}>
            Editable content
          </div>
        </ShortcutHarness>
      );

      const editable = screen.getByTestId('test-editable');
      editable.focus();

      fireEvent.keyDown(editable, { key: ' ', code: 'Space' });
      fireEvent.keyDown(editable, { key: 'w', altKey: true });
      fireEvent.keyDown(editable, { key: 'l', code: 'KeyL' });

      expect(togglePlaySpy).not.toHaveBeenCalled();
      expect(startWaveSpy).not.toHaveBeenCalled();
    });

    it('Alt+W strictly checks modifiers: rejects Ctrl+Alt+W, Shift+Alt+W, Meta+Alt+W', () => {
      const startWaveSpy = vi.spyOn(usePlayerStore.getState(), 'startMyWave').mockResolvedValue(undefined);
      useUIStore.setState({ activeView: 'search' });

      render(<ShortcutHarness />);

      // Invalid chord: Ctrl + Alt + W
      fireEvent.keyDown(window, { key: 'w', altKey: true, ctrlKey: true });
      expect(startWaveSpy).not.toHaveBeenCalled();

      // Invalid chord: Shift + Alt + W
      fireEvent.keyDown(window, { key: 'w', altKey: true, shiftKey: true });
      expect(startWaveSpy).not.toHaveBeenCalled();

      // Invalid chord: Meta + Alt + W
      fireEvent.keyDown(window, { key: 'w', altKey: true, metaKey: true });
      expect(startWaveSpy).not.toHaveBeenCalled();

      // Valid chord: Alt + W only
      fireEvent.keyDown(window, { key: 'w', altKey: true });
      expect(startWaveSpy).toHaveBeenCalled();
      expect(useUIStore.getState().activeView).toBe('wave');
    });

    it('Alt+R strictly checks modifiers: rejects Ctrl+Alt+R, Shift+Alt+R and handles null currentTrack safely', () => {
      const startRadioSpy = vi.spyOn(usePlayerStore.getState(), 'startTrackRadio').mockResolvedValue(undefined);

      render(<ShortcutHarness />);

      // When currentTrack is null: Alt+R does not throw
      usePlayerStore.setState({ currentTrack: null });
      expect(() => {
        fireEvent.keyDown(window, { key: 'r', altKey: true });
      }).not.toThrow();
      expect(startRadioSpy).not.toHaveBeenCalled();

      // When currentTrack exists: Ctrl+Alt+R must be rejected
      usePlayerStore.setState({ currentTrack: mockTrack });
      fireEvent.keyDown(window, { key: 'r', altKey: true, ctrlKey: true });
      expect(startRadioSpy).not.toHaveBeenCalled();

      // Valid Alt+R
      fireEvent.keyDown(window, { key: 'r', altKey: true });
      expect(startRadioSpy).toHaveBeenCalledWith(mockTrack);
    });

    it('Spacebar strictly rejects Shift+Space, Ctrl+Space, Alt+Space', () => {
      const togglePlaySpy = vi.spyOn(usePlayerStore.getState(), 'togglePlayPause').mockResolvedValue(undefined);

      render(<ShortcutHarness />);

      // Shift+Space
      fireEvent.keyDown(window, { key: ' ', shiftKey: true });
      expect(togglePlaySpy).not.toHaveBeenCalled();

      // Ctrl+Space
      fireEvent.keyDown(window, { key: ' ', ctrlKey: true });
      expect(togglePlaySpy).not.toHaveBeenCalled();

      // Alt+Space
      fireEvent.keyDown(window, { key: ' ', altKey: true });
      expect(togglePlaySpy).not.toHaveBeenCalled();

      // Plain Space
      fireEvent.keyDown(window, { key: ' ' });
      expect(togglePlaySpy).toHaveBeenCalledTimes(1);
    });

    it('L (Like) and D (Dislike) safely no-op when currentTrack is null', async () => {
      usePlayerStore.setState({ currentTrack: null });
      const favSpy = vi.spyOn(useLibraryStore.getState(), 'toggleFavorite');
      const dislikeSpy = vi.spyOn(usePlayerStore.getState(), 'dislikeAndSkipCurrentTrack');

      render(<ShortcutHarness />);

      await act(async () => {
        fireEvent.keyDown(window, { key: 'l' });
        fireEvent.keyDown(window, { key: 'd' });
      });

      expect(favSpy).not.toHaveBeenCalled();
      expect(dislikeSpy).not.toHaveBeenCalled();
    });

    it('ArrowLeft and ArrowRight distinguish between seek and track jump with Shift', () => {
      usePlayerStore.setState({ currentTime: 50, duration: 200 });
      const seekSpy = vi.spyOn(usePlayerStore.getState(), 'seekTo');
      const prevSpy = vi.spyOn(usePlayerStore.getState(), 'prevTrack').mockResolvedValue(undefined);
      const nextSpy = vi.spyOn(usePlayerStore.getState(), 'nextTrack').mockResolvedValue(undefined);

      render(<ShortcutHarness />);

      // ArrowLeft without shift -> seek backward 5s (50 -> 45)
      fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: false });
      expect(seekSpy).toHaveBeenCalledWith(45);
      expect(prevSpy).not.toHaveBeenCalled();

      // ArrowLeft with shift -> prevTrack
      fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });
      expect(prevSpy).toHaveBeenCalled();

      // Reset currentTime to 50 for ArrowRight test
      usePlayerStore.setState({ currentTime: 50 });
      seekSpy.mockClear();

      // ArrowRight without shift -> seek forward 5s (50 -> 55)
      fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: false });
      expect(seekSpy).toHaveBeenCalledWith(55);
      expect(nextSpy).not.toHaveBeenCalled();

      // ArrowRight with shift -> nextTrack
      fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
      expect(nextSpy).toHaveBeenCalledWith(true);
    });

    it('Fuzz / Flood test: handles 500 rapid random keydowns with mixed modifiers without crashing or throwing', () => {
      usePlayerStore.setState({ currentTrack: mockTrack, currentTime: 20, duration: 100 });

      render(<ShortcutHarness />);

      const randomKeys = ['a', 'b', 'c', ' ', 'w', 'r', 'l', 'd', 'm', 'f', 'q', '/', 'Escape', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown'];

      expect(() => {
        for (let i = 0; i < 500; i++) {
          const key = randomKeys[i % randomKeys.length];
          const altKey = i % 3 === 0;
          const ctrlKey = i % 5 === 0;
          const shiftKey = i % 7 === 0;
          const metaKey = i % 11 === 0;

          fireEvent.keyDown(window, { key, altKey, ctrlKey, shiftKey, metaKey });
        }
      }).not.toThrow();
    });
  });
});
