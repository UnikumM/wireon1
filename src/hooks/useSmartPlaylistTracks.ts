import { useEffect, useMemo, useState } from 'react';
import { getAllHistory, HistoryRecord } from '../services/db';
import { collectTrackFacts, evaluateSmartPlaylist, SmartPlaylist, SmartTrackFacts } from '../services/smartPlaylists';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSmartPlaylistStore } from '../store/useSmartPlaylistStore';

/**
 * Всё, что известно о треках на устройстве, — для проверки правил.
 *
 * История перечитывается, когда меняется её короткая копия в сторе медиатеки
 * (а она меняется с каждым включением): умный плейлист «недавно слушал»
 * обязан заметить только что сыгранную песню.
 */
export function useTrackFacts(): SmartTrackFacts[] | null {
  const favorites = useLibraryStore((s) => s.favorites);
  const playlists = useLibraryStore((s) => s.playlists);
  const recent = useLibraryStore((s) => s.history);
  const [history, setHistory] = useState<HistoryRecord[] | null>(null);

  useEffect(() => {
    void useSmartPlaylistStore.getState().hydrate();
  }, []);

  useEffect(() => {
    let alive = true;
    void getAllHistory()
      .catch(() => [] as HistoryRecord[])
      .then((rows) => {
        if (alive) setHistory(rows);
      });
    return () => {
      alive = false;
    };
  }, [recent]);

  return useMemo(() => {
    if (!history) return null;
    return collectTrackFacts({
      favorites,
      playlistTracks: playlists.flatMap((p) => p.tracks || []),
      history
    });
  }, [favorites, playlists, history]);
}

/** Треки одного умного плейлиста; `null` — ещё считаем. */
export function useSmartPlaylistTracks(playlist: SmartPlaylist | null | undefined) {
  const facts = useTrackFacts();
  return useMemo(
    () => (facts && playlist ? evaluateSmartPlaylist(playlist, facts, Date.now()) : null),
    [facts, playlist]
  );
}
