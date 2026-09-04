import React, { useState } from 'react';
import { Gauge, RotateCcw } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useDismissable } from '../../hooks';
import { Button } from '../common/Button';
import { MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE } from '../../services/audioEngine';
import { ICON } from '../../styles/icons';

/**
 * Speed presets, named the way listeners name them.
 *
 * The values are the ones the slowed/sped-up scene actually uses — 0.8 is the
 * classic "slowed + reverb" tempo, 1.4 is nightcore — so a preset sounds like the
 * edit the user has heard elsewhere rather than a generic percentage.
 */
export const TEMPO_PRESETS: ReadonlyArray<{ label: string; rate: number; hint: string }> = [
  { label: 'Ultra slowed', rate: 0.65, hint: 'очень медленно, ниже тональность' },
  { label: 'Super slowed', rate: 0.8, hint: 'классический slowed + reverb' },
  { label: 'Slowed', rate: 0.9, hint: 'чуть медленнее оригинала' },
  { label: 'Оригинал', rate: 1, hint: 'как в оригинале' },
  { label: 'Sped up', rate: 1.25, hint: 'быстрее и выше' },
  { label: 'Nightcore', rate: 1.4, hint: 'заметно быстрее и выше' }
];

/** Formats a rate as it appears on the button: `1×`, `0.85×`, `1.25×`. */
export function formatRate(rate: number): string {
  const rounded = Math.round(rate * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0$/, '')}×`;
}

export interface TempoControlProps {
  /**
   * Which edge the popover is anchored to. It opens upward either way; the anchor
   * decides which way it grows sideways, so a control near the left edge of the
   * screen does not push its panel off-screen.
   */
  align?: 'left' | 'right';
  /** `sm` matches the player bar transport, `lg` the roomier fullscreen controls. */
  size?: 'sm' | 'lg';
}

/**
 * Содержимое регулятора: пресеты, ползунок и переключатель тональности.
 *
 * Вынесено отдельно от того, **где** оно показывается, и это не украшение.
 * На ПК регулятор — всплывающая панель у кнопки; на телефоне такая панель
 * прибита к кнопке посреди нижнего ряда и растёт вбок за край экрана —
 * половина пресетов оказывалась за кадром. Телефон показывает то же самое
 * листом снизу, и для этого ему нужно содержимое без привязки к кнопке.
 */
export interface TempoPanelProps {
  /**
   * Сколько пресетов в ряду. Две колонки компактнее и на ПК читаются лучше; на
   * телефоне в них не помещаются подписи — «Ultra slowed» и «Super slowed»
   * обрезаются многоточием ровно там, где отличаются друг от друга. Один
   * столбец там честнее: лист снизу и так высокий.
   */
  columns?: 1 | 2;
}

export const TempoPanel: React.FC<TempoPanelProps> = ({ columns = 2 }) => {
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const preservePitch = usePlayerStore((s) => s.preservePitch);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const setPreservePitch = usePlayerStore((s) => s.setPreservePitch);
  const resetPlaybackRate = usePlayerStore((s) => s.resetPlaybackRate);

  const isModified = Math.abs(playbackRate - 1) > 0.001;
  const activePreset = TEMPO_PRESETS.find((preset) => Math.abs(preset.rate - playbackRate) < 0.001);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-2)'
          }}
        >
          {/*
            * Строчными, а не капсом. Капс требует разрядки — набранный
            * трекингом обычного текста, он даёт 0.13 px между буквами, и
            * заголовок читается не заголовком, а слипшейся ошибкой вёрстки.
            * Роль надстрочника здесь всё равно пустая: панель подписана
            * `aria-label`, а открывается с кнопки «Настроить песню».
            */}
          <span
            style={{
              fontSize: 'var(--text-sm)',
              letterSpacing: 'var(--tracking-sm)',
              fontWeight: 'var(--weight-medium)',
              color: 'var(--text-secondary)'
            }}
          >
            Скорость
          </span>
          {isModified && (
            <button
              className="chip focus-ring"
              onClick={resetPlaybackRate}
              title="Вернуть обычную скорость"
              data-testid="tempo-reset"
            >
              <RotateCcw size={ICON.xs} aria-hidden="true" />
              Сбросить
            </button>
          )}
        </div>

        <div
          role="group"
          aria-label="Пресеты скорости"
          style={{
            display: 'grid',
            gridTemplateColumns:
              columns === 1 ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: 'var(--space-1)'
          }}
        >
          {TEMPO_PRESETS.map((preset) => (
            <button
              key={preset.label}
              className="chip focus-ring"
              role="radio"
              aria-checked={activePreset?.label === preset.label}
              data-active={activePreset?.label === preset.label}
              onClick={() => setPlaybackRate(preset.rate)}
              title={preset.hint}
              style={{ justifyContent: 'space-between' }}
              data-testid={`tempo-preset-${preset.rate}`}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{preset.label}</span>
              {/*
                * Числа стоят столбцом, а не «где придётся».
                *
                * При `space-between` и подписях разной длины каждое число
                * вставало на своё место: «0.65×» на одной высоте, «1×» на
                * другой, «1.25×» на третьей — шесть значений вразнобой в
                * сетке два на три. Общая ширина поля и выключка вправо
                * ставят их в одну линию, а `data-numeric` даёт цифрам
                * одинаковую ширину, иначе «1» и «4» разъезжались бы и внутри
                * поля.
                */}
              <span
                data-numeric
                style={{
                  minWidth: '3.05em',
                  textAlign: 'right',
                  flexShrink: 0,
                  color: 'var(--text-faint)'
                }}
              >
                {formatRate(preset.rate)}
              </span>
            </button>
          ))}
        </div>

        <label
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
          data-testid="tempo-manual"
        >
          <span
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-secondary)'
            }}
          >
            <span>Вручную</span>
            <span data-numeric style={{ color: 'var(--text-primary)' }}>
              {formatRate(playbackRate)}
            </span>
          </span>
          <input
            type="range"
            className="focus-ring"
            min={MIN_PLAYBACK_RATE}
            max={MAX_PLAYBACK_RATE}
            step={0.05}
            value={playbackRate}
            onChange={(event) => setPlaybackRate(Number(event.target.value))}
            aria-label="Скорость воспроизведения"
            style={
              {
                width: '100%',
                // Доля заливки, а не собственное оформление: как выглядит
                // дорожка, решает одно правило в global.css. Без этой
                // переменной ползунок остаётся ровной дорожкой — видимой, но
                // без пройденной части, и тогда «Вручную» не показывает, где
                // стоит бегунок, пока в него не ткнули.
                '--range-fill': `${(
                  ((playbackRate - MIN_PLAYBACK_RATE) / (MAX_PLAYBACK_RATE - MIN_PLAYBACK_RATE)) *
                  100
                ).toFixed(1)}%`
              } as React.CSSProperties
            }
            data-testid="tempo-slider"
          />
        </label>

        {/*
          * Пояснение ушло в `title`, а не осталось строкой под названием.
          * Подпись менялась на каждое нажатие и пересказывала словами то, что
          * уже сказано положением переключателя, — при шести чипах и ползунке
          * выше это третий уровень текста в панели на 268 px. Кому нужно
          * объяснение, тот задержится на строке.
          */}
        <button
          role="switch"
          aria-checked={preservePitch}
          className="menu-item-hover focus-ring"
          onClick={() => setPreservePitch(!preservePitch)}
          title={
            preservePitch
              ? 'Меняется только темп, голос остаётся прежним'
              : 'Голос меняется вместе с темпом, как в slowed и nightcore'
          }
          style={{ textAlign: 'left' }}
          data-testid="tempo-preserve-pitch"
        >
          <span style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)' }}>Сохранять тональность</span>
          <span
            aria-hidden="true"
            style={{
              width: '30px',
              height: '16px',
              flexShrink: 0,
              borderRadius: 'var(--radius-full)',
              backgroundColor: preservePitch ? 'var(--accent)' : 'var(--surface-3)',
              border: '1px solid var(--border-subtle)',
              position: 'relative',
              transition: 'background-color var(--dur-fast) var(--ease-out)'
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: '2px',
                left: '2px',
                width: '10px',
                height: '10px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: preservePitch ? 'var(--text-on-accent)' : 'var(--text-muted)',
                // Ползунок едет трансформацией, а не `left`.
                //
                // `left` пересчитывает раскладку на каждом из 150 мс, и
                // десятипиксельная точка заметно дёргается — тем виднее, что
                // дорожка под ней в это же время чисто переливается цветом.
                // DESIGN_SYSTEM §6 это и запрещает: никаких top/left в анимации.
                transform: preservePitch ? 'translateX(14px)' : 'translateX(0)',
                transition: 'transform var(--dur-fast) var(--ease-out)'
              }}
            />
          </span>
        </button>
    </div>
  );
};

/**
 * The "настроить песню" control: speed presets, a manual slider and a pitch
 * switch, in one popover next to the transport.
 *
 * Deliberately compact — it is a per-listen tweak, not a setting, so it lives in
 * the player bar rather than in Settings, and shows the active rate on its own
 * face so a forgotten 0.65× is never a mystery.
 */
export const TempoControl: React.FC<TempoControlProps> = ({ align = 'right', size: sizeName = 'sm' }) => {
  const playbackRate = usePlayerStore((s) => s.playbackRate);

  const [isOpen, setIsOpen] = useState(false);
  const { containerRef, backdropProps } = useDismissable<HTMLDivElement>({
    isOpen,
    onDismiss: () => setIsOpen(false),
    lockScroll: false
  });

  const isModified = Math.abs(playbackRate - 1) > 0.001;
  const activePreset = TEMPO_PRESETS.find((preset) => Math.abs(preset.rate - playbackRate) < 0.001);
  const controlSize = sizeName === 'lg' ? 'var(--control-lg)' : 'var(--control-md)';
  const iconSize = sizeName === 'lg' ? ICON.lg : ICON.md;

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <Button
        variant="ghost"
        size="icon"
        isActive={isOpen || isModified}
        onClick={() => setIsOpen((open) => !open)}
        title={
          isModified
            ? `Скорость ${formatRate(playbackRate)}${activePreset ? ` — ${activePreset.label}` : ''}`
            : 'Настроить песню: скорость и тональность'
        }
        aria-label="Настроить песню"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        style={{
          width: isModified ? 'auto' : controlSize,
          minWidth: controlSize,
          height: controlSize,
          // С числом на лице кнопка перестаёт быть квадратной иконкой и
          // становится плашкой: манометру и цифрам нужен воздух между собой и
          // по краям, иначе «0.8×» читается как продолжение иконки. Пилюля —
          // чтобы форма сама говорила «здесь значение», а не «здесь кнопка».
          padding: isModified ? '0 var(--space-3)' : 0,
          gap: isModified ? 'var(--space-2)' : 0,
          borderRadius: isModified ? 'var(--radius-full)' : undefined,
          color: isModified ? 'var(--accent)' : undefined
        }}
        data-testid="tempo-button"
      >
        <Gauge size={iconSize} aria-hidden="true" />
        {isModified && (
          <span
            data-numeric
            style={{
              fontSize: 'var(--text-xs)',
              fontWeight: 'var(--weight-semibold)',
              lineHeight: 1,
              letterSpacing: 'var(--tracking-xs)'
            }}
            data-testid="tempo-badge"
          >
            {formatRate(playbackRate)}
          </span>
        )}
      </Button>

      {isOpen && (
        <>
          <div {...backdropProps} style={{ position: 'fixed', inset: 0, zIndex: 1 }} />
          <div
            ref={containerRef}
            role="dialog"
            aria-label="Настройка звучания"
            className="panel-raised animate-pop-in"
            style={
              {
                position: 'absolute',
                [align]: 0,
                bottom: 'calc(100% + var(--space-3))',
                // Панель раскрывается вверх и прижата к тому же краю, что и
                // кнопка, — расти она обязана оттуда же, иначе всплывает из
                // пустоты рядом со своим переключателем.
                transformOrigin: `bottom ${align}`,
                zIndex: 2,
                // Ширина — под содержимое, а не наоборот.
                //
                // Было 268: на столько панель нарисована, а шесть пресетов в две
                // колонки просят 322 — самая длинная подпись «Super slowed» с
                // числом рядом, плюс поля. Сетка `1fr 1fr` колонку уже содержимого не
                // делает, поэтому правый столбец просто вылезал за край панели и
                // висел в воздухе. Ниже стоит `minmax(0, 1fr)` — предохранитель
                // на будущее: если подписи ещё вырастут, они обрежутся
                // многоточием внутри панели, а не вылезут наружу.
                //
                // На узком экране берём столько, сколько есть, оставляя поля.
                width: 'min(344px, calc(100vw - var(--space-5)))',
                maxWidth: 'calc(100vw - var(--space-5))',
                padding: 'var(--space-3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
                '--ring-offset-color': 'var(--surface-3)'
              } as React.CSSProperties
            }
            data-testid="tempo-panel"
          >
            <TempoPanel />
          </div>
        </>
      )}
    </div>
  );
};
