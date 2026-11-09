import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getWaveform,
  normalizeSamples,
  peekWaveform,
  resetWaveformMemory,
  waveformJsonUrl,
  WAVEFORM_BARS,
  WAVEFORM_INDEX_KEY,
  WAVEFORM_STORAGE_LIMIT,
  WAVEFORM_STORAGE_PREFIX
} from '../../src/services/waveform';
import { getWaveformUrl, rememberWaveformUrl, SoundCloudService } from '../../src/services/soundcloud';
import type { UnifiedTrack } from '../../src/types/music';

const scTrack = (id: string): UnifiedTrack => ({
  id: `sc_${id}`,
  source: 'soundcloud',
  originalId: id,
  title: 'Трек',
  artist: 'Автор',
  duration: 200,
  artworkUrl: ''
});

const ytTrack: UnifiedTrack = {
  id: 'yt_abc',
  source: 'youtube',
  originalId: 'abc',
  title: 'Ролик',
  artist: 'Канал',
  duration: 200,
  artworkUrl: ''
};

/** Ответ wave.sndcdn.com: сколько угодно отсчётов, нам важна только форма. */
const jsonResponse = (samples: unknown, ok = true) =>
  ({
    ok,
    json: async () => ({ width: 1800, height: 140, samples })
  }) as unknown as Response;

describe('normalizeSamples — сжатие до столбиков', () => {
  it('сводит длинный ряд к 120 корзинам со средним и нормирует по пику', () => {
    // 1200 отсчётов, по десять одинаковых на корзину: корзина i = i.
    const samples = Array.from({ length: 1200 }, (_, index) => Math.floor(index / 10));
    const bars = normalizeSamples(samples);

    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(WAVEFORM_BARS);
    expect(bars![0]).toBe(0);
    expect(bars![119]).toBe(1);
    expect(bars![60]).toBeCloseTo(60 / 119, 2);
  });

  it('усредняет, а не берёт максимум: один щелчок не делает столбик во всю высоту', () => {
    const samples = new Array(1200).fill(10);
    samples[5] = 1000; // щелчок в первой корзине
    const bars = normalizeSamples(samples)!;

    // Первая корзина: (9·10 + 1000)/10 = 109 → это пик; остальные 10/109.
    expect(bars[0]).toBe(1);
    expect(bars[1]).toBeCloseTo(10 / 109, 3);
  });

  it('отсчётов меньше, чем столбиков — форма всё равно из 120 ступеней', () => {
    const bars = normalizeSamples([1, 2, 3, 4, 5, 6, 7]);

    expect(bars).toHaveLength(WAVEFORM_BARS);
    expect(Math.max(...bars!)).toBe(1);
    expect(bars!.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('пустой ряд, мусор и тишина — null, а не ряд одинаковых точек', () => {
    expect(normalizeSamples([])).toBeNull();
    expect(normalizeSamples(undefined)).toBeNull();
    expect(normalizeSamples('samples')).toBeNull();
    expect(normalizeSamples([1, 'x', 3])).toBeNull();
    expect(normalizeSamples([0, 0, 0, 0])).toBeNull();
  });

  it('адрес картинки _m.png превращается в адрес JSON', () => {
    expect(waveformJsonUrl('https://wave.sndcdn.com/abc_m.png')).toBe('https://wave.sndcdn.com/abc_m.json');
    expect(waveformJsonUrl('https://wave.sndcdn.com/abc_m.json')).toBe('https://wave.sndcdn.com/abc_m.json');
  });
});

describe('getWaveform — откуда берётся форма', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    localStorage.clear();
    resetWaveformMemory();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('YouTube — null без похода в сеть', async () => {
    await expect(getWaveform(ytTrack)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SoundCloud без известного адреса волны — null без похода в сеть', async () => {
    await expect(getWaveform(scTrack('unknown'))).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('нормализатор SoundCloud запоминает waveform_url рядом с треком', () => {
    const service = new SoundCloudService();
    const tracks = service.parseTracksResponse([
      {
        id: 777001,
        title: 'С волной',
        duration: 200000,
        user: { username: 'Кто-то' },
        waveform_url: 'https://wave.sndcdn.com/w777_m.png'
      }
    ]);

    expect(tracks[0].id).toBe('sc_777001');
    expect(getWaveformUrl('777001')).toBe('https://wave.sndcdn.com/w777_m.png');
    expect(getWaveformUrl('777002')).toBeNull();
  });

  it('качает JSON, отдаёт 120 столбиков и кладёт в localStorage', async () => {
    rememberWaveformUrl('100', 'https://wave.sndcdn.com/w100_m.png');
    fetchMock.mockResolvedValue(jsonResponse(Array.from({ length: 600 }, (_, i) => (i % 50) + 1)));

    const bars = await getWaveform(scTrack('100'));

    expect(bars).toHaveLength(WAVEFORM_BARS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://wave.sndcdn.com/w100_m.json');
    expect(JSON.parse(localStorage.getItem(`${WAVEFORM_STORAGE_PREFIX}sc_100`)!)).toEqual(bars);
    expect(JSON.parse(localStorage.getItem(WAVEFORM_INDEX_KEY)!)).toEqual(['sc_100']);
  });

  it('повторный запрос берёт из памяти, после перезапуска — из хранилища', async () => {
    rememberWaveformUrl('101', 'https://wave.sndcdn.com/w101_m.png');
    fetchMock.mockResolvedValue(jsonResponse([1, 2, 3, 4, 5, 6, 7, 8]));

    const first = await getWaveform(scTrack('101'));
    const second = await getWaveform(scTrack('101'));
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // «Перезапуск»: память пуста, localStorage на месте.
    resetWaveformMemory();
    expect(peekWaveform(scTrack('101'))).toEqual(first);
    await expect(getWaveform(scTrack('101'))).resolves.toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('две одновременные загрузки одного трека — один запрос', async () => {
    rememberWaveformUrl('102', 'https://wave.sndcdn.com/w102_m.png');
    fetchMock.mockResolvedValue(jsonResponse([3, 2, 1]));

    const [a, b] = await Promise.all([getWaveform(scTrack('102')), getWaveform(scTrack('102'))]);

    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ошибка сети, плохой статус и мусор в ответе — null, без исключений', async () => {
    rememberWaveformUrl('103', 'https://wave.sndcdn.com/w103_m.png');

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(getWaveform(scTrack('103'))).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse([1, 2, 3], false));
    await expect(getWaveform(scTrack('103'))).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError('bad json');
      }
    } as unknown as Response);
    await expect(getWaveform(scTrack('103'))).resolves.toBeNull();

    // Неудача не запоминается: следующая попытка снова идёт в сеть.
    fetchMock.mockResolvedValueOnce(jsonResponse([1, 2, 3]));
    await expect(getWaveform(scTrack('103'))).resolves.toHaveLength(WAVEFORM_BARS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('хранилище не растёт больше 200 записей — старые вытесняются', async () => {
    fetchMock.mockResolvedValue(jsonResponse([1, 2, 3, 4]));

    const total = WAVEFORM_STORAGE_LIMIT + 1;
    for (let i = 0; i < total; i += 1) {
      rememberWaveformUrl(`e${i}`, `https://wave.sndcdn.com/e${i}_m.png`);
      await getWaveform(scTrack(`e${i}`));
    }

    const index: string[] = JSON.parse(localStorage.getItem(WAVEFORM_INDEX_KEY)!);
    expect(index).toHaveLength(WAVEFORM_STORAGE_LIMIT);
    expect(index[0]).toBe('sc_e1');
    expect(localStorage.getItem(`${WAVEFORM_STORAGE_PREFIX}sc_e0`)).toBeNull();
    expect(localStorage.getItem(`${WAVEFORM_STORAGE_PREFIX}sc_e${total - 1}`)).not.toBeNull();
  });

  it('сломанное хранилище не мешает: читается как пусто, пишется молча', async () => {
    localStorage.setItem(`${WAVEFORM_STORAGE_PREFIX}sc_104`, '{not json');
    rememberWaveformUrl('104', 'https://wave.sndcdn.com/w104_m.png');
    fetchMock.mockResolvedValue(jsonResponse([5, 5, 1]));

    await expect(getWaveform(scTrack('104'))).resolves.toHaveLength(WAVEFORM_BARS);

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    resetWaveformMemory();
    localStorage.clear();
    try {
      await expect(getWaveform(scTrack('104'))).resolves.toHaveLength(WAVEFORM_BARS);
    } finally {
      setItem.mockRestore();
    }
  });
});
