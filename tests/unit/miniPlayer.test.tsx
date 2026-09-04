import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../setup';

import { useUIStore } from '../../src/store/useUIStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { MiniPlayerView } from '../../src/components/player/mini/MiniPlayerView';
import { MiniPlayerCompact } from '../../src/components/player/mini/MiniPlayerCompact';
import { MiniPlayerSquare } from '../../src/components/player/mini/MiniPlayerSquare';
import { MiniPlayerExpanded } from '../../src/components/player/mini/MiniPlayerExpanded';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { UnifiedTrack } from '../../src/types/music';

const mockTrack: UnifiedTrack = {
  id: 'yt_mini_01',
  source: 'youtube',
  originalId: 'mini_01',
  title: 'Cyberpunk Odyssey',
  artist: 'Neon Synth',
  album: 'Future Horizon',
  duration: 200,
  artworkUrl: 'https://example.com/cyber.jpg'
};

const mockNextTrack: UnifiedTrack = {
  id: 'yt_mini_02',
  source: 'youtube',
  originalId: 'mini_02',
  title: 'Starlight Dream',
  artist: 'Astro Wave',
  album: 'Space Odyssey',
  duration: 180,
  artworkUrl: 'https://example.com/starlight.jpg'
};

function ShortcutHost() {
  useKeyboardShortcuts();
  return <div data-testid="shortcut-host" />;
}

describe('Mini Player Test Suite (Compact, Square, Expanded, Settings & Shortcuts)', () => {
  beforeEach(() => {
    useUIStore.setState({
      isMiniPlayerOpen: true,
      miniPlayerLayout: 'compact',
      miniPlayerAlwaysOnTop: true,
      miniPlayerOpacity: 0.95,
      miniPlayerShowVisualizer: true,
      miniPlayerShowProgress: true,
      miniPlayerShowControls: true
    });

    usePlayerStore.setState({
      currentTrack: mockTrack,
      isPlaying: true,
      isLoading: false,
      currentTime: 45,
      duration: 200,
      buffered: 100,
      volume: 0.8,
      isMuted: false,
      autoplayRadio: true,
      sourceQueue: [mockTrack, mockNextTrack],
      userQueue: [],
      currentIndex: 0
    });

    useLibraryStore.setState({
      favorites: [mockTrack]
    });
  });

  it('renders MiniPlayerView with Compact layout by default', () => {
    render(<MiniPlayerView />);

    expect(screen.getByTestId('mini-player-view')).toBeInTheDocument();
    expect(screen.getByTestId('mini-player-header')).toBeInTheDocument();
    expect(screen.getByTestId('mini-player-compact')).toBeInTheDocument();
    expect(screen.getByText('Cyberpunk Odyssey')).toBeInTheDocument();
  });

  it('switches between Compact, Square, and Expanded layouts smoothly', () => {
    render(<MiniPlayerView />);

    // Switch to Square
    fireEvent.click(screen.getByTestId('mini-layout-square-btn'));
    expect(useUIStore.getState().miniPlayerLayout).toBe('square');
    expect(screen.getByTestId('mini-player-square')).toBeInTheDocument();

    // Switch to Expanded
    fireEvent.click(screen.getByTestId('mini-layout-expanded-btn'));
    expect(useUIStore.getState().miniPlayerLayout).toBe('expanded');
    expect(screen.getByTestId('mini-player-expanded')).toBeInTheDocument();

    // Switch back to Compact
    fireEvent.click(screen.getByTestId('mini-layout-compact-btn'));
    expect(useUIStore.getState().miniPlayerLayout).toBe('compact');
    expect(screen.getByTestId('mini-player-compact')).toBeInTheDocument();
  });

  it('opens settings popover and updates opacity, always-on-top and visualizer options', () => {
    render(<MiniPlayerView />);

    // Open settings popover
    fireEvent.click(screen.getByTestId('mini-header-settings-btn'));
    expect(screen.getByTestId('mini-player-settings-popover')).toBeInTheDocument();

    // Change Opacity
    const opacitySlider = screen.getByTestId('mini-opacity-slider');
    fireEvent.change(opacitySlider, { target: { value: '70' } });
    expect(useUIStore.getState().miniPlayerOpacity).toBe(0.7);

    // Toggle Visualizer
    const visualizerToggle = screen.getByTestId('mini-visualizer-toggle-btn');
    fireEvent.click(visualizerToggle);
    expect(useUIStore.getState().miniPlayerShowVisualizer).toBe(false);

    // Toggle Progress
    const progressToggle = screen.getByTestId('mini-progress-toggle-btn');
    fireEvent.click(progressToggle);
    expect(useUIStore.getState().miniPlayerShowProgress).toBe(false);
  });

  it('MiniPlayerCompact executes play/pause, seek, next/prev and favorite actions', () => {
    const togglePlaySpy = vi.spyOn(usePlayerStore.getState(), 'togglePlayPause').mockResolvedValue();
    const nextSpy = vi.spyOn(usePlayerStore.getState(), 'nextTrack').mockResolvedValue();
    const prevSpy = vi.spyOn(usePlayerStore.getState(), 'prevTrack').mockResolvedValue();
    const seekSpy = vi.spyOn(usePlayerStore.getState(), 'seekTo');

    render(<MiniPlayerCompact />);

    // Play/Pause
    fireEvent.click(screen.getByTestId('mini-compact-play-btn'));
    expect(togglePlaySpy).toHaveBeenCalled();

    // Next / Prev
    fireEvent.click(screen.getByTestId('mini-compact-next-btn'));
    expect(nextSpy).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByTestId('mini-compact-prev-btn'));
    expect(prevSpy).toHaveBeenCalled();

    // Progress Bar Seek
    const progressBar = screen.getByTestId('mini-compact-progress-bar');
    vi.spyOn(progressBar, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 4,
      right: 200,
      bottom: 4,
      x: 0,
      y: 0,
      toJSON: () => {}
    });

    fireEvent.click(progressBar, { clientX: 100 });
    expect(seekSpy).toHaveBeenCalledWith(100); // 50% of 200s duration = 100s

    togglePlaySpy.mockRestore();
    nextSpy.mockRestore();
    prevSpy.mockRestore();
    seekSpy.mockRestore();
  });

  it('MiniPlayerSquare renders artwork overlay, dislike button and transport pill', () => {
    const dislikeSpy = vi.spyOn(usePlayerStore.getState(), 'dislikeAndSkipCurrentTrack').mockResolvedValue();

    render(<MiniPlayerSquare />);

    expect(screen.getByTestId('mini-player-square')).toBeInTheDocument();
    expect(screen.getByText('Cyberpunk Odyssey')).toBeInTheDocument();

    // Dislike & Skip
    fireEvent.click(screen.getByTestId('mini-square-dislike-btn'));
    expect(dislikeSpy).toHaveBeenCalled();

    dislikeSpy.mockRestore();
  });

  it('MiniPlayerExpanded renders Up Next preview and volume control', () => {
    const setVolumeSpy = vi.spyOn(usePlayerStore.getState(), 'setVolume');

    render(<MiniPlayerExpanded />);

    expect(screen.getByTestId('mini-player-expanded')).toBeInTheDocument();
    expect(screen.getByText(/Starlight Dream/)).toBeInTheDocument();

    const volumeSlider = screen.getByTestId('mini-expanded-volume-slider');
    fireEvent.change(volumeSlider, { target: { value: '0.5' } });
    expect(setVolumeSpy).toHaveBeenCalledWith(0.5);

    setVolumeSpy.mockRestore();
  });

  it('Alt+M keyboard shortcut toggles mini player mode', () => {
    useUIStore.setState({ isMiniPlayerOpen: false });
    render(<ShortcutHost />);

    // Press Alt+M
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'm', altKey: true });
    window.dispatchEvent(event);

    expect(useUIStore.getState().isMiniPlayerOpen).toBe(true);

    // Press Alt+M again
    const eventClose = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'm', altKey: true });
    window.dispatchEvent(eventClose);

    expect(useUIStore.getState().isMiniPlayerOpen).toBe(false);
  });
});
