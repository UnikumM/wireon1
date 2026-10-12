import { useEffect, useMemo, useState } from 'react';
import { getAllHistory, getDislikedTrackIds, getPlayEvents, HistoryRecord, PlayEventRecord } from '../services/db';
import { AutoMix, buildAutoMixes, DAYPART_WINDOW_MS } from '../services/autoMixes';
import { useLibraryStore } from '../store/useLibraryStore';
import { DISCOVER_WEEKLY_KEY, DiscoverWeekly, getDiscoverWeekly, weekKeyOf } from '../services/discoverWeekly';
import { getSetting } from '../services/db';

/**
 * Сборка «Открытий недели» ходит в сеть, поэтому не сразу: первые секунды
 * после открытия экрана принадлежат музыке, которую человек включает.
 */
const DISCOVER_BUILD_DELAY_MS = 8000;

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
  const [discover, setDiscover] = useState<DiscoverWeekly | null>(null);

  useEffect(() => {
    let alive = true;
    // Готовый список этой недели — сразу, из базы; собирать — только если нет.
    void getSetting<DiscoverWeekly | null>(DISCOVER_WEEKLY_KEY, null)
      .catch(() => null)
      .then((cached) => {
        if (!alive) return;
        if (cached && cached.weekKey === weekKeyOf(Date.now()) && cached.tracks?.length) setDiscover(cached);
      });
    const timer = setTimeout(() => {
      void getDiscoverWeekly().then((built) => {
        if (alive && built) setDiscover(built);
      });
    }, DISCOVER_BUILD_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

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

  return useMemo(() => {
    const local = loaded
      ? buildAutoMixes({
          history: loaded.history,
          events: loaded.events,
          dislikedIds: loaded.disliked,
          favorites,
          library,
          now
        })
      : [];
    if (!discover) return local;
    const weekly: AutoMix = {
      id: `auto_discover_${discover.weekKey}`,
      kind: 'discover',
      title: 'Открытия недели',
      subtitle: 'Новое для вас — обновляется по понедельникам',
      artworkUrl: discover.tracks.find((t) => t.artworkUrl)?.artworkUrl ?? '',
      tracks: discover.tracks
    };
    return [weekly, ...local];
  }, [loaded, favorites, library, now, discover]);
}
