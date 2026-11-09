import { streamResolver } from './streamResolver';
import { audioEngine } from './audioEngine';
import { isHlsUrl } from './hls';
import { usePlayerStore } from '../store/usePlayerStore';
import type { UnifiedTrack } from '../types/music';

/**
 * Превью трека по наведению: десять секунд с середины записи, не трогая того,
 * что играет сейчас.
 *
 * Отдельный `HTMLAudioElement`, а не `audioEngine`: у движка две деки, очередь,
 * кроссфейд, эквалайзер и трекер прослушиваний — превью ничего из этого не
 * нужно, а попытка «на минутку» подменить текущий трек сломала бы историю,
 * позицию и Discord RPC. Основной плеер продолжает играть, только на время
 * превью приглушается до {@link PREVIEW_DUCK_RATIO}.
 *
 * Как приглушаем. У движка нет публичного множителя, зато есть
 * `fadeVolumeTo(target, ms)`: он берёт цель в абсолютной громкости, делит на
 * текущую `volume` и плавно ведёт внутренний `fadeMultiplier` к этому
 * отношению, саму `volume` не трогая. Поэтому «приглушить» — это
 * `fadeVolumeTo(volume × 0.25)`, а «вернуть» — `fadeVolumeTo(volume)`, то есть
 * множитель 1. Если человек за это время сам крутанул громкость,
 * `setVolume` уже сбросил множитель в 1 (`cancelVolumeFade`), и наш возврат
 * к множителю 1 ничего не перетирает. При нулевой громкости не приглушаем
 * вовсе: `fadeVolumeTo(0)` оставил бы множитель в нуле навсегда.
 */
export const PREVIEW_DWELL_MS = 600;
export const PREVIEW_LENGTH_MS = 10_000;
/** Начинаем не с тишины вступления, а там, где трек уже «разошёлся». */
export const PREVIEW_START_RATIO = 0.4;
/** Длительность неизвестна (0 или NaN) — берём полминуты. */
export const PREVIEW_FALLBACK_START_SEC = 30;
export const PREVIEW_VOLUME = 0.6;
export const PREVIEW_DUCK_RATIO = 0.25;
export const PREVIEW_DUCK_MS = 250;
const PREVIEW_TICK_MS = 100;

export type PreviewStatus = 'idle' | 'pending' | 'loading' | 'playing';

export interface PreviewState {
  trackId: string | null;
  status: PreviewStatus;
  /** 0…1 — доля прошедших десяти секунд, для кольца над обложкой. */
  progress: number;
}

type Listener = (state: PreviewState) => void;

const IDLE: PreviewState = { trackId: null, status: 'idle', progress: 0 };

export class PreviewPlayer {
  private state: PreviewState = IDLE;
  private listeners = new Set<Listener>();
  private audio: HTMLAudioElement | null = null;
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  /** Растёт при каждом запросе и отмене: ответ от старого резолва игнорируем. */
  private token = 0;
  private ducked = false;

  getState = (): PreviewState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Курсор встал на обложку. Сам поток грузится только через
   * {@link PREVIEW_DWELL_MS}: пролёт курсора по списку не должен запускать
   * разбор ссылки за несколько секунд процессорного времени каждый.
   * Возвращает, принят ли запрос.
   */
  request(track: UnifiedTrack | null | undefined): boolean {
    if (!track?.id) return false;
    // То, что уже звучит в основном плеере, подсматривать незачем.
    if (usePlayerStore.getState().currentTrack?.id === track.id) return false;
    if (this.state.trackId === track.id && this.state.status !== 'idle') return true;

    this.stop();
    const token = ++this.token;
    this.setState({ trackId: track.id, status: 'pending', progress: 0 });
    this.dwellTimer = setTimeout(() => {
      this.dwellTimer = null;
      void this.begin(track, token);
    }, PREVIEW_DWELL_MS);
    return true;
  }

  /**
   * Курсор ушёл. С `trackId` — остановить, только если превью именно этого
   * трека: уход с одной обложки не должен гасить превью, уже запрошенное на
   * соседней.
   */
  cancel(trackId?: string): void {
    if (trackId !== undefined && this.state.trackId !== trackId) return;
    this.stop();
  }

  /** Для тестов: забыть всё, включая созданный элемент. */
  resetForTests(): void {
    this.stop();
    this.audio = null;
  }

  private async begin(track: UnifiedTrack, token: number): Promise<void> {
    this.setState({ trackId: track.id, status: 'loading', progress: 0 });

    let url: string;
    try {
      // Тем же путём, что и основной плеер; `prefetch` — чтобы не отбирать
      // очередь у трека, которого человек ждёт по щелчку.
      const info = await streamResolver.resolve(track, false, 'prefetch');
      url = info.streamUrl;
    } catch {
      // Любая ошибка резолва — тихо: превью необязательно, тост здесь был бы шумом.
      if (token === this.token) this.stop();
      return;
    }
    if (token !== this.token) return;
    // HLS в `<audio>` без hls.js не играет (Chromium/Electron); для подсказки
    // поднимать второй экземпляр hls.js не стоит — просто молчим.
    if (!url || isHlsUrl(url)) {
      this.stop();
      return;
    }

    const audio = this.ensureAudio();
    audio.volume = PREVIEW_VOLUME;
    audio.src = url;
    const start = Number.isFinite(track.duration) && track.duration > 0
      ? track.duration * PREVIEW_START_RATIO
      : PREVIEW_FALLBACK_START_SEC;
    try {
      // До загрузки метаданных браузер запоминает позицию как стартовую и
      // применяет её сам, когда узнает длительность.
      audio.currentTime = start;
    } catch {
      // Некоторые окружения не дают перемотать до метаданных — тогда с начала.
    }

    try {
      await audio.play();
    } catch {
      if (token === this.token) this.stop();
      return;
    }
    if (token !== this.token) {
      audio.pause();
      return;
    }

    this.startedAt = Date.now();
    this.duckMain();
    this.setState({ trackId: track.id, status: 'playing', progress: 0 });
    this.stopTimer = setTimeout(() => this.stop(), PREVIEW_LENGTH_MS);
    this.tickTimer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - this.startedAt) / PREVIEW_LENGTH_MS);
      this.setState({ ...this.state, progress });
    }, PREVIEW_TICK_MS);
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      const audio = new Audio();
      audio.preload = 'auto';
      // Поток оборвался или не подошёл — превью просто заканчивается.
      audio.addEventListener('error', () => this.stop());
      audio.addEventListener('ended', () => this.stop());
      this.audio = audio;
    }
    return this.audio;
  }

  private duckMain(): void {
    const { isPlaying } = usePlayerStore.getState();
    const volume = audioEngine.getVolume();
    if (!isPlaying || volume <= 0) return;
    this.ducked = true;
    void audioEngine.fadeVolumeTo(volume * PREVIEW_DUCK_RATIO, PREVIEW_DUCK_MS);
  }

  private restoreMain(): void {
    if (!this.ducked) return;
    this.ducked = false;
    const volume = audioEngine.getVolume();
    if (volume <= 0) return;
    // Цель равна текущей громкости — это множитель 1, то есть «как было».
    void audioEngine.fadeVolumeTo(volume, PREVIEW_DUCK_MS);
  }

  private stop(): void {
    this.token++;
    if (this.dwellTimer) {
      clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.audio) {
      this.audio.pause();
      // Снять `src` и перезагрузить — единственный способ оборвать докачку потока.
      if (this.audio.getAttribute('src')) {
        this.audio.removeAttribute('src');
        try {
          this.audio.load();
        } catch {
          // Пустой элемент перезагружать нечем — это не ошибка.
        }
      }
    }
    this.restoreMain();
    if (this.state !== IDLE) this.setState(IDLE);
  }

  private setState(next: PreviewState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

export const previewPlayer = new PreviewPlayer();
