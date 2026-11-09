import React from 'react';
import { Play, Pause, Radio, ArrowLeft, User, Bell, BellOff } from 'lucide-react';
import { ArtistProfile } from '../../../services/artistService';
import { Button } from '../../common/Button';
import { ICON } from '../../../styles/icons';

interface ArtistHeroProps {
  profile: ArtistProfile;
  isNarrow: boolean;
  isArtistPlaying: boolean;
  subscribed: boolean;
  bannerFailed: boolean;
  onBannerError: () => void;
  onBack: () => void;
  onPlayAll: () => void;
  onStartRadio: () => void;
  onToggleSubscription: () => void;
}

/** Шапка: баннер под скримом, кнопка «Назад», аватар, имя и быстрые действия. */
export const ArtistHero: React.FC<ArtistHeroProps> = ({
  profile,
  isNarrow,
  isArtistPlaying,
  subscribed,
  bannerFailed,
  onBannerError,
  onBack,
  onPlayAll,
  onStartRadio,
  onToggleSubscription
}) => (
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
    {/* Баннер: фотография уходит под размытие и скрим, чтобы не спорить с текстом. */}
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
          onError={onBannerError}
        />
      </div>
    )}

    {/* Градиент поверх баннера */}
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

    {/* Верхняя строка: возврат к поиску */}
    <div
      className="relative pb-4" style={{ zIndex: 2, marginBottom: 'auto' }}
    >
      <Button
        variant="ghost"
        size="sm"
        icon={<ArrowLeft size={ICON.md} />}
        onClick={onBack}
        aria-label="Назад к поиску"
        data-testid="artist-back-btn"
      >
        Назад
      </Button>
    </div>

    {/* Исполнитель и управление */}
    <div
      className="relative row-end gap-6 wrap" style={{ zIndex: 2 }}
    >
      {/* Аватар */}
      <div
        className="radius-full overflow-hidden shrink-0 row justify-center max-w-full bg-surface-3" style={{ width: '128px', aspectRatio: '1 / 1', border: '3px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
        data-testid="artist-avatar"
      >
        {profile.avatarUrl || profile.bannerUrl ? (
          <img
            src={profile.avatarUrl || profile.bannerUrl}
            alt={profile.name}
            className="fill-cover"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : (
          <User size={ICON.hero} className="text-faint" />
        )}
      </div>

      {/* Имя и число подписчиков */}
      <div className="min-0 stack gap-2" style={{ flex: '1 1 240px' }}>
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
            textShadow: 'var(--text-shadow-md)',
            overflowWrap: 'anywhere'
          }}
          data-testid="artist-name-heading"
        >
          {profile.name}
        </h1>

        {/* Дословно из YouTube Music. Придуманной строки «слушателей в месяц»
            больше нет — это число нам никто не сообщает. */}
        {profile.subscriberCount && (
          <p
            className="m-0 text-sm text-secondary weight-medium"
            data-testid="artist-subscribers"
          >
            {profile.subscriberCount}
          </p>
        )}

        {/* Быстрые действия */}
        <div
          className="row wrap gap-3 mt-3"
        >
          <Button
            variant="primary"
            size="md"
            icon={isArtistPlaying ? <Pause size={ICON.lg} /> : <Play size={ICON.lg} />}
            onClick={onPlayAll}
            disabled={profile.topTracks.length === 0}
            data-testid="artist-play-all-btn"
          >
            {isArtistPlaying ? 'Пауза' : 'Слушать'}
          </Button>

          <Button
            variant="secondary"
            size="md"
            icon={<Radio size={ICON.md} />}
            onClick={onStartRadio}
            disabled={profile.topTracks.length === 0}
            data-testid="artist-radio-btn"
          >
            Радио
          </Button>

          <Button
            variant="secondary"
            size="md"
            icon={subscribed ? <BellOff size={ICON.md} /> : <Bell size={ICON.md} />}
            onClick={onToggleSubscription}
            aria-pressed={subscribed}
            data-testid="artist-subscribe-btn"
          >
            {subscribed ? 'Вы подписаны' : 'Подписаться'}
          </Button>
        </div>
      </div>
    </div>
  </div>
);
