import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '../setup';
import { RecapStories } from '../../src/components/recap/RecapStories';
import { useUIStore } from '../../src/store/useUIStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import * as dbService from '../../src/services/db';
import * as download from '../../src/utils/download';
import { renderRecapCard } from '../../src/services/recapCard';
import { buildRecap } from '../../src/services/recap';
import { resetUIStore, resetLibraryStore, resetPlayerStore, resetAuthStore, signInForTests } from '../helpers/testUtils';
import { UnifiedTrack } from '../../src/types/music';

const track = (n: number, artist: string): UnifiedTrack => ({
  id: `yt_recap_${n}`,
  source: 'youtube',
  originalId: String(n),
  title: `Песня ${n}`,
  artist,
  duration: 200,
  artworkUrl: ''
});

async function seedListening() {
  const now = Date.now();
  const tracks = [track(1, 'Кино'), track(2, 'Кино'), track(3, 'Земфира'), track(4, 'Сплин')];
  for (const t of tracks) await dbService.db.history.put({ id: t.id, track: t, playCount: 3, playedAt: now });
  let k = 0;
  for (const t of tracks) {
    for (let i = 0; i < 3; i++) {
      await dbService.db.plays.add({ trackId: t.id, playedAt: now - (k++ % 5) * 60_000 - 1000, seconds: 180 });
    }
  }
  return tracks;
}

describe('3.0: Итоги', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetUIStore();
    resetLibraryStore();
    resetPlayerStore();
    resetAuthStore();
    signInForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it('закрыты, пока их не открыли', () => {
    render(<RecapStories />);
    expect(screen.queryByTestId('recap-stories')).toBeNull();
  });

  it('пустая история — честное «маловато музыки»', async () => {
    render(<RecapStories />);
    act(() => useUIStore.getState().openRecap('month'));
    expect(await screen.findByTestId('recap-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recap-close'));
    expect(useUIStore.getState().recapPeriod).toBeNull();
  });

  it('листается до сводки и играет топ', async () => {
    await seedListening();
    const play = vi.spyOn(usePlayerStore.getState(), 'playTrack').mockResolvedValue();
    render(<RecapStories />);
    act(() => useUIStore.getState().openRecap('year'));
    expect(await screen.findByTestId('recap-slide-intro')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recap-next'));
    expect(screen.getByTestId('recap-minutes').textContent).toBe('36');
    fireEvent.click(screen.getByTestId('recap-next'));
    expect(screen.getByTestId('recap-top-artist')).toHaveTextContent('Кино');
    // Стрелки клавиатуры тоже листают.
    for (let i = 0; i < 6; i++) fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId('recap-slide-summary')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recap-play-top'));
    expect(play).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().recapPeriod).toBeNull();
  });

  it('сохраняет топ плейлистом и картинку', async () => {
    await seedListening();
    const save = vi.spyOn(download, 'saveImageFile').mockResolvedValue({ ok: true, where: 'download' });
    render(<RecapStories />);
    act(() => useUIStore.getState().openRecap('year'));
    await screen.findByTestId('recap-slide-intro');
    for (let i = 0; i < 8; i++) fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.click(screen.getByTestId('recap-save-playlist'));
    await waitFor(() => expect(useLibraryStore.getState().playlists).toHaveLength(1));
    expect(useLibraryStore.getState().playlists[0].title).toMatch(/^Итоги · /);
    expect(useLibraryStore.getState().playlists[0].tracks).toHaveLength(4);

    // Холст в jsdom — заглушка без toDataURL, поэтому подменяем отрисовку.
    const canvasProto = HTMLCanvasElement.prototype as any;
    const original = canvasProto.toDataURL;
    canvasProto.toDataURL = () => 'data:image/png;base64,AAAA';
    try {
      fireEvent.click(screen.getByTestId('recap-save-card'));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(save.mock.calls[0][0]).toMatch(/^wireon-itogi-.*\.png$/);
    } finally {
      canvasProto.toDataURL = original;
    }
  });

  it('карточка рисуется на холсте', () => {
    const canvas = document.createElement('canvas');
    (canvas as any).toDataURL = () => 'data:image/png;base64,BBBB';
    const recap = buildRecap({ events: [], history: [], period: 'year', now: Date.now() });
    expect(renderRecapCard(recap, '#ff0000', canvas)).toBe('data:image/png;base64,BBBB');
    expect(canvas.width).toBe(1080);
    expect(canvas.height).toBe(1920);
  });

  it('автолистание идёт само', async () => {
    await seedListening();
    render(<RecapStories />);
    act(() => useUIStore.getState().openRecap('year'));
    await screen.findByTestId('recap-slide-intro');
    vi.useFakeTimers();
    try {
      // Пауза и снятие паузы перезаводят таймер слайда — уже на поддельных часах.
      fireEvent.keyDown(window, { key: ' ' });
      fireEvent.keyDown(window, { key: ' ' });
      act(() => {
        vi.advanceTimersByTime(7100);
      });
      expect(screen.getByTestId('recap-slide-minutes')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
