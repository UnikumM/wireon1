import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Common Components
import { Button } from '../../src/components/common/Button';
import { Modal } from '../../src/components/common/Modal';
import { SourceBadge } from '../../src/components/common/SourceBadge';
import { VolumeSlider } from '../../src/components/common/VolumeSlider';
import { Toast } from '../../src/components/common/Toast';

// Layout Components
import { AppShell } from '../../src/components/layout/AppShell';
import { Sidebar } from '../../src/components/layout/Sidebar';
import { Header } from '../../src/components/layout/Header';
import { MobileNav } from '../../src/components/layout/MobileNav';

// Search Components
import { SearchBar } from '../../src/components/search/SearchBar';
import { TrackCard } from '../../src/components/search/TrackCard';
import { SearchResults } from '../../src/components/search/SearchResults';

// Player & Visualizer Components
import { AudioVisualizer } from '../../src/components/player/AudioVisualizer';
import { PlayerBar } from '../../src/components/player/PlayerBar';
import { QueueDrawer } from '../../src/components/player/QueueDrawer';
import { FullscreenPlayer } from '../../src/components/player/FullscreenPlayer';

// Library Components
import { CreatePlaylistModal } from '../../src/components/library/CreatePlaylistModal';
import { FavoritesView } from '../../src/components/library/FavoritesView';
import { PlaylistView } from '../../src/components/library/PlaylistView';
import { LibraryView } from '../../src/components/library/LibraryView';

// Auth Components
import { DiscordLoginButton, UserProfile } from '../../src/components/auth';

// App Core
import { App } from '../../src/App';

// Stores & Types
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { UnifiedTrack } from '../../src/types/music';
import { searchAggregator } from '../../src/services/aggregator';
import { isDiscordConfigured } from '../../src/services/discordAuth';
import * as dbService from '../../src/services/db';
import { resetAuthStore, signInForTests } from '../helpers/testUtils';

// Mock Canvas 2D context for jsdom environment
beforeEach(() => {
  // Вход, выставленный одной проверкой, не должен доставаться следующей: часть
  // из них про то, как выглядит именно гость.
  resetAuthStore();
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
    closePath: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    scale: vi.fn(),
    createLinearGradient: vi.fn().mockReturnValue({
      addColorStop: vi.fn(),
    }),
    createRadialGradient: vi.fn().mockReturnValue({
      addColorStop: vi.fn(),
    }),
  });

  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
    width: 400,
    height: 150,
    top: 0,
    left: 0,
    bottom: 150,
    right: 400,
  });

  // Reset stores to default state
  usePlayerStore.setState({
    currentTrack: null,
    isPlaying: false,
    isLoading: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 0.8,
    isMuted: false,
    repeatMode: 'off',
    isShuffled: false,
    userQueue: [],
    sourceQueue: [],
    history: [],
    currentIndex: -1,
    shuffleOrder: [],
    visualizerEnabled: true,
    visualizerPreset: 'CYBER_BARS',
  });

  useUIStore.setState({
    activeView: 'search',
    activePlaylistId: null,
    isQueueOpen: false,
    isFullscreenPlayerOpen: false,
    searchQuery: '',
    searchFilter: 'all',
    toastMessage: null,
  });

  useLibraryStore.setState({
    favorites: [],
    playlists: [],
    history: [],
    isLoading: false,
  });
});

const sampleTrackYT: UnifiedTrack = {
  id: 'yt_test123',
  source: 'youtube',
  originalId: 'test123',
  title: 'Synthwave Night Ride',
  artist: 'Cyber Dreamer',
  duration: 215,
  artworkUrl: 'https://example.com/art1.jpg',
};

const sampleTrackSC: UnifiedTrack = {
  id: 'sc_test456',
  source: 'soundcloud',
  originalId: 'test456',
  title: 'Obsidian Neon Echoes',
  artist: 'Wireon Wave',
  duration: 180,
  artworkUrl: 'https://example.com/art2.jpg',
};

describe('Milestone 3 UI & Player Components Test Suite', () => {
  // ==========================================
  // 1. Common Components
  // ==========================================
  describe('Common Components', () => {
    it('Button renders correctly with variants, sizes, loading, and click handling', () => {
      const handleClick = vi.fn();
      const { rerender } = render(
        <Button variant="neon" size="md" onClick={handleClick}>
          Play Music
        </Button>
      );

      const btn = screen.getByRole('button', { name: /play music/i });
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);
      expect(handleClick).toHaveBeenCalledTimes(1);

      // Loading state
      rerender(
        <Button variant="danger" isLoading>
          Deleting
        </Button>
      );
      expect(screen.getByRole('button')).toBeDisabled();
    });

    it('Modal renders title, body, footer, responds to Escape key and backdrop clicks', async () => {
      const handleClose = vi.fn();
      const { rerender } = render(
        <Modal isOpen={true} onClose={handleClose} title="Create Mix" footer={<button>Save</button>}>
          <div>Modal Content Body</div>
        </Modal>
      );

      expect(screen.getByText('Create Mix')).toBeInTheDocument();
      expect(screen.getByText('Modal Content Body')).toBeInTheDocument();
      expect(screen.getByText('Save')).toBeInTheDocument();

      // Press Escape key
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(1);

      // Backdrop click
      const backdrop = screen.getByTestId('modal-backdrop');
      fireEvent.click(backdrop);
      expect(handleClose).toHaveBeenCalledTimes(2);

      // Closing plays the exit frames first: `isOpen` is already false while the
      // panel is still mounted, marked `data-leaving` and inert. It used to
      // vanish between two frames — a fade in and a jump cut out.
      rerender(
        <Modal isOpen={false} onClose={handleClose}>
          <div>Hidden</div>
        </Modal>
      );
      const leaving = screen.getByTestId('modal-backdrop');
      expect(leaving).toHaveAttribute('data-leaving', 'true');
      expect(leaving.className).toContain('animate-fade-out');
      expect(screen.getByTestId('modal-container').className).toContain('animate-pop-out');

      // Догорающее изображение окна — уже не диалог: скринридер его не читает,
      // таб в него не попадает, роль снята.
      expect(leaving).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByTestId('modal-container')).not.toHaveAttribute('role');

      // ...and only then leaves the tree.
      await waitFor(() => {
        expect(screen.queryByTestId('modal-backdrop')).not.toBeInTheDocument();
      });
      expect(screen.queryByText('Modal Content Body')).not.toBeInTheDocument();
    });

    it('a modal that was never open does not play the exit animation', () => {
      // Иначе первый же рендер закрытого окна мигнул бы затемнением: все
      // вызывающие держат примитив в дереве с `isOpen={false}`.
      render(
        <Modal isOpen={false} onClose={vi.fn()}>
          <div>Never Shown</div>
        </Modal>
      );
      expect(screen.queryByTestId('modal-backdrop')).not.toBeInTheDocument();
    });

    it('SourceBadge renders badges for YouTube, SoundCloud, and All sources', () => {
      const { rerender } = render(<SourceBadge source="youtube" size="sm" />);
      expect(screen.getByText(/youtube/i)).toBeInTheDocument();

      rerender(<SourceBadge source="soundcloud" size="xs" />);
      expect(screen.getByText(/sc/i)).toBeInTheDocument();

      rerender(<SourceBadge source="all" size="md" />);
      expect(screen.getByText(/все источники/i)).toBeInTheDocument();
    });

    it('VolumeSlider updates volume and handles mute toggle', () => {
      const handleVol = vi.fn();
      const handleMute = vi.fn();
      render(
        <VolumeSlider
          volume={0.7}
          isMuted={false}
          onVolumeChange={handleVol}
          onToggleMute={handleMute}
          showPercentage={true}
        />
      );

      expect(screen.getByText('70%')).toBeInTheDocument();
      const muteBtn = screen.getByRole('button', { name: /звук/i });
      fireEvent.click(muteBtn);
      expect(handleMute).toHaveBeenCalledTimes(1);

      const slider = screen.getByLabelText(/громкость/i);
      fireEvent.change(slider, { target: { value: '0.4' } });
      expect(handleVol).toHaveBeenCalledWith(0.4);
    });

    it('Toast renders notification messages and auto-clears', async () => {
      useUIStore.getState().showToast('Test Notification', 'success');
      render(<Toast />);

      expect(screen.getByText('Test Notification')).toBeInTheDocument();
      const dismissBtn = screen.getByLabelText(/закрыть уведомление/i);
      fireEvent.click(dismissBtn);
      expect(useUIStore.getState().toastMessage).toBeNull();

      // Хранилище чистится сразу, а карточка ещё доигрывает кадры ухода: иначе
      // повтор того же текста был бы принят за дубликат и не показался.
      const card = screen.getByTestId('toast-notification');
      expect(card).toHaveAttribute('data-leaving', 'true');
      expect(card.className).toContain('animate-slide-out');

      await waitFor(() => {
        expect(screen.queryByTestId('toast-notification')).not.toBeInTheDocument();
      });
    });
  });

  // ==========================================
  // 2. Layout Components
  // ==========================================
  describe('Layout Components', () => {
    it('Sidebar renders navigation links, playlist items, and switches views', () => {
      useLibraryStore.setState({
        playlists: [
          {
            id: 'pl_1',
            title: 'Chill Wave',
            tracks: [sampleTrackYT],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            isSynced: true,
          },
        ],
      });

      const handleCreatePl = vi.fn();
      render(<Sidebar onCreatePlaylistClick={handleCreatePl} />);

      expect(screen.getByTestId('app-sidebar')).toBeInTheDocument();

      /*
       * Снизу боковая панель обязана оставить место полосе плеера.
       *
       * Полоса лежит `position: fixed` во всю ширину окна — то есть поверх
       * панели тоже. У `<main>` место под неё зарезервировано с самого начала, у
       * панели не было, и её нижний ряд, пилюля аккаунта, оказывался целиком под
       * полосой: замерено 821–876 px при полосе от 804 px в окне 1600×900.
       * Кнопка была на месте и отвечала на клавиатуру, но мышь до неё не
       * доставала вовсе. Владелец обвёл это место на снимке.
       *
       * Проверяется именно `--player-bar-space`, а не число: `--player-bar-height`
       * пресет пишет инлайном в `:root`, и на узком экране её не переопределить
       * (см. `theme.css`), поэтому под отступы существует отдельная переменная.
       */
      const sidebarPadding = screen.getByTestId('app-sidebar').style.padding;
      expect(sidebarPadding).toContain('var(--player-bar-space)');
      // The wordmark is one colour now ("Wireon" + a lighter-weight "Sounds"),
      // so match the element that owns both spans rather than a single text node.
      expect(screen.getByLabelText('Wireon Sounds — на главную')).toHaveTextContent('Wireon Sounds');

      // Navigation switching
      fireEvent.click(screen.getByTestId('sidebar-nav-favorites'));
      expect(useUIStore.getState().activeView).toBe('favorites');

      fireEvent.click(screen.getByTestId('sidebar-nav-wave'));
      expect(useUIStore.getState().activeView).toBe('wave');

      fireEvent.click(screen.getByTestId('sidebar-nav-library'));
      expect(useUIStore.getState().activeView).toBe('library');

      // Click playlist item
      fireEvent.click(screen.getByTestId('sidebar-playlist-pl_1'));
      expect(useUIStore.getState().activeView).toBe('playlist');
      expect(useUIStore.getState().activePlaylistId).toBe('pl_1');

      // Click create playlist shortcut
      fireEvent.click(screen.getByTestId('sidebar-create-playlist-btn'));
      expect(handleCreatePl).toHaveBeenCalled();
    });

    // Очередь из шапки убрана: та же панель открывалась кнопкой в полосе плеера.
    // Счётчик и открытие проверяет playerLayout.test.tsx на оставшейся кнопке.
    it('Header displays active view title and toggles the visualizer', () => {
      useUIStore.setState({ activeView: 'search' });

      render(<Header />);

      expect(screen.getByText('Поиск')).toBeInTheDocument();
      expect(screen.queryByTestId('header-queue-toggle')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('header-visualizer-toggle'));
      expect(usePlayerStore.getState().visualizerEnabled).toBe(false);
    });

    it('MobileNav navigates across mobile views', () => {
      render(<MobileNav />);
      fireEvent.click(screen.getByTestId('mobile-nav-wave'));
      expect(useUIStore.getState().activeView).toBe('wave');

      fireEvent.click(screen.getByTestId('mobile-nav-library'));
      expect(useUIStore.getState().activeView).toBe('library');

      fireEvent.click(screen.getByTestId('mobile-nav-search'));
      expect(useUIStore.getState().activeView).toBe('search');
    });

    it('MobileNav не повторяет то, что уже есть вкладками медиатеки', () => {
      // «Избранное» и «Плейлисты» — вкладки внутри `LibraryView`. Пока они были
      // ещё и в панели, один экран стоял в ней трижды, а подписи шести разделов
      // не влезали в ширину телефона: «Настройки» обрезались на «Настройк».
      render(<MobileNav />);
      expect(screen.queryByTestId('mobile-nav-favorites')).toBeNull();
      expect(screen.queryByTestId('mobile-nav-playlists')).toBeNull();
      expect(screen.queryByTestId('mobile-nav-settings')).toBeNull();
    });

    it('AppShell mounts all layout sections and slots', () => {
      render(
        <AppShell
          playerBarSlot={<div data-testid="player-bar-slot">Player Bar</div>}
          queueDrawerSlot={<div data-testid="queue-drawer-slot">Queue Drawer</div>}
        >
          <div data-testid="test-content">Main View Content</div>
        </AppShell>
      );

      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.getByTestId('test-content')).toBeInTheDocument();
      expect(screen.getByTestId('player-bar-slot')).toBeInTheDocument();
      expect(screen.getByTestId('queue-drawer-slot')).toBeInTheDocument();
    });
  });

  // ==========================================
  // 3. Search Components
  // ==========================================
  describe('Search Components', () => {
    it('SearchBar debounces the query, clears it, and submits on Enter', async () => {
      const handleQuery = vi.fn();
      const handleSubmit = vi.fn();
      const handleClear = vi.fn();

      render(
        <SearchBar
          query=""
          onQueryChange={handleQuery}
          onSearchSubmit={handleSubmit}
          onClear={handleClear}
        />
      );

      const input = screen.getByTestId('search-input');
      fireEvent.change(input, { target: { value: 'Cyberpunk' } });

      // Debounced: the parent is not told about every keystroke.
      expect(handleQuery).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(handleQuery).toHaveBeenCalledWith('Cyberpunk');
      });

      // Enter bypasses the debounce.
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(handleSubmit).toHaveBeenCalledWith('Cyberpunk');

      fireEvent.click(screen.getByTestId('search-clear-btn'));
      expect(handleClear).toHaveBeenCalled();
      expect(input).toHaveValue('');
    });

    it('TrackCard renders metadata, triggers playback, adds to queue, and favorites', async () => {
      // Медиатека принадлежит аккаунту: гость её не пополняет — вместо
      // избранного и нового плейлиста ему показывается приглашение войти.
      signInForTests();
      const handlePlay = vi.fn();
      render(
        <TrackCard
          track={sampleTrackYT}
          index={0}
          layout="row"
          onPlay={handlePlay}
        />
      );

      expect(screen.getByText('Synthwave Night Ride')).toBeInTheDocument();
      expect(screen.getByText('Cyber Dreamer')).toBeInTheDocument();
      expect(screen.getByText('3:35')).toBeInTheDocument();

      // Play click
      const row = screen.getByTestId(`track-row-${sampleTrackYT.id}`);
      fireEvent.click(row);
      expect(handlePlay).toHaveBeenCalledWith(sampleTrackYT);

      // Add to queue click
      const queueBtn = screen.getByTestId(`track-queue-btn-${sampleTrackYT.id}`);
      fireEvent.click(queueBtn);
      expect(usePlayerStore.getState().userQueue).toHaveLength(1);
      expect(usePlayerStore.getState().userQueue[0].id).toBe(sampleTrackYT.id);

      // Favorite toggle
      const favBtn = screen.getByTestId(`track-fav-btn-${sampleTrackYT.id}`);
      fireEvent.click(favBtn);
      await waitFor(() => {
        expect(useLibraryStore.getState().favorites).toHaveLength(1);
      });

      // Context menu radio action
      const radioSpy = vi.spyOn(usePlayerStore.getState(), 'startTrackRadio').mockResolvedValue();
      const moreBtn = screen.getByTestId(`track-more-btn-${sampleTrackYT.id}`);
      fireEvent.click(moreBtn);
      const radioMenuBtn = screen.getByTestId(`menu-track-radio-${sampleTrackYT.id}`);
      expect(radioMenuBtn).toBeInTheDocument();
      fireEvent.click(radioMenuBtn);
      expect(radioSpy).toHaveBeenCalledWith(sampleTrackYT);
    });

    it('SearchResults performs aggregation and renders top result hero and song rows', async () => {
      vi.spyOn(searchAggregator, 'search').mockResolvedValue({
        results: [sampleTrackYT, sampleTrackSC],
        sources: { youtube: 1, soundcloud: 1 },
      });

      useUIStore.setState({ searchQuery: 'Cyberpunk' });

      render(<SearchResults />);

      await waitFor(() => {
        expect(screen.getByTestId(`track-hero-${sampleTrackYT.id}`)).toBeInTheDocument();
        expect(screen.getByTestId(`track-row-${sampleTrackSC.id}`)).toBeInTheDocument();
      });
    });
  });

  // ==========================================
  // 4. Player & Visualizer Components
  // ==========================================
  describe('Player & Visualizer Components', () => {
    it('AudioVisualizer mounts canvas and renders without errors', () => {
      const { container } = render(<AudioVisualizer preset="CYBER_BARS" height={100} width={200} />);
      const canvas = container.querySelector('canvas');
      expect(canvas).toBeInTheDocument();
    });

    it('PlayerBar displays track info, playback controls, scrubber, and volume', async () => {
      usePlayerStore.setState({
        currentTrack: sampleTrackYT,
        isPlaying: true,
        playbackState: 'playing',
        duration: 215,
        currentTime: 45,
      });

      render(<PlayerBar />);

      expect(screen.getByTestId('player-track-title')).toHaveTextContent('Synthwave Night Ride');
      expect(screen.getByTestId('player-current-time')).toHaveTextContent('0:45');
      expect(screen.getByTestId('player-duration')).toHaveTextContent('3:35');

      // Pause button click
      const playPauseBtn = screen.getByTestId('player-play-pause-btn');
      await act(async () => {
        fireEvent.click(playPauseBtn);
      });
      expect(usePlayerStore.getState().isPlaying).toBe(false);

      // Shuffle toggle
      fireEvent.click(screen.getByTestId('player-shuffle-btn'));
      expect(usePlayerStore.getState().isShuffled).toBe(true);

      // Repeat toggle
      fireEvent.click(screen.getByTestId('player-repeat-btn'));
      expect(usePlayerStore.getState().repeatMode).toBe('all');

      // Seek
      const seekSlider = screen.getByTestId('player-seek-slider');
      fireEvent.change(seekSlider, { target: { value: '100' } });
      expect(usePlayerStore.getState().currentTime).toBe(100);
    });

    it('PlayerBar labels a snipped stream and keeps the raw cause in a tooltip', () => {
      // A 30-second SoundCloud snippet playing under a five-minute duration
      // reads as a bug unless the bar says so, and the friendly error copy is
      // useless in a bug report unless the thrown message is still reachable.
      usePlayerStore.setState({
        currentTrack: sampleTrackSC,
        playbackState: 'playing',
        isPreviewStream: true,
        error: 'SoundCloud only offers a protected version of this track.',
        errorDetail: 'SoundCloud track 284056452 is only offered as DRM-protected audio',
        errorCanRetry: false,
      });

      const { rerender } = render(<PlayerBar />);

      expect(screen.getByTestId('player-preview-badge')).toHaveTextContent(/отрывок/i);
      expect(screen.getByTestId('player-error-message')).toHaveAttribute(
        'title',
        'SoundCloud track 284056452 is only offered as DRM-protected audio'
      );

      act(() => {
        usePlayerStore.setState({ isPreviewStream: false });
      });
      rerender(<PlayerBar />);
      expect(screen.queryByTestId('player-preview-badge')).not.toBeInTheDocument();
    });

    it('миниатюра визуализатора снимается, пока открыт плеер на весь экран', () => {
      // Оверлей непрозрачный и держит свой визуализатор. Оставленный под ним
      // холст никому не виден, а кадры считает — два спектра одновременно.
      usePlayerStore.setState({
        currentTrack: sampleTrackYT,
        isPlaying: true,
        visualizerEnabled: true,
      });
      useUIStore.setState({ isFullscreenPlayerOpen: false });

      const { rerender } = render(<PlayerBar />);
      expect(screen.getByTestId('player-mini-visualizer')).toBeInTheDocument();

      act(() => {
        useUIStore.setState({ isFullscreenPlayerOpen: true });
      });
      rerender(<PlayerBar />);
      expect(screen.queryByTestId('player-mini-visualizer')).not.toBeInTheDocument();
    });

    it('время воспроизведения доходит до таймлайна, минуя полосу плеера', () => {
      /*
       * `timeupdate` приходит примерно четыре раза в секунду. Пока время читала
       * сама полоса плеера, каждый тик перерисовывал её целиком — транспорт,
       * бегущую строку, меню, караоке — ради двух цифр и ширины заливки.
       * Подписка живёт в <PlayerProgress>, и проверяется здесь именно то, что
       * от переноса не пострадало: цифры по-прежнему обновляются.
       */
      usePlayerStore.setState({
        currentTrack: sampleTrackYT,
        duration: 200,
        currentTime: 10,
      });

      render(<PlayerBar />);
      expect(screen.getByTestId('player-current-time')).toHaveTextContent('0:10');

      act(() => {
        usePlayerStore.setState({ currentTime: 125 });
      });
      expect(screen.getByTestId('player-current-time')).toHaveTextContent('2:05');
    });

    it('большие деревья плеера не подписаны на время напрямую', () => {
      // Регресс легко вернуть одной строкой `usePlayerStore((s) => s.currentTime)`,
      // и заметить это по внешнему виду невозможно — приложение просто станет
      // тратить кадры. Поэтому проверяется исходник.
      for (const file of ['PlayerBar.tsx', 'FullscreenPlayer.tsx']) {
        const source = readFileSync(
          path.resolve(__dirname, '../../src/components/player', file),
          'utf8'
        ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

        expect(
          /\(\s*s\s*\)\s*=>\s*s\.currentTime/.test(source),
          `${file} снова подписан на currentTime — используйте <PlayerProgress>`
        ).toBe(false);
      }
    });

    it('QueueDrawer manages Up Next priority queue with removal and clear', () => {
      usePlayerStore.setState({
        currentTrack: sampleTrackYT,
        userQueue: [sampleTrackSC],
      });
      useUIStore.setState({ isQueueOpen: true });

      render(<QueueDrawer />);

      expect(screen.getByTestId('queue-drawer')).toBeInTheDocument();
      expect(screen.getByTestId('queue-now-playing')).toBeInTheDocument();
      expect(screen.getByTestId('user-queue-item-0')).toHaveTextContent('Obsidian Neon Echoes');

      // Remove from queue
      fireEvent.click(screen.getByTestId('remove-queue-item-0'));
      expect(usePlayerStore.getState().userQueue).toHaveLength(0);

      // Close drawer
      fireEvent.click(screen.getByTestId('queue-drawer-close'));
      expect(useUIStore.getState().isQueueOpen).toBe(false);
    });

    it('FullscreenPlayer expands to immersive overlay with visualizer and full controls', () => {
      usePlayerStore.setState({
        currentTrack: sampleTrackYT,
        isPlaying: true,
      });
      useUIStore.setState({ isFullscreenPlayerOpen: true });

      render(<FullscreenPlayer />);

      expect(screen.getByTestId('fullscreen-player')).toBeInTheDocument();
      expect(screen.getByText('Synthwave Night Ride')).toBeInTheDocument();

      // Collapse button
      fireEvent.click(screen.getByTestId('fullscreen-close-btn'));
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(false);
    });

    it('FullscreenPlayer opens minimal: artwork ambience, queue hidden, no style picker', () => {
      usePlayerStore.setState({
        currentTrack: sampleTrackYT,
        sourceQueue: [sampleTrackYT, sampleTrackSC],
        currentIndex: 0,
        isPlaying: true,
      });
      useUIStore.setState({ isFullscreenPlayerOpen: true });

      render(<FullscreenPlayer />);

      // The background is mixed from the artwork, and it drifts while playing.
      const ambient = screen.getByTestId('fullscreen-ambient');
      expect(ambient.querySelector('.ambient-wash-a')).not.toBeNull();

      // The visualizer style now lives in Settings, so no chips here.
      expect(screen.queryByTestId('visualizer-preset-CYBER_BARS')).toBeNull();
      expect(screen.queryByTestId('fullscreen-visualizer-toggle')).toBeNull();

      // Queue starts collapsed and is one click away.
      expect(screen.queryByTestId('fullscreen-queue')).toBeNull();
      fireEvent.click(screen.getByTestId('fullscreen-queue-toggle'));
      expect(screen.getByTestId('fullscreen-queue')).toHaveTextContent('Obsidian Neon Echoes');
    });

    it('FullscreenPlayer settles its ambience when playback is paused', () => {
      usePlayerStore.setState({ currentTrack: sampleTrackYT, isPlaying: false });
      useUIStore.setState({ isFullscreenPlayerOpen: true });

      render(<FullscreenPlayer />);

      // A paused track should not have a moving background.
      expect(screen.getByTestId('fullscreen-ambient').querySelector('.ambient-wash-a')).toBeNull();
    });
  });

  // ==========================================
  // 5. Library & Playlist Components
  // ==========================================
  describe('Library & Playlist Components', () => {
    it('CreatePlaylistModal creates playlist and validates inputs', async () => {
      // Медиатека принадлежит аккаунту: гость её не пополняет — вместо
      // избранного и нового плейлиста ему показывается приглашение войти.
      signInForTests();
      const handleClose = vi.fn();
      const handleCreated = vi.fn();

      render(
        <CreatePlaylistModal
          isOpen={true}
          onClose={handleClose}
          onCreated={handleCreated}
        />
      );

      const input = screen.getByTestId('create-playlist-title-input');
      const submitBtn = screen.getByTestId('create-playlist-submit-btn');

      // Empty submission shows error
      fireEvent.click(submitBtn);
      expect(screen.getByTestId('create-playlist-error')).toHaveTextContent(/введите название/i);

      // Valid submission
      fireEvent.change(input, { target: { value: 'Cyberpunk Synth Beats' } });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(useLibraryStore.getState().playlists).toHaveLength(1);
        expect(useLibraryStore.getState().playlists[0].title).toBe('Cyberpunk Synth Beats');
        expect(handleClose).toHaveBeenCalled();
      });
    });

    it('FavoritesView renders the supplied list and plays it in order', () => {
      const tracks = [sampleTrackYT, sampleTrackSC];
      render(<FavoritesView tracks={tracks} totalCount={tracks.length} />);

      expect(screen.getByTestId('favorites-view')).toBeInTheDocument();
      expect(screen.getByText('Избранное')).toBeInTheDocument();
      expect(screen.getByTestId('favorites-summary')).toHaveTextContent('2 трека');

      // Play all
      fireEvent.click(screen.getByTestId('favorites-play-all-btn'));
      expect(usePlayerStore.getState().currentTrack?.id).toBe(sampleTrackYT.id);
      expect(usePlayerStore.getState().sourceQueue).toHaveLength(2);
    });

    it('FavoritesView reports a filtered subset without inventing rows', () => {
      render(<FavoritesView tracks={[sampleTrackSC]} totalCount={2} query="Obsidian" />);

      expect(screen.getByTestId('favorites-summary')).toHaveTextContent('Показано 1 из 2');
      expect(screen.getByText('Obsidian Neon Echoes')).toBeInTheDocument();
      expect(screen.queryByText('Synthwave Night Ride')).not.toBeInTheDocument();
    });

    it('PlaylistView renames playlist, reorders tracks, and removes tracks', async () => {
      const initialPlaylist = {
        id: 'pl_100',
        title: 'Electronic Odyssey',
        tracks: [sampleTrackYT, sampleTrackSC],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isSynced: false,
      };

      await dbService.savePlaylist(initialPlaylist);
      useLibraryStore.setState({
        playlists: [initialPlaylist],
      });

      render(<PlaylistView playlistId="pl_100" />);

      expect(screen.getByTestId('playlist-title')).toHaveTextContent('Electronic Odyssey');

      // Rename
      fireEvent.click(screen.getByTestId('playlist-rename-btn'));
      const renameInput = screen.getByTestId('playlist-rename-input');
      fireEvent.change(renameInput, { target: { value: 'Synthwave Odyssey' } });
      fireEvent.click(screen.getByTestId('playlist-rename-save-btn'));

      await waitFor(() => {
        expect(useLibraryStore.getState().playlists[0].title).toBe('Synthwave Odyssey');
      });

      // Reorder track
      fireEvent.click(screen.getByTestId('reorder-down-0'));
      await waitFor(() => {
        expect(useLibraryStore.getState().playlists[0].tracks[0].id).toBe(sampleTrackSC.id);
      });

      // Remove track — destructive, so it goes through the confirmation dialog.
      fireEvent.click(screen.getByTestId('remove-track-0'));
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
      await waitFor(() => {
        expect(useLibraryStore.getState().playlists[0].tracks).toHaveLength(1);
      });
    });

    it('LibraryView switches between Playlists, Favorites, and History tabs', () => {
      useLibraryStore.setState({
        playlists: [
          {
            id: 'pl_1',
            title: 'Chill Vibes',
            tracks: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            isSynced: false,
          },
        ],
        favorites: [sampleTrackSC],
        history: [sampleTrackYT],
      });
      // The tab is derived from `activeView`, so the route decides what mounts.
      useUIStore.setState({ activeView: 'playlists' });

      render(<LibraryView />);

      expect(screen.getByTestId('playlist-card-pl_1')).toBeInTheDocument();

      // Switch to History — the tab writes back to `activeView`.
      fireEvent.click(screen.getByTestId('tab-library'));
      expect(useUIStore.getState().activeView).toBe('library');
      expect(screen.getByRole('heading', { name: 'Недавно прослушанное' })).toBeInTheDocument();
      expect(screen.getByText('Synthwave Night Ride')).toBeInTheDocument();

      // Switch to Favorites
      fireEvent.click(screen.getByTestId('tab-favorites'));
      expect(useUIStore.getState().activeView).toBe('favorites');
      expect(screen.getByTestId('favorites-view')).toBeInTheDocument();
    });

    it('«Офлайн» открывается с любой закладки, а не только с «Недавних»', () => {
      /*
       * У «Офлайна» не было своего маршрута: он жил в состоянии `LibraryView`,
       * а выбранная закладка выводилась из `activeView` всякий раз, когда тот
       * указывал на «Избранное» или «Плейлисты». Вывод до состояния просто не
       * доходил, и нажатие проходило впустую: состояние менялось, экран нет.
       */
      useUIStore.setState({ activeView: 'favorites' });
      useLibraryStore.setState({ favorites: [sampleTrackSC] });

      render(<LibraryView />);
      expect(screen.getByTestId('favorites-view')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('tab-offline'));

      expect(useUIStore.getState().activeView).toBe('offline');
      expect(screen.queryByTestId('favorites-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('tab-offline')).toHaveAttribute('aria-selected', 'true');
    });

    it('подпись сортировки в медиатеке — по-русски, как и её варианты', () => {
      // Подпись — единственное доступное имя этого select, поэтому английское
      // слово читал и экранный диктор, стоя между русским плейсхолдером поиска и
      // русским списком вариантов.
      useUIStore.setState({ activeView: 'library' });
      useLibraryStore.setState({ history: [sampleTrackYT] });

      render(<LibraryView />);

      expect(screen.getByLabelText('Сортировка')).toBe(screen.getByTestId('library-sort-select'));
      expect(screen.queryByText('Sort')).not.toBeInTheDocument();
    });
  });

  // ==========================================
  // 6. Auth & Profile Components (Milestone 4)
  // ==========================================
  describe('Auth & Profile Components', () => {
    it('DiscordLoginButton offers a real sign-in now that an application id ships', () => {
      // The application id is compiled in, so a packaged build can finish a
      // login without a .env — the button must therefore be live, not disabled.
      expect(isDiscordConfigured()).toBe(true);

      const handleClick = vi.fn();
      const { rerender } = render(
        <DiscordLoginButton onClick={handleClick} text="Войти через Discord" />
      );

      const btn = screen.getByTestId('discord-login-btn');
      expect(btn).toBeInTheDocument();
      expect(screen.getByText('Войти через Discord')).toBeInTheDocument();
      expect(btn).not.toBeDisabled();
      // No configuration notice: there is nothing left for the user to set up.
      expect(screen.queryByTestId('discord-login-notice')).not.toBeInTheDocument();

      fireEvent.click(btn);
      expect(handleClick).toHaveBeenCalledTimes(1);
      // Clicking starts the flow; it must never fabricate a session by itself.
      expect(useAuthStore.getState().isAuthenticated).toBe(false);

      // Loading state
      rerender(<DiscordLoginButton onClick={handleClick} isLoading={true} />);
      expect(screen.getByTestId('discord-login-spinner')).toBeInTheDocument();
      expect(screen.getByText('Подключаемся…')).toBeInTheDocument();
      expect(screen.getByTestId('discord-login-btn')).toBeDisabled();
    });

    it('UserProfile renders the guest state, sync indicator, and toggles its menu', async () => {
      const { unmount } = render(<UserProfile />);

      expect(screen.getByTestId('user-profile')).toBeInTheDocument();
      expect(screen.getByTestId('user-profile-username')).toHaveTextContent('Гость');
      expect(screen.getByTestId('user-profile-sync-indicator')).toBeInTheDocument();

      // Open dropdown menu
      fireEvent.click(screen.getByTestId('user-profile-btn'));
      expect(screen.getByTestId('user-profile-menu')).toBeInTheDocument();
      expect(screen.getByTestId('user-profile-sync-now')).toBeInTheDocument();
      // A guest gets a working sign-in entry, not an "unavailable" notice.
      expect(screen.getByTestId('user-profile-login')).toBeInTheDocument();
      expect(screen.queryByTestId('user-profile-login-unavailable')).not.toBeInTheDocument();

      // Click sync now — local-only, so it must resolve without a remote.
      fireEvent.click(screen.getByTestId('user-profile-sync-now'));
      await waitFor(() => {
        expect(screen.getByTestId('user-profile-sync-headline')).toBeInTheDocument();
      });

      // Close dropdown
      fireEvent.click(screen.getByTestId('user-profile-btn'));
      expect(screen.queryByTestId('user-profile-menu')).not.toBeInTheDocument();

      unmount();
    });
  });

  // ==========================================
  // 7. Full App Integration
  // ==========================================
  describe('Full App Integration', () => {
    it('App boots cleanly, loads store data, and renders AppShell with search view', async () => {
      render(<App />);

      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.getByTestId('search-view')).toBeInTheDocument();
      expect(screen.getByTestId('player-bar')).toBeInTheDocument();
    });
  });
});

