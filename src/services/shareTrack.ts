/**
 * «Поделиться треком» — ссылка на песню, которую можно отправить другу.
 *
 * С 4.0 ссылка ведёт на страницу своего сервера (`/t/yt/<id>?n=…&a=…&img=…`):
 * в мессенджере она раскрывается карточкой с обложкой, а на самой странице
 * есть «Открыть в Wireon» (`wireon://track/...`) и ссылка на источник. Если
 * сервер не настроен — как раньше, ссылка на сам источник: она открывается у
 * любого. На телефоне — системный лист «Поделиться», на ПК — буфер обмена.
 */

import { UnifiedTrack } from '../types/music';
import { detectPlatform, resolveServerConfig } from './nativeBridge';

const SOURCE_KEY = { youtube: 'yt', soundcloud: 'sc' } as const;

export type ShareOutcome = 'shared' | 'copied' | 'failed';

/** Ссылка на трек у источника; `null` — давать нечего. */
export function trackSourceUrl(track: UnifiedTrack): string | null {
  if (!track) return null;
  if (track.sourceUrl && /^https?:\/\//.test(track.sourceUrl)) return track.sourceUrl;
  if (track.source === 'youtube' && track.originalId) {
    return `https://music.youtube.com/watch?v=${encodeURIComponent(track.originalId)}`;
  }
  return null;
}

/**
 * Страница трека на своём сервере. Сведения едут в самой ссылке: у сервера
 * нет каталога, и так карточка в мессенджере рисуется без единого запроса к
 * YouTube. `null` — сервер не настроен или id не годится для адреса.
 */
export function trackSharePageUrl(track: UnifiedTrack, baseUrl?: string | null): string | null {
  if (!track?.originalId || !/^[\w-]{1,64}$/.test(track.originalId)) return null;
  const key = SOURCE_KEY[track.source as keyof typeof SOURCE_KEY];
  if (!key) return null;
  const base = baseUrl ?? resolveServerConfig()?.baseUrl;
  if (!base) return null;
  const url = new URL(`${base.replace(/\/+$/, '')}/t/${key}/${track.originalId}`);
  if (track.title) url.searchParams.set('n', track.title.slice(0, 160));
  if (track.artist) url.searchParams.set('a', track.artist.slice(0, 160));
  if (track.artworkUrl && /^https:\/\//.test(track.artworkUrl)) url.searchParams.set('img', track.artworkUrl.slice(0, 600));
  const origin = trackSourceUrl(track);
  if (origin && track.source === 'soundcloud') url.searchParams.set('u', origin);
  return url.toString();
}

/** Что отправлять другу: страница сервера, а без сервера — источник. */
export function trackShareUrl(track: UnifiedTrack): string | null {
  if (!track) return null;
  return trackSharePageUrl(track) ?? trackSourceUrl(track);
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
