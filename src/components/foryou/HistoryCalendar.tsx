import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { Button } from '../common/Button';
import { TrackCard } from '../search/TrackCard';
import { usePlayerStore } from '../../store/usePlayerStore';
import { HistoryRecord, PlayEventRecord } from '../../services/db';
import {
  bucketByDay,
  dateKey,
  formatDayLabel,
  formatTrackCount,
  intensity,
  monthLabels,
  WEEKDAY_LABELS,
  weeksGrid
} from '../../services/listeningCalendar';
import { ICON } from '../../styles/icons';

export interface HistoryCalendarProps {
  records: HistoryRecord[];
  events: PlayEventRecord[];
  /** Момент чтения истории: экран держит его сам, чтобы сетка не ползла между перерисовками. */
  now: number;
  /** Часть дней стоит по последнему прослушиванию: лента включений моложе истории. */
  approximate: boolean;
}

/**
 * Тепловая карта последних двенадцати недель и список треков выбранного дня.
 *
 * Клетка — кнопка: цвет говорит, сколько треков прозвучало, нажатие
 * раскрывает их под картой. Пустые дни — тоже кнопки, но погашенные: читалке
 * экрана они назовут дату и «ничего не играло», а в обход по табуляции не
 * попадут. Фокус по карте ходит стрелками, а не табуляцией по каждой из
 * восьмидесяти клеток: вход один, на последнем дне с музыкой.
 *
 * Без единого дня с треками не рисуется вовсе — пустая серая сетка смотрелась
 * бы как сломанная.
 */
export const HistoryCalendar: React.FC<HistoryCalendarProps> = ({ records, events, now, approximate }) => {
  const playTrack = usePlayerStore((s) => s.playTrack);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  const grid = useMemo(() => weeksGrid(now), [now]);
  const months = useMemo(() => monthLabels(grid), [grid]);
  const days = useMemo(() => bucketByDay({ records, events, now }), [records, events, now]);
  const todayKey = dateKey(now);

  const max = useMemo(() => {
    let top = 0;
    for (const tracks of days.values()) top = Math.max(top, tracks.length);
    return top;
  }, [days]);

  /** Последний день с музыкой — туда приходит фокус с клавиатуры. */
  const latestKey = useMemo(() => {
    let latest: string | null = null;
    for (const key of days.keys()) if (latest === null || key > latest) latest = key;
    return latest;
  }, [days]);

  const focusKey = selectedKey ?? latestKey;

  const moveFocus = useCallback(
    (fromKey: string, deltaDays: number) => {
      const cursor = new Date(`${fromKey}T00:00:00`);
      cursor.setDate(cursor.getDate() + deltaDays);
      const target = cellRefs.current.get(dateKey(cursor.getTime()));
      if (target && !target.disabled) target.focus();
    },
    []
  );

  const onKeyDown = (key: string) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
    // Столбец — неделя, строка — день: влево-вправо шагают на неделю,
    // вверх-вниз — на день, как глаз и читает сетку.
    const step: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
    const delta = step[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    moveFocus(key, delta);
  };

  const selectedTracks = selectedKey ? days.get(selectedKey) ?? [] : [];

  const listenDay = () => {
    const first = selectedTracks[0];
    if (first) void playTrack(first, selectedTracks, 0);
  };

  if (days.size === 0) return null;

  return (
    <section className="stack gap-3" data-testid="history-calendar">
      <div>
        <h2 className="m-0 text-lg weight-semibold text-primary leading-lg tracking-lg">Календарь</h2>
        <p className="m-0 mt-1 text-sm text-secondary leading-sm">
          Чем ярче день, тем больше в нём треков. Нажмите на день, чтобы увидеть, что играло.
        </p>
        {approximate && (
          <p className="m-0 mt-1 text-xs text-muted leading-xs" data-testid="history-calendar-approximate">
            Часть дней стоит по последнему прослушиванию: отдельные включения тогда ещё не записывались.
          </p>
        )}
      </div>

      {/* Число столбцов — из данных: таблице стилей незачем знать его заранее. */}
      <div className="history-calendar" style={{ '--weeks': grid.length } as React.CSSProperties}>
        <div className="history-calendar-months" aria-hidden="true">
          {months.map((month) => (
            <span
              key={month.column}
              className="history-calendar-month"
              style={{ gridColumn: month.column + 1 }}
            >
              {month.label}
            </span>
          ))}
        </div>

        <div className="history-calendar-weekdays" aria-hidden="true">
          {/* Подписаны через день: семь подписей в строку в 20 px не влезают. */}
          {WEEKDAY_LABELS.map((label, index) => (
            <span key={label} className="history-calendar-weekday">
              {index % 2 === 0 ? label : ''}
            </span>
          ))}
        </div>

        <div
          className="history-calendar-grid"
          role="group"
          aria-label="Прослушивания по дням за последние двенадцать недель"
        >
          {grid.flat().map((cell) => {
            if (cell.future) {
              return <span key={cell.key} className="history-calendar-cell" data-future="true" aria-hidden="true" />;
            }
            const count = days.get(cell.key)?.length ?? 0;
            const selected = cell.key === selectedKey;
            return (
              <button
                key={cell.key}
                ref={(node) => {
                  if (node) cellRefs.current.set(cell.key, node);
                  else cellRefs.current.delete(cell.key);
                }}
                type="button"
                className="history-calendar-cell"
                // Насыщенность — из данных, поэтому инлайном; цвет из неё
                // собирает таблица стилей.
                style={{ '--heat': intensity(count, max) } as React.CSSProperties}
                aria-label={`${formatDayLabel(cell.key)}: ${formatTrackCount(count)}`}
                aria-pressed={selected}
                data-today={cell.key === todayKey || undefined}
                data-testid={`calendar-day-${cell.key}`}
                disabled={count === 0}
                tabIndex={cell.key === focusKey ? 0 : -1}
                onClick={() => setSelectedKey(selected ? null : cell.key)}
                onKeyDown={onKeyDown(cell.key)}
              />
            );
          })}
        </div>
      </div>

      {selectedKey && selectedTracks.length > 0 && (
        <div className="stack gap-2" data-testid="history-calendar-day">
          <div className="row justify-between gap-3 wrap">
            <h3 className="m-0 text-sm weight-semibold text-primary leading-sm">
              {formatDayLabel(selectedKey)}{' '}
              <span className="text-secondary weight-normal" data-numeric>
                · {formatTrackCount(selectedTracks.length)}
              </span>
            </h3>
            <Button
              variant="primary"
              size="sm"
              icon={<Play size={ICON.sm} aria-hidden="true" />}
              onClick={listenDay}
              data-testid="history-calendar-play"
            >
              Слушать день
            </Button>
          </div>
          <div className="stack gap-1">
            {selectedTracks.map((track, index) => (
              <TrackCard key={track.id} track={track} index={index} layout="row" contextQueue={selectedTracks} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

export default HistoryCalendar;
