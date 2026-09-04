import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '../setup';

import { WaveView } from '../../src/components/wave/WaveView';
import { WaveVisualizerOrb } from '../../src/components/wave/WaveVisualizerOrb';
import { WaveTuner, describeWaveAxes } from '../../src/components/wave/WaveTuner';
import { WaveSourcePicker, suggestSeedArtists } from '../../src/components/wave/WaveSourcePicker';
import { WaveControls } from '../../src/components/wave/WaveControls';

import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { audioEngine } from '../../src/services/audioEngine';
import { recommendationEngine, UserProfile } from '../../src/services/recommendationEngine';
import { UnifiedTrack } from '../../src/types/music';
import { resetPlayerStore, resetLibraryStore, resetUIStore } from '../helpers/testUtils';

/** Пустой профиль: тесты дописывают в него только то, что проверяют. */
function emptyProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    artistAffinities: new Map(),
    topArtists: [],
    dislikedTrackIds: new Set(),
    recentTrackIds: new Set(),
    favoriteTrackIds: new Set(),
    totalPlays: 0,
    artistPlayCounts: new Map(),
    artistFavoriteCounts: new Map(),
    artistPlaylistCounts: new Map(),
    lastPlayedAt: new Map(),
    ...overrides
  };
}


const mockTrack1: UnifiedTrack = {
  id: 'yt_mock_wave_01',
  source: 'youtube',
  originalId: 'mock_wave_01',
  title: 'Cyberpunk City Flow',
  artist: 'Synth Master',
  duration: 210,
  durationFormatted: '3:30',
  artworkUrl: 'https://example.com/synth.jpg',
  streamUrl: 'https://example.com/stream/synth.mp3'
};

const mockTrack2: UnifiedTrack = {
  id: 'sc_mock_wave_02',
  source: 'soundcloud',
  originalId: 'mock_wave_02',
  title: 'Neon Horizon',
  artist: 'Retro Wave',
  duration: 180,
  durationFormatted: '3:00',
  artworkUrl: 'https://example.com/neon.jpg',
  streamUrl: 'https://example.com/stream/neon.mp3'
};

describe('Wave Components Unit Tests', () => {
  beforeEach(() => {
    resetPlayerStore();
    resetLibraryStore();
    resetUIStore();

    // Canvas mock
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
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
    });

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

  describe('WaveVisualizerOrb', () => {
    it('mounts canvas and starts animation loop', () => {
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
      const getFreqSpy = vi.spyOn(audioEngine, 'getFrequencyData').mockReturnValue(new Uint8Array(128).fill(100));

      const { unmount } = render(<WaveVisualizerOrb mood="discovery" isPlaying={true} />);

      expect(screen.getByTestId('wave-visualizer-orb')).toBeInTheDocument();
      expect(screen.getByTestId('wave-visualizer-canvas')).toBeInTheDocument();
      expect(rafSpy).toHaveBeenCalled();
      expect(getFreqSpy).toBeDefined();

      unmount();
    });

    it('handles different moods gracefully', () => {
      const moods: Array<'favorite' | 'discovery' | 'energy' | 'chill' | 'focus'> = [
        'favorite',
        'discovery',
        'energy',
        'chill',
        'focus'
      ];

      for (const mood of moods) {
        const { unmount } = render(<WaveVisualizerOrb mood={mood} isPlaying={false} />);
        expect(screen.getByTestId('wave-visualizer-canvas')).toBeInTheDocument();
        unmount();
      }
    });

    /**
     * Ловушка на бесконечный цикл отрисовки.
     *
     * Каждый вызов `requestAnimationFrame` копится, а вернуть можно последний
     * запрошенный кадр: если после его выполнения список не вырос — цикл
     * остановился, а не «просто ещё не успел».
     */
    function trackFrames(): { calls: () => number; runLast: () => void } {
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });
      return {
        calls: () => frames.length,
        runLast: () => {
          const cb = frames[frames.length - 1];
          act(() => {
            if (cb) cb(frames.length * 16);
          });
        }
      };
    }

    it('во время игры продолжает планировать кадры', () => {
      vi.spyOn(audioEngine, 'getFrequencyData').mockReturnValue(new Uint8Array(128).fill(120));
      const frames = trackFrames();

      const { unmount } = render(<WaveVisualizerOrb mood="energy" isPlaying={true} />);
      expect(frames.calls()).toBe(1);

      frames.runLast();
      expect(frames.calls()).toBe(2);

      unmount();
    });

    it('на паузе прореживает кадры до 24 в секунду, а не крутит их все', () => {
      /*
       * Шар с дыханием в 60 кадрах в секунду при остановленной музыке — это
       * вентилятор ноутбука в приложении, которое ничего не играет. Но и совсем
       * остановить его нельзя: на нулевом времени контур складывается в
       * правильный пятиугольник с бликом в одной точке, и этот кадр висел бы всё
       * время простоя, читаясь поломкой, а не покоем. Отсюда прореживание:
       * кадры продолжают запрашиваться, но перерисовка происходит не чаще раза в
       * 1000/24 мс — остальные вызовы выходят сразу.
       *
       * Проверяем именно это: цикл живёт (кадр запрошен), но кадр, пришедший
       * раньше порога, до перерисовки не доходит.
       */
      const frames = trackFrames();
      const painted = vi.spyOn(audioEngine, 'getFrequencyData');

      const { unmount } = render(<WaveVisualizerOrb mood="chill" isPlaying={false} />);
      expect(frames.calls()).toBe(1);

      // 16 мс с начала — меньше порога 41.7 мс: кадр обязан выйти до разбора
      // спектра и запросить следующий.
      frames.runLast();
      expect(frames.calls()).toBe(2);
      expect(painted).not.toHaveBeenCalled();

      unmount();
    });

    it('со свёрнутым окном останавливается даже во время игры', () => {
      vi.spyOn(audioEngine, 'getFrequencyData').mockReturnValue(new Uint8Array(128).fill(200));
      const frames = trackFrames();

      const { unmount } = render(<WaveVisualizerOrb mood="favorite" isPlaying={true} />);
      frames.runLast();
      expect(frames.calls()).toBe(2);

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Один последний кадр — дорисовать покой; дальше тишина.
      const afterHide = frames.calls();
      frames.runLast();
      expect(frames.calls()).toBe(afterHide);

      unmount();
      // @ts-expect-error свойство добавлено самим тестом, вернуть надо как было
      delete document.visibilityState;
    });

    it('с просьбой системы убрать анимации не крутит цикл вообще', () => {
      // CSS-блок prefers-reduced-motion гасит только переходы; до цикла на
      // requestAnimationFrame он не достаёт, и это надо было учесть здесь.
      vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: query.includes('prefers-reduced-motion'),
            media: query,
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn()
          }) as unknown as MediaQueryList
      );
      const frames = trackFrames();

      const { unmount } = render(<WaveVisualizerOrb mood="focus" isPlaying={true} />);
      expect(frames.calls()).toBe(1);

      frames.runLast();
      expect(frames.calls()).toBe(1);

      unmount();
    });

    it('мерит холст один раз, а не в каждом кадре', () => {
      // getBoundingClientRect посреди кадра — это принудительный пересчёт
      // раскладки шестьдесят раз в секунду ради числа, меняющегося с окном.
      vi.spyOn(audioEngine, 'getFrequencyData').mockReturnValue(new Uint8Array(128).fill(90));
      const measureSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect');
      const frames = trackFrames();

      const { unmount } = render(<WaveVisualizerOrb mood="discovery" isPlaying={true} />);
      const afterMount = measureSpy.mock.calls.length;

      frames.runLast();
      frames.runLast();
      frames.runLast();

      expect(measureSpy.mock.calls.length).toBe(afterMount);

      unmount();
    });
  });

  describe('WaveTuner', () => {
    it('описывает словами, что настроено, вместо ярлыка настроения', () => {
      usePlayerStore.setState({ waveNovelty: 0.1, waveEnergy: 0.9 });
      render(<WaveTuner />);

      expect(screen.getByTestId('wave-tuner')).toBeInTheDocument();
      expect(screen.getByTestId('wave-axes-summary')).toHaveTextContent('только знакомое');
      expect(screen.getByTestId('wave-axes-summary')).toHaveTextContent('очень бодрое');
    });

    it('двигает знакомость и пересчитывает ярлык для шара', () => {
      render(<WaveTuner />);

      fireEvent.change(screen.getByTestId('wave-slider-novelty'), { target: { value: '90' } });

      expect(usePlayerStore.getState().waveNovelty).toBeCloseTo(0.9);
      // Ярлык нужен только шару и подписи — он считается из осей, а не выбирается.
      expect(usePlayerStore.getState().activeWaveMood).toBe('discovery');
      expect(screen.getByTestId('wave-slider-value-novelty')).toHaveTextContent('почти только новое');
    });

    it('двигает темп и не трогает знакомость', () => {
      usePlayerStore.setState({ waveNovelty: 0.2 });
      render(<WaveTuner />);

      fireEvent.change(screen.getByTestId('wave-slider-energy'), { target: { value: '95' } });

      expect(usePlayerStore.getState().waveEnergy).toBeCloseTo(0.95);
      expect(usePlayerStore.getState().waveNovelty).toBeCloseTo(0.2);
      // Ярлык достаётся оси, которую сдвинули дальше от середины: темп ушёл на
      // 0.45, знакомость — на 0.3.
      expect(usePlayerStore.getState().activeWaveMood).toBe('energy');
    });

    it('перезапускает волну не сразу, а когда ползунок замер', () => {
      vi.useFakeTimers();
      try {
        usePlayerStore.setState({ queueMode: 'my_wave' });
        const startSpy = vi.spyOn(usePlayerStore.getState(), 'startMyWave').mockResolvedValue(undefined);

        render(<WaveTuner />);
        const slider = screen.getByTestId('wave-slider-novelty');
        fireEvent.change(slider, { target: { value: '40' } });
        fireEvent.change(slider, { target: { value: '60' } });
        fireEvent.change(slider, { target: { value: '80' } });

        // Три шага подряд — но поток пересобирается один раз, и только после паузы.
        expect(startSpy).not.toHaveBeenCalled();
        act(() => {
          vi.advanceTimersByTime(600);
        });
        expect(startSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('не перезапускает волну, если она не запущена', () => {
      vi.useFakeTimers();
      try {
        const startSpy = vi.spyOn(usePlayerStore.getState(), 'startMyWave').mockResolvedValue(undefined);

        render(<WaveTuner />);
        fireEvent.change(screen.getByTestId('wave-slider-energy'), { target: { value: '70' } });
        act(() => {
          vi.advanceTimersByTime(600);
        });

        expect(startSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('показывает жанры по-русски, а в поиск отдаёт то, что понимают каталоги', () => {
      render(<WaveTuner />);

      const rockChip = screen.getByTestId('wave-genre-chip-rock');
      expect(rockChip).toHaveTextContent('Рок');

      fireEvent.click(rockChip);
      expect(useUIStore.getState().activeWaveGenre).toBe('Rock');

      fireEvent.click(screen.getByTestId('wave-genre-chip-all'));
      expect(useUIStore.getState().activeWaveGenre).toBeNull();
    });

    it('описывает середину обеих осей без выдуманных настроений', () => {
      expect(describeWaveAxes(0.5, 0.5)).toBe('поровну знакомого и нового, без крайностей по темпу');
    });
  });

  describe('WaveSourcePicker', () => {
    it('переключает источник волны', () => {
      render(<WaveSourcePicker />);

      fireEvent.click(screen.getByTestId('wave-source-chip-discovery'));
      expect(usePlayerStore.getState().waveSeedKind).toBe('discovery');

      fireEvent.click(screen.getByTestId('wave-source-chip-forgotten'));
      expect(usePlayerStore.getState().waveSeedKind).toBe('forgotten');
    });

    it('не даёт выбрать «по артисту», когда выбирать некого', () => {
      render(<WaveSourcePicker />);

      const artistChip = screen.getByTestId('wave-source-chip-artist');
      expect(artistChip).toBeDisabled();
      fireEvent.click(artistChip);
      expect(usePlayerStore.getState().waveSeedKind).toBe('library');
    });

    it('не даёт выбрать «от этой песни», когда ничего не играет', () => {
      render(<WaveSourcePicker />);

      const trackChip = screen.getByTestId('wave-source-chip-track');
      expect(trackChip).toBeDisabled();
      fireEvent.click(trackChip);
      expect(usePlayerStore.getState().waveSeedKind).toBe('library');
    });

    it('берёт за отправную точку играющую песню', () => {
      usePlayerStore.setState({ currentTrack: mockTrack1 });

      render(<WaveSourcePicker />);

      const trackChip = screen.getByTestId('wave-source-chip-track');
      expect(trackChip).not.toBeDisabled();
      // Подпись называет саму песню: от неё и пойдёт Поток.
      expect(trackChip).toHaveTextContent(mockTrack1.title);

      fireEvent.click(trackChip);
      expect(usePlayerStore.getState().waveSeedKind).toBe('track');
    });

    it('предлагает артистов из избранного и текущего трека', () => {
      useLibraryStore.setState({ favorites: [mockTrack2] });
      usePlayerStore.setState({ currentTrack: mockTrack1 });

      render(<WaveSourcePicker />);

      fireEvent.click(screen.getByTestId('wave-source-chip-artist'));
      expect(usePlayerStore.getState().waveSeedKind).toBe('artist');
      // Текущий трек идёт первым: волну чаще всего продолжают от него.
      expect(usePlayerStore.getState().waveSeedArtist).toBe('Synth Master');

      fireEvent.click(screen.getByTestId('wave-seed-artist-1'));
      expect(usePlayerStore.getState().waveSeedArtist).toBe('Retro Wave');
    });

    it('перезапускает волну при смене источника, если она играет', async () => {
      usePlayerStore.setState({ queueMode: 'my_wave' });
      const startSpy = vi.spyOn(usePlayerStore.getState(), 'startMyWave').mockResolvedValue(undefined);

      render(<WaveSourcePicker />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('wave-source-chip-discovery'));
      });

      expect(startSpy).toHaveBeenCalled();
    });

    it('ранжирует артистов по частоте', () => {
      const list = suggestSeedArtists([
        { ...mockTrack1, id: 'a' },
        { ...mockTrack2, id: 'b' },
        { ...mockTrack2, id: 'c' }
      ]);
      expect(list).toEqual(['Retro Wave', 'Synth Master']);
    });
  });

  describe('WaveControls', () => {
    it('renders like, dislike, more, and toggle buttons', () => {
      render(<WaveControls />);

      expect(screen.getByTestId('wave-btn-dislike')).toBeInTheDocument();
      expect(screen.getByTestId('wave-btn-like')).toBeInTheDocument();
      expect(screen.getByTestId('wave-btn-toggle-play')).toBeInTheDocument();
      expect(screen.getByTestId('wave-btn-more')).toBeInTheDocument();
    });

    it('toggles favorite when liking current track', async () => {
      usePlayerStore.setState({ currentTrack: mockTrack1 });
      const toggleFavSpy = vi.spyOn(useLibraryStore.getState(), 'toggleFavorite').mockResolvedValue(true);
      const recordFeedbackSpy = vi.spyOn(recommendationEngine, 'recordFeedback').mockResolvedValue(undefined);

      render(<WaveControls />);

      const likeBtn = screen.getByTestId('wave-btn-like');
      await act(async () => {
        fireEvent.click(likeBtn);
      });

      expect(toggleFavSpy).toHaveBeenCalledWith(mockTrack1);
      expect(recordFeedbackSpy).toHaveBeenCalledWith(mockTrack1, 'like');
    });

    it('dislikes and skips track when dislike clicked', async () => {
      usePlayerStore.setState({ currentTrack: mockTrack1 });
      const dislikeSpy = vi.spyOn(usePlayerStore.getState(), 'dislikeAndSkipCurrentTrack').mockResolvedValue(undefined);

      render(<WaveControls />);

      const dislikeBtn = screen.getByTestId('wave-btn-dislike');
      await act(async () => {
        fireEvent.click(dislikeBtn);
      });

      expect(dislikeSpy).toHaveBeenCalled();
    });

    it('requests more like this when more button clicked', async () => {
      usePlayerStore.setState({ currentTrack: mockTrack1 });
      const feedbackSpy = vi.spyOn(recommendationEngine, 'recordFeedback').mockResolvedValue(undefined);
      const replenishSpy = vi.spyOn(usePlayerStore.getState(), 'replenishAutoplayQueue').mockResolvedValue(undefined);

      render(<WaveControls />);

      const moreBtn = screen.getByTestId('wave-btn-more');
      await act(async () => {
        fireEvent.click(moreBtn);
      });

      expect(feedbackSpy).toHaveBeenCalledWith(mockTrack1, 'more_like_this');
      expect(replenishSpy).toHaveBeenCalled();
    });

    it('invokes startMyWave on primary button when wave is not active', async () => {
      const startWaveSpy = vi.spyOn(usePlayerStore.getState(), 'startMyWave').mockResolvedValue(undefined);

      render(<WaveControls />);

      const playBtn = screen.getByTestId('wave-btn-toggle-play');
      await act(async () => {
        fireEvent.click(playBtn);
      });

      expect(startWaveSpy).toHaveBeenCalled();
    });

    it('пересобирает поток по текущим настройкам, когда волна уже играет', async () => {
      usePlayerStore.setState({ queueMode: 'my_wave', currentTrack: mockTrack1 });
      const startWaveSpy = vi.spyOn(usePlayerStore.getState(), 'startMyWave').mockResolvedValue(undefined);

      render(<WaveControls />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('wave-btn-restart'));
      });

      expect(startWaveSpy).toHaveBeenCalled();
      expect(useUIStore.getState().toastMessage?.text).toContain('пересобран');
    });

    it('не показывает «Пересобрать», пока волна не запущена', () => {
      render(<WaveControls />);
      expect(screen.queryByTestId('wave-btn-restart')).not.toBeInTheDocument();
    });

    it('остаётся кнопкой «Остановить», пока волна молча добирает треки в фоне', () => {
      // Волна дозаполняет очередь сама, каждый раз когда в ней остаётся два трека.
      // Если считать это занятостью, главная кнопка посреди спокойного
      // воспроизведения показывает крутилку и «Загрузка...» — музыка играет, а
      // интерфейс сообщает, что чего-то ждёт.
      usePlayerStore.setState({
        queueMode: 'my_wave',
        currentTrack: mockTrack1,
        isPlaying: true,
        isReplenishingQueue: true
      });

      render(<WaveControls />);

      expect(screen.getByTestId('wave-btn-toggle-play')).toHaveTextContent('Остановить');
      expect(screen.getByTestId('wave-btn-toggle-play')).not.toHaveTextContent('Загрузка');
    });

    it('но на холодном старте про сбор рекомендаций сообщает', () => {
      // `startMyWave` ждёт рекомендации секундами до того, как появится трек и
      // взлетит `isLoading`. Без этого случая нажатие «Запустить Поток» осталось бы
      // совсем без отклика.
      usePlayerStore.setState({
        queueMode: 'my_wave',
        currentTrack: null,
        isPlaying: false,
        isReplenishingQueue: true
      });

      render(<WaveControls />);

      expect(screen.getByTestId('wave-btn-toggle-play')).toHaveTextContent('Загрузка');
    });

    it('на загрузке трека показывает загрузку — про неё как раз и ждут', () => {
      usePlayerStore.setState({ queueMode: 'my_wave', currentTrack: mockTrack1, isLoading: true });

      render(<WaveControls />);

      expect(screen.getByTestId('wave-btn-toggle-play')).toHaveTextContent('Загрузка');
    });

    it('не даёт пересобрать поток, пока предыдущий сбор ещё идёт', () => {
      usePlayerStore.setState({
        queueMode: 'my_wave',
        currentTrack: mockTrack1,
        isReplenishingQueue: true
      });

      render(<WaveControls />);

      expect(screen.getByTestId('wave-btn-restart')).toBeDisabled();
    });

    it('сообщает, если добавить в любимое не удалось', async () => {
      // `toggleFavorite` про отказ сообщает через `false`, а не исключением: без
      // разбора этого случая сердце выглядело мёртвой кнопкой.
      usePlayerStore.setState({ currentTrack: mockTrack1 });
      vi.spyOn(useLibraryStore.getState(), 'toggleFavorite').mockResolvedValue(false);
      useLibraryStore.setState({ error: 'База недоступна' });
      const recordFeedbackSpy = vi.spyOn(recommendationEngine, 'recordFeedback').mockResolvedValue(undefined);

      render(<WaveControls />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('wave-btn-like'));
      });

      expect(useUIStore.getState().toastMessage?.text).toBe('База недоступна');
      expect(useUIStore.getState().toastMessage?.type).toBe('error');
      // И предпочтение не записывается: трек в любимое не попал.
      expect(recordFeedbackSpy).not.toHaveBeenCalled();
    });
  });

  describe('WaveView Integration', () => {
    beforeEach(() => {
      vi.spyOn(recommendationEngine, 'buildUserProfile').mockResolvedValue(emptyProfile());
    });

    it('renders wave view container with header, visualizer orb and controls', async () => {
      render(<WaveView />);

      expect(screen.getByTestId('wave-view')).toBeInTheDocument();
      expect(screen.getByText('Поток')).toBeInTheDocument();
      expect(screen.getByTestId('wave-visualizer-orb')).toBeInTheDocument();
      expect(screen.getByTestId('wave-controls')).toBeInTheDocument();
      await waitFor(() => {
        expect(recommendationEngine.buildUserProfile).toHaveBeenCalled();
      });
    });

    it('пишет в подзаголовке, что настроено, а не обещания', async () => {
      usePlayerStore.setState({
        waveNovelty: 0.9,
        waveEnergy: 0.1,
        waveSeedKind: 'artist',
        waveSeedArtist: 'Synth Master',
        activeWaveGenre: 'Rock'
      });

      render(<WaveView />);

      const summary = screen.getByTestId('wave-config-summary');
      expect(summary).toHaveTextContent('от одного артиста');
      expect(summary).toHaveTextContent('Synth Master');
      expect(summary).toHaveTextContent('почти только новое');
      expect(summary).toHaveTextContent('совсем спокойное');
      expect(summary).toHaveTextContent('Rock');
      await waitFor(() => {
        expect(recommendationEngine.buildUserProfile).toHaveBeenCalled();
      });
    });

    it('displays current track metadata when available', async () => {
      usePlayerStore.setState({
        currentTrack: mockTrack1,
        isPlaying: true,
        queueMode: 'my_wave'
      });

      render(<WaveView />);

      expect(screen.getByTestId('wave-current-track')).toHaveTextContent('Cyberpunk City Flow');
      expect(screen.getByTestId('wave-current-track')).toHaveTextContent('Synth Master');
      await waitFor(() => {
        expect(recommendationEngine.buildUserProfile).toHaveBeenCalled();
      });
    });

    it('объясняет, почему трек играет', async () => {
      // Избранное берётся из живого стора, а не из снятого профиля: лайк
      // виден сразу, без повторного чтения базы.
      useLibraryStore.setState({ favorites: [mockTrack1] });
      usePlayerStore.setState({
        currentTrack: mockTrack1,
        queueMode: 'my_wave'
      });

      render(<WaveView />);

      await waitFor(() => {
        expect(screen.getByTestId('wave-current-reason')).toHaveTextContent('Из вашего избранного');
      });
    });

    it('displays upcoming wave flow when source queue has items', async () => {
      usePlayerStore.setState({
        currentTrack: mockTrack1,
        sourceQueue: [mockTrack1, mockTrack2],
        currentIndex: 0,
        queueMode: 'my_wave'
      });

      render(<WaveView />);

      expect(screen.getByTestId('wave-upcoming-flow')).toBeInTheDocument();
      expect(screen.getByText('Далее в Потоке')).toBeInTheDocument();
      expect(screen.getByTestId(`wave-upcoming-item-${mockTrack2.id}`)).toHaveTextContent('Neon Horizon');

      // Причина стоит рядом с каждым треком, а не только у текущего.
      await waitFor(() => {
        expect(screen.getByTestId(`wave-upcoming-item-${mockTrack2.id}`)).toHaveTextContent(
          'Новое имя для вас'
        );
      });
    });

    it('убирает трек из Потока и запоминает отказ', async () => {
      usePlayerStore.setState({
        currentTrack: mockTrack1,
        sourceQueue: [mockTrack1, mockTrack2],
        currentIndex: 0,
        queueMode: 'my_wave'
      });
      const feedbackSpy = vi.spyOn(recommendationEngine, 'recordFeedback').mockResolvedValue(undefined);

      render(<WaveView />);

      await act(async () => {
        fireEvent.click(screen.getByTestId(`wave-item-remove-${mockTrack2.id}`));
      });

      expect(usePlayerStore.getState().sourceQueue.map((t) => t.id)).toEqual([mockTrack1.id]);
      // Текущий трек остался текущим: индекс пересчитан, а не сдвинут наугад.
      expect(usePlayerStore.getState().currentIndex).toBe(0);
      expect(feedbackSpy).toHaveBeenCalledWith(mockTrack2, 'dislike');
    });

    it('просит больше похожего на конкретный трек из Потока', async () => {
      usePlayerStore.setState({
        currentTrack: mockTrack1,
        sourceQueue: [mockTrack1, mockTrack2],
        currentIndex: 0,
        queueMode: 'my_wave'
      });
      const feedbackSpy = vi.spyOn(recommendationEngine, 'recordFeedback').mockResolvedValue(undefined);
      const replenishSpy = vi
        .spyOn(usePlayerStore.getState(), 'replenishAutoplayQueue')
        .mockResolvedValue(undefined);

      render(<WaveView />);

      await act(async () => {
        fireEvent.click(screen.getByTestId(`wave-item-more-${mockTrack2.id}`));
      });

      expect(feedbackSpy).toHaveBeenCalledWith(mockTrack2, 'more_like_this');
      expect(replenishSpy).toHaveBeenCalled();
    });

    it('честно предупреждает, что персонализировать пока нечем', async () => {
      render(<WaveView />);

      expect(screen.getByTestId('wave-cold-start')).toBeInTheDocument();
      await waitFor(() => {
        expect(recommendationEngine.buildUserProfile).toHaveBeenCalled();
      });
    });

    it('не предупреждает про пустую библиотеку, когда источник — незнакомое', async () => {
      usePlayerStore.setState({ waveSeedKind: 'discovery' });

      render(<WaveView />);

      expect(screen.queryByTestId('wave-cold-start')).not.toBeInTheDocument();
      await waitFor(() => {
        expect(recommendationEngine.buildUserProfile).toHaveBeenCalled();
      });
    });

    it('объясняет пустой поток вместо пустого места', async () => {
      usePlayerStore.setState({
        currentTrack: mockTrack1,
        sourceQueue: [mockTrack1],
        currentIndex: 0,
        queueMode: 'my_wave',
        isReplenishingQueue: false
      });

      render(<WaveView />);

      expect(screen.getByTestId('wave-empty-stream')).toBeInTheDocument();
      expect(screen.queryByTestId('wave-upcoming-flow')).not.toBeInTheDocument();
      await waitFor(() => {
        expect(recommendationEngine.buildUserProfile).toHaveBeenCalled();
      });
    });
  });
});
