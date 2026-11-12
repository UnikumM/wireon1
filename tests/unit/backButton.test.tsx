/**
 * Системная кнопка «назад» на Android (4.0.2).
 *
 * Жалоба: «на телефоне нельзя использовать кнопку обратно». Обработчика не было
 * вовсе, и Capacitor на «назад» закрывал приложение вместе с музыкой. Проверяется
 * порядок: один нажим — один слой, потом экраны, и только с «Главной» — свернуть.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../setup';

import { handleBackPress, resetBackButtonForTests, startBackButton } from '../../src/services/backButton';
import { useUIStore } from '../../src/store/useUIStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { Modal } from '../../src/components/common/Modal';
import { MobilePlaylistView } from '../../src/components/mobile/MobilePlaylistView';
import { resetLibraryStore, resetPlayerStore, resetUIStore } from '../helpers/testUtils';
import type { UnifiedTrack } from '../../src/types/music';

const fakeApp = vi.hoisted(() => {
  const listeners = new Map<string, Array<() => void>>();
  return {
    listeners,
    minimized: 0,
    removed: 0,
    addListener(name: string, callback: () => void) {
      const list = listeners.get(name) ?? [];
      list.push(callback);
      listeners.set(name, list);
      return Promise.resolve({
        remove: () => {
          this.removed += 1;
        }
      });
    },
    minimizeApp() {
      this.minimized += 1;
      return Promise.resolve();
    },
    press() {
      for (const callback of listeners.get('backButton') ?? []) callback();
    },
    reset() {
      listeners.clear();
      this.minimized = 0;
      this.removed = 0;
    }
  };
});

vi.mock('@capacitor/app', () => ({ App: fakeApp }));

function pretendMobile(mobile: boolean) {
  const view = window as unknown as { Capacitor?: unknown; electronAPI?: unknown };
  if (mobile) {
    delete view.electronAPI;
    view.Capacitor = { isNativePlatform: () => true };
  } else {
    delete view.Capacitor;
  }
}

const track: UnifiedTrack = { id: 'yt_1', source: 'youtube', originalId: '1', title: 'Трек', artist: 'Артист', duration: 100, artworkUrl: '' };

function ui() {
  return useUIStore.getState();
}

describe('«назад»: слои и экраны', () => {
  beforeEach(() => {
    resetUIStore();
    resetPlayerStore();
    resetLibraryStore();
  });

  it('с вложенного экрана возвращает туда, откуда пришли, затем на «Главную», затем сворачивает', () => {
    ui().setActiveView('playlists');
    ui().setActivePlaylistId('p1');
    ui().setActiveView('playlist');
    expect(ui().viewBackStack).toEqual(['playlists']);

    expect(handleBackPress()).toBe('view');
    expect(ui().activeView).toBe('playlists');

    expect(handleBackPress()).toBe('view');
    expect(ui().activeView).toBe('home');

    expect(handleBackPress()).toBe('minimize');
    expect(ui().activeView).toBe('home');
  });

  it('цепочка вложенных экранов разматывается по одному: поиск → исполнитель → подборка', () => {
    ui().setActiveView('search');
    ui().openArtist('Кино');
    ui().openCollection({ id: 'c1', kind: 'album', source: 'youtube', ref: 'r', title: 'Альбом', subtitle: '', artworkUrl: '' } as never);
    expect(ui().activeView).toBe('collection');

    handleBackPress();
    expect(ui().activeView).toBe('artist');
    handleBackPress();
    expect(ui().activeView).toBe('search');
  });

  it('переход в другой раздел сбрасывает историю: «назад» не возвращает в чужой плейлист', () => {
    ui().setActiveView('playlists');
    ui().setActiveView('playlist');
    ui().setActiveView('search');
    expect(ui().viewBackStack).toEqual([]);

    handleBackPress();
    expect(ui().activeView).toBe('home');
  });

  it('без истории вложенный экран знает, куда отступать', () => {
    useUIStore.setState({ activeView: 'smart', viewBackStack: [] });
    handleBackPress();
    expect(ui().activeView).toBe('playlists');
  });

  it('один нажим — один слой: сначала сцена плеера, экран остаётся на месте', () => {
    useUIStore.setState({ activeView: 'playlist', viewBackStack: ['playlists'], isFullscreenPlayerOpen: true, isQueueOpen: true });

    expect(handleBackPress()).toBe('layer');
    expect(ui().isFullscreenPlayerOpen).toBe(false);
    expect(ui().isQueueOpen).toBe(true);
    expect(ui().activeView).toBe('playlist');

    expect(handleBackPress()).toBe('layer');
    expect(ui().isQueueOpen).toBe(false);
    expect(ui().activeView).toBe('playlist');

    expect(handleBackPress()).toBe('view');
    expect(ui().activeView).toBe('playlists');
  });

  it('лист действий трека и режим выбора закрываются раньше экрана', () => {
    useUIStore.setState({ activeView: 'playlist', viewBackStack: ['playlists'], actionsTrack: track, selectedTrackIds: ['yt_1'] });

    expect(handleBackPress()).toBe('layer');
    expect(ui().actionsTrack).toBeNull();
    expect(handleBackPress()).toBe('layer');
    expect(ui().selectedTrackIds).toBeNull();
    expect(ui().activeView).toBe('playlist');
  });

  it('открытое окно закрывается тем же путём, что и по Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Окно">
        <button type="button">ок</button>
      </Modal>
    );
    useUIStore.setState({ activeView: 'playlist', viewBackStack: ['playlists'] });

    expect(handleBackPress()).toBe('layer');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ui().activeView).toBe('playlist');
  });
});

describe('«назад»: подписка на телефоне', () => {
  beforeEach(() => {
    resetUIStore();
    fakeApp.reset();
    resetBackButtonForTests();
  });

  afterEach(() => {
    pretendMobile(false);
  });

  it('на «Главной» сворачивает приложение, а не закрывает его', async () => {
    pretendMobile(true);
    useUIStore.setState({ activeView: 'home', viewBackStack: [] });
    await startBackButton();
    await Promise.resolve();

    fakeApp.press();
    expect(fakeApp.minimized).toBe(1);
  });

  it('с экрана плейлиста возвращает назад и приложение не сворачивает', async () => {
    pretendMobile(true);
    useUIStore.setState({ activeView: 'playlist', viewBackStack: ['playlists'] });
    await startBackButton();
    await Promise.resolve();

    fakeApp.press();
    expect(useUIStore.getState().activeView).toBe('playlists');
    expect(fakeApp.minimized).toBe(0);
  });

  it('вне телефона ничего не слушает; отписка снимает обработчик', async () => {
    pretendMobile(false);
    const stopDesktop = await startBackButton();
    expect(fakeApp.listeners.get('backButton')).toBeUndefined();
    stopDesktop();

    resetBackButtonForTests();
    pretendMobile(true);
    const stop = await startBackButton();
    await Promise.resolve();
    stop();
    expect(fakeApp.removed).toBe(1);
  });
});

describe('видимая кнопка «Назад» в плейлисте на телефоне', () => {
  beforeEach(() => {
    resetUIStore();
    resetLibraryStore();
    resetPlayerStore();
  });

  it('есть в шапке обычного плейлиста и ведёт туда, откуда пришли', () => {
    useLibraryStore.setState({
      playlists: [{ id: 'p1', title: 'Вечер', tracks: [track], createdAt: 1, updatedAt: 1 } as never]
    });
    ui().setActiveView('home');
    ui().setActivePlaylistId('p1');
    ui().setActiveView('playlist');

    render(<MobilePlaylistView />);
    const back = screen.getByTestId('mobile-playlist-back');
    expect(back).toHaveAttribute('aria-label', 'Назад');

    fireEvent.click(back);
    // Открыт с «Главной» (закреплённый плейлист) — туда и возвращает, а не в медиатеку.
    expect(ui().activeView).toBe('home');
    expect(ui().activePlaylistId).toBeNull();
  });
});
