import { describe, it, expect } from 'vitest';
import '../setup';
import {
  EXPORT_FORMAT_LABELS,
  PLAYLIST_EXPORT_VERSION,
  PlaylistFileError,
  exportPlaylist,
  parsePlaylistFile,
  slugifyTitle,
  toCsv,
  toM3U8,
  toWireonJson
} from '../../src/services/playlistTransfer';
import type { Playlist, UnifiedTrack } from '../../src/types/music';

const ytTrack: UnifiedTrack = {
  id: 'yt_abc123',
  source: 'youtube',
  originalId: 'abc123',
  title: 'Ночная дорога',
  artist: 'Мотор',
  album: 'Трасса',
  duration: 214,
  artworkUrl: 'https://example.com/a.jpg'
};

const scTrack: UnifiedTrack = {
  id: 'sc_987',
  source: 'soundcloud',
  originalId: '987',
  title: 'Slow, Deep & Loud',
  artist: 'Somebody',
  duration: 0,
  artworkUrl: '',
  sourceUrl: 'https://soundcloud.com/somebody/slow'
};

const playlist: Playlist = {
  id: 'pl_1',
  title: 'Ночная дорога',
  description: 'Для длинных перегонов',
  tracks: [ytTrack, scTrack],
  createdAt: 1_000,
  updatedAt: 2_000,
  isSynced: false
};

const EXPORTED_AT = Date.UTC(2026, 7, 18, 12, 0, 0);

describe('Перенос отдельного плейлиста (пункт 8)', () => {
  describe('Имя файла', () => {
    it('транслитерирует название и подставляет дату', () => {
      const file = exportPlaylist(playlist, 'wireon', EXPORTED_AT);
      expect(file.filename).toMatch(/^nochnaya-doroga-\d{4}-\d{2}-\d{2}\.wireon\.json$/);
    });

    it('не оставляет пустое имя, когда в названии нет ни букв, ни цифр', () => {
      expect(slugifyTitle('???')).toBe('playlist');
      expect(slugifyTitle('')).toBe('playlist');
    });

    it('даёт каждому формату своё расширение и MIME-тип', () => {
      expect(exportPlaylist(playlist, 'm3u8', EXPORTED_AT).filename).toMatch(/\.m3u8$/);
      expect(exportPlaylist(playlist, 'csv', EXPORTED_AT).mimeType).toContain('text/csv');
      expect(Object.keys(EXPORT_FORMAT_LABELS)).toEqual(['wireon', 'm3u8', 'csv']);
    });
  });

  describe('Формат Wireon', () => {
    it('сохраняет id, источник и длительность каждого трека', () => {
      const parsed = JSON.parse(toWireonJson(playlist, EXPORTED_AT));
      expect(parsed.format).toBe('wireon-playlist');
      expect(parsed.version).toBe(PLAYLIST_EXPORT_VERSION);
      expect(parsed.trackCount).toBe(2);
      expect(parsed.tracks[0]).toMatchObject({
        id: 'yt_abc123',
        source: 'youtube',
        originalId: 'abc123',
        title: 'Ночная дорога',
        duration: 214
      });
    });

    it('подставляет ссылку на источник, когда её не было в треке', () => {
      const parsed = JSON.parse(toWireonJson(playlist, EXPORTED_AT));
      expect(parsed.tracks[0].sourceUrl).toBe('https://www.youtube.com/watch?v=abc123');
      // У второго трека своя ссылка — её и оставляем.
      expect(parsed.tracks[1].sourceUrl).toBe('https://soundcloud.com/somebody/slow');
    });

    it('переживает круг «выгрузили → загрузили» без поиска', () => {
      const file = exportPlaylist(playlist, 'wireon', EXPORTED_AT);
      const back = parsePlaylistFile(file.content, file.filename);

      expect(back.title).toBe('Ночная дорога');
      expect(back.items).toHaveLength(0);
      expect(back.tracks).toHaveLength(2);
      expect(back.tracks[0].id).toBe('yt_abc123');
      expect(back.tracks[0].artist).toBe('Мотор');
      expect(back.tracks[1].source).toBe('soundcloud');
    });

    it('отправляет в поиск запись без источника, а не в плейлист', () => {
      const broken = JSON.stringify({
        format: 'wireon-playlist',
        version: 1,
        title: 'Сборный',
        tracks: [
          { title: 'Без источника', artist: 'Кто-то' },
          { id: 'yt_ok', source: 'youtube', originalId: 'ok', title: 'Целая', artist: 'Она', duration: 100 }
        ]
      });
      const parsed = parsePlaylistFile(broken);
      expect(parsed.tracks.map((t) => t.title)).toEqual(['Целая']);
      expect(parsed.items.map((i) => i.title)).toEqual(['Без источника']);
    });

    it('отказывается читать чужой JSON и слишком новый формат', () => {
      expect(() => parsePlaylistFile('{"format":"spotify-export"}')).toThrow(PlaylistFileError);
      expect(() => parsePlaylistFile('{"format":"spotify-export"}')).toThrow(/не файл плейлиста/i);
      expect(() =>
        parsePlaylistFile(JSON.stringify({ format: 'wireon-playlist', version: 99, tracks: [] }))
      ).toThrow(/более новой версией/i);
      expect(() => parsePlaylistFile('{ не json')).toThrow(/не читается как JSON/i);
    });
  });

  describe('Формат M3U8', () => {
    it('пишет #EXTINF с длительностью и ссылкой на источник', () => {
      const lines = toM3U8(playlist).split('\n');
      expect(lines[0]).toBe('#EXTM3U');
      expect(lines[1]).toBe('#PLAYLIST:Ночная дорога');
      expect(lines[2]).toBe('#EXTINF:214,Мотор - Ночная дорога');
      expect(lines[3]).toBe('https://www.youtube.com/watch?v=abc123');
    });

    it('ставит -1, когда длительность неизвестна', () => {
      expect(toM3U8(playlist)).toContain('#EXTINF:-1,Somebody - Slow, Deep & Loud');
    });

    it('заканчивается переводом строки — иначе часть плееров теряет последний трек', () => {
      expect(toM3U8(playlist).endsWith('\n')).toBe(true);
    });

    it('читает свой же файл обратно как строки для поиска', () => {
      const file = exportPlaylist(playlist, 'm3u8', EXPORTED_AT);
      const back = parsePlaylistFile(file.content, file.filename);

      expect(back.source).toBe('m3u8');
      expect(back.title).toBe('Ночная дорога');
      expect(back.tracks).toHaveLength(0);
      expect(back.items).toEqual([
        { title: 'Ночная дорога', artist: 'Мотор', duration: 214 },
        { title: 'Slow, Deep & Loud', artist: 'Somebody', duration: undefined }
      ]);
    });

    it('читает чужой m3u без #EXTINF, доставая название из имени файла', () => {
      const foreign = ['#EXTM3U', 'C:\\Music\\04 - Кино - Группа крови.mp3', '/home/u/Songs/Bad_Apple.flac'].join('\n');
      const back = parsePlaylistFile(foreign, 'foreign.m3u');

      expect(back.items).toEqual([
        { title: 'Группа крови', artist: 'Кино', duration: undefined },
        { title: 'Bad Apple', artist: '', duration: undefined }
      ]);
    });

    it('не молчит, когда в m3u нет ни одного трека', () => {
      expect(() => parsePlaylistFile('#EXTM3U\n#EXT-X-VERSION:3\n', 'empty.m3u8')).toThrow(
        /ни одного трека/i
      );
    });
  });

  describe('Формат CSV', () => {
    it('ставит BOM и заворачивает поля с запятыми', () => {
      const csv = toCsv(playlist);
      expect(csv.startsWith('\ufeff')).toBe(true);
      expect(csv).toContain('Исполнитель,Название,Альбом,Длительность,Источник,Ссылка');
      // В названии второго трека есть запятая — поле должно быть в кавычках.
      expect(csv).toContain('"Slow, Deep & Loud"');
      expect(csv).toContain('3:34');
    });

    it('находит колонки по заголовку в любом порядке', () => {
      const foreign = [
        'Track Name,Artist Name,Album',
        'Группа крови,Кино,Группа крови',
        'Bad Apple,Alstroemeria,'
      ].join('\n');
      const back = parsePlaylistFile(foreign, 'spotify.csv');

      expect(back.source).toBe('csv');
      expect(back.items).toEqual([
        { title: 'Группа крови', artist: 'Кино', album: 'Группа крови' },
        { title: 'Bad Apple', artist: 'Alstroemeria', album: undefined }
      ]);
    });

    it('читает файл без заголовка как «исполнитель, название»', () => {
      const back = parsePlaylistFile('Кино,Группа крови\nMotorama,Alps\n');
      expect(back.items).toEqual([
        { title: 'Группа крови', artist: 'Кино', album: undefined },
        { title: 'Alps', artist: 'Motorama', album: undefined }
      ]);
    });

    it('переживает свой же экспорт с кавычками внутри поля', () => {
      const file = exportPlaylist(playlist, 'csv', EXPORTED_AT);
      const back = parsePlaylistFile(file.content, file.filename);
      expect(back.items.map((i) => i.title)).toEqual(['Ночная дорога', 'Slow, Deep & Loud']);
    });

    it('не принимает пустой файл', () => {
      expect(() => parsePlaylistFile('   ')).toThrow(/пуст/i);
    });
  });
});
