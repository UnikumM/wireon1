import React from 'react';
import { AlertCircle, Loader2, Music, Search, Check } from 'lucide-react';
import { Button } from '../../common/Button';
import type { UnifiedTrack } from '../../../types/music';
import { pluralize } from '../../../utils/plural';
import { UNKNOWN_ARTIST } from '../../../utils/placeholders';
import { formatDuration } from '../../../utils/time';
import { ICON } from '../../../styles/icons';
import type { IndexedMatch, ManualState } from './types';

interface Props {
  unmatched: IndexedMatch[];
  manual: Record<number, ManualState>;
  onManualSearch: (index: number) => void;
  onPickCandidate: (index: number, track: UnifiedTrack) => void;
}

/** Отчёт о ненайденном с ручным выбором: раньше эти строки просто исчезали. */
export const UnmatchedList: React.FC<Props> = ({ unmatched, manual, onManualSearch, onPickCandidate }) => (
  <div
    className="radius-md overflow-hidden border-subtle bg-surface-2"
    data-testid="import-unmatched-list"
  >
    <div
      className="row gap-2 text-xs text-secondary py-2 px-3 border-b-subtle"
    >
      <AlertCircle size={ICON.sm} className="text-warning" />
      <span>
        Не нашли уверенного совпадения: {pluralize(unmatched.length, 'трек', 'трека', 'треков')}. Можно выбрать вручную.
      </span>
    </div>

    <div className="scrollbar-thin" style={{ maxHeight: '240px', overflowY: 'auto' }}>
      {unmatched.map(({ match, index }) => {
        const state = manual[index];
        return (
          <div
            key={index}
            className="py-2 px-3 border-b-subtle"
            data-testid={`import-unmatched-row-${index}`}
          >
            <div className="row gap-2">
              <div className="grow">
                <div className="text-truncate text-sm text-primary">
                  {match.item.title}
                  <span className="text-secondary ml-2">
                    — {match.item.artist || UNKNOWN_ARTIST}
                  </span>
                </div>
                {match.notes.length > 0 && (
                  <div className="text-xs text-muted mt-px">
                    {match.notes.join(' · ')}
                  </div>
                )}
              </div>

              {state?.addedId ? (
                <span
                  className="inline-row text-xs text-success shrink-0 gap-1"
                  data-testid={`import-manual-added-${index}`}
                >
                  <Check size={ICON.xs} /> Добавлен
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={
                    state?.isSearching ? (
                      <Loader2 size={ICON.xs} className="animate-spin" />
                    ) : (
                      <Search size={ICON.xs} />
                    )
                  }
                  disabled={state?.isSearching}
                  onClick={() => void onManualSearch(index)}
                  data-testid={`import-manual-search-${index}`}
                >
                  Выбрать вручную
                </Button>
              )}
            </div>

            {!state?.addedId && state?.candidates && (
              <div
                // Список кандидатов раскрывается под кнопкой «Выбрать
                // вручную» — то самое «нажал, и раскрылось».
                className="animate-drop-in mt-2 stack gap-px"
              >
                {state.candidates.length === 0 ? (
                  <span className="text-xs text-muted">
                    Источники ничего не вернули по этому названию.
                  </span>
                ) : (
                  state.candidates.map((candidate) => (
                    <button
                      type="button"
                      key={candidate.id}
                      className="menu-item-hover w-full text-left"
                      onClick={() => void onPickCandidate(index, candidate)}
                      data-testid={`import-manual-candidate-${index}-${candidate.id}`}
                    >
                      <Music size={ICON.xs} aria-hidden="true" className="shrink-0" />
                      <span className="text-truncate text-xs">
                        {candidate.artist || UNKNOWN_ARTIST} — {candidate.title}
                        {candidate.duration ? ` · ${formatDuration(candidate.duration)}` : ''}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  </div>
);
