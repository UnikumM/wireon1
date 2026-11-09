/**
 * Главная страница (`src/components/home/HomeView.tsx`).
 *
 * Проверяется то, ради чего экран и переделан: он должен продолжать вчерашний
 * вечер. Отсюда две вещи, которые легко сломать незаметно, — герой обязан
 * находиться даже когда ничего не играет, и «Продолжить» обязано продолжать, а
 * не начинать трек заново.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../setup';

import { HomeView } from '../../src/components/home/HomeView';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { UnifiedTrack } from '../../src/types/music';
import { resetPlayerStore, resetLibraryStore, resetUIStore, flushAsync } from '../helpers/testUtils';
import * as discover from '../../src/services/discover';
import * as dbService from '../../src/services/db';
import * as subscriptions from '../../src/services/subscriptions';

function track(id: string, title: string): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id,
    title,
    artist: 'Daft Punk',
    duration: 248,
    artworkUrl: ''
  };
}

const lastNight = track('yt_home_1', 'Get Lucky');

describe('Главная', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetPlayerStore();
    resetLibraryStore();
    resetUIStore();
  });

  it('показывает последнее из истории, когда ничего не играет', async () => {
    useLibraryStore.setState({ history: [lastNight] });

    render(<HomeView />);
    await flushAsync();

    expect(screen.getByTestId('home-hero-title')).toHaveTextContent('Get Lucky');
    // Ничего не играло — значит и продолжать нечего, кнопка зовётся иначе.
    expect(screen.getByTestId('home-hero-play')).toHaveTextContent('Слушать');
  });

  it('продолжает трек с прошлого запуска, а не начинает его заново', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const playTrack = vi.fn().mockResolvedValue(undefined);
    usePlayerStore.setState({ currentTrack: lastNight, resumePosition: 95, play, playTrack });

    render(<HomeView />);
    await flushAsync();

    expect(screen.getByTestId('home-hero-play')).toHaveTextContent('Продолжить');

    fireEvent.click(screen.getByTestId('home-hero-play'));

    // `playTrack` открыл бы трек с нуля и стёр бы запомненную секунду.
    expect(play).toHaveBeenCalledTimes(1);
    expect(playTrack).not.toHaveBeenCalled();
  });

  it('включает трек заново, если в плеере другой', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const playTrack = vi.fn().mockResolvedValue(undefined);
    usePlayerStore.setState({ currentTrack: null, play, playTrack });
    useLibraryStore.setState({ history: [lastNight] });

    render(<HomeView />);
    await flushAsync();
    fireEvent.click(screen.getByTestId('home-hero-play'));

    expect(playTrack).toHaveBeenCalledWith(expect.objectContaining({ id: lastNight.id }));
    expect(play).not.toHaveBeenCalled();
  });

  it('карточка волны запускает Поток и уводит на его экран', async () => {
    const startMyWave = vi.fn().mockResolvedValue(undefined);
    usePlayerStore.setState({ startMyWave });

    render(<HomeView />);
    await flushAsync();
    fireEvent.click(screen.getByTestId('home-card-wave'));

    expect(startMyWave).toHaveBeenCalled();
    expect(useUIStore.getState().activeView).toBe('wave');
  });

  it('переживает пустую медиатеку', async () => {
    render(<HomeView />);
    await flushAsync();

    // Ни истории, ни текущего трека: экран обязан остаться, а кнопка — молчать.
    expect(screen.getByTestId('home-view')).toBeInTheDocument();
    expect(screen.getByTestId('home-hero-play')).toBeDisabled();
  });

  it('полки площадки открываются, а не включаются вслепую', async () => {
    vi.spyOn(discover, 'getNewReleases').mockResolvedValue([
      {
        title: 'Альбомы и синглы',
        items: [
          {
            id: 'ytc_MPREb_x',
            kind: 'album',
            source: 'youtube',
            ref: 'MPREb_x',
            title: 'Legend',
            subtitle: 'Альбом • ELITE',
            artworkUrl: ''
          }
        ]
      }
    ]);
    vi.spyOn(discover, 'getCharts').mockResolvedValue([]);

    render(<HomeView />);
    await flushAsync();

    fireEvent.click(screen.getByTestId('home-shelf-item-ytc_MPREb_x'));
    expect(useUIStore.getState().activeView).toBe('collection');
    expect(useUIStore.getState().activeCollection).toMatchObject({ ref: 'MPREb_x' });
  });

  it('без подписок и без сети ряды просто не показываются', async () => {
    vi.spyOn(discover, 'getNewReleases').mockResolvedValue([]);
    vi.spyOn(discover, 'getCharts').mockResolvedValue([]);
    vi.spyOn(subscriptions, 'checkNewReleases').mockResolvedValue([]);

    render(<HomeView />);
    await flushAsync();

    // Пустой ряд с заголовком хуже отсутствующего: он обещает содержимое.
    // С 4.0 это касается и «Собрано для тебя»: без истории миксов нет, и
    // заголовок без карточек под ним не показывается. Герой остаётся всегда.
    expect(screen.queryByTestId('home-releases')).toBeNull();
    expect(screen.queryByTestId('home-daily')).toBeNull();
    expect(screen.getByTestId('home-hero')).toBeInTheDocument();
    expect(screen.getByTestId('home-card-wave')).toBeInTheDocument();
  });
});

describe('Главная: «Забытое»', () => {
  it('показывает любимое, которое не включали полгода, от самого давнего', async () => {
    const { FORGOTTEN_AFTER_MS } = await import('../../src/components/home/HomeView');
    resetPlayerStore();
    resetLibraryStore();
    resetUIStore();
    vi.spyOn(discover, 'getNewReleases').mockResolvedValue([]);
    vi.spyOn(discover, 'getCharts').mockResolvedValue([]);
    vi.spyOn(subscriptions, 'checkNewReleases').mockResolvedValue([]);
    const old = track('old', 'Старое любимое');
    const older = track('older', 'Совсем забытое');
    const fresh = track('fresh', 'Недавнее любимое');
    const now = Date.now();
    vi.spyOn(dbService, 'getHistory').mockResolvedValue([
      { id: 'old', track: old, playedAt: now - FORGOTTEN_AFTER_MS - 1000, playCount: 3 },
      { id: 'older', track: older, playedAt: now - FORGOTTEN_AFTER_MS * 2, playCount: 9 },
      { id: 'fresh', track: fresh, playedAt: now - 1000, playCount: 1 }
    ] as never);
    useLibraryStore.setState({ favorites: [old, older, fresh] });

    render(<HomeView />);
    await flushAsync();

    const shelf = screen.getByTestId('home-forgotten');
    const titles = [...shelf.querySelectorAll('.cover-card-title')].map((el) => el.textContent);
    expect(titles).toEqual(['Совсем забытое', 'Старое любимое']);
  });
});
