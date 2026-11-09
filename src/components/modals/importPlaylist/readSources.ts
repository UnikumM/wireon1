import { youtubeService } from '../../../services/youtube';
import { soundCloudService } from '../../../services/soundcloud';
import { parseCollectionLink } from '../../../services/collections';
import { getFreshAccessToken } from '../../../services/spotifyAuth';
import { fetchPlaylistItems } from '../../../services/spotifyLibrary';
import { playlistImporter, ParsedPlaylistItem } from '../../../services/playlistImporter';
import { parsePlaylistFile, PlaylistFileError } from '../../../services/playlistTransfer';
import type { UnifiedTrack } from '../../../types/music';
import { UNTITLED_PLAYLIST } from '../../../utils/placeholders';
import type { PreviewState } from './types';

/** `nochnaya-doroga-2026-08-18.wireon.json` → `nochnaya-doroga-2026-08-18`. */
function titleFromFilename(filename: string): string {
  return filename.replace(/\.(wireon\.)?[a-z0-9]{2,5}$/i, '').trim() || UNTITLED_PLAYLIST;
}

/**
 * Треки плейлиста Spotify: через API, а если он отказал — с публичной страницы.
 *
 * После миграции Spotify (март 2026) API отдаёт содержимое только своих и
 * совместных плейлистов. Чужой плейлист, на который человек подписан, отвечает
 * отказом — и раньше этот отказ показывался красной надписью вместо переноса.
 * Публичная страница читает любой открытый плейлист, но только первую сотню.
 */
export async function readSpotifyPlaylist(
  playlistId: string
): Promise<{ title?: string; items: ParsedPlaylistItem[]; complete: boolean }> {
  const token = await getFreshAccessToken().catch(() => null);
  if (token) {
    try {
      const items = await fetchPlaylistItems(token, playlistId);
      if (items.length > 0) return { items, complete: true };
    } catch (err) {
      console.warn('[ImportPlaylistModal] Spotify API не отдал плейлист, читаю страницу:', err);
    }
  }
  const parsed = await playlistImporter.parsePlaylistUrl(`https://open.spotify.com/playlist/${playlistId}`);
  return { title: parsed.title, items: parsed.items ?? [], complete: false };
}

/**
 * Плейлист по ссылке — в состояние предпросмотра.
 *
 * Отказ — исключение с готовым текстом для баннера: окно показывает его как
 * есть, поэтому формулировки здесь обращены к человеку, а не к журналу.
 */
export async function readPlaylistLink(trimmed: string): Promise<PreviewState> {
  // Плейлист YouTube Music переносится как есть: он уже состоит из тех
  // самых записей, которые мы играем, — искать и подбирать нечего, а
  // значит и подменить нечем.
  const detected = playlistImporter.detectPlatform(trimmed);
  if (detected === 'youtube' || detected === 'soundcloud') {
    let tracks: UnifiedTrack[] = [];
    let title: string | null = null;
    if (detected === 'youtube') {
      const listId = playlistImporter.extractYouTubePlaylistId(trimmed);
      tracks = listId ? await youtubeService.getPlaylistTracks(listId) : [];
    } else {
      // Плейлист SoundCloud — как есть, со своим названием.
      const link = parseCollectionLink(trimmed);
      const found = link ? await soundCloudService.getPlaylistWithTitle(link.ref) : null;
      tracks = found?.tracks ?? [];
      title = found?.title ?? null;
    }
    if (tracks.length === 0) {
      throw new Error('Не удалось прочитать этот плейлист. Проверьте, что он доступен по ссылке всем.');
    }

    return {
      title: title || (detected === 'soundcloud' ? 'Плейлист из SoundCloud' : 'Плейлист из YouTube Music'),
      items: [],
      readyTracks: tracks,
      origin: { kind: 'platform', platform: detected }
    };
  }

  // Ссылка на Spotify, когда вход уже сделан: список берётся у них по-честному
  // и целиком. Публичная страница отдаёт первую сотню треков и молчит об
  // остальных — именно отсюда бралось «перенеслось не всё».
  if (playlistImporter.detectPlatform(trimmed) === 'spotify') {
    const spotifyId = /playlist[/:]([a-zA-Z0-9]+)/.exec(trimmed)?.[1];
    const token = spotifyId ? await getFreshAccessToken().catch(() => null) : null;
    // Отказ API (чужой плейлист, режим разработки) — не ошибка переноса:
    // ниже та же ссылка читается публичной страницей.
    const items =
      spotifyId && token
        ? await fetchPlaylistItems(token, spotifyId).catch((err) => {
            console.warn('[ImportPlaylistModal] Spotify API не отдал плейлист, читаю страницу:', err);
            return [] as ParsedPlaylistItem[];
          })
        : [];
    if (items.length > 0) {
      return {
        title: 'Плейлист из Spotify',
        items,
        readyTracks: [],
        origin: { kind: 'platform', platform: 'spotify' }
      };
    }
  }

  const parsed = await playlistImporter.parsePlaylistUrl(trimmed);
  if (!parsed.items || parsed.items.length === 0) {
    throw new Error('В этом плейлисте не нашлось ни одного трека. Проверьте, что он открыт для всех.');
  }

  return {
    title: parsed.title,
    description: parsed.description,
    coverUrl: parsed.coverUrl,
    items: parsed.items,
    readyTracks: [],
    origin: { kind: 'platform', platform: parsed.platform }
  };
}

/**
 * Плейлист из файла: наш `.wireon.json`, `.m3u8` из другого плеера или таблица.
 * Формат определяет `parsePlaylistFile` по содержимому — расширение не важно.
 * Пустой файл — такой же `PlaylistFileError`, как и нечитаемый: его текст
 * показывается без приписки «Не удалось прочитать файл».
 */
export async function readPlaylistFile(file: File): Promise<PreviewState> {
  const text = await file.text();
  const parsed = parsePlaylistFile(text, file.name);
  if (parsed.items.length === 0 && parsed.tracks.length === 0) {
    throw new PlaylistFileError('В файле не нашлось ни одного трека.');
  }

  return {
    title: parsed.title === UNTITLED_PLAYLIST ? titleFromFilename(file.name) : parsed.title,
    description: parsed.description,
    items: parsed.items,
    readyTracks: parsed.tracks,
    origin: { kind: 'file', filename: file.name }
  };
}
