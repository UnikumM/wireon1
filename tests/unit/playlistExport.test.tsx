/**
 * Вынос плейлиста наружу — меню в шапке плейлиста.
 *
 * Сам формат файлов проверяется в `playlistTransfer.test.ts`; здесь проверяется
 * ровно то, что между кнопкой и файлом: правильный формат под правильным
 * пунктом, честное имя файла, отсутствие висящих object URL и осмысленный ответ,
 * когда сохранить или скопировать не получилось.
 *
 * jsdom не умеет ни `URL.createObjectURL`, ни переход по `<a download>`, ни
 * буфер обмена — всё три подменяются вручную.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { PlaylistExportMenu } from '../../src/components/library/PlaylistExportMenu';
import { PlaylistView } from '../../src/components/library/PlaylistView';
import { useUIStore } from '../../src/store/useUIStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import type { Playlist } from '../../src/types/music';
import { createMockTrack } from '../helpers/mockData';
import { resetLibraryStore, resetUIStore } from '../helpers/testUtils';

const TRACKS = [
  createMockTrack({
    id: 'yt_night',
    originalId: 'night',
    title: 'Ночная дорога',
    artist: 'Кассета',
    album: 'Трасса',
    duration: 214,
    sourceUrl: 'https://www.youtube.com/watch?v=night'
  }),
  createMockTrack({
    id: 'sc_neon',
    source: 'soundcloud',
    originalId: '9001',
    title: 'Neon, Rain',
    artist: 'Halogen',
    album: undefined,
    duration: 187,
    sourceUrl: 'https://soundcloud.com/halogen/neon-rain'
  })
];

function makePlaylist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: 'pl_export',
    title: 'Ночная дорога',
    tracks: TRACKS,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    isSynced: false,
    ...overrides
  };
}

function toast() {
  return useUIStore.getState().toastMessage;
}

describe('PlaylistExportMenu (src/components/library/PlaylistExportMenu.tsx)', () => {
  let anchorClicks: Array<{ href: string; download: string }>;
  let createdBlobs: Blob[];
  let revoked: string[];
  let originalClipboard: unknown;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetUIStore();
    resetLibraryStore();

    createdBlobs = [];
    anchorClicks = [];
    revoked = [];

    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn((blob: Blob) => {
      createdBlobs.push(blob);
      return `blob:wireon/${createdBlobs.length}`;
    });
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
      this: HTMLAnchorElement
    ) {
      anchorClicks.push({ href: this.href, download: this.download });
    });

    originalClipboard = (navigator as unknown as { clipboard?: unknown }).clipboard;
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
      writable: true
    });
  });

  /** Меню закрыто до нажатия — иначе три пункта висят над списком треков. */
  it('opens and closes the menu, restoring focus to its trigger', () => {
    render(<PlaylistExportMenu playlist={makePlaylist()} />);

    expect(screen.queryByTestId('playlist-export-menu')).not.toBeInTheDocument();
    const trigger = screen.getByTestId('playlist-export-btn');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(screen.getByTestId('playlist-export-menu')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('playlist-export-menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);

    // Клик мимо меню закрывает его так же.
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('playlist-export-menu')).not.toBeInTheDocument();
  });

  it('offers all three formats with their labels and hints', () => {
    render(<PlaylistExportMenu playlist={makePlaylist()} />);
    fireEvent.click(screen.getByTestId('playlist-export-btn'));

    const menu = screen.getByTestId('playlist-export-menu');
    expect(menu).toHaveAttribute('role', 'menu');
    expect(screen.getByTestId('playlist-export-wireon')).toHaveTextContent('Wireon Sounds (.json)');
    expect(screen.getByTestId('playlist-export-m3u8')).toHaveTextContent('Плейлист (.m3u8)');
    expect(screen.getByTestId('playlist-export-csv')).toHaveTextContent('Таблица (.csv)');
    // Подсказка объясняет, зачем формат нужен — иначе выбор угадывается.
    expect(screen.getByTestId('playlist-export-wireon').textContent).not.toBe('Wireon Sounds (.json)');
  });

  it('saves the Wireon JSON file with a slugified, dated name', async () => {
    render(<PlaylistExportMenu playlist={makePlaylist()} />);
    fireEvent.click(screen.getByTestId('playlist-export-btn'));
    fireEvent.click(screen.getByTestId('playlist-export-wireon'));

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    // Кириллица в названии транслитерируется — файловые системы её местами калечат.
    expect(anchorClicks[0].download).toMatch(/^nochnaya-doroga-\d{4}-\d{2}-\d{2}\.wireon\.json$/);
    expect(anchorClicks[0].href).toBe('blob:wireon/1');
    expect(createdBlobs[0].type).toBe('application/json;charset=utf-8');

    // Меню закрылось, ссылка в документе не осталась, object URL освобождён.
    expect(screen.queryByTestId('playlist-export-menu')).not.toBeInTheDocument();
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    await waitFor(() => expect(revoked).toEqual(['blob:wireon/1']));

    expect(toast()?.type).toBe('success');
    expect(toast()?.text).toContain('2 трека');
    expect(toast()?.text).toContain('.wireon.json');
  });

  it('saves m3u8 and csv under their own extensions and MIME types', async () => {
    const { unmount } = render(<PlaylistExportMenu playlist={makePlaylist()} />);
    fireEvent.click(screen.getByTestId('playlist-export-btn'));
    fireEvent.click(screen.getByTestId('playlist-export-m3u8'));
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(anchorClicks[0].download).toMatch(/^nochnaya-doroga-\d{4}-\d{2}-\d{2}\.m3u8$/);
    expect(createdBlobs[0].type).toBe('audio/x-mpegurl;charset=utf-8');
    unmount();

    render(<PlaylistExportMenu playlist={makePlaylist()} />);
    fireEvent.click(screen.getByTestId('playlist-export-btn'));
    fireEvent.click(screen.getByTestId('playlist-export-csv'));
    await waitFor(() => expect(anchorClicks).toHaveLength(2));
    expect(anchorClicks[1].download).toMatch(/^nochnaya-doroga-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(createdBlobs[1].type).toBe('text/csv;charset=utf-8');
  });

  it('writes the actual playlist into the blob it hands to the browser', async () => {
    render(<PlaylistExportMenu playlist={makePlaylist()} />);
    fireEvent.click(screen.getByTestId('playlist-export-btn'));
    fireEvent.click(screen.getByTestId('playlist-export-m3u8'));

    await waitFor(() => expect(createdBlobs).toHaveLength(1));
    const text = await readBlob(createdBlobs[0]);
    expect(text).toContain('#EXTM3U');
    // В m3u8 разделитель — обычный дефис, как ждут внешние плееры.
    expect(text).toContain('#EXTINF:214,Кассета - Ночная дорога');
    expect(text).toContain('https://soundcloud.com/halogen/neon-rain');
  });

  it('refuses to export an empty playlist instead of writing an empty file', () => {
    render(<PlaylistExportMenu playlist={makePlaylist({ tracks: [] })} />);
    fireEvent.click(screen.getByTestId('playlist-export-btn'));
    fireEvent.click(screen.getByTestId('playlist-export-csv'));

    expect(anchorClicks).toHaveLength(0);
    expect(toast()?.type).toBe('info');
    expect(toast()?.text).toMatch(/нет треков/i);
  });

  it('reports a failure when the browser cannot save the file', async () => {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = undefined;

    render(<PlaylistExportMenu playlist={makePlaylist()} />);
    fireEvent.click(screen.getByTestId('playlist-export-btn'));
    fireEvent.click(screen.getByTestId('playlist-export-wireon'));

    await waitFor(() => expect(toast()?.type).toBe('error'));
    expect(toast()?.text).toMatch(/не получилось/i);
    expect(anchorClicks).toHaveLength(0);
  });

  it('copies a numbered "artist — title" list to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true
    });

    render(<PlaylistExportMenu playlist={makePlaylist()} />);
    fireEvent.click(screen.getByTestId('playlist-export-btn'));
    fireEvent.click(screen.getByTestId('playlist-copy-list'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toBe(
      'Ночная дорога\n\n1. Кассета — Ночная дорога\n2. Halogen — Neon, Rain'
    );
    // Ни одного файла — этот пункт только для переписки.
    expect(anchorClicks).toHaveLength(0);
    await waitFor(() => expect(toast()?.type).toBe('success'));
    expect(toast()?.text).toContain('2 трека');
  });

  it('suggests exporting a file when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true
    });

    render(<PlaylistExportMenu playlist={makePlaylist()} />);
    fireEvent.click(screen.getByTestId('playlist-export-btn'));
    fireEvent.click(screen.getByTestId('playlist-copy-list'));

    await waitFor(() => expect(toast()?.type).toBe('error'));
    expect(toast()?.text).toMatch(/выгрузите файлом/i);
  });

  it('is reachable from the playlist header', async () => {
    const playlist = makePlaylist({ id: 'pl_header' });
    useLibraryStore.setState({ playlists: [playlist] });

    render(<PlaylistView playlistId="pl_header" />);

    fireEvent.click(screen.getByTestId('playlist-export-btn'));
    fireEvent.click(screen.getByTestId('playlist-export-wireon'));

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(anchorClicks[0].download).toMatch(/\.wireon\.json$/);
  });
});

/** jsdom отдаёт содержимое Blob только через `text()`/`FileReader`. */
async function readBlob(blob: Blob): Promise<string> {
  if (typeof (blob as { text?: () => Promise<string> }).text === 'function') {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
