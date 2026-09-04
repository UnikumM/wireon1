import React from 'react';

export interface SettingsSectionProps {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** A titled panel. Every settings group is one of these. */
export const SettingsSection: React.FC<SettingsSectionProps> = ({ id, title, description, children }) => (
  <section
    className="panel"
    aria-labelledby={`${id}-heading`}
    style={{
      padding: 'var(--space-5)',
      borderRadius: 'var(--radius-lg)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-4)'
    }}
    data-testid={`settings-section-${id}`}
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <h2
        id={`${id}-heading`}
        style={{
          margin: 0,
          fontSize: 'var(--text-lg)',
          lineHeight: 'var(--leading-lg)',
          letterSpacing: 'var(--tracking-lg)',
          fontWeight: 'var(--weight-semibold)',
          color: 'var(--text-primary)'
        }}
      >
        {title}
      </h2>
      {description && (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            lineHeight: 'var(--leading-sm)',
            color: 'var(--text-muted)'
          }}
        >
          {description}
        </p>
      )}
    </div>
    {children}
  </section>
);

export interface SettingRowProps {
  /** Rendered as the visible label; `controlId` ties it to the real control. */
  label: string;
  controlId: string;
  description?: string;
  /** Right-hand control. */
  children: React.ReactNode;
  /** Stacks the control under the label — for sliders and radio groups. */
  stacked?: boolean;
}

export const SettingRow: React.FC<SettingRowProps> = ({
  label,
  controlId,
  description,
  children,
  stacked = false
}) => (
  <div
    style={{
      display: 'flex',
      flexDirection: stacked ? 'column' : 'row',
      alignItems: stacked ? 'stretch' : 'center',
      justifyContent: 'space-between',
      // Перенос — не украшение: у органов управления справа стоит
      // `flexShrink: 0`, поэтому на узком экране они не ужимались, а уезжали за
      // правый край. Прокрутки по горизонтали у настроек нет, так что кнопка
      // «Выбрать файл» просто переставала существовать. Теперь она уходит на
      // вторую строку.
      flexWrap: stacked ? 'nowrap' : 'wrap',
      gap: stacked ? 'var(--space-2)' : 'var(--space-5)'
    }}
  >
    {/*
      * Основа 220 px — только в строчном виде.
      *
      * В колонке `flex-basis` задаёт **высоту**, а не ширину: у `stacked` строк
      * блок с подписью получал 220 px высоты, и между «Громкость» и её
      * ползунком зияла пустая полоса в пол-экрана. На узком экране почти все
      * строки настроек как раз `stacked`.
      */}
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        minWidth: 0,
        flex: stacked ? '0 0 auto' : '1 1 220px'
      }}
    >
      <label
        htmlFor={controlId}
        style={{
          fontSize: 'var(--text-sm)',
          lineHeight: 'var(--leading-sm)',
          fontWeight: 'var(--weight-medium)',
          color: 'var(--text-primary)',
          cursor: 'pointer'
        }}
      >
        {label}
      </label>
      {description && (
        <p
          id={`${controlId}-description`}
          style={{
            margin: 0,
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)',
            color: 'var(--text-muted)',
            maxWidth: '62ch'
          }}
        >
          {description}
        </p>
      )}
    </div>
    <div
      style={{
        // `flexShrink: 0` остаётся: на широком окне органы управления не должны
        // ужиматься. А `maxWidth: 100%` не даёт им, уже перенесённым на свою
        // строку, оказаться шире этой строки — иначе длинное значение всё равно
        // уезжает за край, только строкой ниже.
        flexShrink: 0,
        maxWidth: '100%',
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 'var(--space-3)'
      }}
    >
      {children}
    </div>
  </div>
);

export interface InfoRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

/** Label/value pair for read-only facts — no form control, so no `htmlFor`. */
export const InfoRow: React.FC<InfoRowProps> = ({ label, description, children }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      // Ровно та же причина, что у `SettingRow`: значение справа не сжимается,
      // и на узком экране уезжало за край вместе с цифрами, ради которых строка
      // и существует.
      flexWrap: 'wrap',
      gap: 'var(--space-5)'
    }}
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 220px' }}>
      <span
        style={{
          fontSize: 'var(--text-sm)',
          lineHeight: 'var(--leading-sm)',
          fontWeight: 'var(--weight-medium)',
          color: 'var(--text-primary)'
        }}
      >
        {label}
      </span>
      {description && (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)',
            color: 'var(--text-muted)',
            maxWidth: '62ch'
          }}
        >
          {description}
        </p>
      )}
    </div>
    <div
      style={{
        // `flexShrink: 0` остаётся: на широком окне органы управления не должны
        // ужиматься. А `maxWidth: 100%` не даёт им, уже перенесённым на свою
        // строку, оказаться шире этой строки — иначе длинное значение всё равно
        // уезжает за край, только строкой ниже.
        flexShrink: 0,
        maxWidth: '100%',
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 'var(--space-3)'
      }}
    >
      {children}
    </div>
  </div>
);

export interface ToggleSettingProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/**
 * A native checkbox, deliberately: `accent-color` and the shared
 * `:focus-visible` ring in `global.css` already make it matte and
 * keyboard-operable, and it needs no ARIA of its own.
 */
export const ToggleSetting: React.FC<ToggleSettingProps> = ({
  id,
  label,
  description,
  checked,
  onChange,
  disabled = false
}) => (
  <SettingRow label={label} controlId={id} description={description}>
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-describedby={description ? `${id}-description` : undefined}
      onChange={(e) => onChange(e.target.checked)}
      data-testid={id}
    />
  </SettingRow>
);

export interface SliderSettingProps {
  id: string;
  label: string;
  description?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  /** Read-out next to the label, e.g. `+3 dB`. Also used as `aria-valuetext`. */
  format: (value: number) => string;
  disabled?: boolean;
}

export const SliderSetting: React.FC<SliderSettingProps> = ({
  id,
  label,
  description,
  min,
  max,
  step = 1,
  value,
  onChange,
  format,
  disabled = false
}) => {
  const span = max - min;
  const percentage = span > 0 ? Math.round(((value - min) / span) * 100) : 0;

  return (
    <SettingRow label={label} controlId={id} description={description} stacked>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-describedby={description ? `${id}-description` : undefined}
          aria-valuetext={format(value)}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={
            {
              flex: 1,
              /* The share only — the track itself is one rule in global.css. */
              '--range-fill': `${percentage}%`
            } as React.CSSProperties
          }
          data-testid={id}
        />
        <span
          data-numeric
          style={{
            width: '62px',
            textAlign: 'right',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-secondary)',
            flexShrink: 0
          }}
          data-testid={`${id}-value`}
        >
          {format(value)}
        </span>
      </div>
    </SettingRow>
  );
};
