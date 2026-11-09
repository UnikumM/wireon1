import React from 'react';
import { Button } from './Button';
import { EmptyArt, type EmptyArtName } from './emptyArt';

/** Одно действие пустого экрана: подпись и что делать. */
export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  variant?: 'primary' | 'secondary';
  'data-testid'?: string;
}

export interface EmptyStateProps {
  /**
   * Иллюстрация одной линией по имени (см. `emptyArt.tsx`). Когда задана,
   * `icon` не показывается.
   */
  art?: EmptyArtName;
  /** Usually a lucide icon element. Старый путь; новые экраны берут `art`. */
  icon?: React.ReactNode;
  /** Что здесь будет — по-человечески, одной строкой. */
  title: string;
  /** Одна строка подсказки: что сделать, чтобы здесь что-то появилось. */
  description?: React.ReactNode;
  /**
   * Одно действие. Либо `{ label, onClick }` — тогда кнопка рисуется здесь,
   * либо готовый элемент (`Button` или что-то кликабельное).
   */
  action?: React.ReactNode | EmptyStateAction;
  className?: string;
  style?: React.CSSProperties;
  'data-testid'?: string;
}

function isActionSpec(action: EmptyStateProps['action']): action is EmptyStateAction {
  return (
    typeof action === 'object' &&
    action !== null &&
    !React.isValidElement(action) &&
    'label' in action &&
    'onClick' in action
  );
}

/**
 * Утопленный блок «здесь пока ничего нет» (`.panel-inset.empty-state`).
 *
 * Один на пустую область. Каждый пустой экран говорит, что здесь будет, и даёт
 * ровно одно действие — поэтому `action` один, а не набор кнопок: когда
 * человеку нечего смотреть, выбор между тремя кнопками — лишняя работа.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  art,
  icon,
  title,
  description,
  action,
  className = '',
  style,
  'data-testid': testId = 'empty-state'
}) => {
  const actionNode = isActionSpec(action) ? (
    <Button
      variant={action.variant ?? 'secondary'}
      size="sm"
      icon={action.icon}
      onClick={action.onClick}
      data-testid={action['data-testid']}
    >
      {action.label}
    </Button>
  ) : (
    action
  );

  return (
    <div
      className={`panel-inset empty-state${className ? ` ${className}` : ''}`}
      style={style}
      data-testid={testId}
      data-art={art}
    >
      {art ? (
        <EmptyArt name={art} />
      ) : (
        icon && (
          // Парение вместо неподвижного знака: пустой блок — единственное место, где
          // на экране вообще нечего разглядывать, и висящая иконка отличает
          // «здесь пока ничего нет» от «здесь что-то не загрузилось».
          <span className="animate-float text-faint inline-row" aria-hidden="true">
            {icon}
          </span>
        )
      )}
      <h3 className="m-0 type-lg weight-semibold text-primary empty-state-title">{title}</h3>
      {description && <p className="m-0 type-sm text-secondary empty-state-text">{description}</p>}
      {actionNode && <div className="mt-2 empty-state-action">{actionNode}</div>}
    </div>
  );
};
