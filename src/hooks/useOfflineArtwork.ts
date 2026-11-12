import { useEffect, useState } from 'react';
import { offlineStorage } from '../services/offlineStorage';

/**
 * Адрес сохранённой обложки трека (object URL) или `null`.
 *
 * У сохранённого трека обложка лежит на устройстве в лучшем качестве
 * (`offlineArtwork.ts`): она и чётче сетевой, и видна без интернета. Адрес
 * живёт, пока смонтирован компонент, и отзывается при смене трека.
 */
export function useOfflineArtwork(trackId: string | null | undefined, enabled: boolean = true): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    if (!trackId || !enabled) return;
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;

    let alive = true;
    let created: string | null = null;
    void offlineStorage
      .getOfflineTrack(trackId)
      .then((record) => {
        if (!alive || !record?.artwork || record.artwork.size === 0) return;
        created = URL.createObjectURL(record.artwork);
        setUrl(created);
      })
      .catch(() => undefined);

    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [trackId, enabled]);

  return url;
}
