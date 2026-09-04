import { useEffect, useState } from 'react';

/** Fallback used for a missing, unreachable or cross-origin-locked image. */
export const DOMINANT_COLOR_FALLBACK = 'var(--accent)';

/** Sampled colours per URL, so re-opening the same track costs nothing. */
const cache = new Map<string, string>();

const SAMPLE_SIZE = 24;

function toCssColor(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Averages the artwork down to a single colour, then pushes it away from grey so
 * it still reads as an accent behind matte surfaces.
 */
function averageColor(data: Uint8ClampedArray): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let counted = 0;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 16) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    counted++;
  }

  if (counted === 0) return null;

  r = Math.round(r / counted);
  g = Math.round(g / counted);
  b = Math.round(b / counted);

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);

  // A near-grey average would read as dirt over the matte surfaces; keep the
  // hue but lift it out of the mud.
  if (max - min < 12) return toCssColor(r, g, b);

  const boost = 1.18;
  const mid = (max + min) / 2;
  const saturate = (value: number) => Math.min(255, Math.max(0, Math.round(mid + (value - mid) * boost)));

  return toCssColor(saturate(r), saturate(g), saturate(b));
}

/**
 * Extracts an average colour from artwork for ambient backgrounds. Artwork is
 * cross-origin, so a tainted canvas (or any load failure) resolves to
 * `--accent` rather than throwing.
 */
export function useDominantColor(url?: string | null): string {
  const [color, setColor] = useState<string>(() =>
    url && cache.has(url) ? (cache.get(url) as string) : DOMINANT_COLOR_FALLBACK
  );

  useEffect(() => {
    if (!url) {
      setColor(DOMINANT_COLOR_FALLBACK);
      return;
    }

    const cached = cache.get(url);
    if (cached) {
      setColor(cached);
      return;
    }

    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      setColor(DOMINANT_COLOR_FALLBACK);
      return;
    }

    let cancelled = false;

    const remember = (value: string) => {
      cache.set(url, value);
      if (!cancelled) setColor(value);
    };

    const image = new Image();
    image.crossOrigin = 'anonymous';

    image.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          remember(DOMINANT_COLOR_FALLBACK);
          return;
        }

        ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        // Throws a SecurityError when the host sent no permissive CORS header.
        const pixels = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        remember(averageColor(pixels.data) ?? DOMINANT_COLOR_FALLBACK);
      } catch {
        remember(DOMINANT_COLOR_FALLBACK);
      }
    };

    image.onerror = () => {
      remember(DOMINANT_COLOR_FALLBACK);
    };

    image.src = url;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [url]);

  return color;
}

/** Test/diagnostic helper — drops the per-URL colour cache. */
export function clearDominantColorCache(): void {
  cache.clear();
}
