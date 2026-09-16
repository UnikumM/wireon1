import { UnifiedTrack, PlaybackState, RepeatMode, EqSettings, SearchCollection } from './music';
import { VisualizerPreset } from './visualizer';

export type QueueMode = 'sequential' | 'track_radio' | 'my_wave';
export type WaveMood = 'favorite' | 'discovery' | 'energy' | 'chill' | 'focus';

/**
 * Откуда волна берёт начало. Прежние «настроения» смешивали в одном списке две
 * разные вещи — что играть и насколько знакомое, — поэтому источник вынесен
 * отдельно, а знакомость и энергия стали регуляторами.
 */
/**
 * Откуда Поток берёт направление. `'track'` — от играющей песни: радио самого
 * YouTube Music по ней, а не поиск по жанру.
 */
export type WaveSeedKind = 'library' | 'discovery' | 'artist' | 'forgotten' | 'track';

export interface WaveConfig {
  /**
   * Внутренний ярлык для движка. Когда заданы `novelty`/`energy`, он считается
   * из них и нужен только для подписи и цвета шара.
   */
  mood: WaveMood;
  genre?: string;
  seedTrack?: UnifiedTrack;
  /** 0 — только знакомое, 1 — только незнакомое. */
  novelty?: number;
  /** 0 — спокойное, 1 — бодрое. */
  energy?: number;
  seedKind?: WaveSeedKind;
  /** Для `seedKind: 'artist'` — от кого отталкиваться. */
  seedArtist?: string;
}

export interface PlayerStoreState {
  currentTrack: UnifiedTrack | null;
  playbackState: PlaybackState;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  volume: number; // 0.0 to 1.0
  isMuted: boolean;
  previousVolume: number; // last non-zero volume, restored on unmute
  repeatMode: RepeatMode;
  isShuffled: boolean;
  /**
   * Что в очереди подобрано нами, а не выбрано человеком.
   *
   * Нужно, чтобы предложения было видно: подмешанный трек в чужом плейлисте
   * без пометки выглядит как «откуда это здесь взялось».
   */
  suggestedTrackIds: string[];
  error: string | null; // human-readable last playback error
  errorDetail: string | null; // the raw message behind `error`, for tooltips and bug reports
  errorCanRetry: boolean; // false when pressing play again cannot help
  isPreviewStream: boolean; // the resolved stream is a snipped preview, not the full track
  /**
   * Секунда, с которой продолжится трек, оставшийся с прошлого запуска.
   *
   * `null` — продолжать нечего. Само по себе значение ничего не запускает:
   * трек показан на паузе, и позиция применяется в момент, когда человек
   * нажмёт «играть». Иначе пришлось бы идти за ссылкой прямо на старте
   * приложения — четыре-восемь секунд ради того, чего никто не просил.
   */
  resumePosition: number | null;

  /** Свои сочетания уровня системы включены. Медиаклавиши — отдельная настройка. */
  globalHotkeysEnabled: boolean;
  /** Карта «действие → сочетание». Пустая строка — действию клавиша не назначена. */
  globalHotkeys: Record<string, string>;

  // 2-tier Queue
  userQueue: UnifiedTrack[];
  sourceQueue: UnifiedTrack[];
  history: UnifiedTrack[];
  currentIndex: number;
  shuffleOrder: number[];

  // Wave & Queue Mode
  queueMode: QueueMode;
  activeWaveMood: WaveMood;
  activeWaveGenre: string | null;
  activeSeedTrack: UnifiedTrack | null;
  isReplenishingQueue: boolean;
  /** Регулятор «знакомое ↔ новое», 0..1. */
  waveNovelty: number;
  /** Регулятор «спокойное ↔ бодрое», 0..1. */
  waveEnergy: number;
  waveSeedKind: WaveSeedKind;
  /** Кто задаёт направление при `waveSeedKind: 'artist'`. */
  waveSeedArtist: string | null;

  // Visualizer settings
  visualizerEnabled: boolean;
  visualizerPreset: VisualizerPreset;

  // Playback extras
  sleepTimerEndsAt: number | null; // epoch ms
  autoplayRadio: boolean; // continue with related tracks when the queue ends
  eq: EqSettings; // dB, -12..+12
  crossfadeEnabled: boolean;
  crossfadeDuration: number; // 0..12 seconds
  loudnessNormalization: boolean;
  /** Телефон: пропускать звук через эквалайзер и спектр. См. services/audioProcessing.ts. */
  mobileAudioFx: boolean;
  /** Playback speed, 0.5–2.0. Anything other than 1 is shown in the player bar. */
  playbackRate: number;
  /** True keeps the original key while the tempo changes. */
  preservePitch: boolean;
  mediaKeysEnabled: boolean;
  settingsHydrated: boolean;
}

export interface PlayerStoreActions {
  playTrack: (track: UnifiedTrack, newSourceQueue?: UnifiedTrack[], index?: number) => Promise<void>;
  playTrackSingle: (track: UnifiedTrack) => Promise<void>;
  togglePlayPause: () => Promise<void>;
  togglePlay: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  nextTrack: (isManualSkip?: boolean) => Promise<void>;
  prevTrack: () => Promise<void>;
  seekTo: (seconds: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  setMuted: (muted: boolean) => void;
  toggleShuffle: () => void;
  cycleRepeatMode: () => void;
  setRepeatMode: (mode: RepeatMode) => void;

  // Queue actions
  addToUserQueue: (track: UnifiedTrack) => void;
  addToQueueEnd: (track: UnifiedTrack) => void;
  addToQueueNext: (track: UnifiedTrack) => void;
  removeFromUserQueue: (index: number) => void;
  reorderUserQueue: (fromIndex: number, toIndex: number) => void;
  jumpToUserQueueTrack: (index: number) => Promise<void>;
  clearQueue: () => void;
  clearUserQueue: () => void;
  setSourceQueue: (queue: UnifiedTrack[], startIndex?: number) => void;
  syncSourceQueue: (tracks: UnifiedTrack[]) => void;

  // Wave & Radio actions
  setQueueMode: (mode: QueueMode) => void;
  startTrackRadio: (seedTrack: UnifiedTrack) => Promise<void>;
  /**
   * Перемешать и дополнить: тот же плейлист вперемешку, а между своими треками
   * подобранные по его составу. Пустой список тихо ничего не делает.
   */
  smartShuffle: (tracks: UnifiedTrack[]) => Promise<void>;
  startMyWave: (mood?: WaveMood, genre?: string | null) => Promise<void>;
  startWave: (configOrMood?: WaveConfig | WaveMood) => Promise<void>;
  dislikeAndSkipCurrentTrack: () => Promise<void>;
  replenishAutoplayQueue: () => Promise<void>;
  setWaveMood: (mood: WaveMood) => Promise<void>;
  setWaveGenre: (genre: string | null) => Promise<void>;
  /** Двигает регулятор знакомости; волну перезапускает вызывающая сторона. */
  setWaveNovelty: (novelty: number) => void;
  setWaveEnergy: (energy: number) => void;
  setWaveSeed: (kind: WaveSeedKind, artist?: string | null) => void;

  // Visualizer actions
  toggleVisualizer: () => void;
  setVisualizerEnabled: (enabled: boolean) => void;
  setVisualizerPreset: (preset: VisualizerPreset) => void;

  // Settings & extras
  hydrateSettings: () => Promise<void>;
  setSleepTimer: (minutes: number | null) => void;
  setAutoplayRadio: (enabled: boolean) => void;
  setEq: (partial: Partial<EqSettings>) => void;
  setCrossfadeEnabled: (enabled: boolean) => void;
  setCrossfadeDuration: (seconds: number) => void;
  setLoudnessNormalization: (enabled: boolean) => void;
  setMobileAudioFx: (enabled: boolean) => void;
  setPlaybackRate: (rate: number, preservePitch?: boolean) => void;
  setPreservePitch: (preserve: boolean) => void;
  resetPlaybackRate: () => void;
  setMediaKeysEnabled: (enabled: boolean) => void;
  setGlobalHotkeysEnabled: (enabled: boolean) => void;
  /** Назначает сочетание действию; пустая строка снимает назначение. */
  setGlobalHotkey: (action: string, accelerator: string) => void;
  resetGlobalHotkeys: () => void;

  // Synchronization callbacks
  syncProgress: (currentTime: number, duration: number, buffered: number) => void;
  onTrackEnded: () => Promise<void>;
}

export type PlayerStore = PlayerStoreState & PlayerStoreActions;

/**
 * The library and auth store shapes are declared next to their implementations
 * so there is exactly one source of truth; they are re-exported here for
 * consumers that import every store type from this module.
 */
export type { LibraryStoreState, LibraryStoreActions, LibraryStore } from '../store/useLibraryStore';
export type { AuthStoreState, AuthStoreActions, AuthStore } from '../store/useAuthStore';

export interface ToastInfo {
  id?: string;
  text: string;
  type: 'info' | 'success' | 'error';
}

export type MiniPlayerLayout = 'compact' | 'square' | 'expanded';

export interface UIStoreState {
  isQueueOpen: boolean;
  isFullscreenPlayerOpen: boolean;
  isCommandPaletteOpen: boolean;
  isMiniPlayerOpen: boolean;
  /** True when the mini player lives in its own always-on-top window rather than in this one. */
  miniWindowActive: boolean;
  miniPlayerLayout: MiniPlayerLayout;
  miniPlayerAlwaysOnTop: boolean;
  miniPlayerOpacity: number;
  miniPlayerShowVisualizer: boolean;
  miniPlayerShowProgress: boolean;
  miniPlayerShowControls: boolean;
  // `offline` — полноценный маршрут, а не закладка внутри медиатеки. Пока он
  // жил только в состоянии `LibraryView`, выбранная закладка выводилась из
  // `activeView` и до него не доходила: с «Избранного» и «Плейлистов» вкладка
  // «Офлайн» не открывалась вовсе.
  // `home` — лента, с которой открывается телефон. На широком окне отдельного
  // экрана под неё нет, и маршрут ведёт в «Для вас»: содержимое то же, просто
  // собранное для мыши.
  activeView: 'home' | 'search' | 'library' | 'favorites' | 'playlists' | 'offline' | 'playlist' | 'settings' | 'wave' | 'artist' | 'foryou' | 'collection';
  /** Открытая подборка: альбом, чужой плейлист или сеты человека с SoundCloud. */
  activeCollection: SearchCollection | null;
  /** Трек, для которого открыт лист действий на телефоне. */
  actionsTrack: UnifiedTrack | null;
  /**
   * Отмеченные треки, когда список в режиме выбора. `null` — обычный список.
   *
   * В сторе, а не в каждом экране: режим включается из меню самого трека, а
   * меню живёт отдельным слоем и до состояния списка не дотягивается. Плюс
   * экранов со списками несколько, и три копии одной механики разъехались бы
   * на первой же правке.
   */
  selectedTrackIds: string[] | null;
  /**
   * Что человек попытался сохранить без аккаунта. `null` — приглашение закрыто.
   *
   * Медиатека привязана к аккаунту Discord: сервер узнаёт по нему, чей это
   * шкаф. Без входа её некуда положить, кроме этого устройства, — а значит,
   * плейлист, собранный на телефоне, на компьютере просто не появится. Поэтому
   * приложение не делает вид, что сохранило, а просит войти и называет, ради
   * чего.
   */
  accountPrompt: string | null;
  activeWaveMood: WaveMood;
  activeWaveGenre: string | null;
  activePlaylistId: string | null;
  selectedArtistName: string | null;
  searchQuery: string;
  searchFilter: 'all' | 'youtube' | 'soundcloud';
  toastMessage: ToastInfo | null;
  isLyricsOpen: boolean;
}

export interface UIStoreActions {
  setActiveView: (view: UIStoreState['activeView']) => void;
  openCollection: (collection: SearchCollection) => void;
  setActiveWaveMood: (mood: WaveMood) => void;
  setActiveWaveGenre: (genre: string | null) => void;
  setActivePlaylistId: (id: string | null) => void;
  setSelectedArtistName: (name: string | null) => void;
  openArtist: (artistName: string) => void;
  toggleQueue: () => void;
  setQueueOpen: (isOpen: boolean) => void;
  toggleLyrics: () => void;
  setLyricsOpen: (isOpen: boolean) => void;
  toggleFullscreenPlayer: () => void;
  setFullscreenPlayerOpen: (isOpen: boolean) => void;
  toggleMiniPlayer: () => Promise<void>;
  setMiniPlayerOpen: (isOpen: boolean) => Promise<void>;
  setMiniPlayerLayout: (layout: MiniPlayerLayout) => Promise<void>;
  setMiniPlayerAlwaysOnTop: (alwaysOnTop: boolean) => Promise<void>;
  setMiniPlayerOpacity: (opacity: number) => void;
  setMiniPlayerShowVisualizer: (show: boolean) => void;
  setMiniPlayerShowProgress: (show: boolean) => void;
  setMiniPlayerShowControls: (show: boolean) => void;
  toggleCommandPalette: () => void;
  setCommandPaletteOpen: (isOpen: boolean) => void;
  setSearchQuery: (query: string) => void;
  setSearchFilter: (filter: 'all' | 'youtube' | 'soundcloud') => void;
  showToast: (text: string, type?: 'info' | 'success' | 'error') => void;
  clearToast: () => void;
  openTrackActions: (track: UnifiedTrack) => void;
  closeTrackActions: () => void;
  /** Включает режим выбора, сразу отмечая трек, из которого его позвали. */
  startSelection: (trackId?: string) => void;
  toggleSelected: (trackId: string) => void;
  setSelected: (trackIds: string[]) => void;
  clearSelection: () => void;
  /** Просит войти. `reason` — что именно человек хотел сохранить. */
  requireAccount: (reason: string) => void;
  closeAccountPrompt: () => void;
}

export type UIStore = UIStoreState & UIStoreActions;
