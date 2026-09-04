import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../../utils/time';

const KEYBOARD_SEEK_STEP_SECONDS = 5;

export interface SeekBarProps {
  currentTime: number;
  duration: number;
  buffered: number;
  onSeek: (seconds: number) => void;
  /** `compact` is the player bar, `comfortable` the fullscreen player. */
  variant?: 'compact' | 'comfortable';
  idPrefix?: string;
  className?: string;
}

/**
 * Timeline with a buffered rail, drag/click seeking and a full slider keyboard
 * contract. A chunked stream whose duration is not known yet degrades to a
 * read-only rail rather than inventing a position.
 */
export const SeekBar: React.FC<SeekBarProps> = ({
  currentTime,
  duration,
  buffered,
  onSeek,
  variant = 'compact',
  idPrefix = 'player',
  className = ''
}) => {
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  // The change handler must know about the drag in the same tick it fires in.
  const scrubbingRef = useRef(false);
  const scrubTimeRef = useRef(0);

  const seekable = duration > 0;
  const clampTime = useCallback(
    (seconds: number) => (seekable ? Math.max(0, Math.min(seconds, duration)) : 0),
    [duration, seekable]
  );

  // An incoming syncProgress must never pull the handle out from under a drag.
  const displayTime = isScrubbing ? scrubTime : clampTime(currentTime);
  const progressPercent = seekable ? (displayTime / duration) * 100 : 0;
  const bufferedPercent = seekable ? Math.min(100, (buffered / duration) * 100) : 0;

  const commitScrub = useCallback(() => {
    scrubbingRef.current = false;
    setIsScrubbing(false);
    onSeek(scrubTimeRef.current);
  }, [onSeek]);

  // The pointer often leaves the rail before it is released.
  useEffect(() => {
    if (!isScrubbing || typeof window === 'undefined') return;

    window.addEventListener('pointerup', commitScrub);
    window.addEventListener('pointercancel', commitScrub);
    return () => {
      window.removeEventListener('pointerup', commitScrub);
      window.removeEventListener('pointercancel', commitScrub);
    };
  }, [isScrubbing, commitScrub]);

  const handlePointerDown = () => {
    if (!seekable) return;
    const start = clampTime(currentTime);
    scrubbingRef.current = true;
    scrubTimeRef.current = start;
    setScrubTime(start);
    setIsScrubbing(true);
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = clampTime(parseFloat(event.target.value));
    if (scrubbingRef.current) {
      scrubTimeRef.current = value;
      setScrubTime(value);
      return;
    }
    onSeek(value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!seekable) return;

    const base = scrubbingRef.current ? scrubTimeRef.current : currentTime;
    let target: number | null = null;

    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        target = base - KEYBOARD_SEEK_STEP_SECONDS;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        target = base + KEYBOARD_SEEK_STEP_SECONDS;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = duration;
        break;
      default:
        return;
    }

    // The native 0.1 s step would fight the 5 s contract.
    event.preventDefault();
    onSeek(clampTime(target));
  };

  const handleRailPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!seekable || isScrubbing) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    setHoverTime(clampTime(((event.clientX - rect.left) / rect.width) * duration));
  };

  const previewTime = isScrubbing ? displayTime : hoverTime;
  const previewPercent = seekable && previewTime !== null ? (previewTime / duration) * 100 : 0;

  const timeStyle: React.CSSProperties = {
    flexShrink: 0,
    minWidth: 'var(--space-7)',
    fontSize: variant === 'compact' ? 'var(--text-xs)' : 'var(--text-sm)',
    color: 'var(--text-muted)'
  };

  const railStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    height: 'var(--range-track-height)',
    borderRadius: 'var(--radius-full)',
    pointerEvents: 'none'
  };

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        width: '100%'
      }}
    >
      <span data-numeric style={{ ...timeStyle, textAlign: 'right' }} data-testid={`${idPrefix}-current-time`}>
        {formatDuration(displayTime)}
      </span>

      <div
        style={{
          position: 'relative',
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          height: 'var(--range-thumb-size)'
        }}
        onPointerMove={handleRailPointerMove}
        onPointerLeave={() => setHoverTime(null)}
      >
        {/* Recessed base rail, then the buffered rail, then the accent fill. */}
        <div style={{ ...railStyle, right: 0, background: 'var(--surface-sunken)' }} />
        <div style={{ ...railStyle, width: `${bufferedPercent}%`, background: 'var(--surface-active)' }} />

        <input
          type="range"
          role="slider"
          min={0}
          max={seekable ? duration : 1}
          step={0.1}
          value={displayTime}
          disabled={!seekable}
          onPointerDown={handlePointerDown}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          aria-label="Перемотка по треку"
          aria-valuemin={0}
          aria-valuemax={seekable ? Math.floor(duration) : 0}
          aria-valuenow={Math.floor(displayTime)}
          aria-valuetext={
            seekable
              ? `${formatDuration(displayTime)} из ${formatDuration(duration)}`
              : 'Позиция неизвестна — длительность ещё не загрузилась'
          }
          data-testid={`${idPrefix}-seek-slider`}
          /*
           * `range-bare` keeps the track transparent. This is the one slider in
           * the app that draws its own rails — sunken base, buffered, then the
           * accent fill — because two independent levels cannot come from a
           * single gradient. An opaque default track would cover both.
           */
          className="range-bare"
          style={{
            position: 'relative',
            width: '100%',
            background: `linear-gradient(to right, var(--accent) 0 ${progressPercent}%, transparent ${progressPercent}% 100%)`
          }}
        />

        {previewTime !== null && seekable && (
          <span
            data-numeric
            aria-hidden="true"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + var(--space-2))',
              left: `${previewPercent}%`,
              transform: 'translateX(-50%)',
              padding: '2px var(--space-2)',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-primary)',
              background: 'var(--surface-4)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              boxShadow: 'var(--shadow-md)',
              pointerEvents: 'none',
              whiteSpace: 'nowrap'
            }}
            data-testid={`${idPrefix}-seek-preview`}
          >
            {formatDuration(previewTime)}
          </span>
        )}
      </div>

      <span data-numeric style={timeStyle} data-testid={`${idPrefix}-duration`}>
        {seekable ? formatDuration(duration) : '--:--'}
      </span>
    </div>
  );
};
