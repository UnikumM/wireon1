import { create } from 'zustand';
import { UnifiedTrack, RepeatMode, EqSettings } from '../types/music';
import { VisualizerPreset } from '../types/visualizer';
import { PlayerStore, PlayerStoreState, QueueMode, WaveMood, WaveConfig, WaveSeedKind } from '../types/store';
import { audioEngine, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE } from '../services/audioEngine';
import { MediaSessionService } from '../services/mediaSession';
import { streamResolver } from '../services/streamResolver';
import { describePlaybackError } from '../services/playbackErrors';
import { searchAggregator } from '../services/aggregator';
import { recommendationEngine, deriveWaveMood, clampAxis } from '../services/recommendationEngine';
import { offlineMode } from '../services/offlineMode';
import * as dbService from '../services/db';
import { useLibraryStore } from './useLibraryStore';
import { useUIStore } from './useUIStore';

const HISTORY_LIMIT = 99;
const SLEEP_FADE_MS = 5000;
const RADIO_BATCH_SIZE = 10;
/**
 * Сколько треков вперёд заранее греем.
 *
 * Три, а не один: yt-dlp на холодную тратит секунды, и подряд нажатое «дальше»
 * упиралось в это ожидание каждый раз. Больше трёх смысла мало — до них человек
 * чаще всего не доходит, а очередь фоновых задач в главном процессе не резиновая.
 */
const PREFETCH_DEPTH = 3;
const FALLBACK_UNMUTE_VOLUME = 0.5;
const EQ_LIMIT_DB = 12;

/** Keys used for `db.setSetting` / `db.getSetting` persistence. */
export const PLAYER_SETTING_KEYS = {
  volume: 'volume',
  isMuted: 'isMuted',
  repeatMode: 'repeatMode',
  isShuffled: 'isShuffled',
  visualizerEnabled: 'visualizerEnabled',
  visualizerPreset: 'visualizerPreset',
  autoplayRadio: 'autoplayRadio',
  eq: 'eq',
  mediaKeysEnabled: 'mediaKeysEnabled',
  crossfadeEnabled: 'crossfadeEnabled',
  crossfadeDuration: 'crossfadeDuration',
  loudnessNormalization: 'loudnessNormalization',
  playbackRate: 'playbackRate',
  preservePitch: 'preservePitch',
  waveNovelty: 'waveNovelty',
  waveEnergy: 'waveEnergy',
  waveSeedKind: 'waveSeedKind',
  waveSeedArtist: 'waveSeedArtist'
} as const;

const WAVE_SEED_KINDS: WaveSeedKind[] = [
  'library',
  'discovery',
  'artist',
  'forgotten',
  'track'
];

const VISUALIZER_PRESETS: VisualizerPreset[] = [
  'CYBER_BARS',
  'HOLOGRAPHIC_WAVE',
  'CIRCULAR_SPECTRUM',
  'AMBIENT_AURORA'
];

const REPEAT_MODES: RepeatMode[] = ['off', 'all', 'one'];

/** Clears all three error fields together; forgetting one leaves stale copy on screen. */
const NO_ERROR = { error: null, errorDetail: null, errorCanRetry: true } as const;

/**
 * The store keeps user-facing copy in `error` and the thrown message in
 * `errorDetail`: the player bar shows the first and offers the second as its
 * tooltip, so a listener reads a sentence while a bug report still carries the
 * transcoding, status code and video id.
 */
function errorPatch(err: unknown, source?: string) {
  const described = describePlaybackError(err, source);
  return {
    error: described.message,
    errorDetail: described.detail,
    errorCanRetry: described.canRetry
  };
}

/**
 * Собирает конфиг волны из текущего состояния. Раньше каждое место складывало
 * его руками, и пополнение очереди теряло регуляторы — волна начиналась одной,
 * а продолжалась другой.
 */
/**
 * Какую песню отдать радио как семя при данном источнике Потока.
 *
 * Здесь жила поломка, из-за которой «подбор похожего не работает». Семя брали
 * только при `seedKind === 'track'`, а по умолчанию стоит `'library'` — значит
 * при обычном запуске `config.seedTrack` был пуст, условие
 * `if (config.seedTrack && config.seedTrack.originalId)` в
 * `recommendationEngine` не выполнялось ни разу, и `getRelatedVideos` **не
 * вызывался вовсе**. Поток целиком собирался поиском по ключевым словам вида
 * «lofi hip hop focus study» — отсюда и «играет что попало».
 *
 * Почему не «всегда семя». Двум источникам семя противопоказано по смыслу:
 * «Открытия» просят незнакомое, «Забытое» — своё же давнее, и радио от текущей
 * песни увело бы оба туда, откуда их и просили увести. «От артиста» ведёт
 * `seedArtist`, и песня там лишняя.
 *
 * Остаются «от этой песни» и «из библиотеки» — то есть режим по умолчанию.
 * Движок при этом сам решает, хватило ли радио: `seedRadioIsEnough` пускает
 * поиск по словам только в добор, а не вместо.
 */
function pickWaveSeed(seedKind: WaveSeedKind, candidate: UnifiedTrack | null): UnifiedTrack | null {
  if (seedKind === 'discovery' || seedKind === 'forgotten' || seedKind === 'artist') return null;
  return candidate;
}

function buildWaveConfig(state: PlayerStoreState, seedTrack?: UnifiedTrack | null): WaveConfig {
  return {
    mood: state.activeWaveMood,
    genre: state.activeWaveGenre || undefined,
    seedTrack: seedTrack || undefined,
    novelty: state.waveNovelty,
    energy: state.waveEnergy,
    seedKind: state.waveSeedKind,
    seedArtist: state.waveSeedArtist || undefined
  };
}

let sleepTimerHandle: ReturnType<typeof setTimeout> | null = null;
let hydrationPromise: Promise<void> | null = null;
let replenishPromise: Promise<void> | null = null;
let radioFetchInFlight = false;
let crossfadeTransitionInFlight = false;

/**
 * Fisher-Yates non-destructive index shuffling
 */
export function generateShuffledIndices(length: number, firstIndex?: number): number[] {
  if (length <= 0) return [];
  const indices: number[] = [];

  for (let i = 0; i < length; i++) {
    if (firstIndex === undefined || i !== firstIndex) {
      indices.push(i);
    }
  }

  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  if (firstIndex !== undefined && firstIndex >= 0 && firstIndex < length) {
    return [firstIndex, ...indices];
  }
  return indices;
}

/** Persisting preferences must never surface as an error to the UI. */
function persistSetting(key: string, value: unknown): void {
  try {
    const result = dbService.setSetting(key, value);
    if (result && typeof result.catch === 'function') {
      result.catch((err: unknown) => {
        console.warn(`[usePlayerStore] Could not persist "${key}":`, err);
      });
    }
  } catch (err) {
    console.warn(`[usePlayerStore] Could not persist "${key}":`, err);
  }
}

/** Lets the desktop shell register/unregister its global media-key shortcuts. */
function forwardMediaKeysPreference(enabled: boolean): void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api || typeof api.setMediaKeysEnabled !== 'function') return;
  try {
    api.setMediaKeysEnabled(enabled);
  } catch (err) {
    console.warn('[usePlayerStore] Could not forward media key preference:', err);
  }
}

function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Keeps speed inside what the media element renders without artefacts. */
function clampPlaybackRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  // Rounded to 0.01 so the badge reads "0.85×" and not "0.8500000000000001×".
  const clamped = Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, value));
  return Math.round(clamped * 100) / 100;
}

function clampGainDb(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(-EQ_LIMIT_DB, Math.min(EQ_LIMIT_DB, value));
}

function normalizeEq(value: unknown, fallback: EqSettings): EqSettings {
  const partial = (value && typeof value === 'object' ? value : {}) as Partial<EqSettings>;
  return {
    bass: clampGainDb(partial.bass, fallback.bass),
    mid: clampGainDb(partial.mid, fallback.mid),
    treble: clampGainDb(partial.treble, fallback.treble)
  };
}

function finiteDuration(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function clearSleepTimerHandle(): void {
  if (sleepTimerHandle !== null) {
    clearTimeout(sleepTimerHandle);
    sleepTimerHandle = null;
  }
}

interface CommitTrackOptions {
  queue?: UnifiedTrack[];
  index?: number;
  shuffleOrder?: number[];
  userQueue?: UnifiedTrack[];
  history?: UnifiedTrack[];
  addToHistory?: boolean;
}

export const usePlayerStore = create<PlayerStore>((set, get) => {
  /**
   * Returns the tracks that would play next, in order, without mutating anything.
   *
   * Порядок ровно тот, по которому пойдёт `nextTrack`: сначала ручная очередь,
   * потом основная — с учётом перемешивания и зацикливания. Треки не повторяются:
   * дважды греть одну и ту же ссылку смысла нет.
   */
  const peekUpcomingTracks = (count: number): UnifiedTrack[] => {
    const state = get();
    const result: UnifiedTrack[] = [];
    if (count <= 0) return result;

    const seen = new Set<string>();
    // Играющий трек уже разобран — на repeat all он иначе попадёт в список
    // как «следующий» и займёт место настоящего следующего.
    if (state.currentTrack?.id) seen.add(state.currentTrack.id);
    const push = (track: UnifiedTrack | null | undefined): void => {
      if (!track || !track.id || seen.has(track.id)) return;
      seen.add(track.id);
      result.push(track);
    };

    for (const queued of state.userQueue) {
      push(queued);
      if (result.length >= count) return result;
    }

    const sourceLen = state.sourceQueue.length;
    if (sourceLen === 0) return result;
    const wraps = state.repeatMode === 'all';

    if (state.isShuffled && state.shuffleOrder.length > 0) {
      const order = state.shuffleOrder;
      const pos = order.indexOf(state.currentIndex);
      for (let step = 1; step <= order.length && result.length < count; step++) {
        const raw = pos + step;
        const inRange = pos !== -1 && raw < order.length;
        // За край выходим только на repeat all — иначе очередь просто кончилась.
        if (!inRange && !wraps) break;
        const at = inRange ? raw : ((raw % order.length) + order.length) % order.length;
        push(state.sourceQueue[order[at]]);
      }
      return result;
    }

    for (let step = 1; step <= sourceLen && result.length < count; step++) {
      const raw = state.currentIndex + step;
      const inRange = raw >= 0 && raw < sourceLen;
      if (!inRange && !wraps) break;
      push(state.sourceQueue[((raw % sourceLen) + sourceLen) % sourceLen]);
    }
    return result;
  };

  /**
   * Warms the stream URLs of the upcoming tracks so the next skip is instant.
   *
   * Греем несколько вперёд, а не один: люди листают очередь пачкой, и на втором
   * же «дальше» человек снова ждал бы yt-dlp. Расход ограничен не этим числом, а
   * лимитом процессов в главном процессе — фоновых там ровно два, остальные
   * ждут и уступают дорогу нажатию play.
   */
  const prefetchUpcoming = (): void => {
    if (!streamResolver || typeof streamResolver.prefetch !== 'function') return;
    for (const upcoming of peekUpcomingTracks(PREFETCH_DEPTH)) {
      try {
        streamResolver.prefetch(upcoming);
      } catch (err) {
        console.warn('[usePlayerStore] Prefetch of upcoming track failed:', err);
      }
    }
  };

  /**
   * The single path that starts a track: state patch -> MediaSession -> engine
   * load -> history write. The OS is only told "playing" once the stream is
   * actually running.
   */
  const commitTrack = async (track: UnifiedTrack, options: CommitTrackOptions = {}): Promise<void> => {
    if (!track) return;
    const addToHistory = options.addToHistory !== false;

    const patch: Partial<PlayerStoreState> = {
      currentTrack: track,
      currentTime: 0,
      duration: finiteDuration(track.duration),
      buffered: 0,
      playbackState: 'loading',
      isLoading: true,
      isPlaying: false,
      error: null,
      errorDetail: null,
      errorCanRetry: true,
      isPreviewStream: false
    };
    if (options.queue) patch.sourceQueue = options.queue;
    if (options.index !== undefined) patch.currentIndex = options.index;
    if (options.shuffleOrder) patch.shuffleOrder = options.shuffleOrder;
    if (options.userQueue) patch.userQueue = options.userQueue;
    if (options.history) patch.history = options.history;

    set(patch);

    MediaSessionService.updateMetadata(track);
    MediaSessionService.updatePlaybackState('loading');

    try {
      await audioEngine.load(track, true);

      set({
        playbackState: 'playing',
        isPlaying: true,
        isLoading: false,
        // Known only after resolution: SoundCloud hands back a 30-second snippet
        // for some uploads, and the bar has to label it.
        isPreviewStream: audioEngine.getCurrentTrack()?.isPreview === true,
        ...NO_ERROR
      });
      MediaSessionService.updatePlaybackState('playing');

      if (addToHistory) {
        useLibraryStore
          .getState()
          .addToHistory(track)
          .catch(() => {});
      }

      // Offline mode keeps a copy of whatever is actually listened to. A no-op
      // while the switch is off.
      offlineMode.noteListened(track);

      prefetchUpcoming();

      // Lookahead queue check for infinite wave/radio replenishment
      const currentState = get();
      const currentQueue = currentState.sourceQueue;
      const currIdx = currentState.currentIndex;
      const remaining = currentQueue.length - (currIdx >= 0 ? currIdx + 1 : 0);
      if (remaining <= 2 && (currentState.queueMode === 'track_radio' || currentState.queueMode === 'my_wave')) {
        void get().replenishAutoplayQueue();
      }
    } catch (err) {
      console.error('[usePlayerStore] Failed to start track:', err);
      set({
        playbackState: 'error',
        isLoading: false,
        isPlaying: false,
        ...errorPatch(err, track.source)
      });
      MediaSessionService.updatePlaybackState('error');
    }
  };

  /** Appends related tracks (autoplay radio). Returns true when playback continued. */
  const continueWithRelatedTracks = async (track: UnifiedTrack): Promise<boolean> => {
    if (radioFetchInFlight) return false;
    if (!searchAggregator || typeof searchAggregator.getRelatedTracks !== 'function') return false;

    radioFetchInFlight = true;
    try {
      const related = await searchAggregator.getRelatedTracks(track, RADIO_BATCH_SIZE);
      const state = get();
      const known = new Set<string>([
        track.id,
        ...state.sourceQueue.map((t) => t.id),
        ...state.userQueue.map((t) => t.id)
      ]);
      const additions = (Array.isArray(related) ? related : []).filter((t) => t && t.id && !known.has(t.id));
      if (additions.length === 0) return false;

      const base = state.sourceQueue.length;
      const nextQueue = [...state.sourceQueue, ...additions];
      const appendedOrder = generateShuffledIndices(additions.length, 0).map((i) => base + i);
      const nextHistory = [...state.history.slice(-HISTORY_LIMIT), track];

      await commitTrack(nextQueue[base], {
        queue: nextQueue,
        index: base,
        shuffleOrder: state.isShuffled ? [...state.shuffleOrder, ...appendedOrder] : undefined,
        history: nextHistory
      });
      return true;
    } catch (err) {
      console.warn('[usePlayerStore] Autoplay radio could not extend the queue:', err);
      return false;
    } finally {
      radioFetchInFlight = false;
    }
  };

  /** Queue exhausted: stop where we are instead of blanking the player. */
  const stopAtQueueEnd = (): void => {
    audioEngine.pause();

    if (!get().currentTrack) {
      haltPlayback();
      return;
    }

    audioEngine.seek(0);
    set({ playbackState: 'paused', isPlaying: false, isLoading: false, currentTime: 0 });
    MediaSessionService.updatePlaybackState('paused');
  };

  const applyMuted = (muted: boolean, restoreVolume?: number): void => {
    if (muted) {
      audioEngine.setMuted(true);
      set((s) => ({ isMuted: true, previousVolume: s.volume > 0 ? s.volume : s.previousVolume }));
    } else {
      const state = get();
      const candidate =
        restoreVolume !== undefined && restoreVolume > 0
          ? restoreVolume
          : state.volume > 0
            ? state.volume
            : state.previousVolume > 0
              ? state.previousVolume
              : FALLBACK_UNMUTE_VOLUME;
      const restored = clampVolume(candidate);
      audioEngine.setVolume(restored);
      audioEngine.setMuted(false);
      set({ isMuted: false, volume: restored, previousVolume: restored });
      persistSetting(PLAYER_SETTING_KEYS.volume, restored);
    }
    persistSetting(PLAYER_SETTING_KEYS.isMuted, muted);
  };

  const runSleepTimer = async (): Promise<void> => {
    try {
      await audioEngine.fadeVolumeTo(0, SLEEP_FADE_MS);
    } catch (err) {
      console.warn('[usePlayerStore] Sleep timer fade failed:', err);
    }
    get().pause();
    // Restores the pre-fade level (or whatever the user picked mid-fade)
    audioEngine.setVolume(get().volume);
    set({ sleepTimerEndsAt: null });
  };

  const setUserQueue = (userQueue: UnifiedTrack[]): void => {
    set({ userQueue });
  };

  const appendToUserQueue = (track: UnifiedTrack): void => {
    if (!track) return;
    set((s) => ({ userQueue: [...s.userQueue, track] }));
  };

  const emptyUserQueue = (): void => {
    setUserQueue([]);
  };

  return {
    // Playback state
    currentTrack: null,
    playbackState: 'idle',
    isPlaying: false,
    isLoading: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 0.8,
    isMuted: false,
    previousVolume: 0.8,
    repeatMode: 'off',
    isShuffled: false,
    error: null,
    errorDetail: null,
    errorCanRetry: true,
    isPreviewStream: false,

    // 2-tier Queue
    userQueue: [],
    sourceQueue: [],
    history: [],
    currentIndex: -1,
    shuffleOrder: [],

    // Wave & Queue Mode
    queueMode: 'sequential',
    activeWaveMood: 'favorite',
    activeWaveGenre: null,
    activeSeedTrack: null,
    isReplenishingQueue: false,
    // По умолчанию волна тянется к знакомому: на старте о вкусе известно мало,
    // и промах по знакомому треку раздражает меньше, чем поток из ничего.
    waveNovelty: 0.35,
    waveEnergy: 0.5,
    waveSeedKind: 'library',
    waveSeedArtist: null,

    // Visualizer state
    visualizerEnabled: true,
    visualizerPreset: 'CYBER_BARS',

    // Playback extras
    sleepTimerEndsAt: null,
    autoplayRadio: false,
    eq: { bass: 0, mid: 0, treble: 0 },
    crossfadeEnabled: false,
    crossfadeDuration: 3,
    loudnessNormalization: false,
    playbackRate: 1,
    preservePitch: false,
    mediaKeysEnabled: true,
    settingsHydrated: false,

    // Actions
    playTrack: async (track: UnifiedTrack, newSourceQueue?: UnifiedTrack[], index?: number) => {
      if (!track) return;

      const state = get();
      const nextSourceQueue = newSourceQueue || state.sourceQueue;
      let nextIndex = index !== undefined ? index : -1;
      if (nextIndex === -1) {
        nextIndex = nextSourceQueue.findIndex((t) => t.id === track.id);
      }

      const nextShuffleOrder = state.isShuffled
        ? generateShuffledIndices(nextSourceQueue.length, nextIndex >= 0 ? nextIndex : undefined)
        : undefined;

      const nextHistory =
        state.currentTrack && state.currentTrack.id !== track.id
          ? [...state.history.slice(-HISTORY_LIMIT), state.currentTrack]
          : undefined;

      await commitTrack(track, {
        queue: nextSourceQueue,
        index: nextIndex,
        shuffleOrder: nextShuffleOrder,
        history: nextHistory
      });
    },

    playTrackSingle: async (track: UnifiedTrack) => {
      if (!track) return;

      const state = get();
      const nextHistory =
        state.currentTrack && state.currentTrack.id !== track.id
          ? [...state.history.slice(-HISTORY_LIMIT), state.currentTrack]
          : undefined;

      await commitTrack(track, { history: nextHistory });
    },

    togglePlayPause: async () => {
      const state = get();
      if (state.playbackState === 'playing') {
        get().pause();
        return;
      }
      await get().play();
    },

    togglePlay: async () => {
      await get().togglePlayPause();
    },

    play: async () => {
      const state = get();

      if (state.currentTrack) {
        try {
          await audioEngine.play();
          set({ playbackState: 'playing', isPlaying: true, isLoading: false, ...NO_ERROR });
          MediaSessionService.updatePlaybackState('playing');
        } catch (err) {
          console.error('[usePlayerStore] play error:', err);
          set({
            playbackState: 'error',
            isPlaying: false,
            isLoading: false,
            ...errorPatch(err, state.currentTrack?.source)
          });
          MediaSessionService.updatePlaybackState('error');
        }
        return;
      }

      if (state.userQueue.length > 0) {
        const [next, ...rest] = state.userQueue;
        setUserQueue(rest);
        await commitTrack(next);
        return;
      }

      if (state.sourceQueue.length > 0) {
        const idx = state.currentIndex >= 0 ? state.currentIndex : 0;
        await get().playTrack(state.sourceQueue[idx], state.sourceQueue, idx);
      }
    },

    pause: () => {
      audioEngine.pause();
      set({ playbackState: 'paused', isPlaying: false, isLoading: false });
      MediaSessionService.updatePlaybackState('paused');
    },

    resume: async () => {
      await get().play();
    },

    nextTrack: async (isManualSkip: boolean = false) => {
      const state = get();

      // Record skip feedback on manual skip
      if (isManualSkip && state.currentTrack) {
        void recommendationEngine.recordFeedback(state.currentTrack, 'skip').catch(() => {});
      }

      // Repeat one only loops on natural track end, never on a manual skip
      if (state.repeatMode === 'one' && state.currentTrack && !isManualSkip) {
        audioEngine.seek(0);
        try {
          await audioEngine.play();
          set({ currentTime: 0, playbackState: 'playing', isPlaying: true, ...NO_ERROR });
          MediaSessionService.updatePlaybackState('playing');
        } catch (err) {
          console.error('[usePlayerStore] Repeat one play error:', err);
          set({
            playbackState: 'error',
            isLoading: false,
            isPlaying: false,
            ...errorPatch(err, state.currentTrack?.source)
          });
          MediaSessionService.updatePlaybackState('error');
        }
        return;
      }

      const nextHistory = state.currentTrack
        ? [...state.history.slice(-HISTORY_LIMIT), state.currentTrack]
        : undefined;

      // Priority 1: the user queue (Up Next)
      if (state.userQueue.length > 0) {
        const [next, ...rest] = state.userQueue;
        await commitTrack(next, { userQueue: rest, history: nextHistory });
        return;
      }

      // Priority 2: source queue progression
      const sourceLen = state.sourceQueue.length;
      if (sourceLen > 0) {
        if (state.isShuffled && state.shuffleOrder.length > 0) {
          const pos = state.shuffleOrder.indexOf(state.currentIndex);
          if (pos !== -1 && pos + 1 < state.shuffleOrder.length) {
            const nextIndex = state.shuffleOrder[pos + 1];
            await commitTrack(state.sourceQueue[nextIndex], { index: nextIndex, history: nextHistory });
            return;
          }
          if (state.repeatMode === 'all') {
            const newShuffle = generateShuffledIndices(sourceLen);
            if (newShuffle.length > 1 && newShuffle[0] === state.currentIndex) {
              [newShuffle[0], newShuffle[1]] = [newShuffle[1], newShuffle[0]];
            }
            const nextIndex = newShuffle[0];
            await commitTrack(state.sourceQueue[nextIndex], {
              index: nextIndex,
              shuffleOrder: newShuffle,
              history: nextHistory
            });
            return;
          }
        } else if (state.currentIndex + 1 < sourceLen) {
          const nextIndex = state.currentIndex + 1;
          await commitTrack(state.sourceQueue[nextIndex], { index: nextIndex, history: nextHistory });
          return;
        } else if (state.repeatMode === 'all') {
          await commitTrack(state.sourceQueue[0], { index: 0, history: nextHistory });
          return;
        }
      }

      // Queue exhausted: wave/radio replenishment, or autoplay radio, or stop
      if ((state.queueMode === 'track_radio' || state.queueMode === 'my_wave') && (state.currentTrack || state.activeSeedTrack)) {
        await get().replenishAutoplayQueue();
        const freshState = get();
        const freshSourceLen = freshState.sourceQueue.length;
        if (freshState.currentIndex + 1 < freshSourceLen) {
          const nextIndex = freshState.currentIndex + 1;
          await commitTrack(freshState.sourceQueue[nextIndex], { index: nextIndex, history: nextHistory });
          return;
        }
      } else if (state.autoplayRadio && state.currentTrack) {
        const continued = await continueWithRelatedTracks(state.currentTrack);
        if (continued) return;
      }

      stopAtQueueEnd();
    },

    prevTrack: async () => {
      const state = get();

      // Restart the current track when playback already progressed
      if (state.currentTime > 3.0) {
        audioEngine.seek(0);
        set({ currentTime: 0 });
        if (state.playbackState !== 'playing') {
          await get().play();
        }
        return;
      }

      // Pop the in-memory back stack; these plays must not re-enter DB history
      if (state.history.length > 0) {
        const previous = state.history[state.history.length - 1];
        const idx = state.sourceQueue.findIndex((t) => t.id === previous.id);

        await commitTrack(previous, {
          history: state.history.slice(0, -1),
          index: idx !== -1 ? idx : state.currentIndex,
          addToHistory: false
        });
        return;
      }

      // Step back through the queue
      if (state.isShuffled && state.shuffleOrder.length > 0) {
        const pos = state.shuffleOrder.indexOf(state.currentIndex);
        if (pos > 0) {
          const prevIndex = state.shuffleOrder[pos - 1];
          await commitTrack(state.sourceQueue[prevIndex], { index: prevIndex });
          return;
        }
      } else if (state.currentIndex > 0) {
        const prevIndex = state.currentIndex - 1;
        await commitTrack(state.sourceQueue[prevIndex], { index: prevIndex });
        return;
      }

      audioEngine.seek(0);
      set({ currentTime: 0 });
    },

    seekTo: (seconds: number) => {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return;

      const duration = finiteDuration(get().duration);
      const clamped = duration > 0 ? Math.max(0, Math.min(seconds, duration)) : Math.max(0, seconds);

      audioEngine.seek(clamped);
      set({ currentTime: clamped });
      MediaSessionService.updatePositionState(duration, clamped);
    },

    setVolume: (volume: number) => {
      if (typeof volume !== 'number' || !Number.isFinite(volume)) return;

      const clamped = clampVolume(volume);
      const muted = clamped === 0;

      audioEngine.setVolume(clamped);
      audioEngine.setMuted(muted);

      set((s) => ({
        volume: clamped,
        isMuted: muted,
        previousVolume: clamped > 0 ? clamped : s.previousVolume
      }));

      persistSetting(PLAYER_SETTING_KEYS.volume, clamped);
      persistSetting(PLAYER_SETTING_KEYS.isMuted, muted);
    },

    toggleMute: () => {
      const state = get();
      if (state.isMuted) {
        applyMuted(false, state.previousVolume);
      } else {
        applyMuted(true);
      }
    },

    setMuted: (muted: boolean) => {
      applyMuted(muted);
    },

    toggleShuffle: () => {
      const state = get();
      const nextShuffle = !state.isShuffled;

      if (nextShuffle) {
        const newOrder = generateShuffledIndices(
          state.sourceQueue.length,
          state.currentIndex >= 0 ? state.currentIndex : undefined
        );
        set({ isShuffled: true, shuffleOrder: newOrder });
      } else {
        set({ isShuffled: false, shuffleOrder: [] });
      }

      persistSetting(PLAYER_SETTING_KEYS.isShuffled, nextShuffle);
    },

    cycleRepeatMode: () => {
      const current = get().repeatMode;
      const nextMode: RepeatMode = REPEAT_MODES[(REPEAT_MODES.indexOf(current) + 1) % REPEAT_MODES.length];
      set({ repeatMode: nextMode });
      persistSetting(PLAYER_SETTING_KEYS.repeatMode, nextMode);
    },

    setRepeatMode: (mode: RepeatMode) => {
      if (!REPEAT_MODES.includes(mode)) return;
      set({ repeatMode: mode });
      persistSetting(PLAYER_SETTING_KEYS.repeatMode, mode);
    },

    // Queue actions
    addToUserQueue: appendToUserQueue,

    addToQueueEnd: appendToUserQueue,

    addToQueueNext: (track: UnifiedTrack) => {
      if (!track) return;
      set((s) => ({ userQueue: [track, ...s.userQueue] }));
    },

    removeFromUserQueue: (index: number) => {
      set((s) => {
        if (index < 0 || index >= s.userQueue.length) return s;
        const updated = [...s.userQueue];
        updated.splice(index, 1);
        return { userQueue: updated };
      });
    },

    reorderUserQueue: (fromIndex: number, toIndex: number) => {
      set((s) => {
        const len = s.userQueue.length;
        if (fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len) return s;
        const updated = [...s.userQueue];
        const [item] = updated.splice(fromIndex, 1);
        updated.splice(toIndex, 0, item);
        return { userQueue: updated };
      });
    },

    jumpToUserQueueTrack: async (index: number) => {
      const state = get();
      if (index < 0 || index >= state.userQueue.length) return;

      const track = state.userQueue[index];
      const nextHistory =
        state.currentTrack && state.currentTrack.id !== track.id
          ? [...state.history.slice(-HISTORY_LIMIT), state.currentTrack]
          : undefined;

      // Everything the user skipped past is dropped, sourceQueue is untouched
      await commitTrack(track, { userQueue: state.userQueue.slice(index + 1), history: nextHistory });
    },

    clearQueue: emptyUserQueue,

    clearUserQueue: emptyUserQueue,

    setSourceQueue: (queue: UnifiedTrack[], startIndex = 0) => {
      const list = Array.isArray(queue) ? queue : [];
      set({
        sourceQueue: list,
        currentIndex: startIndex >= 0 && startIndex < list.length ? startIndex : 0,
        isShuffled: false,
        shuffleOrder: []
      });
    },

    /**
     * Reconciles the live queue with an edited playlist without disturbing what
     * is currently playing.
     */
    syncSourceQueue: (tracks: UnifiedTrack[]) => {
      const list = Array.isArray(tracks) ? tracks : [];
      const state = get();

      let nextIndex = state.currentTrack ? list.findIndex((t) => t.id === state.currentTrack?.id) : -1;
      if (nextIndex === -1) {
        nextIndex = list.length === 0 ? -1 : Math.max(0, Math.min(state.currentIndex, list.length - 1));
      }

      set({
        sourceQueue: list,
        currentIndex: nextIndex,
        shuffleOrder: state.isShuffled
          ? generateShuffledIndices(list.length, nextIndex >= 0 ? nextIndex : undefined)
          : []
      });
    },

    // Wave & Radio actions
    setQueueMode: (mode: QueueMode) => {
      const isAuto = mode === 'track_radio' || mode === 'my_wave';
      set({
        queueMode: mode,
        autoplayRadio: isAuto
      });
      persistSetting(PLAYER_SETTING_KEYS.autoplayRadio, isAuto);
      if (isAuto && (get().currentTrack || get().activeSeedTrack || get().sourceQueue.length > 0)) {
        void get().replenishAutoplayQueue();
      }
    },

    startTrackRadio: async (seedTrack: UnifiedTrack) => {
      if (!seedTrack) return;
      set({
        queueMode: 'track_radio',
        autoplayRadio: true,
        activeSeedTrack: seedTrack,
        userQueue: [],
        sourceQueue: [seedTrack],
        currentIndex: 0,
        isShuffled: false,
        shuffleOrder: []
      });

      await commitTrack(seedTrack, {
        queue: [seedTrack],
        index: 0,
        userQueue: []
      });
    },

    startMyWave: async (mood?: WaveMood, genre?: string | null) => {
      const previous = get();
      // Ярлык считается из регуляторов, если его не передали явно: снаружи волну
      // теперь запускают именно они.
      const effectiveMood =
        mood || deriveWaveMood(previous.waveNovelty, previous.waveEnergy);
      // `undefined` — «жанр не трогаем», `null` — «сбросить». Без этого различия
      // перезапуск волны из-за ползунка каждый раз терял выбранный жанр.
      const effectiveGenre = genre === undefined ? previous.activeWaveGenre : genre;

      /*
       * Источник «от этой песни» отталкивается от того, что играет сейчас.
       *
       * Раньше семя здесь обнулялось всегда, поэтому Поток вообще не умел
       * начинаться от конкретной песни: от фонка он шёл в поиск по жанру и играл
       * что попало. Теперь при `seedKind: 'track'` песня уходит в конфиг и радио
       * составляет сам YouTube Music.
       *
       * Если играть нечего, источник молча ведёт себя как «из библиотеки»: пустое
       * семя — не повод оставлять человека без Потока.
       */
      const seedTrack = pickWaveSeed(previous.waveSeedKind, previous.currentTrack || previous.activeSeedTrack);

      set({
        queueMode: 'my_wave',
        autoplayRadio: true,
        activeWaveMood: effectiveMood,
        activeWaveGenre: effectiveGenre,
        activeSeedTrack: seedTrack,
        userQueue: [],
        sourceQueue: [],
        currentIndex: -1
      });

      set({ isReplenishingQueue: true });
      try {
        const config = buildWaveConfig(get(), seedTrack);
        const recs = await recommendationEngine.getRecommendationsForWave(config, 10);
        if (recs.length > 0) {
          const firstTrack = recs[0];
          await commitTrack(firstTrack, {
            queue: recs,
            index: 0,
            userQueue: []
          });
        }
      } catch (err) {
        /*
         * Отказ здесь молчал, и это была отдельная беда поверх поломки самого
         * подбора: кнопка «Запустить Поток» возвращалась в исходное состояние,
         * ничего не происходило и ничего не сообщалось. Человек видел ровно то
         * же, что при пустом ответе, и не мог отличить «сеть отвалилась» от
         * «нечего играть».
         */
        console.warn('[usePlayerStore] startMyWave error:', err);
        useUIStore.getState().showToast('Не удалось собрать Поток. Проверьте соединение.', 'error');
      } finally {
        set({ isReplenishingQueue: false });
      }
    },

    startWave: async (configOrMood?: WaveConfig | WaveMood) => {
      if (typeof configOrMood === 'string') {
        await get().startMyWave(configOrMood);
      } else if (configOrMood && typeof configOrMood === 'object') {
        // Конфиг снаружи может нести и регуляторы — их надо запомнить, иначе
        // пополнение очереди продолжит волну по старым значениям из стора.
        if (typeof configOrMood.novelty === 'number') {
          get().setWaveNovelty(configOrMood.novelty);
        }
        if (typeof configOrMood.energy === 'number') {
          get().setWaveEnergy(configOrMood.energy);
        }
        if (configOrMood.seedKind) {
          get().setWaveSeed(configOrMood.seedKind, configOrMood.seedArtist ?? null);
        }
        await get().startMyWave(configOrMood.mood, configOrMood.genre ?? null);
      } else {
        await get().startMyWave(get().activeWaveMood, get().activeWaveGenre);
      }
    },

    dislikeAndSkipCurrentTrack: async () => {
      const state = get();
      const current = state.currentTrack;
      if (current) {
        // Immediately record feedback 'dislike' (adds to dbService.addDislike and records skip)
        await recommendationEngine.recordFeedback(current, 'dislike').catch((err) => {
          console.warn('[usePlayerStore] recordFeedback dislike error:', err);
        });

        // Remove any occurrences of this track from userQueue and sourceQueue
        const filteredUserQueue = state.userQueue.filter((t) => t.id !== current.id);
        const filteredSourceQueue = state.sourceQueue.filter((t) => t.id !== current.id);

        let nextIndex = state.currentIndex;
        const currentPosInSource = state.sourceQueue.findIndex((t) => t.id === current.id);
        if (currentPosInSource !== -1 && currentPosInSource <= state.currentIndex) {
          nextIndex = state.currentIndex - 1;
        }

        set({
          userQueue: filteredUserQueue,
          sourceQueue: filteredSourceQueue,
          currentIndex: nextIndex
        });
      }

      // Check if queue needs replenishing
      const freshState = get();
      const remaining = freshState.sourceQueue.length - (freshState.currentIndex >= 0 ? freshState.currentIndex + 1 : 0);
      if ((remaining <= 0 || freshState.sourceQueue.length === 0) && (freshState.queueMode === 'track_radio' || freshState.queueMode === 'my_wave')) {
        await get().replenishAutoplayQueue();
      }

      await get().nextTrack(false);
    },

    replenishAutoplayQueue: async () => {
      const state = get();
      if (state.queueMode === 'sequential' && !state.autoplayRadio) return;

      const hasSeed = state.currentTrack || state.activeSeedTrack || state.sourceQueue.length > 0 || state.queueMode === 'my_wave';
      if (!hasSeed) return;

      if (replenishPromise) return replenishPromise;

      set({ isReplenishingQueue: true });
      replenishPromise = (async () => {
        try {
          const currentState = get();
          const excludeIds = new Set<string>([
            ...(currentState.currentTrack ? [currentState.currentTrack.id] : []),
            ...currentState.sourceQueue.map((t) => t.id),
            ...currentState.userQueue.map((t) => t.id),
            ...currentState.history.map((t) => t.id)
          ]);

          let newTracks: UnifiedTrack[] = [];
          if (currentState.queueMode === 'track_radio' || (currentState.queueMode === 'sequential' && currentState.autoplayRadio)) {
            const seed = currentState.activeSeedTrack || currentState.currentTrack || (currentState.sourceQueue.length > 0 ? currentState.sourceQueue[currentState.sourceQueue.length - 1] : null);
            if (seed) {
              newTracks = await recommendationEngine.getTrackRadio(seed, 10, excludeIds);
            }
          } else if (currentState.queueMode === 'my_wave') {
            /*
             * Те же запасные сёмена, что и у соседней ветки.
             *
             * Раньше здесь стоял голый `activeSeedTrack`, и если Поток
             * запустили, когда ничего не играло, он оставался `null` навсегда:
             * каждое пополнение прогоняло одни и те же запросы по словам с
             * растущим `excludeIds`, новых треков находилось всё меньше, и
             * очередь высыхала до «Поток закончился». Поток не цеплялся за
             * играющую песню ни разу за всё время работы.
             */
            const seed = pickWaveSeed(
              currentState.waveSeedKind,
              currentState.activeSeedTrack ||
                currentState.currentTrack ||
                (currentState.sourceQueue.length > 0
                  ? currentState.sourceQueue[currentState.sourceQueue.length - 1]
                  : null)
            );
            const config = buildWaveConfig(currentState, seed);
            newTracks = await recommendationEngine.getRecommendationsForWave(config, 10, excludeIds);
          }

          if (newTracks && newTracks.length > 0) {
            const freshState = get();
            const currentIds = new Set<string>([
              ...(freshState.currentTrack ? [freshState.currentTrack.id] : []),
              ...freshState.sourceQueue.map((t) => t.id),
              ...freshState.userQueue.map((t) => t.id)
            ]);
            const filteredNew = newTracks.filter((t) => t && t.id && !currentIds.has(t.id));
            if (filteredNew.length > 0) {
              const base = freshState.sourceQueue.length;
              const updatedSourceQueue = [...freshState.sourceQueue, ...filteredNew];
              const updatedShuffleOrder = freshState.isShuffled
                ? [...freshState.shuffleOrder, ...generateShuffledIndices(filteredNew.length, 0).map((i) => base + i)]
                : freshState.shuffleOrder;

              set({
                sourceQueue: updatedSourceQueue,
                shuffleOrder: updatedShuffleOrder
              });
            }
          }
        } catch (err) {
          // Без этого «Поток закончился» показывалось одинаково и когда
          // похожего честно не нашлось, и когда запрос вовсе не дошёл.
          console.warn('[usePlayerStore] replenishAutoplayQueue error:', err);
          useUIStore.getState().showToast('Не удалось продолжить подбор похожего.', 'error');
        } finally {
          set({ isReplenishingQueue: false });
          replenishPromise = null;
        }
      })();

      return replenishPromise;
    },

    setWaveMood: async (mood: WaveMood) => {
      set({ activeWaveMood: mood });
      if (get().queueMode === 'my_wave') {
        await get().startMyWave(mood, get().activeWaveGenre);
      }
    },

    setWaveGenre: async (genre: string | null) => {
      set({ activeWaveGenre: genre });
      if (get().queueMode === 'my_wave') {
        await get().startMyWave(get().activeWaveMood, genre);
      }
    },

    /**
     * Регуляторы не перезапускают волну сами: пока палец на ползунке, значение
     * меняется десятки раз, и каждый шаг стоил бы полного пересбора очереди.
     * Перезапуск делает экран волны, когда ползунок отпустили.
     */
    setWaveNovelty: (novelty: number) => {
      const clamped = clampAxis(novelty, get().waveNovelty);
      set({
        waveNovelty: clamped,
        activeWaveMood: deriveWaveMood(clamped, get().waveEnergy)
      });
      persistSetting(PLAYER_SETTING_KEYS.waveNovelty, clamped);
    },

    setWaveEnergy: (energy: number) => {
      const clamped = clampAxis(energy, get().waveEnergy);
      set({
        waveEnergy: clamped,
        activeWaveMood: deriveWaveMood(get().waveNovelty, clamped)
      });
      persistSetting(PLAYER_SETTING_KEYS.waveEnergy, clamped);
    },

    setWaveSeed: (kind: WaveSeedKind, artist?: string | null) => {
      // «По артисту» без имени — это ничто: движку не от кого отталкиваться,
      // поэтому такой выбор откатывается к библиотеке.
      const nextArtist = kind === 'artist' ? (artist || null) : null;
      const nextKind: WaveSeedKind = kind === 'artist' && !nextArtist ? 'library' : kind;
      set({ waveSeedKind: nextKind, waveSeedArtist: nextArtist });
      persistSetting(PLAYER_SETTING_KEYS.waveSeedKind, nextKind);
      persistSetting(PLAYER_SETTING_KEYS.waveSeedArtist, nextArtist);
    },

    // Visualizer actions
    toggleVisualizer: () => {
      const next = !get().visualizerEnabled;
      set({ visualizerEnabled: next });
      persistSetting(PLAYER_SETTING_KEYS.visualizerEnabled, next);
    },

    setVisualizerEnabled: (enabled: boolean) => {
      set({ visualizerEnabled: enabled });
      persistSetting(PLAYER_SETTING_KEYS.visualizerEnabled, enabled);
    },

    setVisualizerPreset: (preset: VisualizerPreset) => {
      if (!VISUALIZER_PRESETS.includes(preset)) return;
      set({ visualizerPreset: preset });
      persistSetting(PLAYER_SETTING_KEYS.visualizerPreset, preset);
    },

    // Settings & extras
    hydrateSettings: async () => {
      if (get().settingsHydrated) return;
      if (hydrationPromise) return hydrationPromise;

      hydrationPromise = (async () => {
        const current = get();
        try {
          const [
            volume,
            isMuted,
            repeatMode,
            isShuffled,
            visualizerEnabled,
            visualizerPreset,
            autoplayRadio,
            eq,
            mediaKeysEnabled,
            crossfadeEnabled,
            crossfadeDuration,
            loudnessNormalization,
            playbackRate,
            preservePitch,
            waveNovelty,
            waveEnergy,
            waveSeedKind,
            waveSeedArtist
          ] = await Promise.all([
            dbService.getSetting<number>(PLAYER_SETTING_KEYS.volume, current.volume),
            dbService.getSetting<boolean>(PLAYER_SETTING_KEYS.isMuted, current.isMuted),
            dbService.getSetting<RepeatMode>(PLAYER_SETTING_KEYS.repeatMode, current.repeatMode),
            dbService.getSetting<boolean>(PLAYER_SETTING_KEYS.isShuffled, current.isShuffled),
            dbService.getSetting<boolean>(PLAYER_SETTING_KEYS.visualizerEnabled, current.visualizerEnabled),
            dbService.getSetting<VisualizerPreset>(PLAYER_SETTING_KEYS.visualizerPreset, current.visualizerPreset),
            dbService.getSetting<boolean>(PLAYER_SETTING_KEYS.autoplayRadio, current.autoplayRadio),
            dbService.getSetting<EqSettings>(PLAYER_SETTING_KEYS.eq, current.eq),
            dbService.getSetting<boolean>(PLAYER_SETTING_KEYS.mediaKeysEnabled, current.mediaKeysEnabled),
            dbService.getSetting<boolean>(PLAYER_SETTING_KEYS.crossfadeEnabled, current.crossfadeEnabled),
            dbService.getSetting<number>(PLAYER_SETTING_KEYS.crossfadeDuration, current.crossfadeDuration),
            dbService.getSetting<boolean>(PLAYER_SETTING_KEYS.loudnessNormalization, current.loudnessNormalization),
            dbService.getSetting<number>(PLAYER_SETTING_KEYS.playbackRate, current.playbackRate),
            dbService.getSetting<boolean>(PLAYER_SETTING_KEYS.preservePitch, current.preservePitch),
            dbService.getSetting<number>(PLAYER_SETTING_KEYS.waveNovelty, current.waveNovelty),
            dbService.getSetting<number>(PLAYER_SETTING_KEYS.waveEnergy, current.waveEnergy),
            dbService.getSetting<WaveSeedKind>(PLAYER_SETTING_KEYS.waveSeedKind, current.waveSeedKind),
            dbService.getSetting<string | null>(PLAYER_SETTING_KEYS.waveSeedArtist, current.waveSeedArtist)
          ]);

          const nextVolume = typeof volume === 'number' && Number.isFinite(volume) ? clampVolume(volume) : current.volume;
          const nextMuted = typeof isMuted === 'boolean' ? isMuted : nextVolume === 0;
          const nextEq = normalizeEq(eq, current.eq);
          const nextPreset = VISUALIZER_PRESETS.includes(visualizerPreset) ? visualizerPreset : current.visualizerPreset;
          const nextCrossfadeEnabled = typeof crossfadeEnabled === 'boolean' ? crossfadeEnabled : current.crossfadeEnabled;
          const nextCrossfadeDuration =
            typeof crossfadeDuration === 'number' && Number.isFinite(crossfadeDuration)
              ? Math.max(0, Math.min(12, Math.round(crossfadeDuration)))
              : current.crossfadeDuration;
          const nextLoudnessNorm =
            typeof loudnessNormalization === 'boolean' ? loudnessNormalization : current.loudnessNormalization;
          const nextRate =
            typeof playbackRate === 'number' && Number.isFinite(playbackRate)
              ? clampPlaybackRate(playbackRate)
              : current.playbackRate;
          const nextPreservePitch =
            typeof preservePitch === 'boolean' ? preservePitch : current.preservePitch;
          const nextNovelty = clampAxis(
            typeof waveNovelty === 'number' ? waveNovelty : undefined,
            current.waveNovelty
          );
          const nextEnergy = clampAxis(
            typeof waveEnergy === 'number' ? waveEnergy : undefined,
            current.waveEnergy
          );
          const nextSeedArtist = typeof waveSeedArtist === 'string' && waveSeedArtist.trim() ? waveSeedArtist : null;
          // Источник «по артисту» без сохранённого имени бесполезен — такой
          // мусор в базе не должен превращать волну в пустоту.
          const storedSeedKind = WAVE_SEED_KINDS.includes(waveSeedKind) ? waveSeedKind : current.waveSeedKind;
          const nextSeedKind: WaveSeedKind =
            storedSeedKind === 'artist' && !nextSeedArtist ? 'library' : storedSeedKind;

          set({
            volume: nextVolume,
            isMuted: nextMuted || nextVolume === 0,
            previousVolume: nextVolume > 0 ? nextVolume : current.previousVolume,
            repeatMode: REPEAT_MODES.includes(repeatMode) ? repeatMode : current.repeatMode,
            isShuffled: typeof isShuffled === 'boolean' ? isShuffled : current.isShuffled,
            visualizerEnabled: typeof visualizerEnabled === 'boolean' ? visualizerEnabled : current.visualizerEnabled,
            visualizerPreset: nextPreset,
            autoplayRadio: typeof autoplayRadio === 'boolean' ? autoplayRadio : current.autoplayRadio,
            eq: nextEq,
            crossfadeEnabled: nextCrossfadeEnabled,
            crossfadeDuration: nextCrossfadeDuration,
            loudnessNormalization: nextLoudnessNorm,
            playbackRate: nextRate,
            preservePitch: nextPreservePitch,
            waveNovelty: nextNovelty,
            waveEnergy: nextEnergy,
            waveSeedKind: nextSeedKind,
            waveSeedArtist: nextSeedArtist,
            activeWaveMood: deriveWaveMood(nextNovelty, nextEnergy),
            mediaKeysEnabled: typeof mediaKeysEnabled === 'boolean' ? mediaKeysEnabled : current.mediaKeysEnabled
          });

          audioEngine.setVolume(nextVolume);
          audioEngine.setMuted(nextMuted || nextVolume === 0);
          audioEngine.setEqGains(nextEq);
          audioEngine.setCrossfade(nextCrossfadeEnabled, nextCrossfadeDuration);
          audioEngine.setLoudnessNormalization(nextLoudnessNorm);
          audioEngine.setPlaybackRate(nextRate, nextPreservePitch);
          forwardMediaKeysPreference(get().mediaKeysEnabled);

          if (get().isShuffled && get().sourceQueue.length > 0) {
            set({
              shuffleOrder: generateShuffledIndices(
                get().sourceQueue.length,
                get().currentIndex >= 0 ? get().currentIndex : undefined
              )
            });
          }
        } catch (err) {
          console.warn('[usePlayerStore] Could not hydrate persisted settings:', err);
        } finally {
          set({ settingsHydrated: true });
          hydrationPromise = null;
        }
      })();

      return hydrationPromise;
    },

    setSleepTimer: (minutes: number | null) => {
      clearSleepTimerHandle();
      audioEngine.cancelVolumeFade();

      if (minutes === null || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
        set({ sleepTimerEndsAt: null });
        return;
      }

      const durationMs = minutes * 60000;
      sleepTimerHandle = setTimeout(() => {
        sleepTimerHandle = null;
        void runSleepTimer();
      }, durationMs);

      set({ sleepTimerEndsAt: Date.now() + durationMs });
    },

    setAutoplayRadio: (enabled: boolean) => {
      set({ autoplayRadio: enabled });
      persistSetting(PLAYER_SETTING_KEYS.autoplayRadio, enabled);
    },

    setEq: (partial: Partial<EqSettings>) => {
      const next = normalizeEq({ ...get().eq, ...partial }, get().eq);
      audioEngine.setEqGains(next);
      set({ eq: next });
      persistSetting(PLAYER_SETTING_KEYS.eq, next);
    },

    setCrossfadeEnabled: (enabled: boolean) => {
      set({ crossfadeEnabled: enabled });
      audioEngine.setCrossfade(enabled, get().crossfadeDuration);
      persistSetting(PLAYER_SETTING_KEYS.crossfadeEnabled, enabled);
    },

    setCrossfadeDuration: (seconds: number) => {
      const clamped = Math.max(0, Math.min(12, Math.round(seconds)));
      set({ crossfadeDuration: clamped });
      audioEngine.setCrossfade(get().crossfadeEnabled, clamped);
      persistSetting(PLAYER_SETTING_KEYS.crossfadeDuration, clamped);
    },

    setLoudnessNormalization: (enabled: boolean) => {
      set({ loudnessNormalization: enabled });
      audioEngine.setLoudnessNormalization(enabled);
      persistSetting(PLAYER_SETTING_KEYS.loudnessNormalization, enabled);
    },

    setPlaybackRate: (rate: number, preservePitch?: boolean) => {
      const clamped = clampPlaybackRate(rate);
      const nextPreserve = typeof preservePitch === 'boolean' ? preservePitch : get().preservePitch;
      set({ playbackRate: clamped, preservePitch: nextPreserve });
      audioEngine.setPlaybackRate(clamped, nextPreserve);
      persistSetting(PLAYER_SETTING_KEYS.playbackRate, clamped);
      persistSetting(PLAYER_SETTING_KEYS.preservePitch, nextPreserve);
    },

    setPreservePitch: (preserve: boolean) => {
      set({ preservePitch: preserve });
      audioEngine.setPlaybackRate(get().playbackRate, preserve);
      persistSetting(PLAYER_SETTING_KEYS.preservePitch, preserve);
    },

    resetPlaybackRate: () => {
      set({ playbackRate: 1 });
      audioEngine.setPlaybackRate(1, get().preservePitch);
      persistSetting(PLAYER_SETTING_KEYS.playbackRate, 1);
    },

    setMediaKeysEnabled: (enabled: boolean) => {
      set({ mediaKeysEnabled: enabled });
      persistSetting(PLAYER_SETTING_KEYS.mediaKeysEnabled, enabled);
      forwardMediaKeysPreference(enabled);
    },

    // Event callbacks
    syncProgress: (currentTime: number, duration: number, buffered: number) => {
      const state = get();
      const safeTime = typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
      const safeDuration = finiteDuration(duration) || finiteDuration(state.duration);
      const safeBuffered = typeof buffered === 'number' && Number.isFinite(buffered) && buffered > 0 ? buffered : 0;

      set({ currentTime: safeTime, duration: safeDuration, buffered: safeBuffered });
      MediaSessionService.updatePositionState(safeDuration, safeTime);

      // DJ Crossfade early progression trigger before current track finishes
      if (
        state.crossfadeEnabled &&
        state.crossfadeDuration > 0 &&
        state.isPlaying &&
        !state.isLoading &&
        safeDuration > state.crossfadeDuration * 1.5 &&
        safeDuration - safeTime <= state.crossfadeDuration &&
        !crossfadeTransitionInFlight
      ) {
        crossfadeTransitionInFlight = true;
        void get().nextTrack(false).finally(() => {
          setTimeout(() => {
            crossfadeTransitionInFlight = false;
          }, (state.crossfadeDuration + 1) * 1000);
        });
      }
    },

    onTrackEnded: async () => {
      const current = get().currentTrack;
      if (current) {
        void recommendationEngine.recordFeedback(current, 'complete').catch(() => {});
      }
      await get().nextTrack(false);
    }
  };
});

/** Full stop: the OS notification must not keep showing a stale track. */
function haltPlayback(): void {
  audioEngine.pause();
  usePlayerStore.setState({
    playbackState: 'idle',
    isPlaying: false,
    isLoading: false,
    currentTime: 0,
    buffered: 0
  });
  MediaSessionService.clear();
  registerMediaSessionHandlers();
}

function registerMediaSessionHandlers(): void {
  MediaSessionService.registerActionHandlers({
    onPlay: () => {
      void usePlayerStore.getState().play();
    },
    onPause: () => usePlayerStore.getState().pause(),
    onNext: () => {
      void usePlayerStore.getState().nextTrack(true);
    },
    onPrev: () => {
      void usePlayerStore.getState().prevTrack();
    },
    onSeek: (pos) => usePlayerStore.getState().seekTo(pos),
    getCurrentPosition: () => usePlayerStore.getState().currentTime,
    onStop: () => haltPlayback()
  });
}

/** Releases timers, the audio graph and the OS session (app teardown). */
export function destroyPlayerRuntime(): void {
  clearSleepTimerHandle();
  usePlayerStore.setState({ sleepTimerEndsAt: null });
  audioEngine.destroy();
  MediaSessionService.clear();
}

// Initialize engine and MediaSession event integration
if (typeof window !== 'undefined') {
  audioEngine.onTimeUpdate((currentTime, duration, buffered) => {
    usePlayerStore.getState().syncProgress(currentTime, duration, buffered);
  });

  audioEngine.onStateChange((playbackState) => {
    usePlayerStore.setState((s) => ({
      playbackState,
      isPlaying: playbackState === 'playing',
      isLoading: playbackState === 'loading' || playbackState === 'buffering',
      error: playbackState === 'playing' ? null : s.error,
      errorDetail: playbackState === 'playing' ? null : s.errorDetail
    }));
    MediaSessionService.updatePlaybackState(playbackState);
  });

  audioEngine.onError((err) => {
    const track = usePlayerStore.getState().currentTrack;
    usePlayerStore.setState(errorPatch(err, track?.source));
  });

  audioEngine.onEnded(() => {
    usePlayerStore.getState().onTrackEnded();
  });

  registerMediaSessionHandlers();

  window.addEventListener('pagehide', destroyPlayerRuntime);
}
