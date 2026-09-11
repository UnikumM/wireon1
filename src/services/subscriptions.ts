/**
 * Подписки на исполнителей и новинки у них.
 *
 * Чего здесь нет намеренно: обхода по расписанию в фоне. Проверка запускается,
 * когда человек открывает главную, и не чаще раза в шесть часов на исполнителя
 * — у нас нет ни push, ни сервера уведомлений, а будить сеть ради списка,
 * который никто сейчас не смотрит, незачем.
 *
 * Первая проверка после подписки нарочно не считает новым ничего: она только
 * запоминает, что у исполнителя уже вышло. Иначе в день подписки человек
 * получил бы всю дискографию под заголовком «новое».
 */

import { db, SubscriptionRecord } from './db';
import { normalizeArtistKey } from './tasteProfile';
import { artistService, ArtistAlbum } from './artistService';

/** Не чаще этого ходим за новинками одного исполнителя. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Сколько исполнителей обходим за один заход. */
const CHECK_BATCH = 5;

/** Релиз, которого человек ещё не видел. */
export interface NewRelease {
  artist: string;
  album: ArtistAlbum;
}

/** Подписан ли. */
export async function isSubscribed(artist: string): Promise<boolean> {
  const key = normalizeArtistKey(artist);
  if (!key) return false;
  try {
    return (await db.subscriptions.get(key)) !== undefined;
  } catch (err) {
    console.error('[Subscriptions] get error:', err);
    return false;
  }
}

/** Все подписки, свежие сверху. */
export async function getSubscriptions(): Promise<SubscriptionRecord[]> {
  try {
    return await db.subscriptions.orderBy('subscribedAt').reverse().toArray();
  } catch (err) {
    console.error('[Subscriptions] list error:', err);
    return [];
  }
}

/**
 * Подписаться. Повторный вызов ничего не портит: запись перезаписывается тем
 * же ключом, а отметки о виденном сохраняются.
 */
export async function subscribe(
  artist: string,
  extra: { avatarUrl?: string; channelId?: string } = {}
): Promise<void> {
  const name = (artist || '').trim();
  const key = normalizeArtistKey(name);
  if (!key) return;

  try {
    const existing = await db.subscriptions.get(key);
    await db.subscriptions.put({
      ...existing,
      key,
      name,
      avatarUrl: extra.avatarUrl ?? existing?.avatarUrl,
      channelId: extra.channelId ?? existing?.channelId,
      subscribedAt: existing?.subscribedAt ?? Date.now()
    });
  } catch (err) {
    console.error('[Subscriptions] subscribe error:', err);
  }
}

/** Отписаться. */
export async function unsubscribe(artist: string): Promise<void> {
  const key = normalizeArtistKey(artist);
  if (!key) return;
  try {
    await db.subscriptions.delete(key);
  } catch (err) {
    console.error('[Subscriptions] unsubscribe error:', err);
  }
}

/** Переключает подписку и возвращает новое состояние. */
export async function toggleSubscription(
  artist: string,
  extra: { avatarUrl?: string; channelId?: string } = {}
): Promise<boolean> {
  if (await isSubscribed(artist)) {
    await unsubscribe(artist);
    return false;
  }
  await subscribe(artist, extra);
  return true;
}

/** Ключ релиза: `browseId`, если он есть, иначе название с годом. */
function releaseId(album: ArtistAlbum): string {
  return album.browseId || `${album.title}::${album.year || ''}`;
}

/**
 * Новинки у тех, на кого подписаны.
 *
 * Обходит по нескольку исполнителей за раз и только тех, кого давно не
 * проверяли: у каждого профиля свой поход в сеть, и опрашивать два десятка
 * подписок разом означало бы двадцать запросов на открытие главной.
 */
export async function checkNewReleases(now: number = Date.now()): Promise<NewRelease[]> {
  const all = await getSubscriptions();
  const due = all
    .filter((record) => !record.checkedAt || now - record.checkedAt >= CHECK_INTERVAL_MS)
    .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0))
    .slice(0, CHECK_BATCH);

  const found: NewRelease[] = [];

  for (const record of due) {
    try {
      const profile = await artistService.getArtistProfile(record.name);
      const albums = profile.albums || [];
      const seen = new Set(record.seenReleaseIds || []);
      // Первая проверка: только запоминаем. См. пояснение в шапке файла.
      const firstLook = !record.checkedAt;

      if (!firstLook) {
        for (const album of albums) {
          if (!seen.has(releaseId(album))) found.push({ artist: record.name, album });
        }
      }

      await db.subscriptions.put({
        ...record,
        checkedAt: now,
        avatarUrl: record.avatarUrl || profile.avatarUrl,
        channelId: record.channelId || profile.channelId,
        // Кольцо на сотню: дискографии длиннее не бывает, а расти записи в базе
        // без предела не должны.
        seenReleaseIds: Array.from(new Set([...seen, ...albums.map(releaseId)])).slice(-100)
      });
    } catch (err) {
      console.warn(`[Subscriptions] Не удалось проверить «${record.name}»:`, err);
    }
  }

  return found;
}
