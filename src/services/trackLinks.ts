/**
 * Ссылка на отдельный трек в строке поиска.
 *
 * Плейлисты и альбомы по ссылке открывает `collections.ts`; ссылка на один
 * трек до сих пор уходила в поиск как текст — для SoundCloud это пустая
 * выдача, для YouTube — случайные совпадения по буквам адреса. Здесь адрес
 * разбирается на источник и ключ, а по ключу у источника спрашивается сама
 * запись. Поиск показывает её первой, а под ней ищет по названию — чтобы
 * рядом были и другие версии.
 */

import { UnifiedTrack } from '../types/music';
import { soundCloudService } from './soundcloud';
import { youtubeService } from './youtube';
import { UNKNOWN_ARTIST } from '../utils/placeholders';

export type ParsedTrackLink =
  | { source: 'youtube'; videoId: string }
  | { source: 'soundcloud'; url: string };

/** Идентификатор видео YouTube — всегда одиннадцать знаков. */
const YOUTUBE_ID = /^[\w-]{11}$/;

/** Пути вида `/shorts/ID`, `/embed/ID`, `/live/ID`, `/v/ID`. */
const YOUTUBE_PATH_ID = /^\/(?:shorts|embed|live|v)\/([\w-]{11})(?:[/?#]|$)/;

/**
 * Разделы SoundCloud, у которых второй сегмент пути — не трек автора.
 * `soundcloud.com/search/sounds`, `soundcloud.com/discover/sets` и т.п.
 */
const SOUNDCLOUD_RESERVED = new Set([
  'search', 'discover', 'you', 'stream', 'charts', 'tags', 'people', 'pages',
  'upload', 'settings', 'messages', 'notifications', 'terms-of-use', 'jobs',
  'imprint', 'mobile', 'popular', 'explore', 'stations', 'feed', 'login', 'signin'
]);

/** Похоже ли на адрес одного из наших источников — без схемы тоже считается. */
const LOOKS_LIKE_LINK = /^(https?:\/\/)?((www|m|music|on)\.)?(youtube\.com|youtu\.be|soundcloud\.com)\//i;

function toUrl(raw: string): URL | null {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

/**
 * Ссылка на трек → источник и ключ, всё остальное → `null`.
 *
 * Понимает `youtube.com/watch?v=ID` (и `m.`, и `music.`), `youtu.be/ID`,
 * `/shorts/ID`, `soundcloud.com/<кто>/<что>` и короткие `on.soundcloud.com/<код>`.
 * Лишние параметры (`?t=`, `&si=`) не мешают. Если в адресе есть и `v`, и
 * `list`, это трек внутри плейлиста — возвращается трек: подборку по чистой
 * ссылке поиск и так умеет открывать.
 */
export function parseTrackLink(text: string): ParsedTrackLink | null {
  const raw = (text || '').trim();
  if (!raw || /\s/.test(raw) || !LOOKS_LIKE_LINK.test(raw)) return null;
  const url = toUrl(raw);
  if (!url) return null;
  const host = url.hostname.replace(/^(www|m)\./, '').toLowerCase();

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] || '';
    return YOUTUBE_ID.test(id) ? { source: 'youtube', videoId: id } : null;
  }

  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v') || '';
    if (YOUTUBE_ID.test(v)) return { source: 'youtube', videoId: v };
    const byPath = YOUTUBE_PATH_ID.exec(url.pathname);
    return byPath ? { source: 'youtube', videoId: byPath[1] } : null;
  }

  if (host === 'soundcloud.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    // Два сегмента — автор и трек; третий допустим только как секретный
    // ключ приватной записи (`/s-XXXX`). Сеты и служебные разделы — не треки.
    if (parts.length < 2 || parts.length > 3) return null;
    if (parts[1] === 'sets' || SOUNDCLOUD_RESERVED.has(parts[0].toLowerCase())) return null;
    if (parts.length === 3 && !/^s-/.test(parts[2])) return null;
    return { source: 'soundcloud', url: `https://soundcloud.com/${parts.join('/')}` };
  }

  if (host === 'on.soundcloud.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    return { source: 'soundcloud', url: `https://on.soundcloud.com/${parts[0]}` };
  }

  return null;
}

/**
 * Сама запись по разобранной ссылке. `null` — «не нашли»: поиск тогда идёт
 * по тексту ссылки, как раньше, и говорит об этом строкой, а не ошибкой.
 */
export async function resolveTrackLink(parsed: ParsedTrackLink | null): Promise<UnifiedTrack | null> {
  if (!parsed) return null;
  try {
    if (parsed.source === 'youtube') return await youtubeService.getTrackById(parsed.videoId);
    return await soundCloudService.resolveTrackUrl(parsed.url);
  } catch (err) {
    console.warn('[TrackLinks] Не удалось открыть трек по ссылке:', err);
    return null;
  }
}

/** Что искать под треком по ссылке, чтобы нашлись и другие его версии. */
export function trackSearchQuery(track: UnifiedTrack): string {
  const artist = (track.artist || '').trim();
  const title = (track.title || '').trim();
  return artist && artist !== UNKNOWN_ARTIST ? `${artist} ${title}`.trim() : title;
}
