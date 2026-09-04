import React, { useEffect, useState } from 'react';
import { SettingsSection, SettingRow } from './SettingsPrimitives';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useThemeStore, resolveAccentHex } from '../../store/useThemeStore';
import {
  ACCENT_PRESETS,
  THEME_DEPTHS,
  contrastRatio,
  normalizeHex,
  pickTextOnAccent,
  type ThemeDepth
} from '../../styles/palette';
import { designVars, findPreset } from '../../styles/presets';
import { VisualizerPreset } from '../../types/visualizer';

/** Russian names for the presets, in the order they appear in the picker. */
export const PRESET_LABELS: Record<VisualizerPreset, string> = {
  CYBER_BARS: 'Полосы',
  HOLOGRAPHIC_WAVE: 'Волна',
  CIRCULAR_SPECTRUM: 'Круг',
  AMBIENT_AURORA: 'Аврора'
};

const PRESETS = Object.keys(PRESET_LABELS) as VisualizerPreset[];

/** The value that stands for "no visualizer at all". */
const OFF = 'OFF';

/** WCAG AA for body text. Below this a label on the accent stops being readable. */
const MIN_LABEL_CONTRAST = 4.5;

/** Shared look of the two block headings inside this section. */
const HEADING_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-sm)',
  fontWeight: 'var(--weight-semibold)',
  color: 'var(--text-primary)'
};

const HINT_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-xs)',
  color: 'var(--text-muted)',
  maxWidth: '62ch'
};

export const AppearanceSettings: React.FC = () => {
  const visualizerEnabled = usePlayerStore((s) => s.visualizerEnabled);
  const visualizerPreset = usePlayerStore((s) => s.visualizerPreset);
  const setVisualizerEnabled = usePlayerStore((s) => s.setVisualizerEnabled);
  const setVisualizerPreset = usePlayerStore((s) => s.setVisualizerPreset);

  const accentId = useThemeStore((s) => s.accentId);
  const customAccentHex = useThemeStore((s) => s.customAccentHex);
  const depth = useThemeStore((s) => s.depth);
  // Not this section's own settings: the depth swatches need them to be computed
  // in the preset the person is actually looking at.
  const presetId = useThemeStore((s) => s.presetId);
  const overrides = useThemeStore((s) => s.overrides);
  const setAccent = useThemeStore((s) => s.setAccent);
  const setCustomAccent = useThemeStore((s) => s.setCustomAccent);
  const setDepth = useThemeStore((s) => s.setDepth);

  const accentHex = resolveAccentHex({ accentId, customAccentHex });

  // The text field keeps its own draft: typing "#8fc7ff" passes through "#8f",
  // which is not a colour, and rewriting the field from the store on every
  // keystroke would fight the person's cursor.
  const [hexDraft, setHexDraft] = useState(accentHex);

  // Follows the accent only when the field is not the one that changed it.
  // Without the comparison a half-typed short form («#8fc») came back expanded
  // («#88ffcc») and the remaining keystrokes landed after someone else's text.
  useEffect(() => {
    setHexDraft((draft) => (normalizeHex(draft) === accentHex ? draft : accentHex));
  }, [accentHex]);

  const draftIsColor = normalizeHex(hexDraft) !== null;
  const labelContrast = contrastRatio(accentHex, pickTextOnAccent(accentHex));

  // Two presets demand a depth: «Неон» only works on near-black, «Бумага» is not
  // paper anywhere but white. `applyDesign` resolves that before painting, so the
  // stored choice is not what is on screen — and the swatches must follow the
  // window, not the store. Without this the chips took the press, the hint
  // changed, and nothing else did: two clicks to a control that lies.
  const lockedPreset = findPreset(presetId);
  const lockedDepth = lockedPreset.forceDepth;
  const shownDepth = lockedDepth ?? depth;
  const activeDepth = THEME_DEPTHS.find((option) => option.id === shownDepth);

  // Base surface of a depth, computed by the same engine that paints the window,
  // so the swatch cannot drift from what the choice actually does. The preset and
  // the knobs are part of it: sharp corners and a flat preset shift the whole
  // surface ramp, and a hardcoded palette would show yesterday's colours.
  const depthBase = (id: ThemeDepth): string =>
    designVars({ presetId, depth: id, accentHex, overrides })['--bg-base'] ?? '';

  // One control instead of a toggle plus a locked dropdown: «Нет» is just another
  // choice, and this is the value the fullscreen player opens with.
  const handleChange = (value: string): void => {
    if (value === OFF) {
      setVisualizerEnabled(false);
      return;
    }
    setVisualizerPreset(value as VisualizerPreset);
    if (!visualizerEnabled) setVisualizerEnabled(true);
  };

  return (
    <SettingsSection
      id="appearance"
      title="Внешний вид"
      description="Цвет акцента, глубина подложки и визуализация. Всё применяется сразу и остаётся после перезапуска."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <h3 style={HEADING_STYLE}>Акцент</h3>
        <p style={HINT_STYLE}>
          Один цвет на всё приложение: кнопки, ползунки, обводка фокуса. Оттенки наведения и
          нажатия выводятся из него сами.
        </p>
      </div>

      <div
        role="group"
        aria-label="Готовые акценты"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
          gap: 'var(--space-2)'
        }}
      >
        {ACCENT_PRESETS.map((preset, index) => {
          // A preset is current only while there is no custom colour: the custom
          // one wins in `resolveAccentHex`, so keeping a swatch pressed under it
          // would point at a colour that is not on screen.
          const isActive = customAccentHex === null && accentId === preset.id;

          return (
            <button
              key={preset.id}
              type="button"
              /*
               * `animate-settle` and not `animate-rise`: the grid fits six
               * swatches per row, so the index climbs faster than the eye — the
               * rising version read as a wave crossing the row diagonally.
               */
              className="card-interactive focus-ring animate-settle"
              aria-pressed={isActive}
              data-selected={isActive ? 'true' : undefined}
              onClick={() => setAccent(preset.id)}
              data-testid={`settings-accent-${preset.id}`}
              style={
                {
                  '--stagger': index,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-2) var(--space-3)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 'var(--weight-medium)',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                  textAlign: 'left'
                } as React.CSSProperties
              }
            >
              {/*
                The only place a hard-coded colour is allowed: this is the swatch,
                its whole job is to show that exact hex. It carries no class with a
                hover rule, so the inline fill cannot silence one.
              */}
              <span
                aria-hidden="true"
                style={{
                  width: 'var(--space-4)',
                  height: 'var(--space-4)',
                  flexShrink: 0,
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: preset.hex,
                  border: '1px solid var(--border-strong)'
                }}
              />
              <span className="text-truncate">{preset.label}</span>
            </button>
          );
        })}
      </div>

      <SettingRow
        label="Свой цвет"
        controlId="setting-accent-hex"
        description="Пипетка или запись вида #8fc7ff. Свой цвет старше пресета — чтобы вернуться к готовому, нажмите на образец."
      >
        <input
          type="color"
          aria-label="Выбрать свой цвет акцента"
          value={accentHex}
          onChange={(e) => setCustomAccent(e.target.value)}
          data-testid="settings-accent-color"
          style={{
            width: 'var(--control-xl)',
            height: 'var(--control-md)'
          }}
        />
        <input
          id="setting-accent-hex"
          type="text"
          value={hexDraft}
          spellCheck={false}
          aria-invalid={!draftIsColor}
          aria-describedby="setting-accent-hex-description"
          onChange={(e) => {
            setHexDraft(e.target.value);
            setCustomAccent(e.target.value);
          }}
          data-testid="settings-accent-hex"
          style={{
            width: 'calc(var(--space-8) + var(--space-5))',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)'
          }}
        />
      </SettingRow>

      {!draftIsColor && (
        <p style={{ ...HINT_STYLE, color: 'var(--danger)' }} data-testid="settings-accent-hex-error">
          Это не цвет. Нужны три или шесть шестнадцатеричных цифр, например #8fc7ff.
        </p>
      )}

      {labelContrast < MIN_LABEL_CONTRAST && (
        <p
          role="status"
          style={{ ...HINT_STYLE, color: 'var(--warning)' }}
          data-testid="settings-accent-contrast-warning"
        >
          На этом цвете подпись читается плохо: контраст {labelContrast.toFixed(1)}:1 вместо 4.5:1.
          Цвет применён — но текст на акцентных кнопках будет бледным.
        </p>
      )}

      <div className="divider" role="presentation" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <h3 style={HEADING_STYLE}>Глубина</h3>
        <p style={HINT_STYLE}>
          Насколько тёмная подложка. Меняются только цвета поверхностей — расположение и
          акцент остаются теми же.
        </p>
      </div>

      <div
        role="group"
        aria-label="Глубина темы"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}
      >
        {THEME_DEPTHS.map((option) => (
          <button
            key={option.id}
            type="button"
            className="chip"
            aria-pressed={shownDepth === option.id}
            disabled={lockedDepth !== null}
            title={lockedDepth === null ? option.description : `Глубину держит пресет «${lockedPreset.label}»`}
            onClick={() => setDepth(option.id)}
            data-testid={`settings-theme-depth-${option.id}`}
            style={{ fontSize: 'var(--text-xs)' }}
          >
            {/*
              The dot is the actual base surface of that depth under the current
              preset, taken from the engine: «Ночь» and «Сумерки» differ by a few
              points of lightness, and no wording separates them the way two
              swatches side by side do. Decorative for a screen reader — the
              label and the title attribute already say it.
            */}
            <span
              aria-hidden="true"
              data-testid={`settings-theme-depth-swatch-${option.id}`}
              style={{
                width: '10px',
                height: '10px',
                flexShrink: 0,
                borderRadius: 'var(--radius-full)',
                background: depthBase(option.id),
                boxShadow: 'inset 0 0 0 1px var(--border-strong)'
              }}
            />
            {option.label}
          </button>
        ))}
      </div>

      {activeDepth && (
        <p style={HINT_STYLE} data-testid="settings-theme-depth-state">
          {activeDepth.description}.
        </p>
      )}

      {lockedDepth !== null && (
        <p style={HINT_STYLE} data-testid="settings-theme-depth-locked">
          Пресет «{lockedPreset.label}» задуман для этой глубины и держит её. Чтобы выбирать
          глубину, смените пресет в разделе «Оформление».
        </p>
      )}

      <div className="divider" role="presentation" />

      <SettingRow
        label="Визуализация"
        controlId="setting-visualizer-preset"
        description="Рисует спектр под обложкой в полноэкранном режиме. «Нет» освобождает анализатор и немного экономит процессор."
      >
        <select
          id="setting-visualizer-preset"
          value={visualizerEnabled ? visualizerPreset : OFF}
          onChange={(e) => handleChange(e.target.value)}
          data-testid="settings-visualizer-preset"
        >
          {PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {PRESET_LABELS[preset]}
            </option>
          ))}
          <option value={OFF}>Нет</option>
        </select>
      </SettingRow>
    </SettingsSection>
  );
};
