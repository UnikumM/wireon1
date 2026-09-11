/**
 * Подписки на исполнителей (`src/services/subscriptions.ts`).
 *
 * Главное, что здесь охраняется: первая проверка после подписки не считает
 * новым ничего. Иначе в день подписки человек получил бы всю дискографию под
 * заголовком «новое у исполнителей» — и второй раз на эту кнопку не нажал бы.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  CHECK_INTERVAL_MS,
  checkNewReleases,
  getSubscriptions,
  isSubscribed,
  subscribe,
  toggleSubscription,
  unsubscribe
} from '../../src/services/subscriptions';
import { artistService, ArtistProfile } from '../../src/services/artistService';
import { clearAllData, db } from '../../src/services/db';

function profileWith(albums: { title: string; browseId: string }[]): ArtistProfile {
  return {
    name: 'Daft Punk',
    topTracks: [],
    albums: albums.map((album) => ({ id: album.browseId, ...album })),
    similarArtists: []
  } as ArtistProfile;
}

describe('подписки', () => {
  beforeEach(async () => {
    await clearAllData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('подписка находится по любому написанию имени', async () => {
    await subscribe('Daft Punk');

    // Ключ нормализованный — тот же, по которому считается вкус и память волны.
    expect(await isSubscribed('daft  punk')).toBe(true);
    expect(await isSubscribed('Daft-Punk')).toBe(true);
  });

  it('повторная подписка не заводит вторую запись', async () => {
    await subscribe('Daft Punk', { channelId: 'UC1' });
    await subscribe('daft punk');

    const all = await getSubscriptions();
    expect(all).toHaveLength(1);
    // Канал, узнанный в первый раз, вторым вызовом не теряется.
    expect(all[0].channelId).toBe('UC1');
  });

  it('переключатель работает в обе стороны', async () => {
    expect(await toggleSubscription('Daft Punk')).toBe(true);
    expect(await toggleSubscription('Daft Punk')).toBe(false);
    expect(await isSubscribed('Daft Punk')).toBe(false);
  });

  it('первая проверка ничего не считает новым, вторая — считает', async () => {
    const spy = vi
      .spyOn(artistService, 'getArtistProfile')
      .mockResolvedValue(profileWith([{ title: 'Discovery', browseId: 'MPREb_disc' }]));

    await subscribe('Daft Punk');
    const first = await checkNewReleases();
    expect(first).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);

    // Вышел новый альбом, и с прошлой проверки прошло больше срока.
    spy.mockResolvedValue(
      profileWith([
        { title: 'Discovery', browseId: 'MPREb_disc' },
        { title: 'Random Access Memories', browseId: 'MPREb_ram' }
      ])
    );
    const second = await checkNewReleases(Date.now() + CHECK_INTERVAL_MS + 1);

    expect(second).toHaveLength(1);
    expect(second[0].album.title).toBe('Random Access Memories');
  });

  it('один и тот же релиз не показывается дважды', async () => {
    vi.spyOn(artistService, 'getArtistProfile').mockResolvedValue(
      profileWith([{ title: 'Discovery', browseId: 'MPREb_disc' }])
    );
    await subscribe('Daft Punk');
    await checkNewReleases();

    // Сразу после первой проверки: альбом уже отмечен виденным.
    const again = await checkNewReleases(Date.now() + CHECK_INTERVAL_MS + 1);
    expect(again).toEqual([]);
  });

  it('раньше срока в сеть не ходим', async () => {
    const spy = vi
      .spyOn(artistService, 'getArtistProfile')
      .mockResolvedValue(profileWith([]));

    await subscribe('Daft Punk');
    await checkNewReleases();
    await checkNewReleases();

    // Второй заход сразу после первого — это открытие главной второй раз за
    // минуту, и будить сеть ради того же ответа незачем.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('отписка убирает запись', async () => {
    await subscribe('Daft Punk');
    await unsubscribe('Daft Punk');

    expect(await db.subscriptions.count()).toBe(0);
  });
});
