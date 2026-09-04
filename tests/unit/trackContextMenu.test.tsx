import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup';

import { TrackCard } from '../../src/components/search/TrackCard';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { resetLibraryStore, resetUIStore, resetPlayerStore, signInForTests } from '../helpers/testUtils';
import type { UnifiedTrack } from '../../src/types/music';

/**
 * Меню «…» у трека.
 *
 * Жалоба 2026-09-01: «на трёх точках зачем-то надо туда-сюда листать». Причина
 * была в том, что **каждый плейлист был отдельным пунктом этого же меню**, а
 * меню ограничено 320 px по высоте: пяти обычных действий и трёх плейлистов
 * хватало, чтобы началась прокрутка, — и чтобы вернуться к «Играть следующим»,
 * приходилось листать обратно вверх. С ростом числа плейлистов становилось
 * только хуже.
 *
 * Проверяется поэтому не «пункт есть», а то, что меню **не растёт** от числа
 * плейлистов.
 */

const track: UnifiedTrack = {
  id: 'yt_menu',
  source: 'youtube',
  originalId: 'menu1',
  title: 'Diamonds Are Forever',
  artist: 'Shirley Bassey',
  duration: 162,
  artworkUrl: '',
  sourceUrl: 'https://youtube.com/watch?v=menu1'
};

async function openMenu() {
  fireEvent.click(screen.getByTestId(`track-more-btn-${track.id}`));
  return screen.findByTestId('track-context-menu');
}

beforeEach(() => {
  resetPlayerStore();
  resetLibraryStore();
  resetUIStore();
  signInForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Меню трека не растёт от числа плейлистов', () => {
  it('с одним плейлистом и с восемью пунктов поровну', async () => {
    render(<TrackCard track={track} />);
    await useLibraryStore.getState().createPlaylist('Первый');

    const withOne = (await openMenu()).querySelectorAll('[role="menuitem"]').length;
    fireEvent.click(screen.getByTestId(`track-more-btn-${track.id}`));

    for (const name of ['Второй', 'Третий', 'Четвёртый', 'Пятый', 'Шестой', 'Седьмой', 'Восьмой']) {
      await useLibraryStore.getState().createPlaylist(name);
    }

    const withMany = (await openMenu()).querySelectorAll('[role="menuitem"]').length;

    expect(withMany).toBe(withOne);
  });

  it('плейлисты не сыплются в меню поимённо', async () => {
    await useLibraryStore.getState().createPlaylist('Тренировка');
    render(<TrackCard track={track} />);

    const menu = await openMenu();

    expect(menu.textContent).not.toContain('Тренировка');
    expect(screen.getByTestId(`menu-add-to-playlist-${track.id}`)).toBeInTheDocument();
  });

  it('«Добавить в плейлист…» открывает окно выбора', async () => {
    await useLibraryStore.getState().createPlaylist('Тренировка');
    render(<TrackCard track={track} />);
    await openMenu();

    fireEvent.click(screen.getByTestId(`menu-add-to-playlist-${track.id}`));

    // В окне выбора плейлист уже виден по имени, и там же можно создать новый —
    // ради этого список из меню и убран.
    await waitFor(() => expect(screen.getByText('Тренировка')).toBeInTheDocument());
  });
});
