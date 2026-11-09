import React from 'react';

export interface RoundButtonProps {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  /** `md` 40 px для плашки, `lg` 48 px для сцены. */
  size?: 'md' | 'lg';
  className?: string;
  'data-testid'?: string;
}

/** Круглая кнопка транспорта на телефоне: один размер под палец, акцент на активной. */
export const RoundButton: React.FC<RoundButtonProps> = ({
  label,
  onClick,
  children,
  active = false,
  size = 'lg',
  className = '',
  'data-testid': testId
}) => (
  <button
    type="button"
    className={`press focus-ring player-round ${size === 'md' ? 'player-round-md' : 'player-round-lg'} ${className}`}
    onClick={onClick}
    aria-label={label}
    aria-pressed={active || undefined}
    data-active={active ? 'true' : undefined}
    data-testid={testId}
  >
    {children}
  </button>
);

export interface LabelledButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  'data-testid'?: string;
}

/** Кнопка с подписью внутри: по слову нажимается так же, как по значку. */
export const LabelledButton: React.FC<LabelledButtonProps> = ({
  icon,
  label,
  onClick,
  active = false,
  'data-testid': testId
}) => (
  <button
    type="button"
    className="press player-labelled row gap-2 type-sm pointer"
    onClick={onClick}
    aria-pressed={active || undefined}
    data-active={active ? 'true' : undefined}
    data-testid={testId}
  >
    {icon}
    {label}
  </button>
);
