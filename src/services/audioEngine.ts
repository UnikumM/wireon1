import { UnifiedTrack, PlaybackState, EqSettings } from '../types/music';
import { streamResolver, StreamResolver } from './streamResolver';
import { attachHls, isHlsUrl, HlsHandle } from './hls';
import { detectPlatform } from './nativeBridge';

export type TimeUpdateCallback = (currentTime: number, duration: number, buffered: number) => void;
export type EndedCallback = () => void;
export type ErrorCallback = (error: Error) => void;
export type StateChangeCallback = (state: PlaybackState) => void;

export const EQ_GAIN_LIMIT_DB = 12;

interface EqNodes {
  bass: BiquadFilterNode;
  mid: BiquadFilterNode;
  treble: BiquadFilterNode;
}

export interface IAudioEngine {
  load(track: UnifiedTrack, autoPlay?: boolean): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(timeInSeconds: number): void;
  setVolume(volume: number): void; // 0.0 to 1.0 (applied via quadratic perceptual curve)
  setMuted(muted: boolean): void;
  getVolume(): number;
  isMuted(): boolean;
  fadeVolumeTo(target: number, durationMs: number): Promise<void>;
  cancelVolumeFade(): void;
  setEqGains(gains: Partial<EqSettings>): void;
  getEqGains(): EqSettings;
  setPlaybackRate(rate: number, preservePitch?: boolean): void;
  getPlaybackRate(): number;
  getPreservesPitch(): boolean;
  setCrossfade(enabled: boolean, durationSec: number): void;
  isCrossfadeEnabled(): boolean;
  getCrossfadeDuration(): number;
  isCrossfadeInProgress(): boolean;
  setLoudnessNormalization(enabled: boolean): void;
  isLoudnessNormalizationEnabled(): boolean;
  getActiveDeck(): 'A' | 'B';
  getDeckAGainNode(): GainNode | null;
  getDeckBGainNode(): GainNode | null;
  getMasterGainNode(): GainNode | null;
  getCompressorNode(): DynamicsCompressorNode | null;
  getCurrentTime(): number;
  getDuration(): number;
  getBuffered(): number;
  getState(): PlaybackState;
  getCurrentTrack(): UnifiedTrack | null;
  getAudioContext(): AudioContext | null;
  getAnalyser(): AnalyserNode | null;
  getFrequencyData(): Uint8Array;
  onTimeUpdate(callback: TimeUpdateCallback): () => void;
  onEnded(callback: EndedCallback): () => void;
  onError(callback: ErrorCallback): () => void;
  onStateChange(callback: StateChangeCallback): () => void;
  destroy(): void;
}

const FADE_STEP_MS = 100;

/** Speed bounds. Below 0.5 audio turns to mud; above 2.0 it turns to chipmunk. */
export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 2.0;

/**
 * Сколько ждём начала звука после включения, прежде чем чинить поток.
 *
 * Взято с запасом от обычного включения: ссылка приходит из кэша мгновенно,
 * первые байты — за секунду-две даже на слабой связи. Меньше нельзя, иначе
 * попадём в живую, просто медленную загрузку и оборвём её на ровном месте.
 */
export const LOAD_WATCHDOG_MS = 12000;

/**
 * Сколько ждать, что заминка пройдёт сама, прежде чем идти за новой ссылкой.
 *
 * Полторы секунды — заметно меньше, чем стоит поход за ссылкой (четыре-восемь
 * секунд по замерам на ПК), и заметно больше типичной паузы на добор буфера.
 */
export const SOFT_RECOVERY_MS = 1500;

/**
 * Отличает гонку от настоящего отказа воспроизведения.
 *
 * `HTMLMediaElement.play()` возвращает промис, и браузер отклоняет его с
 * `AbortError`, если до его разрешения элементу сменили `src`, вызвали `load()`
 * или `pause()`. Это ровно то, что делает быстрое переключение треков: старый
 * запрос проиграл гонку новому, и новый в этот момент уже играет. Для слушателя
 * это не ошибка, поэтому такой отказ не должен ни ронять состояние в `error`, ни
 * всплывать тостом «Audio playback failed: The play() request was interrupted…».
 *
 * `NotAllowedError` (политика автозапуска) и `NotSupportedError` (формат)
 * намеренно сюда не попадают — это настоящие проблемы, о них нужно сказать.
 */
export function isBenignPlayInterruption(err: unknown): boolean {
  const name =
    typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name?: unknown }).name ?? '')
      : '';
  if (name === 'AbortError') return true;

  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return (
    message.includes('interrupted by a new load request') ||
    message.includes('interrupted by a call to pause') ||
    message.includes('interrupted because the media was removed from the document') ||
    message.includes('interrupted because video-only background media was paused')
  );
}

export class AudioEngine implements IAudioEngine {
  private audioA: HTMLAudioElement;
  private audioB: HTMLAudioElement;
  private activeDeck: 'A' | 'B' = 'A';

  private audioContext: AudioContext | null = null;
  private sourceNodeA: MediaElementAudioSourceNode | null = null;
  private sourceNodeB: MediaElementAudioSourceNode | null = null;
  private gainNodeA: GainNode | null = null;
  private gainNodeB: GainNode | null = null;
  private masterGainNode: GainNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  /**
   * Reused spectrum buffer for `getFrequencyData`. Deliberately inferred: an
   * explicit `Uint8Array` annotation widens it to `ArrayBufferLike`, which
   * `getByteFrequencyData` rejects.
   */
  private frequencyBuffer = new Uint8Array(128);
  private eqNodes: EqNodes | null = null;
  private isGraphConnected: boolean = false;
  private graphUnavailable: boolean = false;

  private crossfadeEnabled: boolean = false;
  private crossfadeDuration: number = 3; // default 3s (0s-12s range)
  private loudnessNormalization: boolean = false;
  private crossfadeTimer: ReturnType<typeof setTimeout> | null = null;
  private isCrossfading: boolean = false;

  private currentTrack: UnifiedTrack | null = null;
  private state: PlaybackState = 'idle';
  private volume: number = 0.8; // default 80%
  private muted: boolean = false;
  private eqGains: EqSettings = { bass: 0, mid: 0, treble: 0 };
  /** 1 = normal speed; see {@link setPlaybackRate}. */
  private playbackRate: number = 1;
  private preservePitch: boolean = false;
  private fadeMultiplier: number = 1;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  private fadeToken: number = 0;
  private pendingSeek: number | null = null;
  private hlsHandleA: HlsHandle | null = null;
  private hlsHandleB: HlsHandle | null = null;
  private resolver: StreamResolver;
  private playRequestId: number = 0;
  private loadRequestId: number = 0;

  private retryCount: number = 0;
  private maxRetries: number = 3;
  private isRecovering: boolean = false;
  private stallWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Сторож самого включения — на случай, когда элемент не присылает ни одного
   * события. Обычный сторож здесь бессилен: он отказывается заводиться, пока
   * элемент на паузе, а между `load()` и началом звука он именно на паузе.
   */
  private loadWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private healthResetTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCurrentTime: number = -1;

  // Event Listeners Sets
  private timeUpdateListeners: Set<TimeUpdateCallback> = new Set();
  private endedListeners: Set<EndedCallback> = new Set();
  private errorListeners: Set<ErrorCallback> = new Set();
  private stateChangeListeners: Set<StateChangeCallback> = new Set();

  private boundTimeUpdate: (e?: Event) => void;
  private boundProgress: (e?: Event) => void;
  private boundEnded: (e?: Event) => void;
  private boundError: (e: Event) => void;
  private boundPlaying: (e?: Event) => void;
  private boundPause: (e?: Event) => void;
  private boundWaiting: (e?: Event) => void;
  private boundStalled: (e?: Event) => void;
  private boundMetadata: (e?: Event) => void;

  constructor(
    resolver: StreamResolver = streamResolver,
    customAudio?: HTMLAudioElement,
    customAudioB?: HTMLAudioElement
  ) {
    this.resolver = resolver;
    this.audioA = customAudio || (typeof Audio !== 'undefined' ? new Audio() : ({} as HTMLAudioElement));
    this.audioB = customAudioB || (typeof Audio !== 'undefined' ? new Audio() : ({} as HTMLAudioElement));

    /*
     * `crossOrigin` на телефоне ставить нельзя, и это замерено на устройстве
     * 2026-08-29, а не выведено из документации.
     *
     * Ссылки YouTube отдаёт с `googlevideo.com`, и заголовков CORS у них нет.
     * В WebView, где страница живёт на `https://localhost`, элемент с
     * `crossOrigin='anonymous'` такую ссылку **отвергает целиком**: один и тот
     * же адрес даёт `canplay` без атрибута и ошибку 4 («формат не
     * поддерживается») с ним. Снаружи это выглядит как «этот аудиоформат здесь
     * не воспроизводится» — то есть как беда с треком, а не с заголовком.
     *
     * Плата за снятый атрибут: ресурс становится «запятнанным», и звук,
     * пропущенный через Web Audio, обращается в тишину (тоже замерено: элемент
     * идёт, `currentTime` растёт, анализатор видит нули). Поэтому на телефоне
     * граф не строится вовсе — см. `graphUnavailable` ниже. Цена честная:
     * эквалайзер, кроссфейд и спектр там не работают, зато звук есть.
     *
     * На десктопе всё остаётся как было: там ссылку добывает главный процесс,
     * а Electron эти запросы не режет.
     */
    const needsTaintedPlayback = detectPlatform() === 'mobile';

    if (this.audioA && typeof this.audioA.addEventListener === 'function') {
      if (!needsTaintedPlayback) this.audioA.crossOrigin = 'anonymous';
      this.audioA.preload = 'auto';
    }
    if (this.audioB && typeof this.audioB.addEventListener === 'function') {
      if (!needsTaintedPlayback) this.audioB.crossOrigin = 'anonymous';
      this.audioB.preload = 'auto';
    }

    // Граф на телефоне не строится: `createMediaElementSource` на запятнанном
    // ресурсе отдаёт тишину, и это не отказ, который видно, а отказ, который
    // слышно — вернее, не слышно. Громкостью тогда заведует сам элемент, и эта
    // ветка в движке уже есть и уже покрыта тестами.
    this.graphUnavailable = needsTaintedPlayback;

    this.boundTimeUpdate = this.handleTimeUpdate.bind(this);
    this.boundProgress = this.handleProgress.bind(this);
    this.boundEnded = this.handleEnded.bind(this);
    this.boundError = this.handleError.bind(this);
    this.boundPlaying = this.handlePlaying.bind(this);
    this.boundPause = this.handlePause.bind(this);
    this.boundWaiting = this.handleWaiting.bind(this);
    this.boundStalled = this.handleStalled.bind(this);
    this.boundMetadata = this.handleMetadata.bind(this);

    this.attachAudioListeners(this.audioA);
    this.attachAudioListeners(this.audioB);
  }

  // --- Backwards compatibility aliases ---
  public get audio(): HTMLAudioElement {
    return this.getActiveAudio();
  }

  public set audio(el: HTMLAudioElement) {
    if (this.activeDeck === 'A') {
      this.audioA = el;
    } else {
      this.audioB = el;
    }
  }

  public get gainNode(): GainNode | null {
    return this.masterGainNode;
  }

  public get sourceNode(): MediaElementAudioSourceNode | null {
    return this.activeDeck === 'A' ? this.sourceNodeA : this.sourceNodeB;
  }

  public getActiveAudio(): HTMLAudioElement {
    return this.activeDeck === 'A' ? this.audioA : this.audioB;
  }

  public getSecondaryAudio(): HTMLAudioElement {
    return this.activeDeck === 'A' ? this.audioB : this.audioA;
  }

  public getActiveDeck(): 'A' | 'B' {
    return this.activeDeck;
  }

  public getActiveGainNode(): GainNode | null {
    return this.activeDeck === 'A' ? this.gainNodeA : this.gainNodeB;
  }

  public getSecondaryGainNode(): GainNode | null {
    return this.activeDeck === 'A' ? this.gainNodeB : this.gainNodeA;
  }

  public getDeckAGainNode(): GainNode | null {
    return this.gainNodeA;
  }

  public getDeckBGainNode(): GainNode | null {
    return this.gainNodeB;
  }

  public getMasterGainNode(): GainNode | null {
    return this.masterGainNode;
  }

  public getCompressorNode(): DynamicsCompressorNode | null {
    return this.compressorNode;
  }

  public isCrossfadeEnabled(): boolean {
    return this.crossfadeEnabled;
  }

  public isCrossfadeInProgress(): boolean {
    return this.isCrossfading;
  }

  public getCrossfadeDuration(): number {
    return this.crossfadeDuration;
  }

  public setCrossfade(enabled: boolean, durationSec: number): void {
    this.crossfadeEnabled = Boolean(enabled);
    const dur = typeof durationSec === 'number' && Number.isFinite(durationSec) ? durationSec : 0;
    this.crossfadeDuration = Math.max(0, Math.min(12, dur));
  }

  public isLoudnessNormalizationEnabled(): boolean {
    return this.loudnessNormalization;
  }

  public setLoudnessNormalization(enabled: boolean): void {
    if (this.loudnessNormalization === enabled) return;
    this.loudnessNormalization = enabled;
    if (this.isGraphConnected) {
      this.connectGraph();
    }
  }

  /**
   * Builds the Web Audio graph:
   * Deck A -> Gain A \
   *                    --> [bass -> mid -> treble] -> analyser -> [DynamicsCompressorNode?] -> masterGain -> destination
   * Deck B -> Gain B /
   */
  private initAudioGraph(): void {
    if (this.isGraphConnected || this.graphUnavailable) return;
    if (typeof window === 'undefined') return;

    const activeAudio = this.getActiveAudio();
    if (!activeAudio || typeof activeAudio.addEventListener !== 'function') return;

    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      this.graphUnavailable = true;
      this.applyGainVolume();
      return;
    }

    try {
      if (!this.audioContext || this.audioContext.state === 'closed') {
        this.audioContext = new AudioContextClass();
        this.sourceNodeA = null;
        this.sourceNodeB = null;
        this.gainNodeA = null;
        this.gainNodeB = null;
        this.masterGainNode = null;
        this.compressorNode = null;
        this.analyserNode = null;
        this.eqNodes = null;
      }

      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }

      if (!this.sourceNodeA && this.audioA && typeof this.audioA.addEventListener === 'function') {
        this.sourceNodeA = this.audioContext.createMediaElementSource(this.audioA);
      }
      if (!this.sourceNodeB && this.audioB && typeof this.audioB.addEventListener === 'function') {
        this.sourceNodeB = this.audioContext.createMediaElementSource(this.audioB);
      }

      if (!this.gainNodeA) {
        this.gainNodeA = this.audioContext.createGain();
        this.gainNodeA.gain.value = this.activeDeck === 'A' ? 1.0 : 0.0;
      }
      if (!this.gainNodeB) {
        this.gainNodeB = this.audioContext.createGain();
        this.gainNodeB.gain.value = this.activeDeck === 'B' ? 1.0 : 0.0;
      }

      if (!this.masterGainNode) {
        this.masterGainNode = this.audioContext.createGain();
      }

      if (!this.compressorNode && typeof this.audioContext.createDynamicsCompressor === 'function') {
        this.compressorNode = this.createCompressorNode(this.audioContext);
      }

      if (!this.analyserNode) {
        this.analyserNode = this.audioContext.createAnalyser();
        this.analyserNode.fftSize = 256;
        this.analyserNode.smoothingTimeConstant = 0.8;
      }

      if (!this.eqNodes) {
        this.eqNodes = this.createEqNodes(this.audioContext);
      }

      this.connectGraph();
      this.isGraphConnected = true;

      // The elements themselves must stay transparent once the gain nodes drive output
      if (this.audioA && typeof this.audioA === 'object') {
        this.audioA.volume = 1;
        this.audioA.muted = false;
      }
      if (this.audioB && typeof this.audioB === 'object') {
        this.audioB.volume = 1;
        this.audioB.muted = false;
      }

      this.applyEqGains();
      this.applyGainVolume();
    } catch (err) {
      this.releaseGraphNodes();
      this.graphUnavailable = true;
      this.applyGainVolume();
      console.warn('[AudioEngine] Web Audio graph unavailable, using element volume:', err);
    }
  }

  /**
   * Creates the DynamicsCompressorNode for loudness normalization.
   * Threshold: -24dB, Knee: 30dB, Ratio: 4:1, Attack: 0.003s, Release: 0.25s
   */
  private createCompressorNode(context: AudioContext): DynamicsCompressorNode | null {
    if (typeof context.createDynamicsCompressor !== 'function') return null;

    try {
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 30;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      return compressor;
    } catch (err) {
      console.warn('[AudioEngine] DynamicsCompressorNode unavailable:', err);
      return null;
    }
  }

  /**
   * Creates the 3-band EQ chain. Returns null where BiquadFilterNode is absent
   */
  private createEqNodes(context: AudioContext): EqNodes | null {
    if (typeof context.createBiquadFilter !== 'function') return null;

    try {
      const bass = context.createBiquadFilter();
      bass.type = 'lowshelf';
      bass.frequency.value = 120;

      const mid = context.createBiquadFilter();
      mid.type = 'peaking';
      mid.frequency.value = 1000;
      mid.Q.value = 1;

      const treble = context.createBiquadFilter();
      treble.type = 'highshelf';
      treble.frequency.value = 6000;

      return { bass, mid, treble };
    } catch (err) {
      console.warn('[AudioEngine] EQ filters unavailable:', err);
      return null;
    }
  }

  private connectGraph(): void {
    if (!this.audioContext || !this.masterGainNode || !this.analyserNode) return;

    this.disconnectGraph();

    const downstreamBus: AudioNode = this.eqNodes?.bass ?? this.analyserNode;

    // Connect Deck A
    if (this.sourceNodeA && this.gainNodeA) {
      this.sourceNodeA.connect(this.gainNodeA);
      this.gainNodeA.connect(downstreamBus);
    }

    // Connect Deck B
    if (this.sourceNodeB && this.gainNodeB) {
      this.sourceNodeB.connect(this.gainNodeB);
      this.gainNodeB.connect(downstreamBus);
    }

    // Connect EQ filters if present
    if (this.eqNodes) {
      this.eqNodes.bass.connect(this.eqNodes.mid);
      this.eqNodes.mid.connect(this.eqNodes.treble);
      this.eqNodes.treble.connect(this.analyserNode);
    }

    // Analyser -> DynamicsCompressorNode (if enabled) -> Master Gain -> Destination
    if (this.loudnessNormalization && this.compressorNode) {
      this.analyserNode.connect(this.compressorNode);
      this.compressorNode.connect(this.masterGainNode);
    } else {
      this.analyserNode.connect(this.masterGainNode);
    }

    this.masterGainNode.connect(this.audioContext.destination);
  }

  private disconnectGraph(): void {
    const nodes: Array<AudioNode | null> = [
      this.sourceNodeA,
      this.sourceNodeB,
      this.gainNodeA,
      this.gainNodeB,
      this.eqNodes?.bass ?? null,
      this.eqNodes?.mid ?? null,
      this.eqNodes?.treble ?? null,
      this.analyserNode,
      this.compressorNode,
      this.masterGainNode
    ];

    for (const node of nodes) {
      if (!node || typeof node.disconnect !== 'function') continue;
      try {
        node.disconnect();
      } catch {
        // Already disconnected
      }
    }
  }

  private releaseGraphNodes(): void {
    this.disconnectGraph();
    this.sourceNodeA = null;
    this.sourceNodeB = null;
    this.gainNodeA = null;
    this.gainNodeB = null;
    this.masterGainNode = null;
    this.compressorNode = null;
    this.analyserNode = null;
    this.eqNodes = null;
    this.isGraphConnected = false;
  }

  private attachAudioListeners(audio: HTMLAudioElement): void {
    if (!audio || typeof audio.addEventListener !== 'function') return;

    audio.addEventListener('timeupdate', this.boundTimeUpdate);
    audio.addEventListener('progress', this.boundProgress);
    audio.addEventListener('ended', this.boundEnded);
    audio.addEventListener('error', this.boundError);
    audio.addEventListener('playing', this.boundPlaying);
    audio.addEventListener('pause', this.boundPause);
    audio.addEventListener('waiting', this.boundWaiting);
    audio.addEventListener('stalled', this.boundStalled);
    audio.addEventListener('loadedmetadata', this.boundMetadata);
    audio.addEventListener('durationchange', this.boundMetadata);
    audio.addEventListener('canplay', this.boundMetadata);
  }

  private detachAudioListeners(audio: HTMLAudioElement): void {
    if (!audio || typeof audio.removeEventListener !== 'function') return;

    audio.removeEventListener('timeupdate', this.boundTimeUpdate);
    audio.removeEventListener('progress', this.boundProgress);
    audio.removeEventListener('ended', this.boundEnded);
    audio.removeEventListener('error', this.boundError);
    audio.removeEventListener('playing', this.boundPlaying);
    audio.removeEventListener('pause', this.boundPause);
    audio.removeEventListener('waiting', this.boundWaiting);
    audio.removeEventListener('stalled', this.boundStalled);
    audio.removeEventListener('loadedmetadata', this.boundMetadata);
    audio.removeEventListener('durationchange', this.boundMetadata);
    audio.removeEventListener('canplay', this.boundMetadata);
  }

  /**
   * Loads a track and resolves its stream URL.
   * If DJ crossfade is active (>0s duration, currently playing another track),
   * seamlessly crossfades between Deck A and Deck B.
   */
  public async load(track: UnifiedTrack, autoPlay: boolean = true): Promise<void> {
    if (!track) {
      throw new Error('Cannot load null or undefined track');
    }

    const currentLoadId = ++this.loadRequestId;
    const shouldCrossfade =
      this.crossfadeEnabled &&
      this.crossfadeDuration > 0 &&
      this.state === 'playing' &&
      this.currentTrack !== null &&
      this.currentTrack.id !== track.id;

    if (shouldCrossfade) {
      await this.executeCrossfade(track, currentLoadId, autoPlay);
      return;
    }

    // Direct / standard load on the active deck
    this.clearCrossfadeTimer();
    this.isCrossfading = false;
    this.clearStallWatchdog();
    this.clearLoadWatchdog();
    this.clearHealthTimer();
    this.currentTrack = { ...track };
    this.pendingSeek = null;
    this.retryCount = 0;
    this.isRecovering = false;
    this.lastCurrentTime = -1;
    this.setState('loading');

    try {
      this.initAudioGraph();

      let streamUrl = track.streamUrl;
      let streamFormat = track.format;
      const now = Date.now();

      // Resolve stream if missing or expired
      if (!streamUrl || (track.streamExpiry && track.streamExpiry < now + 30000)) {
        const resolved = await this.resolver.resolve(track);
        if (currentLoadId !== this.loadRequestId) return; // Abort silently

        streamUrl = resolved.streamUrl;
        streamFormat = resolved.format;
        this.currentTrack = {
          ...this.currentTrack,
          streamUrl: resolved.streamUrl,
          streamExpiry: resolved.expiresAt,
          format: resolved.format,
          bitrate: resolved.bitrate,
          isPreview: resolved.isPreview === true
        };
      }

      if (currentLoadId !== this.loadRequestId) return; // Abort silently

      if (!streamUrl) {
        throw new Error(`Failed to resolve direct streaming URL for track: ${track.title}`);
      }

      const activeAudio = this.getActiveAudio();
      const secondaryAudio = this.getSecondaryAudio();

      // Stop secondary deck
      if (secondaryAudio && typeof secondaryAudio.pause === 'function') {
        try {
          secondaryAudio.pause();
          secondaryAudio.src = '';
        } catch {}
      }
      this.destroyHlsForDeck(this.activeDeck === 'A' ? 'B' : 'A');
      this.destroyHlsForDeck(this.activeDeck);

      // Align deck gains
      const activeGain = this.getActiveGainNode();
      const secondaryGain = this.getSecondaryGainNode();
      if (this.audioContext && activeGain && secondaryGain) {
        const ctxTime = this.audioContext.currentTime;
        activeGain.gain.cancelScheduledValues(ctxTime);
        activeGain.gain.setValueAtTime(1.0, ctxTime);
        secondaryGain.gain.cancelScheduledValues(ctxTime);
        secondaryGain.gain.setValueAtTime(0.0, ctxTime);
      }

      if (activeAudio) {
        if (streamFormat === 'hls' || isHlsUrl(streamUrl)) {
          const handle = await attachHls(activeAudio, streamUrl, {
            onError: (err: Error) => this.handleHlsRuntimeError(err, streamUrl as string)
          });

          if (currentLoadId !== this.loadRequestId) {
            handle.destroy();
            return;
          }
          if (this.activeDeck === 'A') {
            this.hlsHandleA = handle;
          } else {
            this.hlsHandleB = handle;
          }
        } else {
          activeAudio.src = streamUrl;
          activeAudio.load();
          // The load algorithm resets playbackRate, so the chosen speed is re-applied.
          this.applyPlaybackRate();
        }
      }

      if (autoPlay) {
        // Заводим до `play()`: его промис разрешается только когда звук
        // действительно пошёл, так что при мёртвой ссылке ждать здесь можно
        // бесконечно, и завести сторож после уже не выйдет.
        this.startLoadWatchdog(currentLoadId);
        await this.play();
      }
    } catch (err: unknown) {
      if (currentLoadId !== this.loadRequestId) return;
      this.clearLoadWatchdog();
      this.setState('error');
      this.emitError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /**
   * Performs a smooth DJ crossfade transition from active deck to secondary deck.
   * Ramps gains smoothly via linearRampToValueAtTime (0s-12s).
   */
  private async executeCrossfade(track: UnifiedTrack, currentLoadId: number, autoPlay: boolean): Promise<void> {
    const outgoingDeck = this.activeDeck;
    const incomingDeck = outgoingDeck === 'A' ? 'B' : 'A';
    const outgoingAudio = outgoingDeck === 'A' ? this.audioA : this.audioB;
    const incomingAudio = incomingDeck === 'A' ? this.audioA : this.audioB;

    this.clearCrossfadeTimer();
    this.isCrossfading = true;

    try {
      this.initAudioGraph();

      let streamUrl = track.streamUrl;
      let streamFormat = track.format;
      const nowMs = Date.now();

      if (!streamUrl || (track.streamExpiry && track.streamExpiry < nowMs + 30000)) {
        const resolved = await this.resolver.resolve(track);
        if (currentLoadId !== this.loadRequestId) return;

        streamUrl = resolved.streamUrl;
        streamFormat = resolved.format;
      }

      if (currentLoadId !== this.loadRequestId) return;

      if (!streamUrl) {
        throw new Error(`Failed to resolve direct streaming URL for crossfade track: ${track.title}`);
      }

      this.destroyHlsForDeck(incomingDeck);

      if (incomingAudio) {
        if (streamFormat === 'hls' || isHlsUrl(streamUrl)) {
          const handle = await attachHls(incomingAudio, streamUrl, {
            onError: (err: Error) => this.handleHlsRuntimeError(err, streamUrl as string)
          });

          if (currentLoadId !== this.loadRequestId) {
            handle.destroy();
            return;
          }
          if (incomingDeck === 'A') {
            this.hlsHandleA = handle;
          } else {
            this.hlsHandleB = handle;
          }
        } else {
          incomingAudio.src = streamUrl;
          incomingAudio.load();
          // The load algorithm resets playbackRate, so the chosen speed is re-applied.
          this.applyPlaybackRate();
          await this.waitForBufferReady(incomingAudio);
        }
      }

      if (currentLoadId !== this.loadRequestId) return;

      const outgoingGain = outgoingDeck === 'A' ? this.gainNodeA : this.gainNodeB;
      const incomingGain = incomingDeck === 'A' ? this.gainNodeA : this.gainNodeB;
      const xfadeDur = this.crossfadeDuration;

      // Web Audio smooth gain ramps
      if (this.audioContext && outgoingGain && incomingGain) {
        const now = this.audioContext.currentTime;
        const currentOutgoingVal = typeof outgoingGain.gain.value === 'number' ? outgoingGain.gain.value : 1.0;

        outgoingGain.gain.cancelScheduledValues(now);
        outgoingGain.gain.setValueAtTime(currentOutgoingVal, now);
        outgoingGain.gain.linearRampToValueAtTime(0.0001, now + xfadeDur);

        incomingGain.gain.cancelScheduledValues(now);
        incomingGain.gain.setValueAtTime(0.0001, now);
        incomingGain.gain.linearRampToValueAtTime(1.0, now + xfadeDur);
      }

      // Start playback on incoming deck early
      if (autoPlay && incomingAudio && typeof incomingAudio.play === 'function') {
        try {
          await incomingAudio.play();
        } catch (err: unknown) {
          if (currentLoadId !== this.loadRequestId) return;
          if (!isBenignPlayInterruption(err)) throw err;

          // Старт входящей колоды прервали (обычно паузой прямо во время
          // кроссфейда). Переход не состоялся, поэтому колоду не меняем, а
          // громкости возвращаем к исходным — иначе исходящая уедет в тишину.
          this.isCrossfading = false;
          if (this.audioContext && outgoingGain && incomingGain) {
            const abortTime = this.audioContext.currentTime;
            outgoingGain.gain.cancelScheduledValues(abortTime);
            outgoingGain.gain.setValueAtTime(1.0, abortTime);
            incomingGain.gain.cancelScheduledValues(abortTime);
            incomingGain.gain.setValueAtTime(0.0, abortTime);
          }
          return;
        }
      }

      // Update active deck reference and track
      this.activeDeck = incomingDeck;
      this.currentTrack = {
        ...track,
        streamUrl,
        format: streamFormat
      };
      this.lastCurrentTime = -1;
      this.setState('playing');

      // Finalize crossfade when transition completes
      this.crossfadeTimer = setTimeout(() => {
        this.isCrossfading = false;
        this.crossfadeTimer = null;

        if (outgoingAudio && typeof outgoingAudio.pause === 'function') {
          try {
            outgoingAudio.pause();
            outgoingAudio.src = '';
          } catch {}
        }
        this.destroyHlsForDeck(outgoingDeck);

        if (this.audioContext && outgoingGain && incomingGain) {
          const finishTime = this.audioContext.currentTime;
          outgoingGain.gain.setValueAtTime(0, finishTime);
          incomingGain.gain.setValueAtTime(1.0, finishTime);
        }
      }, xfadeDur * 1000);
    } catch (err) {
      if (currentLoadId !== this.loadRequestId) return;
      this.isCrossfading = false;
      this.setState('error');
      this.emitError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  private handleHlsRuntimeError(error: Error, url: string): void {
    const handle = this.activeDeck === 'A' ? this.hlsHandleA : this.hlsHandleB;
    if (!handle || handle.url !== url) return;
    if (!error.message.startsWith('HLS playback unavailable')) {
      console.warn('[AudioEngine] Recoverable HLS problem:', error.message);
      return;
    }
    this.setState('error');
    this.emitError(error);
  }

  private destroyHlsForDeck(deck: 'A' | 'B'): void {
    const handle = deck === 'A' ? this.hlsHandleA : this.hlsHandleB;
    if (!handle) return;
    if (deck === 'A') this.hlsHandleA = null;
    else this.hlsHandleB = null;
    try {
      handle.destroy();
    } catch (err) {
      console.warn(`[AudioEngine] Failed to release HLS handle on Deck ${deck}:`, err);
    }
  }

  private destroyHls(): void {
    this.destroyHlsForDeck('A');
    this.destroyHlsForDeck('B');
  }

  private clearCrossfadeTimer(): void {
    if (this.crossfadeTimer !== null) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
  }

  /**
   * Resumes or starts playback
   */
  public async play(): Promise<void> {
    this.initAudioGraph();

    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const activeAudio = this.getActiveAudio();
    if (activeAudio && typeof activeAudio.play === 'function') {
      const currentReqId = ++this.playRequestId;
      const currentLoadId = this.loadRequestId;
      try {
        await activeAudio.play();
        if (currentReqId !== this.playRequestId || !activeAudio || activeAudio.paused) return;
        this.setState('playing');
      } catch (err: unknown) {
        // Запрос устарел: пока промис play() висел, пришёл новый play/pause или
        // новая загрузка. Ошибка принадлежит проигравшей гонку попытке, а решать
        // судьбу состояния будет та, что победила, — выходим молча.
        const superseded = currentReqId !== this.playRequestId || currentLoadId !== this.loadRequestId;

        if (superseded || isBenignPlayInterruption(err)) {
          if (!superseded) {
            // Смены не пришло: играть уже не начнём, но и пугать нечем — это
            // просто прерванный старт, а не сбой источника.
            this.setState('paused');
          }
          return;
        }

        this.setState('error');
        const message = err instanceof Error ? err.message : String(err);
        const error = new Error(`Audio playback failed: ${message}`);
        this.emitError(error);
        throw error;
      }
    }
  }

  /**
   * Pauses playback
   */
  public pause(): void {
    this.playRequestId++;
    // Снимаем сторож здесь, а не только в обработчике `pause`: если человек
    // остановил именно зависшее включение, элемент может не прислать события, и
    // тогда таймер сработал бы уже по остановленному треку.
    this.clearLoadWatchdog();
    const activeAudio = this.getActiveAudio();
    if (activeAudio && typeof activeAudio.pause === 'function') {
      activeAudio.pause();
    }
    const secondaryAudio = this.getSecondaryAudio();
    if (secondaryAudio && typeof secondaryAudio.pause === 'function') {
      secondaryAudio.pause();
    }
    this.setState('paused');
  }

  /**
   * Seeks to a position in seconds
   */
  public seek(timeInSeconds: number): void {
    const activeAudio = this.getActiveAudio();
    if (!activeAudio || typeof timeInSeconds !== 'number' || Number.isNaN(timeInSeconds)) return;

    const target = timeInSeconds < 0 ? 0 : timeInSeconds;
    const duration = this.getDuration();

    if (duration > 0) {
      this.pendingSeek = null;
      this.applySeek(Math.min(target, duration), false);
      return;
    }

    if (target === 0) {
      this.pendingSeek = null;
      this.applySeek(0, false);
      return;
    }

    if (!Number.isFinite(target)) return;

    if (this.isWithinSeekable(target)) {
      this.pendingSeek = null;
      this.applySeek(target, true);
      return;
    }

    this.pendingSeek = target;
  }

  private applySeek(time: number, preferFastSeek: boolean): void {
    if (!Number.isFinite(time)) return;

    const activeAudio = this.getActiveAudio() as HTMLAudioElement & { fastSeek?: (time: number) => void };
    try {
      if (preferFastSeek && typeof activeAudio.fastSeek === 'function') {
        activeAudio.fastSeek(time);
      } else if (activeAudio) {
        activeAudio.currentTime = time;
      }
    } catch (err) {
      console.warn('[AudioEngine] Seek rejected by media element:', err);
    }
    this.handleTimeUpdate();
  }

  private flushPendingSeek(): boolean {
    const pending = this.pendingSeek;
    if (pending === null) return false;

    const duration = this.getDuration();
    if (duration > 0) {
      this.pendingSeek = null;
      this.applySeek(Math.min(pending, duration), true);
      return true;
    }

    if (this.isWithinSeekable(pending)) {
      this.pendingSeek = null;
      this.applySeek(pending, true);
      return true;
    }

    return false;
  }

  private isWithinSeekable(time: number): boolean {
    const seekable = this.getActiveAudio()?.seekable;
    if (!seekable || typeof seekable.length !== 'number' || seekable.length === 0) return false;

    try {
      for (let i = 0; i < seekable.length; i++) {
        if (time >= seekable.start(i) && time <= seekable.end(i)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Sets volume with quadratic perceptual curve V = x^2
   */
  public setVolume(volume: number): void {
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
    this.cancelVolumeFade();
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyGainVolume();
  }

  /**
   * Toggles or sets muted state
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGainVolume();
  }

  /**
   * Ramps output toward `target` over `durationMs`
   */
  public fadeVolumeTo(target: number, durationMs: number): Promise<void> {
    const clampedTarget = typeof target === 'number' && Number.isFinite(target) ? Math.max(0, Math.min(1, target)) : 0;
    const effectiveVolume = this.volume > 0 ? this.volume : 1;
    const targetMultiplier = Math.min(1, clampedTarget / effectiveVolume);

    this.clearFadeTimer();
    const token = ++this.fadeToken;
    const startMultiplier = this.fadeMultiplier;
    const steps = Math.max(1, Math.round(Math.max(0, durationMs) / FADE_STEP_MS));

    return new Promise<void>((resolve) => {
      let step = 0;
      this.fadeTimer = setInterval(() => {
        if (token !== this.fadeToken) {
          resolve();
          return;
        }
        step += 1;
        const ratio = Math.min(1, step / steps);
        this.fadeMultiplier = startMultiplier + (targetMultiplier - startMultiplier) * ratio;
        this.applyGainVolume();
        if (step >= steps) {
          this.clearFadeTimer();
          resolve();
        }
      }, FADE_STEP_MS);
    });
  }

  public cancelVolumeFade(): void {
    this.fadeToken++;
    this.clearFadeTimer();
    if (this.fadeMultiplier !== 1) {
      this.fadeMultiplier = 1;
      this.applyGainVolume();
    }
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer !== null) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  /**
   * Applies perceptual volume curve to Master GainNode or fallback HTMLAudioElement
   */
  private applyGainVolume(): void {
    // V = x^2 perceptual curve, scaled by any active volume fade
    const effectiveVolume = (this.muted ? 0 : this.volume * this.volume) * this.fadeMultiplier;

    if (this.masterGainNode && this.audioContext) {
      try {
        const currentTime = this.audioContext.currentTime;
        this.masterGainNode.gain.cancelScheduledValues(currentTime);
        this.masterGainNode.gain.setValueAtTime(this.masterGainNode.gain.value, currentTime);
        // Smooth 20ms ramp to eliminate pop/click
        this.masterGainNode.gain.linearRampToValueAtTime(effectiveVolume, currentTime + 0.02);
      } catch {
        this.masterGainNode.gain.value = effectiveVolume;
      }
    }

    // Also sync HTMLAudioElements volume as fallback when graph unavailable
    if (!this.isGraphConnected) {
      const activeAudio = this.getActiveAudio();
      if (activeAudio && typeof activeAudio.volume === 'number') {
        activeAudio.volume = effectiveVolume;
        activeAudio.muted = this.muted;
      }
    }
  }

  /**
   * Sets 3-band EQ gains in dB, clamped to -12..+12
   */
  public setEqGains(gains: Partial<EqSettings>): void {
    this.eqGains = {
      bass: this.clampGainDb(gains.bass, this.eqGains.bass),
      mid: this.clampGainDb(gains.mid, this.eqGains.mid),
      treble: this.clampGainDb(gains.treble, this.eqGains.treble)
    };
    this.applyEqGains();
  }

  public getEqGains(): EqSettings {
    return { ...this.eqGains };
  }

  /**
   * Sets playback speed on both decks.
   *
   * `preservesPitch: false` is the point of the feature — slowed and sped-up
   * edits are defined by the pitch moving with the tempo. Chromium defaults it to
   * true, which sounds like a tempo-shifted karaoke track instead.
   *
   * Applied to both decks so a crossfade does not jump back to normal speed
   * mid-transition, and re-applied on every `load` because a fresh `src` resets
   * the property.
   *
   * @param rate 0.5–2.0; values outside the range are clamped
   * @param preservePitch true keeps the original key (tempo-only change)
   */
  public setPlaybackRate(rate: number, preservePitch: boolean = false): void {
    const safe = typeof rate === 'number' && Number.isFinite(rate)
      ? Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, rate))
      : 1;
    this.playbackRate = safe;
    this.preservePitch = preservePitch;
    this.applyPlaybackRate();
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
  }

  public getPreservesPitch(): boolean {
    return this.preservePitch;
  }

  /** Pushes the current rate onto both media elements, tolerating old engines. */
  private applyPlaybackRate(): void {
    for (const element of [this.audioA, this.audioB]) {
      if (!element) continue;
      try {
        element.playbackRate = this.playbackRate;
        // Vendor-prefixed on older WebKit; jsdom has neither.
        const withPitch = element as HTMLAudioElement & {
          preservesPitch?: boolean;
          webkitPreservesPitch?: boolean;
        };
        if ('preservesPitch' in withPitch) {
          withPitch.preservesPitch = this.preservePitch;
        }
        if ('webkitPreservesPitch' in withPitch) {
          withPitch.webkitPreservesPitch = this.preservePitch;
        }
      } catch (err) {
        console.warn('[AudioEngine] Failed to apply playback rate:', err);
      }
    }
  }

  private clampGainDb(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(-EQ_GAIN_LIMIT_DB, Math.min(EQ_GAIN_LIMIT_DB, value));
  }

  private applyEqGains(): void {
    if (!this.eqNodes) return;
    try {
      this.eqNodes.bass.gain.value = this.eqGains.bass;
      this.eqNodes.mid.gain.value = this.eqGains.mid;
      this.eqNodes.treble.gain.value = this.eqGains.treble;
    } catch (err) {
      console.warn('[AudioEngine] Failed to apply EQ gains:', err);
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public getCurrentTime(): number {
    const current = this.getActiveAudio()?.currentTime;
    return typeof current === 'number' && Number.isFinite(current) ? current : 0;
  }

  public getDuration(): number {
    const elementDuration = this.getActiveAudio()?.duration;
    if (typeof elementDuration === 'number' && Number.isFinite(elementDuration) && elementDuration > 0) {
      return elementDuration;
    }

    const trackDuration = this.currentTrack?.duration;
    if (typeof trackDuration === 'number' && Number.isFinite(trackDuration) && trackDuration > 0) {
      return trackDuration;
    }

    return 0;
  }

  public getBuffered(): number {
    const activeAudio = this.getActiveAudio();
    if (!activeAudio || !activeAudio.buffered || activeAudio.buffered.length === 0) {
      return 0;
    }
    try {
      const end = activeAudio.buffered.end(activeAudio.buffered.length - 1);
      return Number.isFinite(end) ? end : 0;
    } catch {
      return 0;
    }
  }

  public getState(): PlaybackState {
    return this.state;
  }

  public getCurrentTrack(): UnifiedTrack | null {
    return this.currentTrack;
  }

  public getAudioContext(): AudioContext | null {
    return this.audioContext;
  }

  public getAnalyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  /**
   * Reads real-time frequency spectrum from AnalyserNode.
   *
   * The buffer is reused between calls, so a caller must read it before the next
   * frame instead of keeping the reference: the visualisers ask for this sixty
   * times per second, and a fresh 1 KB array each time is a megabyte of garbage
   * per minute for data that is stale the moment the frame ends.
   */
  public getFrequencyData(): Uint8Array {
    if (!this.analyserNode) {
      if (this.frequencyBuffer.length !== 128) {
        this.frequencyBuffer = new Uint8Array(128);
      }
      return this.frequencyBuffer;
    }
    if (this.frequencyBuffer.length !== this.analyserNode.frequencyBinCount) {
      this.frequencyBuffer = new Uint8Array(this.analyserNode.frequencyBinCount);
    }
    this.analyserNode.getByteFrequencyData(this.frequencyBuffer);
    return this.frequencyBuffer;
  }

  // --- Subscriptions ---

  public onTimeUpdate(callback: TimeUpdateCallback): () => void {
    this.timeUpdateListeners.add(callback);
    return () => this.timeUpdateListeners.delete(callback);
  }

  public onEnded(callback: EndedCallback): () => void {
    this.endedListeners.add(callback);
    return () => this.endedListeners.delete(callback);
  }

  public onError(callback: ErrorCallback): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  public onStateChange(callback: StateChangeCallback): () => void {
    this.stateChangeListeners.add(callback);
    return () => this.stateChangeListeners.delete(callback);
  }

  // --- Internal Event Handlers ---

  private startStallWatchdog(): void {
    if (this.stallWatchdogTimer !== null || this.isRecovering) return;
    const activeAudio = this.getActiveAudio();
    if (!activeAudio || activeAudio.paused || activeAudio.ended) return;

    this.stallWatchdogTimer = setTimeout(() => {
      this.stallWatchdogTimer = null;
      const currentActive = this.getActiveAudio();
      if (
        !this.isRecovering &&
        currentActive &&
        !currentActive.paused &&
        !currentActive.ended &&
        this.currentTrack &&
        // `loading` тоже считается зависанием. Первое включение трека проводит
        // здесь всё время до начала звука, и `waiting` в этом состоянии не
        // повышает его до `buffering` — без этой ветки самый частый случай
        // («погрузилось чуть-чуть и встало») до восстановления не доходил.
        (this.state === 'buffering' || this.state === 'playing' || this.state === 'loading')
      ) {
        console.warn('[AudioEngine] Playback stalled for 3.5s without progress, initiating auto-recovery');
        void this.recoverStream('Playback stall watchdog triggered');
      }
    }, 3500);
  }

  /**
   * Ждёт, не поедет ли трек сам.
   *
   * Возвращает `true`, если позиция сдвинулась, — значит поток жив и чинить
   * нечего. Проверка идёт по позиции, а не по событиям: событие `playing`
   * приходит и тогда, когда элемент дёрнулся на месте.
   */
  /**
   * Пишет строку в журнал главного процесса — тот же, где история ссылок.
   *
   * Заминки до этого попадали только в консоль окна, которую никто не
   * открывает: человек говорит «поиграло и повисло», а посмотреть нечего. В
   * браузере и на телефоне моста нет, и это не отказ — просто писать некуда.
   */
  private noteToLog(message: string): void {
    console.info(`[AudioEngine] ${message}`);
    try {
      void (window as { electronAPI?: { playbackLog?: (m: string) => Promise<boolean> } })
        .electronAPI?.playbackLog?.(message);
    } catch {
      // Журнал — не причина ломать воспроизведение.
    }
  }

  private async waitForOwnRecovery(track: UnifiedTrack, windowMs: number): Promise<boolean> {
    const audio = this.getActiveAudio();
    if (!audio || audio.paused || audio.ended) return false;

    const startedAt = audio.currentTime;
    const deadline = Date.now() + windowMs;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Пока ждали, человек мог переключить трек или нажать паузу — тогда
      // чинить уже нечего и незачем.
      if (this.currentTrack?.id !== track.id) return true;
      const current = this.getActiveAudio();
      if (!current || current.paused || current.ended) return false;
      if (current.currentTime > startedAt + 0.15) return true;
    }

    return false;
  }

  private clearStallWatchdog(): void {
    if (this.stallWatchdogTimer !== null) {
      clearTimeout(this.stallWatchdogTimer);
      this.stallWatchdogTimer = null;
    }
  }

  /**
   * Заводит проверку того, что включение вообще дошло до звука.
   *
   * Событийный сторож ловит только обрыв уже начавшегося потока: он привязан к
   * `waiting` и `stalled` и не заводится на паузе. Но самый частый обрыв
   * происходит раньше — ссылку выдали, `src` присвоили, а байты либо не пошли,
   * либо кончились на первых килобайтах. Тогда элемент молчит: ни `waiting`, ни
   * `stalled`, ни `error`, и на экране навсегда остаётся загрузка. Этот таймер
   * ни от каких событий не зависит и потому закрывает именно этот случай.
   *
   * @param loadId номер попытки: пока таймер ждёт, человек мог включить другое,
   *   и тогда чинить эту загрузку уже некому.
   */
  private startLoadWatchdog(loadId: number): void {
    this.clearLoadWatchdog();
    this.loadWatchdogTimer = setTimeout(() => {
      this.loadWatchdogTimer = null;
      if (loadId !== this.loadRequestId || this.isRecovering || !this.currentTrack) return;
      // Дошло до звука или до честной ошибки — вмешиваться незачем.
      if (this.state !== 'loading' && this.state !== 'buffering') return;
      const activeAudio = this.getActiveAudio();
      // Позиция сдвинулась — значит поток идёт, просто медленно.
      if (activeAudio && activeAudio.currentTime > 0) return;
      console.warn(
        `[AudioEngine] Track never started playing within ${LOAD_WATCHDOG_MS}ms, initiating auto-recovery`
      );
      void this.recoverStream('Load watchdog triggered');
    }, LOAD_WATCHDOG_MS);
  }

  private clearLoadWatchdog(): void {
    if (this.loadWatchdogTimer !== null) {
      clearTimeout(this.loadWatchdogTimer);
      this.loadWatchdogTimer = null;
    }
  }

  private startHealthTimer(): void {
    this.clearHealthTimer();
    this.healthResetTimer = setTimeout(() => {
      if (this.state === 'playing' && !this.isRecovering) {
        this.retryCount = 0;
      }
    }, 10000);
  }

  private clearHealthTimer(): void {
    if (this.healthResetTimer !== null) {
      clearTimeout(this.healthResetTimer);
      this.healthResetTimer = null;
    }
  }

  private waitForBufferReady(audio: HTMLAudioElement, timeoutMs: number = 2500): Promise<void> {
    if (!audio || typeof audio.addEventListener !== 'function') {
      return Promise.resolve();
    }
    if (audio.readyState === undefined || audio.readyState >= 2) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.removeEventListener('canplay', onReady);
        audio.removeEventListener('loadeddata', onReady);
        audio.removeEventListener('loadedmetadata', onReady);
        audio.removeEventListener('error', onError);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      audio.addEventListener('canplay', onReady, { once: true });
      audio.addEventListener('loadeddata', onReady, { once: true });
      audio.addEventListener('loadedmetadata', onReady, { once: true });
      audio.addEventListener('error', onError, { once: true });
    });
  }

  private handleTimeUpdate(e?: Event): void {
    // If event fired from secondary deck while not in active use, skip
    if (e && e.target && e.target !== this.getActiveAudio()) {
      return;
    }

    const curTime = this.getCurrentTime();
    const dur = this.getDuration();
    const buf = this.getBuffered();

    if (curTime !== this.lastCurrentTime) {
      this.lastCurrentTime = curTime;
      this.clearStallWatchdog();
      // Позиция поехала — включение состоялось, дальше следит обычный сторож.
      this.clearLoadWatchdog();
      const activeAudio = this.getActiveAudio();
      if (this.state === 'buffering' && activeAudio && !activeAudio.paused && !this.isRecovering) {
        this.setState('playing');
        this.startHealthTimer();
      }
    }

    for (const listener of this.timeUpdateListeners) {
      try {
        listener(curTime, dur, buf);
      } catch (err) {
        console.error('[AudioEngine] Error in timeUpdate listener:', err);
      }
    }
  }

  private handleProgress(e?: Event): void {
    if (e && e.target && e.target !== this.getActiveAudio()) {
      return;
    }
    this.handleTimeUpdate();
  }

  private handleMetadata(e?: Event): void {
    if (e && e.target && e.target !== this.getActiveAudio()) {
      return;
    }
    if (!this.flushPendingSeek()) {
      this.handleTimeUpdate();
    }
  }

  private handleEnded(e?: Event): void {
    if (e && e.target && e.target !== this.getActiveAudio()) {
      return;
    }
    this.clearStallWatchdog();
    this.clearLoadWatchdog();
    this.clearHealthTimer();
    for (const listener of this.endedListeners) {
      try {
        listener();
      } catch (err) {
        console.error('[AudioEngine] Error in ended listener:', err);
      }
    }
  }

  private handleStalled(e?: Event): void {
    if (e && e.target && e.target !== this.getActiveAudio()) {
      return;
    }
    // `loading` — состояние первого включения: если байты перестали идти именно
    // здесь, сторожевой таймер нужен ровно так же, как посреди трека.
    if (this.state === 'playing' || this.state === 'buffering' || this.state === 'loading') {
      this.startStallWatchdog();
    }
  }

  private async handleError(e?: Event): Promise<void> {
    const activeAudio = this.getActiveAudio();
    if (e && e.target && e.target !== activeAudio) {
      return;
    }

    if (activeAudio?.error && activeAudio.error.code === 1) {
      // MEDIA_ERR_ABORTED - User / code switched track, not a fatal failure
      return;
    }

    const errorReason = activeAudio?.error
      ? `MediaError [${activeAudio.error.code}]: ${activeAudio.error.message || 'Stream error'}`
      : 'Audio stream error';

    await this.recoverStream(errorReason);
  }

  private async recoverStream(reason: string, initialError?: Error): Promise<void> {
    const activeAudio = this.getActiveAudio();
    if (activeAudio?.error && activeAudio.error.code === 1) {
      return;
    }

    const currentTrack = this.currentTrack;
    if (!currentTrack) {
      return;
    }
    /**
     * Самая дальняя точка, до которой трек реально доиграл.
     *
     * Именно «самая дальняя», а не «текущая», и это починка настоящей беды.
     * Раньше позиция снималась здесь один раз и использовалась всеми тремя
     * попытками: вторая и третья отматывали трек назад, туда же, где он в
     * первый раз сломался. Снаружи это слышно как один и тот же кусок,
     * проигрываемый по кругу, — «трек перемалывается».
     *
     * Максимум нужен потому, что после неудачной загрузки `currentTime`
     * обнуляется: без него первая же осечка отбросила бы нас в начало.
     */
    let resumePosition = this.getCurrentTime();

    if (this.isRecovering) {
      return;
    }

    this.isRecovering = true;
    this.clearHealthTimer();
    this.clearStallWatchdog();
    // Починка сама ждёт готовности буфера с ограничением, так что сторож
    // включения здесь только помешал бы: он ушёл бы чинить уже чинящееся.
    this.clearLoadWatchdog();
    this.setState('buffering');

    /*
     * Первая ступень — ничего не трогать.
     *
     * Дальше идёт тяжёлая починка: выбросить запомненную ссылку и попросить
     * новую. На компьютере это запуск извлекателя, а он отвечает по замерам
     * четыре-восемь секунд — то есть за каждую заминку в полторы секунды
     * человек платит ещё пятью секундами тишины и слышит «поиграло, повисло,
     * снова грузится».
     *
     * А заминка чаще всего проходит сама: буфер добирает недостающее, и трек
     * едет дальше. Поэтому сначала мы просто смотрим, поехала ли позиция, и
     * только если за это время она не сдвинулась ни на сколько — идём за новой
     * ссылкой.
     */
    // Только для заминок. Если элемент уже сказал об ошибке, ждать от него
    // выздоровления бессмысленно: поток мёртв, и эти полторы секунды были бы
    // чистой задержкой перед неизбежным походом за ссылкой.
    const stalledNotBroken = !initialError && !this.getActiveAudio()?.error;

    /*
     * Ссылка, на которой всё сломалось, — и почему её имя стоит запомнить.
     *
     * Названный адрес доезжает до перебора клиентов на телефоне, и ступень,
     * которая отдала бы ровно его, пропускается. Много от этого ждать не стоит:
     * тот же клиент на повторный запрос выдаёт новый подписанный адрес, так что
     * совпадение — случай нечастый. Настоящую защиту даёт проверка ссылки на
     * стороне устройства (`YtDlpPlugin`), а это — дешёвая добавка к ней.
     *
     * Только для настоящего обрыва. Заминка — это про буфер, а не про адрес:
     * отказываться там от рабочей ссылки значит менять хорошее на неизвестное.
     */
    const brokenUrl = stalledNotBroken
      ? undefined
      : this.getActiveAudio()?.currentSrc || this.getActiveAudio()?.src || undefined;
    if (stalledNotBroken && (await this.waitForOwnRecovery(currentTrack, SOFT_RECOVERY_MS))) {
      this.isRecovering = false;
      this.retryCount = 0;
      const revived = this.getActiveAudio();
      if (revived && !revived.paused) {
        this.setState('playing');
        this.startHealthTimer();
      }
      this.noteToLog(
        `заминка на ${resumePosition.toFixed(1)}с прошла сама (${reason}) — ссылку не трогали`
      );
      return;
    }

    const baseDelays = [400, 1000, 2200];
    let lastError = initialError;

    try {
      while (this.retryCount < this.maxRetries) {
        this.retryCount++;
        resumePosition = Math.max(resumePosition, this.getCurrentTime());
        console.warn(
          `[AudioEngine] Stream glitch at ${resumePosition.toFixed(1)}s (${reason}), attempting auto-recovery (${this.retryCount}/${this.maxRetries})...`
        );

        this.noteToLog(
          `перезапрашиваю ссылку для «${currentTrack.title || currentTrack.id}» ` +
            `с ${resumePosition.toFixed(1)}с (${reason}), попытка ${this.retryCount}/${this.maxRetries}`
        );

        const baseDelay = baseDelays[this.retryCount - 1] ?? 2200;
        const jitter = Math.floor(Math.random() * (baseDelay * 0.2));
        await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));

        if (this.currentTrack?.id !== currentTrack.id || !this.isRecovering) {
          return;
        }

        try {
          if (currentTrack.id) {
            this.resolver.invalidate(currentTrack.id);
          }
          const resolved = await this.resolver.resolve(currentTrack, true, 'user', brokenUrl);
          if (this.currentTrack?.id !== currentTrack.id || !this.isRecovering) {
            return;
          }

          const currentAudio = this.getActiveAudio();
          if (currentAudio) {
            this.destroyHlsForDeck(this.activeDeck);
            if (resolved.format === 'hls' || isHlsUrl(resolved.streamUrl)) {
              const handle = await attachHls(currentAudio, resolved.streamUrl, {
                onError: (err: Error) => this.handleHlsRuntimeError(err, resolved.streamUrl as string)
              });
              if (this.activeDeck === 'A') {
                this.hlsHandleA = handle;
              } else {
                this.hlsHandleB = handle;
              }
            } else {
              currentAudio.src = resolved.streamUrl;
              currentAudio.load();
              // The load algorithm resets playbackRate, so the chosen speed is re-applied.
              this.applyPlaybackRate();
              await this.waitForBufferReady(currentAudio);
            }

            if (this.currentTrack?.id !== currentTrack.id || !this.isRecovering) {
              return;
            }

            if (resumePosition > 0) {
              this.pendingSeek = resumePosition;
              this.applySeek(resumePosition, true);
            }
            await this.play();
            this.startHealthTimer();
            return;
          }
        } catch (recoveryErr) {
          console.warn(`[AudioEngine] Auto-recovery attempt ${this.retryCount} failed:`, recoveryErr);
          lastError = recoveryErr instanceof Error ? recoveryErr : new Error(String(recoveryErr));
          if (this.currentTrack?.id !== currentTrack.id || !this.isRecovering) {
            return;
          }
        }
      }
    } finally {
      this.isRecovering = false;
    }

    if (this.currentTrack?.id !== currentTrack.id) {
      return;
    }

    this.clearStallWatchdog();
    this.clearLoadWatchdog();
    this.clearHealthTimer();
    if (this.currentTrack?.id) {
      this.resolver.invalidate(this.currentTrack.id);
    }
    const currentActiveAudio = this.getActiveAudio();
    const err =
      lastError ||
      (currentActiveAudio?.error
        ? new Error(`MediaError [${currentActiveAudio.error.code}]: ${currentActiveAudio.error.message || 'Stream error'}`)
        : new Error(`Playback failed after ${this.retryCount} auto-recovery attempts: ${reason}`));
    this.setState('error');
    this.emitError(err);
  }

  private handlePlaying(e?: Event): void {
    if (e && e.target && e.target !== this.getActiveAudio()) {
      return;
    }
    this.setState('playing');
    this.clearStallWatchdog();
    // Звук пошёл — сторож включения свою работу сделал.
    this.clearLoadWatchdog();
    this.startHealthTimer();
  }

  private handlePause(e?: Event): void {
    if (e && e.target && e.target !== this.getActiveAudio()) {
      return;
    }
    this.clearStallWatchdog();
    this.clearLoadWatchdog();
    this.clearHealthTimer();
    if (this.state !== 'loading' && this.state !== 'error' && !this.isRecovering) {
      this.setState('paused');
    }
  }

  private handleWaiting(e?: Event): void {
    if (e && e.target && e.target !== this.getActiveAudio()) {
      return;
    }
    this.clearHealthTimer();
    if (this.state === 'playing') {
      this.setState('buffering');
    }
    this.startStallWatchdog();
  }

  private setState(newState: PlaybackState): void {
    if (this.state === newState) return;
    this.state = newState;
    for (const listener of this.stateChangeListeners) {
      try {
        listener(newState);
      } catch (e) {
        console.error('[AudioEngine] Error in stateChange listener:', e);
      }
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch (e) {
        console.error('[AudioEngine] Error in error listener:', e);
      }
    }
  }

  /**
   * Tears the engine down: disconnects every node, drops listeners and closes
   * the AudioContext. Safe to call more than once.
   */
  public destroy(): void {
    this.playRequestId++;
    this.loadRequestId++;
    this.fadeToken++;
    this.clearFadeTimer();
    this.clearCrossfadeTimer();
    this.clearStallWatchdog();
    this.clearLoadWatchdog();
    this.clearHealthTimer();
    this.isRecovering = false;
    this.isCrossfading = false;
    this.currentTrack = null;
    this.fadeMultiplier = 1;
    this.pendingSeek = null;

    this.detachAudioListeners(this.audioA);
    this.detachAudioListeners(this.audioB);

    this.destroyHls();

    if (this.audioA && typeof this.audioA.pause === 'function') {
      try {
        this.audioA.pause();
        this.audioA.src = '';
      } catch {}
    }
    if (this.audioB && typeof this.audioB.pause === 'function') {
      try {
        this.audioB.pause();
        this.audioB.src = '';
      } catch {}
    }

    this.releaseGraphNodes();
    this.graphUnavailable = false;

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;

    this.timeUpdateListeners.clear();
    this.endedListeners.clear();
    this.errorListeners.clear();
    this.stateChangeListeners.clear();
  }
}

export const audioEngine = new AudioEngine();
