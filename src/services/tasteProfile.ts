/**
 * Общий словарь вкуса: ключ артиста, пороги зачёта и жанровые слова.
 *
 * Здесь нет ни одного сетевого вызова и ни одного похода в базу — только
 * разбор строк и числа. Файл лежит ниже всех по зависимостям именно поэтому:
 * ключ артиста нужен и подбору, и памяти волны, и поиску похожих, и если бы
 * каждый считал его сам, ключи бы разъехались. Однажды они и разъехались.
 *
 * Раньше здесь же жил целый второй движок подбора — `buildTasteProfile` и всё
 * вокруг него, около трёхсот пятидесяти строк, которые не вызывались ниоткуда.
 * Он удалён: работающий подбор живёт в `recommendationEngine`.
 */

import { UnifiedTrack } from '../types/music';

/** Нормализация имени артиста: регистр, пунктуация и лишние пробелы не значат ничего. */
export function normalizeArtistKey(artist: string | null | undefined): string {
  return (artist || '')
    .toLowerCase()
    // Диакритика и «залго» — украшение буквы, а не разделитель: сняв их
    // пробелом, мы получили бы «h e l l o» вместо «hello».
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ранний пропуск — самый сильный отрицательный сигнал, какой вообще можно снять
 * без слов. Тридцать секунд — граница, на которой сходятся исследования
 * потоковых сессий: выключил до неё — значит не подошло, а не «не то
 * настроение».
 */
export const EARLY_SKIP_SECONDS = 30;

/**
 * Доля трека, после которой прослушивание считается зачтённым.
 *
 * Дослушивать до конца никто не обязан: последние секунды — это затухание,
 * аутро и тишина, и уход на 92% ничем не отличается от полного прослушивания.
 */
export const COMPLETION_RATIO = 0.85;

/**
 * Жанровые и стилевые слова, которые действительно встречаются в названиях
 * треков и именах каналов на YouTube и SoundCloud.
 *
 * Свободные токены из названий брать нельзя: там «official», «video», «feat»,
 * «prod» и номера частей, то есть шум, который перетянул бы на себя весь вес.
 * Поэтому список закрытый — зато каждое попадание в него что-то значит.
 */
export const GENRE_TOKENS: readonly string[] = [
  'rock', 'metal', 'punk', 'hardcore', 'grunge', 'emo', 'shoegaze', 'postrock', 'industrial',
  'jazz', 'blues', 'funk', 'soul', 'rnb', 'disco', 'gospel',
  'hiphop', 'rap', 'trap', 'drill', 'phonk', 'boombap', 'grime',
  'house', 'techno', 'trance', 'dnb', 'dubstep', 'edm', 'electro', 'garage', 'breakbeat',
  'ambient', 'lofi', 'chillhop', 'downtempo', 'synthwave', 'vaporwave', 'darkwave', 'idm',
  'pop', 'kpop', 'jpop', 'indie', 'folk', 'country', 'americana', 'bluegrass',
  'classical', 'piano', 'orchestral', 'opera', 'soundtrack', 'ost', 'score',
  'reggae', 'ska', 'dancehall', 'afrobeat', 'latin', 'salsa', 'bossa', 'flamenco',
  'рок', 'метал', 'панк', 'рэп', 'поп', 'шансон', 'джаз', 'блюз', 'электроника', 'классика'
];

const GENRE_TOKEN_SET = new Set(GENRE_TOKENS);

/**
 * Слова, которые пишутся по-разному, а значат одно. Без этого «hip hop»,
 * «hip-hop» и «hiphop» были бы тремя разными жанрами с третью веса каждый.
 */
const TOKEN_ALIASES: Record<string, string> = {
  'hip': 'hiphop',
  'hop': 'hiphop',
  'hip hop': 'hiphop',
  'lo': 'lofi',
  'fi': 'lofi',
  'lo fi': 'lofi',
  'drum': 'dnb',
  'bass': 'dnb',
  'drum and bass': 'dnb',
  'r&b': 'rnb',
  'randb': 'rnb',
  'k': 'kpop',
  'post': 'postrock',
  'boom': 'boombap',
  'bap': 'boombap',
  'хип': 'hiphop',
  'хоп': 'hiphop',
  'металл': 'метал'
};

/** Стилевые слова из названия и имени артиста. Пустой набор — норма, а не сбой. */
export function extractGenreTokens(track: Pick<UnifiedTrack, 'title' | 'artist'>): string[] {
  const haystack = `${track?.title || ''} ${track?.artist || ''}`.toLowerCase();
  // Дефисы и амперсанды склеивают слова, поэтому сначала разрезаем по ним.
  const words = haystack.split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
  const found = new Set<string>();

  for (const word of words) {
    const alias = TOKEN_ALIASES[word];
    const token = alias || word;
    if (GENRE_TOKEN_SET.has(token)) found.add(token);
  }

  // Составные написания ловим по подстроке: «hip-hop» уже распалось на слова, а
  // «hiphop» одним куском мог и не попасть в список выше.
  for (const compound of ['hip hop', 'lo fi', 'drum and bass', 'post rock', 'boom bap']) {
    if (haystack.includes(compound)) {
      const canonical = TOKEN_ALIASES[compound];
      if (canonical) found.add(canonical);
    }
  }

  return Array.from(found);
}
