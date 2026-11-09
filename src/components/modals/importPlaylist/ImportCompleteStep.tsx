import React from 'react';
import { CheckCircle2, Play } from 'lucide-react';
import type { ImportMatch } from '../../../services/playlistImporter';
import { Button } from '../../common/Button';
import type { UnifiedTrack } from '../../../types/music';
import { ICON } from '../../../styles/icons';
import type { IndexedMatch, ManualState, PreviewState } from './types';
import { UnmatchedList } from './UnmatchedList';
import { RememberedList } from './RememberedList';

interface Props {
  preview: PreviewState;
  resolvedTracks: UnifiedTrack[];
  matches: ImportMatch[];
  unmatched: IndexedMatch[];
  remembered: IndexedMatch[];
  manual: Record<number, ManualState>;
  forgotten: Record<number, boolean>;
  onManualSearch: (index: number) => void;
  onPickCandidate: (index: number, track: UnifiedTrack) => void;
  onForget: (index: number) => void;
  onOpenPlaylist: () => void;
  onClose: () => void;
}

/** Четвёртый шаг: итог переноса, отчёт о ненайденном и память подтверждений. */
export const ImportCompleteStep: React.FC<Props> = ({
  preview,
  resolvedTracks,
  matches,
  unmatched,
  remembered,
  manual,
  forgotten,
  onManualSearch,
  onPickCandidate,
  onForget,
  onOpenPlaylist,
  onClose
}) => (
  <div className="animate-drop-in stack gap-4 py-2 px-0">
    <div className="text-center">
      <div
        className="inline-row justify-center bg-success-soft" style={{ width: '60px', height: '60px', borderRadius: '50%', margin: '0 auto var(--space-3) auto' }}
      >
        <CheckCircle2 size={ICON.display} className="text-success" />
      </div>

      <h4 className="m-0 text-lg text-primary weight-semibold">
        Готово!
      </h4>
      <p className="text-sm text-secondary" style={{ margin: 'var(--space-1) 0 0 0' }}>
        В плейлист «<strong>{preview.title}</strong>» перенесено треков: <strong>{resolvedTracks.length}</strong>
        {unmatched.length > 0 && <> из {matches.length + preview.readyTracks.length}</>}.
      </p>
    </div>

    {unmatched.length > 0 && (
      <UnmatchedList
        unmatched={unmatched}
        manual={manual}
        onManualSearch={onManualSearch}
        onPickCandidate={onPickCandidate}
      />
    )}

    {remembered.length > 0 && (
      <RememberedList remembered={remembered} forgotten={forgotten} onForget={onForget} />
    )}

    <div className="row-stretch justify-center gap-3 mt-2">
      <Button variant="ghost" onClick={onClose} data-testid="import-done-btn">
        Закрыть
      </Button>
      <Button
        variant="primary"
        icon={<Play size={ICON.md} />}
        onClick={onOpenPlaylist}
        data-testid="open-imported-playlist-btn"
      >
        Открыть плейлист
      </Button>
    </div>
  </div>
);
