import { useCallback, useEffect, useState } from 'react';
import { offlineStorage } from '../../../services/offlineStorage';

/**
 * Лежит ли трек в офлайн-кэше.
 *
 * Offline mode caches what gets played, so the card only reports the fact —
 * there is no per-track download to drive from here any more. Подписка на
 * хранилище нужна, чтобы отметка появилась сразу, как трек доиграл до кэша.
 */
export function useTrackOffline(trackId: string | undefined): boolean {
  const [isDownloaded, setIsDownloaded] = useState(false);

  const checkOffline = useCallback(async () => {
    if (!trackId) return;
    try {
      setIsDownloaded(await offlineStorage.isDownloaded(trackId));
    } catch {
      // ignore
    }
  }, [trackId]);

  useEffect(() => {
    void checkOffline();
    const unsubscribe = offlineStorage.subscribe(() => {
      void checkOffline();
    });
    return () => {
      unsubscribe();
    };
  }, [checkOffline]);

  return isDownloaded;
}
