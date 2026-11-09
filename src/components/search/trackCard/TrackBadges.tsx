import React from 'react';
import { CheckCircle2, Scissors, SignalLow } from 'lucide-react';
import { ICON } from '../../../styles/icons';
import { useTrackQuality } from '../../../hooks/useTrackQuality';
import { describeQuality } from '../../../services/trackQuality';
import { useTrackTags } from '../../../hooks/useTrackNote';

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

export interface QualityBadgeProps {
  trackId: string;
  variant: 'hero' | 'card' | 'row';
}

/**
 * Отметка о качестве записи у источника: «отрывок», когда SoundCloud отдаёт
 * только 30 секунд, «низкое качество» для потока ниже 96 кбит/с. Знание
 * берётся из `trackQuality` — его оставил прошлый разбор этого трека, — так
 * что человек видит предупреждение в списке, а не на середине куплета.
 */
export const QualityBadge: React.FC<QualityBadgeProps> = ({ trackId, variant }) => {
  const quality = useTrackQuality(trackId);
  if (!quality) return null;
  const { label, title } = describeQuality(quality);
  const Icon = quality === 'preview' ? Scissors : SignalLow;
  return (
    <span
      title={title}
      aria-label={title}
      className="badge track-quality-badge text-warning bg-warning-soft shrink-0"
      data-quality={quality}
      data-testid={`${variant}-quality-badge-${trackId}`}
    >
      <Icon size={ICON.xs} aria-hidden="true" />
      {label}
    </span>
  );
};

export interface TagBadgesProps {
  trackId: string;
  variant: 'hero' | 'card' | 'row';
}

/** Сколько тегов показывать на карточке: остальные сворачиваются в «+N». */
const VISIBLE_TAGS = 2;

/**
 * Свои теги трека («для бега», «показать Диме») — маленькими пилюлями рядом
 * с источником. Рисуется только когда теги есть; больше двух — «+N», полный
 * список во всплывающей подсказке и в окне «Теги и заметка».
 */
export const TagBadges: React.FC<TagBadgesProps> = ({ trackId, variant }) => {
  const tags = useTrackTags(trackId);
  if (tags.length === 0) return null;
  const visible = tags.slice(0, VISIBLE_TAGS);
  const rest = tags.length - visible.length;
  const title = `Теги: ${tags.join(', ')}`;
  return (
    <span
      className="inline-row gap-1 min-0"
      title={title}
      aria-label={title}
      data-testid={`${variant}-tag-badges-${trackId}`}
    >
      {visible.map((tag) => (
        <span key={tag} className="badge track-tag-badge" data-testid={`${variant}-tag-badge-${trackId}`}>
          {tag}
        </span>
      ))}
      {rest > 0 && (
        <span className="badge track-tag-badge shrink-0" data-numeric>
          +{rest}
        </span>
      )}
    </span>
  );
};
