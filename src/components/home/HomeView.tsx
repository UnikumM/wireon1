import React, { useEffect, useMemo, useState } from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { getHistory, HistoryRecord } from '../../services/db';
import { buildDailyMixes, dailyMixDateKey, DailyMix } from '../../services/dailyMixes';
import { SearchCollection, UnifiedTrack } from '../../types/music';
import { checkNewReleases, NewRelease } from '../../services/subscriptions';
import { DiscoverShelf, getCharts, getNewReleases } from '../../services/discover';
import { CoverCard } from '../common/CoverCard';
import { formatDuration } from '../../utils/time';
import { HomeLayout } from './HomeLayout';
import { HandoffBanner, ResumeCard, WaveCard } from './HeroCards';
import { HomeBlockId } from '../../store/useAppLayoutStore';
import { useAutoMixes } from '../../hooks/useAutoMixes';
import { MonthlyRecapCard } from '../recap/MonthlyRecapCard';
import { useHomeMonthlyRecap } from '../recap/useMonthlyRecap';

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
/** Полгода без прослушивания — трек «забыт». */
export const FORGOTTEN_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

export const HomeView: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const resumePosition = usePlayerStore((s) => s.resumePosition);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
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
  // Итоги прошлого месяца — первые семь дней нового, пока не закрыли.
  const monthlyRecap = useHomeMonthlyRecap();
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

  // Недавнее — без повторов и без того, что уже в герое: ряд показывает, куда
  // вернуться, а не то, что и так на экране.
  const recent = useMemo<UnifiedTrack[]>(() => {
    const seen = new Set<string>();
    const rows: UnifiedTrack[] = [];
    for (const track of history) {
      if (seen.has(track.id) || track.id === currentTrack?.id) continue;
      seen.add(track.id);
      rows.push(track);
      if (rows.length >= 8) break;
    }
    return rows;
  }, [history, currentTrack?.id]);

  /*
   * «Забытое»: любимые треки, которые давно не включали. Срок — полгода: за
   * меньший список пестрит тем, что просто не попалось под руку, за больший —
   * пустеет у всех, кто пользуется приложением меньше года. Порядок — от самого
   * давнего: то, что забыли сильнее всего, первым.
   */
  const forgotten = useMemo<UnifiedTrack[]>(() => {
    if (!records || favorites.length === 0) return [];
    const lastPlayed = new Map(records.map((record) => [record.id, record.playedAt]));
    const threshold = Date.now() - FORGOTTEN_AFTER_MS;
    return favorites
      .map((track) => ({ track, at: lastPlayed.get(track.id) ?? 0 }))
      .filter(({ at }) => at > 0 && at < threshold)
      .sort((a, b) => a.at - b.at)
      .slice(0, 8)
      .map(({ track }) => track);
  }, [records, favorites]);

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

  // Доля прослушанного — для полоски в карточке «продолжить». Нужны и позиция,
  // и длительность трека; без длительности полоска обещала бы то, чего не знает.
  const resumeProgress =
    heroTrack && resumePosition && resumePosition > 1 && heroTrack.duration > 0
      ? Math.min(100, Math.round((resumePosition / heroTrack.duration) * 100))
      : null;

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
      {/* --- Герой: Волна и «продолжить» ---------------------------------- */}
      <HandoffBanner />
      <section data-home-block="hero" className="home-hero" data-testid="home-hero">
        <WaveCard
          favorites={favorites.length}
          onStart={() => {
            setActiveView('wave');
            void startMyWave();
          }}
        />

        <ResumeCard
          track={heroTrack}
          kicker={heroKicker}
          subtitle={heroSubtitle}
          progress={resumeProgress}
          playLabel={resumePosition && resumePosition > 1 ? 'Продолжить' : 'Слушать'}
          onPlay={() => {
            if (!heroTrack) return;
            // Трек с прошлого запуска уже стоит в плеере на паузе: ему нужен
            // именно `play`, иначе он начался бы сначала.
            if (currentTrack && heroTrack.id === currentTrack.id) void play();
            else void playTrack(heroTrack);
          }}
          onRadio={() => heroTrack && void startTrackRadio(heroTrack)}
        />
      </section>

      {/* --- Итоги месяца: первые дни нового месяца ------------------------ */}
      {monthlyRecap && (
        <MonthlyRecapCard
          homeBlock="monthlyRecap"
          recap={monthlyRecap.recap}
          onDismiss={monthlyRecap.dismiss}
          testId="home-monthly-recap"
        />
      )}

      {/* --- Собрано для тебя --------------------------------------------- */}
      {recent.length > 0 && (
        <Shelf title="Недавно слушали" testId="home-recent" homeBlock="recent">
          {recent.map((track) => (
            <CoverCard
              key={track.id}
              title={track.title}
              subtitle={track.artist}
              artworkUrl={track.artworkUrl}
              testId={`home-recent-${track.id}`}
              onClick={() => void playTrack(track, recent, recent.indexOf(track))}
            />
          ))}
        </Shelf>
      )}

      {(autoMixes.length > 0 || mixes.length > 0) && (
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
      )}

      {forgotten.length > 0 && (
        <Shelf title="Забытое" note="любили, но давно не включали" testId="home-forgotten" homeBlock="forgotten">
          {forgotten.map((track) => (
            <CoverCard
              key={track.id}
              title={track.title}
              subtitle={track.artist}
              artworkUrl={track.artworkUrl}
              testId={`home-forgotten-${track.id}`}
              onClick={() => void playTrack(track, forgotten, forgotten.indexOf(track))}
            />
          ))}
        </Shelf>
      )}

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
      <h2 className="m-0 text-primary type-2xl">
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
