import React from 'react';
import { Radio } from 'lucide-react';
import { AudioSource } from '../../types/music';
import { ICON } from '../../styles/icons';

export interface SourceBadgeProps {
  source: AudioSource | 'all';
  size?: 'xs' | 'sm' | 'md';
  showLabel?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const SIZE_STYLES: Record<NonNullable<SourceBadgeProps['size']>, React.CSSProperties> = {
  // `xs` differs from `sm` in padding only. It used to shave the text down to
  // 11px, a size that exists nowhere else in the app: the scale bottoms out at
  // --text-xs, and a badge is exactly the kind of dense, uppercase text that
  // needs the floor rather than a value below it.
  xs: { padding: '1px var(--space-1)', fontSize: 'var(--text-xs)', gap: '3px' },
  sm: { padding: '2px var(--space-2)', fontSize: 'var(--text-xs)', gap: 'var(--space-1)' },
  md: { padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--text-sm)', gap: 'var(--space-1)' }
};

/**
 * Provider tag. Tinting comes from `.badge[data-source]` in `global.css`, so the
 * matte source colours live in exactly one place.
 */
export const SourceBadge: React.FC<SourceBadgeProps> = ({
  source,
  size = 'sm',
  showLabel = true,
  className = '',
  style
}) => {
  const isYT = source === 'youtube';
  const isSC = source === 'soundcloud';

  const label = isYT ? 'YouTube' : isSC ? 'SoundCloud' : 'Все источники';
  // «YT» и «SC» — аббревиатуры, прописные им и положены. «Все» — обычное слово,
  // и капсом оно кричало на треть громче соседей по строке.
  const shortLabel = isYT ? 'YT' : isSC ? 'SC' : 'Все';

  return (
    <span
      className={`badge wireon-source-badge${className ? ` ${className}` : ''}`}
      style={{ ...SIZE_STYLES[size], ...style }}
      title={label}
      data-source={source}
    >
      {isYT && (
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
        </svg>
      )}
      {isSC && (
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M11.56 8.87V17h9.09a3.35 3.35 0 0 0 3.35-3.35 3.35 3.35 0 0 0-3.35-3.35c-.24 0-.47.03-.7.08a4.99 4.99 0 0 0-4.9-3.93 4.96 4.96 0 0 0-3.49 1.42zm-1.63 2.14v5.99h1.1V10.7c-.38.1-.75.2-1.1.31zm-1.64.44v5.55h1.1v-5.26c-.36.14-.73.28-1.1.41zm-1.63.53v5.02h1.1v-4.75c-.36.16-.73.33-1.1.48zm-1.64.63v4.39h1.1v-4.14c-.36.17-.73.35-1.1.52zm-1.64.81v3.58h1.1v-3.35c-.37.19-.74.39-1.1.58zm-1.63 1.05v2.53h1.1v-2.31c-.37.22-.73.44-1.1.66zm-1.64 1.34v1.19h1.1v-.98c-.37.25-.74.5-1.1.75z" />
        </svg>
      )}
      {!isYT && !isSC && <Radio size={ICON.xs} aria-hidden="true" style={{ flexShrink: 0 }} />}
      {showLabel && <span>{size === 'xs' ? shortLabel : label}</span>}
    </span>
  );
};
