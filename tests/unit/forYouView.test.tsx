import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup';

import { ForYouView } from '../../src/components/foryou/ForYouView';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import { addToHistory, clearAllData, savePlaylist } from '../../src/services/db';
import * as db from '../../src/services/db';
import { streamResolver } from '../../src/services/streamResolver';
import { UnifiedTrack, Playlist } from '../../src/types/music';
import { resetPlayerStore, resetLibraryStore, resetUIStore } from '../helpers/testUtils';

/**
 * Экран «Для вас»: миксы дня и итоги прослушанного.
 *
 * Оба раздела считаются из локальной истории, и главное, что здесь проверяется —
 * что они не выдумывают данных: без истории показывают пустое состояние, а не
 * нули и не случайные треки.
 */

function track(id: string, artist: string, title: string, extra: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return {
    id,
    source: id.startsWith('sc_') ? 'soundcloud' : 'youtube',
    originalId: id.replace(/^(yt_|sc_)/, ''),
    title,
    artist,
    duration: 200,
    artworkUrl: `https://example.test/${id}.jpg`,
    ...extra
  };
}

const artistA = Array.from({ length: 6 }, (_, i) => track(`yt_a${i}`, 'Сплин', `A${i}`));
const artistB = Array.from({ length: 6 }, (_, i) => track(`yt_b${i}`, 'Земфира', `B${i}`));

function playlistOf(id: string, tracks: UnifiedTrack[]): Playlist {
  return {
    id,
    title: `Плейлист ${id}`,
    tracks,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    isSynced: false
  };
}

const library = () => useLibraryStore.getState();
const player = () => usePlayerStore.getState();

describe('ForYouView (миксы дня и итоги)', () => {
  beforeEach(async () => {
    resetPlayerStore();
    resetLibraryStore();
    resetUIStore();
    // Проверяем очередь, а не сеть: пусть поток отдаётся сразу.
    vi.spyOn(streamResolver, 'resolve').mockResolvedValue({
      streamUrl: 'https://stream.example.test/audio.mp3',
      format: 'mp3',
      bitrate: 128,
      expiresAt: Date.now() + 3_600_000
    } as unknown as Awaited<ReturnType<typeof streamResolver.resolve>>);
    vi.spyOn(streamResolver, 'prefetch').mockImplementation(() => {});
    await clearAllData();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearAllData();
  });

  it('без истории и медиатеки показывает пустые состояния, а не нули', async () => {
    render(<ForYouView />);

    await waitFor(() => expect(screen.getByTestId('foryou-mixes-empty')).toBeInTheDocument());
    expect(screen.getByTestId('foryou-stats-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('stats-total-plays')).not.toBeInTheDocument();
    expect(screen.queryByTestId('foryou-mixes')).not.toBeInTheDocument();
  });

  it('собирает миксы из плейлистов и избранного', async () => {
    await savePlaylist(playlistOf('pl_1', [...artistA, ...artistB]));
    await library().loadInitialData();

    render(<ForYouView />);

    await waitFor(() => expect(screen.getByTestId('foryou-mixes')).toBeInTheDocument());

    const firstMix = screen.getByTestId('daily-mix-0');
    expect(firstMix).toHaveTextContent(/Микс дня/);
    expect(screen.getByTestId('daily-mix-0-totals')).toHaveTextContent(/трек/);
  });

  it('нажатие на микс ставит его в очередь целиком', async () => {
    await savePlaylist(playlistOf('pl_1', [...artistA, ...artistB]));
    await library().loadInitialData();

    render(<ForYouView />);
    await waitFor(() => expect(screen.getByTestId('daily-mix-0-play')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('daily-mix-0-play'));

    await waitFor(() => expect(player().currentTrack).not.toBeNull());
    // Очередь — весь микс, а не один трек: продолжать нечего доигрывать.
    expect(player().sourceQueue.length).toBeGreaterThan(1);
    expect(player().sourceQueue[0].id).toBe(player().currentTrack?.id);
  });

  it('считает итоги по истории и честно называет время «примерным»', async () => {
    // Один трек включали трижды, другой — один раз.
    await addToHistory(artistA[0]);
    await addToHistory(artistA[0]);
    await addToHistory(artistA[0]);
    await addToHistory(artistB[0]);

    render(<ForYouView />);

    await waitFor(() => expect(screen.getByTestId('stats-total-plays')).toBeInTheDocument());

    expect(screen.getByTestId('stats-total-plays')).toHaveTextContent('4');
    expect(screen.getByTestId('stats-total-plays')).toHaveTextContent('2 разных трека');
    expect(screen.getByTestId('stats-artists')).toHaveTextContent('2');
    // 4 включения по 200 секунд — 13 минут с копейками.
    expect(screen.getByTestId('stats-time')).toHaveTextContent('13 мин');
    expect(screen.getByTestId('stats-time')).toHaveTextContent(/поэтому «примерно»/i);
  });

  it('в топе первым стоит то, что слушали чаще', async () => {
    await addToHistory(artistB[0]);
    await addToHistory(artistA[0]);
    await addToHistory(artistA[0]);

    render(<ForYouView />);

    await waitFor(() => expect(screen.getByTestId('stats-top-artists')).toBeInTheDocument());

    expect(screen.getByTestId('stats-artist-0')).toHaveTextContent('Сплин');
    expect(screen.getByTestId('stats-artist-0')).toHaveTextContent('2 раза');
    expect(screen.getByTestId('stats-artist-1')).toHaveTextContent('Земфира');
    expect(screen.getByTestId('stats-track-0')).toHaveTextContent('A0');
  });

  it('показывает, откуда играла музыка', async () => {
    await addToHistory(track('yt_1', 'A', 'a'));
    await addToHistory(track('yt_2', 'B', 'b'));
    await addToHistory(track('yt_3', 'C', 'c'));
    await addToHistory(track('sc_4', 'D', 'd'));

    render(<ForYouView />);

    await waitFor(() => expect(screen.getByTestId('stats-sources')).toBeInTheDocument());

    const sources = screen.getByTestId('stats-sources');
    expect(sources).toHaveTextContent('75%');
    expect(sources).toHaveTextContent('25%');
  });

  it('«Обновить» перечитывает историю', async () => {
    await addToHistory(artistA[0]);

    render(<ForYouView />);
    await waitFor(() => expect(screen.getByTestId('stats-total-plays')).toHaveTextContent('1'));

    await addToHistory(artistA[1]);
    fireEvent.click(screen.getByTestId('foryou-refresh'));

    await waitFor(() => expect(screen.getByTestId('stats-total-plays')).toHaveTextContent('2'));
  });

  /**
   * Окна итогов.
   *
   * Проверяется то же, что и в сервисе, но уже на экране: переключатель должен
   * менять цифры, а не подпись над ними. Старое включение подкладывается прямо
   * в базу — `addToHistory` умеет писать только «сейчас», а весь смысл окна в
   * том, чтобы отличать сейчас от прошлого месяца.
   */
  describe('окна: неделя / месяц / всё время', () => {
    const DAY = 24 * 60 * 60 * 1000;

    /** Включение задним числом: и счётчик в истории, и само событие. */
    async function playedDaysAgo(t: UnifiedTrack, daysAgo: number[]): Promise<void> {
      const existing = await db.db.history.get(t.id);
      const at = Date.now() - Math.min(...daysAgo) * DAY;
      await db.db.history.put({
        id: t.id,
        track: t,
        playedAt: Math.max(at, existing?.playedAt ?? 0),
        playCount: (existing?.playCount ?? 0) + daysAgo.length
      });
      for (const days of daysAgo) {
        await db.db.plays.add({ trackId: t.id, playedAt: Date.now() - days * DAY });
      }
    }

    it('неделя показывает недельные цифры, а не весь счётчик', async () => {
      // Сплин: 4 включения, из них в неделю попадает одно.
      await playedDaysAgo(artistA[0], [1, 12, 20, 26]);
      // Земфира: 2 включения, оба на этой неделе.
      await playedDaysAgo(artistB[0], [2, 3]);

      render(<ForYouView />);
      await waitFor(() => expect(screen.getByTestId('stats-total-plays')).toHaveTextContent('6'));

      // По умолчанию — всё время, и там первым стоит тот, кого больше слушали.
      expect(screen.getByTestId('stats-period-all')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('stats-artist-0')).toHaveTextContent('Сплин');

      fireEvent.click(screen.getByTestId('stats-period-week'));

      await waitFor(() => expect(screen.getByTestId('stats-total-plays')).toHaveTextContent('3'));
      expect(screen.getByTestId('stats-period-week')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('stats-period-all')).toHaveAttribute('aria-pressed', 'false');
      // В недельном окне порядок обратный: у Земфиры два включения против одного.
      expect(screen.getByTestId('stats-artist-0')).toHaveTextContent('Земфира');
      expect(screen.getByTestId('stats-artist-1')).toHaveTextContent('Сплин');

      fireEvent.click(screen.getByTestId('stats-period-month'));

      await waitFor(() => expect(screen.getByTestId('stats-total-plays')).toHaveTextContent('6'));
      expect(screen.getByTestId('stats-artist-0')).toHaveTextContent('Сплин');
    });

    it('пустое окно не выглядит как «вы ничего не слушали»', async () => {
      // Всё наслушанное — за пределами месяца.
      await playedDaysAgo(artistA[0], [40, 45]);

      render(<ForYouView />);
      await waitFor(() => expect(screen.getByTestId('stats-total-plays')).toHaveTextContent('2'));

      fireEvent.click(screen.getByTestId('stats-period-week'));

      await waitFor(() =>
        expect(screen.getByTestId('foryou-stats-period-empty')).toBeInTheDocument()
      );
      // Переключатель на месте — иначе из пустой недели некуда вернуться.
      expect(screen.getByTestId('stats-periods')).toBeInTheDocument();
      expect(screen.queryByTestId('foryou-stats-empty')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Показать всё время' }));

      await waitFor(() => expect(screen.getByTestId('stats-total-plays')).toHaveTextContent('2'));
    });

    it('пока событий меньше окна, говорит это прямо', async () => {
      // Счётчик помнит десять включений, а события — только вчерашнее.
      await db.db.history.put({
        id: artistA[0].id,
        track: artistA[0],
        playedAt: Date.now() - DAY,
        playCount: 10
      });
      await db.db.plays.add({ trackId: artistA[0].id, playedAt: Date.now() - DAY });

      render(<ForYouView />);
      await waitFor(() => expect(screen.getByTestId('stats-total-plays')).toBeInTheDocument());

      // За всё время оговорки нет: там счётчик, и он знает всю историю.
      expect(screen.queryByTestId('stats-period-shortfall')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('stats-period-month'));

      await waitFor(() =>
        expect(screen.getByTestId('stats-period-shortfall')).toBeInTheDocument()
      );
      expect(screen.getByTestId('stats-period-shortfall')).toHaveTextContent(/1 день/);
      expect(screen.getByTestId('stats-total-plays')).toHaveTextContent('1');
    });

    it('переключатель не показывается, когда истории нет вовсе', async () => {
      render(<ForYouView />);

      await waitFor(() => expect(screen.getByTestId('foryou-stats-empty')).toBeInTheDocument());
      expect(screen.queryByTestId('stats-periods')).not.toBeInTheDocument();
    });
  });

  it('из пустого экрана можно уйти в поиск', async () => {
    render(<ForYouView />);
    await waitFor(() => expect(screen.getByTestId('foryou-mixes-empty')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Найти музыку' }));

    expect(useUIStore.getState().activeView).toBe('search');
  });

  it('когда историю не прочитать, говорит это вслух, а не крутит скелетон', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = vi.spyOn(db, 'getHistory').mockRejectedValue(new Error('IndexedDB blocked'));

    render(<ForYouView />);

    await waitFor(() => expect(screen.getByTestId('foryou-error')).toBeInTheDocument());
    // Никаких «итогов пока нет» рядом с ошибкой — это выглядело бы так,
    // будто человек ничего не слушал.
    expect(screen.queryByTestId('foryou-stats-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('foryou-mixes-empty')).not.toBeInTheDocument();

    // Кнопка «Попробовать снова» действительно перечитывает историю.
    read.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Попробовать снова' }));

    await waitFor(() => expect(screen.getByTestId('foryou-stats-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('foryou-error')).not.toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
  });
});
