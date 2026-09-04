// Vitest & Universal Test Environment Setup for Wireon
import '@testing-library/jest-dom';
import 'fake-indexeddb/auto';

// Comprehensive Mocks for Web Audio API, MediaSession, IndexedDB/Dexie, Electron IPC, and Network Services

// ==========================================
// 1. Web Audio API Mock System
// ==========================================
export class MockAudioParam {
  value = 1;
  minValue = 0;
  maxValue = 1;
  defaultValue = 1;

  setValueAtTime(val: number, _startTime: number): MockAudioParam {
    this.value = val;
    return this;
  }

  linearRampToValueAtTime(val: number, _endTime: number): MockAudioParam {
    this.value = val;
    return this;
  }

  exponentialRampToValueAtTime(val: number, _endTime: number): MockAudioParam {
    this.value = Math.max(0.0001, val);
    return this;
  }

  cancelScheduledValues(_startTime: number): MockAudioParam {
    return this;
  }
}

export class MockGainNode {
  gain = new MockAudioParam();
  numberOfInputs = 1;
  numberOfOutputs = 1;
  connectedTo: any[] = [];

  connect(destinationNode: any): any {
    this.connectedTo.push(destinationNode);
    return destinationNode;
  }

  disconnect(): void {
    this.connectedTo = [];
  }
}

export class MockAnalyserNode {
  fftSize = 256;
  frequencyBinCount = 128;
  smoothingTimeConstant = 0.8;
  minDecibels = -100;
  maxDecibels = -30;
  connectedTo: any[] = [];

  connect(destinationNode: any): any {
    this.connectedTo.push(destinationNode);
    return destinationNode;
  }

  disconnect(): void {
    this.connectedTo = [];
  }

  getByteFrequencyData(array: Uint8Array): void {
    const len = Math.min(array.length, this.frequencyBinCount);
    for (let i = 0; i < len; i++) {
      // Deterministic synthetic frequency spectrum curve
      const normalized = i / len;
      array[i] = Math.floor(Math.sin(normalized * Math.PI) * 200 + 20);
    }
  }

  getByteTimeDomainData(array: Uint8Array): void {
    const len = array.length;
    for (let i = 0; i < len; i++) {
      const normalized = i / len;
      array[i] = Math.floor(128 + Math.sin(normalized * Math.PI * 4) * 64);
    }
  }
}

export class MockMediaElementAudioSourceNode {
  mediaElement: HTMLMediaElement;
  connectedTo: any[] = [];

  constructor(mediaElement: HTMLMediaElement) {
    this.mediaElement = mediaElement;
  }

  connect(destinationNode: any): any {
    this.connectedTo.push(destinationNode);
    return destinationNode;
  }

  disconnect(): void {
    this.connectedTo = [];
  }
}

export class MockBiquadFilterNode {
  type: string = 'lowpass';
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
  gain = new MockAudioParam();
  numberOfInputs = 1;
  numberOfOutputs = 1;
  connectedTo: any[] = [];

  constructor() {
    this.frequency.value = 350;
    this.Q.value = 1;
    this.gain.value = 0;
  }

  connect(destinationNode: any): any {
    this.connectedTo.push(destinationNode);
    return destinationNode;
  }

  disconnect(): void {
    this.connectedTo = [];
  }
}

export class MockDynamicsCompressorNode {
  threshold = new MockAudioParam();
  knee = new MockAudioParam();
  ratio = new MockAudioParam();
  attack = new MockAudioParam();
  release = new MockAudioParam();
  numberOfInputs = 1;
  numberOfOutputs = 1;
  connectedTo: any[] = [];

  constructor() {
    this.threshold.value = -24;
    this.knee.value = 30;
    this.ratio.value = 4;
    this.attack.value = 0.003;
    this.release.value = 0.25;
  }

  connect(destinationNode: any): any {
    this.connectedTo.push(destinationNode);
    return destinationNode;
  }

  disconnect(): void {
    this.connectedTo = [];
  }
}

export class MockAudioDestinationNode {
  maxChannelCount = 2;
  channelCount = 2;
  numberOfInputs = 1;
  numberOfOutputs = 0;
}

export class MockAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 44100;
  destination = new MockAudioDestinationNode();

  createGain(): MockGainNode {
    return new MockGainNode();
  }

  createAnalyser(): MockAnalyserNode {
    return new MockAnalyserNode();
  }

  createMediaElementSource(mediaElement: HTMLMediaElement): MockMediaElementAudioSourceNode {
    return new MockMediaElementAudioSourceNode(mediaElement);
  }

  createBiquadFilter(): MockBiquadFilterNode {
    return new MockBiquadFilterNode();
  }

  createDynamicsCompressor(): MockDynamicsCompressorNode {
    return new MockDynamicsCompressorNode();
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}

// ==========================================
// 2. MediaSession API Mock System
// ==========================================
export interface MediaImage {
  src: string;
  sizes?: string;
  type?: string;
}

export interface MediaMetadataInit {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: MediaImage[];
}

export class MockMediaMetadata {
  title = '';
  artist = '';
  album = '';
  artwork: MediaImage[] = [];

  constructor(init?: MediaMetadataInit) {
    if (init) {
      this.title = init.title || '';
      this.artist = init.artist || '';
      this.album = init.album || '';
      this.artwork = init.artwork || [];
    }
  }
}

export type MediaSessionAction =
  | 'play'
  | 'pause'
  | 'seekbackward'
  | 'seekforward'
  | 'previoustrack'
  | 'nexttrack'
  | 'stop'
  | 'seekto';

export class MockMediaSession {
  metadata: MockMediaMetadata | null = null;
  playbackState: 'none' | 'paused' | 'playing' = 'none';
  actionHandlers: Map<MediaSessionAction, (details?: any) => void> = new Map();
  positionState: { duration?: number; playbackRate?: number; position?: number } | null = null;

  setActionHandler(action: MediaSessionAction, handler: ((details?: any) => void) | null): void {
    if (handler) {
      this.actionHandlers.set(action, handler);
    } else {
      this.actionHandlers.delete(action);
    }
  }

  setPositionState(state?: { duration?: number; playbackRate?: number; position?: number }): void {
    this.positionState = state || null;
  }

  // Helper for tests to simulate hardware media key presses
  triggerAction(action: MediaSessionAction, details?: any): void {
    const handler = this.actionHandlers.get(action);
    if (handler) {
      handler(details);
    }
  }
}

// ==========================================
// 3. In-Memory Mock Dexie / IndexedDB Database
// ==========================================
export class MockDexieTable<T extends { id?: any; key?: any }> {
  name: string;
  /**
   * The inbound primary key, matching the real schema in `src/services/db.ts`
   * (`settings` is keyed on `key`, every other table on `id`). Dexie derives the
   * key from this property and never writes a different one back onto the
   * record, so neither does this mock.
   */
  keyPath: 'id' | 'key';
  private records: Map<any, T> = new Map();

  constructor(name: string, keyPath: 'id' | 'key' = 'id') {
    this.name = name;
    this.keyPath = keyPath;
  }

  /** The key Dexie would extract from `item`, or undefined when it is absent. */
  private keyOf(item: T): any {
    return (item as any)[this.keyPath];
  }

  async get(key: any): Promise<T | undefined> {
    return this.records.get(key);
  }

  async put(item: T): Promise<any> {
    const recordKey = this.keyOf(item);
    if (recordKey === undefined || recordKey === null) {
      // Real Dexie rejects an inbound-keyed put with no key rather than inventing one.
      throw new Error(`Missing primary key '${this.keyPath}' for table ${this.name}`);
    }
    this.records.set(recordKey, { ...item });
    return recordKey;
  }

  async bulkPut(items: T[]): Promise<any> {
    let lastKey: any;
    for (const item of items) {
      lastKey = await this.put(item);
    }
    return lastKey;
  }

  async add(item: T): Promise<any> {
    const recordKey = this.keyOf(item);
    if (recordKey !== undefined && this.records.has(recordKey)) {
      throw new Error(`Key already exists in table ${this.name}: ${recordKey}`);
    }
    return this.put(item);
  }

  async delete(key: any): Promise<void> {
    this.records.delete(key);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  async toArray(): Promise<T[]> {
    return Array.from(this.records.values());
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  where(field: string) {
    // Evaluated lazily: a real Dexie query reads the table when the terminator
    // (`toArray`/`first`/`count`) runs, not when `where()` is called.
    const snapshot = () => Array.from(this.records.values());
    return {
      equals: (val: any) => ({
        toArray: async () => snapshot().filter((r: any) => r[field] === val),
        first: async () => snapshot().find((r: any) => r[field] === val),
        count: async () => snapshot().filter((r: any) => r[field] === val).length,
        delete: async () => {
          for (const [k, v] of this.records.entries()) {
            if ((v as any)[field] === val) {
              this.records.delete(k);
            }
          }
        }
      }),
      anyOf: (vals: any[]) => ({
        toArray: async () => snapshot().filter((r: any) => vals.includes(r[field]))
      })
    };
  }

  orderBy(field: string) {
    return {
      reverse: () => ({
        toArray: async () => {
          const all = Array.from(this.records.values());
          return all.sort((a: any, b: any) => (b[field] || 0) - (a[field] || 0));
        },
        limit: (n: number) => ({
          toArray: async () => {
            const all = Array.from(this.records.values());
            return all.sort((a: any, b: any) => (b[field] || 0) - (a[field] || 0)).slice(0, n);
          }
        })
      }),
      toArray: async () => {
        const all = Array.from(this.records.values());
        return all.sort((a: any, b: any) => (a[field] || 0) - (b[field] || 0));
      }
    };
  }
}

export class MockWireonDatabase {
  tracks = new MockDexieTable<any>('tracks', 'id');
  playlists = new MockDexieTable<any>('playlists', 'id');
  favorites = new MockDexieTable<any>('favorites', 'id');
  history = new MockDexieTable<any>('history', 'id');
  /** Keyed on `key`, exactly like the `settings` store in `src/services/db.ts`. */
  settings = new MockDexieTable<any>('settings', 'key');

  async transaction(_mode: string, ..._tablesAndCallback: any[]): Promise<any> {
    const callback = _tablesAndCallback[_tablesAndCallback.length - 1];
    if (typeof callback === 'function') {
      return callback();
    }
    return Promise.resolve();
  }

  async clearAll(): Promise<void> {
    await this.tracks.clear();
    await this.playlists.clear();
    await this.favorites.clear();
    await this.history.clear();
    await this.settings.clear();
  }
}

// ==========================================
// 4. Electron IPC Bridge Mock
// ==========================================
/**
 * `openExternal` is **opt-in**. `discordAuth.getDesktopAuthBridge()` treats a
 * bridge that exposes both `onDeepLink` and `openExternal` as a working
 * deep-link runtime, so installing it globally would silently change which auth
 * path every test takes (see `tests/unit/discordAuth.test.ts`, which asserts
 * `DEEP_LINK_UNAVAILABLE` against the default global mock). Tests that want the
 * deep-link flow construct their own instance with `withOpenExternal: true`.
 */
export interface MockElectronAPIOptions {
  withOpenExternal?: boolean;
}

export class MockElectronAPI {
  isElectron = true;
  platform = 'win32';
  registeredShortcuts: Map<string, () => void> = new Map();
  ipcListeners: Map<string, Array<(...args: any[]) => void>> = new Map();
  windowState: { isMaximized: boolean; isMinimized: boolean; isClosed: boolean } = {
    isMaximized: false,
    isMinimized: false,
    isClosed: false
  };
  thumbnailButtons: any[] = [];
  deepLinkHandlers: Array<(url: string) => void> = [];
  /** Every URL handed to `openExternal`, including the ones it refused. */
  openExternalCalls: string[] = [];
  /**
   * Present only when constructed with `{ withOpenExternal: true }`. Mirrors the
   * preload contract in `electron/preload.ts`: `Promise<void>`, and the main
   * process refuses anything that is not http(s).
   */
  openExternal?: (url: string) => Promise<void>;

  constructor(options: MockElectronAPIOptions = {}) {
    if (options.withOpenExternal) {
      this.openExternal = async (url: string): Promise<void> => {
        this.openExternalCalls.push(url);
        let protocol = '';
        try {
          protocol = new URL(url).protocol;
        } catch {
          protocol = '';
        }
        if (protocol !== 'http:' && protocol !== 'https:') {
          throw new Error('Refused to open a URL that is not http(s)');
        }
      };
    }
  }

  minimize(): void {
    this.windowState.isMinimized = true;
    this.emit('window-minimized');
  }

  maximize(): void {
    this.windowState.isMaximized = !this.windowState.isMaximized;
    this.emit('window-maximized', this.windowState.isMaximized);
  }

  close(): void {
    this.windowState.isClosed = true;
    this.emit('window-closed');
  }

  registerShortcut(accelerator: string, callback: () => void): boolean {
    this.registeredShortcuts.set(accelerator, callback);
    return true;
  }

  unregisterShortcut(accelerator: string): void {
    this.registeredShortcuts.delete(accelerator);
  }

  triggerShortcut(accelerator: string): void {
    const cb = this.registeredShortcuts.get(accelerator);
    if (cb) cb();
  }

  setThumbarButtons(buttons: any[]): void {
    this.thumbnailButtons = buttons;
  }

  onDeepLink(callback: (url: string) => void): () => void {
    this.deepLinkHandlers.push(callback);
    return () => {
      this.deepLinkHandlers = this.deepLinkHandlers.filter(cb => cb !== callback);
    };
  }

  simulateDeepLink(url: string): void {
    this.deepLinkHandlers.forEach(cb => cb(url));
  }

  on(channel: string, listener: (...args: any[]) => void): () => void {
    const list = this.ipcListeners.get(channel) || [];
    list.push(listener);
    this.ipcListeners.set(channel, list);
    return () => {
      const current = this.ipcListeners.get(channel) || [];
      this.ipcListeners.set(channel, current.filter(l => l !== listener));
    };
  }

  emit(channel: string, ...args: any[]): void {
    const list = this.ipcListeners.get(channel) || [];
    list.forEach(l => l(...args));
  }
}

// ==========================================
// 5. Global Polyfills & Mock Installation
// ==========================================
/**
 * jsdom 25 реализует Blob без `arrayBuffer()`, `text()` и `stream()` — в
 * Chromium они есть с 2019 года, так что прод-код ими пользуется, а под тестами
 * падал с «blob.arrayBuffer is not a function». FileReader jsdom реализует
 * честно, поэтому чтение идёт через него.
 */
function polyfillBlobReaders(): void {
  const proto = (globalThis as any).Blob?.prototype;
  if (!proto || typeof (globalThis as any).FileReader !== 'function') return;

  const readAs = (blob: Blob, mode: 'buffer' | 'text'): Promise<any> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      if (mode === 'buffer') reader.readAsArrayBuffer(blob);
      else reader.readAsText(blob);
    });

  if (typeof proto.arrayBuffer !== 'function') {
    proto.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
      return readAs(this, 'buffer');
    };
  }
  if (typeof proto.text !== 'function') {
    proto.text = function (this: Blob): Promise<string> {
      return readAs(this, 'text');
    };
  }
}

export function setupTestEnvironment() {
  polyfillBlobReaders();

  if (typeof window !== 'undefined') {
    // Audio Context Polyfills
    (window as any).AudioContext = MockAudioContext;
    (window as any).webkitAudioContext = MockAudioContext;

    // MediaSession Polyfill
    const mockMediaSession = new MockMediaSession();
    (navigator as any).mediaSession = mockMediaSession;
    (window as any).MediaMetadata = MockMediaMetadata;

    // Electron API Polyfill
    (window as any).electronAPI = new MockElectronAPI();

    /*
     * jsdom не знает `PointerEvent`, и `fireEvent.pointerDown` собирает вместо
     * него голый `Event`: `clientX`, `clientY`, `pointerId` до обработчика не
     * доезжают, то есть жест снаружи выглядит как нажатие в точку (0, 0).
     * Подмена минимальная — ровно те поля, по которым считают жест.
     */
    if (typeof (window as any).PointerEvent !== 'function') {
      class StubPointerEvent extends MouseEvent {
        public readonly pointerId: number;
        public readonly pointerType: string;
        public readonly isPrimary: boolean;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? 'touch';
          this.isPrimary = init.isPrimary ?? true;
        }
      }
      (window as any).PointerEvent = StubPointerEvent;
      (globalThis as any).PointerEvent = StubPointerEvent;
    }

    // Захвата указателя в jsdom тоже нет, а жест его просит. Без заглушки
    // падало бы то, что к проверяемому поведению отношения не имеет.
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = function setPointerCapture() {};
      Element.prototype.releasePointerCapture = function releasePointerCapture() {};
      Element.prototype.hasPointerCapture = function hasPointerCapture() {
        return false;
      };
    }

    // WebSocket stub. jsdom ships a real one, which would have the group-listen
    // tests dialling public MQTT brokers over the network — slow, flaky and rude.
    // It stays in CONNECTING forever, so anything built on it degrades to its
    // offline path; tests that want a live socket inject their own factory.
    (window as any).WebSocket = class StubWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 0;
      binaryType = 'blob';
      onopen: ((event?: unknown) => void) | null = null;
      onclose: ((event?: unknown) => void) | null = null;
      onerror: ((event?: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(public url: string, public protocols?: string | string[]) {}
      send(): void {}
      close(): void {
        this.readyState = 3;
      }
      addEventListener(): void {}
      removeEventListener(): void {}
    };
    (globalThis as any).WebSocket = (window as any).WebSocket;

    // Canvas 2D. jsdom has no renderer, so every visualizer mount printed a
    // «Not implemented: HTMLCanvasElement.prototype.getContext» wall of stack
    // traces into otherwise green runs. A no-op context keeps the drawing code
    // on its normal path; tests that need to inspect the calls install their own.
    if (window.HTMLCanvasElement && !(window.HTMLCanvasElement.prototype as any).__wireonCanvasStub) {
      const stubContext = () =>
        ({
          canvas: null,
          fillRect: () => {},
          clearRect: () => {},
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
          putImageData: () => {},
          createImageData: () => ({ data: new Uint8ClampedArray(4) }),
          setTransform: () => {},
          transform: () => {},
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          drawImage: () => {},
          save: () => {},
          restore: () => {},
          beginPath: () => {},
          closePath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          bezierCurveTo: () => {},
          quadraticCurveTo: () => {},
          arc: () => {},
          arcTo: () => {},
          ellipse: () => {},
          rect: () => {},
          roundRect: () => {},
          clip: () => {},
          fill: () => {},
          stroke: () => {},
          fillText: () => {},
          strokeText: () => {},
          measureText: () => ({ width: 0 }),
          createLinearGradient: () => ({ addColorStop: () => {} }),
          createRadialGradient: () => ({ addColorStop: () => {} }),
          createPattern: () => null,
          globalAlpha: 1,
          globalCompositeOperation: 'source-over',
          fillStyle: '#000',
          strokeStyle: '#000',
          lineWidth: 1,
          lineCap: 'butt',
          lineJoin: 'miter',
          font: '10px sans-serif',
          textAlign: 'start',
          textBaseline: 'alphabetic',
          shadowBlur: 0,
          shadowColor: 'rgba(0,0,0,0)',
          shadowOffsetX: 0,
          shadowOffsetY: 0,
          filter: 'none'
        }) as unknown as CanvasRenderingContext2D;

      window.HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        contextId: string
      ) {
        // Только 2D: за webgl никто здесь не рисует, и врать про него незачем.
        return contextId === '2d' ? stubContext() : null;
      } as HTMLCanvasElement['getContext'];
      (window.HTMLCanvasElement.prototype as any).__wireonCanvasStub = true;
    }

    // HTMLMediaElement Mocks
    if (window.HTMLMediaElement) {      window.HTMLMediaElement.prototype.play = async function () {
        (this as any)._isPlaying = true;
        this.dispatchEvent(new Event('play'));
        this.dispatchEvent(new Event('playing'));
        return Promise.resolve();
      };

      window.HTMLMediaElement.prototype.pause = function () {
        (this as any)._isPlaying = false;
        this.dispatchEvent(new Event('pause'));
      };

      window.HTMLMediaElement.prototype.load = function () {
        this.dispatchEvent(new Event('loadstart'));
      };
    }
  }
}

// Auto-run on import
setupTestEnvironment();
