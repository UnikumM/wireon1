import React from 'react';
import type { LyricHit } from '../../services/lyricSearch';

/**
 * Цитата под треком, найденным по строчке: та строка текста, где она есть,
 * с подсветкой совпадения. Для находок LRCLIB — подпись, откуда текст.
 */
export const LyricQuote: React.FC<{ hit: LyricHit }> = ({ hit }) => (
  <blockquote className="lyric-quote stack gap-1 m-0 text-sm text-secondary leading-sm" data-testid="lyric-quote">
    <p className="m-0">
      {hit.before}
      <mark className="lyric-hit">{hit.line}</mark>
      {hit.after}
    </p>
    {hit.origin === 'lrclib' && <p className="m-0 text-xs text-muted">Нашли по тексту на lrclib</p>}
  </blockquote>
);
