/**
 * Чарты и новинки.
 *
 * Ни того ни другого в приложении не было: единственным способом что-то найти
 * был поиск по названию, то есть надо было заранее знать, что ищешь. Здесь
 * берутся готовые страницы YouTube Music — те же, что видит любой её
 * посетитель, — и раскладываются полками.
 *
 * Своего подсчёта популярности нет и не планируется: у нас нет ни аудитории, по
 * которой её считать, ни права называть выдумку чартом.
 */

import { SearchCollection } from '../types/music';
import { youtubeService } from './youtube';

/** Готовая страница YouTube Music. Строки непрозрачные, поэтому названы здесь. */
const BROWSE_CHARTS = 'FEmusic_charts';
const BROWSE_NEW_RELEASES = 'FEmusic_new_releases';

/** Полка: заголовок от источника и её содержимое. */
export interface DiscoverShelf {
  title: string;
  items: SearchCollection[];
}

/** Сколько живёт ответ. Чарты обновляются раз в сутки, чаще спрашивать нечего. */
const CACHE_TTL_MS = 60 * 60 * 1000;

const cache = new Map<string, { at: number; shelves: DiscoverShelf[] }>();

/** Только для тестов: забыть закэшированные страницы. */
export function resetDiscoverCache(): void {
  cache.clear();
}

async function browseCached(browseId: string, now: number): Promise<DiscoverShelf[]> {
  const hit = cache.get(browseId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.shelves;

  const shelves = await youtubeService.browseShelves(browseId);
  // Пустой ответ не кэшируем: это почти всегда отказ сети, а не «чартов нет»,
  // и запомнить его на час значило бы показывать пустоту до перезапуска.
  if (shelves.length > 0) cache.set(browseId, { at: now, shelves });
  return shelves;
}

/** Чарты: топ исполнителей и хит-парады площадки. */
export function getCharts(now: number = Date.now()): Promise<DiscoverShelf[]> {
  return browseCached(BROWSE_CHARTS, now);
}

/** Новинки: альбомы, синглы и клипы этой недели. */
export function getNewReleases(now: number = Date.now()): Promise<DiscoverShelf[]> {
  return browseCached(BROWSE_NEW_RELEASES, now);
}
