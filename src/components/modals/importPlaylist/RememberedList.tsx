import React from 'react';
import { Check } from 'lucide-react';
import { Button } from '../../common/Button';
import { pluralize } from '../../../utils/plural';
import { ICON } from '../../../styles/icons';
import type { IndexedMatch } from './types';

interface Props {
  remembered: IndexedMatch[];
  forgotten: Record<number, boolean>;
  onForget: (index: number) => void;
}

/**
 * Строки, взятые по прошлым подтверждениям, — с кнопкой «забыть»: подтверждённое
 * соответствие не должно становиться необратимым.
 */
export const RememberedList: React.FC<Props> = ({ remembered, forgotten, onForget }) => (
  <div
    className="radius-md overflow-hidden border-subtle bg-surface-2"
    data-testid="import-remembered-list"
  >
    <div
      className="row gap-2 text-xs text-secondary py-2 px-3 border-b-subtle"
    >
      <Check size={ICON.sm} className="text-success" />
      <span>
        {pluralize(remembered.length, 'трек взят', 'трека взяты', 'треков взяты')} по прошлым
        подтверждениям. Если запись не та — забудьте выбор.
      </span>
    </div>

    <div className="scrollbar-thin" style={{ maxHeight: '200px', overflowY: 'auto' }}>
      {remembered.map(({ match, index }) => (
        <div
          key={index}
          className="row gap-2 py-2 px-3 border-b-subtle"
          data-testid={`import-remembered-row-${index}`}
        >
          <div className="grow">
            <div className="text-truncate text-sm">
              {match.item.title}
            </div>
            <div
              className="text-truncate text-xs text-muted"
            >
              {match.track?.title} — {match.track?.artist}
              {match.fromLink === 'manual' ? ' · выбрано вами' : ' · найдено раньше'}
            </div>
          </div>
          {forgotten[index] ? (
            <span className="text-xs text-muted shrink-0">
              Забыто
            </span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onForget(index)}
              data-testid={`import-forget-link-${index}`}
            >
              Забыть выбор
            </Button>
          )}
        </div>
      ))}
    </div>
  </div>
);
