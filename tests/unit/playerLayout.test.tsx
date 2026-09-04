import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup';
import { PlayerLayoutSettings } from '../../src/components/settings/PlayerLayoutSettings';
import { PlayerBar } from '../../src/components/player/PlayerBar';
import { FullscreenPlayer } from '../../src/components/player/FullscreenPlayer';
import { usePlayerLayoutStore } from '../../src/store/usePlayerLayoutStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { resetPlayerStore, resetLibraryStore, resetUIStore } from '../helpers/testUtils';
import * as dbService from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

const track: UnifiedTrack = {
  id: 'yt_layout_1',
  source: 'youtube',
  originalId: 'layout_1',
  title: 'Neon Grid',
  artist: 'Layout Tester',
  duration: 210,
  artworkUrl: 'https://example.com/layout.jpg'
};

/** Полоса плеера появляется только вместе с треком. */
function renderBarWithTrack(): void {
  act(() => {
    usePlayerStore.setState({ currentTrack: track, duration: track.duration });
  });
  render(<PlayerBar />);
}

describe('Разметка плеера: настройки и полоса', () => {
  beforeEach(async () => {
    resetPlayerStore();
    resetLibraryStore();
    resetUIStore();
    // Гидратацию в этих тестах имитировать не нужно: полоса вызывает её сама, а
    // помеченный флаг не даёт ей перечитать базу и затереть значения из теста.
    usePlayerLayoutStore.getState().resetLayout();
    usePlayerLayoutStore.setState({ layoutHydrated: true });
    await dbService.clearAllData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('PlayerLayoutSettings', () => {
    it('renders the section with every module on', () => {
      render(<PlayerLayoutSettings />);

      expect(screen.getByTestId('settings-section-player')).toBeTruthy();
      for (const key of ['favorite', 'shuffle', 'repeat', 'queue', 'lyrics', 'tempo', 'sleepTimer', 'volume', 'visualizer']) {
        const box = screen.getByTestId(`setting-player-module-${key}`) as HTMLInputElement;
        expect(box.checked).toBe(true);
      }
      for (const key of ['artwork', 'visualizer', 'lyrics', 'queue']) {
        const box = screen.getByTestId(`setting-player-fullscreen-${key}`) as HTMLInputElement;
        expect(box.checked).toBe(true);
      }
    });

    it('turns a bar module off through the store', () => {
      render(<PlayerLayoutSettings />);

      fireEvent.click(screen.getByTestId('setting-player-module-queue'));

      expect(usePlayerLayoutStore.getState().modules.queue).toBe(false);
      expect((screen.getByTestId('setting-player-module-queue') as HTMLInputElement).checked).toBe(false);
    });

    it('turns a fullscreen module off through the store', () => {
      render(<PlayerLayoutSettings />);

      fireEvent.click(screen.getByTestId('setting-player-fullscreen-artwork'));

      expect(usePlayerLayoutStore.getState().fullscreenModules.artwork).toBe(false);
    });

    it('drives the four pickers', () => {
      render(<PlayerLayoutSettings />);

      fireEvent.change(screen.getByTestId('settings-player-density'), { target: { value: 'spacious' } });
      fireEvent.change(screen.getByTestId('settings-player-artwork-shape'), { target: { value: 'circle' } });
      fireEvent.change(screen.getByTestId('settings-player-artwork-click'), { target: { value: 'none' } });
      fireEvent.change(screen.getByTestId('settings-player-progress-style'), { target: { value: 'thick' } });

      const state = usePlayerLayoutStore.getState();
      expect(state.density).toBe('spacious');
      expect(state.artworkShape).toBe('circle');
      expect(state.artworkClickAction).toBe('none');
      expect(state.progressStyle).toBe('thick');
    });

    it('resets everything from the section', () => {
      render(<PlayerLayoutSettings />);
      fireEvent.click(screen.getByTestId('setting-player-module-tempo'));
      fireEvent.change(screen.getByTestId('settings-player-density'), { target: { value: 'compact' } });

      fireEvent.click(screen.getByTestId('settings-player-reset'));

      const state = usePlayerLayoutStore.getState();
      expect(state.modules.tempo).toBe(true);
      expect(state.density).toBe('comfortable');
      expect((screen.getByTestId('setting-player-module-tempo') as HTMLInputElement).checked).toBe(true);
    });
  });

  describe('PlayerBar at defaults', () => {
    it('shows every module', () => {
      renderBarWithTrack();

      expect(screen.getByTestId('player-fav-btn')).toBeTruthy();
      expect(screen.getByTestId('player-shuffle-btn')).toBeTruthy();
      expect(screen.getByTestId('player-repeat-btn')).toBeTruthy();
      expect(screen.getByTestId('player-queue-btn')).toBeTruthy();
      expect(screen.getByTestId('player-lyrics-btn')).toBeTruthy();
      expect(screen.getByTestId('tempo-button')).toBeTruthy();
      expect(screen.getByTestId('volume-slider-container')).toBeTruthy();
      expect(screen.getByTestId('player-mini-visualizer')).toBeTruthy();
      // Транспорт и таймлайн не выключаются вовсе.
      expect(screen.getByTestId('player-play-pause-btn')).toBeTruthy();
      expect(screen.getByTestId('player-seek-slider')).toBeTruthy();
    });

    it('keeps the artwork a fullscreen trigger, 52px and softly rounded', () => {
      renderBarWithTrack();

      const artwork = screen.getByTestId('player-artwork-btn');
      expect(artwork.style.width).toBe('52px');
      expect(artwork.style.borderRadius).toBe('var(--radius-sm)');

      fireEvent.click(artwork);
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);
    });

    it('leaves the range tokens to the theme', () => {
      renderBarWithTrack();

      const bar = screen.getByTestId('player-bar');
      expect(bar.getAttribute('style')).not.toContain('--range-track-height');
      expect(bar.style.gap).toBe('var(--space-4)');
      expect(bar.style.padding).toBe('0 var(--space-5)');
    });

    it('shows the sleep countdown while a timer is armed', () => {
      act(() => {
        usePlayerStore.setState({ sleepTimerEndsAt: Date.now() + 60_000 });
      });
      renderBarWithTrack();

      expect(screen.getByTestId('player-sleep-remaining')).toBeTruthy();
    });

    /*
     * Счётчик очереди и её открытие охранял тест шапки: там стояла вторая такая же
     * кнопка. Кнопку из шапки убрали — она открывала ту же панель тем же вызовом, —
     * а обе проверки перенесены сюда, на единственную оставшуюся. Класс регрессий
     * тот же: счётчик врёт или кнопка не открывает панель.
     */
    it('counts the queue on the button and opens the drawer', () => {
      act(() => {
        usePlayerStore.setState({ userQueue: [track, { ...track, id: 'yt_layout_2' }] });
      });
      renderBarWithTrack();

      const button = screen.getByTestId('player-queue-btn');
      expect(button).toHaveTextContent('2');
      expect(button.getAttribute('aria-label')).toBe('Очередь, далее 2');

      fireEvent.click(button);
      expect(useUIStore.getState().isQueueOpen).toBe(true);
    });
  });

  describe('PlayerBar with modules off', () => {
    it('does not render a hidden module at all', () => {
      act(() => {
        const layout = usePlayerLayoutStore.getState();
        for (const key of ['favorite', 'shuffle', 'repeat', 'queue', 'lyrics', 'tempo', 'volume', 'visualizer'] as const) {
          layout.toggleModule(key);
        }
      });
      renderBarWithTrack();

      expect(screen.queryByTestId('player-fav-btn')).toBeNull();
      expect(screen.queryByTestId('player-shuffle-btn')).toBeNull();
      expect(screen.queryByTestId('player-repeat-btn')).toBeNull();
      expect(screen.queryByTestId('player-queue-btn')).toBeNull();
      expect(screen.queryByTestId('player-lyrics-btn')).toBeNull();
      expect(screen.queryByTestId('tempo-button')).toBeNull();
      expect(screen.queryByTestId('volume-slider-container')).toBeNull();
      expect(screen.queryByTestId('player-mini-visualizer')).toBeNull();

      // Плеер остаётся плеером: транспорт и таймлайн на месте.
      expect(screen.getByTestId('player-play-pause-btn')).toBeTruthy();
      expect(screen.getByTestId('player-seek-slider')).toBeTruthy();
      expect(screen.getByTestId('player-track-title')).toBeTruthy();
    });

    it('drops the sleep countdown and its picker together', () => {
      act(() => {
        usePlayerStore.setState({ sleepTimerEndsAt: Date.now() + 60_000 });
        usePlayerLayoutStore.getState().toggleModule('sleepTimer');
      });
      renderBarWithTrack();

      expect(screen.queryByTestId('player-sleep-remaining')).toBeNull();

      fireEvent.click(screen.getByTestId('player-overflow-btn'));
      expect(screen.queryByTestId('sleep-timer-off')).toBeNull();
      // Остальное меню живо.
      expect(screen.getByTestId('autoplay-radio-toggle')).toBeTruthy();
    });

    /*
     * Правый край поделён на три группы расстоянием: между группами зазор шире,
     * чем внутри. Пустая обёртка тут не бесплатна — `gap` считается вокруг каждого
     * элемента строки, в том числе нулевой ширины, поэтому оставленная на месте
     * пустая группа даёт двойную паузу и ломает ровно то, для чего группы и
     * заведены. Класс регрессий: кто-нибудь уберёт условие с обёртки, а на глаз
     * лишний зазор в конце строки не заметен.
     */
    it('skips a side group entirely when everything in it is off', () => {
      act(() => {
        const layout = usePlayerLayoutStore.getState();
        for (const key of ['queue', 'lyrics', 'tempo', 'volume', 'visualizer'] as const) {
          layout.toggleModule(key);
        }
      });
      renderBarWithTrack();

      expect(screen.queryByTestId('player-side-track-controls')).toBeNull();
      // Таймер не заведён, спектр выключен — показаний нет тоже.
      expect(screen.queryByTestId('player-side-readouts')).toBeNull();
      // Группа окна не выключается ничем, поэтому остаётся всегда.
      expect(screen.getByTestId('player-side-window')).toBeTruthy();
    });

    it('keeps the readouts group while the sleep timer runs', () => {
      act(() => {
        usePlayerStore.setState({ sleepTimerEndsAt: Date.now() + 60_000 });
        usePlayerLayoutStore.getState().toggleModule('visualizer');
      });
      renderBarWithTrack();

      const readouts = screen.getByTestId('player-side-readouts');
      expect(readouts).toContainElement(screen.getByTestId('player-sleep-remaining'));
      expect(screen.queryByTestId('player-mini-visualizer')).toBeNull();
    });
  });

  describe('PlayerBar density, shape and artwork action', () => {
    it('grows the paddings and the artwork on spacious', () => {
      act(() => {
        usePlayerLayoutStore.getState().setDensity('spacious');
      });
      renderBarWithTrack();

      expect(screen.getByTestId('player-bar').style.padding).toBe('0 var(--space-6)');
      expect(screen.getByTestId('player-artwork-btn').style.width).toBe('60px');
    });

    it('shrinks them on compact', () => {
      act(() => {
        usePlayerLayoutStore.getState().setDensity('compact');
      });
      renderBarWithTrack();

      expect(screen.getByTestId('player-bar').style.padding).toBe('0 var(--space-4)');
      expect(screen.getByTestId('player-artwork-btn').style.width).toBe('44px');
    });

    it('rounds the artwork into a circle', () => {
      act(() => {
        usePlayerLayoutStore.getState().setArtworkShape('circle');
      });
      renderBarWithTrack();

      expect(screen.getByTestId('player-artwork-btn').style.borderRadius).toBe('var(--radius-full)');
    });

    it('squares the artwork', () => {
      act(() => {
        usePlayerLayoutStore.getState().setArtworkShape('square');
      });
      renderBarWithTrack();

      expect(screen.getByTestId('player-artwork-btn').style.borderRadius).toBe('0');
    });

    it('turns the artwork into a visualizer switch', () => {
      act(() => {
        usePlayerLayoutStore.getState().setArtworkClickAction('visualizer');
      });
      renderBarWithTrack();

      const artwork = screen.getByTestId('player-artwork-btn');
      expect(artwork.getAttribute('aria-pressed')).toBe('true');

      fireEvent.click(artwork);

      expect(usePlayerStore.getState().visualizerEnabled).toBe(false);
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(false);
    });

    it('takes the artwork out of the tab order entirely when it does nothing', () => {
      act(() => {
        usePlayerLayoutStore.getState().setArtworkClickAction('none');
      });
      renderBarWithTrack();

      expect(screen.queryByTestId('player-artwork-btn')).toBeNull();
      const artwork = screen.getByTestId('player-artwork');
      expect(artwork.tagName).toBe('DIV');

      fireEvent.click(artwork);
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(false);
    });

    it('thickens both range tracks by overriding the theme tokens', () => {
      act(() => {
        usePlayerLayoutStore.getState().setProgressStyle('thick');
      });
      renderBarWithTrack();

      const style = screen.getByTestId('player-bar').getAttribute('style') ?? '';
      expect(style).toContain('--range-track-height: 10px');
      expect(style).toContain('--range-thumb-size: 16px');
    });
  });

  describe('FullscreenPlayer modules', () => {
    beforeEach(() => {
      act(() => {
        usePlayerStore.setState({ currentTrack: track, duration: track.duration });
        useUIStore.setState({ isFullscreenPlayerOpen: true });
        useLibraryStore.setState({ favorites: [] });
      });
    });

    it('shows artwork, visualizer, lyrics and queue at defaults', () => {
      render(<FullscreenPlayer />);

      expect(screen.getByTestId('fullscreen-artwork')).toBeTruthy();
      expect(screen.getByTestId('fullscreen-lyrics-btn')).toBeTruthy();
      expect(screen.getByTestId('fullscreen-queue-toggle')).toBeTruthy();
      expect(screen.getByTestId('fullscreen-artwork').style.borderRadius).toBe('var(--radius-lg)');
    });

    it('drops each hidden block from the markup', () => {
      act(() => {
        const layout = usePlayerLayoutStore.getState();
        layout.toggleFullscreenModule('artwork');
        layout.toggleFullscreenModule('lyrics');
        layout.toggleFullscreenModule('queue');
        layout.toggleFullscreenModule('visualizer');
      });
      render(<FullscreenPlayer />);

      expect(screen.queryByTestId('fullscreen-artwork')).toBeNull();
      expect(screen.queryByTestId('fullscreen-lyrics-btn')).toBeNull();
      expect(screen.queryByTestId('fullscreen-queue-toggle')).toBeNull();
      expect(screen.queryByTestId('fullscreen-queue')).toBeNull();
      // Название и транспорт остаются.
      expect(screen.getByTestId('fullscreen-track-title')).toBeTruthy();
      expect(screen.getByTestId('fullscreen-play-pause-btn')).toBeTruthy();
    });

    it('follows the chosen artwork shape', () => {
      act(() => {
        usePlayerLayoutStore.getState().setArtworkShape('circle');
      });
      render(<FullscreenPlayer />);

      expect(screen.getByTestId('fullscreen-artwork').style.borderRadius).toBe('var(--radius-full)');
    });
  });
});
