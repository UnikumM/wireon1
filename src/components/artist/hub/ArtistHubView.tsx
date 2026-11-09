import React, { useState, useCallback } from 'react';
import { useUIStore } from '../../../store/useUIStore';
import { usePlayerStore } from '../../../store/usePlayerStore';
import { ArtistAlbum } from '../../../services/artistService';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { useArtistProfile } from './useArtistProfile';
import { ArtistHubLoading, ArtistHubError } from './ArtistHubStates';
import { ArtistHero } from './ArtistHero';
import { ArtistTopTracks } from './ArtistTopTracks';
import { ArtistDiscography } from './ArtistDiscography';
import { ArtistSimilar } from './ArtistSimilar';
import { ArtistBio } from './ArtistBio';

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

/**
 * Страница исполнителя. Контейнер: берёт данные из `useArtistProfile`, держит
 * состояние экрана и собирает секции; сами секции лежат рядом и ничего не
 * загружают.
 */
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
  const openCollection = useUIStore((s) => s.openCollection);

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const startTrackRadio = usePlayerStore((s) => s.startTrackRadio);

  const artistName = propArtistName || selectedArtistName || 'Исполнитель';

  const {
    profile,
    isLoading,
    error,
    loadProfile,
    bannerFailed,
    markBannerFailed,
    similar,
    retrySimilar,
    subscribed,
    toggleSubscribed
  } = useArtistProfile(artistName);

  // Раскрытие биографии — состояние экрана, а не секции: оно живёт здесь, рядом
  // с остальным, и не зависит от того, смонтирована ли сейчас сама секция.
  const [isBioExpanded, setIsBioExpanded] = useState<boolean>(false);

  const handleToggleSubscription = useCallback(async () => {
    const name = profile?.name || artistName;
    const next = await toggleSubscribed();
    showToast(next ? `Подписка на ${name}` : `Отписались от ${name}`, 'info');
  }, [artistName, profile, showToast, toggleSubscribed]);

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
   * Открывает альбом на его экране.
   *
   * Раньше карточка сразу включала альбом: состав человек узнавал уже очередью,
   * начав слушать. Ожидание, полоса занятости и сообщение о пустом ответе жили
   * здесь же — теперь всё это забота экрана подборки, одна на все источники.
   */
  const handleOpenAlbum = useCallback(
    (album: ArtistAlbum) => {
      const ref = album.browseId || album.id;
      openCollection({
        id: `ytc_${ref}`,
        kind: 'album',
        source: 'youtube',
        ref,
        title: album.title,
        subtitle: [profile?.name || artistName, album.year].filter(Boolean).join(' • '),
        artworkUrl: album.coverUrl || ''
      });
    },
    [artistName, openCollection, profile?.name]
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
    return <ArtistHubLoading className={className} />;
  }

  if (error || !profile || profile.isSparse) {
    return (
      <ArtistHubError
        className={className}
        artistName={artistName}
        error={error}
        profile={profile}
        onRetry={() => void loadProfile(artistName, true)}
      />
    );
  }

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
      <ArtistHero
        profile={profile}
        isNarrow={isNarrow}
        isArtistPlaying={isArtistPlaying}
        subscribed={subscribed}
        bannerFailed={bannerFailed}
        onBannerError={markBannerFailed}
        onBack={handleBack}
        onPlayAll={handlePlayAll}
        onStartRadio={handleStartArtistRadio}
        onToggleSubscription={() => void handleToggleSubscription()}
      />

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
        <ArtistTopTracks artistName={profile.name} tracks={profile.topTracks} />

        <ArtistDiscography albums={profile.albums ?? []} onOpenAlbum={handleOpenAlbum} />

        <ArtistSimilar
          artistName={profile.name}
          similar={similar}
          onRetry={retrySimilar}
          onOpenArtist={openArtist}
        />

        <ArtistBio
          bio={profile.bio}
          bioSource={profile.bioSource}
          expanded={isBioExpanded}
          onToggle={() => setIsBioExpanded(!isBioExpanded)}
        />
      </div>
    </div>
  );
};
