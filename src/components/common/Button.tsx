import React from 'react';
import { ICON } from '../../styles/icons';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'subtle'
  | 'ghost'
  | 'danger'
  | 'icon'
  /** Legacy names kept as aliases while the UI migrates. */
  | 'neon'
  | 'cyan'
  | 'glass';

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

/** Legacy variant names resolve onto the matte set. */
const VARIANT_ALIASES: Record<string, ButtonVariant> = {
  neon: 'primary',
  cyan: 'primary',
  glass: 'secondary'
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  isLoading?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  /** Renders the accent-soft "toggled on" treatment of a ghost/icon button. */
  isActive?: boolean;
}

function resolveVariant(variant: ButtonVariant): ButtonVariant {
  return VARIANT_ALIASES[variant] ?? variant;
}

/*
 * Цвета вариантов живут в `.wireon-btn[data-variant]` в global.css, а `isActive`
 * — в атрибуте `data-active`. Здесь их держать нельзя: инлайновое объявление
 * старше любого правила таблицы стилей, поэтому перекраска по `:hover` до кнопки
 * не доходила — так приложение и осталось с кнопками, которые описывали переход
 * цвета, но не отвечали на наведение. Инлайновые переопределения на местах
 * вызова продолжают работать: они по-прежнему старше класса.
 */

/*
 * Обёртка слота — не декорация, а две починки сразу.
 *
 * `align-items: center` с обнулённым межстрочным: по умолчанию содержимое
 * наследовало `line-height` кнопки и глиф прижимался к верху обёртки, из-за чего
 * иконка вставала выше центра рамки во всём приложении.
 *
 * `gap: inherit` — потому что все дети кладутся в одну обёртку, и `gap` самой
 * кнопки до них не доходил: между манометром и «0.8×» не было ни пикселя, и
 * цифры читались как продолжение иконки. Обёртка передаёт свой `gap` дальше и
 * перестаёт быть барьером.
 */
const SLOT_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'inherit',
  flexShrink: 0,
  lineHeight: 0
};

function sizeStyles(size: ButtonSize): React.CSSProperties {
  switch (size) {
    case 'xs':
      return {
        minHeight: 'var(--control-xs)',
        padding: '2px var(--space-2)',
        fontSize: 'var(--text-xs)',
        letterSpacing: 'var(--tracking-xs)',
        borderRadius: 'var(--radius-xs)',
        gap: 'var(--space-1)'
      };
    case 'sm':
      return {
        minHeight: 'var(--control-sm)',
        padding: 'var(--space-1) var(--space-3)',
        fontSize: 'var(--text-sm)',
        letterSpacing: 'var(--tracking-sm)',
        borderRadius: 'var(--radius-sm)',
        gap: 'var(--space-2)'
      };
    case 'lg':
      return {
        minHeight: 'var(--control-lg)',
        padding: 'var(--space-3) var(--space-5)',
        fontSize: 'var(--text-base)',
        borderRadius: 'var(--radius-sm)',
        gap: 'var(--space-2)'
      };
    case 'icon':
      return {
        padding: 0,
        // Off-scale 36px used to be the default; --control-md pairs with ICON.md
        // so an un-overridden icon button matches the rest of its row.
        width: 'var(--control-md)',
        height: 'var(--control-md)',
        // No border-radius here on purpose. Inline wins over the stylesheet, and
        // `[data-variant='icon']` is the rule that makes an icon button round —
        // declaring --radius-sm at this size silently squared off every icon
        // button in the app and forced call sites to re-declare the radius.
        // Other variants used at this size still get --radius-sm from .wireon-btn.
        flexShrink: 0
      };
    case 'md':
    default:
      return {
        minHeight: 'var(--control-md)',
        padding: 'var(--space-2) var(--space-4)',
        fontSize: 'var(--text-base)',
        borderRadius: 'var(--radius-sm)',
        gap: 'var(--space-2)'
      };
  }
}

/**
 * The single button primitive. `variant="icon"` is shorthand for a ghost button
 * at `size="icon"`, and the three legacy variant names still resolve so
 * un-migrated call sites keep rendering.
 */
export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'secondary',
  size,
  icon,
  iconPosition = 'left',
  isLoading = false,
  loading = false,
  fullWidth = false,
  isActive = false,
  disabled,
  type,
  className = '',
  style,
  ...props
}) => {
  const resolved = resolveVariant(variant);
  const effectiveSize: ButtonSize = size ?? (resolved === 'icon' ? 'icon' : 'md');
  const busy = isLoading || loading;

  const combined: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabled || busy ? 'not-allowed' : 'pointer',
    width: fullWidth ? '100%' : undefined,
    userSelect: 'none',
    whiteSpace: 'nowrap',
    fontWeight: 'var(--weight-medium)',
    ...sizeStyles(effectiveSize),
    ...style
  };

  const isIconOnly = effectiveSize === 'icon' || (!children && !!icon);

  return (
    <button
      type={type ?? 'button'}
      className={`wireon-btn${isIconOnly ? ' press' : ''}${className ? ` ${className}` : ''}`}
      style={combined}
      disabled={disabled || busy}
      data-variant={resolved}
      data-active={isActive || undefined}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? (
        <span
          className="animate-spin"
          aria-hidden="true"
          style={{
            // Same box as a default glyph: the spinner replaces the icon, and a
            // size of its own made the button jump width while it was busy.
            width: `${ICON.md}px`,
            height: `${ICON.md}px`,
            border: '2px solid currentColor',
            borderRightColor: 'transparent',
            borderRadius: 'var(--radius-full)',
            display: 'inline-block'
          }}
        />
      ) : (
        <>
          {icon && iconPosition === 'left' && <span style={SLOT_STYLE}>{icon}</span>}
          {children ? <span style={SLOT_STYLE}>{children}</span> : null}
          {icon && iconPosition === 'right' && <span style={SLOT_STYLE}>{icon}</span>}
        </>
      )}
    </button>
  );
};
