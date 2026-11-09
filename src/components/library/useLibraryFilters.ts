import { useEffect, useMemo, useState } from 'react';
import { getAllHistory } from '../../services/db';
import { offlineStorage } from '../../services/offlineStorage';
import { useLibraryStore } from '../../store/useLibraryStore';
import {
  EMPTY_FILTERS,
  applyFilters,
  hasActiveFilters,
  LibraryFilters,
  FilterContext
} from '../../services/libraryFilters';
import { useTrackTagsIndex } from '../../hooks/useTrackNote';
import type { UnifiedTrack } from '../../types/music';

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * Id треков, лежащих офлайн, — живой набор.
 *
 * Хранилище само сообщает о каждом скачивании и удалении, поэтому список не
 * нужно перечитывать по таймеру: чип «только офлайн» меняется, как только
 * файл появился на устройстве.
 */
export function useOfflineIds(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  useEffect(() => {
    let alive = true;
    const read = () => {
      offlineStorage
        .getOfflineTracks()
        .then((rows) => {
          if (alive) setIds(new Set(rows.map((record) => record.track?.id ?? record.id)));
        })
        .catch(() => {
          if (alive) setIds(EMPTY_IDS);
        });
    };
    read();
    const unsubscribe = offlineStorage.subscribe(read);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return ids;
}

const EMPTY_PLAYED: ReadonlyMap<string, number> = new Map();

/**
 * Последнее включение каждого трека — из полной истории в базе.
 *
 * Короткая копия истории в сторе хранит только треки, без дат; перечитываем
 * базу, когда эта копия меняется, то есть после каждого включения — иначе
 * «давно не слушал» продолжал бы показывать только что сыгранную песню.
 */
export function useLastPlayedById(): ReadonlyMap<string, number> {
  const recent = useLibraryStore((s) => s.history);
  const [map, setMap] = useState<ReadonlyMap<string, number>>(EMPTY_PLAYED);
  useEffect(() => {
    let alive = true;
    void getAllHistory()
      .then((rows) => {
        if (!alive) return;
        const next = new Map<string, number>();
        for (const row of rows) {
          if (!row?.id || !row.playedAt) continue;
          // Запись без прослушиваний — только пометка о пропуске; это не «слушал».
          if (!(row.playCount > 0)) continue;
          next.set(row.id, Math.max(next.get(row.id) ?? 0, row.playedAt));
        }
        setMap(next);
      })
      .catch(() => {
        if (alive) setMap(EMPTY_PLAYED);
      });
    return () => {
      alive = false;
    };
  }, [recent]);
  return map;
}

export interface LibraryFiltersState {
  filters: LibraryFilters;
  setFilters: (next: LibraryFilters) => void;
  reset: () => void;
  active: boolean;
  /** Применить набор к списку. `allowStale: false` игнорирует чип «давно не слушал». */
  apply: (tracks: ReadonlyArray<UnifiedTrack>, options?: { allowStale?: boolean }) => UnifiedTrack[];
}

/** Состояние чипов и всё, что нужно, чтобы их посчитать. Одно на экран медиатеки. */
export function useLibraryFilters(): LibraryFiltersState {
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS);
  const offlineIds = useOfflineIds();
  const lastPlayedById = useLastPlayedById();
  // Свои теги треков — живой снимок из `trackNotes`, меняется вместе с пометками.
  const tagsById = useTrackTagsIndex();

  return useMemo(() => {
    const ctx: FilterContext = { lastPlayedById, offlineIds, tagsById, now: Date.now() };
    return {
      filters,
      setFilters,
      reset: () => setFilters(EMPTY_FILTERS),
      active: hasActiveFilters(filters),
      apply: (tracks, options) => {
        // На «Недавних» давность бессмысленна — там всё только что играло.
        const effective = options?.allowStale === false ? { ...filters, stale: false } : filters;
        return applyFilters(tracks, effective, ctx);
      }
    };
  }, [filters, lastPlayedById, offlineIds, tagsById]);
}
