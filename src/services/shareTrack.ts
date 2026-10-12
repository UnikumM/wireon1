/**
 * «Поделиться треком» — ссылка на песню, которую можно отправить другу.
 *
 * Ссылка ведёт к источнику (YouTube, SoundCloud): у Wireon нет своих
 * публичных страниц треков, а ссылка на исходник открывается у любого. На
 * телефоне — системный лист «Поделиться», на компьютере — буфер обмена.
 */

import { UnifiedTrack } from '../types/music';
import { detectPlatform } from './nativeBridge';

export type ShareOutcome = 'shared' | 'copied' | 'failed';

/** Ссылка на трек у источника; `null` — давать нечего. */
export function trackShareUrl(track: UnifiedTrack): string | null {
  if (!track) return null;
  if (track.sourceUrl && /^https?:\/\//.test(track.sourceUrl)) return track.sourceUrl;
  if (track.source === 'youtube' && track.originalId) {
    return `https://music.youtube.com/watch?v=${encodeURIComponent(track.originalId)}`;
  }
  return null;
}

/** «Кино — Кукушка» + ссылка: так сообщение понятно и без превью. */
export function trackShareText(track: UnifiedTrack): string {
  const name = track.artist ? `${track.artist} — ${track.title}` : track.title;
  const url = trackShareUrl(track);
  return url ? `${name}\n${url}` : name;
}

async function copy(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Буфер бывает закрыт (окно без фокуса) — скажем об этом честно.
  }
  return false;
}

export async function shareTrack(track: UnifiedTrack): Promise<ShareOutcome> {
  if (!track) return 'failed';
  const text = trackShareText(track);
  const url = trackShareUrl(track) ?? undefined;

  if (detectPlatform() === 'mobile') {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: track.title, text, url, dialogTitle: 'Поделиться треком' });
      return 'shared';
    } catch {
      // Лист закрыли или его нет — тогда хотя бы в буфер.
    }
  }

  return (await copy(text)) ? 'copied' : 'failed';
}
