import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { KaraokeView } from '../../src/components/lyrics/KaraokeView';
import { PlayerBar } from '../../src/components/player/PlayerBar';
import { FullscreenPlayer } from '../../src/components/player/FullscreenPlayer';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { UnifiedTrack } from '../../src/types/music';
import * as lyricsService from '../../src/services/lyricsService';

// Mock Canvas 2D context for jsdom environment
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
    putImageData: vi.fn(),
    createImageData: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    createLinearGradient: vi.fn().mockReturnValue({
      addColorStop: vi.fn()
    })
  }) as any;

  // Mock scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();

  vi.restoreAllMocks();
  lyricsService.clearLyricsCache();

  // Reset store states
  useUIStore.setState({
    isLyricsOpen: false,
    isFullscreenPlayerOpen: false,
    isQueueOpen: false
  });

  usePlayerStore.setState({
    currentTrack: null,
    currentTime: 0,
    duration: 200,
    isPlaying: false,
    userQueue: [],
    sourceQueue: []
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mockTrack: UnifiedTrack = {
  id: 'yt_test123',
  source: 'youtube',
  originalId: 'test123',
  title: 'Bohemian Rhapsody',
  artist: 'Queen',
  duration: 355,
  artworkUrl: 'https://example.com/art.jpg'
};

describe('KaraokeView Component', () => {
  it('does not render anything when isLyricsOpen is false', () => {
    useUIStore.setState({ isLyricsOpen: false });
    const { container } = render(<KaraokeView />);
    expect(container.firstChild).toBeNull();
  });

  it('renders time-synced lyrics with active line glow and updates with currentTime', async () => {
    const mockSyncedLyrics: lyricsService.LyricsResult = {
      synced: true,
      lines: [
        { time: 5.0, text: 'Is this the real life?' },
        { time: 10.0, text: 'Is this just fantasy?' },
        { time: 15.0, text: 'Caught in a landslide' },
        { time: 20.0, text: 'No escape from reality' }
      ],
      rawLrc: '...',
      trackName: 'Bohemian Rhapsody',
      artistName: 'Queen'
    };

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValueOnce(mockSyncedLyrics);

    usePlayerStore.setState({
      currentTrack: mockTrack,
      currentTime: 11.5
    });
    useUIStore.setState({ isLyricsOpen: true });

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-view')).toBeInTheDocument();
      expect(screen.getByTestId('karaoke-track-title')).toHaveTextContent('Bohemian Rhapsody');
      expect(screen.getByTestId('karaoke-track-artist')).toHaveTextContent('Queen');
      expect(screen.getByTestId('karaoke-synced-badge')).toHaveTextContent('По времени');
    });

    // Check all lines rendered
    expect(screen.getByText('Is this the real life?')).toBeInTheDocument();
    expect(screen.getByText('Is this just fantasy?')).toBeInTheDocument();
    expect(screen.getByText('Caught in a landslide')).toBeInTheDocument();
    expect(screen.getByText('No escape from reality')).toBeInTheDocument();

    // At 11.5s, line 1 ('Is this just fantasy?') is active
    const line0 = screen.getByTestId('karaoke-line-0');
    const line1 = screen.getByTestId('karaoke-line-1');
    const line2 = screen.getByTestId('karaoke-line-2');

    expect(line0).toHaveAttribute('data-active', 'false');
    expect(line1).toHaveAttribute('data-active', 'true');
    expect(line2).toHaveAttribute('data-active', 'false');
  });

  it('seeks audio player to line timestamp when a lyrics line is clicked', async () => {
    const seekToSpy = vi.fn();
    usePlayerStore.setState({
      currentTrack: mockTrack,
      currentTime: 0,
      seekTo: seekToSpy
    });
    useUIStore.setState({ isLyricsOpen: true });

    const mockSyncedLyrics: lyricsService.LyricsResult = {
      synced: true,
      lines: [
        { time: 5.0, text: 'Line 1' },
        { time: 15.0, text: 'Line 2' },
        { time: 25.0, text: 'Line 3' }
      ]
    };

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValueOnce(mockSyncedLyrics);

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-line-2')).toBeInTheDocument();
    });

    // Click line 2 (time: 25.0s)
    fireEvent.click(screen.getByTestId('karaoke-line-2'));

    expect(seekToSpy).toHaveBeenCalledWith(25.0);
  });

  it('renders clean fallback empty state when no lyrics are found', async () => {
    usePlayerStore.setState({
      currentTrack: mockTrack,
      currentTime: 0
    });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValueOnce(null);

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-not-found')).toBeInTheDocument();
      expect(screen.getByText(/Текст не найден/i)).toBeInTheDocument();
    });
  });

  it('renders clean fallback for instrumental tracks', async () => {
    usePlayerStore.setState({
      currentTrack: mockTrack,
      currentTime: 0
    });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValueOnce({
      synced: false,
      instrumental: true,
      lines: []
    });

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-instrumental')).toBeInTheDocument();
      expect(screen.getByText(/Инструментал/i)).toBeInTheDocument();
    });
  });

  it('renders plain text lyrics cleanly when synced lyrics are unavailable', async () => {
    usePlayerStore.setState({
      currentTrack: mockTrack,
      currentTime: 0
    });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValueOnce({
      synced: false,
      lines: [
        { time: 0, text: 'Unsynced line 1' },
        { time: 1, text: 'Unsynced line 2' }
      ],
      plainLyrics: 'Unsynced line 1\nUnsynced line 2'
    });

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-plain-badge')).toHaveTextContent('Без синхронизации');
      expect(screen.getByText('Unsynced line 1')).toBeInTheDocument();
      expect(screen.getByText('Unsynced line 2')).toBeInTheDocument();
    });
  });

  it('closes lyrics view when close button is clicked', async () => {
    usePlayerStore.setState({ currentTrack: mockTrack });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValueOnce(null);

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-close-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('karaoke-close-btn'));
    expect(useUIStore.getState().isLyricsOpen).toBe(false);
  });
});

/**
 * Всё, что появилось из-за пункта «тексты криво, местами нет»: видно, насколько
 * текст надёжно сопоставлен, можно выбрать другой вариант руками и подстроить
 * сдвиг, если строки уезжают.
 */
describe('KaraokeView: подбор текста и сдвиг', () => {
  const syncedLyrics: lyricsService.LyricsResult = {
    synced: true,
    lines: [
      { time: 5.0, text: 'Line 1' },
      { time: 15.0, text: 'Line 2' }
    ],
    trackName: 'Bohemian Rhapsody',
    artistName: 'Queen',
    confidence: 'high'
  };

  it('предупреждает, когда текст подобран неуверенно', async () => {
    usePlayerStore.setState({ currentTrack: mockTrack, currentTime: 0 });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValue({
      ...syncedLyrics,
      trackName: 'Bohemian Like You',
      artistName: 'The Dandy Warhols',
      confidence: 'low'
    });

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-low-confidence')).toBeInTheDocument();
    });
    // В предупреждении названа именно та песня, текст которой показан, —
    // иначе непонятно, что не так.
    expect(screen.getByTestId('karaoke-low-confidence')).toHaveTextContent('Bohemian Like You');
  });

  it('не предупреждает, когда текст надёжный или выбран руками', async () => {
    usePlayerStore.setState({ currentTrack: mockTrack, currentTime: 0 });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValue({
      ...syncedLyrics,
      confidence: 'low',
      manual: true
    });

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-manual-badge')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('karaoke-low-confidence')).not.toBeInTheDocument();
  });

  it('запоминает выбранный вручную вариант и показывает его сразу', async () => {
    usePlayerStore.setState({ currentTrack: mockTrack, currentTime: 0 });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValue(null);
    const setManualSpy = vi.spyOn(lyricsService, 'setManualLyrics').mockResolvedValue();
    vi.spyOn(lyricsService, 'findLyricsCandidates').mockResolvedValue([
      {
        result: {
          synced: true,
          lines: [{ time: 1, text: 'Правильный текст' }],
          trackName: 'Bohemian Rhapsody',
          artistName: 'Queen'
        },
        score: 120,
        confidence: 'high',
        notes: []
      }
    ]);

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-not-found')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('karaoke-search-manually'));

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-candidate-0')).toBeInTheDocument();
    });
    expect(screen.getByTestId('karaoke-candidate-0')).toHaveTextContent('Bohemian Rhapsody');
    expect(screen.getByTestId('karaoke-candidate-confidence-0')).toHaveTextContent('похоже');

    fireEvent.click(screen.getByTestId('karaoke-candidate-0'));

    await waitFor(() => {
      expect(setManualSpy).toHaveBeenCalledTimes(1);
      // Выбор виден сразу, без повторного запроса в сеть.
      expect(screen.getByText('Правильный текст')).toBeInTheDocument();
      expect(screen.getByTestId('karaoke-manual-badge')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('karaoke-picker')).not.toBeInTheDocument();
  });

  it('ищет текст по введённому запросу, когда автоподбор промахнулся', async () => {
    usePlayerStore.setState({ currentTrack: mockTrack, currentTime: 0 });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValue(null);
    const findSpy = vi.spyOn(lyricsService, 'findLyricsCandidates').mockResolvedValue([]);

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-search-manually')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('karaoke-search-manually'));

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-picker-empty')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('karaoke-picker-input'), {
      target: { value: 'Queen Богемская рапсодия' }
    });
    fireEvent.click(screen.getByTestId('karaoke-picker-search-btn'));

    await waitFor(() => {
      expect(findSpy).toHaveBeenLastCalledWith(mockTrack, 'Queen Богемская рапсодия');
    });
  });

  it('сдвигает подсветку и сохраняет сдвиг для трека', async () => {
    // Подмена `seekTo` до рендера: если подставить её после, компонент успеет
    // замкнуться на прежнюю функцию и клик уйдёт в настоящий стор.
    const seekToSpy = vi.fn();
    usePlayerStore.setState({ currentTrack: mockTrack, currentTime: 16, seekTo: seekToSpy });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValue(syncedLyrics);
    vi.spyOn(lyricsService, 'getLyricsOffset').mockResolvedValue(0);
    const setOffsetSpy = vi.spyOn(lyricsService, 'setLyricsOffset').mockResolvedValue();

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-line-1')).toHaveAttribute('data-active', 'true');
    });
    expect(screen.getByTestId('karaoke-offset-value')).toHaveTextContent('0.0 с');

    // На 16 секунде активна вторая строка (15.0). Сдвиг +2 с означает «текст
    // позже», то есть на этой же секунде должна снова гореть первая.
    fireEvent.click(screen.getByTestId('karaoke-offset-later'));
    fireEvent.click(screen.getByTestId('karaoke-offset-later'));
    fireEvent.click(screen.getByTestId('karaoke-offset-later'));
    fireEvent.click(screen.getByTestId('karaoke-offset-later'));

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-offset-value')).toHaveTextContent('+2.0 с');
      expect(screen.getByTestId('karaoke-line-0')).toHaveAttribute('data-active', 'true');
      expect(screen.getByTestId('karaoke-line-1')).toHaveAttribute('data-active', 'false');
    });

    expect(setOffsetSpy).toHaveBeenLastCalledWith(mockTrack.id, 2);

    // Клик по строке учитывает сдвиг, иначе перескок уводил бы мимо неё.
    fireEvent.click(screen.getByTestId('karaoke-line-1'));
    expect(seekToSpy).toHaveBeenCalledWith(17);

    fireEvent.click(screen.getByTestId('karaoke-offset-reset'));
    await waitFor(() => {
      expect(screen.getByTestId('karaoke-offset-value')).toHaveTextContent('0.0 с');
    });
    expect(setOffsetSpy).toHaveBeenLastCalledWith(mockTrack.id, 0);
  });

  it('подставляет сохранённый ранее сдвиг при открытии', async () => {
    usePlayerStore.setState({ currentTrack: mockTrack, currentTime: 0 });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValue(syncedLyrics);
    vi.spyOn(lyricsService, 'getLyricsOffset').mockResolvedValue(-1.5);

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByTestId('karaoke-offset-value')).toHaveTextContent('-1.5 с');
    });
  });

  it('не показывает подстройку тайминга у несинхронизированного текста', async () => {
    usePlayerStore.setState({ currentTrack: mockTrack, currentTime: 0 });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValue({
      synced: false,
      lines: [{ time: 0, text: 'Просто текст' }]
    });

    render(<KaraokeView />);

    await waitFor(() => {
      expect(screen.getByText('Просто текст')).toBeInTheDocument();
    });
    // Сдвигать нечего: у строк нет настоящих таймингов.
    expect(screen.queryByTestId('karaoke-offset-controls')).not.toBeInTheDocument();
  });

  it('прокручивает список строк, а не всё окно', async () => {
    usePlayerStore.setState({ currentTrack: mockTrack, currentTime: 6 });
    useUIStore.setState({ isLyricsOpen: true });

    vi.spyOn(lyricsService, 'fetchLyrics').mockResolvedValue(syncedLyrics);

    render(<KaraokeView />);

    const container = await screen.findByTestId('karaoke-scroll-container');
    const scrollToSpy = vi.fn();
    (container as HTMLElement).scrollTo = scrollToSpy as unknown as typeof container.scrollTo;
    // Прокрутка на монтировании уже прошла — считаем только то, что после.
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    // Активной становится вторая строка (15.0) — прокрутка идёт через контейнер.
    usePlayerStore.setState({ currentTime: 16 });

    await waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalled();
    });
    expect(scrollToSpy.mock.calls[0][0]).toMatchObject({ behavior: 'smooth' });
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('Microphone Triggers (PlayerBar & FullscreenPlayer)', () => {
  it('PlayerBar microphone button toggles lyrics view state', () => {
    usePlayerStore.setState({ currentTrack: mockTrack });
    useUIStore.setState({ isLyricsOpen: false });

    render(<PlayerBar />);

    const micBtn = screen.getByTestId('player-lyrics-btn');
    expect(micBtn).toBeInTheDocument();
    expect(micBtn).toHaveAttribute('aria-pressed', 'false');

    // Click mic button
    fireEvent.click(micBtn);
    expect(useUIStore.getState().isLyricsOpen).toBe(true);

    // Click again to toggle off
    fireEvent.click(micBtn);
    expect(useUIStore.getState().isLyricsOpen).toBe(false);
  });

  it('FullscreenPlayer microphone button toggles lyrics view state', () => {
    usePlayerStore.setState({ currentTrack: mockTrack });
    useUIStore.setState({ isFullscreenPlayerOpen: true, isLyricsOpen: false });

    render(<FullscreenPlayer />);

    const fullscreenMicBtn = screen.getByTestId('fullscreen-lyrics-btn');
    expect(fullscreenMicBtn).toBeInTheDocument();
    expect(fullscreenMicBtn).toHaveAttribute('aria-pressed', 'false');

    // Click mic button
    fireEvent.click(fullscreenMicBtn);
    expect(useUIStore.getState().isLyricsOpen).toBe(true);

    // Click again to toggle off
    fireEvent.click(fullscreenMicBtn);
    expect(useUIStore.getState().isLyricsOpen).toBe(false);
  });
});

/**
 * Экран текста на телефоне.
 *
 * Он прибит к окну целиком (`fixed; inset: 0`), и настольная шапка на 360 px
 * складывалась в кашу: обложка, название, значок «Без синхронизации», кнопка
 * «Другой текст», перезагрузка и крестик — всё в один ряд и поверх часов,
 * потому что про безопасную зону сверху шапка не знала вовсе. Скриншот
 * владельца от 2026-09-01: заголовок наезжает на время, значок — на название.
 */
describe('KaraokeView на телефоне', () => {
  /** Подменяет `matchMedia` так, чтобы порог 768px считался пройденным. */
  function pretendNarrow(narrow: boolean) {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: narrow && query.includes('max-width: 768px'),
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn()
        }) as unknown as MediaQueryList
    );
  }

  beforeEach(() => {
    useUIStore.setState({ isLyricsOpen: true });
    usePlayerStore.setState({
      currentTrack: {
        id: 'yt_k',
        source: 'youtube',
        originalId: 'k',
        title: 'Ушла к реальному пацану',
        artist: 'монеточка',
        duration: 200,
        artworkUrl: ''
      } as UnifiedTrack
    });
  });

  it('шапка собирается в два ряда и отступает от системной строки', () => {
    pretendNarrow(true);
    render(<KaraokeView />);

    const header = screen.getByTestId('karaoke-view').querySelector('header')!;
    expect(header.style.flexDirection).toBe('column');
    // Без этого отступа шапка уезжает под часы и значок сети.
    expect(header.style.padding).toContain('--safe-top');
  });

  it('на широком экране шапка остаётся одним рядом', () => {
    pretendNarrow(false);
    render(<KaraokeView />);

    const header = screen.getByTestId('karaoke-view').querySelector('header')!;
    expect(header.style.flexDirection).toBe('row');
    expect(header.style.padding).not.toContain('--safe-top');
  });

  it('«Другой текст» на телефоне остаётся одним значком', async () => {
    // Со словами кнопка занимает треть ширины экрана и выталкивает крестик за
    // край — именно это видно на скриншоте.
    pretendNarrow(true);
    render(<KaraokeView />);

    const button = await screen.findByTestId('karaoke-pick-other-btn');
    expect(button.textContent).not.toContain('Другой текст');
    expect(button.getAttribute('aria-label')).toBe('Найти другой текст');
  });
});
