import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { ICON } from '../../../styles/icons';

export interface OfflineBadgeProps {
  trackId: string;
  /**
   * Вид решает, сколько места бейджу можно занять: в «лучшем совпадении»
   * есть и подпись, в сетке и в строке — только значок, причём в строке с
   * горизонтальным отступом, чтобы не прилипал к значку источника.
   */
  variant: 'hero' | 'card' | 'row';
}

/**
 * Отметка «Доступно офлайн». Рисуется только когда трек уже лежит в кэше:
 * офлайн-режим сам сохраняет то, что играли, и отсюда ничего не скачать.
 */
export const OfflineBadge: React.FC<OfflineBadgeProps> = ({ trackId, variant }) => {
  if (variant === 'hero') {
    return (
      <span
        title="Доступно офлайн"
        aria-label="Доступно офлайн"
        className="inline-row gap-1 radius-xs text-secondary text-xs weight-semibold" style={{ padding: '2px 6px', backgroundColor: 'var(--surface-active)' }}
        data-testid={`hero-offline-badge-${trackId}`}
      >
        <CheckCircle2 size={ICON.xs} aria-hidden="true" />
        <span>Офлайн</span>
      </span>
    );
  }
  if (variant === 'card') {
    return (
      <span
        title="Доступно офлайн"
        aria-label="Доступно офлайн"
        className="inline-row text-secondary"
        data-testid={`card-offline-badge-${trackId}`}
      >
        <CheckCircle2 size={ICON.sm} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      title="Доступно офлайн"
      aria-label="Доступно офлайн"
      className="inline-row text-secondary py-0 px-1"
      data-testid={`track-offline-badge-${trackId}`}
    >
      <CheckCircle2 size={ICON.sm} aria-hidden="true" />
    </span>
  );
};
