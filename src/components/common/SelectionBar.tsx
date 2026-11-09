import React from 'react';
import { X } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { Button } from './Button';
import { ICON } from '../../styles/icons';
import { plural } from '../../utils/plural';

/**
 * Полоса действий над отмеченными треками — на большом экране.
 *
 * Отдельно от телефонной: там она стоит столбиком значков над списком и
 * прилипает к верху, потому что список длинный и панель под пальцем. Здесь
 * места больше, действия помещаются подписанными кнопками в строку, и
 * прилипать некуда — у окна свой заголовок.
 *
 * Общее у них одно: состояние выбора. Оно живёт в сторе, поэтому обе панели
 * показывают одно и то же и обе умеют выйти из режима.
 */

export interface SelectionActionSpec {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  testId: string;
  danger?: boolean;
}

export interface SelectionBarProps {
  total: number;
  allIds: string[];
  actions: SelectionActionSpec[];
  testId: string;
}

export const SelectionBar: React.FC<SelectionBarProps> = ({ total, allIds, actions, testId }) => {
  const selected = useUIStore((s) => s.selectedTrackIds);
  const setSelected = useUIStore((s) => s.setSelected);
  const clearSelection = useUIStore((s) => s.clearSelection);

  if (selected === null) return null;

  const count = selected.length;
  const allChosen = total > 0 && count === total;

  return (
    <div
      className="card row gap-3 wrap py-3 px-4"
      data-testid={testId}
    >
      <span
        className="text-sm text-primary"
        data-testid={`${testId}-count`}
      >
        {count === 0
          ? 'Выберите треки'
          : `Выбрано ${count} ${plural(count, 'трек', 'трека', 'треков')} из ${total}`}
      </span>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => setSelected(allChosen ? [] : allIds)}
        data-testid={`${testId}-all`}
      >
        {allChosen ? 'Снять все' : 'Выбрать все'}
      </Button>

      <div className="row-stretch gap-2 ml-auto wrap">
        {actions.map((action) => (
          <Button
            key={action.testId}
            variant={action.danger ? 'ghost' : 'secondary'}
            size="sm"
            icon={action.icon}
            onClick={action.onClick}
            disabled={count === 0}
            data-testid={action.testId}
          >
            {action.label}
          </Button>
        ))}

        <Button
          variant="ghost"
          size="sm"
          icon={<X size={ICON.sm} />}
          onClick={clearSelection}
          aria-label="Выйти из режима выбора"
          data-testid={`${testId}-close`}
        >
          Готово
        </Button>
      </div>
    </div>
  );
};
