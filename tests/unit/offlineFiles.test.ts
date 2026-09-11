/**
 * Офлайн файлами (`src/services/offlineFiles.ts`).
 *
 * Проверяется ровно то, из-за чего офлайн на телефоне не работал: звук лежал
 * целым `Blob` внутри записи IndexedDB — упирался в квоту WebView, исчезал при
 * нехватке места и тёк ссылками на каждое включение.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const isNative = vi.fn(() => true);
const writeFile = vi.fn(async (_options: { path: string; data: string }) => ({
  uri: 'file:///data/offline/yt_a.mp3'
}));
const getUri = vi.fn(async (_options: { path: string }) => ({
  uri: 'file:///data/offline/yt_a.mp3'
}));
const deleteFile = vi.fn(async (_options: { path: string }) => undefined);
const rmdir = vi.fn(async (_options: { path: string; recursive?: boolean }) => undefined);
const mkdir = vi.fn(async (_options: { path: string }) => undefined);

// Обёртки, а не сами шпионы: фабрика `vi.mock` поднимается выше объявлений,
// и на сам `writeFile` она сослаться не может.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => isNative(),
    convertFileSrc: (uri: string) => `https://localhost/_capacitor_file_${uri}`
  }
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', Cache: 'CACHE' },
  Filesystem: {
    writeFile: (options: { path: string; data: string }) => writeFile(options),
    getUri: (options: { path: string }) => getUri(options),
    deleteFile: (options: { path: string }) => deleteFile(options),
    rmdir: (options: { path: string; recursive?: boolean }) => rmdir(options),
    mkdir: (options: { path: string }) => mkdir(options)
  }
}));

import {
  clearTrackFiles,
  deleteTrackFile,
  objectUrlFor,
  offlineFileName,
  revokeObjectUrl,
  trackFileUrl,
  writeTrackFile
} from '../../src/services/offlineFiles';

describe('имя файла', () => {
  it('чистит идентификатор и ставит расширение по формату', () => {
    expect(offlineFileName('yt_dQw4w9WgXcQ', 'opus')).toBe('offline/yt_dQw4w9WgXcQ.opus');
    // У SoundCloud в ключ попадают символы, которых файловая система не примет.
    expect(offlineFileName('sc_https://x/y?z=1')).toBe('offline/sc_https___x_y_z_1.mp3');
  });
});

describe('на телефоне', () => {
  beforeEach(() => {
    isNative.mockReturnValue(true);
    vi.clearAllMocks();
  });

  it('пишет трек файлом и возвращает путь', async () => {
    const path = await writeTrackFile('yt_a', new Blob(['sound'], { type: 'audio/mpeg' }), 'mp3');

    expect(path).toBe('offline/yt_a.mp3');
    expect(writeFile).toHaveBeenCalledTimes(1);
    // Данные уходят строкой: двоичное плагин не принимает.
    expect(typeof writeFile.mock.calls[0][0].data).toBe('string');
  });

  it('отдаёт ссылку внутренней схемы, а не file://', async () => {
    // Напрямую `file://` из страницы не открывается — звука бы просто не было.
    const url = await trackFileUrl('offline/yt_a.mp3');
    expect(url).toContain('_capacitor_file_');
  });

  it('удаление снимает файл, а очистка — всю папку', async () => {
    await deleteTrackFile('offline/yt_a.mp3');
    await clearTrackFiles();

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(rmdir).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'offline', recursive: true })
    );
  });
});

describe('на десктопе', () => {
  beforeEach(() => {
    isNative.mockReturnValue(false);
    vi.clearAllMocks();
  });

  it('файловое хранилище молчит, и трек остаётся в базе', async () => {
    const path = await writeTrackFile('yt_a', new Blob(['sound']), 'mp3');

    expect(path).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('ссылки на Blob', () => {
  const created: string[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => {
        const url = `blob:mock-${created.length}-${blob.size}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => revoked.push(url)
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('одна ссылка на трек, и она освобождается', () => {
    // Раньше ссылка создавалась на каждое включение и не освобождалась ни разу:
    // за вечер приложение удерживало в памяти все проигранные треки целиком.
    const blob = new Blob(['sound']);
    const first = objectUrlFor('yt_leak', blob);
    const second = objectUrlFor('yt_leak', blob);

    expect(second).toBe(first);
    expect(created).toHaveLength(1);

    revokeObjectUrl('yt_leak');
    expect(revoked).toEqual([first]);

    // После освобождения ссылка заводится заново, а не отдаётся мёртвой.
    expect(objectUrlFor('yt_leak', blob)).not.toBe(first);
  });
});
