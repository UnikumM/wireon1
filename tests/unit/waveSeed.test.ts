import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { recommendationEngine } from '../../src/services/recommendationEngine';
import { audioEngine } from '../../src/services/audioEngine';
import { streamResolver } from '../../src/services/streamResolver';
import { resetPlayerStore } from '../helpers/testUtils';
import type { UnifiedTrack } from '../../src/types/music';
import type { WaveConfig } from '../../src/types/store';

/**
 * Доходит ли Поток до настоящего радио.
 *
 * Ради чего эти проверки появились. Владелец сообщил, что «подбор похожих песен
 * и в потоке, и в поиске не работает». Мост оказался ни при чём — сервер отдаёт
 * радио и на ПК, и на телефоне. Ломалось на три строки раньше:
 *
 *   `waveSeedKind` по умолчанию `'library'`, а семя брали только при `'track'`,
 *   поэтому `config.seedTrack` был пуст, условие в `recommendationEngine`
 *   (`if (config.seedTrack && config.seedTrack.originalId)`) не выполнялось ни
 *   разу, и `getRelatedVideos` не вызывался **вообще никогда**. Весь Поток
 *   собирался поиском по ключевым словам вида «lofi hip hop focus study».
 *
 * Почему это дожило до релиза при 2200 зелёных тестах: в
 * `recommendationEngine.test.ts` все пять проверок радио передают `seedTrack` в
 * конфиг **руками**. Они доказывали, что радио работает, когда семя дали, — а
 * приложение его не давало. Здесь проверяется именно стык: что стор семя
 * передаёт.
 */

const seedTrack: UnifiedTrack = {
  id: 'yt_seed',
  source: 'youtube',
  originalId: 'seed123',
  title: 'Ghosts of the Late Night Radio Tower',
  artist: 'The Midnight Cassette Orchestra',
  duration: 240,
  artworkUrl: 'https://example.com/seed.jpg'
};

const related: UnifiedTrack = {
  id: 'yt_related',
  source: 'youtube',
  originalId: 'rel456',
  title: 'Signal Drift',
  artist: 'The Midnight Cassette Orchestra',
  duration: 220,
  artworkUrl: 'https://example.com/rel.jpg'
};

/** Конфиги, с которыми стор позвал движок за рекомендациями. */
let seenConfigs: WaveConfig[];

beforeEach(() => {
  resetPlayerStore();
  seenConfigs = [];
  vi.spyOn(recommendationEngine, 'getRecommendationsForWave').mockImplementation(
    async (config: WaveConfig) => {
      seenConfigs.push(config);
      return [related];
    }
  );
  /*
   * Играть по-настоящему здесь нечем и незачем: проверяется, что уходит в
   * движок, а не то, что зазвучало. Без этих заглушек стор идёт добывать ссылку
   * на первый трек по сети — и тест начинает зависеть от YouTube.
   */
  vi.spyOn(streamResolver, 'resolve').mockResolvedValue({
    streamUrl: 'https://example.test/audio.m4a',
    format: 'm4a',
    bitrate: 128,
    expiresAt: Date.now() + 3_600_000
  } as never);
  vi.spyOn(streamResolver, 'prefetch').mockImplementation(() => {});
  vi.spyOn(audioEngine, 'load').mockResolvedValue();
  vi.spyOn(audioEngine, 'play').mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPlayerStore();
});

describe('Поток: семя доходит до радио', () => {
  it('при настройках по умолчанию Поток отталкивается от играющей песни', async () => {
    // Ровно тот случай, который был сломан: источник `library` (значение по
    // умолчанию), играет песня — и радио обязано получить её как семя.
    usePlayerStore.setState({ currentTrack: seedTrack, waveSeedKind: 'library' });

    await usePlayerStore.getState().startMyWave();

    // Вызовов может быть два: за первым треком и упреждающее пополнение,
    // которое срабатывает сразу, как только очередь начала играть. Проверяется
    // первый — тот, с которого Поток начинается.
    expect(seenConfigs.length).toBeGreaterThan(0);
    expect(seenConfigs[0].seedTrack?.originalId).toBe('seed123');
  });

  it('«от этой песни» тоже отдаёт семя', async () => {
    usePlayerStore.setState({ currentTrack: seedTrack, waveSeedKind: 'track' });

    await usePlayerStore.getState().startMyWave();

    expect(seenConfigs[0].seedTrack?.originalId).toBe('seed123');
  });

  it('«Открытия» семени не получают: их просят про незнакомое', async () => {
    // Радио от текущей песни увело бы этот источник ровно туда, откуда его и
    // просили увести.
    usePlayerStore.setState({ currentTrack: seedTrack, waveSeedKind: 'discovery' });

    await usePlayerStore.getState().startMyWave();

    expect(seenConfigs[0].seedTrack).toBeUndefined();
  });

  it('«Забытое» семени не получает: оно берётся из собственной истории', async () => {
    usePlayerStore.setState({ currentTrack: seedTrack, waveSeedKind: 'forgotten' });

    await usePlayerStore.getState().startMyWave();

    expect(seenConfigs[0].seedTrack).toBeUndefined();
  });

  it('без играющей песни Поток запускается и не падает', async () => {
    // Пустое семя — не повод оставлять человека без Потока: движок в этом
    // случае честно уходит в поиск по профилю.
    usePlayerStore.setState({ currentTrack: null, waveSeedKind: 'library' });

    await usePlayerStore.getState().startMyWave();

    expect(seenConfigs.length).toBeGreaterThan(0);
    expect(seenConfigs[0].seedTrack).toBeUndefined();
  });
});

describe('Поток: несколько очагов вкуса, а не один', () => {
  /*
   * Ради чего. Радио от одной песни даёт связный, но узкий поток: он час
   * крутится вокруг того, с чего начали. Большие сервисы строят «микс дня» от
   * нескольких очагов сразу — недавнее, любимые артисты, соседи по
   * прослушиваниям — и сплетают ответы. Считать похожесть самим нечем и
   * незачем: радио YouTube Music уже посчитано на их масштабе, наша работа —
   * выбрать, от чего его просить.
   */

  /** Даёт движку избранное и историю, из которых он и наберёт очаги. */
  async function seedLibrary(): Promise<void> {
    /*
     * Общий `beforeEach` подменяет сам `getRecommendationsForWave` — там это
     * нужно, чтобы читать конфиг, с которым его позвали. Здесь проверяется его
     * внутренность, поэтому подмену надо снять, иначе вызов уйдёт в заглушку.
     */
    vi.restoreAllMocks();
    const db = await import('../../src/services/db');
    vi.spyOn(db, 'getFavorites').mockResolvedValue([
      { ...seedTrack, id: 'yt_fav', originalId: 'fav1', artist: 'Другой Артист' }
    ] as never);
    vi.spyOn(db, 'getHistory').mockResolvedValue([
      { id: 'yt_hist', track: { ...seedTrack, id: 'yt_hist', originalId: 'hist1', artist: 'Третий' } }
    ] as never);
  }

  it('«из библиотеки» спрашивает радио у нескольких треков', async () => {
    await seedLibrary();
    const { recommendationEngine } = await import('../../src/services/recommendationEngine');
    const { youtubeService } = await import('../../src/services/youtube');

    const asked: string[] = [];
    vi.spyOn(youtubeService, 'getRelatedVideos').mockImplementation(async (id: string) => {
      asked.push(id);
      return [];
    });
    // Профиль строится из той же базы; артисты должны быть «слушаемыми».
    vi.spyOn(recommendationEngine, 'buildUserProfile' as never).mockResolvedValue({
      artistAffinities: new Map(),
      topArtists: ['Другой Артист', 'Третий'],
      dislikedTrackIds: new Set(),
      recentTrackIds: new Set(),
      favoriteTrackIds: new Set(),
      totalPlays: 10,
      artistPlayCounts: new Map([
        ['другой артист', 3],
        ['третий', 2]
      ]),
      artistFavoriteCounts: new Map(),
      artistPlaylistCounts: new Map()
    } as never);

    await recommendationEngine.getRecommendationsForWave(
      { mood: 'favorite', seedTrack, seedKind: 'library', novelty: 0.5 },
      20
    );

    expect(asked.length).toBeGreaterThan(1);
    expect(asked[0]).toBe('seed123');
  });

  it('«от этой песни» остаётся радио ровно одной песни', async () => {
    await seedLibrary();
    const { recommendationEngine } = await import('../../src/services/recommendationEngine');
    const { youtubeService } = await import('../../src/services/youtube');

    const asked: string[] = [];
    vi.spyOn(youtubeService, 'getRelatedVideos').mockImplementation(async (id: string) => {
      asked.push(id);
      return [];
    });

    await recommendationEngine.getRecommendationsForWave(
      { mood: 'favorite', seedTrack, seedKind: 'track' },
      20
    );

    expect(asked).toEqual(['seed123']);
  });
});

describe('Поток: пополнение не теряет семя', () => {
  it('цепляется за играющую песню, даже если Поток запускали в тишине', async () => {
    /*
     * Здесь была вторая половина поломки. Ветка `my_wave` в
     * `replenishAutoplayQueue` брала голый `activeSeedTrack`, тогда как соседняя
     * ветка `track_radio` имела три запасных семени. Если Поток запустили, когда
     * ничего не играло, `activeSeedTrack` оставался `null` навсегда: каждое
     * пополнение прогоняло одни и те же запросы по словам с растущим списком
     * исключений, находило всё меньше — и очередь высыхала до «Поток закончился».
     */
    usePlayerStore.setState({
      queueMode: 'my_wave',
      autoplayRadio: true,
      waveSeedKind: 'library',
      activeSeedTrack: null,
      currentTrack: seedTrack,
      sourceQueue: [seedTrack],
      userQueue: [],
      currentIndex: 0,
      history: []
    });

    await usePlayerStore.getState().replenishAutoplayQueue();

    expect(seenConfigs.length).toBeGreaterThan(0);
    expect(seenConfigs[0].seedTrack?.originalId).toBe('seed123');
  });

  it('пополнение «Открытий» семени по-прежнему не получает', async () => {
    usePlayerStore.setState({
      queueMode: 'my_wave',
      autoplayRadio: true,
      waveSeedKind: 'discovery',
      activeSeedTrack: null,
      currentTrack: seedTrack,
      sourceQueue: [seedTrack],
      userQueue: [],
      currentIndex: 0,
      history: []
    });

    await usePlayerStore.getState().replenishAutoplayQueue();

    expect(seenConfigs[0].seedTrack).toBeUndefined();
  });
});
