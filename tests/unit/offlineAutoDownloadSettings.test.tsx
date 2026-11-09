/**
 * Блок «Избранное офлайн» в настройках офлайна.
 *
 * Проверяется то, что видит человек: строка «42 из 118 · 1,3 ГБ из 5 ГБ»,
 * тумблер и лимит пишут настройки, «Только по Wi‑Fi» есть лишь на телефоне,
 * «Скачать сейчас» зовёт проход, а «место кончилось» выводится словами.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../setup';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { clearAllData, getSetting } from '../../src/services/db';
import { offlineMode } from '../../src/services/offlineMode';
import {
  offlineAutoDownload,
  FAVORITES_AUTO_SETTING,
  FAVORITES_LIMIT_SETTING,
  DEFAULT_FAVORITES_LIMIT_BYTES
} from '../../src/services/offlineAutoDownload';
import { OfflineSettings } from '../../src/components/settings/OfflineSettings';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useUIStore } from '../../src/store/useUIStore';
import type { UnifiedTrack } from '../../src/types/music';

const GIB = 1024 * 1024 * 1024;

function makeTrack(id: string): UnifiedTrack {
  return {
    id,
    source: 'youtube',
    originalId: id,
    title: `Трек ${id}`,
    artist: 'Исполнитель',
    duration: 200,
    artworkUrl: 'https://example.com/art.jpg'
  };
}

type Internals = {
  initialised: Promise<void> | null;
  enabled: boolean;
  wifiOnly: boolean;
  limitBytes: number;
  favoritesTotal: number;
  favoritesOffline: number;
  queued: number;
  usedBytes: number;
  storageFull: boolean;
  waitingForWifi: boolean;
  lastError: string | null;
};

const internals = () => offlineAutoDownload as unknown as Internals;

describe('Настройки: избранное офлайн', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearAllData();
    useLibraryStore.setState({ favorites: [] });
    useUIStore.setState({ toastMessage: null });

    (offlineMode as unknown as { initialised: Promise<void> | null }).initialised = null;
    const svc = internals();
    svc.initialised = null;
    svc.enabled = false;
    svc.wifiOnly = true;
    svc.limitBytes = DEFAULT_FAVORITES_LIMIT_BYTES;
    svc.favoritesTotal = 0;
    svc.favoritesOffline = 0;
    svc.queued = 0;
    svc.usedBytes = 0;
    svc.storageFull = false;
    svc.waitingForWifi = false;
    svc.lastError = null;
    offlineAutoDownload.deps.platform = () => 'electron';
    offlineAutoDownload.deps.connection = () => 'wifi';
  });

  afterEach(() => {
    cleanup();
  });

  it('показывает «сколько из скольких» и занятое место против лимита', async () => {
    useLibraryStore.setState({ favorites: [makeTrack('a'), makeTrack('b'), makeTrack('c')] });
    // Цифры подставляются напрямую: сам подсчёт проверяет тест службы.
    vi.spyOn(offlineAutoDownload, 'refreshStats').mockImplementation(async () => {
      const svc = internals();
      svc.favoritesTotal = 3;
      svc.favoritesOffline = 1;
      svc.queued = 2;
      svc.usedBytes = 1.3 * GIB;
      (offlineAutoDownload as unknown as { notify: () => void }).notify();
    });

    render(<OfflineSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('offline-favorites-status')).toHaveTextContent('1 из 3 · 1,3 ГБ из 5 ГБ');
    });
    expect(screen.getByText('В очереди 2 трека.')).toBeInTheDocument();
  });

  it('тумблер и лимит пишут настройки', async () => {
    const sync = vi.spyOn(offlineAutoDownload, 'sync').mockResolvedValue();
    render(<OfflineSettings />);

    fireEvent.click(screen.getByTestId('offline-favorites-auto'));
    await waitFor(async () => {
      expect(await getSetting<boolean>(FAVORITES_AUTO_SETTING, false)).toBe(true);
    });
    // Включение сразу зовёт проход — иначе «само» началось бы только с перезапуска.
    expect(sync).toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('offline-favorites-limit'), { target: { value: String(2 * GIB) } });
    await waitFor(async () => {
      expect(await getSetting<number>(FAVORITES_LIMIT_SETTING, 0)).toBe(2 * GIB);
    });
  });

  it('«Только по Wi‑Fi» есть на телефоне и нет на ПК', async () => {
    const { unmount } = render(<OfflineSettings />);
    await waitFor(() => expect(screen.getByTestId('offline-favorites-auto')).toBeInTheDocument());
    expect(screen.queryByTestId('offline-favorites-wifi')).not.toBeInTheDocument();
    unmount();

    offlineAutoDownload.deps.platform = () => 'mobile';
    render(<OfflineSettings />);
    await waitFor(() => expect(screen.getByTestId('offline-favorites-wifi')).toBeInTheDocument());
    expect(screen.getByTestId('offline-favorites-wifi')).toBeChecked();
  });

  it('«Скачать сейчас» зовёт проход, даже когда автозагрузка выключена', async () => {
    const runNow = vi.spyOn(offlineAutoDownload, 'runNow').mockResolvedValue();
    // Один трек без офлайн-копии — иначе кнопке нечего качать, и она выключена.
    useLibraryStore.setState({ favorites: [makeTrack('pending')] });
    render(<OfflineSettings />);

    const button = await screen.findByTestId('offline-favorites-download');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    expect(runNow).toHaveBeenCalledTimes(1);
  });

  it('когда место кончилось — говорит об этом словами', async () => {
    internals().storageFull = true;
    internals().queued = 4;
    render(<OfflineSettings />);

    await waitFor(() => {
      expect(screen.getByText(/Место кончилось/)).toBeInTheDocument();
    });
  });
});
