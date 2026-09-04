import React from 'react';
import { Loader2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Infinity as InfinityIcon } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { Button } from '../common/Button';
import { ICON } from '../../styles/icons';

export interface TransportControlsProps {
  /**
   * `tight` — полоса, отдавшая часть высоты облику, `compact` — обычная полоса,
   * `comfortable` — плеер на весь экран.
   */
  variant?: 'tight' | 'compact' | 'comfortable';
  idPrefix?: string;
  className?: string;
  /**
   * Shuffle and repeat can be dropped from a host that offers them elsewhere
   * (Settings → Плеер hides them from the bar). Props rather than a store read,
   * so the fullscreen player keeps the full row without opting in.
   */
  showShuffle?: boolean;
  showRepeat?: boolean;
  /**
   * Автопоток — это настройка того, что случится после очереди, а не орган
   * управления на ходу. В полосе на телефоне, где на весь ряд остаётся полторы
   * сотни пикселей, он вытесняет название трека; в плеере на весь экран
   * остаётся на месте.
   */
  showRadio?: boolean;
}

const REPEAT_LABEL: Record<string, string> = {
  off: 'выключен',
  all: 'вся очередь',
  one: 'один трек'
};

/*
 * Три ступени вместо шести случайных размеров. Кнопка и её глиф всегда берутся
 * из одной пары (`--control-md` → `ICON.md` и так далее) — именно это заставляет
 * ряд читаться как ряд, а главную кнопку — как главную.
 *
 * Ступени сдвигаются целиком: `tight` — это тот же ряд на одну ступень ниже, а не
 * отдельный набор чисел. Он нужен обликам, которые отдали часть высоты полосы
 * (`tightControls` в `playerSkins.ts`): в таблетке «Парящей» ряд из кнопки 48 px
 * и таймлайна под ней вылезал за скруглённый контур сверху и снизу.
 */
const STEPS = {
  tight: { small: 'sm', step: 'md', main: 'lg', gap: 'var(--space-3)' },
  compact: { small: 'md', step: 'lg', main: 'xl', gap: 'var(--space-4)' },
  comfortable: { small: 'lg', step: 'xl', main: '2xl', gap: 'var(--space-5)' }
} as const;

/** Пара к каждой ступени `ICON` — та же буква, только в кнопках. */
const CONTROL_OF: Record<'sm' | 'md' | 'lg' | 'xl' | '2xl', string> = {
  sm: 'var(--control-sm)',
  md: 'var(--control-md)',
  lg: 'var(--control-lg)',
  xl: 'var(--control-xl)',
  '2xl': 'var(--control-2xl)'
};

/**
 * Shuffle / previous / play-pause / next / repeat / radio. Shared by the player bar and
 * the fullscreen player so the two can never drift apart.
 */
export const TransportControls: React.FC<TransportControlsProps> = ({
  variant = 'compact',
  idPrefix = 'player',
  className = '',
  showShuffle = true,
  showRepeat = true,
  showRadio = true
}) => {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const autoplayRadio = usePlayerStore((s) => s.autoplayRadio);

  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);
  const setAutoplayRadio = usePlayerStore((s) => s.setAutoplayRadio);

  const step = STEPS[variant] ?? STEPS.compact;
  const smallIcon = ICON[step.small];
  const stepIcon = ICON[step.step];
  const mainIcon = ICON[step.main];
  const smallButton = CONTROL_OF[step.small];
  const stepButton = CONTROL_OF[step.step];
  const mainButton = CONTROL_OF[step.main];

  // A resolving stream must not wear the pause glyph — that reads as "playing".
  const showPause = isPlaying && !isLoading;
  const playLabel = isLoading ? 'Загружаем трек' : showPause ? 'Пауза' : 'Играть';

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: step.gap,
        // Ряд не сжимается: кнопки внутри заданы в пикселях и меньше не станут,
        // поэтому «сжатие» вылилось бы в вылезание за край полосы. Уступать
        // место должно название — оно для того и обрезается.
        flexShrink: 0
      }}
    >
      {showShuffle && (
        <Button
          variant="ghost"
          size="icon"
          isActive={isShuffled}
          onClick={toggleShuffle}
          title={isShuffled ? 'Перемешивание включено' : 'Перемешивание выключено'}
          aria-label="Перемешать"
          aria-pressed={isShuffled}
          style={{ width: smallButton, height: smallButton, color: isShuffled ? 'var(--accent)' : 'var(--text-muted)' }}
          data-testid={`${idPrefix}-shuffle-btn`}
        >
          <Shuffle size={smallIcon} />
        </Button>
      )}

      <Button
        variant="ghost"
        size="icon"
        onClick={() => prevTrack()}
        title="Предыдущий трек"
        aria-label="Предыдущий трек"
        style={{ width: stepButton, height: stepButton, color: 'var(--text-primary)' }}
        data-testid={`${idPrefix}-prev-btn`}
      >
        <SkipBack size={stepIcon} />
      </Button>

      <button
        className="transport-play focus-ring"
        onClick={() => togglePlayPause()}
        title={playLabel}
        aria-label={playLabel}
        aria-busy={isLoading || undefined}
        style={{
          width: mainButton,
          height: mainButton
          // Цвета и наведение — в `.transport-play` (global.css §13). Здесь
          // остаётся только размер: он зависит от варианта.
        }}
        data-testid={`${idPrefix}-play-pause-btn`}
      >
        {isLoading ? (
          <Loader2 className="animate-spin" size={mainIcon} aria-hidden="true" />
        ) : showPause ? (
          <Pause size={mainIcon} aria-hidden="true" />
        ) : (
          // The glyph is optically left-heavy; nudge it back onto the centre.
          <Play size={mainIcon} aria-hidden="true" style={{ marginLeft: '2px' }} />
        )}
      </button>

      <Button
        variant="ghost"
        size="icon"
        onClick={() => nextTrack(true)}
        title="Следующий трек"
        aria-label="Следующий трек"
        style={{ width: stepButton, height: stepButton, color: 'var(--text-primary)' }}
        data-testid={`${idPrefix}-next-btn`}
      >
        <SkipForward size={stepIcon} />
      </Button>

      {showRepeat && (
        <Button
          variant="ghost"
          size="icon"
          isActive={repeatMode !== 'off'}
          onClick={cycleRepeatMode}
          title={`Повтор: ${REPEAT_LABEL[repeatMode]}`}
          aria-label={`Повтор: ${REPEAT_LABEL[repeatMode]}`}
          style={{
            width: smallButton,
            height: smallButton,
            color: repeatMode === 'off' ? 'var(--text-muted)' : 'var(--accent)'
          }}
          data-testid={`${idPrefix}-repeat-btn`}
        >
          {repeatMode === 'one' ? <Repeat1 size={smallIcon} /> : <Repeat size={smallIcon} />}
        </Button>
      )}

      {showRadio && (
      <Button
        variant="ghost"
        size="icon"
        isActive={autoplayRadio}
        onClick={() => setAutoplayRadio(!autoplayRadio)}
        title={
          autoplayRadio
            ? 'Автопоток похожих треков включён'
            : 'Автопоток похожих треков выключен'
        }
        aria-label="Автопоток похожих треков (Радио)"
        aria-pressed={autoplayRadio}
        style={{
          width: smallButton,
          height: smallButton,
          color: autoplayRadio ? 'var(--accent)' : 'var(--text-muted)'
        }}
        data-testid={`${idPrefix}-radio-autoplay-btn`}
      >
        {/* Ровно `smallIcon`, без надбавки: у lucide знак бесконечности и без неё
            шире соседних глифов, а лишние два пикселя выбивали кнопку из ряда. */}
        <InfinityIcon size={smallIcon} />
      </Button>
      )}
    </div>
  );
};
