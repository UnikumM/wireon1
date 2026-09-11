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
