import React from 'react';

export interface EmptyStateProps {
  /** Usually a lucide icon element. */
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  /** Primary affordance — a `Button`, or anything clickable. */
  action?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  'data-testid'?: string;
}

/**
 * The recessed "nothing here yet" well (`.panel-inset`). One per empty region;
 * always give the user the next action if there is one.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className = '',
  style,
  'data-testid': testId = 'empty-state'
}) => {
  return (
    <div
      className={`panel-inset${className ? ` ${className}` : ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-8) var(--space-5)',
        ...style
      }}
      data-testid={testId}
    >
      {icon && (
        // Парение вместо неподвижного знака: пустой блок — единственное место, где
        // на экране вообще нечего разглядывать, и висящая иконка отличает
        // «здесь пока ничего нет» от «здесь что-то не загрузилось».
        <span
          className="animate-float text-faint inline-row"
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <h3
        className="m-0 text-lg weight-semibold text-primary leading-lg tracking-lg"
      >
        {title}
      </h3>
      {description && (
        <p
          className="m-0 text-sm text-secondary leading-sm" style={{ maxWidth: '44ch' }}
        >
          {description}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
};
