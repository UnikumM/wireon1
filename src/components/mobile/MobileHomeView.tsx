import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, ChevronRight, Music2, Settings } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { getHistory, HistoryRecord } from '../../services/db';
import { buildDailyMixes, dailyMixDateKey, DailyMix } from '../../services/dailyMixes';
import { useAutoMixes } from '../../hooks/useAutoMixes';
import { normalizeArtist } from '../../services/recommendationEngine';
import { ICON } from '../../styles/icons';
import type { UnifiedTrack } from '../../types/music';
import { HomeLayout } from '../home/HomeLayout';
import { ResumeCard, WaveCard } from '../home/HeroCards';

/**
 * Главная — то, что человек видит, открыв приложение.
 *
 * Раньше здесь был **поиск**: пустое поле, семь жанровых плашек в три рваных
 * ряда и пятьсот пикселей пустоты под ними. Тому, кто просто хочет включить
 * музыку, предлагали сначала придумать, что искать. При этом экран «Для вас» с
 * миксами дня в приложении уже был — но с телефона до него было не добраться
 * вовсе: в нижнюю панель он не попал, а боковая на узком экране скрыта.
 *
 * Порядок полок выбран владельцем: продолжить слушать, запустить Поток, миксы
 * дня, радио по исполнителям. Первым идёт самое частое действие — вернуться к
 * тому, что уже слушал.
 */

/** Сколько недавних треков показывать сеткой. Ровно два столбца по три ряда. */
const RECENT_TILES = 6;

/** Сколько исполнителей предлагать для радио. */
const ARTIST_SHELF_LIMIT = 8;

export const MobileHomeView: React.FC = () => {
  const playTrack = usePlayerStore((s) => s.playTrack);
  const play = usePlayerStore((s) => s.play);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const resumePosition = usePlayerStore((s) => s.resumePosition);
  const startTrackRadio = usePlayerStore((s) => s.startTrackRadio);
  const favorites = useLibraryStore((s) => s.favorites);
  const playlists = useLibraryStore((s) => s.playlists);
  const history = useLibraryStore((s) => s.history);
  const setActiveView = useUIStore((s) => s.setActiveView);

  const autoMixes = useAutoMixes();
  const [records, setRecords] = useState<HistoryRecord[] | null>(null);

  useEffect(() => {
    let alive = true;
    // Отказ базы не должен обнулять экран: полки, которым история не нужна,
    // обязаны остаться на месте.
    getHistory(200)
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

  const libraryTracks = useMemo(
    () => playlists.flatMap((playlist) => playlist.tracks || []),
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
    [favorites, libraryTracks, records]
  );

  const recent = useMemo(() => history.slice(0, RECENT_TILES), [history]);

  /** Исполнители, которых включали чаще прочих, — по одному треку на имя. */
  const topArtists = useMemo(() => {
    const seen = new Map<string, UnifiedTrack>();
    for (const track of history) {
      const key = normalizeArtist(track.artist);
      if (!key || seen.has(key)) continue;
      seen.set(key, track);
      if (seen.size >= ARTIST_SHELF_LIMIT) break;
    }
    return [...seen.values()];
  }, [history]);

  /**
   * Герой — то, что играет сейчас, иначе последнее из истории.
   *
   * Тот же приём, что на большом экране: самое крупное на странице — сама
   * музыка, а не слово «Wireon». Витринное направление на телефоне держится
   * именно на этом: обложка во всю ширину и название под ней.
   */
  const heroTrack: UnifiedTrack | null = currentTrack ?? history[0] ?? null;

  const resumeProgress =
    heroTrack && resumePosition && resumePosition > 1 && heroTrack.duration > 0
      ? Math.min(100, Math.round((resumePosition / heroTrack.duration) * 100))
      : null;

  const heroKicker = resumePosition
    ? 'Продолжить'
    : currentTrack
      ? isPlaying
        ? 'Сейчас играет'
        : 'На паузе'
      : 'Начните слушать';

  const handleHeroPlay = useCallback(() => {
    if (!heroTrack) return;
    // Трек с прошлого запуска уже стоит в плеере на паузе: ему нужен именно
    // `play`, иначе он начался бы сначала.
    if (currentTrack && heroTrack.id === currentTrack.id) void play();
    else void playTrack(heroTrack);
  }, [currentTrack, heroTrack, play, playTrack]);

  const handleStartWave = useCallback(() => {
    setActiveView('wave');
  }, [setActiveView]);

  const handleArtistRadio = useCallback(
    (track: UnifiedTrack) => {
      void usePlayerStore.getState().startTrackRadio(track);
    },
    []
  );

  return (
    <HomeLayout
      platform="mobile"
      testId="mobile-home"
      /*
       * Настройки — в одном ряду с «Настроить главную». Отдельной строкой под
       * ним шестерёнка оставляла над героем пустую полосу во всю ширину.
       */
      toolsAside={
          <button
            type="button"
            className="press focus-ring row justify-center shrink-0 text-secondary pointer"
            onClick={() => setActiveView('settings')}
            aria-label="Настройки"
            style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-pill)' }}
            data-testid="mobile-home-settings"
          >
            <Settings size={ICON.lg} aria-hidden="true" />
          </button>
      }
    >

      {/* --- Герой: то, на чём остановились — общая карточка с ПК --------- */}
      <section className="stack gap-3" data-testid="mobile-home-hero" data-home-block="hero">
        <ResumeCard
          track={heroTrack}
          kicker={heroKicker}
          subtitle={heroTrack?.artist ?? 'Здесь появится то, на чём вы остановитесь'}
          progress={resumeProgress}
          playLabel={resumePosition ? 'Продолжить' : 'Слушать'}
          onPlay={handleHeroPlay}
          onRadio={() => heroTrack && void startTrackRadio(heroTrack)}
          testIds={{ root: 'mobile-home-resume', art: 'mobile-home-hero-art', title: 'mobile-home-hero-title', play: 'mobile-home-hero-play', radio: 'mobile-home-hero-radio' }}
        />
      </section>

      {recent.length > 0 && (
        <section data-testid="mobile-home-recent" data-home-block="recent">
          <SectionTitle>Продолжить слушать</SectionTitle>
          {/*
            * Сетка два на три с обложкой 64 — приём, которым телефонные плееры
            * открывают главный экран. Самое частое действие оказывается в один
            * палец и без прокрутки.
            */}
          <div
            className="grid gap-2" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
          >
            {recent.map((track) => (
              <button
                key={track.id}
                type="button"
                className="press card-interactive row gap-2 min-0 radius-sm overflow-hidden text-left pointer"
                onClick={() => void playTrack(track, history, history.indexOf(track))}
                style={{ height: '64px' }}
                data-testid={`mobile-home-recent-${track.id}`}
              >
                <Artwork track={track} artSize={64} radius="0" />
                {/*
                  * Две строки, а не одна: на 360 px плитке достаётся 160, из них
                  * 64 забирает обложка — в одну строку названия обрывались на
                  * седьмом символе («Ghosts o…»). Обрезка по второй строке
                  * оставляет достаточно, чтобы трек узнать.
                  */}
                <span
                  className="text-clamp-2"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    paddingRight: 'var(--space-2)',
                    /*
                     * `break-word`, а не `anywhere`. Оба спасают от слова,
                     * которое шире плитки, но `anywhere` рвёт по первому
                     * удобному месту — «Спокойно / й ночи». `break-word` ломает
                     * слово, только если оно не помещается в строку целиком.
                     */
                    overflowWrap: 'break-word',
                    fontSize: 'var(--text-sm)',
                    lineHeight: 'var(--leading-sm)',
                    letterSpacing: 'var(--tracking-sm)',
                    fontWeight: 'var(--weight-medium)',
                    color: 'var(--text-primary)'
                  }}
                >
                  {track.title}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/*
        * Поток одной карточкой во всю ширину. Прежде под него была отведена
        * целая вкладка нижней панели ради единственной кнопки «Запустить».
        */}
      <section data-home-block="wave">
        <WaveCard favorites={favorites.length} onStart={handleStartWave} data-testid="mobile-home-wave" />
      </section>

      {/*
        * Вход в итоги прослушанного.
        *
        * Считались они и раньше — за неделю, за месяц и за всё время, — но жили
        * на экране «Для вас», до которого с телефона было не добраться вовсе.
        * Полки Главной взяли оттуда миксы, а счётчики остались без входа.
        */}
      <section data-home-block="stats">
        <button
          type="button"
          className="press card-interactive row gap-4 w-full p-4 radius-lg text-left pointer"
          onClick={() => setActiveView('foryou')}
          style={{ minHeight: '72px' }}
          data-testid="mobile-home-stats"
        >
          <span
            className="row justify-center shrink-0 radius-md text-accent bg-accent-soft" style={{ width: '44px', height: '44px' }}
          >
            <BarChart3 size={ICON.lg} aria-hidden="true" />
          </span>
          <span className="stack grow gap-px">
            <span
              className="text-base weight-semibold text-primary leading-base tracking-base"
            >
              Итоги прослушанного
            </span>
            <span
              className="text-sm text-muted leading-sm tracking-sm"
            >
              За неделю, месяц и всё время
            </span>
          </span>
          <ChevronRight size={ICON.md} className="shrink-0 text-faint" aria-hidden="true" />
        </button>
      </section>

      {(mixes.length > 0 || autoMixes.length > 0) && (
        <section data-testid="mobile-home-mixes" data-home-block="mixes">
          <SectionTitle>Миксы дня</SectionTitle>
          <Shelf>
            {autoMixes.map((mix) => (
              <ShelfCard
                key={mix.id}
                title={mix.title}
                subtitle={mix.subtitle}
                artworkUrl={mix.artworkUrl}
                onClick={() => void playTrack(mix.tracks[0], mix.tracks, 0)}
                testId={`mobile-home-auto-${mix.kind}`}
              />
            ))}
            {mixes.map((mix) => (
              <ShelfCard
                key={mix.id}
                title={mix.title}
                subtitle={mix.subtitle}
                artworkUrl={mix.artworkUrl}
                onClick={() => void playTrack(mix.tracks[0], mix.tracks, 0)}
                testId={`mobile-home-mix-${mix.id}`}
              />
            ))}
          </Shelf>
        </section>
      )}

      {topArtists.length > 0 && (
        <section data-testid="mobile-home-artists" data-home-block="artists">
          <SectionTitle>В духе тех, кого слушаете</SectionTitle>
          <Shelf>
            {topArtists.map((track) => (
              <ShelfCard
                key={track.id}
                title={track.artist}
                artworkUrl={track.artworkUrl}
                round
                artSize={120}
                onClick={() => handleArtistRadio(track)}
                testId={`mobile-home-artist-${track.id}`}
              />
            ))}
          </Shelf>
        </section>
      )}

      {recent.length === 0 && mixes.length === 0 && (
        <p
          className="m-0 text-sm text-muted leading-sm tracking-sm"
          data-testid="mobile-home-empty"
        >
          Здесь появится то, что вы слушали. Начните с поиска или запустите Поток — он соберёт музыку сам.
        </p>
      )}
    </HomeLayout>
  );
};

/**
 * Кнопка под героем.
 *
 * Своя, а не общая `Button`: главная у героя — большая и в пилюлю, как на
 * большом экране, и обе занимают ровно половину ширины. Общая кнопка растёт по
 * содержимому, и «Слушать» с «Радио по треку» вышли бы разной величины.
 */
const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h2
    className="text-lg weight-semibold text-primary leading-lg tracking-lg" style={{ margin: '0 0 var(--space-3)' }}
  >
    {children}
  </h2>
);

/**
 * Полка с горизонтальной прокруткой. Отрицательные поля возвращают карточкам
 * право уезжать под край экрана — иначе первая и последняя выглядят обрезанными
 * ровно по отступу содержимого, и полка читается как ошибка вёрстки.
 */
const Shelf: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="scroll-x-quiet"
    style={{
      display: 'flex',
      gap: 'var(--space-3)',
      overflowX: 'auto',
      /*
       * Отрицательные поля возвращают карточкам право уезжать под край экрана:
       * иначе первая и последняя выглядят обрезанными ровно по отступу
       * содержимого, и полка читается как ошибка вёрстки.
       */
      margin: '0 calc(var(--mobile-content-pad, var(--space-4)) * -1)',
      padding: '0 var(--mobile-content-pad, var(--space-4))'
      /*
       * Привязки прокрутки здесь нет намеренно. `scroll-snap-align: start`
       * притягивал первую карточку к началу области прокрутки, а не к краю
       * содержимого, и левый отступ просто уезжал: полка открывалась со
       * `scrollLeft: 16`, обложка упиралась в край экрана.
       */
    }}
  >
    {children}
  </div>
);

interface ShelfCardProps {
  title: string;
  /**
   * Необязательна. Под кружками исполнителей она была одинаковой у всех
   * карточек («Радио по исполнителю» ×8) — то есть повторяла заголовок раздела
   * восемь раз подряд и не различала карточки ничем.
   */
  subtitle?: string;
  artworkUrl?: string;
  round?: boolean;
  /**
   * Сторона обложки. Имя не `size`: проверка `iconScale` считает `size={число}`
   * в разметке размером иконки и требует брать его из шкалы `ICON`.
   */
  artSize?: number;
  onClick: () => void;
  testId: string;
}

const ShelfCard: React.FC<ShelfCardProps> = ({ title, subtitle, artworkUrl, round, artSize = 148, onClick, testId }) => {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="press"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        width: `${artSize}px`,
        flexShrink: 0,
        textAlign: 'left',
        cursor: 'pointer'
      }}
      data-testid={testId}
    >
      <span
        style={{
          position: 'relative',
          width: `${artSize}px`,
          height: `${artSize}px`,
          borderRadius: round ? 'var(--radius-full)' : 'var(--radius-md)',
          overflow: 'hidden',
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {failed || !artworkUrl ? (
          <Music2 size={ICON.hero} className="text-faint" aria-hidden="true" />
        ) : (
          <img
            src={artworkUrl}
            alt=""
            loading="lazy"
            className="fill-cover"
            onError={() => setFailed(true)}
          />
        )}
      </span>
      <span
        className="text-truncate w-full text-sm weight-medium text-primary leading-sm tracking-sm"
      >
        {title}
      </span>
      {subtitle && (
        <span
          className="text-truncate w-full text-xs text-muted leading-xs tracking-xs"
        >
          {subtitle}
        </span>
      )}
    </button>
  );
};

const Artwork: React.FC<{ track: UnifiedTrack; artSize: number; radius: string }> = ({ track, artSize, radius }) => {
  const [failed, setFailed] = useState(false);
  return (
    <span
      style={{
        width: `${artSize}px`,
        height: `${artSize}px`,
        flexShrink: 0,
        borderRadius: radius,
        overflow: 'hidden',
        background: 'var(--surface-sunken)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {failed || !track.artworkUrl ? (
        <Music2 size={ICON.lg} className="text-faint" aria-hidden="true" />
      ) : (
        <img
          src={track.artworkUrl}
          alt=""
          loading="lazy"
          className="fill-cover"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
};
