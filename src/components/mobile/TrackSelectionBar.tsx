import React from 'react';
import { X } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { ICON } from '../../styles/icons';

/**
 * Панель над списком, когда треки выбирают пачкой.
 *
 * Одна на все списки телефона: плейлист, недавнее, избранное, офлайн. Панелей
 * было бы четыре — по одной на экран, — и разъехались бы они на первой же
 * правке: где-то осталась бы старая подпись, где-то пропала бы кнопка «выбрать
 * все». Различаются списки только набором действий, и он приходит снаружи.
 *
 * Стоит над списком, а не под ним: списки на телефоне длинные, и панель,
 * уехавшая за экран вместе с прокруткой, панелью быть перестаёт.
 */

export interface SelectionAction {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  testId: string;
}

export interface TrackSelectionBarProps {
  /** Сколько треков в списке — для подписи «выбрано N из M» и «выбрать все». */
  total: number;
  /** Идентификаторы всех треков списка: по ним работает «выбрать все». */
  allIds: string[];
  actions: SelectionAction[];
  testId: string;
}

export const TrackSelectionBar: React.FC<TrackSelectionBarProps> = ({
  total,
  allIds,
  actions,
  testId
}) => {
  const selected = useUIStore((s) => s.selectedTrackIds);
  const setSelected = useUIStore((s) => s.setSelected);
  const clearSelection = useUIStore((s) => s.clearSelection);

  if (selected === null) return null;

  const count = selected.length;
  const allChosen = total > 0 && count === total;

  return (
    <div className="selection-bar" data-testid={testId}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span
          style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}
          data-testid={`${testId}-count`}
        >
          {count === 0 ? 'Выберите треки' : `Выбрано ${count} из ${total}`}
        </span>
        <button
          type="button"
          className="selection-bar-link press focus-ring"
          onClick={() => setSelected(allChosen ? [] : allIds)}
          data-testid={`${testId}-all`}
        >
          {allChosen ? 'Снять все' : 'Выбрать все'}
        </button>
        <button
          type="button"
          className="press focus-ring tap-target"
          onClick={clearSelection}
          aria-label="Выйти из режима выбора"
          style={{ color: 'var(--text-secondary)', cursor: 'pointer' }}
          data-testid={`${testId}-close`}
        >
          <X size={ICON.lg} aria-hidden="true" />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        {actions.map((action) => (
          <button
            key={action.testId}
            type="button"
            className="selection-action press focus-ring"
            onClick={action.onClick}
            data-testid={action.testId}
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
