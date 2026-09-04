import React, { useEffect, useRef, useState } from 'react';
import { VisualizerPreset } from '../../types/visualizer';
import { audioEngine } from '../../services/audioEngine';
import { usePlayerStore } from '../../store/usePlayerStore';

/** How often the idle frame repaints while the audio graph does not exist yet. */
const IDLE_FRAME_INTERVAL_MS = 250;
/**
 * How long the spectrum takes to grow out of — or sink back into — its baseline.
 *
 * Without this the bars appeared at full height on the very first frame of
 * playback: the idle line was replaced by a wall of bars between two frames,
 * which reads as a glitch rather than as the music starting. The ramp scales the
 * amplitude only, so frame zero is pixel-identical to the idle baseline and the
 * shape grows out of it.
 */
const ONSET_MS = 520;
const BAR_GAP = 2;const MIN_BARS = 6;
const MAX_BARS = 48;
const RADIAL_SPOKES = 56;
const RADIAL_SPIN_PER_FRAME = 0.004;

/**
 * Потолок множителя плотности пикселей.
 *
 * У телефонов он бывает 3 и выше, а холст растёт по нему в квадрате: между 2 и
 * 3 разница в 2,25 раза по числу закрашиваемых пикселей каждый кадр. На
 * спектре из полусотни прямоугольников эту разницу не видно даже вплотную, а
 * вот падение частоты кадров слышно — визуализатор делит поток с
 * воспроизведением.
 */
const MAX_PIXEL_RATIO = 2;

/**
 * The amplitude multiplier at `elapsedMs` into a run, 0 to 1.
 *
 * `rising` picks the direction: playback grows the shape out of the baseline,
 * stopping lets it sink back into it along the same curve. The curve is a
 * smoothstep, so both ends are flat — the spectrum neither jumps into motion nor
 * stops dead, which is the whole point of having a ramp at all.
 *
 * Exported because this is the only part of the visualiser that can be checked
 * without a canvas: everything else is `CanvasRenderingContext2D` calls.
 */
export function onsetGain(elapsedMs: number, rising: boolean): number {
  const progress = Math.min(1, Math.max(0, elapsedMs) / ONSET_MS);
  const eased = progress * progress * (3 - 2 * progress);
  return rising ? eased : 1 - eased;
}

interface Palette {
  accent: string;
  accentSoft: string;
  rail: string;
  peak: string;
}

interface Size {
  width: number;
  height: number;
}

export interface AudioVisualizerProps {
  /** Overrides the store preset — used by the small bar-embedded instance. */
  preset?: VisualizerPreset;
  height?: number | string;
  width?: number | string;
  className?: string;
}

/**
 * Every colour is read off the canvas' own computed style so the presets stay on
 * the palette; nothing here hardcodes a colour.
 */
function resolvePalette(canvas: HTMLCanvasElement): Palette {
  const styles = getComputedStyle(canvas);
  const read = (name: string) => styles.getPropertyValue(name).trim() || styles.color;

  return {
    accent: read('--accent'),
    accentSoft: read('--accent-soft'),
    rail: read('--surface-active'),
    peak: read('--text-muted')
  };
}

function measure(canvas: HTMLCanvasElement): Size {
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  };
}

function barCountFor(width: number): number {
  return Math.max(MIN_BARS, Math.min(MAX_BARS, Math.floor(width / 7)));
}

function fillBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  // roundRect is Chromium 99+; the fallback keeps a headless canvas happy.
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fill();
    return;
  }
  ctx.fillRect(x, y, width, height);
}

/**
 * Bars rising from the floor, with a peak cap that falls back under gravity.
 *
 * Рисуется в два прохода, а не в один. Столбики и их шапки — разные заливки, и
 * чередовать их в одном цикле значит переключать `fillStyle` дважды на столбик:
 * под полсотни смен состояния на кадр вместо двух. На настольной машине этого
 * не видно, на телефоне это заметная часть кадра.
 *
 * Градиент приходит готовым: пересобирать его каждый кадр — заметно дороже,
 * чем держать до смены размера.
 */
function drawBars(
  ctx: CanvasRenderingContext2D,
  size: Size,
  data: Uint8Array,
  palette: Palette,
  peaks: number[],
  gain: number,
  gradient: CanvasGradient
): void {
  const count = barCountFor(size.width);
  const barWidth = Math.max(1, (size.width - BAR_GAP * (count - 1)) / count);
  const step = Math.max(1, Math.floor(data.length / count));
  const radius = Math.min(2, barWidth / 2);

  ctx.fillStyle = gradient;
  for (let i = 0; i < count; i += 1) {
    const value = ((data[i * step] ?? 0) / 255) * gain;
    const barHeight = Math.max(2, value * size.height);
    fillBar(ctx, i * (barWidth + BAR_GAP), size.height - barHeight, barWidth, barHeight, radius);

    const previous = peaks[i] ?? 0;
    peaks[i] = barHeight >= previous ? barHeight : Math.max(2, previous - size.height * 0.012);
  }

  ctx.fillStyle = palette.peak;
  for (let i = 0; i < count; i += 1) {
    ctx.fillRect(
      i * (barWidth + BAR_GAP),
      Math.max(0, size.height - (peaks[i] ?? 0) - 2),
      barWidth,
      1
    );
  }
}

/** Bars growing out of the middle in both directions. */
function drawMirroredBars(
  ctx: CanvasRenderingContext2D,
  size: Size,
  data: Uint8Array,
  palette: Palette,
  gain: number
): void {
  const count = barCountFor(size.width);
  const barWidth = Math.max(1, (size.width - BAR_GAP * (count - 1)) / count);
  const step = Math.max(1, Math.floor(data.length / count));
  const middle = size.height / 2;

  ctx.fillStyle = palette.accent;
  ctx.globalAlpha = 0.72;

  for (let i = 0; i < count; i += 1) {
    const value = ((data[i * step] ?? 0) / 255) * gain;
    const half = Math.max(1, (value * size.height) / 2);
    const x = i * (barWidth + BAR_GAP);
    fillBar(ctx, x, middle - half, barWidth, half * 2, Math.min(2, barWidth / 2));
  }

  ctx.globalAlpha = 1;
}

/** Time-domain trace with a soft fill underneath it. */
function drawWave(
  ctx: CanvasRenderingContext2D,
  size: Size,
  timeData: Uint8Array,
  palette: Palette,
  gain: number
): void {
  const middle = size.height / 2;
  const stepX = size.width / Math.max(1, timeData.length - 1);
  const pointY = (index: number) => middle + ((timeData[index] - 128) / 128) * (middle - 1) * gain;

  ctx.beginPath();
  ctx.moveTo(0, pointY(0));
  for (let i = 1; i < timeData.length; i += 1) {
    ctx.lineTo(i * stepX, pointY(i));
  }

  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo(size.width, middle);
  ctx.lineTo(0, middle);
  ctx.closePath();
  ctx.fillStyle = palette.accentSoft;
  ctx.fill();
}

/** Spokes around a slowly rotating ring. */
function drawRadial(
  ctx: CanvasRenderingContext2D,
  size: Size,
  data: Uint8Array,
  palette: Palette,
  rotation: number,
  gain: number
): void {
  const centerX = size.width / 2;
  const centerY = size.height / 2;
  const extent = Math.min(centerX, centerY);
  const baseRadius = extent * 0.5;
  const step = (Math.PI * 2) / RADIAL_SPOKES;

  ctx.strokeStyle = palette.rail;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(centerX, centerY, baseRadius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = Math.max(1, extent * 0.03);
  ctx.lineCap = 'round';

  for (let i = 0; i < RADIAL_SPOKES; i += 1) {
    const angle = i * step + rotation;
    const value = (data[i % data.length] ?? 0) / 255;
    const length = Math.max(1, value * gain * extent * 0.45);

    ctx.beginPath();
    ctx.moveTo(centerX + Math.cos(angle) * baseRadius, centerY + Math.sin(angle) * baseRadius);
    ctx.lineTo(
      centerX + Math.cos(angle) * (baseRadius + length),
      centerY + Math.sin(angle) * (baseRadius + length)
    );
    ctx.stroke();
  }
}

/** Paused, muted or no audio graph: a still, quiet baseline. Never a black box. */
function drawIdle(ctx: CanvasRenderingContext2D, size: Size, palette: Palette, preset: VisualizerPreset): void {
  ctx.fillStyle = palette.rail;
  ctx.strokeStyle = palette.rail;

  if (preset === 'CIRCULAR_SPECTRUM') {
    const extent = Math.min(size.width, size.height) / 2;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(size.width / 2, size.height / 2, extent * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  if (preset === 'HOLOGRAPHIC_WAVE') {
    const middle = Math.round(size.height / 2);
    ctx.fillRect(0, middle, size.width, 1);
    return;
  }

  const count = barCountFor(size.width);
  const barWidth = Math.max(1, (size.width - BAR_GAP * (count - 1)) / count);
  const middle = size.height / 2;

  for (let i = 0; i < count; i += 1) {
    const x = i * (barWidth + BAR_GAP);
    if (preset === 'AMBIENT_AURORA') {
      ctx.fillRect(x, middle - 1, barWidth, 2);
    } else {
      ctx.fillRect(x, size.height - 2, barWidth, 2);
    }
  }
}

/**
 * Canvas spectrum for the player bar and the fullscreen player. It only ever
 * reads the engine's existing analyser — it never builds an audio graph of its
 * own — and it animates only while audio is actually playing and the window is
 * visible, so a backgrounded app costs nothing.
 */
export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({
  preset,
  height = '100%',
  width = '100%',
  className = ''
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<number[]>([]);
  const rotationRef = useRef(0);
  // Deliberately inferred: an explicit `Uint8Array` annotation widens the buffer
  // to `ArrayBufferLike`, which the analyser methods reject.
  const frequencyRef = useRef(new Uint8Array(0));
  const timeDomainRef = useRef(new Uint8Array(0));
  /**
   * Whether the previous run of the frame effect was animating.
   *
   * The effect cannot tell "playback just stopped" from "mounted while paused" —
   * both arrive as `shouldAnimate === false`. Only the first deserves a fade-out;
   * the second would fade in a spectrum nobody ever saw.
   */
  const wasAnimatingRef = useRef(false);

  const storePreset = usePlayerStore((s) => s.visualizerPreset);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const visualizerEnabled = usePlayerStore((s) => s.visualizerEnabled);
  const activePreset = preset ?? storePreset;

  const [isPageVisible, setIsPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibility = () => setIsPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const shouldAnimate = visualizerEnabled && isPlaying && isPageVisible;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const palette = resolvePalette(canvas);
    let size = measure(canvas);
    let frame = 0;
    let lastIdleAt = 0;

    /**
     * Градиент столбиков. Держится до смены высоты, потому что зависит только
     * от неё: `createLinearGradient` на каждый кадр — это лишняя пересборка
     * шестьдесят раз в секунду ради одного и того же результата.
     */
    let barGradient: CanvasGradient | null = null;
    let gradientHeight = 0;
    const barsGradient = (): CanvasGradient => {
      if (!barGradient || gradientHeight !== size.height) {
        const next = ctx.createLinearGradient(0, size.height, 0, 0);
        next.addColorStop(0, palette.accent);
        next.addColorStop(1, palette.accentSoft);
        barGradient = next;
        gradientHeight = size.height;
      }
      return barGradient;
    };

    /** Applies the device pixel ratio and clears in CSS pixels. */
    const prepare = () => {
      const ratio = Math.min(MAX_PIXEL_RATIO, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
      const pixelWidth = Math.round(size.width * ratio);
      const pixelHeight = Math.round(size.height * ratio);

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);
      ctx.globalAlpha = 1;
    };

    const paintIdle = () => {
      prepare();
      drawIdle(ctx, size, palette, activePreset);
    };

    const paintFrame = (analyser: AnalyserNode, gain: number) => {
      prepare();

      if (activePreset === 'HOLOGRAPHIC_WAVE') {
        if (timeDomainRef.current.length !== analyser.fftSize) {
          timeDomainRef.current = new Uint8Array(analyser.fftSize);
        }
        analyser.getByteTimeDomainData(timeDomainRef.current);
        drawWave(ctx, size, timeDomainRef.current, palette, gain);
        return;
      }

      if (frequencyRef.current.length !== analyser.frequencyBinCount) {
        frequencyRef.current = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(frequencyRef.current);
      const data = frequencyRef.current;

      if (activePreset === 'CIRCULAR_SPECTRUM') {
        rotationRef.current += RADIAL_SPIN_PER_FRAME;
        drawRadial(ctx, size, data, palette, rotationRef.current, gain);
        return;
      }

      if (activePreset === 'AMBIENT_AURORA') {
        drawMirroredBars(ctx, size, data, palette, gain);
        return;
      }

      if (peaksRef.current.length !== barCountFor(size.width)) {
        peaksRef.current = new Array(barCountFor(size.width)).fill(0);
      }
      drawBars(ctx, size, data, palette, peaksRef.current, gain, barsGradient());
    };

    /**
     * Where the run is on its ramp: 0 is the idle baseline, 1 is full amplitude.
     *
     * Playback ramps up, stopping ramps down, and both use the same curve so the
     * spectrum leaves the screen the way it arrived.
     */
    let onsetAt = 0;
    const gainAt = (timestamp: number): number => {
      if (onsetAt === 0) onsetAt = timestamp;
      return onsetGain(timestamp - onsetAt, shouldAnimate);
    };

    const tick = (timestamp: number) => {
      const gain = gainAt(timestamp);
      const analyser = audioEngine.getAnalyser();

      if (!analyser) {
        // The graph is built on first play; wait for it cheaply rather than
        // burning frames or inventing data. Nothing to fade out of, either.
        if (!shouldAnimate) {
          paintIdle();
          return;
        }
        frame = requestAnimationFrame(tick);
        if (timestamp - lastIdleAt < IDLE_FRAME_INTERVAL_MS) return;
        lastIdleAt = timestamp;
        paintIdle();
        return;
      }

      paintFrame(analyser, gain);

      // A fade-out is finite: once it has burned down the canvas is idle again
      // and the loop must stop, or a paused player keeps costing frames.
      if (!shouldAnimate && gain <= 0) {
        paintIdle();
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        size = measure(canvas);
        peaksRef.current = [];
        if (!shouldAnimate) paintIdle();
      });
      observer.observe(canvas);
    }

    // Stopping runs the same loop backwards, but only if there was something on
    // screen to take away: on first mount the baseline is simply drawn.
    if (shouldAnimate || wasAnimatingRef.current) {
      frame = requestAnimationFrame(tick);
    } else {
      paintIdle();
    }
    wasAnimatingRef.current = shouldAnimate;

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [activePreset, shouldAnimate]);

  return (
    <div
      className={className}
      style={{
        width,
        height,
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      data-testid="audio-visualizer"
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
};
