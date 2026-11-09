import type { UnifiedTrack } from '../types/music';
import { getWaveformUrl } from './soundcloud';

/**
 * Волновая дорожка трека — форма громкости для таймлайна плеера.
 *
 * Строится только там, где источник её отдаёт сам: SoundCloud вместе с треком
 * присылает `waveform_url`, за которым лежит JSON `{ width, height, samples }`
 * с парой тысяч отсчётов. YouTube ничего подобного не отдаёт, а считать форму
 * из самого звука — значит качать весь файл заранее; поэтому для остальных
 * источников здесь честный null, и таймлайн остаётся ровной полоской.
 *
 * Любая ошибка — сети, формата, хранилища — тоже null: волна украшение, а не
 * условие воспроизведения, и падать из-за неё плеер не должен.
 */

/** Сколько столбиков рисует таймлайн: достаточно для формы, мало для DOM. */
export const WAVEFORM_BARS = 120;

/** Ключ в localStorage: `wireon_waveform_<id трека>`. */
export const WAVEFORM_STORAGE_PREFIX = 'wireon_waveform_';

/** Порядок записей в хранилище — старые впереди, они вытесняются первыми. */
export const WAVEFORM_INDEX_KEY = 'wireon_waveform_index';

/** Потолок записей в localStorage: 200 × ~600 байт — заметно меньше мегабайта. */
export const WAVEFORM_STORAGE_LIMIT = 200;

/** Волна — не условие воспроизведения, поэтому ждать её долго незачем. */
const FETCH_TIMEOUT_MS = 8000;

/** Готовые формы по id трека — чтобы повторный показ не ходил даже в хранилище. */
const memory = new Map<string, number[]>();

/** Текущие загрузки по id трека — смена трека туда-обратно не плодит запросов. */
const inflight = new Map<string, Promise<number[] | null>>();

/**
 * Сжимает произвольный ряд отсчётов до `bars` корзин со значениями 0..1.
 *
 * Среднее по корзине, а не максимум: максимум превращает любой щелчок в
 * столбик во всю высоту, и форма становится гребёнкой. Нормировка по самой
 * громкой корзине — тихий трек всё равно должен заполнять высоту дорожки,
 * иначе у него волны почти не видно.
 *
 * Возвращает null, если отсчётов нет, они не числа или все нули: рисовать
 * тогда нечего, и лучше ровная полоска, чем ряд одинаковых точек.
 */
export function normalizeSamples(samples: unknown, bars: number = WAVEFORM_BARS): number[] | null {
  if (!Array.isArray(samples) || samples.length === 0 || bars <= 0) return null;

  const values: number[] = [];
  for (const raw of samples) {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) return null;
    values.push(Math.max(0, value));
  }

  const count = values.length;
  const binned: number[] = new Array(bars);
  for (let i = 0; i < bars; i += 1) {
    const start = Math.floor((i * count) / bars);
    // Корзина не бывает пустой: когда отсчётов меньше, чем столбиков, соседние
    // столбики делят один отсчёт, и форма просто становится ступенчатой.
    const end = Math.max(start + 1, Math.floor(((i + 1) * count) / bars));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += values[j];
    binned[i] = sum / (end - start);
  }

  const peak = Math.max(...binned);
  if (!(peak > 0)) return null;

  // Три знака: глазом разница не видна, а в хранилище запись втрое короче.
  return binned.map((value) => Math.round((value / peak) * 1000) / 1000);
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Доступ к localStorage сам бросает в приватных окнах и при запрете cookies.
    return null;
  }
}

function readIndex(store: Storage): string[] {
  try {
    const parsed = JSON.parse(store.getItem(WAVEFORM_INDEX_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function readStored(trackId: string): number[] | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(WAVEFORM_STORAGE_PREFIX + trackId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(trackId: string, bars: number[]): void {
  const store = storage();
  if (!store) return;
  try {
    const index = readIndex(store).filter((id) => id !== trackId);
    index.push(trackId);
    // Вытесняем самые старые записи, пока не уложимся в потолок.
    while (index.length > WAVEFORM_STORAGE_LIMIT) {
      const oldest = index.shift();
      if (oldest) store.removeItem(WAVEFORM_STORAGE_PREFIX + oldest);
    }
    store.setItem(WAVEFORM_STORAGE_PREFIX + trackId, JSON.stringify(bars));
    store.setItem(WAVEFORM_INDEX_KEY, JSON.stringify(index));
  } catch {
    // Переполнение квоты или запрет записи — волна просто не переживёт перезапуск.
  }
}

/**
 * Адрес JSON с отсчётами. api-v2 в `waveform_url` чаще отдаёт картинку
 * `…_m.png`; JSON лежит по тому же адресу с другим расширением.
 */
export function waveformJsonUrl(url: string): string {
  return url.replace(/\.png(\?.*)?$/i, '.json$1');
}

/**
 * Форма, которая уже есть под рукой — в памяти или в localStorage — без сети.
 * Нужна таймлайну, чтобы при возврате к треку не мигать ровной полоской,
 * пока асинхронная загрузка не разрешится.
 */
export function peekWaveform(track: Pick<UnifiedTrack, 'id' | 'source'> | null | undefined): number[] | null {
  if (!track || track.source !== 'soundcloud') return null;
  const cached = memory.get(track.id);
  if (cached) return cached;
  const stored = readStored(track.id);
  if (stored) memory.set(track.id, stored);
  return stored;
}

async function fetchWaveform(url: string): Promise<number[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(waveformJsonUrl(url), { signal: controller.signal });
    if (!response.ok) return null;
    const json = await response.json();
    return normalizeSamples(json?.samples);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Волна трека в 120 столбиках 0..1 или null, если её негде взять.
 * Никогда не бросает.
 */
export async function getWaveform(
  track: Pick<UnifiedTrack, 'id' | 'source' | 'originalId'> | null | undefined
): Promise<number[] | null> {
  if (!track || track.source !== 'soundcloud') return null;

  const ready = peekWaveform(track);
  if (ready) return ready;

  const url = getWaveformUrl(track.originalId);
  if (!url) return null;

  const pending = inflight.get(track.id);
  if (pending) return pending;

  const request = fetchWaveform(url)
    .then((bars) => {
      if (bars) {
        memory.set(track.id, bars);
        writeStored(track.id, bars);
      }
      return bars;
    })
    .finally(() => inflight.delete(track.id));

  inflight.set(track.id, request);
  return request;
}

/** Для тестов: забыть всё, что лежит в памяти (хранилище не трогает). */
export function resetWaveformMemory(): void {
  memory.clear();
  inflight.clear();
}
