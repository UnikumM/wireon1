import { useEffect, useMemo, useState } from 'react';
import { getAllHistory, getDislikedTrackIds, getPlayEvents, HistoryRecord, PlayEventRecord } from '../services/db';
import { AutoMix, buildAutoMixes, DAYPART_WINDOW_MS } from '../services/autoMixes';
import { useLibraryStore } from '../store/useLibraryStore';

/** «Под это время» меняется с частью суток — пересчёт раз в четверть часа. */
const REFRESH_MS = 15 * 60 * 1000;

interface Loaded {
  history: HistoryRecord[];
  events: PlayEventRecord[];
  disliked: Set<string>;
}

/**
 * Авто-подборки для главной и «Для вас».
 *
 * Читает базу сама: экраны, которые её показывают, держат свою историю
 * усечённой (двести-пятьсот строк), а «Машине времени» нужна вся.
 */
export function useAutoMixes(): AutoMix[] {
  const favorites = useLibraryStore((s) => s.favorites);
  const playlists = useLibraryStore((s) => s.playlists);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const readAt = Date.now();
    void Promise.all([
      getAllHistory().catch(() => [] as HistoryRecord[]),
      getPlayEvents(readAt - DAYPART_WINDOW_MS).catch(() => [] as PlayEventRecord[]),
      getDislikedTrackIds().catch(() => new Set<string>())
    ]).then(([history, events, disliked]) => {
      if (alive) setLoaded({ history, events, disliked });
    });
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const library = useMemo(() => playlists.flatMap((playlist) => playlist.tracks || []), [playlists]);

  return useMemo(
    () =>
      loaded
        ? buildAutoMixes({
            history: loaded.history,
            events: loaded.events,
            dislikedIds: loaded.disliked,
            favorites,
            library,
            now
          })
        : [],
    [loaded, favorites, library, now]
  );
}
