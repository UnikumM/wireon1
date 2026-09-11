import React, { useEffect, useMemo, useState } from 'react';
import { Play, Radio } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { getHistory, HistoryRecord } from '../../services/db';
import { buildDailyMixes, dailyMixDateKey, DailyMix } from '../../services/dailyMixes';
import { SearchCollection, UnifiedTrack } from '../../types/music';
import { checkNewReleases, NewRelease } from '../../services/subscriptions';
import { DiscoverShelf, getCharts, getNewReleases } from '../../services/discover';
import { ICON } from '../../styles/icons';
import { formatDuration } from '../../utils/time';

/**
 * Главная страница.
 *
 * Витринная композиция: наверху одна крупная вещь — то, на чём человек
 * остановился, — а под ней подборки рядами. Так решил владелец, выбрав
 * направление из трёх макетов: смысл в том, что запуск приложения должен
 * продолжать вчерашний вечер, а не показывать список разделов.
 *
 * Данные берутся у тех же служб, что и раньше: история из медиатеки, миксы из
 * `dailyMixes`, волна и радио — из плеера. Ничего нового здесь не считается.
 */

/** Столько записей истории хватает и на «продолжить», и на миксы. */
const HISTORY_DEPTH = 500;

const HERO_ART = 300;

export const HomeView: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const resumePosition = usePlayerStore((s) => s.resumePosition);
  const play = usePlayerStore((s) => s.play);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const startMyWave = usePlayerStore((s) => s.startMyWave);
  const startTrackRadio = usePlayerStore((s) => s.startTrackRadio);

  const history = useLibraryStore((s) => s.history);
  const favorites = useLibraryStore((s) => s.favorites);
  const playlists = useLibraryStore((s) => s.playlists);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const openCollection = useUIStore((s) => s.openCollection);

  const [records, setRecords] = useState<HistoryRecord[] | null>(null);
  const [releases, setReleases] = useState<NewRelease[]>([]);
  const [shelves, setShelves] = useState<DiscoverShelf[]>([]);

  useEffect(() => {
    let alive = true;
    void getHistory(HISTORY_DEPTH)
      .then((rows) => {
        if (alive) setRecords(rows);
      })
      .catch(() => {
        if (alive) setRecords([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  /*
   * Новинки у подписок и полки площадки.
   *
   * Здесь, а не по расписанию в фоне: обход ходит в сеть, и будить её ради
   * списка, на который никто сейчас не смотрит, незачем. Оба запроса
   * необязательные — главная обязана дорисоваться и без них.
   */
  useEffect(() => {
    let alive = true;

    void checkNewReleases()
      .then((found) => {
        if (alive) setReleases(found);
      })
      .catch(() => undefined);

    void Promise.all([getNewReleases(), getCharts()])
      .then(([fresh, charts]) => {
        // По одной полке от каждой страницы: главная — витрина, а не каталог.
        if (alive) setShelves([...fresh.slice(0, 1), ...charts.slice(0, 1)]);
      })
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, []);

  /** Герой — то, что играет сейчас, иначе последнее из истории. */
  const heroTrack: UnifiedTrack | null = currentTrack ?? history[0] ?? null;

  const libraryTracks = useMemo<UnifiedTrack[]>(
    () => playlists.flatMap((playlist) => playlist.tracks ?? []),
    [playlists]
  );

  const mixes = useMemo<DailyMix[]>(
    () =>
      records
        ? buildDailyMixes({
            history: records,
            library: libraryTracks,
            favorites,
            dateKey: dailyMixDateKey()
          })
        : [],
    [records, libraryTracks, favorites]
  );

  const heroSubtitle = heroTrack
    ? [heroTrack.artist, heroTrack.album].filter(Boolean).join(' · ')
    : 'Здесь появится то, на чём вы остановитесь';

  const heroKicker =
    resumePosition && resumePosition > 1
      ? `Остановились на ${formatDuration(resumePosition)}`
      : currentTrack
        ? 'Сейчас играет'
        : 'Начните слушать';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }} data-testid="home-view">
      {/* --- Герой: продолжить слушать ------------------------------------ */}
      <section style={{ display: 'flex', gap: 'var(--space-7)', alignItems: 'stretch' }}>
        <div
          style={{
            width: HERO_ART,
            height: HERO_ART,
            borderRadius: 'var(--radius-xl)',
            flexShrink: 0,
            overflow: 'hidden',
            background: 'var(--surface-2)',
            boxShadow: 'var(--shadow-lg)'
          }}
        >
          {heroTrack?.artworkUrl && (
            <img
              src={heroTrack.artworkUrl}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          )}
        </div>

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 'var(--space-4)'
          }}
        >
          <div
            style={{
              fontSize: 'var(--text-xs)',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--info)',
              fontWeight: 'var(--weight-semibold)'
            }}
          >
            {heroKicker}
          </div>

          <h1
            style={{
              margin: 0,
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--text-4xl)',
              lineHeight: 'var(--leading-4xl)',
              letterSpacing: 'var(--tracking-4xl)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)',
              overflowWrap: 'anywhere'
            }}
            data-testid="home-hero-title"
          >
            {heroTrack?.title ?? 'Wireon'}
          </h1>

          <div style={{ fontSize: 'var(--text-xl)', color: 'var(--text-secondary)' }}>{heroSubtitle}</div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
            <button
              type="button"
              className="focus-ring"
              onClick={() => {
                if (!heroTrack) return;
                // Трек с прошлого запуска уже стоит в плеере на паузе: ему нужен
                // именно `play`, иначе он начался бы сначала.
                if (currentTrack && heroTrack.id === currentTrack.id) void play();
                else void playTrack(heroTrack);
              }}
              disabled={!heroTrack}
              data-testid="home-hero-play"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                padding: '14px 28px',
                borderRadius: 'var(--radius-pill)',
                border: 'none',
                background: 'var(--text-primary)',
                color: 'var(--bg-base)',
                fontSize: 'var(--text-base)',
                fontWeight: 'var(--weight-semibold)',
                cursor: heroTrack ? 'pointer' : 'default',
                opacity: heroTrack ? 1 : 0.5
              }}
            >
              <Play size={ICON.sm} fill="currentColor" />
              {resumePosition && resumePosition > 1 ? 'Продолжить' : 'Слушать'}
            </button>

            <button
              type="button"
              className="focus-ring"
              onClick={() => heroTrack && void startTrackRadio(heroTrack)}
              disabled={!heroTrack}
              data-testid="home-hero-radio"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                padding: '14px 24px',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--border-strong)',
                background: 'transparent',
                color: 'var(--text-primary)',
                fontSize: 'var(--text-base)',
                fontWeight: 'var(--weight-medium)',
                cursor: heroTrack ? 'pointer' : 'default',
                opacity: heroTrack ? 1 : 0.5
              }}
            >
              <Radio size={ICON.sm} />
              Радио по треку
            </button>
          </div>
        </div>
      </section>

      {/* --- Собрано для тебя --------------------------------------------- */}
      <Shelf title="Собрано для тебя" note="обновляется каждый день" testId="home-daily">
          <ShowcaseCard
            title="Моя волна"
            subtitle="бесконечный подбор"
            testId="home-card-wave"
            onClick={() => {
              setActiveView('wave');
              void startMyWave();
            }}
          />

          {mixes.map((mix) => (
            <ShowcaseCard
              key={mix.id}
              title={mix.title}
              subtitle={mix.subtitle}
              artworkUrl={mix.artworkUrl}
              testId={`home-card-${mix.id}`}
              onClick={() => {
                if (mix.tracks.length > 0) void playTrack(mix.tracks[0], mix.tracks, 0);
              }}
            />
          ))}
      </Shelf>

      {/* --- Новое у исполнителей ------------------------------------------ */}
      {releases.length > 0 && (
        <Shelf title="Новое у исполнителей" note="у тех, на кого вы подписаны" testId="home-releases">
          {releases.slice(0, 8).map(({ artist, album }) => (
            <ShowcaseCard
              key={`${artist}_${album.browseId || album.id}`}
              title={album.title}
              subtitle={artist}
              artworkUrl={album.coverUrl}
              testId={`home-release-${album.browseId || album.id}`}
              onClick={() =>
                openCollection({
                  id: `ytc_${album.browseId || album.id}`,
                  kind: 'album',
                  source: 'youtube',
                  ref: album.browseId || album.id,
                  title: album.title,
                  subtitle: [artist, album.year].filter(Boolean).join(' • '),
                  artworkUrl: album.coverUrl || ''
                })
              }
            />
          ))}
        </Shelf>
      )}

      {/* --- Чарты и новинки площадки --------------------------------------- */}
      {shelves.map((shelf) => (
        <Shelf key={shelf.title} title={shelf.title} testId={`home-shelf-${shelf.title}`}>
          {shelf.items.slice(0, 8).map((item: SearchCollection) => (
            <ShowcaseCard
              key={item.id}
              title={item.title}
              subtitle={item.subtitle || ''}
              artworkUrl={item.artworkUrl}
              testId={`home-shelf-item-${item.id}`}
              onClick={() => openCollection(item)}
            />
          ))}
        </Shelf>
      ))}
    </div>
  );
};

interface ShelfProps {
  title: string;
  note?: string;
  testId: string;
  children: React.ReactNode;
}

/**
 * Ряд витрины: заголовок и карточки под ним.
 *
 * Заголовок ряда повторялся в разметке трижды одним и тем же блоком — вынесен,
 * чтобы четвёртый ряд не стал четвёртой копией.
 */
const Shelf: React.FC<ShelfProps> = ({ title, note, testId, children }) => (
  <section
    style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
    data-testid={testId}
  >
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-4)' }}>
      <h2
        style={{
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontSize: 'var(--text-2xl)',
          fontWeight: 'var(--weight-medium)',
          letterSpacing: '-0.02em',
          color: 'var(--text-primary)'
        }}
      >
        {title}
      </h2>
      {note && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>{note}</span>}
    </div>

    {/*
      * Число колонок задаёт ширина, а не константа.
      *
      * Было ровно четыре — и пока слева стояла панель, это давало карточку
      * примерно в 240 px. Без панели те же четыре колонки растянулись на всю
      * ширину окна, и обложка микса дня выходила с ладонь. Витрина — это
      * крупно, но не «одна карточка на четверть экрана».
      */}
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: 'var(--space-5)'
      }}
    >
      {children}
    </div>
  </section>
);

interface ShowcaseCardProps {
  title: string;
  subtitle: string;
  artworkUrl?: string;
  testId: string;
  onClick: () => void;
}

/** Крупная карточка витрины: обложка, под ней две строки. */
const ShowcaseCard: React.FC<ShowcaseCardProps> = ({ title, subtitle, artworkUrl, testId, onClick }) => (
  <button
    type="button"
    className="focus-ring"
    onClick={onClick}
    data-testid={testId}
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-3)',
      padding: 0,
      border: 'none',
      background: 'transparent',
      textAlign: 'left',
      cursor: 'pointer'
    }}
  >
    <div
      style={{
        aspectRatio: '1',
        width: '100%',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        background: 'var(--surface-2)',
        boxShadow: 'var(--shadow-md)'
      }}
    >
      {artworkUrl && (
        <img src={artworkUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      )}
    </div>
    <div>
      <div
        style={{
          fontSize: 'var(--text-lg)',
          fontWeight: 'var(--weight-semibold)',
          color: 'var(--text-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 'var(--text-sm)',
          color: 'var(--text-muted)',
          marginTop: 'var(--space-1)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {subtitle}
      </div>
    </div>
  </button>
);

export default HomeView;
