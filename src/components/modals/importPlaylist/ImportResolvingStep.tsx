import React from 'react';
import { Loader2, Music } from 'lucide-react';
import { ICON } from '../../../styles/icons';
import type { ResolveProgress } from './types';

interface Props {
  progress: ResolveProgress;
  percentComplete: number;
}

/** Третий шаг: параллельный поиск по источникам с живой полосой хода. */
export const ImportResolvingStep: React.FC<Props> = ({ progress, percentComplete }) => (
  <div className="animate-drop-in stack gap-4 py-3 px-0">
    <div className="text-center">
      <div
        className="inline-row justify-center mb-3 bg-accent-soft" style={{ width: '56px', height: '56px', borderRadius: '50%' }}
      >
        <Loader2 size={ICON['2xl']} className="animate-spin text-accent" />
      </div>
      <h4 className="m-0 text-lg text-primary weight-semibold">
        Ищем треки по источникам…
      </h4>
      <p className="text-sm text-secondary" style={{ margin: 'var(--space-1) 0 0 0' }}>
        Сверяем название, исполнителя и длительность — чтобы не подсунуть чужую версию
      </p>
    </div>

    {/* Полоса хода */}
    <div>
      <div className="row-stretch justify-between text-xs text-secondary mb-1">
        <span>
          Обработано {progress.resolved} из {progress.total}
        </span>
        <span className="weight-semibold text-accent">{percentComplete}%</span>
      </div>
      <div
        className="w-full radius-full overflow-hidden bg-surface-3" style={{ height: '8px' }}
        data-testid="import-progress-bar-container"
      >
        <div
          style={{
            width: `${percentComplete}%`,
            height: '100%',
            backgroundColor: 'var(--accent)',
            borderRadius: 'var(--radius-full)',
            // Токены вместо 0.2s ease: у полосы импорта и полосы
            // обновления в AboutSettings была разная длительность на
            // одинаковом по смыслу движении.
            transition: 'width var(--dur-normal) var(--ease-out)'
          }}
          data-testid="import-progress-bar-fill"
        />
      </div>
    </div>

    {progress.current && (
      <div
        className="text-truncate radius-sm text-xs text-secondary row gap-2 py-2 px-3 bg-surface-2"
        data-testid="current-resolving-track"
      >
        <Music size={ICON.sm} className="text-secondary shrink-0" />
        <span>Сейчас ищем: <strong className="text-primary">{progress.current}</strong></span>
      </div>
    )}
  </div>
);
