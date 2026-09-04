import React, { useCallback } from 'react';
import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { Button } from './Button';
import { usePlayerStore } from '../../store/usePlayerStore';
import { ICON } from '../../styles/icons';

export interface VolumeSliderProps {
  /** 0..1. Falls back to the player store. */
  volume?: number;
  isMuted?: boolean;
  /** Defaults to `usePlayerStore.setVolume` (0 implies mute). */
  onVolumeChange?: (volume: number) => void;
  /** Defaults to `usePlayerStore.toggleMute` (restores `previousVolume`). */
  onToggleMute?: () => void;
  showPercentage?: boolean;
  width?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

const STEP = 0.05;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Mute button plus a rail. The rail is a real `input[type=range]`, so it is
 * keyboard-operable and exposes `role="slider"` with percentage-based ARIA
 * values rather than the raw 0..1 float.
 */
export const VolumeSlider: React.FC<VolumeSliderProps> = ({
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  showPercentage = false,
  width = 92,
  className = '',
  style
}) => {
  const storeVolume = usePlayerStore((s) => s.volume);
  const storeMuted = usePlayerStore((s) => s.isMuted);

  const currentVolume = volume ?? storeVolume;
  const muted = isMuted ?? storeMuted;

  const effectiveVolume = muted ? 0 : clamp01(currentVolume);
  const percentage = Math.round(effectiveVolume * 100);

  const applyVolume = useCallback(
    (next: number) => {
      const clamped = clamp01(next);
      if (onVolumeChange) {
        onVolumeChange(clamped);
      } else {
        usePlayerStore.getState().setVolume(clamped);
      }
    },
    [onVolumeChange]
  );

  const toggleMute = useCallback(() => {
    if (onToggleMute) {
      onToggleMute();
    } else {
      usePlayerStore.getState().toggleMute();
    }
  }, [onToggleMute]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'Home':
        event.preventDefault();
        applyVolume(0);
        return;
      case 'End':
        event.preventDefault();
        applyVolume(1);
        return;
      case 'PageUp':
        event.preventDefault();
        applyVolume(effectiveVolume + STEP * 2);
        return;
      case 'PageDown':
        event.preventDefault();
        applyVolume(effectiveVolume - STEP * 2);
        return;
      default:
        // Arrow keys are handled natively by input[type=range] and arrive as
        // change events, so they are deliberately not intercepted here.
        return;
    }
  };

  const icon = () => {
    if (muted || effectiveVolume === 0) {
      return <VolumeX size={ICON.md} aria-hidden="true" />;
    }
    if (effectiveVolume < 0.5) {
      return <Volume1 size={ICON.md} aria-hidden="true" />;
    }
    return <Volume2 size={ICON.md} aria-hidden="true" />;
  };

  return (
    <div
      className={`wireon-volume-control${className ? ` ${className}` : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        userSelect: 'none',
        ...style
      }}
      data-testid="volume-slider-container"
    >
      <Button
        variant="icon"
        onClick={toggleMute}
        title={muted ? 'Включить звук' : 'Выключить звук'}
        aria-label={muted ? 'Включить звук' : 'Выключить звук'}
        aria-pressed={muted}
        style={{ width: 'var(--control-md)', height: 'var(--control-md)' }}
        data-testid="volume-mute-btn"
      >
        {icon()}
      </Button>

      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={effectiveVolume}
        onChange={(e) => applyVolume(parseFloat(e.target.value))}
        onKeyDown={handleKeyDown}
        aria-label="Громкость"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
        aria-valuetext={`${percentage}%`}
        style={
          {
            width,
            /*
             * The fill is a share, not a paint job: `--range-fill` feeds the one
             * track rule in global.css. Painting it here as an element gradient
             * made this slider look unlike every other one in the app — a thumb
             * height tall instead of a track height — and it sat behind the
             * track box, so the moment the default track stopped being
             * transparent the fill would have vanished.
             */
            '--range-fill': `${percentage}%`
          } as React.CSSProperties
        }
        data-testid="volume-slider-input"
      />

      {showPercentage && (
        <span
          data-numeric
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--text-muted)',
            width: '34px',
            textAlign: 'right'
          }}
        >
          {percentage}%
        </span>
      )}
    </div>
  );
};
