import React from 'react';

export interface SkeletonProps {
  /** Any CSS length. Defaults to a full-width bar. */
  width?: number | string;
  height?: number | string;
  radius?: string;
  /** Repeats the bar with a gap; handy for list placeholders. */
  count?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Loading placeholder. The shimmer comes from `.skeleton` in `global.css`, which
 * drops the animation under `prefers-reduced-motion: reduce`.
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  width = '100%',
  height = 16,
  radius = 'var(--radius-sm)',
  count = 1,
  className = '',
  style
}) => {
  const bars = Array.from({ length: Math.max(1, count) });

  if (bars.length === 1) {
    return (
      <div
        className={`skeleton${className ? ` ${className}` : ''}`}
        style={{ width, height, borderRadius: radius, ...style }}
        aria-hidden="true"
        data-testid="skeleton"
      />
    );
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
      aria-hidden="true"
      data-testid="skeleton-group"
    >
      {bars.map((_, index) => (
        <div
          key={index}
          className={`skeleton${className ? ` ${className}` : ''}`}
          style={{ width, height, borderRadius: radius, ...style }}
        />
      ))}
    </div>
  );
};
