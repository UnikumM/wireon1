/**
 * Обложка для сохранённого трека — в максимальном качестве и на устройстве.
 *
 * Сохранённый трек играл без сети, а его обложка оставалась адресом в
 * интернете: в самолёте вместо неё был серый квадрат, а дома — та же мелкая
 * картинка, что в списке. Теперь вместе со звуком сохраняется сама картинка,
 * лучшая из тех, что отдаёт источник.
 *
 * Обложка — украшение: ни один сбой здесь не должен мешать сохранить звук.
 */

import { artworkCandidates } from '../utils/artworkUrl';

/** Целевой размер: верхняя ступень, крупнее источники всё равно не отдают по этим адресам. */
const MAX_ARTWORK_PX = 1200;

/** Предел на файл: обложка в пару мегабайт — это уже не обложка, а чья-то ошибка. */
const MAX_ARTWORK_BYTES = 3 * 1024 * 1024;

/**
 * Меньше этого — заглушка, а не кадр: серая картинка 120×90, которую YouTube
 * отдаёт вместо отсутствующего крупного кадра, весит около килобайта.
 */
const MIN_ARTWORK_BYTES = 2 * 1024;

const FETCH_TIMEOUT_MS = 12_000;

/**
 * Забирает лучшую доступную обложку. `null` — не вышло ни с одним вариантом.
 * Идёт по кандидатам от крупного к гарантированному и берёт первый настоящий.
 */
export async function fetchBestArtwork(
  url: string | null | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<Blob | null> {
  const candidates = artworkCandidates(url, MAX_ARTWORK_PX).filter((candidate) => /^https?:\/\//i.test(candidate));

  for (let index = 0; index < candidates.length; index++) {
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      const response = await fetchImpl(candidates[index], controller ? { signal: controller.signal } : undefined);
      if (!response.ok) continue;
      const blob = await response.blob();
      if (blob.size > MAX_ARTWORK_BYTES) continue;
      // Последнему кандидату (исходному адресу) верим и маленькому: мелкая
      // обложка лучше никакой. У остальных малый вес — признак заглушки.
      const isLast = index === candidates.length - 1;
      if (blob.size < MIN_ARTWORK_BYTES && !isLast) continue;
      if (blob.size === 0) continue;
      if (blob.type && !blob.type.startsWith('image/')) continue;
      return blob;
    } catch {
      // Сеть, CORS, истёкший срок — пробуем следующий вариант.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return null;
}
