import { UnifiedTrack } from '../types/music';
import { pluralize } from '../utils/plural';
import { HistoryRecord, PlayEventRecord } from './db';

/**
 * Календарь прослушиваний: что и в какой день звучало.
 *
 * Даты берутся из ленты включений (`plays`): в `history` на трек лежит одна
 * строка с последним `playedAt`, и по ней не скажешь, в какие ещё дни трек
 * играл. Лента это знает — по одной записи на включение. Записи `history` здесь
 * нужны только затем, чтобы превратить ключ трека из события в сам трек с
 * названием и обложкой.
 *
 * Лента появилась позже самой программы, поэтому у треков, прослушанных до неё,
 * событий нет. Такие треки, если их последнее прослушивание попадает в окно,
 * ставятся на день своего `playedAt` — иначе первые недели календаря у давнего
 * слушателя стояли бы пустыми, хотя он слушал. Экран говорит об этом подписью.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Сколько недель показывает карта. */
export const CALENDAR_WEEKS = 12;

/**
 * Запас событий для календаря: полные недели плюс дни текущей — последняя
 * неделя сетки заканчивается не сегодня, а в своё воскресенье.
 */
export const CALENDAR_WINDOW_MS = (CALENDAR_WEEKS + 1) * 7 * DAY_MS;

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря'
];

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Двухбуквенные подписи дней, неделя с понедельника — как принято у нас. */
export const WEEKDAY_LABELS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const;

export interface CalendarCell {
  /** Ключ дня вида `2026-11-09` по местному времени. */
  key: string;
  /** Полночь этого дня по местному времени. */
  start: number;
  /** День ещё не наступил: в сетке стоит, но не рисуется. */
  future: boolean;
}

/** Подпись месяца над столбцом недели, в которой он начался. */
export interface MonthLabel {
  /** Номер столбца (недели) от нуля. */
  column: number;
  label: string;
}

/** Полночь дня, в который попадает момент `ts`, по местному времени. */
export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Ключ дня по местному времени.
 *
 * Не `toISOString().slice(0, 10)`: тот режет по UTC, и вечернее включение
 * уезжало бы на завтра у всех, кто восточнее Гринвича — то есть у всех наших.
 */
export function dateKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Понедельник недели, в которую попадает `ts`, полночь. */
export function startOfWeek(ts: number): number {
  const date = new Date(startOfDay(ts));
  // `getDay()` считает с воскресенья (0); переводим в «с понедельника».
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

/**
 * Сетка недель: `weeks` столбцов по семь дней, последний столбец — неделя
 * с «сегодня». Дни считаются через `Date`, а не прибавлением суток в
 * миллисекундах: на переводе часов сутки бывают по 23 и 25 часов, и арифметика
 * миллисекундами сдвигала бы ключи на день.
 */
export function weeksGrid(now: number, weeks = CALENDAR_WEEKS): CalendarCell[][] {
  const today = startOfDay(now);
  const firstMonday = new Date(startOfWeek(now));
  firstMonday.setDate(firstMonday.getDate() - (weeks - 1) * 7);

  const grid: CalendarCell[][] = [];
  const cursor = new Date(firstMonday);
  for (let week = 0; week < weeks; week += 1) {
    const column: CalendarCell[] = [];
    for (let day = 0; day < 7; day += 1) {
      const start = cursor.getTime();
      column.push({ key: dateKey(start), start, future: start > today });
      cursor.setDate(cursor.getDate() + 1);
    }
    grid.push(column);
  }
  return grid;
}

/**
 * Подписи месяцев над сеткой: месяц подписывается над той неделей, в которую
 * попало его первое число. Самая первая неделя подписывается всегда, иначе
 * левый край карты оставался бы без ориентира.
 */
export function monthLabels(grid: CalendarCell[][]): MonthLabel[] {
  const labels: MonthLabel[] = [];
  grid.forEach((column, index) => {
    const firstOfMonth = column.find((cell) => new Date(cell.start).getDate() === 1);
    if (firstOfMonth) {
      labels.push({ column: index, label: MONTHS_SHORT[new Date(firstOfMonth.start).getMonth()] });
    } else if (index === 0) {
      // Первая неделя без первого числа подписывается месяцем понедельника.
      labels.push({ column: 0, label: MONTHS_SHORT[new Date(column[0].start).getMonth()] });
    }
  });
  return labels;
}

/** Полночь первого дня сетки — с неё начинается окно календаря. */
export function calendarWindowStart(now: number, weeks = CALENDAR_WEEKS): number {
  return weeksGrid(now, weeks)[0][0].start;
}

export interface BucketByDayInput {
  records: HistoryRecord[];
  events: PlayEventRecord[];
  now: number;
  weeks?: number;
}

/**
 * Треки по дням окна: `Map<ключ дня, треки>`.
 *
 * Внутри дня трек один раз, в порядке первого включения за этот день: список
 * под картой читается как «что играло с утра», а не как счётчик повторов.
 * Пропущенные включения (`skipped`) не считаются — это не прослушивание, и в
 * итогах они тоже не растят счётчик.
 *
 * Треки без событий в окне, но с `playedAt` внутри него, ставятся на день
 * своего `playedAt` — см. описание модуля.
 */
export function bucketByDay(input: BucketByDayInput): Map<string, UnifiedTrack[]> {
  const weeks = input.weeks ?? CALENDAR_WEEKS;
  const grid = weeksGrid(input.now, weeks);
  const windowStart = grid[0][0].start;
  const today = startOfDay(input.now);
  const dayEnd = today + DAY_MS;

  const byId = new Map<string, UnifiedTrack>();
  for (const record of input.records) {
    if (record?.track?.id) byId.set(record.id, record.track);
  }

  // день → (id трека → время первого включения в этот день)
  const firstPlay = new Map<string, Map<string, number>>();
  const seenInWindow = new Set<string>();

  const note = (trackId: string, playedAt: number) => {
    if (playedAt < windowStart || playedAt >= dayEnd) return;
    const track = byId.get(trackId);
    if (!track) return;
    const key = dateKey(playedAt);
    let day = firstPlay.get(key);
    if (!day) {
      day = new Map();
      firstPlay.set(key, day);
    }
    const known = day.get(trackId);
    if (known === undefined || playedAt < known) day.set(trackId, playedAt);
  };

  for (const event of input.events) {
    if (!event.trackId) continue;
    // Любое событие в окне, даже пропуск, значит: лента этот трек тогда уже
    // знала, и его `playedAt` досчитывать не нужно — иначе пропуск превращался
    // бы в день прослушивания через чёрный ход.
    if (event.playedAt >= windowStart) seenInWindow.add(event.trackId);
    if (event.skipped === true) continue;
    note(event.trackId, event.playedAt);
  }

  for (const record of input.records) {
    if (!record?.track?.id || seenInWindow.has(record.id)) continue;
    if (!record.playedAt || (record.playCount ?? 0) <= 0) continue;
    note(record.id, record.playedAt);
  }

  const result = new Map<string, UnifiedTrack[]>();
  for (const [key, day] of firstPlay) {
    const ordered = [...day.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([trackId]) => byId.get(trackId))
      .filter((track): track is UnifiedTrack => Boolean(track));
    if (ordered.length > 0) result.set(key, ordered);
  }
  return result;
}

/**
 * Насыщенность клетки, 0…1.
 *
 * Ноль — только у пустого дня. Один трек на фоне дня с полусотней иначе
 * терялся бы в цвете поверхности, поэтому у любого непустого дня есть нижняя
 * граница, а рост от неё — по корню: разница между одним и пятью треками
 * заметнее, чем между сорока и сорока пятью, и глаз это ждёт.
 */
export function intensity(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const ratio = Math.min(1, count / max);
  return Math.min(1, 0.25 + 0.75 * Math.sqrt(ratio));
}

/** «12 ноября» — число и месяц в родительном падеже. */
export function formatDayLabel(key: string): string {
  const [, month, day] = key.split('-').map(Number);
  return `${day} ${MONTHS_GENITIVE[month - 1] ?? ''}`.trim();
}

/** Сколько треков в день — для подписи клетки и заголовка списка. */
export function formatTrackCount(count: number): string {
  if (count <= 0) return 'ничего не играло';
  return pluralize(count, 'трек', 'трека', 'треков');
}
