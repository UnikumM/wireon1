/**
 * Раскрытие найденной подборки в треки.
 *
 * Альбом, плейлист и профиль приходят из поиска одной карточкой, а играются
 * по-разному: у YouTube альбом лежит за `browse`-запросом, плейлист — за другим
 * `browse`-запросом, а у SoundCloud и то и другое — одна ссылка, за которой
 * половина треков приезжает одними идентификаторами. Разводить это по
 * компонентам значило бы четыре одинаковых `if` в четырёх местах.
 *
 * Исполнитель сюда не попадает: у него есть свой экран, и раскрывать его в
 * плоский список треков было бы хуже, чем открыть.
 */

import { SearchCollection, UnifiedTrack } from '../types/music';
import { artistService } from './artistService';
import { soundCloudService } from './soundcloud';
import { youtubeService } from './youtube';

/**
 * Треки подборки. Пустой список — «не отдали»: причину человек увидит как
 * отсутствие результата, а не как красную надпись.
 */
export async function collectionTracks(collection: SearchCollection): Promise<UnifiedTrack[]> {
  if (!collection || collection.kind === 'artist') return [];

  try {
    if (collection.source === 'soundcloud') {
      return await soundCloudService.getPlaylistTracks(collection.ref);
    }
    if (collection.kind === 'album') {
      // У альбома YouTube Music свой разбор: там есть номера треков и один
      // исполнитель на весь диск, и подставить его — работа `artistService`.
      return await artistService.getAlbumTracks(collection.ref, collection.subtitle || '');
    }
    return await youtubeService.getPlaylistTracks(collection.ref);
  } catch (err) {
    console.warn('[Collections] Не удалось раскрыть подборку:', err);
    return [];
  }
}

/** Название подборки, открытой по ссылке, пока настоящее не приехало. */
export const LINK_COLLECTION_TITLE = 'Плейлист по ссылке';

/**
 * Ссылка на чужой плейлист или альбом → подборка, которую можно открыть.
 *
 * Как в Spotify: вставил в поиск ссылку, которую прислал друг, — плейлист
 * открылся, его можно слушать и сохранить себе. Понимает плейлисты YouTube и
 * YouTube Music (`list=…`), альбомы YouTube Music (`browse/MPREb…`) и
 * плейлисты/альбомы SoundCloud (`soundcloud.com/<кто>/sets/<что>`).
 * Всё остальное — `null`: это обычный поисковый запрос.
 */
export function parseCollectionLink(text: string): SearchCollection | null {
  const raw = (text || '').trim();
  if (!/^https?:\/\//i.test(raw) && !/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be|soundcloud\.com)/i.test(raw)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, '').toLowerCase();

  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
    const album = /\/browse\/(MPREb_[\w-]+)/.exec(url.pathname);
    if (album) {
      return { id: `ytc_${album[1]}`, kind: 'album', source: 'youtube', ref: album[1], title: LINK_COLLECTION_TITLE, artworkUrl: '' };
    }
    const list = url.searchParams.get('list');
    // `RD…` — это «микс» самого YouTube, он собирается на лету и плейлистом не открывается.
    if (list && /^[\w-]{10,}$/.test(list) && !list.startsWith('RD')) {
      return { id: `ytc_${list}`, kind: 'playlist', source: 'youtube', ref: list, title: LINK_COLLECTION_TITLE, artworkUrl: '' };
    }
    return null;
  }

  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[1] === 'sets') {
      const clean = `https://soundcloud.com/${parts[0]}/sets/${parts[2]}`;
      return { id: `scu_${parts[0]}_${parts[2]}`, kind: 'playlist', source: 'soundcloud', ref: clean, title: LINK_COLLECTION_TITLE, artworkUrl: '' };
    }
  }
  return null;
}

/**
 * Треки подборки и, если она открыта по ссылке, её настоящее название.
 */
export async function collectionDetails(
  collection: SearchCollection
): Promise<{ title: string | null; tracks: UnifiedTrack[] }> {
  if (!collection || collection.title !== LINK_COLLECTION_TITLE || collection.kind === 'album') {
    return { title: null, tracks: await collectionTracks(collection) };
  }
  try {
    if (collection.source === 'soundcloud') return await soundCloudService.getPlaylistWithTitle(collection.ref);
    return await youtubeService.getPlaylistWithTitle(collection.ref);
  } catch (err) {
    console.warn('[Collections] Не удалось открыть плейлист по ссылке:', err);
    return { title: null, tracks: [] };
  }
}
