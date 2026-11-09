import { useSyncExternalStore } from 'react';
import { getQuality, subscribe, type TrackQuality } from '../services/trackQuality';

/** Что известно о качестве записи у источника; перерисовывается при новой пометке. */
export function useTrackQuality(trackId: string): TrackQuality | null {
  return useSyncExternalStore(
    subscribe,
    () => getQuality(trackId),
    () => null
  );
}
