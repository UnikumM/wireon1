import React, { useEffect, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  Radio,
  Disc,
  Users,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  Music2,
  TrendingUp,
  Info,
  RefreshCw,
  User
} from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { artistService, ArtistProfile } from '../../services/artistService';
import {
  similarArtistsService,
  SimilarArtistOrigin,
  SimilarArtistsResult
} from '../../services/similarArtists';
import { TrackCard } from '../search/TrackCard';
import { Button } from '../common/Button';
import { Skeleton } from '../common/Skeleton';
import { EmptyState } from '../common/EmptyState';
import { pluralize } from '../../utils/plural';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { ICON } from '../../styles/icons';

export interface ArtistHubViewProps {
  artistName?: string;
  className?: string;
  /**
   * Прокручивать себя самому. По умолчанию да — на ПК экран сам себе область
   * прокрутки. Телефонная оболочка передаёт `false`: там прокручивается
   * `<main>`, и своя область внутри неё дала бы **две полосы прокрутки** одна в
   * другой, где внешняя не двигается, а внутренняя не видна целиком.
   */
  scrollSelf?: boolean;
}

/** Credits the biography, so the listener knows who wrote it. */
const BIO_SOURCE_LABELS: Record<NonNullable<ArtistProfile['bioSource']>, string> = {
  'wikipedia-ru': 'Источник: Википедия',
  'wikipedia-en': 'Источник: Wikipedia (англ.)',
  'youtube-music': 'Источник: описание на YouTube Music'
};

/**
 * Подпись под карточкой похожего: связь называется своим именем, чтобы человек
 * понимал, почему ему это показали, и не считал подбор случайным.
 */
const SIMILAR_ORIGIN_LABELS: Record<SimilarArtistOrigin, string> = {
  'youtube-music': 'По версии YouTube Music',
  collab: 'Записывались вместе',
  library: 'Рядом в вашей медиатеке',
  related: 'В рекомендациях к трекам',
  search: 'Рядом в поиске'
};

export const ArtistHubView: React.FC<ArtistHubViewProps> = ({
  artistName: propArtistName,
  className = '',
  scrollSelf = true
}) => {
  /*
   * Одна подписка на всю страницу: строки рисует `TrackCard`, который узость
   * получает пропом, а не своим медиазапросом на каждую из десяти строк.
   */
  const isNarrow = useMediaQuery('(max-width: 768px)');

  const selectedArtistName = useUIStore((s) => s.selectedArtistName);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const openArtist = useUIStore((s) => s.openArtist);
  const showToast = useUIStore((s) => s.showToast);

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const startTrackRadio = usePlayerStore((s) => s.startTrackRadio);

  const artistName = propArtistName || selectedArtistName || 'Исполнитель';

  const [profile, setProfile] = useState<ArtistProfile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isBioExpanded, setIsBioExpanded] = useState<boolean>(false);
  const [bannerFailed, setBannerFailed] = useState<boolean>(false);
  const [similar, setSimilar] = useState<SimilarArtistsResult | null>(null);
  const [similarAttempt, setSimilarAttempt] = useState<number>(0);
  /** `browseId` альбома, чей состав сейчас запрашивается. */
  const [openingAlbumId, setOpeningAlbumId] = useState<string | null>(null);

  const loadProfile = useCallback(async (name: string, force = false) => {
    if (!name || !name.trim()) return;
    setIsLoading(true);
    setError(null);
    setBannerFailed(false);
    // A retry after a failed lookup must not be served the sparse result we
    // just cached, or the button does nothing visible.
    if (force) artistService.clearCache();
    try {
      const data = await artistService.getArtistProfile(name);
      setProfile(data);
    } catch (err: unknown) {
      console.warn('[ArtistHubView] Failed to load artist profile:', err);
      const msg = err instanceof Error ? err.message : 'Не удалось загрузить профиль исполнителя';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (artistName) {
      void loadProfile(artistName);
    }
  }, [artistName, loadProfile]);

  // Похожие подбираются отдельно от профиля и после него: часть источников
  // сетевые, и страница не должна ждать их, чтобы показать треки. Флаг
  // `cancelled` нужен, потому что переход на другого артиста меняет профиль
  // раньше, чем вернётся прошлый подбор.
  useEffect(() => {
    if (!profile || profile.isSparse) return;

    let cancelled = false;
    setSimilar(null);

    similarArtistsService
      .getSimilarArtists({
        artistName: profile.name,
        topTracks: profile.topTracks,
        fromProfile: profile.similarArtists
      })
      .then((result) => {
        if (!cancelled) setSimilar(result);
      })
      .catch((err: unknown) => {
        console.warn('[ArtistHubView] Похожих исполнителей собрать не удалось:', err);
        if (!cancelled) setSimilar({ artists: [], status: 'unavailable' });
      });

    return () => {
      cancelled = true;
    };
  }, [profile, similarAttempt]);

  const handleRetrySimilar = useCallback(() => {
    if (!profile) return;
    // Без сброса кэша повторная попытка вернула бы тот же пустой ответ.
    similarArtistsService.clearCache(profile.name);
    setSimilarAttempt((attempt) => attempt + 1);
  }, [profile]);

  const isArtistPlaying = Boolean(
    isPlaying &&
      currentTrack &&
      profile &&
      profile.topTracks.some((t) => t.id === currentTrack.id)
  );

  const handlePlayAll = () => {
    if (!profile || profile.topTracks.length === 0) return;
    if (isArtistPlaying) {
      void togglePlayPause();
      return;
    }
    void playTrack(profile.topTracks[0], profile.topTracks, 0);
    showToast(`Играет ${profile.name}`, 'info');
  };

  /**
   * Включает альбом целиком.
   *
   * До этого карточка альбома была картинкой и только: ни нажатия, ни кнопки,
   * ни клавиатурного пути — в самом стиле стояло `cursor: default`. Состав
   * альбома YouTube отдаёт отдельным запросом по его `browseId`, поэтому здесь
   * есть ожидание и есть ответ на пустоту: молча ничего не делать — то же, что
   * было.
   */
  const handlePlayAlbum = useCallback(
    async (albumId: string, albumTitle: string) => {
      if (openingAlbumId) return;
      setOpeningAlbumId(albumId);
      try {
        const tracks = await artistService.getAlbumTracks(albumId, profile?.name || artistName || '');
        if (!tracks.length) {
          showToast(`YouTube не отдал состав «${albumTitle}». Попробуйте открыть его позже.`, 'error');
          return;
        }
        await playTrack(tracks[0], tracks, 0);
      } catch (err) {
        console.warn('[ArtistHubView] Не удалось открыть альбом:', err);
        showToast(`Не удалось открыть «${albumTitle}».`, 'error');
      } finally {
        setOpeningAlbumId(null);
      }
    },
    [artistName, openingAlbumId, playTrack, profile?.name, showToast]
  );

  const handleStartArtistRadio = () => {
    if (!profile || profile.topTracks.length === 0) return;
    void startTrackRadio(profile.topTracks[0]);
    showToast(`Запущено радио по исполнителю «${profile.name}»`, 'success');
  };

  const handleBack = () => {
    setActiveView('search');
  };

  if (isLoading) {
    return (
      <div
        className={`scrollbar-thin ${className}`}
        style={{
          flex: 1,
          height: '100%',
          overflowY: 'auto',
          padding: 'var(--space-6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-6)'
        }}
        data-testid="artist-hub-loading"
      >
        <div style={{
              display: 'flex',
              alignItems: 'center',
              // Три подписанные кнопки в строку не влезают уже на 375 px, а
              // область содержимого режет по горизонтали — «В офлайн» просто
              // переставала существовать. На широком окне перенос ничего не
              // меняет: там они и так помещаются.
              flexWrap: 'wrap',
              gap: 'var(--space-3)'
            }}>
          <Skeleton width="100px" height="36px" radius="var(--radius-sm)" />
        </div>
        <Skeleton width="100%" height="280px" radius="var(--radius-lg)" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <Skeleton width="200px" height="28px" radius="var(--radius-xs)" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} width="100%" height="56px" radius="var(--radius-sm)" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !profile || profile.isSparse) {
    // `isSparse` means every source came back empty — we have a name and nothing
    // else. A retry is more use than a page of empty sections.
    const description = error
      ? error
      : profile?.isSparse
        ? `Про «${artistName}» ничего не нашлось. Возможно, имя написано иначе — или сервис сейчас недоступен.`
        : `Метаданные для «${artistName}» получить не получилось.`;

    return (
      <div
        className={`scrollbar-thin ${className}`}
        style={{
          flex: 1,
          height: '100%',
          overflowY: 'auto',
          padding: 'var(--space-6)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--space-4)'
        }}
        data-testid="artist-hub-error"
      >
        <EmptyState
          icon={<Info size={ICON.display} />}
          title={profile?.isSparse && !error ? 'Исполнитель не найден' : 'Не удалось открыть профиль'}
          description={description}
          action={
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={ICON.sm} />}
              onClick={() => void loadProfile(artistName, true)}
              data-testid="artist-hub-retry-btn"
            >
              Повторить
            </Button>
          }
        />
      </div>
    );
  }

  // Only a real biography is shown. The old placeholder — "Official artist
  // profile for X." — filled the section with a sentence nobody wrote.
  const bio = profile.bio?.trim() ?? '';
  const isBioLong = bio.length > 280;
  const displayedBio = isBioExpanded || !isBioLong ? bio : `${bio.slice(0, 280)}…`;

  // Одна сетка на скелет и на карточки: заглушки должны стоять там же, где
  // потом встанут похожие, иначе блок дёргается при подстановке.
  const similarGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: 'var(--space-4)'
  };

  return (
    <div
      // Вход экрана ставится на загруженное состояние, а не на скелет: иначе
      // движение достаётся заглушке, а сам профиль подменяет её кадром.
      className={`scrollbar-thin animate-view-in ${className}`}
      style={
        scrollSelf
          ? {
              flex: 1,
              height: '100%',
              overflowY: 'auto',
              paddingBottom: 'calc(var(--player-bar-height) + var(--space-8))'
            }
          : // Отступ снизу здесь не нужен: в телефонной оболочке полоса плеера
            // стоит в потоке, а не поверх содержимого.
            { flex: 1 }
      }
      data-testid="artist-hub-view"
    >
      {/* 1. HERO HEADER */}
      <div
        style={{
          position: 'relative',
          minHeight: '320px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          /*
           * 64 px по бокам — это 36% экрана в 360 px, отданные пустоте, при том
           * что строка трека под ними обрезалась до «Happi…». То же самое уже
           * лечили `--content-pad-x` в списках; здесь поле было записано числом
           * и переменной не подчинялось.
           */
          padding: isNarrow ? 'var(--space-5) var(--space-4)' : 'var(--space-6) var(--space-8)',
          background: 'linear-gradient(180deg, var(--surface-2) 0%, var(--bg-base) 100%)',
          borderBottom: '1px solid var(--border-subtle)',
          overflow: 'hidden'
        }}
        data-testid="artist-hero-header"
      >
        {/* Banner Background Image with obsidian glass gradient wash */}
        {profile.bannerUrl && !bannerFailed && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 0,
              backgroundImage: `url(${profile.bannerUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center 25%',
              filter: 'brightness(0.35) blur(2px)',
              transform: 'scale(1.05)',
              transition: 'transform var(--dur-normal) var(--ease-out)'
            }}
          >
            <img
              src={profile.bannerUrl}
              alt=""
              style={{ display: 'none' }}
              onError={() => setBannerFailed(true)}
            />
          </div>
        )}

        {/* Gradient Overlay */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            // Затемнение баннера — скримами, а не своими rgba: у баннера нет
            // «своего» тёмного цвета, есть только требование увести фотографию
            // под текст, и насколько сильно — решает тема.
            background:
              'linear-gradient(0deg, var(--bg-base) 0%, var(--scrim-strong) 50%, var(--scrim) 100%)'
          }}
        />

        {/* Top bar back navigation button */}
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            marginBottom: 'auto',
            paddingBottom: 'var(--space-4)'
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft size={ICON.md} />}
            onClick={handleBack}
            aria-label="Назад к поиску"
            data-testid="artist-back-btn"
          >
            Назад
          </Button>
        </div>

        {/* Artist Identity & Controls */}
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            display: 'flex',
            alignItems: 'flex-end',
            gap: 'var(--space-6)',
            flexWrap: 'wrap'
          }}
        >
          {/* Avatar Tile */}
          <div
            style={{
              width: '128px',
              height: '128px',
              borderRadius: 'var(--radius-full)',
              overflow: 'hidden',
              flexShrink: 0,
              border: '3px solid var(--border)',
              boxShadow: 'var(--shadow-lg)',
              backgroundColor: 'var(--surface-3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            data-testid="artist-avatar"
          >
            {profile.avatarUrl || profile.bannerUrl ? (
              <img
                src={profile.avatarUrl || profile.bannerUrl}
                alt={profile.name}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              <User size={ICON.hero} style={{ color: 'var(--text-faint)' }} />
            )}
          </div>

          {/* Name & Listener Stats */}
          <div style={{ flex: 1, minWidth: '240px', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <h1
              style={{
                margin: 0,
                // Верхняя граница — ступень лестницы, а не 3.5rem: имя артиста
                // было единственным текстом в приложении, который не слушался
                // настройки кегля и на широком окне вырастал до 56 пикселей —
                // вдвое крупнее любого другого заголовка. Текучесть при этом
                // осталась: между ступенями размер по-прежнему ведёт vw.
                fontSize: 'clamp(var(--text-2xl), 5vw, var(--text-3xl))',
                fontWeight: 'var(--weight-bold)',
                lineHeight: 'var(--leading-3xl)',
                letterSpacing: 'var(--tracking-3xl)',
                color: 'var(--text-primary)',
                textShadow: 'var(--text-shadow-md)'
              }}
              data-testid="artist-name-heading"
            >
              {profile.name}
            </h1>

            {/* Verbatim from YouTube Music. There is no invented "monthly
                listeners" line any more — nothing reports that number to us. */}
            {profile.subscriberCount && (
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-secondary)',
                  fontWeight: 'var(--weight-medium)'
                }}
                data-testid="artist-subscribers"
              >
                {profile.subscriberCount}
              </p>
            )}

            {/* Quick Action Buttons */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                marginTop: 'var(--space-3)'
              }}
            >
              <Button
                variant="primary"
                size="md"
                icon={isArtistPlaying ? <Pause size={ICON.lg} /> : <Play size={ICON.lg} />}
                onClick={handlePlayAll}
                disabled={profile.topTracks.length === 0}
                data-testid="artist-play-all-btn"
              >
                {isArtistPlaying ? 'Пауза' : 'Слушать'}
              </Button>

              <Button
                variant="secondary"
                size="md"
                icon={<Radio size={ICON.md} />}
                onClick={handleStartArtistRadio}
                disabled={profile.topTracks.length === 0}
                data-testid="artist-radio-btn"
              >
                Радио
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          maxWidth: '1280px',
          margin: '0 auto',
          // По горизонтали ноль: `main-content` уже отступает на `--content-pad-x`,
          // и второе поле поверх него оставляло списку 200 px из 360.
          padding: isNarrow ? 'var(--space-5) 0' : 'var(--space-6) var(--space-8)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-8)'
        }}
      >
        {/* 2. TOP 10 POPULAR TRACKS */}
        <section aria-labelledby="artist-top-tracks-heading" data-testid="artist-top-tracks-section">
          {/*
            * `space-between` без зазора и без запрета на сжатие — это не ряд, а
            * два слоя друг на друге. Счётчик ужимался до нулевой ширины, его
            * текст вылезал наружу, заголовок переносился на вторую строку, и на
            * 360 px «Популярные треки» лежало прямо поверх «10 треков».
            * Зазор разводит их, `flexShrink: 0` не даёт счётчику исчезнуть, а
            * `minWidth: 0` разрешает переноситься заголовку — он длиннее.
            */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              marginBottom: 'var(--space-4)'
            }}
          >
            <h2
              id="artist-top-tracks-heading"
              style={{
                margin: 0,
                minWidth: 0,
                fontSize: 'var(--text-xl)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)'
              }}
            >
              {/* Про популярность, а не про волшебство: значок и должен быть про рост. */}
              <TrendingUp size={ICON.lg} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} aria-hidden="true" />
              Популярные треки
            </h2>
            <span
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--text-muted)',
                flexShrink: 0,
                whiteSpace: 'nowrap'
              }}
            >
              {pluralize(profile.topTracks.length, 'трек', 'трека', 'треков')}
            </span>
          </div>

          {profile.topTracks.length === 0 ? (
            <EmptyState
              icon={<Music2 size={ICON.display} />}
              title="Треки не найдены"
              description={`Доступных треков для «${profile.name}» найти не удалось.`}
              style={{ padding: 'var(--space-6)' }}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
                backgroundColor: 'var(--surface-1)',
                padding: 'var(--space-2)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)'
              }}
            >
              {profile.topTracks.map((track, index) => (
                <TrackCard
                  key={track.id}
                  track={track}
                  index={index}
                  showIndex={true}
                  contextQueue={profile.topTracks}
                  layout="row"
                />
              ))}
            </div>
          )}
        </section>

        {/* 3. DISCOGRAPHY / ALBUMS */}
        {profile.albums && profile.albums.length > 0 && (
          <section aria-labelledby="artist-discography-heading" data-testid="artist-discography-section">
            <h2
              id="artist-discography-heading"
              style={{
                margin: '0 0 var(--space-4) 0',
                fontSize: 'var(--text-xl)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)'
              }}
            >
              <Disc size={ICON.lg} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
              Дискография
            </h2>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 'var(--space-4)'
              }}
            >
              {profile.albums.map((album, index) => (
                <button
                  key={album.id}
                  type="button"
                  onClick={() => void handlePlayAlbum(album.browseId || album.id, album.title)}
                  disabled={openingAlbumId !== null}
                  aria-busy={openingAlbumId === (album.browseId || album.id)}
                  aria-label={`Включить альбом «${album.title}»`}
                  className="card-interactive card-reset press animate-settle hover-sheen"
                  style={
                    {
                      // Номер обложки в сетке — её задержка: дискография
                      // выкладывается по очереди, а не вспыхивает целиком.
                      '--stagger': index,
                      padding: 'var(--space-3)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-2)',
                      borderRadius: 'var(--radius-md)',
                      // Кнопка, а не `div`: альбом включается нажатием, и до
                      // клавиатуры он тоже должен доходить. Раньше здесь стоял
                      // `cursor: default` — честный признак того, что карточка
                      // не делала ничего.
                      textAlign: 'left',
                      // Фон здесь не задаётся нарочно: он живёт в
                      // `.card-interactive`, и инлайновое свойство глушило бы
                      // `:hover` (DESIGN_SYSTEM §15). Родной вид кнопки
                      // сбрасывает `.card-reset` в таблице стилей.
                      cursor: openingAlbumId ? 'progress' : 'pointer'
                    } as React.CSSProperties
                  }
                  data-testid={`artist-album-${album.id}`}
                >
                  <div
                    style={{
                      position: 'relative',
                      width: '100%',
                      aspectRatio: '1/1',
                      borderRadius: 'var(--radius-sm)',
                      overflow: 'hidden',
                      backgroundColor: 'var(--surface-3)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    {album.coverUrl ? (
                      <img
                        src={album.coverUrl}
                        alt={album.title}
                        loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : (
                      <Disc size={ICON.display} style={{ color: 'var(--text-faint)' }} />
                    )}
                    {/* Знак того, что на обложку можно нажать. Без него карточка
                        выглядит ровно так же, как когда она ничего не делала. */}
                    <span
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'var(--scrim)',
                        color: 'var(--text-on-accent)',
                        opacity: openingAlbumId === (album.browseId || album.id) ? 1 : undefined,
                        transition: 'opacity var(--dur-fast) var(--ease-out)'
                      }}
                      className={
                        openingAlbumId === (album.browseId || album.id)
                          ? 'album-play-veil is-busy'
                          : 'album-play-veil'
                      }
                    >
                      {openingAlbumId === (album.browseId || album.id) ? (
                        <RefreshCw size={ICON.xl} className="animate-spin" />
                      ) : (
                        <Play size={ICON.xl} fill="currentColor" />
                      )}
                    </span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                    <span
                      className="text-truncate"
                      style={{
                        fontSize: 'var(--text-sm)',
                        fontWeight: 'var(--weight-semibold)',
                        color: 'var(--text-primary)'
                      }}
                    >
                      {album.title}
                    </span>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        // Та же беда, что у заголовка выше, только в карточке
                        // альбома: без зазора год и число треков сходятся вплотную.
                        gap: 'var(--space-2)',
                        fontSize: 'var(--text-xs)',
                        color: 'var(--text-muted)'
                      }}
                    >
                      <span style={{ whiteSpace: 'nowrap' }}>{album.year || 'Релиз'}</span>
                      {album.trackCount !== undefined && (
                        <span style={{ whiteSpace: 'nowrap' }}>
                          {pluralize(album.trackCount, 'трек', 'трека', 'треков')}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* 4. ПОХОЖИЕ ИСПОЛНИТЕЛИ. Секция рисуется всегда, когда профиль открыт:
            раньше она висела на условии `similarArtists.length > 0` и при пустом
            списке исчезала целиком, а список пуст почти всегда — карусель
            YouTube Music из renderer недостижима (см. `services/similarArtists.ts`).
            Молча пропавший блок человек читает как поломку, поэтому теперь у него
            есть скелет, ответ и внятное объяснение пустоты. */}
        <section aria-labelledby="artist-similar-heading" data-testid="artist-similar-section">
          <h2
            id="artist-similar-heading"
            style={{
              margin: '0 0 var(--space-4) 0',
              fontSize: 'var(--text-xl)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)'
            }}
          >
            <Users size={ICON.lg} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
            Похожие исполнители
          </h2>

          {!similar ? (
            <div style={similarGridStyle} data-testid="artist-similar-loading">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} width="100%" height="164px" radius="var(--radius-md)" />
              ))}
            </div>
          ) : similar.artists.length === 0 ? (
            <EmptyState
              icon={<Users size={ICON.display} />}
              title={
                similar.status === 'unavailable'
                  ? 'Похожих сейчас не подобрать'
                  : 'Похожих исполнителей не нашлось'
              }
              description={
                similar.status === 'unavailable'
                  ? `Ни YouTube, ни ваша медиатека сейчас не отвечают. Похожие на «${profile.name}» появятся, когда связь вернётся.`
                  : `Мы посмотрели совместные треки, рекомендации YouTube и вашу медиатеку — рядом с «${profile.name}» никого не набралось. Послушайте его в «Радио», и связи появятся.`
              }
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RefreshCw size={ICON.sm} />}
                  onClick={handleRetrySimilar}
                  data-testid="artist-similar-retry-btn"
                >
                  Повторить
                </Button>
              }
              style={{ padding: 'var(--space-6)' }}
              data-testid="artist-similar-empty"
            />
          ) : (
            <div style={similarGridStyle}>
              {similar.artists.map((item, idx) => (
                <button
                  type="button"
                  key={item.name}
                  onClick={() => openArtist(item.name)}
                  className="card-interactive press focus-ring animate-settle hover-sheen"
                  style={
                    {
                      '--stagger': idx,
                      padding: 'var(--space-4) var(--space-2)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-subtle)',
                      cursor: 'pointer',
                      textAlign: 'center'
                    } as React.CSSProperties
                  }
                  data-testid={`similar-artist-card-${idx}`}
                >
                  <div
                    style={{
                      width: '80px',
                      height: '80px',
                      borderRadius: 'var(--radius-full)',
                      overflow: 'hidden',
                      backgroundColor: 'var(--surface-3)',
                      border: '2px solid var(--border-accent)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt={item.name}
                        loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : (
                      <User size={ICON.display} style={{ color: 'var(--text-faint)' }} />
                    )}
                  </div>
                  <span
                    className="text-truncate"
                    style={{
                      width: '100%',
                      fontSize: 'var(--text-sm)',
                      fontWeight: 'var(--weight-medium)',
                      color: 'var(--text-primary)'
                    }}
                  >
                    {item.name}
                  </span>
                  <span
                    className="text-truncate"
                    style={{
                      width: '100%',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-muted)'
                    }}
                    data-testid={`similar-artist-reason-${idx}`}
                  >
                    {SIMILAR_ORIGIN_LABELS[item.origin]}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* 5. ARTIST BIOGRAPHY — omitted entirely when no source has one. */}
        {bio.length > 0 && (
          <section
            aria-labelledby="artist-bio-heading"
            className="panel"
            style={{
              padding: 'var(--space-6)',
              borderRadius: 'var(--radius-lg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
              backgroundColor: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)'
            }}
            data-testid="artist-bio-section"
          >
            <h2
              id="artist-bio-heading"
              style={{
                margin: 0,
                fontSize: 'var(--text-lg)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)'
              }}
            >
              <Info size={ICON.md} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
              Об исполнителе
            </h2>

            <p
              style={{
                margin: 0,
                fontSize: 'var(--text-sm)',
                lineHeight: 'var(--leading-relaxed, 1.6)',
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-line'
              }}
              data-testid="artist-bio-text"
            >
              {displayedBio}
            </p>

            {profile.bioSource && (
              <span
                style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}
                data-testid="artist-bio-source"
              >
                {BIO_SOURCE_LABELS[profile.bioSource]}
              </span>
            )}

            {isBioLong && (
              <Button
                variant="ghost"
                size="sm"
                icon={isBioExpanded ? <ChevronUp size={ICON.sm} /> : <ChevronDown size={ICON.sm} />}
                onClick={() => setIsBioExpanded(!isBioExpanded)}
                style={{ alignSelf: 'flex-start', marginTop: 'var(--space-1)' }}
                data-testid="artist-bio-toggle-btn"
              >
                {isBioExpanded ? 'Свернуть' : 'Читать полностью'}
              </Button>
            )}
          </section>
        )}
      </div>
    </div>
  );
};
