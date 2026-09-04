import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, ChevronRight, Music2, Radio, Settings } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { getHistory, HistoryRecord } from '../../services/db';
import { buildDailyMixes, dailyMixDateKey, DailyMix } from '../../services/dailyMixes';
import { normalizeArtist } from '../../services/recommendationEngine';
import { ICON } from '../../styles/icons';
import type { UnifiedTrack } from '../../types/music';

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
  const favorites = useLibraryStore((s) => s.favorites);
  const playlists = useLibraryStore((s) => s.playlists);
  const history = useLibraryStore((s) => s.history);
  const setActiveView = useUIStore((s) => s.setActiveView);

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }} data-testid="mobile-home">
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <h1
          style={{
            margin: 0,
            flex: 1,
            minWidth: 0,
            fontSize: 'var(--text-2xl)',
            lineHeight: 'var(--leading-2xl)',
            letterSpacing: 'var(--tracking-2xl)',
            fontWeight: 'var(--weight-bold)',
            color: 'var(--text-primary)'
          }}
        >
          Wireon
        </h1>
        {/*
          * Настройки на телефоне жили под аватаром в шапке. Шапки больше нет,
          * поэтому вход переезжает сюда — туда же, куда его кладут телефонные
          * приложения, и он остаётся ровно один.
          */}
        <button
          type="button"
          className="press focus-ring"
          onClick={() => setActiveView('settings')}
          aria-label="Настройки"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '44px',
            height: '44px',
            flexShrink: 0,
            borderRadius: 'var(--radius-pill)',
            color: 'var(--text-secondary)',
            cursor: 'pointer'
          }}
          data-testid="mobile-home-settings"
        >
          <Settings size={ICON.lg} aria-hidden="true" />
        </button>
      </header>

      {recent.length > 0 && (
        <section data-testid="mobile-home-recent">
          <SectionTitle>Продолжить слушать</SectionTitle>
          {/*
            * Сетка два на три с обложкой 64 — приём, которым телефонные плееры
            * открывают главный экран. Самое частое действие оказывается в один
            * палец и без прокрутки.
            */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 'var(--space-2)'
            }}
          >
            {recent.map((track) => (
              <button
                key={track.id}
                type="button"
                className="press card-interactive"
                onClick={() => void playTrack(track, history, history.indexOf(track))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  minWidth: 0,
                  height: '64px',
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                  textAlign: 'left',
                  cursor: 'pointer'
                }}
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
      <section>
        <button
          type="button"
          className="press card-interactive"
          onClick={handleStartWave}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-4)',
            width: '100%',
            minHeight: '88px',
            padding: 'var(--space-4)',
            borderRadius: 'var(--radius-lg)',
            textAlign: 'left',
            cursor: 'pointer'
          }}
          data-testid="mobile-home-wave"
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '56px',
              height: '56px',
              flexShrink: 0,
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent-soft)',
              color: 'var(--accent)'
            }}
          >
            <Radio size={ICON.xl} aria-hidden="true" />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: '2px' }}>
            <span
              style={{
                fontSize: 'var(--text-lg)',
                lineHeight: 'var(--leading-lg)',
                letterSpacing: 'var(--tracking-lg)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)'
              }}
            >
              Поток
            </span>
            <span
              style={{
                fontSize: 'var(--text-sm)',
                lineHeight: 'var(--leading-sm)',
                letterSpacing: 'var(--tracking-sm)',
                color: 'var(--text-muted)'
              }}
            >
              Бесконечный подбор
            </span>
          </span>
          <ChevronRight size={ICON.md} style={{ flexShrink: 0, color: 'var(--text-faint)' }} aria-hidden="true" />
        </button>
      </section>

      {/*
        * Вход в итоги прослушанного.
        *
        * Считались они и раньше — за неделю, за месяц и за всё время, — но жили
        * на экране «Для вас», до которого с телефона было не добраться вовсе.
        * Полки Главной взяли оттуда миксы, а счётчики остались без входа.
        */}
      <section>
        <button
          type="button"
          className="press card-interactive"
          onClick={() => setActiveView('foryou')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-4)',
            width: '100%',
            minHeight: '72px',
            padding: 'var(--space-4)',
            borderRadius: 'var(--radius-lg)',
            textAlign: 'left',
            cursor: 'pointer'
          }}
          data-testid="mobile-home-stats"
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '44px',
              height: '44px',
              flexShrink: 0,
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent-soft)',
              color: 'var(--accent)'
            }}
          >
            <BarChart3 size={ICON.lg} aria-hidden="true" />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: '2px' }}>
            <span
              style={{
                fontSize: 'var(--text-base)',
                lineHeight: 'var(--leading-base)',
                letterSpacing: 'var(--tracking-base)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)'
              }}
            >
              Итоги прослушанного
            </span>
            <span
              style={{
                fontSize: 'var(--text-sm)',
                lineHeight: 'var(--leading-sm)',
                letterSpacing: 'var(--tracking-sm)',
                color: 'var(--text-muted)'
              }}
            >
              За неделю, месяц и всё время
            </span>
          </span>
          <ChevronRight size={ICON.md} style={{ flexShrink: 0, color: 'var(--text-faint)' }} aria-hidden="true" />
        </button>
      </section>

      {mixes.length > 0 && (
        <section data-testid="mobile-home-mixes">
          <SectionTitle>Миксы дня</SectionTitle>
          <Shelf>
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
        <section data-testid="mobile-home-artists">
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
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            lineHeight: 'var(--leading-sm)',
            letterSpacing: 'var(--tracking-sm)',
            color: 'var(--text-muted)'
          }}
          data-testid="mobile-home-empty"
        >
          Здесь появится то, что вы слушали. Начните с поиска или запустите Поток — он соберёт музыку сам.
        </p>
      )}
    </div>
  );
};

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h2
    style={{
      margin: '0 0 var(--space-3)',
      fontSize: 'var(--text-lg)',
      lineHeight: 'var(--leading-lg)',
      letterSpacing: 'var(--tracking-lg)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-primary)'
    }}
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
      margin: '0 calc(var(--space-4) * -1)',
      padding: '0 var(--space-4)'
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
          <Music2 size={ICON.hero} style={{ color: 'var(--text-faint)' }} aria-hidden="true" />
        ) : (
          <img
            src={artworkUrl}
            alt=""
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={() => setFailed(true)}
          />
        )}
      </span>
      <span
        className="text-truncate"
        style={{
          width: '100%',
          fontSize: 'var(--text-sm)',
          lineHeight: 'var(--leading-sm)',
          letterSpacing: 'var(--tracking-sm)',
          fontWeight: 'var(--weight-medium)',
          color: 'var(--text-primary)'
        }}
      >
        {title}
      </span>
      {subtitle && (
        <span
          className="text-truncate"
          style={{
            width: '100%',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)',
            letterSpacing: 'var(--tracking-xs)',
            color: 'var(--text-muted)'
          }}
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
        <Music2 size={ICON.lg} style={{ color: 'var(--text-faint)' }} aria-hidden="true" />
      ) : (
        <img
          src={track.artworkUrl}
          alt=""
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
};
