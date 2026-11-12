import React, { useEffect, useState } from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatDuration } from '../../utils/time';

/** Минуты, которые предлагаются на телефоне. Те же, что в меню полосы плеера. */
export const SLEEP_PANEL_OPTIONS = [15, 30, 45, 60, 90] as const;

/** Секунды до срабатывания таймера; `null`, когда он не заведён. */
export function useSleepCountdown(endsAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [endsAt]);
  if (endsAt === null) return null;
  return Math.max(0, Math.round((endsAt - now) / 1000));
}

export interface SleepTimerPanelProps {
  /** Вызывается после выбора — лист закрывается сам. */
  onPicked?: () => void;
}

/**
 * Таймер сна для телефона.
 *
 * До 3.0 на телефоне его не было вовсе: меню «Ещё» полосы плеера живёт только
 * на компьютере, а в настройки телефона ради таймера никто не ходит. Здесь
 * тот же выбор — минуты и «до конца трека», — показанный листом снизу.
 */
export const SleepTimerPanel: React.FC<SleepTimerPanelProps> = ({ onPicked }) => {
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtTrackEnd = usePlayerStore((s) => s.sleepAtTrackEnd);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const setSleepAtTrackEnd = usePlayerStore((s) => s.setSleepAtTrackEnd);
  const remaining = useSleepCountdown(sleepTimerEndsAt);
  const active = sleepTimerEndsAt !== null || sleepAtTrackEnd;

  const pick = (action: () => void) => {
    action();
    onPicked?.();
  };

  return (
    <div className="stack gap-3" data-testid="sleep-timer-panel">
      <p
        className="m-0 text-sm" style={{ color: active ? 'var(--accent)' : 'var(--text-muted)' }}
        data-testid="sleep-timer-status"
      >
        {sleepAtTrackEnd
          ? 'Остановится, когда доиграет этот трек'
          : remaining !== null
            ? `Остановится через ${formatDuration(remaining)}`
            : 'Музыка плавно стихнет и встанет на паузу'}
      </p>
      <div
        role="group"
        aria-label="Таймер сна"
        className="sleep-timer-grid gap-2"
      >
        {SLEEP_PANEL_OPTIONS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className="chip justify-center"
            style={{ minHeight: '44px' }}
            onClick={() => pick(() => setSleepTimer(minutes))}
            data-testid={`sleep-panel-${minutes}`}
          >
            <span data-numeric>{minutes}</span>
            <span className="text-faint">мин</span>
          </button>
        ))}
        <button
          type="button"
          className="chip justify-center"
          data-active={sleepAtTrackEnd}
          aria-pressed={sleepAtTrackEnd}
          style={{ minHeight: '44px' }}
          onClick={() => pick(() => setSleepAtTrackEnd(true))}
          data-testid="sleep-panel-track-end"
        >
          Конец трека
        </button>
      </div>
      {active && (
        <button
          type="button"
          className="chip justify-center"
          style={{ minHeight: '44px' }}
          onClick={() => pick(() => setSleepTimer(null))}
          data-testid="sleep-panel-off"
        >
          Отключить таймер
        </button>
      )}
    </div>
  );
};
