import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  allTags,
  getNote,
  getVersion,
  hydrateTrackNotes,
  subscribe,
  tagsById,
  type TagCount,
  type TrackNoteRecord
} from '../services/trackNotes';

/*
 * Хуки над `trackNotes`: читают кэш синхронно и перерисовываются по подписке.
 * Каждый первым делом будит чтение базы — оно идемпотентно, так что сотня
 * строк списка стоит одного запроса.
 */

function useHydrated(): void {
  useEffect(() => {
    void hydrateTrackNotes();
  }, []);
}

/** Пометка трека — теги и заметка; `null`, пока пометки нет. */
export function useTrackNote(trackId: string): TrackNoteRecord | null {
  useHydrated();
  return useSyncExternalStore(
    subscribe,
    () => getNote(trackId),
    () => null
  );
}

const NO_TAGS: ReadonlyArray<string> = [];

/** Только теги трека — для бейджей на карточке. Пустой массив стабилен по ссылке. */
export function useTrackTags(trackId: string): ReadonlyArray<string> {
  const note = useTrackNote(trackId);
  return note?.tags ?? NO_TAGS;
}

/** Номер изменения кэша: снимки, которые надо пересчитывать, вешаются на него. */
function useNotesVersion(): number {
  useHydrated();
  return useSyncExternalStore(subscribe, getVersion, () => 0);
}

/** Все теги с частотой, по убыванию — подсказки при вводе и ряд чипов-фильтров. */
export function useAllTags(): TagCount[] {
  const version = useNotesVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => allTags(), [version]);
}

/** Теги по id трека — для фильтров и палитры, где треков много, а пометок мало. */
export function useTrackTagsIndex(): ReadonlyMap<string, ReadonlyArray<string>> {
  const version = useNotesVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => tagsById(), [version]);
}
