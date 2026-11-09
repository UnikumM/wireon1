/**
 * Палитра команд как «одна строка для всего» (4.0, фича 39): кроме команд
 * по запросу находятся треки, плейлисты и артисты из медиатеки, ссылка
 * уходит в поиск, а пустой результат предлагает поискать в сети.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup';

import { CommandPalette } from '../../src/components/common/CommandPalette';
import {
  collectLibraryTracks,
  looksLikeUrl,
  normalizeQuery,
  searchArtists,
  searchTracks
} from '../../src/components/common/commandPalette/librarySearch';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { streamResolver } from '../../src/services/streamResolver';
import { Playlist, UnifiedTrack } from '../../src/types/music';

import {
  installFetchMock,
  resetPlayerStore,
  resetLibraryStore,
  resetUIStore,
  signInForTests,
  flushAsync
} from '../helpers/testUtils';
import { healthySourceRoutes } from '../helpers/networkFixtures';

const player = () => usePlayerStore.getState();
const ui = () => useUIStore.getState();

function track(id: string, title: string, artist: string, extra: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id,
    title,
    artist,
    duration: 185,
    artworkUrl: '',
    streamUrl: '',
    ...extra
  };
}

function playlist(id: string, title: string, tracks: UnifiedTrack[] = []): Playlist {
  return { id, title, tracks, createdAt: 1, updatedAt: 1, isSynced: false };
}

const yolka = track('yt_yolka', 'Ёлки', 'Зимний хор', { artworkUrl: 'https://img.test/yolka.jpg' });
const loud = track('yt_loud', 'ГРОМКАЯ ПЕСНЯ', 'Interaction Test');
const quiet = track('yt_quiet', 'Тихая песня', 'Другой артист');

function openPalette() {
  useUIStore.setState({ isCommandPaletteOpen: true });
  return render(<CommandPalette />);
}

function type(value: string) {
  const input = screen.getByTestId('command-palette-input');
  fireEvent.change(input, { target: { value } });
  return input;
}

describe('librarySearch — чистые функции', () => {
  it('нормализует регистр и «ё/е»', () => {
    expect(normalizeQuery('  ЁЛКИ   Зелёные ')).toBe('елки зеленые');
  });

  it('отличает ссылку от запроса', () => {
    expect(looksLikeUrl('https://youtu.be/abc')).toBe(true);
    expect(looksLikeUrl('www.soundcloud.com/x/y')).toBe(true);
    expect(looksLikeUrl('http в названии')).toBe(false);
    expect(looksLikeUrl('ёлки')).toBe(false);
  });

  it('собирает треки без дублей, избранное первым', () => {
    const inFavorites = track('yt_dup', 'Из избранного', 'А');
    const inHistory = track('yt_dup', 'Из истории', 'А');
    const merged = collectLibraryTracks([inFavorites], [inHistory, quiet], [playlist('p', 'П', [quiet, loud])]);
    expect(merged.map((t) => t.id)).toEqual(['yt_dup', 'yt_quiet', 'yt_loud']);
    expect(merged[0].title).toBe('Из избранного');
  });

  it('ограничивает число совпадений и ставит начало названия выше', () => {
    const many = Array.from({ length: 12 }, (_, i) => track(`yt_${i}`, `Песня номер ${i}`, 'Кто-то'));
    const exact = track('yt_exact', 'Номер один', 'Кто-то');
    const found = searchTracks([...many, exact], 'номер');
    expect(found).toHaveLength(8);
    expect(found[0].id).toBe('yt_exact');
  });

  it('артисты уникальны без учёта регистра', () => {
    const list = [track('a', 'x', 'Кино'), track('b', 'y', 'КИНО'), track('c', 'z', 'Кинопоиск')];
    expect(searchArtists(list, 'кино')).toEqual(['Кино', 'Кинопоиск']);
  });
});

describe('CommandPalette — поиск по медиатеке', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Запуск трека резолвит поток — сеть должна быть заглушена.
    installFetchMock(healthySourceRoutes());
    streamResolver.clearCache();
    resetPlayerStore();
    resetLibraryStore();
    signInForTests();
    resetUIStore();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    await flushAsync();
    vi.unstubAllGlobals();
  });

  it('находит трек из избранного и запускает его', async () => {
    useLibraryStore.setState({ favorites: [yolka, loud] });
    openPalette();

    type('громк');

    const option = screen.getByTestId('command-option-track-yt_loud');
    expect(screen.getByText('Треки')).toBeInTheDocument();
    expect(option).toHaveTextContent('ГРОМКАЯ ПЕСНЯ');
    expect(option).toHaveTextContent('Interaction Test');
    expect(option).toHaveTextContent('3:05');
    expect(screen.queryByTestId('command-option-track-yt_yolka')).toBeNull();

    // Запуск трека — асинхронный: дожидаемся его внутри act, чтобы обновления
    // стора не прилетали в палитру после конца проверки.
    await act(async () => {
      fireEvent.click(option);
      await flushAsync();
    });

    expect(player().currentTrack?.id).toBe('yt_loud');
    expect(ui().isCommandPaletteOpen).toBe(false);
  });

  it('показывает обложку, когда она есть, и значок, когда нет', () => {
    useLibraryStore.setState({ favorites: [yolka, loud] });
    openPalette();

    type('песн');
    expect(screen.getByTestId('command-option-track-yt_loud').querySelector('img')).toBeNull();

    type('ёлк');
    const img = screen.getByTestId('command-option-track-yt_yolka').querySelector('img');
    expect(img).toHaveAttribute('src', 'https://img.test/yolka.jpg');
  });

  it('не зависит от регистра и различия «ё/е»', () => {
    useLibraryStore.setState({ favorites: [yolka], history: [loud] });
    openPalette();

    type('елки');
    expect(screen.getByTestId('command-option-track-yt_yolka')).toBeInTheDocument();

    type('ЁЛКИ');
    expect(screen.getByTestId('command-option-track-yt_yolka')).toBeInTheDocument();

    type('громкая песня');
    expect(screen.getByTestId('command-option-track-yt_loud')).toBeInTheDocument();
  });

  it('треки из истории и плейлистов тоже находятся, без дублей', () => {
    useLibraryStore.setState({
      favorites: [quiet],
      history: [quiet, loud],
      playlists: [playlist('pl_1', 'Вечер', [quiet, yolka])]
    });
    openPalette();

    type('песня');
    expect(screen.getAllByTestId(/command-option-track-/)).toHaveLength(2);
    expect(screen.getByTestId('command-option-track-yt_quiet')).toBeInTheDocument();
    expect(screen.getByTestId('command-option-track-yt_loud')).toBeInTheDocument();
  });

  it('находит плейлист и открывает его', () => {
    useLibraryStore.setState({ playlists: [playlist('pl_night', 'Late Night', [loud]), playlist('pl_day', 'Утро')] });
    openPalette();

    type('night');

    expect(screen.getByText('Плейлисты')).toBeInTheDocument();
    const option = screen.getByTestId('command-option-playlist-pl_night');
    expect(option).toHaveTextContent('Late Night');
    expect(option).toHaveTextContent('1 трек');
    expect(screen.queryByTestId('command-option-playlist-pl_day')).toBeNull();
    // Плейлист не дублируется командой «Открыть плейлист: …».
    expect(screen.getAllByTestId(/command-option-playlist-/)).toHaveLength(1);

    fireEvent.click(option);

    expect(ui().activeView).toBe('playlist');
    expect(ui().activePlaylistId).toBe('pl_night');
  });

  it('без запроса плейлисты остаются командами, как раньше', () => {
    useLibraryStore.setState({ playlists: [playlist('pl_night', 'Late Night')] });
    openPalette();

    expect(screen.getByTestId('command-option-playlist-pl_night')).toHaveTextContent('Открыть плейлист: Late Night');
    expect(screen.getByText('Навигация')).toBeInTheDocument();
  });

  it('находит артиста и открывает его страницу', () => {
    useLibraryStore.setState({ favorites: [yolka], history: [loud, quiet] });
    openPalette();

    type('зимний');

    expect(screen.getByText('Артисты')).toBeInTheDocument();
    const option = screen.getByTestId('command-option-artist-зимний-хор');
    fireEvent.click(option);

    expect(ui().activeView).toBe('artist');
    expect(ui().selectedArtistName).toBe('Зимний хор');
  });

  it('стрелки и Enter идут сквозь группы', async () => {
    useLibraryStore.setState({ favorites: [quiet] });
    openPalette();

    // «тих» по подпоследовательности находит и команды, и трек «Тихая песня»:
    // список смешанный, и обход должен идти по нему насквозь и замыкаться.
    const input = type('тих');
    const idOf = () => input.getAttribute('aria-activedescendant');

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    expect(options.some((o) => o.id === 'command-track-yt_quiet')).toBe(true);
    expect(idOf()).toBe(options[0].id);

    for (let i = 1; i < options.length; i += 1) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(idOf()).toBe(options[i].id);
    }
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(idOf()).toBe(options[0].id);

    fireEvent.keyDown(input, { key: 'End' });
    expect(idOf()).toBe('command-track-yt_quiet');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await flushAsync();
    });

    expect(player().currentTrack?.id).toBe('yt_quiet');
  });

  it('ссылка открывается в поиске', () => {
    openPalette();

    const input = type('https://youtu.be/dQw4w9WgXcQ');

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute('id', 'command-open-link');
    expect(options[0]).toHaveTextContent('Открыть ссылку в поиске');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(ui().activeView).toBe('search');
    expect(ui().searchQuery).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(ui().isCommandPaletteOpen).toBe(false);
  });

  it('пустой результат предлагает поиск в YouTube и SoundCloud', () => {
    useLibraryStore.setState({ favorites: [yolka] });
    openPalette();

    const input = type('zzqqxx');

    expect(screen.getByTestId('command-palette-empty')).toHaveTextContent('Ничего не нашлось по запросу «zzqqxx».');
    const option = screen.getByTestId('command-option-search-web');
    expect(option).toHaveTextContent('Искать „zzqqxx“ в YouTube и SoundCloud');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(ui().activeView).toBe('search');
    expect(ui().searchQuery).toBe('zzqqxx');
  });

  it('подпись в поле говорит, что здесь ищется всё', () => {
    openPalette();
    expect(screen.getByTestId('command-palette-input')).toHaveAttribute(
      'placeholder',
      'Команды, треки, плейлисты, артисты'
    );
  });

  it('команды по-прежнему находятся и идут первой группой', () => {
    useLibraryStore.setState({ favorites: [track('yt_sh', 'Shuffle Dance', 'DJ')] });
    openPalette();

    type('shuffle');

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('id', 'command-toggle-shuffle');
    expect(screen.getByText('Команды')).toBeInTheDocument();
    expect(screen.getByTestId('command-option-track-yt_sh')).toBeInTheDocument();

    act(() => {
      fireEvent.click(options[0]);
    });
    expect(player().isShuffled).toBe(true);
  });
});
