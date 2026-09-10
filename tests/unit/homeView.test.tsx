/**
 * Главная страница (`src/components/home/HomeView.tsx`).
 *
 * Проверяется то, ради чего экран и переделан: он должен продолжать вчерашний
 * вечер. Отсюда две вещи, которые легко сломать незаметно, — герой обязан
 * находиться даже когда ничего не играет, и «Продолжить» обязано продолжать, а
 * не начинать трек заново.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../setup';

import { HomeView } from '../../src/components/home/HomeView';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { UnifiedTrack } from '../../src/types/music';
import { resetPlayerStore, resetLibraryStore, resetUIStore, flushAsync } from '../helpers/testUtils';

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
});
