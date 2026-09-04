import React from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '../common/Button';
import { SettingsSection, SettingRow, ToggleSetting } from './SettingsPrimitives';
import { CustomDesignsSection } from './CustomDesignsSection';
import { useThemeStore, resolveAccentHex } from '../../store/useThemeStore';
import {
  DESIGN_PRESETS,
  DENSITY_OPTIONS,
  MOTION_OPTIONS,
  PARTICLE_OPTIONS,
  RADIUS_OPTIONS,
  designVars,
  findPreset,
  DensityOverride,
  MotionOverride,
  ParticleProfileId,
  RadiusOverride
} from '../../styles/presets';
import {
  FONT_OPTIONS,
  FONT_WEIGHT_MODES,
  LETTER_SPACINGS,
  TYPE_SCALES,
  fontStack,
  FontId,
  FontWeightModeId,
  LetterSpacingId,
  TypeScaleId
} from '../../styles/typography';
import { ICON } from '../../styles/icons';

/**
 * Раздел «Оформление»: пресет приложения, шрифт и ручки поверх пресета.
 *
 * Отдельно от «Внешнего вида» намеренно. Там — цвет и глубина, то есть два
 * решения; здесь — характер приложения целиком: форма углов, плотность, скорость
 * движения, частицы, гарнитура. В одном разделе это тридцать органов управления
 * подряд, и найти среди них цвет акцента становится нельзя.
 *
 * Ручки живут «поверх» пресета и хранят `null`, пока их не тронули. Поэтому в
 * каждом списке есть пункт «Как в пресете» — он и означает `null`, а не одно из
 * значений: без него вернуться к пресету можно было бы только сбросом всех ручек
 * сразу.
 */

/** Значение пункта «как в пресете». Не может совпасть ни с одним ключом ручки. */
const INHERIT = '';

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

const CARD_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 'var(--space-1)',
  padding: 'var(--space-3)',
  textAlign: 'left'
};

const CARD_TITLE_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-sm)',
  fontWeight: 'var(--weight-semibold)',
  color: 'var(--text-primary)'
};

const CARD_HINT_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-xs)',
  color: 'var(--text-muted)'
};

/* --- Миниатюра пресета ----------------------------------------------------
 * Размеры внутри заданы числами, а не отступами темы, и это осознанно: это
 * диаграмма постоянного масштаба. Плотность пресета обязана менять в ней вид
 * панели, а не размер самой картинки, иначе карточки в сетке разъедутся по
 * высоте и сравнивать их станет нельзя.
 */

const PREVIEW_FRAME_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  alignSelf: 'stretch',
  gap: '4px',
  height: '38px',
  padding: '4px',
  overflow: 'hidden',
  background: 'var(--bg-base)',
  borderRadius: 'var(--radius-sm)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)'
};

/** Боковая панель: самая узкая деталь, на ней видно скругление мелкой ступени. */
const PREVIEW_RAIL_STYLE: React.CSSProperties = {
  width: '7px',
  background: 'var(--surface-2)',
  borderRadius: 'var(--radius-xs)'
};

const PREVIEW_PANEL_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
  flex: 1,
  minWidth: 0,
  padding: '0 6px',
  background: 'var(--surface-2)',
  borderRadius: 'var(--radius-xs)',
  boxShadow: 'var(--shadow-sm)'
};

/** Кружок акцента: у «Неона» вокруг него видно свечение из его же тени. */
const PREVIEW_DOT_STYLE: React.CSSProperties = {
  flexShrink: 0,
  width: '9px',
  height: '9px',
  background: 'var(--accent)',
  borderRadius: 'var(--radius-full)'
};

const PREVIEW_BAR_STYLE: React.CSSProperties = {
  height: '3px',
  background: 'var(--text-secondary)',
  borderRadius: 'var(--radius-pill)'
};

/**
 * Миниатюра пресета — то же окно, собранное в его переменных.
 *
 * Зачем не одна подпись: «мягче углы» и «плотнее» словами не различить, а
 * применять пресет ради взгляда — значит перекрашивать всё приложение на каждый
 * клик. Переменные ставятся на сам блок, поэтому внутри работают те же
 * `var(--surface-*)` и `var(--radius-*)`, что и в приложении: картинка не
 * срисована, а посчитана, и разойтись с настоящим окном не может.
 *
 * Для чтения с экрана это украшение: карточка и без неё называет пресет и
 * описывает его словами.
 */
const PresetPreview: React.FC<{ vars: Record<string, string>; testId: string }> = ({ vars, testId }) => (
  <span
    aria-hidden="true"
    data-testid={testId}
    style={{ ...PREVIEW_FRAME_STYLE, ...vars } as React.CSSProperties}
  >
    <span style={PREVIEW_RAIL_STYLE} />
    <span style={PREVIEW_PANEL_STYLE}>
      <span style={PREVIEW_DOT_STYLE} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, minWidth: 0 }}>
        <span style={{ ...PREVIEW_BAR_STYLE, width: '62%' }} />
        <span style={{ ...PREVIEW_BAR_STYLE, width: '34%', background: 'var(--text-faint)' }} />
      </span>
    </span>
  </span>
);

export const DesignSettings: React.FC = () => {
  const presetId = useThemeStore((s) => s.presetId);
  // Глубина и акцент нужны не разделу, а миниатюрам: без них каждая карточка
  // рисовала бы пресет в чужой светлоте и чужим акцентом.
  const depth = useThemeStore((s) => s.depth);
  const accentHex = useThemeStore(resolveAccentHex);
  const fontId = useThemeStore((s) => s.fontId);
  const typeScaleId = useThemeStore((s) => s.typeScaleId);
  const fontWeightId = useThemeStore((s) => s.fontWeightId);
  const letterSpacingId = useThemeStore((s) => s.letterSpacingId);
  const overrides = useThemeStore((s) => s.overrides);

  const setPreset = useThemeStore((s) => s.setPreset);
  const setFont = useThemeStore((s) => s.setFont);
  const setTypeScale = useThemeStore((s) => s.setTypeScale);
  const setFontWeight = useThemeStore((s) => s.setFontWeight);
  const setLetterSpacing = useThemeStore((s) => s.setLetterSpacing);
  const setOverride = useThemeStore((s) => s.setOverride);
  const resetOverrides = useThemeStore((s) => s.resetOverrides);

  const preset = findPreset(presetId);
  const touched = Object.values(overrides).some((value) => value !== null);
  // Пресет хранит стекло и зерно числами (сила размытия, непрозрачность шума), а
  // ручка — да/нет. Ноль в пресете и означает «выключено», ровно так же это
  // читает `designVars`.
  const presetGlass = preset.glassBlur > 0;
  const presetGrain = preset.grain > 0;

  return (
    <SettingsSection
      id="design"
      title="Оформление"
      description="Пресет задаёт характер: форму углов, плотность, скорость движения и частицы. Ручки ниже переопределяют пресет по одной — остальное продолжает следовать за ним."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <h3 style={HEADING_STYLE}>Пресет</h3>
        <p style={HINT_STYLE}>
          Меняется всё сразу: скругления, отступы, длительности, стекло, зерно, частицы. Своя
          гарнитура пресета подставляется только если шрифт не выбирали руками.
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label="Пресет оформления"
        style={{
          display: 'grid',
          // Шире, чем просят сами карточки: на узкой сетке описание пресета
          // ломается на четыре строки, и пять высоких плиток читаются тяжелее,
          // чем три спокойных.
          gridTemplateColumns: 'repeat(auto-fit, minmax(232px, 1fr))',
          gap: 'var(--space-2)'
        }}
        data-testid="settings-design-presets"
      >
        {DESIGN_PRESETS.map((option, index) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={presetId === option.id}
            data-active={presetId === option.id ? 'true' : 'false'}
            /*
             * `animate-settle` вместо подъёма: пять карточек стоят сеткой в
             * два-три столбца, и волна, идущая наискось, замечается раньше самих
             * пресетов. Блик под курсором — потому что карточка применяет вид
             * целиком, и весом она ближе к кнопке, чем к строке списка.
             */
            className="card-interactive focus-ring animate-settle hover-sheen"
            onClick={() => setPreset(option.id)}
            data-testid={`settings-design-preset-${option.id}`}
            style={{ ...CARD_STYLE, '--stagger': index } as React.CSSProperties}
          >
            {/*
              Ручки идут в расчёт миниатюры нарочно: они старше пресета и
              переживут его смену, так что показать карточку без них — обещать
              вид, которого после нажатия не будет.
            */}
            <PresetPreview
              vars={designVars({ presetId: option.id, depth, accentHex, overrides })}
              testId={`settings-design-preview-${option.id}`}
            />
            <span style={CARD_TITLE_STYLE}>{option.label}</span>
            <span style={CARD_HINT_STYLE}>{option.description}</span>
          </button>
        ))}
      </div>

      <CustomDesignsSection />

      <div className="divider" role="presentation" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <h3 style={HEADING_STYLE}>Шрифт</h3>
        <p style={HINT_STYLE}>
          Название каждой гарнитуры набрано ей же — по описанию шрифт не выбирают. Файлы лежат
          в приложении, так что ничего не загружается из сети.
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label="Гарнитура"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 'var(--space-2)'
        }}
        data-testid="settings-design-fonts"
      >
        {FONT_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={fontId === option.id}
            data-active={fontId === option.id ? 'true' : 'false'}
            className="card-interactive focus-ring hover-sheen"
            onClick={() => setFont(option.id as FontId)}
            data-testid={`settings-design-font-${option.id}`}
            style={CARD_STYLE}
          >
            {/*
              Единственное место, где семейство задаётся инлайном: образец обязан
              быть набран той гарнитурой, о которой он говорит. Через переменную
              темы это невозможно — она одна и указывает на выбранный шрифт.

              Кегль подменяется вместе со своей тройкой: межстрочное и трекинг в
              шкале привязаны к размеру, и `--text-lg` с интерлиньяжем от
              `--text-sm` даёт образцу лишнюю строку воздуха сверху.
            */}
            <span
              style={{
                ...CARD_TITLE_STYLE,
                fontFamily: fontStack(option.id),
                fontSize: 'var(--text-lg)',
                lineHeight: 'var(--leading-lg)',
                letterSpacing: 'var(--tracking-lg)'
              }}
            >
              {option.label}
            </span>
            <span style={CARD_HINT_STYLE}>{option.description}</span>
          </button>
        ))}
      </div>

      <SettingRow
        label="Кегль"
        controlId="setting-design-type-scale"
        description="Размер всего текста сразу. Межстрочное расстояние пересчитывается само."
      >
        <select
          id="setting-design-type-scale"
          value={typeScaleId}
          aria-describedby="setting-design-type-scale-description"
          onChange={(e) => setTypeScale(e.target.value as TypeScaleId)}
          data-testid="settings-design-type-scale"
        >
          {TYPE_SCALES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="Насыщенность"
        controlId="setting-design-font-weight"
        description="Сдвигает все начертания сразу. На системном шрифте разница меньше: он не переменный."
      >
        <select
          id="setting-design-font-weight"
          value={fontWeightId}
          aria-describedby="setting-design-font-weight-description"
          onChange={(e) => setFontWeight(e.target.value as FontWeightModeId)}
          data-testid="settings-design-font-weight"
        >
          {FONT_WEIGHT_MODES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="Межбуквенное"
        controlId="setting-design-letter-spacing"
        description="Разрядка букв. «Просторно» помогает мелким подписям и вредит крупным заголовкам."
      >
        <select
          id="setting-design-letter-spacing"
          value={letterSpacingId}
          aria-describedby="setting-design-letter-spacing-description"
          onChange={(e) => setLetterSpacing(e.target.value as LetterSpacingId)}
          data-testid="settings-design-letter-spacing"
        >
          {LETTER_SPACINGS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <div className="divider" role="presentation" />

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <h3 style={HEADING_STYLE}>Ручки</h3>
          <p style={HINT_STYLE}>
            Каждая ручка старше пресета и переживает его смену. «Как в пресете» возвращает её
            обратно под пресет — сейчас это «{preset.label}».
          </p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          icon={<RotateCcw size={ICON.sm} />}
          onClick={resetOverrides}
          disabled={!touched}
          data-testid="settings-design-reset-overrides"
        >
          Под пресет
        </Button>
      </div>

      <SettingRow
        label="Углы"
        controlId="setting-design-radius"
        description="Лестница скруглений целиком: от мелких элементов до окон."
      >
        <select
          id="setting-design-radius"
          value={overrides.radius ?? INHERIT}
          aria-describedby="setting-design-radius-description"
          onChange={(e) =>
            setOverride('radius', e.target.value === INHERIT ? null : (e.target.value as RadiusOverride))
          }
          data-testid="settings-design-radius"
        >
          <option value={INHERIT}>Как в пресете</option>
          {RADIUS_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="Плотность"
        controlId="setting-design-density"
        description="Все отступы приложения одним множителем. Размер текста не меняется."
      >
        <select
          id="setting-design-density"
          value={overrides.density ?? INHERIT}
          aria-describedby="setting-design-density-description"
          onChange={(e) =>
            setOverride('density', e.target.value === INHERIT ? null : (e.target.value as DensityOverride))
          }
          data-testid="settings-design-density"
        >
          <option value={INHERIT}>Как в пресете</option>
          {DENSITY_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="Движение"
        controlId="setting-design-motion"
        description="Длительности всех переходов. «Мгновенно» не отключает анимации совсем — для этого есть системная настройка сокращённого движения."
      >
        <select
          id="setting-design-motion"
          value={overrides.motion ?? INHERIT}
          aria-describedby="setting-design-motion-description"
          onChange={(e) =>
            setOverride('motion', e.target.value === INHERIT ? null : (e.target.value as MotionOverride))
          }
          data-testid="settings-design-motion"
        >
          <option value={INHERIT}>Как в пресете</option>
          {MOTION_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="Частицы"
        controlId="setting-design-particles"
        description="Слой над подложкой на главном экране. На слабой машине это первое, что стоит выключить."
      >
        <select
          id="setting-design-particles"
          value={overrides.particles ?? INHERIT}
          aria-describedby="setting-design-particles-description"
          onChange={(e) =>
            setOverride('particles', e.target.value === INHERIT ? null : (e.target.value as ParticleProfileId))
          }
          data-testid="settings-design-particles"
        >
          <option value={INHERIT}>Как в пресете</option>
          {PARTICLE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id} title={option.description}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      {/*
        Стекло и зерно — да/нет, но с третьим состоянием «как в пресете». Флажок
        третьего состояния не показывает, поэтому «выключить» здесь означает
        именно `false` и переживает смену пресета, а вернуть под пресет можно
        кнопкой «Под пресет».
      */}
      <ToggleSetting
        id="setting-design-glass"
        label="Размытие стекла"
        description={
          overrides.glass === null
            ? `Как в пресете: ${presetGlass ? 'включено' : 'выключено'}. Размытие — самая дорогая часть оформления.`
            : 'Задано вручную и переживёт смену пресета.'
        }
        checked={overrides.glass ?? presetGlass}
        onChange={(checked) => setOverride('glass', checked)}
      />

      <ToggleSetting
        id="setting-design-grain"
        label="Зерно"
        description={
          overrides.grain === null
            ? `Как в пресете: ${presetGrain ? 'включено' : 'выключено'}. Едва заметный шум поверх подложки — он убирает полосы на градиентах.`
            : 'Задано вручную и переживёт смену пресета.'
        }
        checked={overrides.grain ?? presetGrain}
        onChange={(checked) => setOverride('grain', checked)}
      />
    </SettingsSection>
  );
};
