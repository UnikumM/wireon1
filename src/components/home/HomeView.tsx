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
      <section data-home-block="hero" className="home-hero" data-testid="home-hero">
        <WaveCard
          favorites={favorites.length}
          onStart={() => {
            setActiveView('wave');
            void startMyWave();
          }}
        />

        <div className="resume-card" data-testid="home-resume">
          <div className="resume-card-art" data-testid="home-hero-art">
            {heroTrack?.artworkUrl && !heroArtFailed ? (
              <img src={heroTrack.artworkUrl} alt="" onError={() => setHeroArtFailed(true)} className="fill-cover" />
            ) : (
              // Без обложки квадрат был пустым и читался как недогруженный.
              <Music2 size={ICON.xl} aria-hidden="true" className="text-faint" />
            )}
          </div>

          <div className="stack grow gap-1 min-0">
            <div className="home-eyebrow">{heroKicker}</div>
            <h3 className="m-0 text-truncate type-lg weight-semibold text-primary font-sans" data-testid="home-hero-title">
              {heroTrack?.title ?? 'Wireon'}
            </h3>
            <div className="text-truncate type-sm text-secondary">{heroSubtitle}</div>
            {resumeProgress !== null && (
              <div className="resume-card-bar" aria-hidden="true">
                <span style={{ width: `${resumeProgress}%` }} />
              </div>
            )}
          </div>

          <div className="row gap-2 shrink-0 resume-card-actions">
            <button
              type="button"
              className="focus-ring press home-btn home-btn-primary"
              onClick={() => {
                if (!heroTrack) return;
                // Трек с прошлого запуска уже стоит в плеере на паузе: ему нужен
                // именно `play`, иначе он начался бы сначала.
                if (currentTrack && heroTrack.id === currentTrack.id) void play();
                else void playTrack(heroTrack);
              }}
              disabled={!heroTrack}
              data-testid="home-hero-play"
            >
              <Play size={ICON.sm} fill="currentColor" aria-hidden="true" />
              {resumePosition && resumePosition > 1 ? 'Продолжить' : 'Слушать'}
            </button>
            <button
              type="button"
              className="focus-ring press home-btn"
              onClick={() => heroTrack && void startTrackRadio(heroTrack)}
              disabled={!heroTrack}
              aria-label="Радио по треку"
              title="Радио по треку"
              data-testid="home-hero-radio"
            >
              <Radio size={ICON.sm} aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>

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

/** Время суток — для подписи Волны. Границы грубые нарочно: это настроение, а не расписание. */
function dayPart(hour: number): { eyebrow: string; title: string; note: string } {
  if (hour >= 5 && hour < 12) return { eyebrow: 'Волна · утро', title: 'Разогнаться мягко', note: 'Знакомое и светлое, чтобы день начался без рывка.' };
  if (hour >= 12 && hour < 18) return { eyebrow: 'Волна · день', title: 'В ритме дня', note: 'Поток из того, что вы любите, и того, что рядом с ним.' };
  if (hour >= 18 && hour < 23) return { eyebrow: 'Волна · вечер', title: 'Потише, поглубже', note: 'Медленнее, чем днём, с тем, что вы слушали в последние недели.' };
  return { eyebrow: 'Волна · ночь', title: 'Ночная смена', note: 'Тихое и длинное — для часов, когда никто не торопит.' };
}

function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

interface WaveCardProps {
  favorites: number;
  onStart: () => void;
}

/**
 * Волна — главное действие на главной.
 *
 * Карточка, а не строка в ряду: бесконечный поток — это то, ради чего человек
 * открывает приложение, не зная, что хочет слушать. Подпись меняется со временем
 * суток, чтобы карточка читалась живой, а не вывеской.
 */
const WaveCard: React.FC<WaveCardProps> = ({ favorites, onStart }) => {
  const part = dayPart(new Date().getHours());
  return (
    <button type="button" className="wave-card focus-ring" onClick={onStart} data-testid="home-card-wave" aria-label={`Включить Волну: ${part.title}`}>
      <span className="wave-orb" aria-hidden="true" />
      <span className="home-eyebrow">{part.eyebrow}</span>
      <span className="wave-card-title">{part.title}</span>
      <span className="wave-card-note">
        {part.note}
        {favorites > 0 ? ` Опирается на ${favorites} ${plural(favorites, ['любимый трек', 'любимых трека', 'любимых треков'])}.` : ''}
      </span>
      <span className="wave-card-play" aria-hidden="true">
        <Play size={ICON.md} fill="currentColor" />
      </span>
    </button>
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
