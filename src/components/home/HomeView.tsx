import React, { useEffect, useMemo, useState } from 'react';
import { Music2, Play, Radio } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { getHistory, HistoryRecord } from '../../services/db';
import { buildDailyMixes, dailyMixDateKey, DailyMix } from '../../services/dailyMixes';
import { SearchCollection, UnifiedTrack } from '../../types/music';
import { checkNewReleases, NewRelease } from '../../services/subscriptions';
import { DiscoverShelf, getCharts, getNewReleases } from '../../services/discover';
import { ICON } from '../../styles/icons';
import { CoverCard } from '../common/CoverCard';
import { formatDuration } from '../../utils/time';
import { HomeLayout } from './HomeLayout';
import { HomeBlockId } from '../../store/useAppLayoutStore';
import { useAutoMixes } from '../../hooks/useAutoMixes';

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
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const [heroArtFailed, setHeroArtFailed] = useState(false);
  useEffect(() => setHeroArtFailed(false), [currentTrack?.artworkUrl]);
  const play = usePlayerStore((s) => s.play);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const startMyWave = usePlayerStore((s) => s.startMyWave);
  const startTrackRadio = usePlayerStore((s) => s.startTrackRadio);

  const history = useLibraryStore((s) => s.history);
  const favorites = useLibraryStore((s) => s.favorites);
  const playlists = useLibraryStore((s) => s.playlists);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const openCollection = useUIStore((s) => s.openCollection);

  const autoMixes = useAutoMixes();
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
        ? isPlaying
          ? 'Сейчас играет'
          : 'На паузе'
        : 'Начните слушать';

  return (
    <HomeLayout platform="desktop" testId="home-view">
      {/* --- Герой: продолжить слушать ------------------------------------ */}
      <section data-home-block="hero" className="row-stretch items-stretch gap-7">
        <div
          className="shrink-0 overflow-hidden row justify-center bg-surface-2" style={{ width: HERO_ART, height: HERO_ART, borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)' }}
          data-testid="home-hero-art"
        >
          {heroTrack?.artworkUrl && !heroArtFailed ? (
            <img
              src={heroTrack.artworkUrl}
              alt=""
              onError={() => setHeroArtFailed(true)}
              className="fill-cover"
            />
          ) : (
            // Без обложки квадрат был пустым и читался как недогруженный.
            <Music2 size={ICON.display} aria-hidden="true" className="text-faint" />
          )}
        </div>

        <div
          className="grow stack justify-center gap-4"
        >
          <div
            className="text-xs weight-semibold" style={{ letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--info)' }}
          >
            {heroKicker}
          </div>

          <h1
            className="m-0 weight-semibold text-primary" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-4xl)', lineHeight: 'var(--leading-4xl)', letterSpacing: 'var(--tracking-4xl)', overflowWrap: 'anywhere' }}
            data-testid="home-hero-title"
          >
            {heroTrack?.title ?? 'Wireon'}
          </h1>

          <div className="text-xl text-secondary">{heroSubtitle}</div>

          <div className="row gap-3 mt-2">
            <button
              type="button"
              className="focus-ring row gap-2 text-base weight-semibold border-none"
              onClick={() => {
                if (!heroTrack) return;
                // Трек с прошлого запуска уже стоит в плеере на паузе: ему нужен
                // именно `play`, иначе он начался бы сначала.
                if (currentTrack && heroTrack.id === currentTrack.id) void play();
                else void playTrack(heroTrack);
              }}
              disabled={!heroTrack}
              data-testid="home-hero-play"
              style={{ padding: '14px 28px', borderRadius: 'var(--radius-pill)', background: 'var(--text-primary)', color: 'var(--bg-base)', cursor: heroTrack ? 'pointer' : 'default', opacity: heroTrack ? 1 : 0.5 }}
            >
              <Play size={ICON.sm} fill="currentColor" />
              {resumePosition && resumePosition > 1 ? 'Продолжить' : 'Слушать'}
            </button>

            <button
              type="button"
              className="focus-ring row gap-2 text-primary text-base weight-medium border-strong bg-transparent"
              onClick={() => heroTrack && void startTrackRadio(heroTrack)}
              disabled={!heroTrack}
              data-testid="home-hero-radio"
              style={{ padding: '14px 24px', borderRadius: 'var(--radius-pill)', cursor: heroTrack ? 'pointer' : 'default', opacity: heroTrack ? 1 : 0.5 }}
            >
              <Radio size={ICON.sm} />
              Радио по треку
            </button>
          </div>
        </div>
      </section>

      {/* --- Собрано для тебя --------------------------------------------- */}
      <Shelf title="Поток" testId="home-wave" homeBlock="wave">
          <CoverCard
            title="Поток"
            subtitle="бесконечный подбор"
            fallbackIcon={<Radio size={ICON.display} />}
            testId="home-card-wave"
            onClick={() => {
              setActiveView('wave');
              void startMyWave();
            }}
          />

      </Shelf>
      <Shelf title="Собрано для тебя" note="обновляется каждый день" testId="home-daily" homeBlock="mixes">
          {/* Живые подборки — первыми: «Под это время» меняется вместе с днём. */}
          {autoMixes.map((mix) => (
            <CoverCard
              key={mix.id}
              title={mix.title}
              subtitle={mix.subtitle}
              artworkUrl={mix.artworkUrl}
              testId={`home-card-${mix.kind}`}
              onClick={() => {
                if (mix.tracks.length > 0) void playTrack(mix.tracks[0], mix.tracks, 0);
              }}
            />
          ))}
          {mixes.map((mix) => (
            <CoverCard
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
        <Shelf title="Новое у исполнителей" note="у тех, на кого вы подписаны" testId="home-releases" homeBlock="releases">
          {releases.slice(0, 8).map(({ artist, album }) => (
            <CoverCard
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
        <Shelf key={shelf.title} title={shelf.title} testId={`home-shelf-${shelf.title}`} homeBlock="discover">
          {shelf.items.slice(0, 8).map((item: SearchCollection) => (
            <CoverCard
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
    </HomeLayout>
  );
};

interface ShelfProps {
  homeBlock?: HomeBlockId;
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
    className="stack gap-5"
    data-testid={testId}
  >
    <div className="row-stretch items-baseline gap-4">
      <h2
        className="m-0 weight-medium text-primary text-2xl" style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
      >
        {title}
      </h2>
      {note && <span className="text-sm text-faint">{note}</span>}
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
      className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
    >
      {children}
    </div>
  </section>
);

export default HomeView;
