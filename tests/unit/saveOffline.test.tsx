/**
 * Кнопка «В офлайн» для целого списка.
 *
 * Проверяется то, что видит человек: список уходит в очередь одним нажатием,
 * кнопка превращается в живой счётчик с отменой, а уже сохранённый список не
 * обещает сохранить себя ещё раз.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../setup';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { clearAllData } from '../../src/services/db';
import { offlineStorage } from '../../src/services/offlineStorage';
import { offlineMode, DEFAULT_OFFLINE_BITRATE_KBPS } from '../../src/services/offlineMode';
import { SaveOfflineButton } from '../../src/components/library/SaveOfflineButton';
import { useUIStore } from '../../src/store/useUIStore';
import type { UnifiedTrack } from '../../src/types/music';

function makeTrack(id: string, overrides: Partial<UnifiedTrack> = {}): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id.replace(/^yt_/, ''),
    title: `Трек ${id}`,
    artist: 'Исполнитель',
    duration: 200,
    artworkUrl: 'https://example.com/art.jpg',
    ...overrides
  };
}

/** Прогоняет микро- и макрозадачи: очередь сохранения работает на промисах. */
async function settle(turns = 5): Promise<void> {
  // Внутри act(), потому что обновления состояния очереди прилетают в кнопку
  // асинхронно — иначе React ругается на изменения вне act.
  await act(async () => {
    for (let i = 0; i < turns; i++) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe('Кнопка «В офлайн» для списка', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearAllData();

    // Состояние сервиса — синглтон, поэтому между тестами его сбрасываем
    // напрямую: иначе первый тест решал бы судьбу остальных.
    (offlineMode as unknown as { initialised: Promise<void> | null }).initialised = null;
    (offlineMode as unknown as { enabled: boolean }).enabled = false;
    (offlineMode as unknown as { bitrateKbps: number }).bitrateKbps = DEFAULT_OFFLINE_BITRATE_KBPS;
    (offlineMode as unknown as { pending: unknown[] }).pending.length = 0;
    (offlineMode as unknown as { batchDone: number }).batchDone = 0;
    (offlineMode as unknown as { batchTotal: number }).batchTotal = 0;
    (offlineMode as unknown as { lastError: string | null }).lastError = null;

    useUIStore.setState({ toastMessage: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('на пустом списке не показывается вовсе', () => {
    render(<SaveOfflineButton tracks={[]} data-testid="save-btn" />);

    expect(screen.queryByTestId('save-btn')).not.toBeInTheDocument();
  });

  it('одним нажатием ставит весь список в очередь', async () => {
    const queueTracks = vi.spyOn(offlineMode, 'queueTracks').mockResolvedValue(2);
    const tracks = [makeTrack('yt_a'), makeTrack('yt_b')];

    render(<SaveOfflineButton tracks={tracks} data-testid="save-btn" />);
    fireEvent.click(screen.getByTestId('save-btn'));

    await waitFor(() => expect(queueTracks).toHaveBeenCalledWith(tracks));
    await waitFor(() => {
      expect(useUIStore.getState().toastMessage?.text).toContain('2 трека');
    });
  });

  it('честно говорит, когда сохранять уже нечего', async () => {
    vi.spyOn(offlineMode, 'queueTracks').mockResolvedValue(0);

    render(<SaveOfflineButton tracks={[makeTrack('yt_a')]} data-testid="save-btn" />);
    fireEvent.click(screen.getByTestId('save-btn'));

    await waitFor(() => {
      expect(useUIStore.getState().toastMessage?.text).toContain('уже сохранено');
    });
  });

  it('не обещает сохранить список, который целиком лежит на диске', async () => {
    vi.spyOn(offlineStorage, 'isDownloaded').mockResolvedValue(true);

    render(<SaveOfflineButton tracks={[makeTrack('yt_a')]} data-testid="save-btn" />);

    await waitFor(() => {
      expect(screen.getByTestId('save-btn')).toBeDisabled();
    });
    expect(screen.getByTestId('save-btn')).toHaveTextContent('В офлайне');
  });

  it('пока очередь идёт, показывает «сделано из всего» и отменяет', async () => {
    // Загрузка не завершается: так очередь остаётся видимой, а счётчик — живым.
    // Держим resolve в объекте, а не в let — иначе TypeScript сузит его до null.
    const held: { release: (() => void) | null } = { release: null };
    vi.spyOn(offlineStorage, 'downloadTrack').mockImplementation(
      () => new Promise<void>((resolve) => {
        held.release = resolve;
      })
    );
    const cancelBatch = vi.spyOn(offlineMode, 'cancelBatch');

    render(<SaveOfflineButton tracks={[makeTrack('yt_a'), makeTrack('yt_b')]} data-testid="save-btn" />);
    fireEvent.click(screen.getByTestId('save-btn'));

    const cancelBtn = await screen.findByTestId('save-btn-cancel');
    expect(cancelBtn).toHaveTextContent('0 из 2');

    fireEvent.click(cancelBtn);
    expect(cancelBatch).toHaveBeenCalled();
    await waitFor(() => {
      expect(useUIStore.getState().toastMessage?.text).toContain('остановлена');
    });

    held.release?.();
    await settle();
  });

  it('сообщает о сбое, а не молчит', async () => {
    vi.spyOn(offlineMode, 'queueTracks').mockRejectedValue(new Error('база недоступна'));

    render(<SaveOfflineButton tracks={[makeTrack('yt_a')]} data-testid="save-btn" />);
    fireEvent.click(screen.getByTestId('save-btn'));

    await waitFor(() => {
      expect(useUIStore.getState().toastMessage?.text).toContain('Не удалось');
    });
    // Кнопка должна вернуться в рабочее состояние, а не остаться в спиннере.
    await waitFor(() => expect(screen.getByTestId('save-btn')).not.toBeDisabled());
  });
});
