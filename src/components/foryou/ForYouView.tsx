import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Disc3, Music2, RefreshCw } from 'lucide-react';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { Skeleton } from '../common/Skeleton';
import { SourceBadge } from '../common/SourceBadge';
import { TrackCard } from '../search/TrackCard';
import { DailyMixCard } from './DailyMixCard';
import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import {
  getFirstPlayEventAt,
  getHistory,
  getHistoryRecords,
  getPlayEvents,
  HistoryRecord,
  PlayEventRecord
} from '../../services/db';
import { buildDailyMixes, dailyMixDateKey, DailyMix } from '../../services/dailyMixes';
import {
  buildPeriodStats,
  formatListeningTime,
  ListeningStats,
  StatsPeriod,
  statsPeriodStart,
  STATS_MAX_WINDOW_MS,
  STATS_PERIOD_LABELS,
  STATS_PERIODS
} from '../../services/listeningStats';
import { pluralize } from '../../utils/plural';
import { ICON } from '../../styles/icons';

/** Сколько записей истории берём в расчёт: хватает на итоги и на миксы. */
const HISTORY_DEPTH = 500;

const SHELL: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-6)'
};

export interface ForYouViewProps {
  className?: string;
}

interface SummaryCard {
  label: string;
  value: string;
  hint: string;
  testId: string;
}

function buildSummaryCards(stats: ListeningStats, period: StatsPeriod): SummaryCard[] {
  return [
    {
      label: 'Прослушиваний',
      value: String(stats.totalPlays),
      hint: `${pluralize(stats.uniqueTracks, 'разный трек', 'разных трека', 'разных треков')}`,
      testId: 'stats-total-plays'
    },
    {
      label: 'Примерно времени',
      value: formatListeningTime(stats.approxSeconds),
      hint: 'Длительность × число включений, поэтому «примерно»',
      testId: 'stats-time'
    },
    {
      label: 'Исполнителей',
      value: String(stats.uniqueArtists),
      // В окне «за 30 дней» — это и есть всё окно, и подпись про них была бы
      // пересказом цифры слева. За всё время она осмысленна: показывает, к
      // какой части наслушанного человек возвращается сейчас.
      hint:
        period === 'all'
          ? `${pluralize(stats.activeLast30Days, 'трек', 'трека', 'треков')} слушали за 30 дней`
          : `${pluralize(stats.uniqueTracks, 'трек', 'трека', 'треков')} за это время`,
      testId: 'stats-artists'
    }
  ];
}

/**
 * «Для вас»: несколько готовых миксов из своей же медиатеки и честные итоги
 * прослушанного.
 *
 * Всё считается на месте из локальной истории — ни один счётчик отсюда никуда
 * не уходит. Из этого же следует и ограничение: база помнит по треку только
 * последнее включение и их число, поэтому графика «по дням» здесь нет и быть
 * не может.
 */
export const ForYouView: React.FC<ForYouViewProps> = ({ className = '' }) => {
  const favorites = useLibraryStore((s) => s.favorites);
  const playlists = useLibraryStore((s) => s.playlists);
  const setActiveView = useUIStore((s) => s.setActiveView);

  // Медиатека для миксов — это всё, что человек сложил себе сам: плейлисты и
  // избранное. Таблица `tracks` в базе не наполняется, брать оттуда нечего.
  const libraryTracks = useMemo(
    () => playlists.flatMap((playlist) => playlist.tracks || []),
    [playlists]
  );

  const [records, setRecords] = useState<HistoryRecord[] | null>(null);
  /**
   * Записи для треков, которые попали в окно, но не попали на страницу истории.
   * У человека, слушающего много разного, за месяц наберётся больше
   * {@link HISTORY_DEPTH} разных треков, и без этого добора часть включений в
   * окне оказалась бы не в чем показать.
   */
  const [windowRecords, setWindowRecords] = useState<HistoryRecord[]>([]);
  const [events, setEvents] = useState<PlayEventRecord[]>([]);
  /** Когда начали писать отдельные включения — для честной подписи под окном. */
  const [eventsSince, setEventsSince] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [period, setPeriod] = useState<StatsPeriod>('all');
  // Пересобираем миксы только по кнопке или при смене суток, а не на каждый
  // рендер: иначе список бы прыгал под курсором.
  const [dateKey, setDateKey] = useState(() => dailyMixDateKey());
  /**
   * «Сейчас» фиксируется на момент чтения, а не берётся при каждом расчёте:
   * иначе граница окна ползла бы между перерисовками и топ мог бы измениться
   * без причины, просто от того, что прошла минута.
   */
  const [now, setNow] = useState<number>(() => Date.now());

  const load = useCallback(async () => {
    setRecords(null);
    setFailed(false);
    try {
      const readAt = Date.now();
      const [history, windowEvents, firstEventAt] = await Promise.all([
        getHistory(HISTORY_DEPTH),
        getPlayEvents(readAt - STATS_MAX_WINDOW_MS),
        getFirstPlayEventAt()
      ]);

      const known = new Set(history.map((record) => record.id));
      const missing = [...new Set(windowEvents.map((event) => event.trackId))].filter(
        (id) => id && !known.has(id)
      );

      setRecords(history);
      setWindowRecords(missing.length > 0 ? await getHistoryRecords(missing) : []);
      setEvents(windowEvents);
      setEventsSince(firstEventAt);
      setNow(readAt);
      setDateKey(dailyMixDateKey());
    } catch (err) {
      // База может быть недоступна (приватный режим, занятая версия). Тогда
      // честнее сказать это, чем показывать скелетон до конца времён.
      console.warn('[ForYouView] Could not read the listening history:', err);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo<ListeningStats | null>(
    () =>
      records
        ? buildPeriodStats({
            period,
            records: windowRecords.length > 0 ? [...records, ...windowRecords] : records,
            events,
            now
          })
        : null,
    [records, windowRecords, events, period, now]
  );

  /**
   * Окно длиннее, чем есть событий: подпись должна это сказать.
   *
   * Раздел появился позже самой программы, и у тех, кто слушал раньше, «за
   * месяц» посчитано не за месяц. Молча показывать заниженную цифру нельзя —
   * человек решит, что слушал меньше, чем слушал.
   */
  const windowShortfall = useMemo<number | null>(() => {
    if (period === 'all' || eventsSince === null) return null;
    const start = statsPeriodStart(period, now);
    if (eventsSince <= start) return null;
    return Math.max(1, Math.round((now - eventsSince) / (24 * 60 * 60 * 1000)));
  }, [period, eventsSince, now]);

  const mixes = useMemo<DailyMix[]>(
    () =>
      records
        ? buildDailyMixes({ history: records, library: libraryTracks, favorites, dateKey })
        : [],
    [records, libraryTracks, favorites, dateKey]
  );

  const isLoading = records === null && !failed;
  /*
   * «Наслушано хоть что-то» и «в этом окне что-то есть» — разные вопросы, и
   * раньше их различать было незачем: окно было одно. Теперь пустая неделя не
   * повод убирать переключатель — иначе, промахнувшись мимо активной недели,
   * человек остался бы с надписью «итогов пока нет» и без способа вернуться.
   */
  const hasHistory = Boolean(records && records.length > 0);
  const hasPeriodData = Boolean(stats && stats.totalPlays > 0);

  const sectionTitle = (text: string): React.ReactNode => (
    <h2
      style={{
        margin: 0,
        fontSize: 'var(--text-lg)',
        lineHeight: 'var(--leading-lg)',
        letterSpacing: 'var(--tracking-lg)',
        fontWeight: 'var(--weight-semibold)',
        color: 'var(--text-primary)'
      }}
    >
      {text}
    </h2>
  );

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 'var(--space-4)'
      }}
    >
      <div>
        <h1
          style={{
            margin: 0,
            fontSize: 'var(--text-2xl)',
            lineHeight: 'var(--leading-2xl)',
            letterSpacing: 'var(--tracking-2xl)',
            color: 'var(--text-primary)'
          }}
        >
          Для вас
        </h1>
        <p
          style={{
            margin: 'var(--space-1) 0 0 0',
            fontSize: 'var(--text-sm)',
            lineHeight: 'var(--leading-sm)',
            color: 'var(--text-secondary)'
          }}
        >
          Миксы собираются из вашей же медиатеки и меняются раз в сутки. Итоги
          считаются здесь же, на устройстве — ничего никуда не отправляется.
        </p>
      </div>

      <Button
        variant="ghost"
        size="sm"
        icon={<RefreshCw size={ICON.md} aria-hidden="true" />}
        onClick={() => void load()}
        data-testid="foryou-refresh"
      >
        Обновить
      </Button>
    </div>
  );

  // Историю прочитать не вышло — тогда на экране только это, без пустых
  // разделов, которые выглядели бы как «у вас ничего не наслушано».
  if (failed) {
    return (
      <div
        className={`animate-view-in${className ? ` ${className}` : ''}`}
        style={SHELL}
        data-testid="foryou-view"
      >
        {header}
        <EmptyState
          icon={<BarChart3 size={ICON.display} />}
          title="Не удалось прочитать историю"
          description="Локальная база сейчас недоступна, а без неё ни миксы, ни итоги не собрать."
          action={
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Попробовать снова
            </Button>
          }
          data-testid="foryou-error"
        />
      </div>
    );
  }

  /*
   * Вход у экрана один и живёт на корне. Разделы внутри появляются своей чередой
   * (`animate-settle` на карточках), и второй общий кадр поверх них читался бы
   * как двойное движение. Ветка отказа выше получает тот же класс: это такой же
   * экран, и без него отказ подменял бы кадр без движения.
   */
  return (
    <div
      className={`animate-view-in${className ? ` ${className}` : ''}`}
      style={SHELL}
      data-testid="foryou-view"
    >
      {header}

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {sectionTitle('Миксы дня')}

        {isLoading ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 'var(--space-3)'
            }}
          >
            <Skeleton count={3} height={252} radius="var(--radius-md)" />
          </div>
        ) : mixes.length === 0 ? (
          <EmptyState
            icon={<Disc3 size={ICON.display} />}
            title="Миксы ещё не из чего собрать"
            description="Нужно немного больше музыки: сохраните треки хотя бы двух исполнителей, и подборки появятся сами."
            action={
              <Button variant="secondary" size="sm" onClick={() => setActiveView('search')}>
                Найти музыку
              </Button>
            }
            data-testid="foryou-mixes-empty"
          />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 'var(--space-3)'
            }}
            data-testid="foryou-mixes"
          >
            {mixes.map((mix, index) => (
              <DailyMixCard key={mix.id} mix={mix} index={index} />
            ))}
          </div>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            flexWrap: 'wrap'
          }}
        >
          {sectionTitle('Итоги прослушанного')}

          {!isLoading && hasHistory && stats && (
            <div
              role="group"
              aria-label="Период итогов"
              style={{ display: 'flex', gap: 'var(--space-1)' }}
              data-testid="stats-periods"
            >
              {STATS_PERIODS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="chip"
                  aria-pressed={period === id}
                  onClick={() => setPeriod(id)}
                  data-testid={`stats-period-${id}`}
                  style={{ fontSize: 'var(--text-xs)' }}
                >
                  {STATS_PERIOD_LABELS[id]}
                </button>
              ))}
            </div>
          )}
        </div>

        {isLoading ? (
          <Skeleton count={3} height={72} radius="var(--radius-sm)" />
        ) : !hasHistory || !stats ? (
          <EmptyState
            icon={<BarChart3 size={ICON.display} />}
            title="Итогов пока нет"
            description="Послушайте что-нибудь, и статистика соберётся сама."
            data-testid="foryou-stats-empty"
          />
        ) : !hasPeriodData ? (
          <EmptyState
            icon={<BarChart3 size={ICON.display} />}
            title={period === 'week' ? 'За неделю ничего' : 'За месяц ничего'}
            description={
              eventsSince === null
                ? 'Отдельные включения начали записываться только в этой сборке. Топ за неделю и месяц наберётся по мере прослушивания, а «Всё время» уже готово.'
                : 'В это окно ничего не попало. Загляните в «Всё время» — там всё наслушанное.'
            }
            action={
              <Button variant="secondary" size="sm" onClick={() => setPeriod('all')}>
                Показать всё время
              </Button>
            }
            data-testid="foryou-stats-period-empty"
          />
        ) : (
          <>
            {windowShortfall !== null && (
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-xs)',
                  lineHeight: 'var(--leading-xs)',
                  color: 'var(--text-muted)'
                }}
                data-testid="stats-period-shortfall"
              >
                Окно короче, чем кажется: отдельные включения записываются{' '}
                {pluralize(windowShortfall, 'день', 'дня', 'дней')}, и за более раннее в этом
                разделе ручаться нельзя. «Всё время» считается по счётчикам и знает всю историю.
              </p>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 'var(--space-3)'
              }}
            >
              {/*
                Череда безопасна: плиток ровно три и приходят они одним куском
                вместе с историей — догрузки, от которой задержка накопилась бы,
                здесь не бывает. Блика под курсором нет нарочно: плитки только
                читают, а блик обещал бы нажатие.
              */}
              {buildSummaryCards(stats, period).map((card, index) => (
                <div
                  key={card.testId}
                  className="card animate-settle"
                  style={{ padding: 'var(--space-4)', '--stagger': index } as React.CSSProperties}
                  data-testid={card.testId}
                >
                  <p className="section-label">{card.label}
                  </p>
                  <p
                    data-numeric
                    style={{
                      margin: 'var(--space-2) 0 0 0',
                      fontSize: 'var(--text-2xl)',
                      lineHeight: 'var(--leading-2xl)',
                      fontWeight: 'var(--weight-semibold)',
                      color: 'var(--text-primary)'
                    }}
                  >
                    {card.value}
                  </p>
                  <p
                    style={{
                      margin: '2px 0 0 0',
                      fontSize: 'var(--text-xs)',
                      lineHeight: 'var(--leading-xs)',
                      color: 'var(--text-secondary)'
                    }}
                  >
                    {card.hint}
                  </p>
                </div>
              ))}
            </div>

            {stats.sources.length > 0 && (
              <div
                className="panel-inset"
                style={{
                  padding: 'var(--space-3)',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-4)',
                  flexWrap: 'wrap'
                }}
                data-testid="stats-sources"
              >
                {stats.sources.map((source) => (
                  <div
                    key={source.source}
                    style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                  >
                    <SourceBadge source={source.source} />
                    <span
                      data-numeric
                      style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
                    >
                      {Math.round(source.share * 100)}%
                    </span>
                  </div>
                ))}
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-muted)',
                    marginLeft: 'auto'
                  }}
                >
                  Откуда играла музыка
                </span>
              </div>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: 'var(--space-4)'
              }}
            >
              <div>
                <h3
                  style={{
                    margin: '0 0 var(--space-2) 0',
                    fontSize: 'var(--text-sm)',
                    lineHeight: 'var(--leading-sm)',
                    fontWeight: 'var(--weight-semibold)',
                    color: 'var(--text-primary)'
                  }}
                >
                  {period === 'all' ? 'Чаще всего слушали' : 'Исполнители за это время'}
                </h3>
                <ol
                  style={{ margin: 0, padding: 0, listStyle: 'none' }}
                  data-testid="stats-top-artists"
                >
                  {stats.topArtists.map((artist, index) => (
                    <li
                      key={artist.artist}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 'var(--space-2)',
                        padding: 'var(--space-2) 0',
                        borderBottom: '1px solid var(--border-subtle)'
                      }}
                      data-testid={`stats-artist-${index}`}
                    >
                      <span
                        data-numeric
                        style={{ width: '1.5em', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}
                      >
                        {index + 1}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 'var(--text-sm)',
                          color: 'var(--text-primary)'
                        }}
                      >
                        {artist.artist}
                      </span>
                      <span
                        data-numeric
                        style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}
                      >
                        {pluralize(artist.plays, 'раз', 'раза', 'раз')}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              <div>
                <h3
                  style={{
                    margin: '0 0 var(--space-2) 0',
                    fontSize: 'var(--text-sm)',
                    lineHeight: 'var(--leading-sm)',
                    fontWeight: 'var(--weight-semibold)',
                    color: 'var(--text-primary)'
                  }}
                >
                  {period === 'all' ? 'Любимые треки' : 'Треки за это время'}
                </h3>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
                  data-testid="stats-top-tracks"
                >
                  {stats.topTracks.map((entry, index) => (
                    <div
                      key={entry.track.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                      data-testid={`stats-track-${index}`}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <TrackCard
                          track={entry.track}
                          index={index}
                          layout="row"
                          contextQueue={stats.topTracks.map((item) => item.track)}
                        />
                      </div>
                      <span
                        data-numeric
                        style={{
                          fontSize: 'var(--text-xs)',
                          color: 'var(--text-secondary)',
                          whiteSpace: 'nowrap'
                        }}
                        title="Сколько раз включали"
                      >
                        <Music2
                          size={ICON.xs}
                          aria-hidden="true"
                          style={{ verticalAlign: '-1px', marginRight: '4px' }}
                        />
                        {entry.plays}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {(stats.completed > 0 || stats.skipped > 0) && (
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-xs)',
                  lineHeight: 'var(--leading-xs)',
                  color: 'var(--text-muted)'
                }}
                data-testid="stats-completion"
              >
                Дослушано до конца: {stats.completed} · пропущено: {stats.skipped}. Считается только
                с того момента, как в сборке появился этот счётчик, — за более раннее ручаться нельзя.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
};

export default ForYouView;
