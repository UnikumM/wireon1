import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup';
import { MonthlyRecapCard, MonthlyRecapSection } from '../../src/components/recap/MonthlyRecapCard';
import { useHomeMonthlyRecap } from '../../src/components/recap/useMonthlyRecap';
import { buildMonthlyRecap, MONTHLY_RECAP_DISMISSED_KEY } from '../../src/services/monthlyRecap';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import * as dbService from '../../src/services/db';
import { HistoryRecord, PlayEventRecord } from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';
import { resetPlayerStore } from '../helpers/testUtils';

/**
 * Карточка «Октябрь в цифрах»: рендер чисел и топа, кнопка ставит топ в очередь,
 * закрытие на главной запоминается ключом месяца в настройках.
 */

const at = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour).getTime();

const track = (id: string, artist: string, title: string): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title,
  artist,
  duration: 200,
  artworkUrl: id === 'a' ? 'https://img.test/a.jpg' : ''
});

const a = track('a', 'Кино', 'Группа крови');
const b = track('b', 'Земфира', 'Искала');
const c = track('c', 'Сплин', 'Выхода нет');

const history: HistoryRecord[] = [
  { id: a.id, track: a, playCount: 7, playedAt: at(9, 20) },
  { id: b.id, track: b, playCount: 3, playedAt: at(9, 10) },
  { id: c.id, track: c, playCount: 2, playedAt: at(9, 5) }
];
const events: PlayEventRecord[] = [
  ...Array.from({ length: 7 }, (_, i) => ({ trackId: a.id, playedAt: at(9, i + 1), seconds: 180 })),
  ...Array.from({ length: 3 }, (_, i) => ({ trackId: b.id, playedAt: at(9, 10 + i), seconds: 120 })),
  ...Array.from({ length: 2 }, (_, i) => ({ trackId: c.id, playedAt: at(9, 5 + i) })),
  ...Array.from({ length: 8 }, (_, i) => ({ trackId: a.id, playedAt: at(8, i + 1) }))
];

const recap = buildMonthlyRecap({ events, history }, { year: 2026, month: 9 });

const HomeHarness: React.FC = () => {
  const home = useHomeMonthlyRecap();
  if (!home) return <p data-testid="home-no-recap">нет</p>;
  return <MonthlyRecapCard recap={home.recap} onDismiss={home.dismiss} testId="home-monthly-recap" />;
};

describe('MonthlyRecapCard', () => {
  beforeEach(async () => {
    resetPlayerStore();
    await dbService.clearAllData();
  });
  afterEach(() => vi.restoreAllMocks());

  it('показывает месяц, числа, топ и сравнение', () => {
    render(<MonthlyRecapCard recap={recap} />);
    expect(screen.getByTestId('monthly-recap-title')).toHaveTextContent('Октябрь в цифрах');
    expect(screen.getByTestId('monthly-recap-plays')).toHaveTextContent('12');
    // 7×180 + 3×120 = 1620 с = 27 мин; у Сплина секунд нет.
    expect(screen.getByTestId('monthly-recap-minutes')).toHaveTextContent('27');
    // Кино слушали в сентябре — новые только Земфира и Сплин.
    expect(screen.getByTestId('monthly-recap-new-artists')).toHaveTextContent('2');
    expect(screen.getByTestId('monthly-recap-compare')).toHaveTextContent('На 50% больше, чем в сентябре');
    const top = screen.getByTestId('monthly-recap-top');
    expect(top.querySelectorAll('li')).toHaveLength(3);
    expect(top).toHaveTextContent('Группа крови');
    expect(top.querySelector('img')?.getAttribute('src')).toBe('https://img.test/a.jpg');
    // Без обложки — градиент с первой буквой, как у всех обложек.
    expect(top.querySelectorAll('.cover-fallback-letter')).toHaveLength(2);
    // Крестика нет, пока карточку нельзя закрыть.
    expect(screen.queryByTestId('monthly-recap-close')).toBeNull();
  });

  it('без секунд в ленте минут не показывает', () => {
    const dry = buildMonthlyRecap({ events: events.map(({ seconds: _s, ...rest }) => rest), history }, { year: 2026, month: 9 });
    render(<MonthlyRecapCard recap={dry} />);
    expect(screen.queryByTestId('monthly-recap-minutes')).toBeNull();
    expect(screen.getByTestId('monthly-recap-plays')).toHaveTextContent('12');
  });

  it('«Послушать ещё раз» ставит топ-треки в очередь с первого', () => {
    const playTrack = vi.fn().mockResolvedValue(undefined);
    usePlayerStore.setState({ playTrack });
    render(<MonthlyRecapCard recap={recap} />);
    fireEvent.click(screen.getByTestId('monthly-recap-play'));
    expect(playTrack).toHaveBeenCalledTimes(1);
    const [first, queue, index] = playTrack.mock.calls[0];
    expect(first.id).toBe('a');
    expect(queue.map((t: UnifiedTrack) => t.id)).toEqual(['a', 'b', 'c']);
    expect(index).toBe(0);
  });

  it('на главной появляется в первую неделю месяца, а закрытие запоминается', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(at(10, 3));
    for (const record of history) await dbService.db.history.put(record);
    for (const event of events) await dbService.db.plays.add(event);

    const { unmount } = render(<HomeHarness />);
    expect(await screen.findByTestId('home-monthly-recap')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('home-monthly-recap-close'));
    expect(screen.getByTestId('home-no-recap')).toBeInTheDocument();
    await waitFor(async () => {
      expect(await dbService.getSetting(MONTHLY_RECAP_DISMISSED_KEY, null)).toBe('2026-10');
    });
    unmount();

    // После перезапуска карточка не возвращается — ключ месяца совпал.
    render(<HomeHarness />);
    await waitFor(() => expect(screen.getByTestId('home-no-recap')).toBeInTheDocument());
    expect(screen.queryByTestId('home-monthly-recap')).toBeNull();
  });

  it('на главной молчит после седьмого числа и без десяти включений', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(at(10, 9));
    for (const record of history) await dbService.db.history.put(record);
    for (const event of events) await dbService.db.plays.add(event);
    render(<HomeHarness />);
    await waitFor(() => expect(screen.getByTestId('home-no-recap')).toBeInTheDocument());

    // Прошлый месяц закрыли, но пришёл новый — карточка должна вернуться.
    await dbService.setSetting(MONTHLY_RECAP_DISMISSED_KEY, '2026-09');
    vi.spyOn(Date, 'now').mockReturnValue(at(10, 2));
    render(<HomeHarness />);
    expect(await screen.findByTestId('home-monthly-recap')).toBeInTheDocument();
  });

  it('в «Для вас» стоит всегда, пока месяцу есть что сказать', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(at(10, 25));
    render(<MonthlyRecapSection />);
    // Пустая база — раздела нет.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('foryou-monthly-recap')).toBeNull();

    for (const record of history) await dbService.db.history.put(record);
    for (const event of events) await dbService.db.plays.add(event);
    render(<MonthlyRecapSection />);
    expect(await screen.findByTestId('foryou-monthly-recap-card-title')).toHaveTextContent('Октябрь в цифрах');
  });
});
