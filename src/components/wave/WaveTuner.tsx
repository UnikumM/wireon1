import React, { useEffect, useRef } from 'react';
import { Compass, Gauge, Music } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { ICON } from '../../styles/icons';

/**
 * Пауза перед перезапуском Потока после того, как ползунок замер. Пока палец
 * ведёт ручку, значение меняется десятки раз, и пересобирать Поток на каждый
 * шаг — значит греть сеть впустую.
 */
export const WAVE_RESTART_DEBOUNCE_MS = 450;

export interface WaveGenreOption {
  /** Что видит человек. */
  label: string;
  /** Что уходит в поисковый запрос — здесь язык диктуют каталоги, не интерфейс. */
  value: string;
  slug: string;
}

export const WAVE_GENRES: WaveGenreOption[] = [
  { label: 'Хип-хоп', value: 'Hip-Hop', slug: 'hiphop' },
  { label: 'Рок', value: 'Rock', slug: 'rock' },
  { label: 'Электроника', value: 'Electronic', slug: 'electronic' },
  { label: 'Поп', value: 'Pop', slug: 'pop' },
  { label: 'Инди', value: 'Indie', slug: 'indie' },
  { label: 'Джаз', value: 'Jazz', slug: 'jazz' },
  { label: 'Метал', value: 'Metal', slug: 'metal' },
  { label: 'Классика', value: 'Classical', slug: 'classical' },
  { label: 'Эмбиент', value: 'Ambient', slug: 'ambient' },
  { label: 'Лоу-фай', value: 'Lo-fi', slug: 'lofi' },
  { label: 'Русский рэп', value: 'русский рэп', slug: 'ruprap' },
  { label: 'Русский рок', value: 'русский рок', slug: 'rurock' }
];

/** Словами о том, сколько в Потоке будет знакомого. */
export function describeNovelty(novelty: number): string {
  if (novelty < 0.2) return 'только знакомое';
  if (novelty < 0.4) return 'в основном знакомое';
  if (novelty <= 0.6) return 'поровну знакомого и нового';
  if (novelty <= 0.8) return 'больше нового';
  return 'почти только новое';
}

/** Словами о темпе. */
export function describeEnergy(energy: number): string {
  if (energy < 0.2) return 'совсем спокойное';
  if (energy < 0.4) return 'спокойное';
  if (energy <= 0.6) return 'без крайностей по темпу';
  if (energy <= 0.8) return 'бодрое';
  return 'очень бодрое';
}

/**
 * Одна фраза про обе оси. Раньше на месте регуляторов стояли пять «настроений»,
 * и по названию было невозможно понять, чем «Вдохновение» отличается от
 * «Спокойного»; теперь состояние Потока написано прямым текстом.
 */
export function describeWaveAxes(novelty: number, energy: number): string {
  return `${describeNovelty(novelty)}, ${describeEnergy(energy)}`;
}

export interface WaveTunerProps {
  className?: string;
  /** Перезапускать ли Поток, когда ползунок замер. Выключено — только настройка. */
  restartOnChange?: boolean;
}

interface AxisSliderProps {
  id: string;
  icon: React.ReactNode;
  label: string;
  minLabel: string;
  maxLabel: string;
  value: number;
  valueText: string;
  onChange: (value: number) => void;
}

const AxisSlider: React.FC<AxisSliderProps> = ({
  id,
  icon,
  label,
  minLabel,
  maxLabel,
  value,
  valueText,
  onChange
}) => (
  <div className="stack gap-2">
    <div className="row wrap gap-2">
      <span className="inline-row text-secondary">{icon}</span>
      <span
        className="text-sm weight-semibold text-primary"
      >
        {label}
      </span>
      <span
        className="ml-auto text-xs text-secondary"
        data-testid={`wave-slider-value-${id}`}
      >
        {valueText}
      </span>
    </div>

    <input
      type="range"
      min={0}
      max={100}
      step={5}
      value={Math.round(value * 100)}
      onChange={(e) => onChange(Number(e.target.value) / 100)}
      aria-label={label}
      aria-valuetext={valueText}
      style={
        {
          width: '100%',
          cursor: 'pointer',
          // Доля заливки — единственное, что тут можно сказать про облик; сам
          // облик дорожки и бегунка живёт одним правилом в global.css. Раньше
          // здесь стоял `accentColor`, и это была мёртвая строка: у ползунка
          // сброшен `appearance`, системная раскраска до него не доходит, — все
          // три оси Потока оставались пустым местом между подписями.
          '--range-fill': `${Math.round(value * 100)}%`
        } as React.CSSProperties
      }
      data-testid={`wave-slider-${id}`}
    />

    <div
      className="row-stretch justify-between text-xs text-muted"
    >
      <span>{minLabel}</span>
      <span>{maxLabel}</span>
    </div>
  </div>
);

/**
 * Настройка Потока двумя осями вместо набора «настроений»: знакомость и темп —
 * независимые вещи, и смешивать их в один список значило врать про выбор.
 */
export const WaveTuner: React.FC<WaveTunerProps> = ({ className = '', restartOnChange = true }) => {
  const novelty = usePlayerStore((s) => s.waveNovelty);
  const energy = usePlayerStore((s) => s.waveEnergy);
  const activeGenre = usePlayerStore((s) => s.activeWaveGenre);
  const queueMode = usePlayerStore((s) => s.queueMode);

  const setWaveNovelty = usePlayerStore((s) => s.setWaveNovelty);
  const setWaveEnergy = usePlayerStore((s) => s.setWaveEnergy);
  const setWaveGenre = usePlayerStore((s) => s.setWaveGenre);
  const startMyWave = usePlayerStore((s) => s.startMyWave);
  const setActiveWaveGenre = useUIStore((s) => s.setActiveWaveGenre);

  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (restartTimer.current) {
        clearTimeout(restartTimer.current);
        if (usePlayerStore.getState().queueMode === 'my_wave') void usePlayerStore.getState().startMyWave();
      }
    },
    []
  );

  const scheduleRestart = () => {
    if (!restartOnChange || queueMode !== 'my_wave') return;
    if (restartTimer.current) clearTimeout(restartTimer.current);
    restartTimer.current = setTimeout(() => {
      restartTimer.current = null;
      if (usePlayerStore.getState().queueMode === 'my_wave') void startMyWave();
    }, WAVE_RESTART_DEBOUNCE_MS);
  };

  const handleNovelty = (value: number) => {
    setWaveNovelty(value);
    scheduleRestart();
  };

  const handleEnergy = (value: number) => {
    setWaveEnergy(value);
    scheduleRestart();
  };

  const handleGenre = (value: string | null) => {
    const next = activeGenre === value ? null : value;
    setActiveWaveGenre(next);
    // Жанр — выбор дискретный, ждать нечего: перезапуск делает сам стор.
    void setWaveGenre(next);
  };

  return (
    <div
      className={`wave-tuner ${className} stack gap-5 w-full`}
      data-testid="wave-tuner"
    >
      <div
        className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}
      >
        <AxisSlider
          id="novelty"
          icon={<Compass size={ICON.md} />}
          label="Знакомое или новое"
          minLabel="Знакомое"
          maxLabel="Новое"
          value={novelty}
          valueText={describeNovelty(novelty)}
          onChange={handleNovelty}
        />

        <AxisSlider
          id="energy"
          icon={<Gauge size={ICON.md} />}
          label="Темп"
          minLabel="Спокойное"
          maxLabel="Бодрое"
          value={energy}
          valueText={describeEnergy(energy)}
          onChange={handleEnergy}
        />
      </div>

      <p
        className="m-0 p-3 radius-md text-sm text-secondary bg-surface-2 border-subtle"
        data-testid="wave-axes-summary"
      >
        Сейчас в Потоке: {describeWaveAxes(novelty, energy)}
        {activeGenre ? `, жанр — ${activeGenre}` : ''}.
      </p>

      <div className="stack gap-2" data-testid="wave-genre-picker">
        <div
          className="row gap-2 text-muted"
        >
          <Music size={ICON.sm} />
          <span className="section-label">Жанр — если нужен</span>
        </div>

        <div
          className="scrollbar-thin row-stretch wrap gap-1"
          style={{ maxHeight: '96px', overflowY: 'auto', padding: '2px' }}
        >
          <button
            type="button"
            onClick={() => handleGenre(null)}
            className="chip"
            aria-pressed={activeGenre === null}
            style={{
              // Цвета — в `.chip` / `.chip[aria-pressed='true']` (global.css §13).
              // Инлайновый фон здесь глушил `.chip:hover`: инлайн старше.
              fontSize: 'var(--text-xs)',
              fontWeight: activeGenre === null ? 'var(--weight-semibold)' : 'var(--weight-normal)'
            }}
            data-testid="wave-genre-chip-all"
          >
            Любой
          </button>

          {WAVE_GENRES.map((genre) => {
            const isActive = (activeGenre || '').toLowerCase() === genre.value.toLowerCase();
            return (
              <button
                key={genre.slug}
                type="button"
                onClick={() => handleGenre(genre.value)}
                className="chip text-xs"
                aria-pressed={isActive}
                style={{ fontWeight: isActive ? 'var(--weight-semibold)' : 'var(--weight-normal)' }}
                data-testid={`wave-genre-chip-${genre.slug}`}
              >
                {genre.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
