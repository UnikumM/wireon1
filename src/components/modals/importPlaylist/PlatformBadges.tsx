import React from 'react';
import { Disc } from 'lucide-react';
import type { PlatformType } from '../../../services/playlistImporter';
import { ICON } from '../../../styles/icons';
import { PLATFORM_CONFIG } from './platforms';

/** Плашка площадки, узнанной по ссылке, — поверх правого края поля ввода. */
export const DetectedPlatformBadge: React.FC<{ platform: PlatformType }> = ({ platform }) => (
  <div
    style={{
      position: 'absolute',
      right: 'var(--space-2)',
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-1)',
      padding: 'var(--space-1) var(--space-2)',
      borderRadius: 'var(--radius-full)',
      backgroundColor: PLATFORM_CONFIG[platform].bg,
      border: `1px solid ${PLATFORM_CONFIG[platform].border}`,
      color: PLATFORM_CONFIG[platform].color,
      fontSize: 'var(--text-xs)',
      fontWeight: 'var(--weight-semibold)'
    }}
    data-testid="platform-detected-badge"
  >
    <Disc size={ICON.xs} />
    <span>{PLATFORM_CONFIG[platform].name}</span>
  </div>
);

/** Плашка из списка «Откуда можно переносить»; подсвечивается, когда ссылка — с неё. */
export const PlatformChip: React.FC<{ platform: PlatformType; isMatch: boolean }> = ({ platform, isMatch }) => {
  const cfg = PLATFORM_CONFIG[platform];
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: 'var(--space-1) var(--space-3)',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: isMatch ? cfg.bg : 'var(--surface-3)',
        border: `1px solid ${isMatch ? cfg.border : 'var(--border-subtle)'}`,
        color: isMatch ? cfg.color : 'var(--text-secondary)',
        fontSize: 'var(--text-xs)',
        fontWeight: isMatch ? 'var(--weight-semibold)' : 'var(--weight-normal)',
        // `all` анимирует и то, что меняться не должно: вместе с
        // цветом плашки браузер переходит `font-weight`, и текст
        // на 150 мс проходит через дробные веса — на этом
        // размере он просто размывается. Перечислены свойства,
        // которым переход и нужен.
        transition:
          'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)'
      }}
      data-testid={`platform-chip-${platform}`}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          backgroundColor: isMatch ? cfg.color : 'var(--text-muted)'
        }}
      />
      {cfg.name}
    </div>
  );
};
