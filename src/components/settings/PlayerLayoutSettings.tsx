import React from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '../common/Button';
import { SettingsSection, SettingRow, ToggleSetting } from './SettingsPrimitives';
import {
  usePlayerLayoutStore,
  ARTWORK_CLICK_ACTIONS,
  ARTWORK_SHAPES,
  FULLSCREEN_MODULE_KEYS,
  PLAYER_BAR_MODULE_KEYS,
  PLAYER_DENSITIES,
  PROGRESS_STYLES,
  ArtworkClickAction,
  ArtworkShape,
  FullscreenModuleKey,
  PlayerBarModuleKey,
  PlayerDensity,
  ProgressStyle
} from '../../store/usePlayerLayoutStore';
import { PLAYER_SKIN_LIST } from '../../styles/playerSkins';
import { MINI_SKIN_LIST } from '../../styles/miniSkins';
import { ICON } from '../../styles/icons';

/**
 * Раздел «Плеер»: что показывать в полосе, насколько она плотная и что делает
 * нажатие на обложку.
 *
 * Переключатели именно перечисляют существующие элементы полосы — здесь нет ни
 * одного пункта без соответствующей кнопки на экране, иначе настройка выглядела
 * бы сломанной.
 */

const MODULE_LABELS: Record<PlayerBarModuleKey, { label: string; description: string }> = {
  favorite: { label: 'Избранное', description: 'Сердце рядом с названием трека.' },
  shuffle: { label: 'Перемешивание', description: 'Кнопка слева от транспорта.' },
  repeat: { label: 'Повтор', description: 'Кнопка справа от транспорта.' },
  queue: { label: 'Очередь', description: 'Кнопка со счётчиком того, что играет дальше.' },
  lyrics: { label: 'Текст песни', description: 'Кнопка караоке и сама панель с текстом.' },
  tempo: { label: 'Темп', description: 'Скорость воспроизведения без изменения тона.' },
  sleepTimer: { label: 'Таймер сна', description: 'Обратный отсчёт в полосе и выбор времени в меню «Ещё».' },
  volume: { label: 'Громкость', description: 'Ползунок и кнопка отключения звука.' },
  visualizer: { label: 'Мини-визуализация', description: 'Спектр 46×28 рядом с регулятором громкости.' }
};

const FULLSCREEN_LABELS: Record<FullscreenModuleKey, { label: string; description: string }> = {
  artwork: { label: 'Обложка', description: 'Большая картинка в центре экрана.' },
  visualizer: { label: 'Визуализация', description: 'Полоса спектра под обложкой.' },
  lyrics: { label: 'Текст песни', description: 'Кнопка караоке в верхнем ряду.' },
  queue: { label: 'Очередь', description: 'Кнопка и боковой список «далее».' }
};

const DENSITY_LABELS: Record<PlayerDensity, string> = {
  compact: 'Плотно',
  comfortable: 'Обычно',
  spacious: 'Свободно'
};

const SHAPE_LABELS: Record<ArtworkShape, string> = {
  square: 'Квадрат',
  rounded: 'Скруглённый',
  circle: 'Круг'
};

const CLICK_LABELS: Record<ArtworkClickAction, string> = {
  fullscreen: 'Открыть на весь экран',
  visualizer: 'Включить визуализацию',
  none: 'Ничего не делать'
};

const PROGRESS_LABELS: Record<ProgressStyle, string> = {
  thin: 'Тонкая',
  thick: 'Толстая'
};

/** Тот же вид, что у заголовков блоков в «Воспроизведении» и «Внешнем виде». */
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

/** Минимум, который сетке нужно знать об облике: остальное — дело самих обликов. */
interface SkinChoice {
  readonly id: string;
  readonly name: string;
  readonly hint: string;
}

interface SkinGridProps<T extends string> {
  ariaLabel: string;
  options: readonly SkinChoice[];
  activeId: T;
  onPick: (id: T) => void;
  /** `settings-player` → `settings-player-skins` и `settings-player-skin-<id>`. */
  testIdPrefix: string;
}

/*
 * Сетка, а не выпадающий список: облики отличаются сильно, и выбирать их по
 * названию — то же, что выбирать обои по имени файла. Ширина колонки задана в
 * `minmax`, поэтому на узком окне сетка складывается сама.
 *
 * Одна сетка на два набора (полоса плеера и мини-окно) — не ради экономии строк:
 * два независимых списка со временем начали бы вести себя по-разному, а человек
 * видит их рядом и вправе ждать одинакового поведения.
 */
function SkinGrid<T extends string>({
  ariaLabel,
  options,
  activeId,
  onPick,
  testIdPrefix
}: SkinGridProps<T>): React.ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 'var(--space-2)'
      }}
      data-testid={`${testIdPrefix}-skins`}
    >
      {options.map((skin, index) => (
        <button
          key={skin.id}
          type="button"
          role="radio"
          aria-checked={activeId === skin.id}
          data-active={activeId === skin.id ? 'true' : 'false'}
          /*
           * Блик под курсором — единственный способ показать, что плитка живая:
           * облик выбирают по подписи, а картинки у карточки нет, и до нажатия
           * она ничем не отличается от заголовка рядом.
           */
          className="card-interactive focus-ring animate-settle hover-sheen"
          onClick={() => onPick(skin.id as T)}
          style={{
            '--stagger': index,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 'var(--space-1)',
            padding: 'var(--space-3)',
            textAlign: 'left'
          } as React.CSSProperties}
          data-testid={`${testIdPrefix}-skin-${skin.id}`}
        >
          <span
            style={{
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)'
            }}
          >
            {skin.name}
          </span>
          <span
            style={{
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-xs)',
              color: 'var(--text-muted)'
            }}
          >
            {skin.hint}
          </span>
        </button>
      ))}
    </div>
  );
}

export const PlayerLayoutSettings: React.FC = () => {
  const density = usePlayerLayoutStore((s) => s.density);
  const artworkShape = usePlayerLayoutStore((s) => s.artworkShape);
  const artworkClickAction = usePlayerLayoutStore((s) => s.artworkClickAction);
  const progressStyle = usePlayerLayoutStore((s) => s.progressStyle);
  const skinId = usePlayerLayoutStore((s) => s.skinId);
  const miniSkinId = usePlayerLayoutStore((s) => s.miniSkinId);
  const modules = usePlayerLayoutStore((s) => s.modules);
  const fullscreenModules = usePlayerLayoutStore((s) => s.fullscreenModules);

  const setDensity = usePlayerLayoutStore((s) => s.setDensity);
  const setArtworkShape = usePlayerLayoutStore((s) => s.setArtworkShape);
  const setArtworkClickAction = usePlayerLayoutStore((s) => s.setArtworkClickAction);
  const setProgressStyle = usePlayerLayoutStore((s) => s.setProgressStyle);
  const setPlayerSkin = usePlayerLayoutStore((s) => s.setPlayerSkin);
  const setMiniSkin = usePlayerLayoutStore((s) => s.setMiniSkin);
  const toggleModule = usePlayerLayoutStore((s) => s.toggleModule);
  const toggleFullscreenModule = usePlayerLayoutStore((s) => s.toggleFullscreenModule);
  const resetLayout = usePlayerLayoutStore((s) => s.resetLayout);

  return (
    <SettingsSection
      id="player"
      title="Плеер"
      description="Состав полосы плеера и её плотность. Скрытый элемент не рисуется вовсе — не прячется, а перестаёт существовать."
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <h3 style={HEADING_STYLE}>Облик</h3>
          <p style={HINT_STYLE}>
            Чем плеер является: полосой во всю ширину, парящей таблеткой, стеклом, тонкой линией.
            Плотность и состав кнопок при этом остаются вашими — облик меняет саму вещь, а не её
            содержимое.
          </p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          icon={<RotateCcw size={ICON.sm} />}
          onClick={resetLayout}
          data-testid="settings-player-reset"
        >
          Сбросить
        </Button>
      </div>

      <SkinGrid
        ariaLabel="Облик плеера"
        options={PLAYER_SKIN_LIST}
        activeId={skinId}
        onPick={setPlayerSkin}
        testIdPrefix="settings-player"
      />

      <div className="divider" role="presentation" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <h3 style={HEADING_STYLE}>Облик мини-плеера</h3>
        <p style={HINT_STYLE}>
          Отдельное окно поверх остальных: у него своя жизнь и свой вид. «Винил» вращает обложку,
          пока играет музыка, «Афиша» отдаёт ей всё окно, «Индикатор» приглушает кнопки, пока к
          плееру не потянутся.
        </p>
      </div>

      <SkinGrid
        ariaLabel="Облик мини-плеера"
        options={MINI_SKIN_LIST}
        activeId={miniSkinId}
        onPick={setMiniSkin}
        testIdPrefix="settings-mini"
      />

      <div className="divider" role="presentation" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <h3 style={HEADING_STYLE}>Элементы полосы</h3>
        <p style={HINT_STYLE}>
          Транспорт (назад, пауза, вперёд) и таймлайн убрать нельзя — без них полоса перестаёт
          быть плеером.
        </p>
      </div>

      {PLAYER_BAR_MODULE_KEYS.map((key) => (
        <ToggleSetting
          key={key}
          id={`setting-player-module-${key}`}
          label={MODULE_LABELS[key].label}
          description={MODULE_LABELS[key].description}
          checked={modules[key]}
          onChange={() => toggleModule(key)}
        />
      ))}

      <div className="divider" role="presentation" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <h3 style={HEADING_STYLE}>Полноэкранный режим</h3>
        <p style={HINT_STYLE}>Что остаётся на большом экране. Название, транспорт и таймлайн остаются всегда.</p>
      </div>

      {FULLSCREEN_MODULE_KEYS.map((key) => (
        <ToggleSetting
          key={key}
          id={`setting-player-fullscreen-${key}`}
          label={FULLSCREEN_LABELS[key].label}
          description={FULLSCREEN_LABELS[key].description}
          checked={fullscreenModules[key]}
          onChange={() => toggleFullscreenModule(key)}
        />
      ))}

      <div className="divider" role="presentation" />

      <SettingRow
        label="Плотность"
        controlId="setting-player-density"
        description="Отступы полосы и размер обложки в ней. Высота самой полосы не меняется."
      >
        <select
          id="setting-player-density"
          value={density}
          aria-describedby="setting-player-density-description"
          onChange={(e) => setDensity(e.target.value as PlayerDensity)}
          data-testid="settings-player-density"
        >
          {PLAYER_DENSITIES.map((option) => (
            <option key={option} value={option}>
              {DENSITY_LABELS[option]}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="Форма обложки"
        controlId="setting-player-artwork-shape"
        description="Скругление обложки в полосе и в полноэкранном режиме."
      >
        <select
          id="setting-player-artwork-shape"
          value={artworkShape}
          aria-describedby="setting-player-artwork-shape-description"
          onChange={(e) => setArtworkShape(e.target.value as ArtworkShape)}
          data-testid="settings-player-artwork-shape"
        >
          {ARTWORK_SHAPES.map((option) => (
            <option key={option} value={option}>
              {SHAPE_LABELS[option]}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="Нажатие на обложку"
        controlId="setting-player-artwork-click"
        description="«Ничего не делать» превращает обложку в картинку: нажатие перестаёт что-либо открывать."
      >
        <select
          id="setting-player-artwork-click"
          value={artworkClickAction}
          aria-describedby="setting-player-artwork-click-description"
          onChange={(e) => setArtworkClickAction(e.target.value as ArtworkClickAction)}
          data-testid="settings-player-artwork-click"
        >
          {ARTWORK_CLICK_ACTIONS.map((option) => (
            <option key={option} value={option}>
              {CLICK_LABELS[option]}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="Полоса прокрутки"
        controlId="setting-player-progress-style"
        description="Толщина дорожки и размер ползунка — у таймлайна и у громкости сразу."
      >
        <select
          id="setting-player-progress-style"
          value={progressStyle}
          aria-describedby="setting-player-progress-style-description"
          onChange={(e) => setProgressStyle(e.target.value as ProgressStyle)}
          data-testid="settings-player-progress-style"
        >
          {PROGRESS_STYLES.map((option) => (
            <option key={option} value={option}>
              {PROGRESS_LABELS[option]}
            </option>
          ))}
        </select>
      </SettingRow>
    </SettingsSection>
  );
};
