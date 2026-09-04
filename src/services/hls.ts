import type HlsJs from 'hls.js';
import type { ErrorData } from 'hls.js';

/**
 * Lazily-loaded wrapper around hls.js. `hls.js` is only pulled in when an HLS
 * stream actually has to be attached, so the main bundle stays small and jsdom
 * test environments never touch it.
 */

export interface HlsAttachOptions {
  /** Milliseconds to wait for the manifest before giving up. Default 15000. */
  manifestTimeout?: number;
  /** How many times a fatal media/network error may be recovered. Default 3. */
  maxRecoveryAttempts?: number;
  /** Called for recoverable problems and for fatal errors raised after attach. */
  onError?: (error: Error) => void;
}

export interface HlsHandle {
  /** The manifest URL this handle was created for. */
  readonly url: string;
  /** True when the browser played the manifest natively (no hls.js involved). */
  readonly usingNative: boolean;
  /** Detaches from the media element and releases every resource. Idempotent. */
  destroy(): void;
}

type HlsModule = typeof import('hls.js');

const NATIVE_HLS_MIME_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegURL',
  'audio/mpegurl'
];

const UNAVAILABLE = 'HLS playback unavailable';

let hlsModulePromise: Promise<HlsModule | null> | null = null;

/**
 * Imports hls.js once and memoizes the result. Resolves to null when the
 * module cannot be loaded instead of rejecting.
 */
async function loadHlsModule(): Promise<HlsModule | null> {
  if (!hlsModulePromise) {
    hlsModulePromise = import('hls.js')
      .then(mod => (mod && mod.default ? mod : null))
      .catch((err: unknown) => {
        console.warn('[HLS] hls.js could not be loaded:', err);
        return null;
      });
  }
  return hlsModulePromise;
}

/**
 * True when the URL points at an HLS manifest.
 */
export function isHlsUrl(url?: string): boolean {
  if (!url) return false;
  const withoutQuery = url.split('?')[0].split('#')[0];
  return /\.m3u8?$/i.test(withoutQuery);
}

/**
 * True when the platform can play HLS straight from an <audio>/<video> element
 * (Safari, iOS, some Android WebViews). Chromium — and therefore Electron —
 * returns false here.
 */
export function isNativeHlsSupported(media?: HTMLMediaElement | null): boolean {
  const element =
    media || (typeof document !== 'undefined' ? document.createElement('audio') : null);
  if (!element || typeof element.canPlayType !== 'function') return false;

  return NATIVE_HLS_MIME_TYPES.some(mimeType => {
    try {
      const verdict = element.canPlayType(mimeType);
      return verdict === 'probably' || verdict === 'maybe';
    } catch {
      return false;
    }
  });
}

/**
 * True when hls.js itself can run here (needs Media Source Extensions).
 */
export async function isHlsJsSupported(): Promise<boolean> {
  const mod = await loadHlsModule();
  if (!mod) return false;
  try {
    return mod.default.isSupported();
  } catch (err) {
    console.warn('[HLS] Hls.isSupported() threw:', err);
    return false;
  }
}

/**
 * True when HLS can be played at all — natively or through hls.js.
 */
export async function isHlsSupported(media?: HTMLMediaElement | null): Promise<boolean> {
  if (isNativeHlsSupported(media)) return true;
  return isHlsJsSupported();
}

function describeErrorData(data: ErrorData): string {
  const reason = data.error?.message || data.details || 'unknown error';
  return `${data.type}/${data.details}: ${reason}`;
}

/**
 * Attaches an HLS manifest to a media element. Resolves once the manifest has
 * been parsed and the element is ready to play; rejects with a descriptive
 * error otherwise. Never leaves a dangling hls.js instance behind on failure.
 */
export async function attachHls(
  audioEl: HTMLMediaElement,
  url: string,
  options: HlsAttachOptions = {}
): Promise<HlsHandle> {
  if (!audioEl) {
    throw new Error(`${UNAVAILABLE}: no media element was provided`);
  }
  if (!url) {
    throw new Error(`${UNAVAILABLE}: no manifest URL was provided`);
  }

  const manifestTimeout = options.manifestTimeout ?? 15000;
  const maxRecoveryAttempts = options.maxRecoveryAttempts ?? 3;

  // Safari & friends: hand the manifest straight to the element.
  if (isNativeHlsSupported(audioEl)) {
    audioEl.src = url;
    let nativeDestroyed = false;
    return {
      url,
      usingNative: true,
      destroy: () => {
        if (nativeDestroyed) return;
        nativeDestroyed = true;
        try {
          audioEl.removeAttribute('src');
          audioEl.load();
        } catch (err) {
          console.warn('[HLS] Failed to reset media element:', err);
        }
      }
    };
  }

  const mod = await loadHlsModule();
  if (!mod) {
    throw new Error(`${UNAVAILABLE}: hls.js could not be loaded`);
  }

  const Hls = mod.default;
  let supported = false;
  try {
    supported = Hls.isSupported();
  } catch (err) {
    console.warn('[HLS] Hls.isSupported() threw:', err);
  }
  if (!supported) {
    throw new Error(
      `${UNAVAILABLE}: neither native HLS nor Media Source Extensions are available in this environment`
    );
  }

  const hls: HlsJs = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 90
  });

  let destroyed = false;
  let settled = false;
  let recoveryAttempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    try {
      hls.destroy();
    } catch (err) {
      console.warn('[HLS] Error while destroying hls.js instance:', err);
    }
  };

  const handle: HlsHandle = { url, usingNative: false, destroy };

  return new Promise<HlsHandle>((resolve, reject) => {
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolve(handle);
    };

    const fail = (reason: string): void => {
      if (settled) {
        // Already playing: report instead of producing an unhandled rejection.
        const error = new Error(`${UNAVAILABLE}: ${reason}`);
        if (options.onError) {
          options.onError(error);
        } else {
          console.warn(`[HLS] ${error.message}`);
        }
        return;
      }
      settled = true;
      destroy();
      reject(new Error(`${UNAVAILABLE}: ${reason}`));
    };

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      succeed();
    });

    hls.on(Hls.Events.ERROR, (_event: unknown, data: ErrorData) => {
      const description = describeErrorData(data);

      if (!data.fatal) {
        options.onError?.(new Error(`HLS warning: ${description}`));
        return;
      }

      if (destroyed) return;

      if (recoveryAttempts >= maxRecoveryAttempts) {
        fail(`${description} (gave up after ${recoveryAttempts} recovery attempts)`);
        return;
      }

      switch (data.type) {
        case Hls.ErrorTypes.MEDIA_ERROR: {
          recoveryAttempts++;
          options.onError?.(
            new Error(`HLS media error, recovering (${recoveryAttempts}): ${description}`)
          );
          try {
            if (recoveryAttempts > 1) hls.swapAudioCodec();
            hls.recoverMediaError();
          } catch (err) {
            fail(`media error recovery failed: ${(err as Error)?.message || String(err)}`);
          }
          break;
        }
        case Hls.ErrorTypes.NETWORK_ERROR: {
          recoveryAttempts++;
          options.onError?.(
            new Error(`HLS network error, retrying (${recoveryAttempts}): ${description}`)
          );
          try {
            hls.startLoad();
          } catch (err) {
            fail(`network retry failed: ${(err as Error)?.message || String(err)}`);
          }
          break;
        }
        default:
          fail(description);
      }
    });

    timer = setTimeout(() => {
      fail(`manifest did not load within ${manifestTimeout}ms`);
    }, manifestTimeout);

    try {
      hls.loadSource(url);
      hls.attachMedia(audioEl);
    } catch (err) {
      fail((err as Error)?.message || String(err));
    }
  });
}
