import React, { useCallback, useState } from 'react';
import { motion } from 'motion/react';
import { Play, X } from 'lucide-react';
import { Button } from '../common/Button';
import { usePlayerStore } from '../../store/usePlayerStore';
import { appear, swap } from '../../styles/motion';
import { ICON } from '../../styles/icons';
import { coverGradient, coverInitial } from '../../utils/coverFallback';
import { pluralize } from '../../utils/plural';
import { dateKey, formatDayLabel } from '../../services/listeningCalendar';
import { formatComparison, monthName, MonthlyRecap, MonthlyTopTrack, previousMonth } from '../../services/monthlyRecap';
import type { HomeBlockId } from '../../store/useAppLayoutStore';
import { useMonthlyRecap } from './useMonthlyRecap';

/**
 * Карточка «Октябрь в цифрах» — месячный рекап (идея 28 плана 4.0, усечённо).
 *
 * Сравнения с друзьями нет: на сервере нет аккаунтов, сравнивать не с кем.
 * Показывает только своё: три-четыре числа крупно, топ-3 треков с обложками и
 * строку сравнения с прошлым месяцем. Живёт на главной первые дни нового месяца
 * и всегда — в «Для вас» под календарём (`MonthlyRecapSection`).
 */
export interface MonthlyRecapCardProps {
  recap: MonthlyRecap;
  /** Есть — карточку можно убрать; на главной это запоминается до следующего месяца. */
  onDismiss?: () => void;
  /** Читается `HomeLayout`: карточка становится блоком главной. */
  homeBlock?: HomeBlockId;
  testId?: string;
}

interface Figure {
  id: string;
  value: string;
  label: string;
}

/** Числа карточки: прослушивания всегда, минуты — только когда они известны. */
export function recapFigures(recap: MonthlyRecap): Figure[] {
  const figures: Figure[] = [{ id: 'plays', value: String(recap.plays), label: 'прослушиваний' }];
  if (recap.minutes !== null) figures.push({ id: 'minutes', value: String(recap.minutes), label: 'минут музыки' });
  figures.push({
    id: 'new-artists',
    value: String(recap.newArtists.length),
    label: recap.newArtists.length === 1 ? 'новый исполнитель' : 'новых исполнителей'
  });
  figures.push({
    id: 'streak',
    value: String(recap.streakDays),
    label: `${recap.streakDays === 1 ? 'день' : recap.streakDays < 5 ? 'дня' : 'дней'} подряд`
  });
  return figures;
}

const Thumb: React.FC<{ track: MonthlyTopTrack['track'] }> = ({ track }) => {
  const [broken, setBroken] = useState(false);
  return (
    <span className="monthly-recap-thumb relative overflow-hidden shrink-0" aria-hidden="true">
      {track.artworkUrl && !broken ? (
        <img src={track.artworkUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        // Без обложки — градиент из названия, как у всех обложек приложения.
        <span className="cover-fallback fill-cover row justify-center" style={{ background: coverGradient(track.title, track.artist) }}>
          <span className="cover-fallback-letter">{coverInitial(track.title)}</span>
        </span>
      )}
    </span>
  );
};

export const MonthlyRecapCard: React.FC<MonthlyRecapCardProps> = ({ recap, onDismiss, testId = 'monthly-recap' }) => {
  const playTrack = usePlayerStore((s) => s.playTrack);

  const playAgain = useCallback(() => {
    const list = recap.topTracks.map((entry) => entry.track);
    if (list.length === 0) return;
    void playTrack(list[0], list, 0);
  }, [playTrack, recap.topTracks]);

  const title = `${monthName(recap)} в цифрах`;
  const comparison = formatComparison(recap);

  return (
    <motion.section className="monthly-recap card stack gap-4 p-5" data-testid={testId} aria-label={title} {...appear()}>
      <header className="row-start justify-between gap-3">
        <div className="stack gap-1 min-0">
          <p className="m-0 text-sm text-secondary">Итоги месяца</p>
          <h2 className="m-0 text-primary type-2xl" data-testid={`${testId}-title`}>
            {title}
          </h2>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="monthly-recap-close press focus-ring row justify-center shrink-0 pointer"
            onClick={onDismiss}
            aria-label="Скрыть итоги месяца"
            data-testid={`${testId}-close`}
          >
            <X size={ICON.md} aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="monthly-recap-figures grid gap-3">
        {recapFigures(recap).map((figure, index) => (
          <motion.div
            key={figure.id}
            className="monthly-recap-figure stack gap-px"
            data-testid={`${testId}-${figure.id}`}
            {...appear(index + 1)}
          >
            <span data-numeric className="type-2xl weight-bold text-primary tabular">
              {figure.value}
            </span>
            <span className="text-xs text-secondary">{figure.label}</span>
          </motion.div>
        ))}
      </div>

      {/* Строка сравнения меняется вместе с месяцем — кроссфейдом, без сдвига. */}
      <motion.p key={comparison} className="m-0 text-sm text-secondary" data-testid={`${testId}-compare`} {...swap()}>
        {comparison}
      </motion.p>

      <ol className="monthly-recap-top m-0 p-0 list-none stack gap-2" data-testid={`${testId}-top`}>
        {recap.topTracks.map((entry, index) => (
          <li key={entry.track.id} className="row gap-3 min-0">
            <span data-numeric className="monthly-recap-rank text-sm text-faint tabular text-center">
              {index + 1}
            </span>
            <Thumb track={entry.track} />
            <span className="grow stack gap-px">
              <span className="text-sm weight-medium text-primary text-truncate">{entry.track.title}</span>
              <span className="text-xs text-secondary text-truncate">{entry.track.artist}</span>
            </span>
            <span data-numeric className="text-xs text-secondary nowrap tabular" title="Сколько раз включали">
              {pluralize(entry.plays, 'раз', 'раза', 'раз')}
            </span>
          </li>
        ))}
      </ol>

      {recap.busiestDay && (
        <p className="m-0 text-xs text-muted" data-testid={`${testId}-busiest`}>
          Самый музыкальный день — {formatDayLabel(dateKey(recap.busiestDay.date))}:{' '}
          {pluralize(recap.busiestDay.plays, 'прослушивание', 'прослушивания', 'прослушиваний')}.
        </p>
      )}

      <div className="row gap-2 wrap">
        <Button
          variant="primary"
          size="sm"
          icon={<Play size={ICON.sm} fill="currentColor" aria-hidden="true" />}
          onClick={playAgain}
          data-testid={`${testId}-play`}
        >
          Послушать ещё раз
        </Button>
      </div>
    </motion.section>
  );
};

/**
 * Раздел «Для вас»: рекап прошлого месяца без кнопки закрытия — здесь он
 * постоянный. Пока месяц не набрал десяти включений, раздела нет вовсе.
 */
export const MonthlyRecapSection: React.FC = () => {
  const [now] = useState(() => Date.now());
  const recap = useMonthlyRecap(previousMonth(now));
  if (!recap) return null;
  return (
    <section className="stack gap-3" data-testid="foryou-monthly-recap">
      <MonthlyRecapCard recap={recap} testId="foryou-monthly-recap-card" />
    </section>
  );
};

export default MonthlyRecapCard;
